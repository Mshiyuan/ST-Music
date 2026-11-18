// 界面：悬浮按钮、播放面板（卡片 / 全屏）、搜索、播放列表、歌词，以及各页面之间的切换。

import { settings, save, notify } from './settings.js';
import { h, iconButton, setIcon, fmt, clamp, draggable, songRow, hint } from './dom.js';
import { searchSongs, getSong } from './sources.js';
import * as player from './player.js';
import * as rec from './rec.js';
import * as library from './library.js';
import * as strip from './strip.js';
import * as my from './my.js';
import { build as buildSettings, refreshBlockList } from './settingsUi.js';
import * as spring from './spring.js';

const MIN_W = 280;
const MIN_H = 400;
const MANUAL_HOLD = 3000;      // 手动滑动歌词后，这段时间内不自动滚动
const SHEET_CLOSE_DRAG = 70;   // 弹出层下拉超过这个距离就收起
const DOUBLE_TAP = 320;        // 两次点击间隔小于这个值算双击

let fab, panel, els = {};
let view = 'now';              // 'now' | 'search' | 'my' | 'detail' | 'settings'
let detailArg = null;          // 详情页显示的内容：'fav' | 'recent' | 'rank' | 歌单 id
let seeking = false;
let searchToken = 0;
let sheetKind = '';            // 当前弹出层的内容：'queue' | 'menu' | 'tags' | 其他
let lastHeadTap = 0;

let lyricIndex = -1;           // 正在唱的那一句
let lyricOffset = 0;
let manualUntil = 0;
let manualTimer = 0;
let scrubIndex = -1;           // 滑动时停在中线上的那一句
let centers = null;            // 各句歌词的中心位置（缓存，避免拖动时反复读布局）
let stageH = 0;

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

const isCard = () => settings().panelForm === 'card';

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
    const box = isCard() ? applyCard() : { x: 0, y: 0 };
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

/** 底栏的四项，按从左到右的顺序；左右滑动时也按这个顺序切换。 */
const TABS = [
    ['now', 'fa-compact-disc', '唱片'],
    ['my', 'fa-user', '我的'],
    ['pick', 'fa-clapperboard', '选歌'],
    ['settings', 'fa-gear', '设置'],
];
const TAB_ORDER = TABS.map((t) => t[0]);
const SWIPE_MIN = 60;          // 横向滑动超过这个距离才切换页面
let lastTab = 'my';            // 收起唱片页时回到的页面
let prevView = 'now';          // 从搜索页返回时回到的页面

const sheetNow = () => view === 'now' && settings().nowForm === 'sheet';

/** 左上角按钮：唱片页（收起式）为收起；搜索、详情页为返回；其余为搜索。 */
function onNav() {
    if (sheetNow()) go(lastTab);
    else if (view === 'search' || view === 'detail') back();
    else go('search');
}

function renderNav() {
    if (sheetNow()) setIcon(els.navBtn, 'fa-angle-down', '收起');
    else if (view === 'search' || view === 'detail') setIcon(els.navBtn, 'fa-arrow-left', '返回');
    else setIcon(els.navBtn, 'fa-magnifying-glass', '搜索');
    panel.dataset.now = settings().nowForm;
    panel.classList.toggle('stm-cap-on', !!settings().capsule);
    const active = view === 'detail' ? 'my' : view === 'search' ? prevView : view;
    for (const [k, b] of Object.entries(els.tabs)) b.classList.toggle('stm-on', k === active);
}

/** 设置里切换唱片页形式或胶囊开关后调用。 */
export function applyNowForm() {
    renderNav();
}

function buildPanel() {
    panel = h('div', 'stm-panel');
    panel.id = 'stm-panel';

    const head = h('div', 'stm-head');
    els.navBtn = iconButton('fa-magnifying-glass', '搜索');
    els.navBtn.addEventListener('click', onNav);
    // 唱片页（收起式）的左上角是收起，搜索放到右侧
    const search = iconButton('fa-magnifying-glass', '搜索', 'stm-head-search');
    search.addEventListener('click', () => go('search'));
    const close = iconButton('fa-xmark', '关闭', 'stm-close');
    close.addEventListener('click', () => togglePanel(false));
    const left = h('div', 'stm-head-side');
    left.appendChild(els.navBtn);
    const right = h('div', 'stm-head-side stm-head-right');
    right.append(search, close);
    head.append(left, h('div', 'stm-grab'), right);
    draggable(head, {
        onStart: () => (isCard() ? applyCard() : null),
        onMove: (dx, dy, b) => {
            if (!b) return;
            const c = settings().card;
            c.x = b.x + dx; c.y = b.y + dy; c.w = b.w; c.h = b.h;
            applyCard();
        },
        onEnd: save,
    });
    // 双击顶部（按钮以外的地方）在卡片和全屏之间切换
    head.addEventListener('click', (e) => {
        if (e.target.closest('.stm-btn') || !settings().dblFull) return;
        const now = Date.now();
        if (now - lastHeadTap < DOUBLE_TAP) {
            lastHeadTap = 0;
            toggleFormAnimated();
        } else lastHeadTap = now;
    });

    const body = h('div', 'stm-body');
    els.body = body;
    const page = (name) => { const sec = h('section', 'stm-view stm-page'); sec.dataset.view = name; return sec; };
    els.myPage = page('my');
    els.pickPage = page('pick');
    els.detailPage = page('detail');
    els.settingsPage = page('settings');
    els.settingsPage.classList.add('stm-settings');
    body.append(buildNow(), buildSearch(), els.myPage, els.pickPage, els.detailPage, els.settingsPage, buildFoot(), ...buildSheet());
    bindSwipe(body);
    panel.append(head, body);
    for (const c of ['nw', 'ne', 'sw', 'se']) bindResize(c);
    document.body.appendChild(panel);
    applyForm();
    applyDiscStyle();
    applyCustomCss();
    go(settings().home === 'my' ? 'my' : 'now');
}

let formRun = null;   // 正在进行的卡片 / 全屏切换动画

/**
 * 卡片与全屏之间切换，带过渡：
 * 先记下切换前面板在屏幕上的位置和大小，立即换成新布局，再让面板外框从旧的位置和大小过渡到新的。
 * 外框用 translate + scale，内容做反向缩放保持原大小（不变形），超出外框的部分被裁掉；圆角按缩放比例修正。
 * 只改 transform，使用与页面切换相同的弹簧。
 */
