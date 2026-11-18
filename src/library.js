// 歌库：收藏、歌单、最近播放、播放次数、收听时长。数据只保存在本地（酒馆的扩展设置里）。

import { settings, save } from './settings.js';
import { searchSongs, getPlaylist, getQQPlaylist } from './sources.js';

const RECENT_MAX = 100;
const KEEP_DAYS = 120;          // 每小时收听时长保留的天数
const listeners = [];

export const lib = () => settings().lib;
export const onChange = (fn) => listeners.push(fn);

function changed() {
    save();
    for (const fn of listeners) { try { fn(); } catch (e) { console.error('[ST-Music]', e); } }
}

/** 只保留播放需要的字段，不带「剧情配乐推荐」之类的临时标记。 */
function plain(t) {
    return { key: t.key, platform: t.platform, id: t.id, title: t.title, artist: t.artist, cover: t.cover || '', urls: t.urls || [], lrcUrl: t.lrcUrl || '' };
}

function remember(track) {
    lib().tracks[track.key] = plain(track);
}

/** 清掉不再被任何地方引用的歌曲信息。 */
function prune() {
    const l = lib();
    const used = new Set([...l.fav, ...l.recent, ...Object.keys(l.plays), ...l.lists.flatMap((x) => x.keys), ...Object.values(l.ost || {}).flatMap((x) => x.keys)]);
    for (const k of Object.keys(l.tracks)) if (!used.has(k)) delete l.tracks[k];
}

// ---------- 剧情原声 ----------

/** 当前聊天的角色：{ key: 头像文件名, name, avatar: 头像地址 }；群聊或没有角色时返回 null。 */
function currentCharacter() {
    const c = globalThis.SillyTavern.getContext();
    if (c.groupId) return null;
    const ch = c.characters && c.characters[c.characterId];
    if (!ch || !ch.avatar) return null;
    return { key: ch.avatar, name: ch.name || '', avatar: `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}` };
}

/** 剧情配乐推荐、且实际播放够久的歌，记入当前角色的「剧情原声」，新的在前，每个角色至多 max 首。 */
function addOst(track) {
    const o = settings().rec.ost;
    if (!o.on || !track.rec) return;
    const ch = currentCharacter();
    if (!ch) return;
    const l = lib();
    if (!l.ost) l.ost = {};
    const entry = l.ost[ch.key] || (l.ost[ch.key] = { name: ch.name, avatar: ch.avatar, keys: [] });
    entry.name = ch.name;
    entry.avatar = ch.avatar;
    entry.keys = [track.key, ...entry.keys.filter((k) => k !== track.key)].slice(0, o.max);
}

/** 剧情原声列表：[{ key, name, avatar, keys }]，最近更新的角色在前。 */
export function ostLists() {
    const l = lib();
    return Object.entries(l.ost || {}).map(([key, v]) => ({ key, ...v })).filter((x) => x.keys.length);
}

export function deleteOst(key) {
    const l = lib();
    if (l.ost) delete l.ost[key];
    prune();
    changed();
}

export const tracksOf = (keys) => keys.map((k) => lib().tracks[k]).filter(Boolean);

// ---------- 收藏 ----------

export const isFav = (key) => lib().fav.includes(key);

export function toggleFav(track) {
    const l = lib();
    const on = !l.fav.includes(track.key);
    if (on) { remember(track); l.fav.unshift(track.key); } else { l.fav = l.fav.filter((k) => k !== track.key); prune(); }
    changed();
    return on;
}

// ---------- 歌单 ----------

/** 歌单来源；旧版本建的歌单没有记录来源，按名称判断（导入时默认名称以「导入的歌单」开头）。 */
export const originOf = (list) => list.origin || (/^导入的歌单/.test(list.name) ? 'text' : 'created');

/** 新建歌单。origin：'created' 自建 | 'netease' / 'qq' / 'text' 导入（「我的」页面据此分为创建、导入两类）。 */
export function createList(name, origin = 'created') {
    const list = { id: 'l' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), name: name.trim() || '未命名歌单', keys: [], origin };
    lib().lists.push(list);
    changed();
    return list;
}

export const getList = (id) => lib().lists.find((x) => x.id === id) || null;

export function renameList(id, name) {
    const list = getList(id);
    if (!list || !name.trim()) return;
    list.name = name.trim();
    changed();
}

export function deleteList(id) {
    const l = lib();
    l.lists = l.lists.filter((x) => x.id !== id);
    prune();
    changed();
}

/** 把歌加入歌单，返回新加入的数量（已在歌单里的不重复加）。 */
export function addToList(id, tracks) {
    const list = getList(id);
    if (!list) return 0;
    let n = 0;
    for (const t of tracks) {
        if (list.keys.includes(t.key)) continue;
        remember(t);
        list.keys.push(t.key);
        n += 1;
    }
    if (n) changed();
    return n;
}

