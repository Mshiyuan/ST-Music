// 设置页的内容。同一份内容既放在酒馆的扩展设置页里，也放在播放面板的「设置」页里。

import { settings, save, ctx, notify, NAME } from './settings.js';
import { h, makeSeg } from './dom.js';
import * as rec from './rec.js';
import * as ui from './ui.js';
import * as strip from './strip.js';
import { syncKeepAlive } from './media.js';
import * as player from './player.js';
import * as spring from './spring.js';

/** 一行：左边标题和说明，右边控件。 */
function item(title, desc, control) {
    const box = h('div', 'stm-set-item');
    const text = h('div', 'stm-set-text');
    text.appendChild(h('div', 'stm-set-title', title));
    if (desc) text.appendChild(h('div', 'stm-set-desc', desc));
    box.append(text, control);
    return box;
}

/** 一块：标题和说明在上，控件在下。 */
function block(title, desc, ...controls) {
    const box = h('div', 'stm-set-block');
    box.appendChild(h('div', 'stm-set-title', title));
    if (desc) box.appendChild(h('div', 'stm-set-desc', desc));
    box.append(...controls);
    return box;
}

function toggle(value, onChange) {
    const b = h('button', 'stm-switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.appendChild(h('span', 'stm-switch-knob'));
    const set = (v) => { b.classList.toggle('stm-on', v); b.setAttribute('aria-checked', String(v)); };
    set(value);
    b.addEventListener('click', () => { const v = !b.classList.contains('stm-on'); set(v); onChange(v); });
    return b;
}

/** 滑块：右侧显示当前值。 */
function range(value, min, max, step, show, onChange) {
    const row = h('div', 'stm-range-row');
    const input = h('input', 'stm-range');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(value);
    const label = h('span', 'stm-range-num', show(value));
    input.addEventListener('input', () => { const v = Number(input.value); label.textContent = show(v); onChange(v); });
    row.append(input, label);
    return row;
}

/** 长按：按住超过一定时间触发，之后的那次点击不再生效。 */
function onLongPress(el, fn) {
    let timer = 0, sx = 0, sy = 0, fired = false;
    const cancel = () => clearTimeout(timer);
    el.addEventListener('pointerdown', (e) => {
        fired = false; sx = e.clientX; sy = e.clientY;
        timer = setTimeout(() => { fired = true; fn(); }, 550);
    });
    el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // 手机长按约 0.5 秒会开始选中文字，与长按判定冲突；在按钮上禁止选字，已出现的选区立即清除
    el.addEventListener('selectstart', (e) => e.preventDefault());
    el.addEventListener('pointerdown', () => { const sel = window.getSelection(); if (sel && !sel.isCollapsed) sel.removeAllRanges(); });
    el.addEventListener('click', (e) => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
}

function stepper(value, min, max, onChange, step = 1) {
    const box = h('div', 'stm-stepper');
    const mk = (icon, label) => { const b = h('button', 'stm-step stm-press'); b.type = 'button'; b.setAttribute('aria-label', label); b.appendChild(h('i', 'fa-solid ' + icon)); return b; };
    const minus = mk('fa-minus', '减少');
    const plus = mk('fa-plus', '增加');
    const num = h('span', 'stm-step-num', String(value));
    const set = (v) => {
        value = Math.min(max, Math.max(min, v));
        num.textContent = String(value);
        minus.disabled = value <= min;
        plus.disabled = value >= max;
    };
    minus.addEventListener('click', () => { set(value - step); onChange(value); });
    plus.addEventListener('click', () => { set(value + step); onChange(value); });
    set(value);
    box.append(minus, num, plus);
    return box;
}

function chip(label, on, onToggle) {
    const b = h('button', 'stm-chip stm-press', label);
    b.type = 'button';
    b.classList.toggle('stm-on', !!on);
    b.addEventListener('click', () => { const v = !b.classList.contains('stm-on'); b.classList.toggle('stm-on', v); onToggle(v); });
    return b;
}

function chips(options, isOn, onChange) {
    const box = h('div', 'stm-chips');
    for (const [value, label] of options) box.appendChild(chip(label, isOn(value), (v) => onChange(value, v)));
    return box;
}

function textInput(value, placeholder, onChange, type = 'text') {
    const input = h('input', 'stm-input');
    input.type = type;
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    return input;
}

function textButton(label, onClick) {
    const b = h('button', 'stm-text-btn stm-press', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
}

/** 把图片缩小到不超过 maxW 像素宽，转为 JPEG 数据地址，避免设置文件过大。 */
function shrinkImage(file, maxW, quality) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxW / img.naturalWidth);
            const c = document.createElement('canvas');
            c.width = Math.round(img.naturalWidth * scale);
            c.height = Math.round(img.naturalHeight * scale);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            URL.revokeObjectURL(url);
            resolve(c.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
        img.src = url;
    });
}

