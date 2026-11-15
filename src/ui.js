// 界面：悬浮按钮、播放面板（卡片 / 抽屉）、搜索、播放列表、歌词。

import { settings, save, notify } from './settings.js';
import { searchSongs } from './sources.js';
import * as player from './player.js';

const MIN_W = 280;
const MIN_H = 400;
const DRAG_THRESHOLD = 6;
const STAGGER_MAX = 12;

let fab, panel, els = {};
let view = 'now';
let seeking = false;
let lyricIndex = -1;
let searchToken = 0;
let lyricOffset = 0;
let manualUntil = 0;          // 手动滑动歌词后，在这个时间点之前不自动滚动
const MANUAL_HOLD = 3000;

function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
}

function iconButton(icon, title, cls = '') {
    const b = h('button', `stm-btn stm-press ${cls}`.trim());
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.appendChild(h('i', `fa-solid ${icon}`));
    return b;
}

const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** 分段选择器：滑块用 transform 移动。 */
export function makeSeg(options, value, onChange) {
    const seg = h('div', 'stm-seg');
    seg.style.setProperty('--n', options.length);
    const thumb = h('div', 'stm-seg-thumb');
    seg.appendChild(thumb);
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
function draggable(handle, { onStart, onMove, onEnd, onTap, ignore }) {
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (ignore && e.target.closest(ignore)) return;
        const sx = e.clientX, sy = e.clientY;
        let moved = false;
        const base = onStart ? onStart(e) : null;
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
            if (moved) {
                // 拖动结束后不触发按钮的点击
                const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
                handle.addEventListener('click', stop, true);
                setTimeout(() => handle.removeEventListener('click', stop, true), 0);
                if (onEnd) onEnd();
            } else if (onTap) onTap(e);
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    });
}

// ---------- 悬浮按钮 ----------

function placeFab() {
    const s = settings().fab;
    const size = fab.offsetWidth || 48;
    fab.style.left = clamp(s.x * window.innerWidth - size / 2, 4, window.innerWidth - size - 4) + 'px';
    fab.style.top = clamp(s.y * window.innerHeight - size / 2, 4, window.innerHeight - size - 4) + 'px';
}

function buildFab() {
    fab = h('div', 'stm-fab stm-press');
    fab.id = 'stm-fab';
    fab.setAttribute('role', 'button');
    fab.title = '音乐';
    fab.appendChild(h('i', 'fa-solid fa-music'));
    draggable(fab, {
        onStart: () => ({ x: fab.offsetLeft, y: fab.offsetTop }),
        onMove: (dx, dy, b) => {
            const size = fab.offsetWidth;
            const x = clamp(b.x + dx, 4, window.innerWidth - size - 4);
            const y = clamp(b.y + dy, 4, window.innerHeight - size - 4);
            fab.style.left = x + 'px';
            fab.style.top = y + 'px';
            settings().fab = { x: (x + size / 2) / window.innerWidth, y: (y + size / 2) / window.innerHeight };
        },
        onEnd: save,
    });
    // 用点击事件开关面板：若在按下抬起时就打开，同一次点击会落到刚出现的面板上
    fab.addEventListener('click', () => togglePanel());
    document.body.appendChild(fab);
    placeFab();
}

// ---------- 面板位置与大小 ----------

function applyCard() {
    const c = settings().card;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = clamp(c.w, Math.min(MIN_W, vw - 8), vw - 8);
    const ht = clamp(c.h, Math.min(MIN_H, vh - 8), vh - 8);
    const x = clamp(c.x === null ? (vw - w) / 2 : c.x, 4, vw - w - 4);
    const y = clamp(c.y === null ? (vh - ht) / 2 : c.y, 4, vh - ht - 4);
    panel.style.setProperty('--stm-x', x + 'px');
    panel.style.setProperty('--stm-y', y + 'px');
    panel.style.setProperty('--stm-w', w + 'px');
    panel.style.setProperty('--stm-h', ht + 'px');
    return { x, y, w, h: ht };
}

export function applyForm() {
    panel.dataset.form = settings().panelForm;
    applyCard();
    scrollLyric(true);
}

function bindResize(corner) {
    const grip = h('div', `stm-rz stm-rz-${corner}`);
    // 触屏会把落点吸附到附近可点击的元素上；让手柄自身可响应点击，落在手柄上时就不会被旁边的按钮抢走
    grip.addEventListener('click', () => {});
    draggable(grip, {
        onStart: () => applyCard(),
        onMove: (dx, dy, b) => {
            const c = settings().card;
            const vw = window.innerWidth, vh = window.innerHeight;
            let { x, y, w, h: ht } = b;
            if (corner.includes('e')) w = clamp(b.w + dx, MIN_W, vw - b.x - 4);
            if (corner.includes('s')) ht = clamp(b.h + dy, MIN_H, vh - b.y - 4);
            if (corner.includes('w')) { w = clamp(b.w - dx, MIN_W, b.x + b.w - 4); x = b.x + b.w - w; }
            if (corner.includes('n')) { ht = clamp(b.h - dy, MIN_H, b.y + b.h - 4); y = b.y + b.h - ht; }
            Object.assign(c, { x, y, w, h: ht });
            applyCard();
            scrollLyric(true);
        },
        onEnd: save,
    });
    panel.appendChild(grip);
}

