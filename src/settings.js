// 设置的读取与保存。数据存放在酒馆的扩展设置里。

export const KEY = 'st_music';

const DEFAULTS = {
    enabled: true,
    panelForm: 'card',            // 'card' 卡片 | 'drawer' 底部抽屉
    fab: { x: 0.92, y: 0.6 },     // 悬浮按钮位置，占视口的比例
    fabSize: 40,                  // 悬浮按钮直径（像素）
    fabIcon: { type: 'icon', icon: 'fa-music', image: '', text: '' },   // type: icon | cover | image | text
    motion: 'spring',             // 'spring' 弹簧阻尼 | 'smooth' 平滑 | 'fade' 淡入淡出
    showTrans: true,              // 歌词页是否显示译文
    rec: {                        // 按剧情选歌
        enabled: true,
        every: 1,                 // 每隔几条 AI 回复推荐一次
        count: 3,                 // 每次推荐几首
        langs: [],                // 语言偏好
        prefer: '',               // 自由填写的偏好
        exclude: { live: false, dj: true, inst: true, cover: false },
        dims: { mood: true, theme: true, relation: true, event: true, scene: true, stance: true, tone: true, imagery: true },
    },
    card: { x: null, y: null, w: 340, h: 540 },
    mode: 'loop',                 // 'loop' 列表循环 | 'single' 单曲循环 | 'shuffle' 随机
    volume: 1,
    providers: { imeto: true, vkeys: true },
    customMeting: '',             // 自定义 Meting 接口地址
    queue: [],
    index: -1,
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function fill(target, defaults) {
    for (const k of Object.keys(defaults)) {
        const d = defaults[k];
        if (target[k] === undefined) {
            target[k] = clone(d);
        } else if (d && typeof d === 'object' && !Array.isArray(d) && target[k] && typeof target[k] === 'object') {
            fill(target[k], d);
        }
    }
    return target;
}

export function ctx() {
    return globalThis.SillyTavern.getContext();
}

export function settings() {
    const store = ctx().extensionSettings;
    if (!store[KEY]) store[KEY] = {};
    return fill(store[KEY], DEFAULTS);
}

export function save() {
    ctx().saveSettingsDebounced();
}

export function notify(text, type = 'info') {
    const t = globalThis.toastr;
    if (t && typeof t[type] === 'function') t[type](text, 'ST-Music');
}
