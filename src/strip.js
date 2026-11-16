// 歌词长条：一个可拖动的小窗，只显示当前这一句歌词。面板打开时隐藏。

import { settings, save } from './settings.js';
import { h, clamp, draggable } from './dom.js';
import * as player from './player.js';

let el, textEl;
let panelOpen = false;

function place() {
    const s = settings().strip;
    const w = el.offsetWidth || 260, ht = el.offsetHeight || 36;
    el.style.left = clamp(s.x * window.innerWidth - w / 2, 4, window.innerWidth - w - 4) + 'px';
    el.style.top = clamp(s.y * window.innerHeight - ht / 2, 4, window.innerHeight - ht - 4) + 'px';
}

/** 设置显示的文字；没有歌词时显示歌名和歌手。 */
export function setLine(text) {
    if (!textEl) return;
    const t = player.current();
    textEl.textContent = text || (t ? `${t.title} - ${t.artist}` : '');
}

/** 按开关、面板状态和是否有歌曲决定显示或隐藏。 */
export function sync(open) {
    if (!el) return;
    if (open !== undefined) panelOpen = open;
    const s = settings();
    const show = s.enabled && s.strip.on && !panelOpen && !!player.current();
    if (show) place();
    el.classList.toggle('stm-show', show);
}

export function init(onTap) {
    el = h('div', 'stm-strip');
    el.id = 'stm-strip';
    textEl = h('div', 'stm-strip-text');
    el.appendChild(textEl);
    draggable(el, {
        onStart: () => ({ x: el.offsetLeft, y: el.offsetTop }),
        onMove: (dx, dy, b) => {
            const w = el.offsetWidth, ht = el.offsetHeight;
            const x = clamp(b.x + dx, 4, window.innerWidth - w - 4);
            const y = clamp(b.y + dy, 4, window.innerHeight - ht - 4);
            el.style.left = x + 'px';
            el.style.top = y + 'px';
            settings().strip.x = (x + w / 2) / window.innerWidth;
            settings().strip.y = (y + ht / 2) / window.innerHeight;
        },
        onEnd: save,
    });
    el.addEventListener('click', () => { if (onTap) onTap(); });
    document.body.appendChild(el);
    window.addEventListener('resize', () => { if (el.classList.contains('stm-show')) place(); });
    player.on('track', () => { setLine(''); sync(); });
    setLine('');
    sync();
}