function toggleFormAnimated() {
    const toForm = isCard() ? 'full' : 'card';
    const animated = canSlide() && panel.classList.contains('stm-open');
    const first = panel.getBoundingClientRect();
    const r0 = formRun ? formRun.radius() : parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0;
    if (formRun) { formRun.cancel(); formRun = null; }
    settings().panelForm = toForm;
    save();
    applyForm();
    if (!animated) return;
    const last = panel.getBoundingClientRect();
    if (!last.width || !last.height) return;
    const r1 = parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0;
    const sx0 = first.width / last.width, sy0 = first.height / last.height;
    const dx0 = first.left - last.left, dy0 = first.top - last.top;
    const kids = [...panel.children].map((c) => [c, c.offsetLeft, c.offsetTop]);
    const at = (p) => ({ sx: sx0 + (1 - sx0) * p, sy: sy0 + (1 - sy0) * p, dx: dx0 * (1 - p), dy: dy0 * (1 - p), r: r0 + (r1 - r0) * p });
    const targets = [[panel, (p) => {
        const s = at(p);
        return { transformOrigin: '0 0', transform: `translate(${s.dx}px, ${s.dy}px) scale(${s.sx}, ${s.sy})`, borderRadius: `${s.r / s.sx}px / ${s.r / s.sy}px` };
    }]];
    for (const [c, ox, oy] of kids) {
        targets.push([c, (p) => {
            const s = at(p);
            return { transformOrigin: '0 0', transform: `translate(${(1 / s.sx - 1) * ox}px, ${(1 / s.sy - 1) * oy}px) scale(${1 / s.sx}, ${1 / s.sy})` };
        }]);
    }
    // 新布局的第一帧需要重新绘制背景模糊，耗时可能较长；动画的时钟在这一帧期间照常走，会造成跳帧。
    // 因此先把面板定在起点，等新布局画出一帧后再开始动画。
    const origin = panel.style.transformOrigin;
    const hold = () => { for (const [el, fr] of targets) Object.assign(el.style, fr(0)); };
    const release = () => {
        for (const [el] of targets) { el.style.transform = ''; el.style.transformOrigin = ''; el.style.borderRadius = ''; }
        panel.style.transformOrigin = origin;
    };
    let ctl = null;
    const run = {
        cancel: () => { if (ctl) ctl.cancel(); release(); panel.classList.remove('stm-form-moving'); },
        radius: () => at(ctl ? ctl.value() : 0).r,
    };
    formRun = run;
    panel.classList.add('stm-form-moving');
    hold();
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (formRun !== run) return;
        ctl = spring.animate({ from: 0, to: 1, rest: 0.001, targets });
        release();
        ctl.finished.then((done) => { if (done && formRun === run) { formRun = null; run.cancel(); } });
    }));
}

/** 底部：当前歌曲的胶囊（唱片页以外显示）和底栏。 */
function buildFoot() {
    const foot = h('div', 'stm-foot');
    const cap = h('div', 'stm-cap');
    cap.title = '打开唱片页';
    els.capCover = h('img', 'stm-cap-cover');
    els.capCover.alt = '';
    els.capCover.addEventListener('error', () => { els.capCover.style.visibility = 'hidden'; });
    els.capCover.addEventListener('load', () => { els.capCover.style.visibility = ''; });
    const text = h('div', 'stm-cap-text');
    els.capTitle = h('span', 'stm-cap-title');
    els.capArtist = h('span', 'stm-cap-artist');
    text.append(els.capTitle, els.capArtist);
    els.capPlay = iconButton('fa-play', '播放', 'stm-small');
    els.capPlay.addEventListener('click', (e) => { e.stopPropagation(); player.toggle(); });
    const list = iconButton('fa-list', '播放列表', 'stm-small');
    list.addEventListener('click', (e) => { e.stopPropagation(); openQueue(); });
    cap.append(els.capCover, text, els.capPlay, list);
    cap.addEventListener('click', () => go('now'));

    const tabs = h('div', 'stm-tabs');
    els.tabs = {};
    for (const [name, icon, title] of TABS) {
        const b = iconButton(icon, title, 'stm-tab');
        // 已在当前页时不做任何事，避免页面重新生成而闪动
        b.addEventListener('click', () => { if (view !== name) go(name); });
        els.tabs[name] = b;
        tabs.appendChild(b);
    }
    foot.append(cap, tabs);
    return foot;
}

/** 可以左右滑动切换的页面：收起式下唱片页不在其中（它从底部升起）。 */
const slideOrder = () => (settings().nowForm === 'sheet' ? TAB_ORDER.slice(1) : TAB_ORDER);
export const canSlide = () => document.documentElement.dataset.stmMotion !== 'fade' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 为某一页准备内容（拖动时提前显示相邻页用）。 */
function renderView(v) {
    if (v === 'my') my.renderMy(els.myPage, api);
    if (v === 'pick') renderPick();
    if (v === 'settings') buildSettings(els.settingsPage, 'pages');
}

/**
 * 正在进行的横向移动：cur 为目标页（最终停在 0），side 为另一页，位于 cur 的 sideDir 一侧（1 右、-1 左）。
 * 回弹时 cur 就是原来的页，side 为露出的相邻页。
 */
let slideRun = null;

function stopSlide() {
    const run = slideRun;
    slideRun = null;
    if (run) run.ctl.cancel();
    const list = [...panel.querySelectorAll('.stm-view.stm-leaving, .stm-view.stm-sliding')];
    // 移出的页面直接隐藏，不播放 CSS 的退出过渡，否则退出过渡会在原位置显示一帧
    for (const el of list) if (el.classList.contains('stm-leaving')) el.classList.add('stm-noanim');
    for (const el of list) { el.classList.remove('stm-leaving', 'stm-sliding'); el.style.transform = ''; }
    if (list.length) {
        void els.body.offsetWidth;
        for (const el of list) el.classList.remove('stm-noanim');
    }
}

/**
 * 两页一起横向移动，使用弹簧（spring.PAGE_SPRING）。
 * cur 从位移 x0 移到 0，side 始终紧贴在 cur 的 sideDir 一侧；v0 为初速度（像素每秒）。
 */
function runSlide(cur, side, sideDir, x0, v0 = 0) {
    stopSlide();
    const w = els.body.clientWidth;
    cur.classList.add('stm-sliding');
    if (side) side.classList.add('stm-leaving', 'stm-sliding');
    const targets = [[cur, (p) => ({ transform: `translateX(${p}px)` })]];
    if (side) targets.push([side, (p) => ({ transform: `translateX(${p + sideDir * w}px)` })]);
    const ctl = spring.animate({ from: x0, to: 0, v0, rest: 0.4, targets });
    const run = { ctl, cur, side, sideDir };
    slideRun = run;
    ctl.finished.then((done) => { if (done && slideRun === run) stopSlide(); });
}