/** 弹出输入框，返回输入的文字；取消时返回空字符串。 */
export async function askText(title, value = '') {
    const c = ctx();
    try {
        if (typeof c.callGenericPopup === 'function') {
            const type = (c.POPUP_TYPE && c.POPUP_TYPE.INPUT) || 3;
            const out = await c.callGenericPopup(title, type, value);
            return typeof out === 'string' ? out.trim() : '';
        }
    } catch (e) { /* 改用浏览器自带的输入框 */ }
    return (window.prompt(title, value) || '').trim();
}

/** 语言偏好：内置语言、用户添加的语言、以及「其他」按钮。 */
function languageChips(r) {
    const box = h('div', 'stm-chips');
    // 长按任一语言进入删除状态：每个语言右上角出现 ×，点 × 删除；点其他地方退出
    const setEditing = (on) => {
        box.classList.toggle('stm-editing', on);
        if (on) {
            const exit = (e) => {
                if (e.target.closest && e.target.closest('.stm-chip-x')) return;
                document.removeEventListener('pointerdown', exit, true);
                box.classList.remove('stm-editing');
            };
            setTimeout(() => document.addEventListener('pointerdown', exit, true), 0);
        }
    };
    const render = () => {
        const editing = box.classList.contains('stm-editing');
        box.replaceChildren();
        const toggleLang = (name, on) => { r.langs = on ? [...r.langs.filter((x) => x !== name), name] : r.langs.filter((x) => x !== name); save(); };
        // 内置语言删除后记入 hiddenLangs，可恢复；自定义语言直接删除
        const remove = (name) => {
            if (rec.LANGS.includes(name)) r.hiddenLangs = [...r.hiddenLangs.filter((x) => x !== name), name];
            else r.customLangs = r.customLangs.filter((x) => x !== name);
            r.langs = r.langs.filter((x) => x !== name);
            save();
            render();
        };
        const names = [...rec.LANGS.filter((x) => !r.hiddenLangs.includes(x)), ...r.customLangs];
        for (const name of names) {
            const c = chip(name, r.langs.includes(name), (on) => {
                // 删除状态下点语言本身不切换选择
                if (box.classList.contains('stm-editing')) { c.classList.toggle('stm-on', !on); return; }
                toggleLang(name, on);
            });
            c.classList.add('stm-chip-lang');
            onLongPress(c, () => setEditing(true));
            const x = h('span', 'stm-chip-x');
            x.setAttribute('role', 'button');
            x.title = `删除 ${name}`;
            x.appendChild(h('i', 'fa-solid fa-xmark'));
            x.addEventListener('click', (e) => { e.stopPropagation(); remove(name); });
            c.appendChild(x);
            box.appendChild(c);
        }
        box.classList.toggle('stm-editing', editing && names.length > 0);
        const add = h('button', 'stm-chip stm-chip-add stm-press', '其他');
        add.type = 'button';
        add.addEventListener('click', async () => {
            const name = (await askText('输入语言名称')).slice(0, 12);
            if (!name) return;
            if (rec.LANGS.includes(name)) r.hiddenLangs = r.hiddenLangs.filter((x) => x !== name);
            else if (!r.customLangs.includes(name)) r.customLangs.push(name);
            if (!r.langs.includes(name)) r.langs.push(name);
            save();
            render();
        });
        box.appendChild(add);
        if (r.hiddenLangs.length) {
            const restore = h('button', 'stm-chip stm-chip-add stm-press', '恢复默认语言');
            restore.type = 'button';
            restore.addEventListener('click', () => { r.hiddenLangs = []; save(); render(); });
            box.appendChild(restore);
        }
    };
    render();
    return box;
}

/** 设置的分类：键、名称、图标、填充函数。 */
const CATS = [
    ['rec', '剧情配乐', 'fa-clapperboard', fillRec],
    ['look', '外观', 'fa-palette', fillLook],
    ['play', '播放', 'fa-circle-play', fillPlay],
    ['api', '接口', 'fa-plug', fillApi],
    ['debug', '调试', 'fa-bug', fillDebug],
];

