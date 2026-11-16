// 设置页的内容。同一份内容既放在酒馆的扩展设置页里，也放在播放面板的「设置」页里。

import { settings, save, ctx, NAME } from './settings.js';
import { h, makeSeg } from './dom.js';
import * as rec from './rec.js';
import * as ui from './ui.js';
import * as strip from './strip.js';
import { syncKeepAlive } from './media.js';

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

function stepper(value, min, max, onChange) {
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
    minus.addEventListener('click', () => { set(value - 1); onChange(value); });
    plus.addEventListener('click', () => { set(value + 1); onChange(value); });
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
    const render = () => {
        box.replaceChildren();
        const toggleLang = (name, on) => { r.langs = on ? [...r.langs.filter((x) => x !== name), name] : r.langs.filter((x) => x !== name); save(); };
        for (const name of rec.LANGS) box.appendChild(chip(name, r.langs.includes(name), (on) => toggleLang(name, on)));
        for (const name of r.customLangs) {
            const c = chip(name, r.langs.includes(name), (on) => toggleLang(name, on));
            const del = h('i', 'fa-solid fa-xmark stm-chip-del');
            del.title = '删除';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                r.customLangs = r.customLangs.filter((x) => x !== name);
                r.langs = r.langs.filter((x) => x !== name);
                save();
                render();
            });
            c.appendChild(del);
            box.appendChild(c);
        }
        const add = h('button', 'stm-chip stm-chip-add stm-press', '其他');
        add.type = 'button';
        add.addEventListener('click', async () => {
            const name = (await askText('输入语言名称')).slice(0, 12);
            if (!name) return;
            if (!rec.LANGS.includes(name) && !r.customLangs.includes(name)) r.customLangs.push(name);
            if (!r.langs.includes(name)) r.langs.push(name);
            save();
            render();
        });
        box.appendChild(add);
    };
    render();
    return box;
}

/** 把全部设置项放进 content。 */
export function build(content) {
    const s = settings();
    content.replaceChildren();
    const group = (name) => content.appendChild(h('div', 'stm-set-group', name));
    const card = (...children) => { const c = h('div', 'stm-card'); c.append(...children); content.appendChild(c); return c; };

    card(item('启用', '关闭时隐藏悬浮按钮，并暂停播放。', toggle(s.enabled, (v) => {
        s.enabled = v; save(); ui.setEnabled(v); rec.syncPrompt(); syncKeepAlive();
    })));

    // 按剧情选歌
    group('按剧情选歌');
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
    card(
        item('自动选歌', '在提示词中加入一段说明，要求模型在回复末尾输出隐藏标签，并按标签检索歌曲。该条回复的输出增加数十字；不产生额外的模型调用。', toggle(r.enabled, (v) => { r.enabled = v; save(); rec.syncPrompt(); })),
        item('推荐间隔', '每隔若干条模型回复推荐一次。仅在推荐的那一条回复中加入说明。', stepper(r.every, 1, 20, (v) => { r.every = v; save(); })),
        item('每次推荐数量', '推荐的歌曲排在当前歌曲之后；当前歌曲播放结束后切换。', stepper(r.count, 1, 10, (v) => { r.count = v; save(); })),
        block('语言偏好', '未选择时不限制语言。「其他」可添加自定义语言。', languageChips(r)),
        block('推荐偏好', '补充给模型的说明，可留空。', prefer),
        block('排除的版本', '选中的版本不出现在推荐结果中。', chips(rec.VERSIONS.map(([k, name]) => [k, name]), (k) => r.exclude[k], (k, on) => { r.exclude[k] = on; save(); })),
        block('标签维度', '停用的维度不写入标签，可减少输出字数。', chips(rec.DIMS, (k) => r.dims[k], (k, on) => { r.dims[k] = on; save(); })),
        block('说明模板', '发送给模型的说明文字。{{格式}}、{{维度说明}}、{{语言说明}}、{{偏好说明}} 在发送时替换为实际内容。修改不当可能导致选歌失效。',
            tpl, textButton('恢复默认', () => { r.prompt = ''; tpl.value = rec.DEFAULT_PROMPT; save(); })),
    );

    // 外观
    group('外观');
    card(
        block('面板形式', '卡片可拖动顶部移动、按住四角调整大小；全屏占满整个屏幕。',
            makeSeg([{ value: 'card', label: '卡片' }, { value: 'full', label: '全屏' }], s.panelForm, (v) => { s.panelForm = v; save(); ui.applyForm(); })),
        item('双击切换全屏', '双击面板顶部的横杠，在卡片与全屏之间切换。', toggle(s.dblFull, (v) => { s.dblFull = v; save(); })),
        block('动效风格', '',
            makeSeg([{ value: 'spring', label: '弹簧阻尼' }, { value: 'smooth', label: '平滑' }, { value: 'fade', label: '淡入淡出' }], s.motion, (v) => { s.motion = v; save(); ui.applyMotion(); })),
        item('位置', '将悬浮按钮、卡片和歌词长条移回默认位置。', textButton('复位', () => { ui.resetLayout(); strip.sync(); })),
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

    // 播放
    group('播放');
    card(item('后台保活', '播放期间循环播放一段无声音频，降低页面在后台被系统挂起的可能。效果取决于浏览器和系统的省电设置；会略微增加耗电。', toggle(s.keepAlive, (v) => { s.keepAlive = v; save(); syncKeepAlive(); })));

    // 接口
    group('接口');
    card(
        item('公共接口一', 'api.i-meto.com', toggle(s.providers.imeto, (v) => { s.providers.imeto = v; save(); })),
        item('公共接口二', 'api.vkeys.cn', toggle(s.providers.vkeys, (v) => { s.providers.vkeys = v; save(); })),
        block('自定义接口', 'Meting 格式的接口地址。填写后优先使用；留空时不使用。',
            textInput(s.customMeting, 'https://', (v) => { s.customMeting = v; save(); }, 'url')),
    );
    content.appendChild(h('div', 'stm-set-note', '接口按上述顺序使用；某一接口连续失败时自动切换到下一个。公共接口仅能播放平台允许免费播放的歌曲。'));
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
    header.addEventListener('click', () => build(content));
    build(content);
    host.appendChild(root);
}
