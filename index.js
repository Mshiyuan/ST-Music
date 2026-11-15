// ST-Music 入口：初始化播放器与界面，并在扩展设置页里放置设置项。

import { settings, save } from './src/settings.js';
import * as player from './src/player.js';
import * as ui from './src/ui.js';

function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
}

function item(title, desc, control) {
    const box = h('div', 'stm-set-item');
    const text = h('div', 'stm-set-text');
    text.appendChild(h('div', 'stm-set-title', title));
    if (desc) text.appendChild(h('div', 'stm-set-desc', desc));
    box.append(text, control);
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

    // 状态
    const status = h('div', 'stm-card');
    status.appendChild(item('启用', '关闭后隐藏悬浮按钮并暂停播放', toggle(s.enabled, (v) => {
        s.enabled = v; save(); ui.setEnabled(v);
    })));
    content.appendChild(status);

    // 面板
    content.appendChild(h('div', 'stm-set-group', '面板'));
    const panelCard = h('div', 'stm-card');
    const formBox = h('div', 'stm-set-block');
    formBox.append(
        h('div', 'stm-set-title', '面板形式'),
        h('div', 'stm-set-desc', '卡片可拖动标题栏移动、拖四角改大小；抽屉固定在屏幕底部'),
        ui.makeSeg([{ value: 'card', label: '卡片' }, { value: 'drawer', label: '底部抽屉' }], s.panelForm, (v) => {
            s.panelForm = v; save(); ui.applyForm();
        }),
    );
    const reset = h('button', 'stm-text-btn stm-press', '复位');
    reset.type = 'button';
    reset.addEventListener('click', () => ui.resetLayout());
    panelCard.append(formBox, item('位置和大小', '悬浮按钮与卡片恢复到默认位置和大小', reset));
    content.appendChild(panelCard);

    // 接口
    content.appendChild(h('div', 'stm-set-group', '接口'));
    const api = h('div', 'stm-card');
    api.append(
        item('公共接口一', 'api.i-meto.com', toggle(s.providers.imeto, (v) => { s.providers.imeto = v; save(); })),
        item('公共接口二', 'api.vkeys.cn', toggle(s.providers.vkeys, (v) => { s.providers.vkeys = v; save(); })),
    );
    const custom = h('div', 'stm-set-block');
    const input = h('input', 'stm-input');
    input.type = 'url';
    input.placeholder = 'https://';
    input.value = s.customMeting;
    input.addEventListener('input', () => { s.customMeting = input.value; save(); });
    custom.append(
        h('div', 'stm-set-title', '自定义接口'),
        h('div', 'stm-set-desc', 'Meting 格式的接口地址，填写后优先使用；留空则不使用'),
        input,
    );
    api.appendChild(custom);
    content.appendChild(api);
    content.appendChild(h('div', 'stm-set-note', '接口按上面的顺序使用，某个接口连续失败时自动换下一个。公共接口仅能播放平台允许免费播放的歌曲。'));

    host.appendChild(root);
}

function start() {
    settings();
    ui.init();
    player.init();
    buildSettings();
}

if (globalThis.jQuery) globalThis.jQuery(start); else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