/** 切换页面时的移动：新页从 dir 一侧进入。start 为拖动已经走过的距离，v0 为松手时的速度。 */
function slide(fromEl, toEl, dir, start = 0, v0 = 0) {
    const w = els.body.clientWidth;
    runSlide(toEl, fromEl, -dir, dir * w + start, v0);
}

/**
 * 横向拖动的通用处理：页面与手指位移 1:1 跟随；没有相邻页的一侧施加阻力；
 * 松手时目标 = round(位置 + 速度 × 0.15)（以页为单位），然后用弹簧吸附，初速度取松手时的速度。
 * 动画进行中再次按住，页面停在当前位置并继续跟随手指。
 * opts.canStart(e)：本次按下是否处理；opts.neighbor(dir)：dir 一侧的相邻页元素（没有则返回 null）；
 * opts.caught()：正在移动时返回 { cur, side, sideDir, x }，并停止移动；
 * opts.current()：当前页元素；opts.commit(dir, x, v)：切换到 dir 一侧；opts.settle(cur, side, sideDir, x, v)：回到当前页。
 */
export function bindPager(el, opts) {
    let armed = false, dragging = false, sx = 0, sy = 0, base = 0, cur = null, side = null, sideDir = 0, x = 0;
    const vt = spring.velocityTracker();
    const setSide = (dir) => {
        if (sideDir === dir && side) return;
        if (side) { side.classList.remove('stm-peek'); side.style.transform = ''; }
        side = opts.neighbor(dir);
        sideDir = side ? dir : 0;
        if (side) side.classList.add('stm-peek');
    };
    const place = () => {
        const w = el.clientWidth;
        cur.style.transform = `translateX(${x}px)`;
        if (side) side.style.transform = `translateX(${x + sideDir * w}px)`;
    };
    const down = (e) => {
        armed = !e.button && opts.canStart(e);
        if (!armed) return;
        sx = e.clientX; sy = e.clientY;
        vt.reset(e.clientX, e.timeStamp);
        dragging = false;
        // 正在移动时按住：停在当前位置，从这里继续跟随手指
        const run = opts.caught();
        if (run) {
            dragging = true;
            cur = run.cur; base = run.x; x = base;
            cur.classList.add('stm-dragging');
            if (run.side) { side = run.side; sideDir = run.sideDir; side.classList.add('stm-peek'); }
            place();
        }
    };
    const move = (e) => {
        if (!armed) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!dragging) {
            if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { armed = false; return; }
            if (Math.abs(dx) < 10) return;
            dragging = true;
            cur = opts.current();
            base = 0;
            cur.classList.add('stm-dragging');
        }
        vt.add(e.clientX, e.timeStamp);
        const raw = base + dx;
        const dir = raw < 0 ? 1 : -1;
        if (raw !== 0) setSide(dir);
        const w = el.clientWidth;
        x = side && sideDir === dir ? Math.max(-w, Math.min(w, raw)) : spring.rubber(raw, w);
        place();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    const end = (e, cancelled) => {
        if (!armed) return;
        armed = false;
        if (!dragging) return;
        dragging = false;
        // 拖动结束时不触发点击（例如点唱片切换歌词）
        const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        el.addEventListener('click', stop, true);
        setTimeout(() => el.removeEventListener('click', stop, true), 0);
        const w = el.clientWidth;
        const v = cancelled ? 0 : vt.get();
        // 位置以页为单位：向左拖为正（朝右侧的页）
        const lo = side && sideDir === -1 ? -1 : 0;
        const hi = side && sideDir === 1 ? 1 : 0;
        const target = cancelled ? 0 : spring.snapTarget(-x / w, -v / w, lo, hi);
        const c = cur, s = side, sd = sideDir, x0 = x;
        cur.classList.remove('stm-dragging');
        if (side) side.classList.remove('stm-peek');
        cur = null; side = null; sideDir = 0;
        if (target !== 0) opts.commit(target, x0, v, sd === target ? s : null);
        else opts.settle(c, s, sd, x0, v);
    };
    const up = (e) => end(e, false);
    const cancel = (e) => end(e, true);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    // 返回解除绑定的函数
    return () => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', cancel);
    };
}

/** 主页面左右滑动切换。 */
function bindSwipe(body) {
    const pageOf = () => (view === 'detail' ? 'my' : view);
    const neighborView = (dir) => { const o = slideOrder(); const i = o.indexOf(pageOf()); return i < 0 ? null : o[i + dir] || null; };
    bindPager(body, {
        canStart: (e) => canSlide() && slideOrder().includes(pageOf())
            && !e.target.closest('.stm-bar, input, textarea, select, .stm-seg, .stm-sheet, .stm-lyrics, .stm-scrub, .stm-cap, .stm-range, .stm-set-in, .stm-set-moving'),
        neighbor: (dir) => { const v = neighborView(dir); if (!v) return null; renderView(v); return viewEl(v); },
        current: () => { stopSlide(); return viewEl(view); },
        caught: () => {
            const run = slideRun;
            if (!run || run.cur !== viewEl(view)) return null;
            const x = run.ctl.value();
            slideRun = null;
            run.ctl.cancel();
            run.cur.classList.remove('stm-sliding');
            if (run.side) run.side.classList.remove('stm-leaving', 'stm-sliding');
            return { cur: run.cur, side: run.side, sideDir: run.sideDir, x };
        },
        // 露出的那一页就是切换的目标（点底栏跳页途中被按住时，露出的页不一定是顺序上的相邻页）
        commit: (dir, x, v, sideEl) => {
            const target = sideEl ? sideEl.dataset.view : neighborView(dir);
            if (target) go(target, undefined, { start: x, v0: v, dir });
        },
        settle: (cur, side, sideDir, x, v) => {
            cur.style.transform = '';
            if (side) side.style.transform = '';
            runSlide(cur, side, sideDir, x, v);
        },
    });
}

export function togglePanel(force) {
    const open = force === undefined ? !panel.classList.contains('stm-open') : force;
    if (open === panel.classList.contains('stm-open')) return;
    if (open) go(settings().home === 'my' ? 'my' : 'now');
    setOrigin();
    panel.classList.toggle('stm-open', open);
    fab.classList.toggle('stm-active', open);
    strip.sync(open);
    if (open) { invalidateLayout(); scrollLyric(true); } else closeSheet();
}

