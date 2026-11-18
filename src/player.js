// 播放器：播放列表、播放控制、歌词加载。不包含任何界面代码。

import { settings, save, notify } from './settings.js';
import { getLyric, parseLyric } from './sources.js';
import * as library from './library.js';
import { BufferPlayer } from './webaudio.js';

const LOAD_TIMEOUT = 12000;
const BUFFER_LOAD_TIMEOUT = 40000;   // 音频线程方式需下载整首后再解码，等待时间放宽
const MAX_SKIPS = 5;

// 播放元素：标准方式为 HTMLAudioElement；「音频线程」方式为 BufferPlayer（见 webaudio.js），接口相同
let audio = new Audio();
audio.preload = 'auto';
const isBuffer = () => audio instanceof BufferPlayer;
let plannedIndex = -1;         // 音频线程方式下已安排好的下一首在列表中的位置

const listeners = {};
const badKeys = new Set();     // 本次会话里确认不能播的歌
let loadToken = 0;
let skips = 0;
let pendingNext = null;        // 当前这首播完后要切到的歌（剧情配乐推荐的第一首）
let userPaused = false;        // 用户主动暂停后，自动推荐不擅自开始播放
let started = false;           // 本次会话里是否已经开始过播放
let lastTime = 0;              // 上一次进度回报时的播放位置，用来累计收听时长
let counted = false;           // 当前这首是否已经记过一次播放

const COUNT_AFTER = 30;        // 播放满多少秒（或超过一半）记一次播放

// 播放记录：用于排查页面在后台时的中断。只保存在内存里。
const TRACE_MAX = 80;
const traces = [];
export function trace(text) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    traces.push({ time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, hidden: document.hidden, text });
    if (traces.length > TRACE_MAX) traces.shift();
}
export const getTraceItems = () => traces;
export const getTrace = () => traces.map((t) => `${t.time} ${t.hidden ? '后台' : '前台'} ${t.text}`).join('\n');

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
        const onOk = () => { if (play) trace('可以播放'); finish(true); };
        const onBad = () => { if (play) trace('加载出错'); finish(false); };
        const timer = setTimeout(() => { if (play) trace('加载超时'); finish(false); }, el instanceof BufferPlayer ? BUFFER_LOAD_TIMEOUT : LOAD_TIMEOUT);
        el.addEventListener('canplay', onOk);
        el.addEventListener('error', onBad);
        el.src = url;
        el.load();
        // 立即发起播放而不是等缓冲完成：少一次等待，也更容易通过浏览器的自动播放限制
        if (play) {
            trace('设置地址并请求播放');
            el.play().then(() => trace('播放请求成功'), (e) => trace(`播放请求被拒绝：${(e && e.name) || '未知'}`));
        }
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
    if (urls[1] && !document.hidden && !isBuffer()) {
        spare = new Audio();
        spare.preload = 'auto';
        spareResult = attempt(spare, urls[1], false);
    }
    if (await main) { release(spare); return token === loadToken; }
    if (token !== loadToken) { release(spare); return false; }
    if (!spare) {
        // 音频线程方式不预热第二个地址；第一个失败时直接在同一个播放元素上换第二个
        if (!urls[1] || !isBuffer()) return false;
        const ok2 = await attempt(audio, urls[1], true);
        if (ok2) track.urls = [urls[1], urls[0], ...urls.slice(2)];
        return ok2 && token === loadToken;
    }
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

/**
 * 音频线程方式：确定下一首并交给播放元素预先安排，使当前这首结束时在音频线程上直接接上，不需要脚本参与。
 * 下一首的选择与「播完后切换」相同：先看剧情配乐等待切换的歌，再按播放模式。单曲循环时不安排。
 */
function planNext() {
    if (!isBuffer()) return;
    const q = queue();
    const s = settings();
    plannedIndex = -1;
    if (!current() || (s.mode === 'single' && !pendingNext) || q.length < 2) { audio.setNext(null); return; }
    let j = -1;
    if (pendingNext) j = q.findIndex((t) => t.key === pendingNext);
    if (j < 0 && s.mode === 'shuffle') { do j = Math.floor(Math.random() * q.length); while (j === s.index); }
    if (j < 0) j = (s.index + 1) % q.length;
    const t = q[j];
    const url = (t.urls || []).find(Boolean);
    if (!t || badKeys.has(t.key) || !url) { audio.setNext(null); return; }
    plannedIndex = j;
    audio.setNext(url, t.key);
    getLyric(t).catch(() => {});
}

export async function playIndex(i, autoplay = true) {
    const q = queue();
    if (!q.length) return;
    const s = settings();
    s.index = ((i % q.length) + q.length) % q.length;
    save();
    const track = q[s.index];
    if (pendingNext === track.key) pendingNext = null;
    syncLoop();
    const token = ++loadToken;
    trace(`切换到：${track.title}`);
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
    planNext();
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
    // 音频线程方式下已安排好的下一首：手动「下一首」也切到它，与自动接续一致
    if (dir > 0 && plannedIndex >= 0 && plannedIndex < q.length) {
        const p = plannedIndex;
        plannedIndex = -1;
        if (pendingNext === q[p].key) pendingNext = null;
        return p;
    }
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
    planNext();
    return true;
}

/**
 * 放入一批剧情配乐推荐的歌。
 * 新歌排在当前这首之后；以前推荐的歌保留，超过上限时去掉最早的；手动加入的歌不受影响。
 * immediate 为 true（手动刷新）或设置为「立即切换」时马上播放第一首；否则等当前这首播完再切。
 */