/** 往 target 里放一张卡片。 */
const cardIn = (target) => (...children) => { const c = h('div', 'stm-card'); c.append(...children); target.appendChild(c); return c; };
/** 分类页里的小标题。 */
const subhead = (target, name) => target.appendChild(h('div', 'stm-set-group', name));

function enableCard(target) {
    const s = settings();
    cardIn(target)(item('启用', '关闭时隐藏悬浮按钮，并暂停播放。', toggle(s.enabled, (v) => {
        s.enabled = v; save(); ui.setEnabled(v); rec.syncPrompt(); syncKeepAlive();
    })));
}

/**
 * 把全部设置项放进 content。
 * mode 为 'pages'（面板内）：首页列出分类，点击后分类页从右侧滑入。
 * mode 为 'sections'（酒馆扩展页）：各分类为可展开的下拉区块，向下展开。
 */
export function build(content, mode = 'sections') {
    const s = settings();
    content.replaceChildren();
    if (mode === 'pages') { buildPages(content); return; }
    enableCard(content);
    for (const [key, name, icon, fill] of CATS) {
        const sec = h('div', 'stm-sec');
        const head = h('button', 'stm-sec-head stm-press');
        head.type = 'button';
        const label = h('span', 'stm-sec-name');
        label.append(h('i', `fa-solid ${icon} stm-sec-icon`), document.createTextNode(name));
        head.append(label, h('i', 'fa-solid fa-angle-down stm-sec-arrow'));
        // 外层用 grid 行高从 0 过渡到内容高度，实现向下展开
        const wrap = h('div', 'stm-sec-wrap');
        const inner = h('div', 'stm-sec-inner');
        wrap.appendChild(inner);
        let filled = false;
        const open = (v) => {
            if (v && !filled) { fill(inner); filled = true; }
            sec.classList.toggle('stm-sec-open', v);
        };
        open(!!s.sections[key]);
        head.addEventListener('click', () => {
            const v = !sec.classList.contains('stm-sec-open');
            s.sections[key] = v;
            save();
            open(v);
        });
        sec.append(head, wrap);
        content.appendChild(sec);
    }
}

/**
 * 面板内的设置：首页（启用 + 分类列表）与分类页。
 * 进入分类页时首页整页向左移出、分类页从右侧进入，两页同步移动；返回时相反。
 * 移动使用与主页面相同的弹簧；分类页上向右拖动可以返回，规则与主页面左右滑动相同。
 */
function buildPages(content) {
    content.classList.add('stm-set-pages');
    content.classList.remove('stm-set-in');
    const root = h('div', 'stm-set-pane stm-set-root');
    const sub = h('div', 'stm-set-pane stm-set-sub');
    let run = null;   // 正在进行的移动
    const clear = () => {
        for (const p of [root, sub]) { p.classList.remove('stm-set-moving', 'stm-dragging', 'stm-peek'); p.style.transform = ''; }
    };
    /** 移到首页（inSub 为 false）或分类页；q0 为分类页当前的位移，v0 为初速度（像素每秒）。 */
    const move = (inSub, q0, v0 = 0) => {
        if (run) { run.ctl.cancel(); run = null; }
        content.classList.toggle('stm-set-in', inSub);
        clear();
        if (!ui.canSlide()) return;
        const W = content.clientWidth;
        root.classList.add('stm-set-moving');
        sub.classList.add('stm-set-moving');
        const ctl = spring.animate({
            from: q0, to: inSub ? 0 : W, v0, rest: 0.4,
            targets: [[sub, (p) => ({ transform: `translateX(${p}px)` })], [root, (p) => ({ transform: `translateX(${p - W}px)` })]],
        });
        const me = { ctl };
        run = me;
        ctl.finished.then((done) => { if (done && run === me) { run = null; ctl.cancel(); clear(); } });
    };
    const subX = () => (run ? run.ctl.value() : content.classList.contains('stm-set-in') ? 0 : content.clientWidth);
    content._stmBack = () => move(false, subX());
    // 设置页每次显示都会重建内容；先解除上一次的拖动绑定
    if (content._stmUnbind) content._stmUnbind();
    content._stmUnbind = ui.bindPager(content, {
        canStart: (e) => ui.canSlide() && (content.classList.contains('stm-set-in') || !!run)
            && !e.target.closest('input, textarea, select, .stm-seg, .stm-range, .stm-stepper, .stm-chips.stm-editing'),
        neighbor: (dir) => (dir === -1 ? root : null),
        current: () => { if (run) { run.ctl.cancel(); run = null; clear(); } return sub; },
        caught: () => {
            if (!run) return null;
            const x = run.ctl.value();
            run.ctl.cancel();
            run = null;
            clear();
            return { cur: sub, side: root, sideDir: -1, x };
        },
        commit: (dir, x, v) => move(dir !== -1, x, v),
        settle: (cur, side, sideDir, x, v) => move(true, x, v),
    });
    enableCard(root);
    const list = cardIn(root)();
    list.classList.add('stm-cat-list');
    for (const [, name, icon, fill] of CATS) {
        const row = h('button', 'stm-cat-row stm-press');
        row.type = 'button';
        row.append(h('i', `fa-solid ${icon} stm-cat-icon`), h('span', 'stm-cat-name', name), h('i', 'fa-solid fa-angle-right stm-row-go'));
        row.addEventListener('click', () => {
            sub.replaceChildren();
            const bar = h('div', 'stm-set-subbar');
            const back = h('button', 'stm-btn stm-press', '');
            back.type = 'button';
            back.title = '返回';
            back.setAttribute('aria-label', '返回');
            back.appendChild(h('i', 'fa-solid fa-arrow-left'));
            back.addEventListener('click', () => settingsBack());
            bar.append(back, h('div', 'stm-set-subtitle', name));
            const body = h('div', 'stm-set-subbody');
            fill(body);
            sub.append(bar, body);
            sub.scrollTop = 0;
            move(true, subX());
        });
        list.appendChild(row);
    }
    content.append(root, sub);
}

