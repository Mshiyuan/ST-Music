// 界面公用的小工具：创建元素、图标按钮、分段选择器、拖动。

const DRAG_THRESHOLD = 6;
const STAGGER_MAX = 12;

export function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
}

export function iconButton(icon, title, cls = '') {
    const b = h('button', `stm-btn stm-press ${cls}`.trim());
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.appendChild(h('i', `fa-solid ${icon}`));
    return b;
}

export function setIcon(btn, icon, title) {
    btn.firstChild.className = (icon.startsWith('fa-regular') ? '' : 'fa-solid ') + icon;
    if (title) { btn.title = title; btn.setAttribute('aria-label', title); }
}

export const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 把秒数写成「3 小时 20 分」这样的时长。 */
export const fmtDuration = (sec) => {
    const m = Math.floor((sec || 0) / 60);
    if (m < 60) return `${m} 分钟`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
};

export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** 分段选择器：滑块用 transform 移动。 */
export function makeSeg(options, value, onChange) {
    const seg = h('div', 'stm-seg');
    seg.style.setProperty('--n', options.length);
    seg.appendChild(h('div', 'stm-seg-thumb'));
    const set = (v, fire) => {
        const i = Math.max(0, options.findIndex((o) => o.value === v));
        seg.style.setProperty('--i', i);
        [...seg.querySelectorAll('button')].forEach((b, n) => b.classList.toggle('stm-on', n === i));
        if (fire) onChange(v);
    };
    for (const o of options) {
        const b = h('button', 'stm-seg-item', o.label);
        b.type = 'button';
        b.addEventListener('click', () => set(o.value, true));
        seg.appendChild(b);
    }
    set(value, false);
    seg.setValue = (v) => set(v, false);
    return seg;
}

/** 拖动：超过阈值才算拖动，否则算点击。 */
export function draggable(handle, { onStart, onMove, onEnd, onPress, onRelease }) {
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY;
        let moved = false;
        const base = onStart ? onStart(e) : null;
        if (onPress) onPress();
        const move = (ev) => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            moved = true;
            ev.preventDefault();
            onMove(dx, dy, base);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            if (onRelease) onRelease();
            if (moved) {
                // 拖动结束后不触发按钮的点击
                const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
                handle.addEventListener('click', stop, true);
                setTimeout(() => handle.removeEventListener('click', stop, true), 0);
                if (onEnd) onEnd();
            }
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    });
}

/** 歌曲列表里的一行：左边歌名和歌手，右边若干操作按钮。 */
export function songRow(track, i, actions = []) {
    const row = h('div', 'stm-row');
    row.style.setProperty('--i', Math.min(i, STAGGER_MAX));
    const main = h('div', 'stm-row-main stm-press');
    main.append(h('div', 'stm-row-title', track.title), h('div', 'stm-row-sub', track.artist));
    row.appendChild(main);
    for (const a of actions) row.appendChild(a);
    return { row, main };
}

export function hint(box, text) {
    box.replaceChildren(h('div', 'stm-hint', text));
}
