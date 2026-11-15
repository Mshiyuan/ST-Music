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
    return {
        name,
        async search(keyword) {
            const list = await request(`${base}${sep}server=netease&type=search&id=${encodeURIComponent(keyword)}`);
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
            return (r && r.data && r.data.lrc) || '';
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

export async function getLyric(track) {
    if (lyricCache.has(track.key)) return lyricCache.get(track.key);
    let text = '';
    if (track.lrcUrl) {
        try { text = await request(track.lrcUrl, true); } catch (e) { /* 换下一种方式 */ }
    }
    if (!text || !/\[\d+:\d+/.test(text)) {
        try { text = (await withProviders((p) => p.lyric, (p) => p.lyric(track))) || ''; } catch (e) { text = ''; }
    }
    lyricCache.set(track.key, text);
    return text;
}

/** 解析带时间轴的歌词，返回按时间排序的 [{ t: 秒, text }]。 */
export function parseLyric(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const stamps = [...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
        if (!stamps.length) continue;
        const body = line.replace(/\[[^\]]*\]/g, '').trim();
        if (!body) continue;
        for (const m of stamps) {
            const frac = m[3] ? Number('0.' + m[3]) : 0;
            out.push({ t: Number(m[1]) * 60 + Number(m[2]) + frac, text: body });
        }
    }
    return out.sort((a, b) => a.t - b.t);
}