/** 面板内的设置处于分类页时返回首页；返回 true 表示已处理。 */
export function settingsBack() {
    const pages = document.querySelector('#stm-panel .stm-set-pages.stm-set-in');
    if (!pages) return false;
    if (pages._stmBack) pages._stmBack(); else pages.classList.remove('stm-set-in');
    return true;
}

function fillRec(target) {
    const s = settings();
    const card = cardIn(target);
    const r = s.rec;
    const prefer = h('textarea', 'stm-input stm-textarea');
    prefer.placeholder = '例：减少流行歌曲，增加后摇与纯音乐';
    prefer.value = r.prefer;
    prefer.rows = 2;
    prefer.addEventListener('input', () => { r.prefer = prefer.value; save(); });
    const tpl = h('textarea', 'stm-input stm-textarea stm-code');
    tpl.value = r.prompt.trim() ? r.prompt : rec.DEFAULT_PROMPT;
    tpl.rows = 9;
    tpl.addEventListener('input', () => { r.prompt = tpl.value.trim() === rec.DEFAULT_PROMPT.trim() ? '' : tpl.value; save(); });
    subhead(target, '开关与频率');
    card(
        item('自动选歌', '在提示词中加入一段说明，要求模型在回复末尾输出隐藏标签，并按标签检索歌曲。该条回复的输出增加数十字；不产生额外的模型调用。', toggle(r.enabled, (v) => { r.enabled = v; save(); rec.syncPrompt(); })),
        item('推荐间隔', '每隔若干条模型回复推荐一次。仅在推荐的那一条回复中加入说明。', stepper(r.every, 1, 20, (v) => { r.every = v; save(); })),
        item('每次推荐数量', '推荐的歌曲排在当前歌曲之后。', stepper(r.count, 1, 10, (v) => { r.count = v; save(); })),
    );
    subhead(target, '找歌');
    cardIn(target)(
        block('找歌方式', '单曲搜索：按搜索短语搜索单曲，结果按平台的匹配度和热度排序，热门歌曲较多。歌单检索：按搜索短语搜索歌单，从前几个歌单中随机取歌，冷门歌曲比例更高；经酒馆服务器请求网易云，只发送短语。向量匹配：在歌单检索的结果中按与标签的相似度排序，需要向量库；未安装向量库时按歌单检索处理。',
            makeSeg([{ value: 'song', label: '单曲搜索' }, { value: 'playlist', label: '歌单检索' }, { value: 'vector', label: '向量匹配' }], r.method, (v) => { r.method = v; save(); })),
        item('从我的歌单推荐', '在说明中附上收藏和歌单里随机选取的歌曲，由模型从中选择符合剧情的歌，排在其余推荐之前。该条回复的输入增加约每首十余字。', toggle(r.fromLib.on, (v) => { r.fromLib.on = v; save(); })),
        item('附上的歌曲数量', '每次推荐时附上的歌曲上限。', stepper(r.fromLib.max, 10, 200, (v) => { r.fromLib.max = v; save(); }, 10)),
    );
    subhead(target, '情境');
    cardIn(target)(sceneEditor(r));
    subhead(target, '剧情原声');
    cardIn(target)(
        item('记录剧情原声', '剧情配乐推荐、且播放超过 30 秒（或一半）的歌曲，按当前角色记录，显示在「我的」中。群聊不记录。', toggle(r.ost.on, (v) => { r.ost.on = v; save(); })),
        item('每个角色保留的数量', '超过时移除最早的。', stepper(r.ost.max, 10, 200, (v) => { r.ost.max = v; save(); }, 10)),
    );
    subhead(target, '播放列表');
    cardIn(target)(
        block('新推荐到达时', '「重新推荐」始终立即切换。',
            makeSeg([{ value: 'after', label: '播完当前歌曲后切换' }, { value: 'now', label: '立即切换' }], r.arrive, (v) => { r.arrive = v; save(); })),
        item('保留的推荐数量', '以前推荐的歌曲保留在播放列表中；超过此数量时移除最早推荐的歌曲。手动加入的歌曲不受影响。', stepper(r.keep, 10, 100, (v) => { r.keep = v; save(); }, 10)),
        item('避免重复推荐', '最近推荐过的歌曲不再推荐。', toggle(r.noRepeat, (v) => { r.noRepeat = v; save(); })),
        item('不重复的范围', '按最近推荐的歌曲数量计算。', stepper(r.noRepeatCount, 5, 100, (v) => { r.noRepeatCount = v; save(); }, 5)),
    );
    subhead(target, '偏好');
    cardIn(target)(
        block('语言偏好', '未选择时不限制语言。「其他」可添加自定义语言。长按任一语言后，点击右上角的 × 可将其删除。', languageChips(r)),
        block('推荐偏好', '补充给模型的说明，可留空。', prefer),
        block('排除的版本', '选中的版本不出现在推荐结果中。', chips(rec.VERSIONS.map(([k, name]) => [k, name]), (k) => r.exclude[k], (k, on) => { r.exclude[k] = on; save(); })),
    );
    subhead(target, '标签与说明');
    cardIn(target)(
        block('标签维度', '停用的维度不写入标签，可减少输出字数。', chips(rec.DIMS, (k) => r.dims[k], (k, on) => { r.dims[k] = on; save(); })),
        block('说明模板', '发送给模型的说明文字。{{格式}}、{{维度说明}}、{{语言说明}}、{{偏好说明}}、{{歌单说明}} 在发送时替换为实际内容。修改不当可能导致选歌失效。',
            tpl, textButton('恢复默认', () => { r.prompt = ''; tpl.value = rec.DEFAULT_PROMPT; save(); })),
    );
    subhead(target, '黑名单');
    cardIn(target)(blockList());
}

