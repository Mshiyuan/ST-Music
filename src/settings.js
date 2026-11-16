// 设置的读取与保存。数据存放在酒馆的扩展设置里。

export const KEY = 'st_music';
export const NAME = '随剧听';

const DEFAULTS = {
    enabled: true,
    panelForm: 'card',            // 'card' 卡片 | 'full' 全屏
    dblFull: true,                // 双击面板顶部的横杠在卡片和全屏之间切换
    fab: { x: 0.92, y: 0.6 },     // 悬浮按钮位置，占视口的比例
    fabSize: 40,                  // 悬浮按钮直径（像素）
    fabIcon: { type: 'icon', icon: 'fa-music', image: '', text: '' },   // type: icon | cover | image | text
    motion: 'spring',             // 'spring' 弹簧阻尼 | 'smooth' 平滑 | 'fade' 淡入淡出
    showTrans: true,              // 歌词页是否显示译文
    keepAlive: false,             // 后台保活
    strip: { on: false, x: 0.5, y: 0.82 },   // 歌词长条
    rec: {                        // 按剧情选歌
        enabled: true,
        every: 1,                 // 每隔几条 AI 回复推荐一次
        count: 3,                 // 每次推荐几首
        langs: [],                // 语言偏好
        customLangs: [],          // 用户自己添加的语言
        prefer: '',               // 自由填写的偏好
        prompt: '',               // 自定义的说明模板；留空使用默认模板
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
    lib: {                        // 歌库：收藏、歌单、播放记录
        tracks: {},               // 歌曲 key -> 歌曲信息（被收藏、歌单、记录引用的歌）
        fav: [],                  // 收藏的歌曲 key，新的在前
        lists: [],                // [{ id, name, keys: [] }]
        recent: [],               // 最近播放的歌曲 key，新的在前
        plays: {},                // 歌曲 key -> 播放次数
        totalSec: 0,              // 累计收听秒数
        hours: {},                // 'YYYY-MM-DD' -> 长度 24 的数组，每小时收听的秒数
    },
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
    const s = fill(store[KEY], DEFAULTS);
    if (s.panelForm !== 'card' && s.panelForm !== 'full') s.panelForm = 'card';   // 旧版的「底部抽屉」已取消
    return s;
}

export function save() {
    ctx().saveSettingsDebounced();
}

export function notify(text, type = 'info') {
    const t = globalThis.toastr;
    if (t && typeof t[type] === 'function') t[type](text, NAME);
}