export function removeFromList(id, key) {
    const list = getList(id);
    if (!list) return;
    list.keys = list.keys.filter((k) => k !== key);
    prune();
    changed();
}

// ---------- 播放记录 ----------

/** 一首歌播放够久后记一次：进入最近播放，播放次数加一。 */
export function countPlay(track) {
    const l = lib();
    remember(track);
    l.recent = [track.key, ...l.recent.filter((k) => k !== track.key)].slice(0, RECENT_MAX);
    l.plays[track.key] = (l.plays[track.key] || 0) + 1;
    addOst(track);
    prune();
    changed();
}

/** 播放次数排行：[{ track, n }]，次数多的在前。 */
export function ranking(limit = 50) {
    const l = lib();
    return Object.entries(l.plays)
        .map(([key, n]) => ({ track: l.tracks[key], n }))
        .filter((x) => x.track)
        .sort((a, b) => b.n - a.n)
        .slice(0, limit);
}

let unsaved = 0;

/** 累计收听时长，并按日期和小时分别记录（供以后的统计使用）。 */
export function addListening(seconds) {
    const l = lib();
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (!l.hours[day]) {
        l.hours[day] = new Array(24).fill(0);
        const days = Object.keys(l.hours).sort();
        while (days.length > KEEP_DAYS) delete l.hours[days.shift()];
    }
    l.hours[day][now.getHours()] += seconds;
    l.totalSec += seconds;
    unsaved += seconds;
    if (unsaved >= 30) { unsaved = 0; save(); }
}

// ---------- 导入 ----------

/**
 * 从粘贴的文字里找出网易云歌单编号。
 * 返回 { id } / { short: 短链接 } / null。链接里的其他参数（如用户编号）不保留。
 */
export function parsePlaylistInput(text) {
    const t = String(text || '').trim();
    if (/^\d{5,}$/.test(t)) return { id: t };
    const long = /playlist[^\s]*?[?&]id=(\d+)/i.exec(t) || /music\.163\.com[^\s]*?[?&]id=(\d+)/i.exec(t);
    if (long) return { id: long[1] };
    const short = /https?:\/\/163cn\.tv\/[A-Za-z0-9]+/i.exec(t);
    if (short) return { short: short[0] };
    return null;
}

/**
 * 通过酒馆服务器自带的网页访问功能打开 163cn.tv 短链接，从跳转后的页面里取歌单编号。
 * 请求只发往网易云自己的域名。隐私歌单的页面不含编号，返回 null。
 */
export async function resolveShort(url) {
    const c = globalThis.SillyTavern.getContext();
    const res = await fetch('/api/search/visit', {
        method: 'POST',
        headers: c.getRequestHeaders(),
        body: JSON.stringify({ url, html: true }),
    });
    if (!res.ok) throw new Error('visit');
    const html = await res.text();
    const m = /"info":\{"id":(\d+)/.exec(html) || /playlist\?id=(\d+)/.exec(html);
    return m ? m[1] : null;
}

/** 读取网易云歌单并存为本地歌单，返回 { list, count }。 */
export async function importPlaylist(id, name) {
    const tracks = await getPlaylist(id);
    if (!tracks.length) throw new Error('empty');
    const list = createList(name || `导入的歌单 ${id}`, 'netease');
    return { list, count: addToList(list.id, tracks) };
}

/**
 * 识别搜索框里粘贴的单曲链接或音频直链。
 * 返回 { song: 网易云歌曲编号 } / { songShort: 短链接 } / { direct: 地址 } / null。
 */
export function parseSongLink(text) {
    const t = String(text || '').trim();
    const song = /music\.163\.com[^\s]*?(?:song\?(?:[^\s]*?&)?id=|song\/)(\d+)/i.exec(t);
    if (song) return { song: song[1] };
    const short = /https?:\/\/163cn\.tv\/[A-Za-z0-9]+/i.exec(t);
    if (short) return { songShort: short[0] };
    if (/^https?:\/\/\S+$/i.test(t) && !/163\.com|qq\.com/i.test(t)) return { direct: t };
    return null;
}

/** 由音频直链生成一首歌：标题取文件名。 */
export function directTrack(url) {
    let name = url;
    try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || url); } catch (e) { /* 保持原样 */ }
    name = name.replace(/\.(mp3|m4a|aac|flac|ogg|opus|wav|webm)$/i, '');
    let hash = 0;
    for (const ch of url) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    return { key: 'url:' + (hash >>> 0).toString(36), platform: 'url', id: url, title: name || '音频直链', artist: '音频直链', cover: '', urls: [url], lrcUrl: '' };
}

