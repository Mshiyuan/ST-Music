// 歌库：收藏、歌单、最近播放、播放次数、收听时长。数据只保存在本地（酒馆的扩展设置里）。

import { settings, save } from './settings.js';
import { searchSongs, getPlaylist } from './sources.js';

const RECENT_MAX = 100;
const KEEP_DAYS = 120;          // 每小时收听时长保留的天数
const listeners = [];

export const lib = () => settings().lib;
export const onChange = (fn) => listeners.push(fn);

function changed() {
    save();
    for (const fn of listeners) { try { fn(); } catch (e) { console.error('[ST-Music]', e); } }
}

/** 只保留播放需要的字段，不带「按剧情推荐」之类的临时标记。 */
function plain(t) {
    return { key: t.key, platform: t.platform, id: t.id, title: t.title, artist: t.artist, cover: t.cover || '', urls: t.urls || [], lrcUrl: t.lrcUrl || '' };
}

function remember(track) {
    lib().tracks[track.key] = plain(track);
}

/** 清掉不再被任何地方引用的歌曲信息。 */
function prune() {
    const l = lib();
    const used = new Set([...l.fav, ...l.recent, ...Object.keys(l.plays), ...l.lists.flatMap((x) => x.keys)]);
    for (const k of Object.keys(l.tracks)) if (!used.has(k)) delete l.tracks[k];
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

export function createList(name) {
    const list = { id: 'l' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), name: name.trim() || '未命名歌单', keys: [] };
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

/** 读取网易云歌单并存为本地歌单，返回 { list, count }。 */
export async function importPlaylist(id, name) {
    const tracks = await getPlaylist(id);
    if (!tracks.length) throw new Error('empty');
    const list = createList(name || `导入的歌单 ${id}`);
    return { list, count: addToList(list.id, tracks) };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s·・\-—_()（）【】\[\]'"，,。.]/g, '');

/**
 * 按文本清单导入：每行「歌名 - 歌手」，歌手可省略。逐首搜索并取最接近的一首。
 * onProgress(done, total)；返回 { list, count, missed: [未匹配的行] }。
 */
export async function importText(text, name, onProgress) {
    const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) throw new Error('empty');
    const found = [];
    const missed = [];
    for (let i = 0; i < lines.length; i++) {
        const [title, artist] = lines[i].split(/\s+[-–—]\s+/).map((s) => s.trim());
        try {
            const results = await searchSongs(artist ? `${title} ${artist}` : title);
            const want = norm(title);
            const wantArtist = norm(artist);
            const hit = results.find((r) => norm(r.title).includes(want) && (!wantArtist || norm(r.artist).includes(wantArtist)))
                || results.find((r) => norm(r.title).includes(want));
            if (hit) found.push(hit); else missed.push(lines[i]);
        } catch (e) {
            missed.push(lines[i]);
        }
        if (onProgress) onProgress(i + 1, lines.length);
    }
    if (!found.length) return { list: null, count: 0, missed };
    const list = createList(name || '导入的歌单');
    return { list, count: addToList(list.id, found), missed };
}
