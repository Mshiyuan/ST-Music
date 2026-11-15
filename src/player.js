// 播放器：播放列表、播放控制、歌词加载。不包含任何界面代码。

import { settings, save, notify } from './settings.js';
import { getLyric, parseLyric } from './sources.js';

const LOAD_TIMEOUT = 12000;
const MAX_SKIPS = 5;

const audio = new Audio();
audio.preload = 'auto';

const listeners = {};
let loadToken = 0;
let skips = 0;

export const state = {
    playing: false,
    loading: false,
    lyric: [],          // [{ t, text }]
    lyricKey: null,
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

function setLoading(v) {
    state.loading = v;
    emit('state');
}

/** 尝试一个播放地址：能开始缓冲就算可用。 */
function tryUrl(url, token) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            audio.removeEventListener('canplay', onOk);
            audio.removeEventListener('error', onBad);
            resolve(ok && token === loadToken);
        };
        const onOk = () => finish(true);
        const onBad = () => finish(false);
        const timer = setTimeout(() => finish(false), LOAD_TIMEOUT);
        audio.addEventListener('canplay', onOk);
        audio.addEventListener('error', onBad);
        audio.src = url;
        audio.load();
    });
}

async function loadLyric(track) {
    state.lyric = [];
    state.lyricKey = track.key;
    emit('lyric');
    const text = await getLyric(track);
    if (state.lyricKey !== track.key) return;
    state.lyric = parseLyric(text);
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
    const token = ++loadToken;
    audio.pause();
    state.playing = false;
    emit('track');
    loadLyric(track);
    if (!autoplay) { emit('state'); return; }

    setLoading(true);
    let ok = false;
    for (const url of track.urls || []) {
        if (!url) continue;
        ok = await tryUrl(url, token);
        if (token !== loadToken) return;      // 期间已切到别的歌
        if (ok) break;
    }
    setLoading(false);

    if (!ok) {
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
    try {
        await audio.play();
    } catch (e) {
        // 浏览器拦截了自动播放时，停在暂停状态，等用户点播放
    }
    prefetchNext();
}

export function toggle() {
    const t = current();
    if (!t) return;
    if (!audio.src || audio.error) { playIndex(index()); return; }
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function stepIndex(dir) {
    const q = queue();
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
audio.addEventListener('timeupdate', () => emit('time'));
audio.addEventListener('durationchange', () => emit('time'));
audio.addEventListener('ended', () => {
    if (settings().mode === 'single') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    next();
});

export function init() {
    audio.volume = settings().volume;
    const t = current();
    if (t) { emit('track'); loadLyric(t); }
}
