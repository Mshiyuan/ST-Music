// ST-Music 入口：初始化播放器与界面，并在扩展设置页里放置设置项。

import { settings, save } from './src/settings.js';
import { preconnect } from './src/sources.js';
import * as player from './src/player.js';
import * as ui from './src/ui.js';
import * as rec from './src/rec.js';

function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
}

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

/** 加减数字。 */
function stepper(value, min, max, onChange) {
    const box = h('div', 'stm-stepper');
    const minus = h('button', 'stm-step stm-press', '−');
    const plus = h('button', 'stm-step stm-press', '+');
    const num = h('span', 'stm-step-num', String(value));
    minus.type = plus.type = 'button';
    const set = (v) => {
        value = Math.min(max, Math.max(min, v));
        num.textContent = String(value);
        minus.disabled = value <= min;
        plus.disabled = value >= max;
    };
    minus.addEventListener('click', () => { set(value - 1); onChange(value); });
    plus.addEventListener('click', () => { set(value + 1); onChange(value); });
    set(value);
    box.append(minus, num, plus);
    return box;
}

/** 多选的小标签。options: [[值, 文字]]；isOn(值) 返回是否选中。 */
function chips(options, isOn, onChange) {
    const box = h('div', 'stm-chips');
    for (const [value, label] of options) {
        const b = h('button', 'stm-chip stm-press', label);
        b.type = 'button';
        b.classList.toggle('stm-on', !!isOn(value));
        b.addEventListener('click', () => { const v = !b.classList.contains('stm-on'); b.classList.toggle('stm-on', v); onChange(value, v); });
        box.appendChild(b);
    }
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

function buildSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const s = settings();

    const root = h('div', 'stm-settings');
    const drawer = h('div', 'inline-drawer');
    const header = h('div', 'inline-drawer-toggle inline-drawer-header');
    header.append(h('b', '', 'ST-Music'), h('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const content = h('div', 'inline-drawer-content');
    drawer.append(header, content);
    root.appendChild(drawer);
    const group = (name) => content.appendChild(h('div', 'stm-set-group', name));
    const card = (...children) => { const c = h('div', 'stm-card'); c.append(...children); content.appendChild(c); return c; };

    // 状态
    card(item('启用', '关闭后隐藏悬浮按钮并暂停播放', toggle(s.enabled, (v) => {
        s.enabled = v; save(); ui.setEnabled(v); rec.syncPrompt();
    })));

    // 按剧情选歌
    group('按剧情选歌');
    const r = s.rec;
    const prefer = h('textarea', 'stm-input stm-textarea');
    prefer.placeholder = '例如：少推流行，多推后摇和纯音乐';
    prefer.value = r.prefer;
    prefer.rows = 2;
    prefer.addEventListener('input', () => { r.prefer = prefer.value; save(); });
    card(
        item('自动选歌', 'AI 在回复末尾附一个不显示的标签，插件据此搜歌。会在提示词里加一段说明，并使该条回复多输出几十个字；不额外调用 AI', toggle(r.enabled, (v) => { r.enabled = v; save(); rec.syncPrompt(); })),
        item('推荐间隔', '每隔几条 AI 回复推荐一次', stepper(r.every, 1, 20, (v) => { r.every = v; save(); })),
        item('每次几首', '推荐的歌排在当前歌曲之后，当前这首播完再切换', stepper(r.count, 1, 10, (v) => { r.count = v; save(); })),
        block('语言偏好', '不选表示不限', chips(rec.LANGS.map((l) => [l, l]), (v) => r.langs.includes(v), (v, on) => {
            r.langs = on ? [...r.langs, v] : r.langs.filter((x) => x !== v); save();
        })),
        block('推荐偏好', '写给 AI 的补充说明，可留空', prefer),
        block('不要的版本', '选中的版本不会出现在推荐里', chips(rec.VERSIONS.map(([k, name]) => [k, name]), (k) => r.exclude[k], (k, on) => { r.exclude[k] = on; save(); })),
        block('标签维度', '关掉不需要的维度可以减少输出', chips(rec.DIMS, (k) => r.dims[k], (k, on) => { r.dims[k] = on; save(); })),
    );

    // 外观
    group('外观');
    const reset = h('button', 'stm-text-btn stm-press', '复位');
    reset.type = 'button';
    reset.addEventListener('click', () => ui.resetLayout());
    card(
        block('面板形式', '卡片可拖动顶部移动、拖四角改大小；抽屉固定在屏幕底部',
            ui.makeSeg([{ value: 'card', label: '卡片' }, { value: 'drawer', label: '底部抽屉' }], s.panelForm, (v) => { s.panelForm = v; save(); ui.applyForm(); })),
        block('动效风格', '',
            ui.makeSeg([{ value: 'spring', label: '弹簧阻尼' }, { value: 'smooth', label: '平滑' }, { value: 'fade', label: '淡入淡出' }], s.motion, (v) => { s.motion = v; save(); ui.applyMotion(); })),
        item('位置和大小', '悬浮按钮与卡片恢复到默认位置和大小', reset),
    );

    // 悬浮按钮
    group('悬浮按钮');
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
    const imageInput = textInput(icon.image, '图片地址 https://', (v) => { icon.image = v; save(); ui.renderFab(); }, 'url');
    const textField = textInput(icon.text, '一两个字或一个表情', (v) => { icon.text = v; save(); ui.renderFab(); });
    textField.maxLength = 4;
    const extras = { icon: iconPicker, image: imageInput, text: textField };
    const showExtra = () => { for (const [k, el] of Object.entries(extras)) el.style.display = k === icon.type ? '' : 'none'; };
    showExtra();
    card(
        block('大小', '', sizeRow),
        block('内容', '选「封面」时显示正在播放的歌的封面，没有歌时显示图标',
            ui.makeSeg([{ value: 'icon', label: '图标' }, { value: 'cover', label: '封面' }, { value: 'image', label: '图片' }, { value: 'text', label: '文字' }], icon.type, (v) => { icon.type = v; save(); showExtra(); ui.renderFab(); }),
            iconPicker, imageInput, textField),
    );

    // 接口
    group('接口');
    card(
        item('公共接口一', 'api.i-meto.com', toggle(s.providers.imeto, (v) => { s.providers.imeto = v; save(); })),
        item('公共接口二', 'api.vkeys.cn', toggle(s.providers.vkeys, (v) => { s.providers.vkeys = v; save(); })),
        block('自定义接口', 'Meting 格式的接口地址，填写后优先使用；留空则不使用',
            textInput(s.customMeting, 'https://', (v) => { s.customMeting = v; save(); }, 'url')),
    );
    content.appendChild(h('div', 'stm-set-note', '接口按上面的顺序使用，某个接口连续失败时自动换下一个。公共接口仅能播放平台允许免费播放的歌曲。'));

    host.appendChild(root);
}

function start() {
    settings();
    preconnect();
    ui.init();
    player.init();
    rec.init();
    buildSettings();
}

if (globalThis.jQuery) globalThis.jQuery(start); else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
