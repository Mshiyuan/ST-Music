// 播放器：播放列表、播放控制、歌词加载。不包含任何界面代码。

import { settings, save, notify } from './settings.js';
import { getLyric, parseLyric } from './sources.js';
import * as library from './library.js';

const LOAD_TIMEOUT = 12000;
const MAX_SKIPS = 5;

const audio = new Audio();
audio.preload = 'auto';

const listeners = {};
const badKeys = new Set();     // 本次会话里确认不能播的歌
let loadToken = 0;
let skips = 0;
let pendingNext = null;        // 当前这首播完后要切到的歌（按剧情推荐的第一首）
let userPaused = false;        // 用户主动暂停后，自动推荐不擅自开始播放
let started = false;           // 本次会话里是否已经开始过播放
let lastTime = 0;              // 上一次进度回报时的播放位置，用来累计收听时长
let counted = false;           // 当前这首是否已经记过一次播放

const COUNT_AFTER = 30;        // 播放满多少秒（或超过一半）记一次播放

export const state = {
    playing: false,
    loading: false,
    lyric: [],          // [{ t, text, trans }]
    lyricKey: null,
    hasTrans: false,
};

export function on(name, fn) {
    (listeners[name] || (listeners[name] = [])).push(fn);
}

function emit(name, data) {
    for (const fn of listeners[name] || []) {
        try { fn(data); } catch (e) { console.error('[ST-Music]', e); }
    }
}

export const queue = () => settings().queue;
export const index = () => settings().index;
export const current = () => queue()[index()] || null;
export const time = () => audio.currentTime || 0;
export const duration = () => (Number.isFinite(audio.duration) ? audio.duration : 0);
/** 用户是否处于「想听」的状态：开始过播放且没有主动暂停。后台保活据此决定是否工作。 */
export const isActive = () => started && !userPaused && !!current();

function setLoading(v) {
    state.loading = v;
    emit('state');
}

/** 在一个播放元素上尝试一个地址：能开始缓冲就算可用。play 为 true 时同时发起播放。 */
function attempt(el, url, play) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            el.removeEventListener('canplay', onOk);
            el.removeEventListener('error', onBad);
            resolve(ok);
        };
        const onOk = () => finish(true);
        const onBad = () => finish(false);
        const timer = setTimeout(() => finish(false), LOAD_TIMEOUT);
        el.addEventListener('canplay', onOk);
        el.addEventListener('error', onBad);
        el.src = url;
        el.load();
        // 立即发起播放而不是等缓冲完成：少一次等待，也更容易通过浏览器的自动播放限制
        if (play) el.play().catch(() => {});
    });
}

function release(el) {
    if (!el) return;
    el.removeAttribute('src');
    el.load();
}

/** 第一个地址直接在主播放器上播放，同时在后台预热第二个地址；第一个失败时切到已预热的第二个。 */
async function startTrack(track, token) {
    const urls = (track.urls || []).filter(Boolean);
    if (!urls.length) return false;
    const main = attempt(audio, urls[0], true);
    let spare = null, spareResult = null;
    // 页面在后台时不新建播放元素：后台新建的元素可能被浏览器拦截
    if (urls[1] && !document.hidden) {
        spare = new Audio();
        spare.preload = 'auto';
        spareResult = attempt(spare, urls[1], false);
    }
    if (await main) { release(spare); return token === loadToken; }
    if (token !== loadToken) { release(spare); return false; }
    if (!spare) return false;
    const spareOk = await spareResult;
    release(spare);
    if (!spareOk || token !== loadToken) return false;
    const ok = await attempt(audio, urls[1], true);
    if (ok) track.urls = [urls[1], urls[0], ...urls.slice(2)];
    return ok && token === loadToken;
}

async function loadLyric(track) {
    state.lyric = [];
    state.hasTrans = false;
    state.lyricKey = track.key;
    emit('lyric');
    const data = await getLyric(track);
    if (state.lyricKey !== track.key) return;
    state.lyric = parseLyric(data.lrc, data.trans);
    state.hasTrans = state.lyric.some((l) => l.trans);
    emit('lyric');
}

function prefetchNext() {
    const q = queue();
    if (q.length < 2 || settings().mode === 'shuffle') return;
    const next = q[(index() + 1) % q.length];
    if (!next) return;
    getLyric(next).catch(() => {});
    if (next.cover) { const img = new Image(); img.src = next.cover; }
}

export async function playIndex(i, autoplay = true) {
    const q = queue();
    if (!q.length) return;
    const s = settings();
    s.index = ((i % q.length) + q.length) % q.length;
    save();
    const track = q[s.index];
    if (pendingNext === track.key) pendingNext = null;
    const token = ++loadToken;
    audio.pause();
    state.playing = false;
    emit('track');
    loadLyric(track);
    if (!autoplay) { emit('state'); return; }

    userPaused = false;
    started = true;
    lastTime = 0;
    counted = false;
    let ok = false;
    if (!badKeys.has(track.key)) {
        setLoading(true);
        ok = await startTrack(track, token);
        if (token !== loadToken) return;      // 期间已切到别的歌
        setLoading(false);
    }

    if (!ok) {
        badKeys.add(track.key);
        notify(`无法播放：${track.title}`, 'warning');
        skips += 1;
        if (skips >= Math.min(MAX_SKIPS, q.length)) {
            skips = 0;
            notify('连续多首无法播放，已停止', 'error');
            return;
        }
        return playIndex(s.index + 1);
    }
    skips = 0;
    if (audio.paused) audio.play().catch(() => {});   // 被浏览器拦截时停在暂停状态，等用户点播放
    prefetchNext();
}