/** 通过酒馆服务器打开网易云短链接，取单曲编号。取不到时返回 null。 */
export async function resolveSongShort(url) {
    const c = globalThis.SillyTavern.getContext();
    const res = await fetch('/api/search/visit', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ url, html: true }) });
    if (!res.ok) throw new Error('visit');
    const html = await res.text();
    const m = /song\?id=(\d+)/.exec(html) || /"songId"\s*:\s*"?(\d+)/.exec(html);
    return m ? m[1] : null;
}

/**
 * 从粘贴的文字里找出 QQ 音乐歌单编号。
 * 返回 { qq: 编号 } / { qqShort: 短链接 } / null。只取歌单编号，链接里的 hosteuin（创建者编号）等参数不保留。
 */
export function parseQQInput(text) {
    const t = String(text || '');
    if (!/qq\.com/i.test(t)) return null;
    const m = /y\.qq\.com[^\s]*?(?:playlist\/|[?&](?:id|disstid)=)(\d{5,})/i.exec(t);
    if (m) return { qq: m[1] };
    const s = /https?:\/\/c\d*\.y\.qq\.com\/[^\s]+/i.exec(t);
    if (s) return { qqShort: s[0] };
    return null;
}

/** 通过酒馆服务器打开 QQ 音乐短链接，从跳转后的页面里取歌单编号。取不到时返回 null。 */
export async function resolveQQShort(url) {
    const c = globalThis.SillyTavern.getContext();
    const res = await fetch('/api/search/visit', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ url, html: true }) });
    if (!res.ok) throw new Error('visit');
    const html = await res.text();
    const m = /[?&](?:id|disstid)=(\d{5,})/.exec(html) || /"(?:disstid|dissid|tid)"\s*:\s*"?(\d{5,})/.exec(html) || /playlist\/(\d{5,})/.exec(html);
    return m ? m[1] : null;
}

/**
 * 读取 QQ 音乐歌单，按「歌名 + 歌手」到当前音源匹配后存为本地歌单。
 * onProgress(text)；返回 { list, count, missed }。
 */
export async function importQQ(id, name, onProgress) {
    const pl = await getQQPlaylist(id, (n, total) => onProgress && onProgress(`正在读取 ${n} / ${total}`));
    if (!pl.songs.length) throw new Error('empty');
    const { found, missed } = await matchAll(pl.songs, (done, total) => onProgress && onProgress(`正在匹配 ${done} / ${total}`));
    if (!found.length) return { list: null, count: 0, missed };
    const list = createList(name || pl.title || `QQ 音乐歌单 ${id}`, 'qq');
    return { list, count: addToList(list.id, found), missed };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s·・\-—_()（）【】\[\]'"，,。.]/g, '');

/** 按歌名和歌手搜索一首歌，取最接近的结果；找不到返回 null。 */
async function matchOne(title, artist) {
    const results = await searchSongs(artist ? `${title} ${artist}` : title);
    const want = norm(title);
    const wantArtist = norm(String(artist || '').split('/')[0]);
    return results.find((r) => norm(r.title).includes(want) && (!wantArtist || norm(r.artist).includes(wantArtist)))
        || results.find((r) => norm(r.title).includes(want)) || null;
}

/** 并行匹配一组歌（同时 4 首），保持原顺序。songs: [{ title, artist }]。 */
async function matchAll(songs, onProgress) {
    const out = new Array(songs.length).fill(null);
    let next = 0, done = 0;
    const worker = async () => {
        while (next < songs.length) {
            const i = next++;
            try { out[i] = await matchOne(songs[i].title, songs[i].artist); } catch (e) { out[i] = null; }
            done += 1;
            if (onProgress) onProgress(done, songs.length);
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const found = [], missed = [];
    out.forEach((t, i) => { if (t) found.push(t); else missed.push(songs[i].artist ? `${songs[i].title} - ${songs[i].artist}` : songs[i].title); });
    return { found, missed };
}

/**
 * 按文本清单导入：每行「歌名 - 歌手」，歌手可省略。逐首搜索并取最接近的一首。
 * onProgress(done, total)；返回 { list, count, missed: [未匹配的行] }。
 */
export async function importText(text, name, onProgress) {
    const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) throw new Error('empty');
    const songs = lines.map((line) => { const [title, artist] = line.split(/\s+[-–—]\s+/).map((s) => s.trim()); return { title, artist }; });
    const { found, missed } = await matchAll(songs, onProgress);
    if (!found.length) return { list: null, count: 0, missed };
    const list = createList(name || '导入的歌单', 'text');
    return { list, count: addToList(list.id, found), missed };
}
