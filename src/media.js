// 后台播放：向系统登记正在播放的媒体（通知栏的播放控制），以及可选的后台保活。

import { settings } from './settings.js';
import * as player from './player.js';

let keeper = null;        // 循环播放无声音频的元素
let lastPosition = 0;

/** 生成一段一秒的无声音频（8 位单声道 WAV）。 */
function silentUrl() {
    const rate = 8000;
    const bytes = new Uint8Array(44 + rate);
    const view = new DataView(bytes.buffer);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
    text(0, 'RIFF'); view.setUint32(4, 36 + rate, true); text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    text(36, 'data'); view.setUint32(40, rate, true);
    bytes.fill(128, 44);
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

/**
 * 后台保活：用户处于「想听」的状态时循环播放无声音频，
 * 使页面在两首歌之间的空档也保持「正在播放」，降低被系统挂起的可能。
 */
export function syncKeepAlive() {
    const want = settings().enabled && settings().keepAlive && player.isActive();
    if (want) {
        if (!keeper) { keeper = new Audio(silentUrl()); keeper.loop = true; }
        if (keeper.paused) keeper.play().then(() => player.trace('保活音频已开始'), (e) => player.trace(`保活音频被拒绝：${(e && e.name) || '未知'}`));
    } else if (keeper && !keeper.paused) {
        keeper.pause();
    }
}

function syncMeta() {
    const t = player.current();
    if (!t) { navigator.mediaSession.metadata = null; return; }
    navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist, artwork: t.cover ? [{ src: t.cover, sizes: '512x512' }] : [],
    });
}

function syncPosition() {
    const d = player.duration(), p = player.time();
    if (!d || p > d || Math.abs(p - lastPosition) < 1) return;
    lastPosition = p;
    try { navigator.mediaSession.setPositionState({ duration: d, position: p, playbackRate: 1 }); } catch (e) { /* 部分浏览器不支持 */ }
}

export function init() {
    player.on('state', syncKeepAlive);
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const ms = navigator.mediaSession;
    const handle = (name, fn) => { try { ms.setActionHandler(name, fn); } catch (e) { /* 该动作不受支持 */ } };
    handle('play', () => player.play());
    handle('pause', () => player.pause());
    handle('previoustrack', () => player.prev());
    handle('nexttrack', () => player.next());
    handle('seekto', (d) => { if (typeof d.seekTime === 'number') player.seekTo(d.seekTime); });
    player.on('track', () => { lastPosition = -10; syncMeta(); });
    player.on('state', () => { ms.playbackState = player.state.playing ? 'playing' : 'paused'; });
    player.on('time', syncPosition);
    syncMeta();
}