const viewEl = (v) => panel.querySelector(`.stm-view[data-view="${v}"]`);

/** 切换页面。detail 页需要 arg 指明显示什么。opts.start：拖动切换时已经移动的距离；opts.v0：松手时的速度；opts.dir：新页进入的方向。 */
export function go(v, arg, opts = {}) {
    const from = view;
    if (v === 'search' && from !== 'search') prevView = from === 'detail' ? 'my' : from;
    if (v !== 'now' && TAB_ORDER.includes(v)) lastTab = v;
    view = v;
    if (v === 'detail') detailArg = arg;
    if (v === 'detail') my.renderDetail(els.detailPage, detailArg, api);
    else if (!(opts.start !== undefined && from !== v)) renderView(v);   // 拖动时相邻页已经生成过
    if (from !== v) {
        const o = slideOrder();
        const a = o.indexOf(from), b = o.indexOf(v);
        if (a >= 0 && b >= 0 && canSlide() && panel.classList.contains('stm-open')) slide(viewEl(from), viewEl(v), opts.dir || (b > a ? 1 : -1), opts.start || 0, opts.v0 || 0);
        else stopSlide();
    }
    for (const el of panel.querySelectorAll('.stm-view')) el.classList.toggle('stm-show', el.dataset.view === v);
    panel.dataset.view = v;
    renderNav();
    closeSheet();
    if (v === 'search') setTimeout(() => { if (window.matchMedia('(pointer: fine)').matches) els.input.focus(); }, 60);
    if (v === 'now') scrollLyric(true);
}

function back() {
    go(view === 'detail' ? 'my' : prevView || 'now');
}

// ---------- 播放页 ----------

function buildNow() {
    const sec = h('section', 'stm-view');
    sec.dataset.view = 'now';

    const stage = h('div', 'stm-stage');
    stage.title = '点击切换唱片与歌词';
    const discWrap = h('div', 'stm-disc-wrap');
    const deck = h('div', 'stm-deck');
    const disc = h('div', 'stm-disc');
    els.cover = h('img', 'stm-cover');
    els.cover.alt = '';
    els.cover.addEventListener('error', () => { els.cover.style.visibility = 'hidden'; });
    els.cover.addEventListener('load', () => { els.cover.style.visibility = ''; });
    disc.append(els.cover, h('div', 'stm-disc-hole'));
    const arm = h('div', 'stm-arm');
    arm.append(h('div', 'stm-arm-base'), h('div', 'stm-arm-bar'), h('div', 'stm-arm-head'));
    // 磁带样式：外壳、标签（左上角为专辑封面）、窗口里的两个转轴、下方的磁头槽
    const tape = h('div', 'stm-tape');
    const label = h('div', 'stm-tape-label');
    els.tapeCover = h('img', 'stm-tape-cover');
    els.tapeCover.alt = '';
    els.tapeCover.addEventListener('error', () => { els.tapeCover.style.visibility = 'hidden'; });
    els.tapeCover.addEventListener('load', () => { els.tapeCover.style.visibility = ''; });
    els.tapeTitle = h('div', 'stm-tape-title');
    label.append(els.tapeCover, els.tapeTitle, h('div', 'stm-tape-side', 'A'));
    const win = h('div', 'stm-tape-window');
    win.append(h('div', 'stm-reel stm-reel-l'), h('div', 'stm-tape-band'), h('div', 'stm-reel stm-reel-r'));
    tape.append(label, win, h('div', 'stm-tape-foot'), h('div', 'stm-tape-screw stm-s1'), h('div', 'stm-tape-screw stm-s2'));
    // 反光不随唱片转动，所以放在唱片外面
    deck.append(disc, h('div', 'stm-disc-sheen'), arm, tape);
    discWrap.appendChild(deck);

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
    const names = h('div', 'stm-meta-text');
    els.title = h('div', 'stm-title', '未选择歌曲');
    els.artist = h('div', 'stm-artist', '');
    names.append(els.title, els.artist);
    els.stripBtn = iconButton('fa-closed-captioning', '歌词长条', 'stm-small');
    els.stripBtn.addEventListener('click', () => {
        const s = settings().strip;
        s.on = !s.on;
        save();
        renderMetaButtons();
        strip.sync();
        notify(s.on ? '歌词长条已开启，关闭面板后显示' : '歌词长条已关闭');
    });
    els.favBtn = iconButton('fa-heart', '收藏', 'stm-small');
    els.favBtn.addEventListener('click', () => {
        const t = player.current();
        if (!t) return;
        library.toggleFav(t);
    });
    meta.append(names, els.stripBtn, els.favBtn);

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
    els.mode = iconButton('fa-repeat', '列表循环', 'stm-mode');
    els.mode.insertAdjacentHTML('beforeend', ONE_SVG);
    els.mode.addEventListener('click', () => { player.cycleMode(); });
    const prev = iconButton('fa-backward-step', '上一首');
    prev.addEventListener('click', () => player.prev());
    els.play = iconButton('fa-play', '播放', 'stm-play');
    els.play.addEventListener('click', () => player.toggle());
    const next = iconButton('fa-forward-step', '下一首');
    next.addEventListener('click', () => player.next());
    els.listBtn = iconButton('fa-list', '播放列表');
    els.listBtn.addEventListener('click', () => (sheetKind === 'queue' ? closeSheet() : openQueue()));
    ctrl.append(els.mode, prev, els.play, next, els.listBtn);

    sec.append(stage, meta, prog, ctrl);
    return sec;
}

// ---------- 唱片样式、封面取色、自定义 CSS ----------

let colorToken = 0;

/**
 * 从封面取主色，写入面板的 --stm-cover-rgb（彩胶、磁带标签和「封面取色」配色使用）。
 * 取法：缩小到 24×24，跳过过暗、过亮和饱和度很低的像素，按饱和度加权平均。
 * 封面不允许跨域读取时（画布被污染），保留主题的强调色。
 */