/** 情境编辑：每个情境有名称、说明（附加给模型）、检索词（附加到搜索短语）。 */
function sceneEditor(r) {
    const box = h('div', 'stm-set-block stm-scene-edit');
    box.appendChild(h('div', 'stm-set-desc', '在「选歌」页点选情境。说明附加给模型；检索词附加到每个搜索短语后。'));
    const list = h('div', 'stm-scene-list');
    const render = () => {
        list.replaceChildren();
        r.scenes.forEach((sc, i) => {
            const row = h('div', 'stm-scene-row');
            const name = textInput(sc.name, '名称', (v) => { if (r.scene === sc.name) r.scene = v.trim(); sc.name = v.trim(); save(); });
            name.maxLength = 8;
            const prompt = textInput(sc.prompt, '说明', (v) => { sc.prompt = v; save(); });
            const words = textInput(sc.words, '检索词（可留空）', (v) => { sc.words = v; save(); });
            const del = h('button', 'stm-text-btn stm-press', '删除');
            del.type = 'button';
            del.addEventListener('click', () => { if (r.scene === sc.name) r.scene = ''; r.scenes.splice(i, 1); save(); render(); });
            const top = h('div', 'stm-scene-top');
            top.append(name, del);
            row.append(top, prompt, words);
            list.appendChild(row);
        });
    };
    render();
    const add = textButton('添加情境', () => { r.scenes.push({ name: '新情境', prompt: '', words: '' }); save(); render(); });
    box.append(list, add);
    return box;
}