// ---------- 面板 ----------

function buildPanel() {
    panel = h('div', 'stm-panel');
    panel.id = 'stm-panel';

    const head = h('div', 'stm-head');
    els.tabs = makeSeg([
        { value: 'now', label: '播放' },
        { value: 'search', label: '搜索' },
        { value: 'queue', label: '列表' },
    ], view, showView);
    const close = iconButton('fa-xmark', '关闭', 'stm-close');
    close.addEventListener('click', () => togglePanel(false));
    const row = h('div', 'stm-head-row');
    row.append(els.tabs, close);
    head.append(h('div', 'stm-grab'), row);
    draggable(head, {
        onStart: () => (settings().panelForm === 'card' ? applyCard() : null),
        onMove: (dx, dy, b) => {
            if (!b) return;
            const c = settings().card;
            c.x = b.x + dx; c.y = b.y + dy; c.w = b.w; c.h = b.h;
            applyCard();
        },
        onEnd: save,
    });

    const body = h('div', 'stm-body');
    body.append(buildNow(), buildSearch(), buildQueue());
    panel.append(head, body);
    for (const c of ['nw', 'ne', 'sw', 'se']) bindResize(c);
    document.body.appendChild(panel);
    applyForm();
    showView(view);
}

export function togglePanel(force) {
    const open = force === undefined ? !panel.classList.contains('stm-open') : force;
    if (open) applyCard();
    panel.classList.toggle('stm-open', open);
    fab.classList.toggle('stm-active', open);
    if (open) { if (view === 'queue') renderQueue(); scrollLyric(true); }
}

function showView(v) {
    view = v;
    els.tabs.setValue(v);
    for (const el of panel.querySelectorAll('.stm-view')) el.classList.toggle('stm-show', el.dataset.view === v);
    if (v === 'queue') renderQueue();
    if (v === 'search') setTimeout(() => { if (window.matchMedia('(pointer: fine)').matches) els.input.focus(); }, 60);
    if (v === 'now') scrollLyric(true);
}

// ---------- 播放页 ----------

function buildNow() {
    const sec = h('section', 'stm-view');
    sec.dataset.view = 'now';

    const stage = h('div', 'stm-stage');
    stage.title = '点击切换唱片与歌词';
    const discWrap = h('div', 'stm-disc-wrap');
    const arm = h('div', 'stm-arm');
    arm.append(h('div', 'stm-arm-bar'), h('div', 'stm-arm-head'));
    const disc = h('div', 'stm-disc');
    els.cover = h('img', 'stm-cover');
    els.cover.alt = '';
    els.cover.addEventListener('error', () => { els.cover.style.visibility = 'hidden'; });
    els.cover.addEventListener('load', () => { els.cover.style.visibility = ''; });
    disc.appendChild(els.cover);
    discWrap.append(disc, arm);
    els.lyrics = h('div', 'stm-lyrics');
    els.lyricsInner = h('div', 'stm-lyrics-inner');
    els.lyrics.appendChild(els.lyricsInner);
    stage.append(discWrap, els.lyrics);
    stage.addEventListener('click', () => {
        stage.classList.toggle('stm-show-lyrics');
        manualUntil = 0;
        scrollLyric(true);
    });
    // 手动滑动歌词：松手后暂停自动滚动几秒，之后回到当前句
    draggable(els.lyrics, {
        onStart: () => lyricOffset,
        onMove: (dx, dy, base) => {
            const kids = els.lyricsInner.children;
            if (!kids.length) return;
            const half = els.lyrics.clientHeight / 2;
            const first = kids[0], last = kids[kids.length - 1];
            const max = half - (first.offsetTop + first.offsetHeight / 2);
            const min = half - (last.offsetTop + last.offsetHeight / 2);
            lyricOffset = clamp(base + dy, min, max);
            manualUntil = Date.now() + MANUAL_HOLD;
            els.lyricsInner.classList.add('stm-instant');
            els.lyricsInner.style.transform = `translateY(${Math.round(lyricOffset)}px)`;
        },
        onEnd: () => { manualUntil = Date.now() + MANUAL_HOLD; },
    });
    els.stage = stage;

    const meta = h('div', 'stm-meta');
    els.title = h('div', 'stm-title', '未选择歌曲');
    els.artist = h('div', 'stm-artist', '在「搜索」里添加歌曲');
    meta.append(els.title, els.artist);

    const prog = h('div', 'stm-progress');
    els.bar = h('div', 'stm-bar');
    const track = h('div', 'stm-bar-track');
    track.appendChild(h('div', 'stm-bar-fill'));
    const rail = h('div', 'stm-bar-rail');
    rail.appendChild(h('div', 'stm-bar-thumb'));
    els.bar.append(track, rail);
    const times = h('div', 'stm-times');
    els.cur = h('span', '', '0:00');
    els.dur = h('span', '', '0:00');
    times.append(els.cur, els.dur);
    prog.append(els.bar, times);
    bindSeek();

    const ctrl = h('div', 'stm-ctrl');
    els.mode = iconButton('fa-repeat', '列表循环');
    els.mode.addEventListener('click', () => { player.cycleMode(); });
    const prev = iconButton('fa-backward-step', '上一首');
    prev.addEventListener('click', () => player.prev());
    els.play = iconButton('fa-play', '播放', 'stm-play');
    els.play.addEventListener('click', () => player.toggle());
    const next = iconButton('fa-forward-step', '下一首');
    next.addEventListener('click', () => player.next());
    const list = iconButton('fa-list', '播放列表');
    list.addEventListener('click', () => showView('queue'));
    ctrl.append(els.mode, prev, els.play, next, list);

    sec.append(stage, meta, prog, ctrl);
    return sec;
}

