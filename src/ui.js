// 界面：悬浮按钮、播放面板（卡片 / 抽屉）、搜索、播放列表、歌词。

import { settings, save, notify } from './settings.js';
import { searchSongs } from './sources.js';
import * as player from './player.js';
import * as rec from './rec.js';

const MIN_W = 280;
const MIN_H = 400;
const DRAG_THRESHOLD = 6;
const STAGGER_MAX = 12;
const MANUAL_HOLD = 3000;      // 手动滑动歌词后，这段时间内不自动滚动
const SHEET_CLOSE_DRAG = 70;   // 列表下拉超过这个距离就收起

let fab, panel, els = {};
let view = 'now';              // 'now' | 'search'
let seeking = false;
let searchToken = 0;

let lyricIndex = -1;           // 正在唱的那一句
let lyricOffset = 0;
let manualUntil = 0;
let manualTimer = 0;
let scrubIndex = -1;           // 滑动时停在中线上的那一句
let centers = null;            // 各句歌词的中心位置（缓存，避免拖动时反复读布局）
let stageH = 0;

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

function setIcon(btn, icon, title) {
    btn.firstChild.className = 'fa-solid ' + icon;
    if (title) { btn.title = title; btn.setAttribute('aria-label', title); }
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
function draggable(handle, { onStart, onMove, onEnd, onPress, onRelease }) {
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

// ---------- 悬浮按钮 ----------

export function placeFab() {
    const s = settings().fab;
    const size = settings().fabSize;
    fab.style.left = clamp(s.x * window.innerWidth - size / 2, 4, window.innerWidth - size - 4) + 'px';
    fab.style.top = clamp(s.y * window.innerHeight - size / 2, 4, window.innerHeight - size - 4) + 'px';
}

/** 按设置渲染悬浮按钮的大小和内容。 */
export function renderFab() {
    const s = settings();
    const icon = s.fabIcon;
    const t = player.current();
    fab.style.setProperty('--stm-fab', s.fabSize + 'px');
    const fallback = () => fab.replaceChildren(h('i', `fa-solid ${icon.icon || 'fa-music'}`));
    const image = (src, cls) => {
        const img = h('img', `stm-fab-img ${cls}`);
        img.alt = '';
        img.draggable = false;
        img.addEventListener('error', fallback);
        img.src = src;
        fab.replaceChildren(img);
    };
    if (icon.type === 'cover' && t && t.cover) image(t.cover, 'stm-fab-cover');
    else if (icon.type === 'image' && icon.image.trim()) image(icon.image.trim(), '');
    else if (icon.type === 'text' && icon.text.trim()) fab.replaceChildren(h('span', 'stm-fab-text', icon.text.trim()));
    else fallback();
    placeFab();
}

function buildFab() {
    fab = h('div', 'stm-fab stm-press');
    fab.id = 'stm-fab';
    fab.setAttribute('role', 'button');
    fab.title = '音乐';
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
    renderFab();
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

/** 面板从悬浮按钮的位置弹出、收回：把缩放的原点放在按钮中心。 */
function setOrigin() {
    const f = fab.getBoundingClientRect();
    const box = settings().panelForm === 'card' ? applyCard() : { x: 0, y: window.innerHeight - panel.offsetHeight };
    panel.style.transformOrigin = `${Math.round(f.left + f.width / 2 - box.x)}px ${Math.round(f.top + f.height / 2 - box.y)}px`;
}

function invalidateLayout() {
    centers = null;
    stageH = 0;
}

export function applyForm() {
    panel.dataset.form = settings().panelForm;
    applyCard();
    invalidateLayout();
    scrollLyric(true);
}

export function applyMotion() {
    document.documentElement.dataset.stmMotion = settings().motion;
}

function bindResize(corner) {
    const grip = h('div', `stm-rz stm-rz-${corner}`);
    // 触屏会把落点吸附到附近可点击的元素上；让手柄自身可响应点击，落在手柄上时就不会被旁边的按钮抢走
    grip.addEventListener('click', () => {});
    draggable(grip, {
        onStart: () => applyCard(),
        onPress: () => grip.classList.add('stm-active'),
        onRelease: () => grip.classList.remove('stm-active'),
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
            invalidateLayout();
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
    els.searchBtn = iconButton('fa-magnifying-glass', '搜索');
    els.searchBtn.addEventListener('click', () => showView(view === 'search' ? 'now' : 'search'));
    const close = iconButton('fa-xmark', '关闭', 'stm-close');
    close.addEventListener('click', () => togglePanel(false));
    head.append(els.searchBtn, h('div', 'stm-grab'), close);
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
    body.append(buildNow(), buildSearch(), ...buildSheet());
    panel.append(head, body);
    for (const c of ['nw', 'ne', 'sw', 'se']) bindResize(c);
    document.body.appendChild(panel);
    applyForm();
    showView(view);
}

export function togglePanel(force) {
    const open = force === undefined ? !panel.classList.contains('stm-open') : force;
    if (open === panel.classList.contains('stm-open')) return;
    setOrigin();
    panel.classList.toggle('stm-open', open);
    fab.classList.toggle('stm-active', open);
    if (open) { invalidateLayout(); scrollLyric(true); } else toggleSheet(false);
}

function showView(v) {
    view = v;
    for (const el of panel.querySelectorAll('.stm-view')) el.classList.toggle('stm-show', el.dataset.view === v);
    setIcon(els.searchBtn, v === 'search' ? 'fa-chevron-left' : 'fa-magnifying-glass', v === 'search' ? '返回' : '搜索');
    toggleSheet(false);
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

    // 滑动歌词时出现的中线：左边是这一句的时间，右边是播放键，点击跳到这一句
    els.scrub = h('div', 'stm-scrub');
    els.scrubTime = h('span', 'stm-scrub-time', '0:00');
    els.scrub.append(els.scrubTime, h('span', 'stm-scrub-line'), h('i', 'fa-solid fa-play stm-scrub-play'));
    els.scrub.addEventListener('click', (e) => {
        e.stopPropagation();
        const line = player.state.lyric[scrubIndex];
        if (line) player.seekTo(line.t);
        endManual(false);
    });

    els.trans = h('button', 'stm-trans stm-press', '译');
    els.trans.type = 'button';
    els.trans.title = '显示或隐藏译文';
    els.trans.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = settings();
        s.showTrans = !s.showTrans;
        save();
        applyTrans();
    });

    stage.append(discWrap, els.lyrics, els.scrub, els.trans);
    stage.addEventListener('click', () => {
        stage.classList.toggle('stm-show-lyrics');
        endManual(true);
    });
    draggable(els.lyrics, {
        onStart: () => lyricOffset,
        onMove: (dx, dy, base) => {
            const c = lineCenters();
            if (!c.length) return;
            const half = stageH / 2;
            lyricOffset = clamp(base + dy, half - c[c.length - 1], half - c[0]);
            manualUntil = Date.now() + MANUAL_HOLD;
            els.lyricsInner.classList.add('stm-instant');
            els.lyricsInner.style.transform = `translateY(${Math.round(lyricOffset)}px)`;
            updateScrub();
        },
        onEnd: () => {
            manualUntil = Date.now() + MANUAL_HOLD;
            clearTimeout(manualTimer);
            manualTimer = setTimeout(() => endManual(false), MANUAL_HOLD);
        },
    });
    els.stage = stage;

    const meta = h('div', 'stm-meta');
    els.title = h('div', 'stm-title', '未选择歌曲');
    els.artist = h('div', 'stm-artist', '点左上角的放大镜搜索歌曲');
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
    els.listBtn = iconButton('fa-list', '播放列表');
    els.listBtn.addEventListener('click', () => toggleSheet());
    ctrl.append(els.mode, prev, els.play, next, els.listBtn);

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
    els.artist.textContent = t ? t.artist : '点左上角的放大镜搜索歌曲';
    if (t && t.cover) { els.cover.src = t.cover; } else { els.cover.removeAttribute('src'); els.cover.style.visibility = 'hidden'; }
    setProgress(0);
    els.cur.textContent = '0:00';
    els.dur.textContent = '0:00';
    if (settings().fabIcon.type === 'cover') renderFab();
    if (sheetOpen()) renderQueue();
}

const MODE = {
    loop: ['fa-repeat', '列表循环'],
    single: ['fa-rotate-right', '单曲循环'],
    shuffle: ['fa-shuffle', '随机播放'],
};

function renderState() {
    const playing = player.state.playing;
    setIcon(els.play, player.state.loading ? 'fa-spinner fa-spin' : playing ? 'fa-pause' : 'fa-play', playing ? '暂停' : '播放');
    panel.classList.toggle('stm-playing', playing);
    fab.classList.toggle('stm-playing', playing);
    const [mIcon, mTitle] = MODE[settings().mode] || MODE.loop;
    setIcon(els.mode, mIcon, mTitle);
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

function applyTrans() {
    const show = settings().showTrans;
    els.trans.classList.toggle('stm-on', show && player.state.hasTrans);
    els.trans.disabled = !player.state.hasTrans;
    els.lyrics.classList.toggle('stm-hide-trans', !show);
    invalidateLayout();
    scrollLyric(true);
}

function renderLyric() {
    lyricIndex = -1;
    els.lyricsInner.replaceChildren();
    const lines = player.state.lyric;
    if (!lines.length) {
        els.lyricsInner.appendChild(h('p', 'stm-line stm-line-empty', player.current() ? '暂无歌词' : ''));
    } else {
        for (const l of lines) {
            const p = h('p', 'stm-line');
            p.appendChild(h('span', 'stm-line-main', l.text));
            if (l.trans) p.appendChild(h('span', 'stm-line-trans', l.trans));
            els.lyricsInner.appendChild(p);
        }
    }
    endManual(false);
    applyTrans();
    updateLyric(player.time());
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
    updateScrub();
}

function lineCenters() {
    if (!centers) {
        centers = [...els.lyricsInner.children].map((k) => k.offsetTop + k.offsetHeight / 2);
        stageH = els.lyrics.clientHeight;
    }
    return centers;
}

function scrollLyric(instant) {
    if (!panel || !panel.classList.contains('stm-open')) return;
    if (!instant && Date.now() < manualUntil) return;
    const c = lineCenters();
    if (!c.length) return;
    lyricOffset = stageH / 2 - c[Math.max(lyricIndex, 0)];
    els.lyricsInner.classList.toggle('stm-instant', !!instant);
    els.lyricsInner.style.transform = `translateY(${Math.round(lyricOffset)}px)`;
}

/** 滑动时显示中线；停在正在唱的那一句上时不显示。 */
function updateScrub() {
    const lines = player.state.lyric;
    let show = false;
    if (lines.length && Date.now() < manualUntil) {
        const c = lineCenters();
        const target = stageH / 2 - lyricOffset;
        let best = 0;
        for (let i = 1; i < c.length; i++) if (Math.abs(c[i] - target) < Math.abs(c[best] - target)) best = i;
        scrubIndex = best;
        show = best !== lyricIndex;
        if (show) els.scrubTime.textContent = fmt(lines[best].t);
    }
    els.stage.classList.toggle('stm-scrubbing', show);
}

/** 结束手动滑动状态，回到正在唱的那一句。 */
function endManual(instant) {
    clearTimeout(manualTimer);
    manualUntil = 0;
    if (els.stage) els.stage.classList.remove('stm-scrubbing');
    scrollLyric(instant);
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

// ---------- 播放列表（从底部弹出） ----------

const sheetOpen = () => panel && panel.classList.contains('stm-sheet-open');

function buildSheet() {
    els.scrim = h('div', 'stm-scrim');
    els.scrim.addEventListener('click', () => toggleSheet(false));

    els.sheet = h('div', 'stm-sheet');
    const head = h('div', 'stm-sheet-head');
    els.sheetTitle = h('div', 'stm-sheet-title', '播放列表');
    els.refresh = iconButton('fa-wand-magic-sparkles', '按剧情重新推荐');
    els.refresh.addEventListener('click', () => rec.refresh());
    const top = h('div', 'stm-sheet-top');
    top.append(els.sheetTitle, els.refresh);
    head.append(h('div', 'stm-grab'), top);
    let pulled = 0;
    draggable(head, {
        onMove: (dx, dy) => {
            pulled = Math.max(0, dy);
            els.sheet.classList.add('stm-instant');
            els.sheet.style.transform = `translateY(${pulled}px)`;
        },
        onEnd: () => {
            els.sheet.classList.remove('stm-instant');
            els.sheet.style.transform = '';
            if (pulled > SHEET_CLOSE_DRAG) toggleSheet(false);
            pulled = 0;
        },
    });
    els.queue = h('div', 'stm-list');
    els.sheet.append(head, els.queue);
    return [els.scrim, els.sheet];
}

function toggleSheet(force) {
    const open = force === undefined ? !sheetOpen() : force;
    if (open === sheetOpen()) return;
    if (open) renderQueue();
    panel.classList.toggle('stm-sheet-open', open);
}

function renderQueue() {
    const q = player.queue();
    els.sheetTitle.textContent = q.length ? `播放列表（${q.length}）` : '播放列表';
    if (!q.length) { setHint(els.queue, '列表为空'); return; }
    els.queue.replaceChildren();
    q.forEach((track, i) => {
        const del = iconButton('fa-trash-can', '移出列表');
        del.addEventListener('click', () => player.removeAt(i));
        const { row, main } = songRow(track, i, [del]);
        row.classList.toggle('stm-current', i === player.index());
        row.classList.toggle('stm-rec', !!track.rec);
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
    invalidateLayout();
}

export function init() {
    applyMotion();
    buildFab();
    buildPanel();
    player.on('track', renderTrack);
    player.on('state', renderState);
    player.on('time', renderTime);
    player.on('lyric', renderLyric);
    player.on('queue', () => { if (sheetOpen()) renderQueue(); });
    rec.onBusy((busy) => setIcon(els.refresh, busy ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'));
    window.addEventListener('resize', () => { placeFab(); applyCard(); invalidateLayout(); scrollLyric(true); });
    renderTrack();
    renderState();
    setEnabled(settings().enabled);
}