/** 黑名单：可按歌名或歌手搜索，每行可移出。 */
function blockList() {
    const r = settings().rec;
    const box = h('div', 'stm-set-block stm-block-box');
    box.appendChild(h('div', 'stm-set-desc', '播放列表中点击「不喜欢」的歌曲记录在此，不再被推荐。'));
    const input = textInput('', '按歌名或歌手搜索', () => render(), 'search');
    const list = h('div', 'stm-block-list');
    const render = () => {
        const q = input.value.trim().toLowerCase();
        const items = r.block.filter((x) => !q || `${x.title} ${x.artist}`.toLowerCase().includes(q));
        list.replaceChildren();
        if (!items.length) { list.appendChild(h('div', 'stm-hint', r.block.length ? '没有匹配的歌曲' : '黑名单为空')); return; }
        for (const x of items) {
            const row = h('div', 'stm-block-row');
            const text = h('div', 'stm-block-text');
            text.append(h('div', 'stm-row-title', x.title), h('div', 'stm-row-sub', x.artist));
            const out = h('button', 'stm-text-btn stm-press', '移出');
            out.type = 'button';
            out.addEventListener('click', () => { rec.unblock(rec.blockId(x)); render(); });
            row.append(text, out);
            list.appendChild(row);
        }
    };
    render();
    box.append(input, list);
    return box;
}

/** 黑名单变化后（例如在播放列表中点击「不喜欢」），已打开的设置页随之更新。 */
export function refreshBlockList() {
    for (const box of document.querySelectorAll('.stm-block-box')) box.replaceWith(blockList());
}