function applyCoverColor(src) {
    const token = ++colorToken;
    if (!src) { panel.style.removeProperty('--stm-cover-rgb'); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        if (token !== colorToken) return;
        try {
            const c = document.createElement('canvas');
            c.width = c.height = 24;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0, 24, 24);
            const d = g.getImageData(0, 0, 24, 24).data;
            let r = 0, gg = 0, b = 0, w = 0;
            for (let i = 0; i < d.length; i += 4) {
                const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2]);
                const sat = max ? (max - min) / max : 0;
                if (max < 40 || min > 235) continue;
                const k = 0.15 + sat;
                r += d[i] * k; gg += d[i + 1] * k; b += d[i + 2] * k; w += k;
            }
            if (!w) { panel.style.removeProperty('--stm-cover-rgb'); return; }
            panel.style.setProperty('--stm-cover-rgb', `${Math.round(r / w)}, ${Math.round(gg / w)}, ${Math.round(b / w)}`);
        } catch (e) {
            panel.style.removeProperty('--stm-cover-rgb');
        }
    };
    img.onerror = () => { if (token === colorToken) panel.style.removeProperty('--stm-cover-rgb'); };
    img.src = src;
}

/** 按设置应用唱片样式（vinyl 黑胶 | color 彩胶 | tape 磁带 | cover 封面）和配色（theme 跟随美化 | cover 封面取色）。 */
export function applyDiscStyle() {
    const s = settings();
    panel.dataset.disc = s.disc;
    panel.dataset.palette = s.palette;
}

/** 自定义 CSS：放在页面最后一个 style 元素中，可覆盖本扩展的全部样式。 */
export function applyCustomCss() {
    let el = document.getElementById('stm-custom-css');
    if (!el) { el = document.createElement('style'); el.id = 'stm-custom-css'; document.head.appendChild(el); }
    el.textContent = settings().customCss || '';
}

/** 单曲循环图标：循环箭头和中间的 1 画在同一个图形里，粗细一致。 */
const ONE_SVG = '<svg class="stm-one-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5H19"/><path d="M16 3.5l3 3-3 3"/>'
    + '<path d="M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5H5"/><path d="M8 20.5l-3-3 3-3"/>'
    + '<path d="M10.8 10.6l1.6-1.1v5" stroke-width="1.7"/></svg>';

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

function renderMetaButtons() {
    const t = player.current();
    const fav = !!t && library.isFav(t.key);
    setIcon(els.favBtn, fav ? 'fa-heart' : 'fa-regular fa-heart', fav ? '取消收藏' : '收藏');
    els.favBtn.classList.toggle('stm-on', fav);
    els.favBtn.disabled = !t;
    els.stripBtn.classList.toggle('stm-on', settings().strip.on);
}

function renderTrack() {
    const t = player.current();
    els.title.textContent = t ? t.title : '未选择歌曲';
    els.artist.textContent = t ? t.artist : '';
    if (t && t.cover) { els.cover.src = t.cover; els.tapeCover.src = t.cover; } else { for (const img of [els.cover, els.tapeCover]) { img.removeAttribute('src'); img.style.visibility = 'hidden'; } }
    els.tapeTitle.textContent = t ? t.title : '';
    applyCoverColor(t && t.cover);
    setProgress(0);
    els.cur.textContent = '0:00';
    els.dur.textContent = '0:00';
    renderMetaButtons();
    panel.classList.toggle('stm-has-track', !!t);
    els.capTitle.textContent = t ? t.title : '';
    els.capArtist.textContent = t ? ` - ${t.artist}` : '';
    if (t && t.cover) els.capCover.src = t.cover; else { els.capCover.removeAttribute('src'); els.capCover.style.visibility = 'hidden'; }
    if (settings().fabIcon.type === 'cover') renderFab();
    if (sheetKind === 'queue') markQueueCurrent();
}

const MODE = {
    loop: ['fa-repeat', '列表循环'],
    single: ['fa-repeat', '单曲循环'],
    shuffle: ['fa-shuffle', '随机播放'],
};

function renderState() {
    const playing = player.state.playing;
    setIcon(els.play, player.state.loading ? 'fa-spinner fa-spin' : playing ? 'fa-pause' : 'fa-play', playing ? '暂停' : '播放');
    setIcon(els.capPlay, playing ? 'fa-pause' : 'fa-play', playing ? '暂停' : '播放');
    panel.classList.toggle('stm-playing', playing);
    fab.classList.toggle('stm-playing', playing);
    const mode = settings().mode;
    const [mIcon, mTitle] = MODE[mode] || MODE.loop;
    setIcon(els.mode, mIcon, mTitle);
    els.mode.classList.toggle('stm-one', mode === 'single');   // 单曲循环：循环箭头中间加一个 1
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
    // 没有译文的歌不显示「译」按钮
    els.trans.classList.toggle('stm-none', !player.state.hasTrans);
    els.trans.classList.toggle('stm-on', show);
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
    strip.setLine('');
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
    strip.setLine(i >= 0 ? lines[i].text : '', lines[i + 1] ? lines[i + 1].text : '');
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

/** 「加入歌单」按钮。 */
function addToButton(track) {
    const b = iconButton('fa-folder-plus', '加入歌单');
    b.addEventListener('click', () => openAddTo(track));
    return b;
}

function buildSearch() {
    const sec = h('section', 'stm-view');
    sec.dataset.view = 'search';
    const form = h('form', 'stm-search');
    els.input = h('input', 'stm-input');
    els.input.type = 'search';
    els.input.placeholder = '歌名、歌手，或单曲链接、音频直链';
    els.input.enterKeyHint = 'search';
    const submit = iconButton('fa-magnifying-glass', '搜索');
    submit.type = 'submit';
    form.append(els.input, submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    els.results = h('div', 'stm-list');
    hint(els.results, '输入歌名或歌手后搜索。也可粘贴网易云单曲链接或音频文件地址。');
    sec.append(form, els.results);
    return sec;
}

async function runSearch() {
    const keyword = els.input.value.trim();
    if (!keyword) { hint(els.results, '输入歌名或歌手后搜索'); return; }
    const token = ++searchToken;
    hint(els.results, '搜索中');
    let list;
    try {
        // 单曲链接或音频直链：直接列出这一首
        const link = library.parseSongLink(keyword);
        if (link) {
            let track = null;
            if (link.direct) track = library.directTrack(link.direct);
            else {
                const id = link.song || await library.resolveSongShort(link.songShort).catch(() => null);
                if (id) track = await getSong(id);
            }
            if (token !== searchToken) return;
            if (!track) { hint(els.results, link.songShort ? '无法从该链接中读取歌曲。请粘贴歌曲页面的完整地址。' : '无法读取该歌曲'); return; }
            list = [track];
        } else list = await searchSongs(keyword);
    } catch (e) {
        if (token !== searchToken) return;
        hint(els.results, e && e.message === 'no provider' ? '未启用任何接口，请在设置中开启' : '搜索失败，接口暂时不可用');
        return;
    }
    if (token !== searchToken) return;
    if (!list.length) { hint(els.results, '没有找到结果'); return; }
    els.results.replaceChildren();
    list.forEach((track, i) => {
        const add = iconButton('fa-plus', '加入播放列表');
        add.addEventListener('click', () => {
            notify(player.enqueue(track) ? `已加入播放列表：${track.title}` : '已在播放列表中');
        });
        const { row, main } = songRow(track, i, [addToButton(track), add]);
        main.addEventListener('click', () => { player.playTrack(track); go('now'); });
        els.results.appendChild(row);
    });
}

// ---------- 弹出层（从面板底部弹出）：播放列表、更多、本次标签、加入歌单等 ----------

function buildSheet() {
    els.scrim = h('div', 'stm-scrim');
    els.scrim.addEventListener('click', () => closeSheet());

    els.sheet = h('div', 'stm-sheet');
    const head = h('div', 'stm-sheet-head');
    els.sheetTitle = h('div', 'stm-sheet-title', '');
    els.sheetAction = h('div', 'stm-sheet-action');
    const top = h('div', 'stm-sheet-top');
    top.append(els.sheetTitle, els.sheetAction);
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
            if (pulled > SHEET_CLOSE_DRAG) closeSheet();
            pulled = 0;
        },
    });
    els.sheetBody = h('div', 'stm-list');
    els.sheet.append(head, els.sheetBody, buildSelectBar());
    return [els.scrim, els.sheet];
}