export function setRecommended(tracks, immediate) {
    const s = settings();
    const cur = current();
    const now = Date.now();
    const fresh = tracks.filter((t) => !s.queue.some((k) => k.key === t.key)).map((t) => ({ ...t, rec: true, recAt: now }));
    if (!fresh.length) return 0;
    // 以前推荐的歌留在列表里；总数超过上限时去掉最早推荐的（正在播放的那首不动）
    const old = s.queue.filter((t) => t.rec && t !== cur).sort((a, b) => (a.recAt || 0) - (b.recAt || 0));
    const over = old.length + fresh.length - Math.max(fresh.length, s.rec.keep);
    const drop = new Set(over > 0 ? old.slice(0, over) : []);
    const kept = s.queue.filter((t) => !drop.has(t));
    const at = cur ? kept.indexOf(cur) + 1 : 0;
    s.queue = [...kept.slice(0, at), ...fresh, ...kept.slice(at)];
    s.index = cur ? at - 1 : -1;
    save();
    emit('queue');
    const idle = !state.playing && !state.loading;
    if (immediate || s.rec.arrive === 'now' || !cur || (idle && !userPaused)) {
        playIndex(at);
    } else {
        pendingNext = fresh[0].key;
        syncLoop();
        planNext();
    }
    return fresh.length;
}

export const removeAt = (i) => removeMany([i]);

/** 一次移出多首。移出的歌包含正在播放的那首时，接着播放它之后第一首未被移出的歌。 */
export function removeMany(indices) {
    const s = settings();
    const gone = new Set(indices.filter((i) => i >= 0 && i < s.queue.length));
    if (!gone.size) return;
    const cur = current();
    const wasCurrent = gone.has(s.index);
    let after = null;
    if (wasCurrent) {
        const n = s.queue.length;
        for (let d = 1; d < n && !after; d++) { const j = (s.index + d) % n; if (!gone.has(j)) after = s.queue[j]; }
    }
    s.queue = s.queue.filter((_, j) => !gone.has(j));
    const q = s.queue;
    if (!wasCurrent) s.index = cur ? q.indexOf(cur) : -1;
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
        s.index = Math.max(0, q.indexOf(after));
        save();
        emit('queue');
        playIndex(s.index, keep);
        return;
    }
    save();
    emit('queue');
    emit('track');
    emit('lyric');
    planNext();
}

/** 单曲循环交给播放器自带的循环：一曲结束时不需要脚本参与，页面在后台时也能循环。 */
function syncLoop() {
    audio.loop = settings().mode === 'single' && !pendingNext;
}

export function cycleMode() {
    const order = ['loop', 'single', 'shuffle'];
    const s = settings();
    s.mode = order[(order.indexOf(s.mode) + 1) % order.length];
    syncLoop();
    planNext();
    save();
    emit('state');
    return s.mode;
}

function bindAudio(audio) {
audio.addEventListener('play', () => { state.playing = true; emit('state'); });
audio.addEventListener('pause', () => { state.playing = false; emit('state'); });
// 音频线程方式：当前这首结束时已在音频线程上接上了下一首，这里只更新列表位置和界面，不重新加载
audio.addEventListener('advance', (e) => {
    const key = e.detail.key;
    const q = queue();
    const s = settings();
    let i = plannedIndex >= 0 && q[plannedIndex] && q[plannedIndex].key === key ? plannedIndex : q.findIndex((t) => t.key === key);
    plannedIndex = -1;
    if (pendingNext === key) pendingNext = null;
    if (i < 0) return;
    s.index = i;
    save();
    counted = false;
    lastTime = 0;
    trace(`音频线程接续：${q[i].title}`);
    syncLoop();
    emit('track');
    emit('state');
    loadLyric(q[i]);
    prefetchNext();
    planNext();
});
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
audio.addEventListener('stalled', () => trace('数据中断'));
audio.addEventListener('waiting', () => trace('等待缓冲'));
audio.addEventListener('playing', () => trace('开始出声'));
audio.addEventListener('ended', () => {
    trace('一曲结束');
    if (settings().mode === 'single' && !pendingNext) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    next();
});
}
bindAudio(audio);
document.addEventListener('visibilitychange', () => trace(document.hidden ? '页面转入后台' : '页面回到前台'));

/**
 * 切换播放方式：'element' 标准（HTMLAudioElement）| 'buffer' 音频线程（Web Audio）。
 * 切换时停止当前播放，保留播放位置，不自动开始播放。
 */
export function setEngine(kind) {
    const want = kind === 'buffer';
    if (want === isBuffer()) return;
    const pos = audio.currentTime || 0;
    const wasStarted = started;
    loadToken++;
    audio.pause();
    if (isBuffer()) { audio.src = ''; } else { audio.removeAttribute('src'); audio.load(); }
    audio = want ? new BufferPlayer() : new Audio();
    if (!want) audio.preload = 'auto';
    bindAudio(audio);
    audio.volume = settings().volume;
    plannedIndex = -1;
    syncLoop();
    state.playing = false;
    started = false;
    emit('state');
    const t = current();
    // 本次会话还没播放过时不预先下载（音频线程方式会下载整首）
    if (t && wasStarted) {
        const urls = (t.urls || []).filter(Boolean);
        if (urls[0]) {
            audio.src = urls[0];
            audio.load();
            if (pos) { const go = () => { audio.currentTime = pos; audio.removeEventListener('canplay', go); }; audio.addEventListener('canplay', go); }
        }
    }
    trace(want ? '播放方式：音频线程' : '播放方式：标准');
}

export function init() {
    if (settings().engine === 'buffer') setEngine('buffer');
    audio.volume = settings().volume;
    syncLoop();
    const t = current();
    if (t) { emit('track'); loadLyric(t); }
}