function setProgress(ratio) {
    els.bar.style.setProperty('--p', clamp(ratio, 0, 1));
}

function bindSeek() {
    const ratioAt = (e) => {
        const r = els.bar.getBoundingClientRect();
        return clamp((e.clientX - r.left) / r.width, 0, 1);
    };
    els.bar.addEventListener('pointerdown', (e) => {
        if (!player.duration()) return;
        seeking = true;
        let ratio = ratioAt(e);
        setProgress(ratio);
        const move = (ev) => { ratio = ratioAt(ev); setProgress(ratio); els.cur.textContent = fmt(ratio * player.duration()); };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            seeking = false;
            player.seek(ratio);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    });
}

function renderTrack() {
    const t = player.current();
    els.title.textContent = t ? t.title : '未选择歌曲';
    els.artist.textContent = t ? t.artist : '在「搜索」里添加歌曲';
    if (t && t.cover) { els.cover.src = t.cover; } else { els.cover.removeAttribute('src'); els.cover.style.visibility = 'hidden'; }
    setProgress(0);
    els.cur.textContent = '0:00';
    els.dur.textContent = '0:00';
    if (view === 'queue') renderQueue();
}

const MODE = {
    loop: ['fa-repeat', '列表循环'],
    single: ['fa-rotate-right', '单曲循环'],
    shuffle: ['fa-shuffle', '随机播放'],
};

function renderState() {
    const playing = player.state.playing;
    const icon = els.play.firstChild;
    icon.className = 'fa-solid ' + (player.state.loading ? 'fa-spinner fa-spin' : playing ? 'fa-pause' : 'fa-play');
    els.play.title = playing ? '暂停' : '播放';
    els.play.setAttribute('aria-label', els.play.title);
    panel.classList.toggle('stm-playing', playing);
    fab.classList.toggle('stm-playing', playing);
    const [mIcon, mTitle] = MODE[settings().mode] || MODE.loop;
    els.mode.firstChild.className = 'fa-solid ' + mIcon;
    els.mode.title = mTitle;
    els.mode.setAttribute('aria-label', mTitle);
}

function renderTime() {
    const d = player.duration(), t = player.time();
    if (!seeking) {
        setProgress(d ? t / d : 0);
        els.cur.textContent = fmt(t);
    }
    els.dur.textContent = fmt(d);
    updateLyric(t);
}

// ---------- 歌词 ----------

function renderLyric() {
    lyricIndex = -1;
    els.lyricsInner.replaceChildren();
    const lines = player.state.lyric;
    if (!lines.length) {
        els.lyricsInner.appendChild(h('p', 'stm-line stm-line-empty', player.current() ? '暂无歌词' : ''));
    } else {
        for (const l of lines) {
            const p = h('p', 'stm-line', l.text);
            p.dataset.t = l.t;
            els.lyricsInner.appendChild(p);
        }
    }
    updateLyric(player.time());
    scrollLyric(true);
}