/** 打开弹出层。fill(body) 负责填内容；action 是标题右侧的按钮（可省略）。 */
export function openSheet(kind, title, fill, action) {
    sheetKind = kind;
    if (kind !== 'queue') { selecting = false; selected.clear(); els.sheet.classList.remove('stm-selecting'); }
    els.sheetTitle.textContent = title;
    els.sheetAction.replaceChildren();
    if (action) els.sheetAction.appendChild(action);
    els.sheetBody.replaceChildren();
    fill(els.sheetBody);
    panel.classList.add('stm-sheet-open');
}

export function closeSheet() {
    sheetKind = '';
    if (panel) panel.classList.remove('stm-sheet-open');
}

// ---------- 播放列表 ----------

/** 「不喜欢」图标：爱心加一条斜线。FontAwesome 中没有此图标，用内联 SVG 绘制，颜色跟随文字颜色。 */
const DISLIKE_SVG = '<svg class="stm-dislike-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 20.2l-7.1-7.1a4.6 4.6 0 0 1 6.5-6.5l.6.6.6-.6a4.6 4.6 0 0 1 6.5 6.5L12 20.2z"/>'
    + '<path d="M3.5 3.5l17 17"/></svg>';

const QUEUE_ANIM_ROWS = 12;    // 打开播放列表时只有前若干行播放依次进入的动画，其余行直接显示
let queueKeys = [];            // 上一次渲染时各行的标识，用于区分保留的行和新加入的行
let selecting = false;         // 多选状态
const selected = new Set();    // 多选时选中的行标识

/** 每一行的标识：歌曲 key；同一首歌出现多次时加序号区分。 */
function rowIds(q) {
    const count = new Map();
    return q.map((t) => { const n = count.get(t.key) || 0; count.set(t.key, n + 1); return n ? `${t.key}#${n}` : t.key; });
}

/** 行移出：先播放退出动画，再执行 done。 */
function rowOut(row, done) {
    if (!canSlide()) { done(); return; }
    row.style.pointerEvents = 'none';
    const a = row.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(24%)', opacity: 0 }], { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
    a.finished.then(done, done);
}

function queueRow(track, i, id) {
    const dislike = h('button', 'stm-btn stm-press stm-dislike');
    dislike.type = 'button';
    dislike.title = '不喜欢';
    dislike.setAttribute('aria-label', '不喜欢');
    dislike.insertAdjacentHTML('beforeend', DISLIKE_SVG);
    const del = iconButton('fa-trash-can', '移出播放列表');
    const { row, main } = songRow(track, i, [dislike, del]);
    row.classList.add('stm-qrow');
    row.dataset.i = String(i);
    row.dataset.id = id;
    const check = h('span', 'stm-check');
    check.appendChild(h('i', 'fa-solid fa-check'));
    row.prepend(check);
    row.classList.toggle('stm-current', i === player.index());
    row.classList.toggle('stm-rec', !!track.rec);
    row.classList.toggle('stm-picked', selected.has(id));
    const at = () => Number(row.dataset.i);
    dislike.addEventListener('click', () => rowOut(row, () => {
        rec.blockTrack(track);
        player.removeAt(at());
        notify(`已加入黑名单：${track.title}`);
        refreshBlockList();
    }));
    del.addEventListener('click', () => rowOut(row, () => player.removeAt(at())));
    const pick = () => {
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        row.classList.toggle('stm-picked', selected.has(id));
        renderSelectBar();
    };
    main.addEventListener('click', () => { if (selecting) pick(); else player.playIndex(at()); });
    check.addEventListener('click', pick);
    return row;
}

/**
 * 渲染播放列表。
 * 首次打开时前若干行依次进入；之后列表内容变化时，保留的行不再播放进入动画，
 * 位置变化的行从原位置移动到新位置，只有新加入的行播放进入动画。
 */
const QUEUE_FIRST = 30;        // 打开时先生成的行数；其余行分批补上
const QUEUE_CHUNK = 40;
let queueLimit = 0;            // 当前已生成的行数上限
let queueFillTimer = 0;