export function toggle() {
    const t = current();
    if (!t) return;
    if (!audio.src || audio.error) { playIndex(index()); return; }
    if (audio.paused) { userPaused = false; audio.play().catch(() => {}); } else { userPaused = true; audio.pause(); }
    emit('state');
}

export function play() {
    if (audio.paused) toggle();
}

export function pause() {
    if (!audio.paused) toggle();
}

function stepIndex(dir) {
    const q = queue();
    if (dir > 0 && pendingNext) {
        const p = q.findIndex((t) => t.key === pendingNext);
        pendingNext = null;
        if (p >= 0) return p;
    }
    if (settings().mode === 'shuffle' && q.length > 1) {
        let r = index();
        while (r === index()) r = Math.floor(Math.random() * q.length);
        return r;
    }
    return index() + dir;
}

export const next = () => playIndex(stepIndex(1));
export const prev = () => playIndex(stepIndex(-1));

export function seek(ratio) {
    const d = duration();
    if (d) audio.currentTime = Math.max(0, Math.min(1, ratio)) * d;
}

export function seekTo(seconds) {
    if (duration()) audio.currentTime = seconds;
}

/** 加入列表并立即播放；已在列表里的直接跳过去。 */
export function playTrack(track) {
    const q = queue();
    let i = q.findIndex((t) => t.key === track.key);
    if (i < 0) { q.splice(index() + 1, 0, track); i = index() + 1; }
    emit('queue');
    playIndex(i);
}

/** 用一组歌替换整个播放列表，并从指定位置开始播放。 */
export function playAll(tracks, start = 0) {
    if (!tracks.length) return;
    const s = settings();
    s.queue = tracks.map((t) => ({ ...t }));
    s.index = -1;
    pendingNext = null;
    emit('queue');
    playIndex(start);
}

export function enqueue(track) {
    const q = queue();
    if (q.some((t) => t.key === track.key)) return false;
    q.push(track);
    if (settings().index < 0) settings().index = 0;
    save();
    emit('queue');
    if (q.length === 1) emit('track');
    return true;
}

/**
 * 放入一批按剧情推荐的歌。
 * 上一批推荐的歌被替换，手动加入的歌保留；新歌排在当前这首之后。
 * immediate 为 true（手动刷新）时立即播放第一首；否则等当前这首播完再切。
 */
export function setRecommended(tracks, immediate) {
    const s = settings();
    const cur = current();
    const kept = s.queue.filter((t) => !t.rec || t === cur);
    const fresh = tracks.filter((t) => !kept.some((k) => k.key === t.key)).map((t) => ({ ...t, rec: true }));
    if (!fresh.length) return 0;
    const at = cur ? kept.indexOf(cur) + 1 : 0;
    s.queue = [...kept.slice(0, at), ...fresh, ...kept.slice(at)];
    s.index = cur ? at - 1 : -1;
    save();
    emit('queue');
    const idle = !state.playing && !state.loading;
    if (immediate || !cur || (idle && !userPaused)) {
        playIndex(at);
    } else {
        pendingNext = fresh[0].key;
    }
    return fresh.length;
}

export function removeAt(i) {
    const q = queue();
    const s = settings();
    const wasCurrent = i === s.index;
    q.splice(i, 1);
    if (i < s.index) s.index -= 1;
    if (!q.length) {
        s.index = -1;
        loadToken++;
        audio.pause();
        audio.removeAttribute('src');
        state.lyric = [];
        state.lyricKey = null;
        state.hasTrans = false;
    } else if (wasCurrent) {
        const keep = state.playing;
        save();
        emit('queue');
        playIndex(Math.min(i, q.length - 1), keep);
        return;
    }
    save();
    emit('queue');
    emit('track');
    emit('lyric');
}

export function cycleMode() {
    const order = ['loop', 'single', 'shuffle'];
    const s = settings();
    s.mode = order[(order.indexOf(s.mode) + 1) % order.length];
    save();
    emit('state');
    return s.mode;
}

audio.addEventListener('play', () => { state.playing = true; emit('state'); });
audio.addEventListener('pause', () => { state.playing = false; emit('state'); });
audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime;
    const delta = t - lastTime;
    lastTime = t;
    if (delta > 0 && delta < 1.5) library.addListening(delta);   // 跳转造成的大跨度不计入
    const track = current();
    if (!counted && track && (t >= COUNT_AFTER || (duration() && t >= duration() / 2))) {
        counted = true;
        library.countPlay(track);
    }
    emit('time');
});
audio.addEventListener('durationchange', () => emit('time'));
audio.addEventListener('ended', () => {
    if (settings().mode === 'single' && !pendingNext) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    next();
});

export function init() {
    audio.volume = settings().volume;
    const t = current();
    if (t) { emit('track'); loadLyric(t); }
}
