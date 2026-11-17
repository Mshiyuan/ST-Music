// 界面：悬浮按钮、播放面板（卡片 / 全屏）、搜索、播放列表、歌词，以及各页面之间的切换。

import { settings, save, notify } from './settings.js';
import { h, iconButton, setIcon, fmt, clamp, draggable, songRow, hint } from './dom.js';
import { searchSongs } from './sources.js';
import * as player from './player.js';
import * as rec from './rec.js';
import * as library from './library.js';
import * as strip from './strip.js';
import * as my from './my.js';
import { build as buildSettings } from './settingsUi.js';

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
            settings().panelForm = isCard() ? 'full' : 'card';
            save();
            applyForm();
        } else lastHeadTap = now;
    });

    const body = h('div', 'stm-body');
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
    go(settings().home === 'my' ? 'my' : 'now');
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
        b.addEventListener('click', () => go(name));
        els.tabs[name] = b;
        tabs.appendChild(b);
    }
    foot.append(cap, tabs);
    return foot;
}

/** 左右滑动切换底栏的各页。进度条、输入框、歌词、弹出层上的滑动不算。 */
function bindSwipe(body) {
    let sx = 0, sy = 0, armed = false;
    body.addEventListener('pointerdown', (e) => {
        armed = !e.target.closest('.stm-bar, input, textarea, select, .stm-seg, .stm-sheet, .stm-lyrics, .stm-scrub, .stm-cap');
        sx = e.clientX; sy = e.clientY;
    });
    body.addEventListener('pointercancel', () => { armed = false; });
    body.addEventListener('pointerup', (e) => {
        if (!armed) return;
        armed = false;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        const cur = view === 'detail' ? 'my' : view;
        const j = TAB_ORDER.indexOf(cur) + (dx < 0 ? 1 : -1);
        if (TAB_ORDER.indexOf(cur) < 0 || j < 0 || j >= TAB_ORDER.length) return;
        // 滑动结束时不再触发点击（例如点唱片切换歌词）
        const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        body.addEventListener('click', stop, true);
        setTimeout(() => body.removeEventListener('click', stop, true), 0);
        go(TAB_ORDER[j]);
    });
}

/** 设置页面进出的方向：底栏各页之间横向移动，其余保持默认。 */
function prepareView(el, from) {
    if (!el) return;
    const shown = el.classList.contains('stm-show');
    if (!shown) el.classList.add('stm-noanim');
    if (from) el.style.setProperty('--stm-from', from); else el.style.removeProperty('--stm-from');
    if (!shown) { void el.offsetWidth; el.classList.remove('stm-noanim'); }
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

/** 切换页面。detail 页需要 arg 指明显示什么。 */
export function go(v, arg) {
    const from = view;
    if (v === 'search' && from !== 'search') prevView = from === 'detail' ? 'my' : from;
    if (v !== 'now' && TAB_ORDER.includes(v)) lastTab = v;
    view = v;
    if (v === 'detail') detailArg = arg;
    if (v === 'my') my.renderMy(els.myPage, api);
    if (v === 'pick') renderPick();
    if (v === 'detail') my.renderDetail(els.detailPage, detailArg, api);
    if (v === 'settings') buildSettings(els.settingsPage);
    if (from !== v) {
        const a = TAB_ORDER.indexOf(from), b = TAB_ORDER.indexOf(v);
        const sheetEdge = settings().nowForm === 'sheet' && (from === 'now' || v === 'now');
        const horiz = a >= 0 && b >= 0 && !sheetEdge && document.documentElement.dataset.stmMotion !== 'fade';
        const dir = b > a ? 1 : -1;
        prepareView(viewEl(from), horiz ? `translateX(${-dir * 36}px)` : null);
        prepareView(viewEl(v), horiz ? `translateX(${dir * 36}px)` : null);
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
    // 反光不随唱片转动，所以放在唱片外面
    deck.append(disc, h('div', 'stm-disc-sheen'), arm);
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
    if (t && t.cover) { els.cover.src = t.cover; } else { els.cover.removeAttribute('src'); els.cover.style.visibility = 'hidden'; }
    setProgress(0);
    els.cur.textContent = '0:00';
    els.dur.textContent = '0:00';
    renderMetaButtons();
    panel.classList.toggle('stm-has-track', !!t);
    els.capTitle.textContent = t ? t.title : '';
    els.capArtist.textContent = t ? ` - ${t.artist}` : '';
    if (t && t.cover) els.capCover.src = t.cover; else { els.capCover.removeAttribute('src'); els.capCover.style.visibility = 'hidden'; }
    if (settings().fabIcon.type === 'cover') renderFab();
    if (sheetKind === 'queue') renderQueue();
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
    els.input.placeholder = '歌名或歌手';
    els.input.enterKeyHint = 'search';
    const submit = iconButton('fa-magnifying-glass', '搜索');
    submit.type = 'submit';
    form.append(els.input, submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
    els.results = h('div', 'stm-list');
    hint(els.results, '输入歌名或歌手后搜索');
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
        list = await searchSongs(keyword);
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
    els.sheet.append(head, els.sheetBody);
    return [els.scrim, els.sheet];
}

/** 打开弹出层。fill(body) 负责填内容；action 是标题右侧的按钮（可省略）。 */
export function openSheet(kind, title, fill, action) {
    sheetKind = kind;
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

function renderQueue() {
    const q = player.queue();
    els.sheetTitle.textContent = q.length ? `播放列表（${q.length}）` : '播放列表';
    if (!q.length) { hint(els.sheetBody, '播放列表为空'); return; }
    els.sheetBody.replaceChildren();
    q.forEach((track, i) => {
        const del = iconButton('fa-trash-can', '移出播放列表');
        del.addEventListener('click', () => player.removeAt(i));
        const { row, main } = songRow(track, i, [addToButton(track), del]);
        row.classList.toggle('stm-current', i === player.index());
        row.classList.toggle('stm-rec', !!track.rec);
        main.addEventListener('click', () => player.playIndex(i));
        els.sheetBody.appendChild(row);
    });
}

function openQueue() {
    els.refresh = iconButton('fa-dice', '按剧情重新推荐');
    els.refresh.addEventListener('click', () => rec.refresh());
    openSheet('queue', '播放列表', () => {}, els.refresh);
    renderQueue();
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
    box.append(bar, list, h('div', 'stm-set-desc stm-pick-note', '「重新推荐」使用同一组标签检索另一批歌曲，不调用模型。相关设置位于「设置」中的「按剧情选歌」。'));
}

/** 选择要加入的歌单。 */
export function openAddTo(track) {
    openSheet('addto', '加入歌单', (body) => {
        const lists = library.lib().lists;
        body.appendChild(menuRow('fa-plus', '新建歌单', async () => {
            const name = await my.askName('歌单名称');
            if (!name) return;
            const list = library.createList(name);
            library.addToList(list.id, [track]);
            closeSheet();
            notify(`已加入歌单：${list.name}`);
        }, 0));
        lists.forEach((list, i) => {
            body.appendChild(menuRow('fa-music', `${list.name}（${list.keys.length}）`, () => {
                const n = library.addToList(list.id, [track]);
                closeSheet();
                notify(n ? `已加入歌单：${list.name}` : '该歌曲已在歌单中');
            }, i + 1));
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