function renderQueue(fresh = false) {
    const q = player.queue();
    const body = els.sheetBody;
    if (fresh) { queueKeys = []; queueLimit = 0; clearTimeout(queueFillTimer); }
    if (!q.length) {
        queueKeys = [];
        clearTimeout(queueFillTimer);
        if (selecting) setSelecting(false);
        renderQueueTitle();
        hint(body, '播放列表为空');
        return;
    }
    const ids = rowIds(q);
    const existing = new Map([...body.querySelectorAll('.stm-qrow')].map((r) => [r.dataset.id, r]));
    const first = !existing.size;
    if (first) { body.replaceChildren(); queueLimit = QUEUE_FIRST; }
    const animate = !first && canSlide();
    // 记下保留的行原来的位置，用于移动动画
    const before = new Map();
    if (animate) {
        const top = body.getBoundingClientRect().top;
        for (const [id, r] of existing) before.set(id, r.getBoundingClientRect().top - top);
    }
    const old = new Set(queueKeys);
    for (const id of [...selected]) if (!ids.includes(id)) selected.delete(id);
    const limit = Math.min(q.length, Math.max(queueLimit, existing.size));
    const cur = player.index();
    const kept = [];
    // 先移除已不在列表里的行，其余行保持原有顺序，不移动节点（移动节点会使进入动画重新播放）
    const keep = new Set(ids.slice(0, limit));
    for (const [id, r] of existing) if (!keep.has(id)) { r.remove(); existing.delete(id); }
    for (let i = 0; i < limit; i++) {
        const id = ids[i];
        let row = existing.get(id);
        if (row) {
            existing.delete(id);
            // 进入动画已结束的行改为静止；仍在进入中的行让它播完
            if (!row.getAnimations().some((a) => a instanceof CSSAnimation && a.playState === 'running')) row.classList.add('stm-still');
            row.classList.toggle('stm-rec', !!q[i].rec);
            kept.push(row);
        } else {
            row = queueRow(q[i], i, id);
            // 首次打开：前若干行依次进入；之后：已在列表里的歌（之前未生成的行）直接显示，新加入的歌播放进入动画
            if (first ? i >= QUEUE_ANIM_ROWS : old.has(id)) row.classList.add('stm-still');
            else if (!first) row.style.setProperty('--i', 0);
        }
        row.dataset.i = String(i);
        row.classList.toggle('stm-current', i === cur);
        row.classList.toggle('stm-picked', selected.has(id));
        if (body.children[i] !== row) body.insertBefore(row, body.children[i] || null);
    }
    while (body.children.length > limit) body.lastElementChild.remove();
    queueKeys = ids;
    renderQueueTitle();
    renderSelectBar();
    // 未生成的行分批补上，每批之间让出主线程
    clearTimeout(queueFillTimer);
    if (limit < q.length) {
        queueFillTimer = setTimeout(() => { queueLimit = limit + QUEUE_CHUNK; if (sheetKind === 'queue') renderQueue(); }, first ? 400 : 16);
    }
    if (!animate) return;
    // 保留的行从原位置移动到新位置（只改 transform）；不在可见范围内的行不做动画
    const top = body.getBoundingClientRect().top;
    const view = body.clientHeight;
    for (const row of kept) {
        const was = before.get(row.dataset.id);
        const now = row.getBoundingClientRect().top - top;
        const d = was - now;
        const hgt = row.offsetHeight;
        if (Math.abs(d) < 0.5 || (now > view && was > view) || (now + hgt < 0 && was + hgt < 0)) continue;
        for (const a of row.getAnimations()) if (!(a instanceof CSSAnimation)) a.cancel();
        spring.animate({ from: d, to: 0, targets: [[row, (p) => ({ transform: `translateY(${p}px)` })]] }).finished.then(() => {});
    }
}

function renderQueueTitle() {
    const n = player.queue().length;
    if (selecting) els.sheetTitle.textContent = `已选择 ${selected.size} 首`;
    else els.sheetTitle.textContent = n ? `播放列表（${n}）` : '播放列表';
}

/** 切歌时只移动「当前播放」的高亮，不重建列表。 */
function markQueueCurrent() {
    const i = player.index();
    for (const row of els.sheetBody.querySelectorAll('.stm-qrow')) row.classList.toggle('stm-current', Number(row.dataset.i) === i);
}

function renderQueueActions() {
    const box = h('div', 'stm-sheet-btns');
    if (selecting) {
        const all = h('button', 'stm-text-btn stm-press', '全选');
        all.type = 'button';
        const allOn = () => queueKeys.length > 0 && selected.size === queueKeys.length;
        all.textContent = allOn() ? '取消全选' : '全选';
        all.addEventListener('click', () => {
            if (allOn()) selected.clear(); else queueKeys.forEach((id) => selected.add(id));
            for (const row of els.sheetBody.querySelectorAll('.stm-qrow')) row.classList.toggle('stm-picked', selected.has(row.dataset.id));
            renderSelectBar();
        });
        els.selAll = all;
        const done = iconButton('fa-check', '完成');
        done.addEventListener('click', () => setSelecting(false));
        box.append(all, done);
    } else {
        const multi = iconButton('fa-list-check', '多选');
        multi.addEventListener('click', () => { if (player.queue().length) setSelecting(true); });
        els.refresh = iconButton(rec.isBusy() ? 'fa-spinner fa-spin' : 'fa-dice', '重新推荐');
        els.refresh.addEventListener('click', () => rec.refresh());
        box.append(multi, els.refresh);
    }
    els.sheetAction.replaceChildren(box);
}

function setSelecting(on) {
    // 退出多选时操作栏先下降淡出，再从布局中移除
    if (!on && selecting && canSlide() && els.selBar) {
        const bar = els.selBar;
        bar.classList.add('stm-sel-leaving');
        const a = bar.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(100%)', opacity: 0 }], { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
        const done = () => { bar.classList.remove('stm-sel-leaving'); a.cancel(); };
        a.finished.then(done, done);
    }
    selecting = on;
    selected.clear();
    els.sheet.classList.toggle('stm-selecting', on);
    for (const row of els.sheetBody.querySelectorAll('.stm-qrow')) row.classList.remove('stm-picked');
    renderQueueActions();
    renderQueueTitle();
    renderSelectBar();
}

/** 多选时底部的操作栏：加入歌单、从列表删除。 */
function renderSelectBar() {
    if (!els.selBar) return;
    const n = selected.size;
    els.selAdd.disabled = !n;
    els.selDel.disabled = !n;
    if (els.selAll) els.selAll.textContent = queueKeys.length > 0 && n === queueKeys.length ? '取消全选' : '全选';
    if (selecting) renderQueueTitle();
}