function updateLyric(t) {
    const lines = player.state.lyric;
    if (!lines.length) return;
    let i = -1;
    for (let n = 0; n < lines.length; n++) { if (lines[n].t <= t + 0.2) i = n; else break; }
    if (i === lyricIndex) return;
    const kids = els.lyricsInner.children;
    if (kids[lyricIndex]) kids[lyricIndex].classList.remove('stm-now');
    lyricIndex = i;
    if (kids[i]) kids[i].classList.add('stm-now');
    scrollLyric(false);
}

function scrollLyric(instant) {
    if (!panel || !panel.classList.contains('stm-open')) return;
    if (!instant && Date.now() < manualUntil) return;
    const line = els.lyricsInner.children[Math.max(lyricIndex, 0)];
    if (!line) return;
    const offset = els.lyrics.clientHeight / 2 - (line.offsetTop + line.offsetHeight / 2);
    lyricOffset = offset;
    els.lyricsInner.classList.toggle('stm-instant', !!instant);
    els.lyricsInner.style.transform = `translateY(${Math.round(offset)}px)`;
}

// ---------- 搜索 ----------

function songRow(track, i, actions) {
    const row = h('div', 'stm-row');
    row.style.setProperty('--i', Math.min(i, STAGGER_MAX));
    const main = h('div', 'stm-row-main stm-press');
    main.append(h('div', 'stm-row-title', track.title), h('div', 'stm-row-sub', track.artist));
    row.appendChild(main);
    for (const a of actions) row.appendChild(a);
    return { row, main };
}

function buildSearch() {
    const sec = h('section', 'stm-view');
    sec.dataset.view = 'search';
    const form = h('form', 'stm-search');
    els.input = h('input', 'stm-input');
    els.input.type = 'search';
    els.input.placeholder = '歌名或歌手';
    els.input.enterKeyHint = 'search';
    const go = iconButton('fa-magnifying-glass', '搜索');
    go.type = 'submit';
    form.append(els.input, go);
    form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    els.results = h('div', 'stm-list');
    setHint(els.results, '输入歌名或歌手后搜索');
    sec.append(form, els.results);
    return sec;
}

function setHint(box, text) {
    box.replaceChildren(h('div', 'stm-hint', text));
}

async function runSearch() {
    const keyword = els.input.value.trim();
    if (!keyword) { setHint(els.results, '输入歌名或歌手后搜索'); return; }
    const token = ++searchToken;
    setHint(els.results, '搜索中');
    let list;
    try {
        list = await searchSongs(keyword);
    } catch (e) {
        if (token !== searchToken) return;
        setHint(els.results, e && e.message === 'no provider' ? '未启用任何接口，请在扩展设置里开启' : '搜索失败，接口暂时不可用');
        return;
    }
    if (token !== searchToken) return;
    if (!list.length) { setHint(els.results, '没有找到结果'); return; }
    els.results.replaceChildren();
    list.forEach((track, i) => {
        const add = iconButton('fa-plus', '加入列表');
        add.addEventListener('click', () => {
            notify(player.enqueue(track) ? `已加入列表：${track.title}` : '已在列表中');
        });
        const { row, main } = songRow(track, i, [add]);
        main.addEventListener('click', () => { player.playTrack(track); showView('now'); });
        els.results.appendChild(row);
    });
}

// ---------- 播放列表 ----------

function buildQueue() {
    const sec = h('section', 'stm-view');
    sec.dataset.view = 'queue';
    els.queue = h('div', 'stm-list');
    sec.appendChild(els.queue);
    return sec;
}

function renderQueue() {
    if (!els.queue) return;
    const q = player.queue();
    if (!q.length) { setHint(els.queue, '列表为空'); return; }
    els.queue.replaceChildren();
    q.forEach((track, i) => {
        const del = iconButton('fa-trash-can', '移出列表');
        del.addEventListener('click', () => player.removeAt(i));
        const { row, main } = songRow(track, i, [del]);
        row.classList.toggle('stm-current', i === player.index());
        main.addEventListener('click', () => player.playIndex(i));
        els.queue.appendChild(row);
    });
}

// ---------- 启动 ----------

export function setEnabled(on) {
    fab.classList.toggle('stm-hidden', !on);
    if (!on) { togglePanel(false); if (player.state.playing) player.toggle(); }
}

export function resetLayout() {
    const s = settings();
    s.fab = { x: 0.92, y: 0.6 };
    s.card = { x: null, y: null, w: 340, h: 540 };
    save();
    placeFab();
    applyCard();
}

export function init() {
    buildFab();
    buildPanel();
    player.on('track', renderTrack);
    player.on('state', renderState);
    player.on('time', renderTime);
    player.on('lyric', renderLyric);
    player.on('queue', () => { if (view === 'queue') renderQueue(); });
    window.addEventListener('resize', () => { placeFab(); applyCard(); scrollLyric(true); });
    renderTrack();
    renderState();
    setEnabled(settings().enabled);
}