function fillLook(target) {
    const s = settings();
    const card = cardIn(target);
    subhead(target, '面板');
    card(
        block('面板形式', '卡片可拖动顶部移动、按住四角调整大小；全屏占满整个屏幕。',
            makeSeg([{ value: 'card', label: '卡片' }, { value: 'full', label: '全屏' }], s.panelForm, (v) => { s.panelForm = v; save(); ui.applyForm(); })),
        block('唱片页形式', '收起式：唱片页单独显示，不显示底栏，左上角按钮收起；其余页面可左右滑动切换。底栏式：唱片页与其余页面并列，显示底栏，全部页面可左右滑动切换。',
            makeSeg([{ value: 'sheet', label: '收起式' }, { value: 'tab', label: '底栏式' }], s.nowForm, (v) => { s.nowForm = v; save(); ui.applyNowForm(); })),
        block('打开面板时显示', '',
            makeSeg([{ value: 'now', label: '唱片' }, { value: 'my', label: '我的' }], s.home, (v) => { s.home = v; save(); })),
        item('当前歌曲胶囊', '在唱片页以外的页面底部显示当前歌曲，点击进入唱片页。', toggle(s.capsule, (v) => { s.capsule = v; save(); ui.applyNowForm(); })),
        item('双击切换全屏', '双击面板顶部的横杠，在卡片与全屏之间切换。', toggle(s.dblFull, (v) => { s.dblFull = v; save(); })),
        block('动效风格', '',
            makeSeg([{ value: 'spring', label: '弹簧阻尼' }, { value: 'smooth', label: '平滑' }, { value: 'fade', label: '淡入淡出' }], s.motion, (v) => { s.motion = v; save(); ui.applyMotion(); })),
        item('位置', '将悬浮按钮、卡片和歌词长条移回默认位置。', textButton('复位', () => { ui.resetLayout(); strip.sync(); })),
    );

    subhead(target, '唱片页');
    card(
        block('唱片样式', '黑胶：黑色唱片与长唱臂。彩胶：半透明盘面，颜色取自封面。磁带：转轴随播放转动，标签左上角为专辑封面。封面：方形封面，暂停时略缩小。',
            makeSeg([{ value: 'vinyl', label: '黑胶' }, { value: 'color', label: '彩胶' }, { value: 'tape', label: '磁带' }, { value: 'cover', label: '封面' }], s.disc, (v) => { s.disc = v; save(); ui.applyDiscStyle(); })),
        block('配色', '跟随美化：使用酒馆当前主题的颜色。封面取色：强调色和面板顶部的底色取自当前歌曲封面。封面不允许读取颜色时使用主题颜色。',
            makeSeg([{ value: 'theme', label: '跟随美化' }, { value: 'cover', label: '封面取色' }], s.palette, (v) => { s.palette = v; save(); ui.applyDiscStyle(); })),
    );

    subhead(target, '自定义 CSS');
    const css = h('textarea', 'stm-input stm-textarea stm-code');
    css.rows = 6;
    css.placeholder = '#stm-panel { --stm-radius: 12px; }';
    css.value = s.customCss;
    css.addEventListener('input', () => { s.customCss = css.value; save(); ui.applyCustomCss(); });
    card(block('自定义 CSS', '输入后立即生效，可覆盖本扩展的全部样式。面板为 #stm-panel，悬浮按钮为 #stm-fab，歌词长条为 .stm-strip；颜色、圆角、动效时长等为 --stm- 开头的 CSS 变量。', css));

    subhead(target, '歌词长条');
    card(
        block('显示行数', '两行时第二行显示下一句。',
            makeSeg([{ value: 1, label: '一行' }, { value: 2, label: '两行' }], s.strip.lines, (v) => { s.strip.lines = v; save(); strip.applyStyle(); })),
        block('透明度', '', range(Math.round(s.strip.opacity * 100), 20, 100, 5, (v) => v + '%', (v) => { s.strip.opacity = v / 100; save(); strip.applyStyle(); })),
    );

    subhead(target, '我的');
    const m = s.my;
    const pick = textButton('选择图片', () => file.click());
    const file = h('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.style.display = 'none';
    const imgNote = h('div', 'stm-set-desc', m.image ? '已选择图片。' : '尚未选择图片。');
    file.addEventListener('change', async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        try {
            m.image = await shrinkImage(f, 720, 0.82);
            m.bg = 'image';
            bgSeg.setValue('image');
            showPick();
            save();
            imgNote.textContent = '已选择图片。';
        } catch (e) { notify('无法读取该图片', 'warning'); }
        file.value = '';
    });
    // 「选择图片」只在选中「自选图片」时显示
    const showPick = () => { pick.style.display = imgNote.style.display = m.bg === 'image' ? '' : 'none'; };
    const bgSeg = makeSeg([{ value: 'cover', label: '当前封面' }, { value: 'chat', label: '聊天背景' }, { value: 'image', label: '自选图片' }, { value: 'none', label: '无' }], m.bg, (v) => { m.bg = v; save(); showPick(); });
    showPick();
    const bioInput = textInput(m.bio, '例：{{user}} 与 {{char}} 的歌单', (v) => { m.bio = v; save(); });
    bioInput.maxLength = 60;
    card(
        block('顶部背景', '当前封面：虚化显示正在播放的歌曲封面。聊天背景：使用酒馆当前的聊天背景。自选图片：压缩到 720 像素宽后保存在酒馆设置中。', bgSeg, pick, imgNote, file),
        block('简介', '显示在名字下方，可留空。支持 {{user}}、{{char}} 等酒馆宏。', bioInput),
    );

    subhead(target, '悬浮按钮');
    const size = h('input', 'stm-range');
    size.type = 'range';
    size.min = '28'; size.max = '64'; size.step = '2';
    size.value = String(s.fabSize);
    const sizeLabel = h('span', 'stm-range-num', s.fabSize + ' px');
    size.addEventListener('input', () => { s.fabSize = Number(size.value); sizeLabel.textContent = s.fabSize + ' px'; save(); ui.renderFab(); });
    const sizeRow = h('div', 'stm-range-row');
    sizeRow.append(size, sizeLabel);

    const icon = s.fabIcon;
    const iconPicker = h('div', 'stm-chips');
    for (const name of ['fa-music', 'fa-headphones', 'fa-compact-disc', 'fa-radio', 'fa-guitar', 'fa-wave-square']) {
        const b = h('button', 'stm-chip stm-chip-icon stm-press');
        b.type = 'button';
        b.appendChild(h('i', 'fa-solid ' + name));
        b.classList.toggle('stm-on', icon.icon === name);
        b.addEventListener('click', () => {
            icon.icon = name; save(); ui.renderFab();
            for (const x of iconPicker.children) x.classList.toggle('stm-on', x === b);
        });
        iconPicker.appendChild(b);
    }
    const imageInput = textInput(icon.image, '图片地址', (v) => { icon.image = v; save(); ui.renderFab(); }, 'url');
    const textField = textInput(icon.text, '不超过 4 个字符', (v) => { icon.text = v; save(); ui.renderFab(); });
    textField.maxLength = 4;
    const extras = { icon: iconPicker, image: imageInput, text: textField };
    const showExtra = () => { for (const [k, el] of Object.entries(extras)) el.style.display = k === icon.type ? '' : 'none'; };
    showExtra();
    card(
        block('大小', '', sizeRow),
        block('内容', '选择「封面」时显示当前歌曲的封面；没有歌曲时显示图标。',
            makeSeg([{ value: 'icon', label: '图标' }, { value: 'cover', label: '封面' }, { value: 'image', label: '图片' }, { value: 'text', label: '文字' }], icon.type, (v) => { icon.type = v; save(); showExtra(); ui.renderFab(); }),
            iconPicker, imageInput, textField),
    );
}