function buildSelectBar() {
    const bar = h('div', 'stm-sel-bar');
    const mk = (icon, label) => {
        const b = h('button', 'stm-sel-btn stm-press');
        b.type = 'button';
        b.append(h('i', `fa-solid ${icon}`), h('span', '', label));
        return b;
    };
    els.selAdd = mk('fa-folder-plus', '加入歌单');
    els.selDel = mk('fa-trash-can', '从列表删除');
    const pickedIndices = () => queueKeys.map((id, i) => (selected.has(id) ? i : -1)).filter((i) => i >= 0);
    els.selAdd.addEventListener('click', () => {
        const q = player.queue();
        const tracks = pickedIndices().map((i) => q[i]);
        if (!tracks.length) return;
        setSelecting(false);
        openAddTo(tracks);
    });
    els.selDel.addEventListener('click', () => {
        const idx = pickedIndices();
        if (!idx.length) return;
        const rows = [...els.sheetBody.querySelectorAll('.stm-qrow')].filter((r) => selected.has(r.dataset.id));
        let left = rows.length;
        const finish = () => { if (--left > 0) return; setSelecting(false); player.removeMany(idx); };
        rows.forEach((r) => rowOut(r, finish));
        if (!rows.length) { setSelecting(false); player.removeMany(idx); }
    });
    bar.append(els.selAdd, els.selDel);
    els.selBar = bar;
    return bar;
}

function openQueue() {
    selecting = false;
    selected.clear();
    els.sheet.classList.remove('stm-selecting');
    openSheet('queue', '播放列表', () => {});
    renderQueueActions();
    renderQueue(true);
}

function menuRow(icon, label, fn, i) {
    const row = h('div', 'stm-row stm-menu-row stm-press');
    row.style.setProperty('--i', i);
    row.append(h('i', `fa-solid ${icon}`), h('span', '', label));
    row.addEventListener('click', fn);
    return row;
}

/** 「选歌」页：本次标签与重新推荐。 */
function renderPick() {
    const box = els.pickPage;
    box.replaceChildren();
    const bar = h('div', 'stm-sec-bar');
    els.pickRefresh = iconButton(rec.isBusy() ? 'fa-spinner fa-spin' : 'fa-dice', '重新推荐', 'stm-small');
    els.pickRefresh.addEventListener('click', () => rec.refresh());
    bar.append(h('div', 'stm-sec-title', '本次标签'), els.pickRefresh);
    const list = h('div', 'stm-list');
    const tags = rec.getLastTags();
    if (!tags) hint(list, '尚未取得标签。模型回复一次后显示。');
    else {
        const rows = [...Object.entries(tags.dims), ['搜索', tags.search.join('；')]].filter(([, v]) => v);
        rows.forEach(([k, v], i) => {
            const row = h('div', 'stm-row stm-tag-row');
            row.style.setProperty('--i', i);
            row.append(h('span', 'stm-tag-key', k), h('span', 'stm-tag-value', v));
            list.appendChild(row);
        });
    }
    box.append(bar, list, sceneBar(), h('div', 'stm-set-desc stm-pick-note', '「重新推荐」使用同一组标签检索另一批歌曲，不调用模型。情境：选中后，其说明从下一次推荐起附加给模型，其检索词在下一次检索（包括「重新推荐」）时附加；再点一次取消。相关设置位于「设置」中的「剧情配乐」。'));
}

/** 选歌页的情境按钮：单选，再点一次取消。按钮内容在设置中编辑。 */
function sceneBar() {
    const r = settings().rec;
    const wrap = h('div', 'stm-scenes');
    wrap.appendChild(h('div', 'stm-sec-title', '情境'));
    const chips = h('div', 'stm-chips');
    const render = () => {
        chips.replaceChildren();
        for (const sc of r.scenes) {
            const b = h('button', 'stm-chip stm-press', sc.name);
            b.type = 'button';
            b.classList.toggle('stm-on', r.scene === sc.name);
            b.title = sc.prompt;
            b.addEventListener('click', () => {
                r.scene = r.scene === sc.name ? '' : sc.name;
                save();
                for (const x of chips.children) x.classList.toggle('stm-on', x.textContent === r.scene);
            });
            chips.appendChild(b);
        }
        if (!r.scenes.length) chips.appendChild(h('div', 'stm-set-desc', '尚无情境。可在设置中添加。'));
    };
    render();
    wrap.appendChild(chips);
    return wrap;
}

/** 选择要加入的歌单。tracks 为一首歌或一组歌。 */
export function openAddTo(tracks) {
    const list0 = Array.isArray(tracks) ? tracks : [tracks];
    const many = list0.length > 1;
    const done = (list, n) => {
        closeSheet();
        if (many) notify(n ? `已将 ${n} 首加入歌单：${list.name}` : '所选歌曲均已在歌单中');
        else notify(n ? `已加入歌单：${list.name}` : '该歌曲已在歌单中');
    };
    openSheet('addto', many ? `加入歌单（${list0.length} 首）` : '加入歌单', (body) => {
        const lists = library.lib().lists;
        body.appendChild(menuRow('fa-plus', '新建歌单', async () => {
            const name = await my.askName('歌单名称');
            if (!name) return;
            const list = library.createList(name);
            done(list, library.addToList(list.id, list0));
        }, 0));
        lists.forEach((list, i) => {
            body.appendChild(menuRow('fa-music', `${list.name}（${list.keys.length}）`, () => done(list, library.addToList(list.id, list0)), i + 1));
        });
    });
}

// ---------- 启动 ----------

/** 提供给「我的」页面使用的接口。 */
const api = { go, back, openSheet, closeSheet, openAddTo };

export function setEnabled(on) {
    fab.classList.toggle('stm-hidden', !on);
    if (!on) { togglePanel(false); if (player.state.playing) player.toggle(); }
    strip.sync();
}

/** 复位：只恢复位置，不改变大小。 */
export function resetLayout() {
    const s = settings();
    s.fab = { x: 0.92, y: 0.6 };
    s.card.x = null;
    s.card.y = null;
    s.strip.x = 0.5;
    s.strip.y = 0.82;
    save();
    placeFab();
    applyCard();
    invalidateLayout();
}

export function init() {
    applyMotion();
    buildFab();
    buildPanel();
    strip.init(() => togglePanel(true));
    player.on('track', renderTrack);
    player.on('state', renderState);
    player.on('time', renderTime);
    player.on('lyric', renderLyric);
    player.on('queue', () => { if (sheetKind === 'queue') renderQueue(); });
    library.onChange(() => {
        renderMetaButtons();
        if (view === 'my') my.renderMy(els.myPage, api);
        if (view === 'detail') my.renderDetail(els.detailPage, detailArg, api);
    });
    rec.onBusy((busy) => {
        for (const b of [els.refresh, els.pickRefresh]) if (b) setIcon(b, busy ? 'fa-spinner fa-spin' : 'fa-dice');
        if (!busy && view === 'pick') renderPick();
    });
    window.addEventListener('resize', () => { placeFab(); applyCard(); invalidateLayout(); scrollLyric(true); });
    renderTrack();
    renderState();
    setEnabled(settings().enabled);
}
