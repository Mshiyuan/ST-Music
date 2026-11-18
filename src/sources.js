// 音源适配层：统一的搜索 / 歌词 / 播放地址入口。
// 播放器只认这里返回的统一格式，换接口或加平台时不改播放器。
//
// 统一的歌曲格式：
// { key, platform, id, title, artist, cover, urls: [播放地址候选], lrcUrl?: 歌词文本地址 }

import { settings } from './settings.js';

const TIMEOUT = 10000;
const FAIL_LIMIT = 3;              // 连续失败这么多次后暂时跳过
const COOLDOWN = 5 * 60 * 1000;    // 跳过的时长
const SEARCH_TTL = 10 * 60 * 1000;

const health = {};                 // 接口名 -> { fails, until }
const searchCache = new Map();     // 关键词 -> { at, list }
const lyricCache = new Map();      // 歌曲 key -> 歌词文本

async function request(url, asText = false) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return asText ? await res.text() : await res.json();
    } finally {
        clearTimeout(timer);
    }
}

const https = (u) => (typeof u === 'string' ? u.replace(/^http:\/\//, 'https://') : u);

// 网易云官方外链：免费歌曲会跳转到音频文件，其余跳转到错误页（播放器据此判断不可播）。
const outerLink = (id) => `https://music.163.com/song/media/outer/url?id=${id}.mp3`;

function metingProvider(name, base) {
    const sep = base.includes('?') ? '&' : '?';
    const toTracks = (list) => {
        if (!Array.isArray(list)) throw new Error('bad response');
        return list.map((s) => {
            const id = (/[?&]id=(\d+)/.exec(s.url || '') || [])[1];
            if (!id) return null;
            return {
                key: 'netease:' + id, platform: 'netease', id,
                title: s.title || s.name || '', artist: s.author || s.artist || '',
                cover: https(s.pic), urls: [https(s.url), outerLink(id)], lrcUrl: https(s.lrc),
            };
        }).filter(Boolean);
    };
    return {
        name,
        async search(keyword) {
            return toTracks(await request(`${base}${sep}server=netease&type=search&id=${encodeURIComponent(keyword)}`));
        },
        async playlist(id) {
            return toTracks(await request(`${base}${sep}server=netease&type=playlist&id=${encodeURIComponent(id)}`));
        },
        async song(id) {
            return toTracks(await request(`${base}${sep}server=netease&type=song&id=${encodeURIComponent(id)}`));
        },
    };
}

function vkeysProvider() {
    const base = 'https://api.vkeys.cn/v2/music';
    return {
        name: 'vkeys',
        async search(keyword) {
            const r = await request(`${base}/netease?word=${encodeURIComponent(keyword)}`);
            if (!r || !Array.isArray(r.data)) throw new Error('bad response');
            return r.data.filter((s) => s && s.id).map((s) => ({
                key: 'netease:' + s.id, platform: 'netease', id: String(s.id),
                title: s.song || '', artist: s.singer || '',
                cover: https(s.cover), urls: [outerLink(s.id)],
            }));
        },
        async lyric(track) {
            if (track.platform !== 'netease') return '';
            const r = await request(`${base}/netease/lyric?id=${track.id}`);
            const d = (r && r.data) || {};
            return d.lrc ? { lrc: d.lrc, trans: d.trans || '' } : null;
        },
    };
}

function providers() {
    const s = settings();
    const list = [];
    if (s.customMeting && /^https?:\/\//.test(s.customMeting.trim())) list.push(metingProvider('custom', s.customMeting.trim()));
    if (s.providers.imeto) list.push(metingProvider('imeto', 'https://api.i-meto.com/meting/api'));
    if (s.providers.vkeys) list.push(vkeysProvider());
    return list;
}

function usable(p) {
    const h = health[p.name];
    return !h || h.fails < FAIL_LIMIT || Date.now() > h.until;
}

function mark(p, ok) {
    const h = health[p.name] || (health[p.name] = { fails: 0, until: 0 });
    if (ok) { h.fails = 0; return; }
    h.fails += 1;
    if (h.fails >= FAIL_LIMIT) h.until = Date.now() + COOLDOWN;
}

/** 依次尝试各接口；全部在冷却中时仍然每个再试一次。 */
async function withProviders(pick, run) {
    const all = providers().filter(pick);
    const order = all.filter(usable).concat(all.filter((p) => !usable(p)));
    let lastError = null;
    for (const p of order) {
        try {
            const out = await run(p);
            mark(p, true);
            if (out && (!Array.isArray(out) || out.length)) return out;
        } catch (e) {
            mark(p, false);
            lastError = e;
            console.warn('[ST-Music] 接口失败', p.name, e);
        }
    }
    if (lastError) throw lastError;
    return null;
}

export async function searchSongs(keyword) {
    const k = keyword.trim();
    if (!k) return [];
    const hit = searchCache.get(k);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list;
    if (!providers().length) throw new Error('no provider');
    const list = (await withProviders((p) => p.search, (p) => p.search(k))) || [];
    searchCache.set(k, { at: Date.now(), list });
    return list;
}

/** 读取网易云歌单里的歌曲。只发送歌单编号。 */
export async function getPlaylist(id) {
    return (await withProviders((p) => p.playlist, (p) => p.playlist(id))) || [];
}

const playlistSearchCache = new Map();

/**
 * 按关键词搜索网易云歌单（经酒馆服务器的网页访问接口；网易云接口不允许浏览器跨域读取）。
 * 只发送关键词。返回 [{ id, name, count }]。
 */
export async function searchPlaylists(keyword, limit = 8) {
    const k = keyword.trim();
    if (!k) return [];
    const hit = playlistSearchCache.get(k);
    if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list;
    const c = globalThis.SillyTavern.getContext();
    const url = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(k)}&type=1000&limit=${limit}&offset=0`;
    const res = await fetch('/api/search/visit', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ url, html: false }) });
    if (!res.ok) throw new Error('visit ' + res.status);
    const j = JSON.parse(await res.text());
    const list = ((j.result && j.result.playlists) || []).map((p) => ({ id: String(p.id), name: p.name || '', count: p.trackCount || 0 }));
    playlistSearchCache.set(k, { at: Date.now(), list });
    return list;
}

/** 按编号读取一首网易云歌曲。 */
export async function getSong(id) {
    const list = (await withProviders((p) => p.song, (p) => p.song(id))) || [];
    return list[0] || null;
}

/**
 * 经酒馆服务器读取 QQ 音乐歌单（QQ 音乐接口不允许浏览器跨域读取）。
 * 只发送歌单编号，不发送创建者编号（hosteuin），也不读取创建者信息。
 * 返回 { title, songs: [{ title, artist }] }。
 */
export async function getQQPlaylist(id, onProgress) {
    const c = globalThis.SillyTavern.getContext();
    const songs = [];
    let title = '', total = Infinity;
    for (let begin = 0; begin < total && begin < 2000; begin += 200) {
        const body = { comm: { ct: 24, cv: 4747474 }, req_0: { module: 'music.srfDissInfo.aiDissInfo', method: 'uniform_get_Dissinfo', param: { disstid: Number(id), tag: 1, userinfo: 0, orderlist: 1, song_begin: begin, song_num: 200 } } };
        const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(JSON.stringify(body));
        const res = await fetch('/api/search/visit', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ url, html: false }) });
        if (!res.ok) throw new Error('visit ' + res.status);
        const j = JSON.parse(await res.text());
        const d = j && j.req_0 && j.req_0.data;
        if (!d || j.req_0.code !== 0) throw new Error('empty');
        title = (d.dirinfo && d.dirinfo.title) || title;
        total = d.total_song_num || 0;
        const list = d.songlist || [];
        for (const s of list) songs.push({ title: s.name || s.title || '', artist: (s.singer || []).map((x) => x.name).join('/') });
        if (onProgress) onProgress(songs.length, total);
        if (!list.length) break;
    }
    return { title, songs };
}

const timed = (text) => /\[\d+:\d+/.test(text || '');

/** 取歌词，返回 { lrc, trans }。译文来自平台自带的翻译，没有时 trans 为空。 */
export async function getLyric(track) {
    if (lyricCache.has(track.key)) return lyricCache.get(track.key);
    // 两种来源同时取：带独立译文的接口优先，另一种作为后备
    const [a, b] = await Promise.allSettled([
        withProviders((p) => p.lyric, (p) => p.lyric(track)),
        track.lrcUrl ? request(track.lrcUrl, true) : Promise.resolve(''),
    ]);
    let out = { lrc: '', trans: '' };
    if (a.status === 'fulfilled' && a.value && timed(a.value.lrc)) out = a.value;
    else if (b.status === 'fulfilled' && timed(b.value)) out = { lrc: b.value, trans: '' };
    lyricCache.set(track.key, out);
    return out;
}

function parseLines(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const stamps = [...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
        if (!stamps.length) continue;
        const body = line.replace(/\[[^\]]*\]/g, '').trim();
        if (!body) continue;
        for (const m of stamps) {
            const frac = m[3] ? Number('0.' + m[3]) : 0;
            const t = Number(m[1]) * 60 + Number(m[2]) + frac;
            out.push({ t, key: Math.round(t * 100), text: body });
        }
    }
    return out;
}

const HAN = /[一-鿿]/;
const KANA_HANGUL = /[぀-ヿ가-힯]/;

/** 有些接口把译文写在行尾括号里：原文不是中文、括号里是中文时，拆成原文和译文。 */
function splitInline(text) {
    const m = /^(.*\S)\s*[（(]([^（()）]+)[)）]$/.exec(text);
    if (!m) return null;
    const [, head, tail] = m;
    const tailIsChinese = HAN.test(tail) && !KANA_HANGUL.test(tail);
    const headIsForeign = KANA_HANGUL.test(head) || !HAN.test(head);
    return tailIsChinese && headIsForeign ? { text: head, trans: tail } : null;
}

/** 解析带时间轴的歌词，返回按时间排序的 [{ t: 秒, text, trans }]。 */
export function parseLyric(lrc, trans) {
    const lines = parseLines(lrc);
    if (timed(trans)) {
        const map = new Map(parseLines(trans).map((l) => [l.key, l.text]));
        for (const l of lines) l.trans = map.get(l.key) || '';
    } else {
        for (const l of lines) {
            const s = splitInline(l.text);
            if (s) { l.text = s.text; l.trans = s.trans; } else l.trans = '';
        }
    }
    return lines.sort((a, b) => a.t - b.t);
}

/** 探测一个地址能否播放（只取到元数据为止）。 */
export function canLoad(url, timeout = 8000) {
    return new Promise((resolve) => {
        const el = new Audio();
        el.preload = 'metadata';
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            el.removeAttribute('src');
            el.load();
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeout);
        el.addEventListener('loadedmetadata', () => finish(true));
        el.addEventListener('error', () => finish(false));
        el.src = url;
    });
}

/** 同时探测一首歌的各个地址，任一个能播即返回 true，并把它排到最前。 */
export function probeTrack(track) {
    const urls = (track.urls || []).filter(Boolean);
    if (!urls.length) return Promise.resolve(false);
    return new Promise((resolve) => {
        let left = urls.length, done = false;
        for (const url of urls) {
            canLoad(url).then((ok) => {
                left -= 1;
                if (done) return;
                if (ok) {
                    done = true;
                    track.urls = [url, ...urls.filter((u) => u !== url)];
                    resolve(true);
                } else if (!left) resolve(false);
            });
        }
    });
}

/** 提前与接口和音频服务器建立连接，缩短首次请求的等待。 */
export function preconnect() {
    for (const origin of ['https://api.i-meto.com', 'https://api.vkeys.cn', 'https://music.163.com']) {
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = origin;
        document.head.appendChild(link);
    }
}