function fillPlay(target) {
    const s = settings();
    cardIn(target)(item('后台保活', '播放期间循环播放一段无声音频，降低页面在后台被系统挂起的可能。效果取决于浏览器和系统的省电设置；会略微增加耗电。', toggle(s.keepAlive, (v) => { s.keepAlive = v; save(); syncKeepAlive(); })));
}

/** 调试：播放记录，以日志列表显示。 */
function fillDebug(target) {
    const log = h('div', 'stm-log');
    const render = () => {
        log.replaceChildren();
        const items = player.getTraceItems();
        if (!items.length) { log.appendChild(h('div', 'stm-log-empty', '暂无记录。')); return; }
        for (const it of items.slice().reverse()) {
            const row = h('div', 'stm-log-row');
            row.append(h('span', 'stm-log-time', it.time), h('span', `stm-log-tag${it.hidden ? ' stm-bg' : ''}`, it.hidden ? '后台' : '前台'), h('span', 'stm-log-text', it.text));
            log.appendChild(row);
        }
    };
    render();
    const actions = h('div', 'stm-log-actions');
    actions.append(
        textButton('刷新', render),
        textButton('复制', async () => {
            try { await navigator.clipboard.writeText(player.getTrace()); notify('已复制播放记录'); } catch (e) { notify('复制失败，浏览器不允许访问剪贴板', 'warning'); }
        }),
    );
    const s = settings();
    cardIn(target)(block('播放方式（测试）',
        '标准：使用浏览器的播放器，边下载边播放。音频线程：整首下载并解码后用 Web Audio 播放；单曲循环和播完接下一首都在音频线程上完成，页面脚本在后台被暂停时仍可继续（用于 Via 等浏览器）。'
        + '音频线程方式下，每首歌需下载完成后才开始播放；解码后的数据每首约占 80–100 MB 内存，同时保留当前和下一首。切换时停止当前播放。',
        makeSeg([{ value: 'element', label: '标准' }, { value: 'buffer', label: '音频线程' }], s.engine, (v) => { s.engine = v; save(); player.setEngine(v); })));
    cardIn(target)(block('播放记录', '最近的播放事件，新的在上。仅保存在内存中，刷新页面后清空。页面在后台被浏览器暂停时，事件在回到前台后才记录，时间为记录时的时间。', actions, log));
}

function fillApi(target) {
    const s = settings();
    const card = cardIn(target);
    card(
        item('公共接口一', 'api.i-meto.com', toggle(s.providers.imeto, (v) => { s.providers.imeto = v; save(); })),
        item('公共接口二', 'api.vkeys.cn', toggle(s.providers.vkeys, (v) => { s.providers.vkeys = v; save(); })),
        block('自定义接口', 'Meting 格式的接口地址。填写后优先使用；留空时不使用。',
            textInput(s.customMeting, 'https://', (v) => { s.customMeting = v; save(); }, 'url')),
    );
    target.appendChild(h('div', 'stm-set-note', '接口按上述顺序使用；某一接口连续失败时自动切换到下一个。公共接口仅能播放平台允许免费播放的歌曲。'));
}

/** 在酒馆的扩展设置页里放一个可折叠的设置区。每次展开时重新生成，保证与面板里的设置一致。 */
export function mountExtensionPage() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const root = h('div', 'stm-settings');
    const drawer = h('div', 'inline-drawer');
    const header = h('div', 'inline-drawer-toggle inline-drawer-header');
    header.append(h('b', '', NAME), h('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const content = h('div', 'inline-drawer-content');
    drawer.append(header, content);
    root.appendChild(drawer);
    // 只在展开前、且设置在别处改过时才重新生成。展开时不做多余的排版，展开动画才能逐帧进行
    const sig = () => JSON.stringify(settings(), (k, v) => (['queue', 'lib', 'index', 'history', 'sections', 'volume'].includes(k) ? undefined : v));
    let builtSig = '';
    const rebuild = () => { build(content); builtSig = sig(); };
    header.addEventListener('click', () => { if (getComputedStyle(content).display === 'none' && sig() !== builtSig) rebuild(); });
    rebuild();
    host.appendChild(root);
}
