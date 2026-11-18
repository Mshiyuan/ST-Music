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
    engine: 'element',            // 播放方式：'element' 标准 | 'buffer' 音频线程（Web Audio，后台脚本暂停时仍可循环和接续）
    nowForm: 'sheet',             // 唱片页形式：'sheet' 收起式（无底栏，左上角收起）| 'tab' 底栏式（保留底栏，可左右滑动）
    home: 'now',                  // 打开面板时显示：'now' 唱片 | 'my' 我的
    capsule: true,                // 其他页面底部显示当前歌曲的胶囊
    disc: 'vinyl',                // 唱片样式：'vinyl' 黑胶 | 'color' 彩胶 | 'tape' 磁带 | 'cover' 封面
    palette: 'theme',             // 配色：'theme' 跟随酒馆美化 | 'cover' 跟随专辑封面取色
    customCss: '',                // 自定义 CSS
    my: { bg: 'cover', image: '', bio: '' },   // 「我的」页面：顶部背景 'cover' 当前封面 | 'chat' 聊天背景 | 'image' 自选图片 | 'none'；简介文字
    sections: {},                 // 设置页里各板块是否展开
    strip: { on: false, x: 0.5, y: 0.82, lines: 1, opacity: 1 },   // 歌词长条
    rec: {                        // 剧情配乐
        enabled: true,
        every: 1,                 // 每隔几条 AI 回复推荐一次
        count: 3,                 // 每次推荐几首
        arrive: 'after',          // 新推荐到达时：'after' 播完当前歌曲后切换 | 'now' 立即切换
        keep: 30,                 // 播放列表里最多保留多少首推荐的歌，超出时去掉最早的
        noRepeat: true,           // 避免重复推荐
        noRepeatCount: 20,        // 最近多少首不再推荐
        history: [],              // 最近推荐过的歌（"key|歌名"），新的在前
        block: [],                // 黑名单：[{ key, title, artist, at }]，按歌名 + 歌手排除，新的在前
        method: 'song',           // 找歌方式：'song' 单曲搜索 | 'playlist' 歌单检索 | 'vector' 向量匹配
        fromLib: { on: false, max: 50 },   // 从用户歌单推歌：在说明里附上至多 max 首歌名，由模型选取
        scenes: [                 // 情境按钮：名称、补充给模型的偏好、检索时附加的词
            { name: '睡前', prompt: '曲调舒缓、安静，起伏小。', words: '轻柔' },
            { name: '写作', prompt: '人声少或无人声，节奏平稳，不抢注意力。', words: '纯音乐' },
            { name: '运动', prompt: '节奏明快，有力度。', words: '节奏' },
        ],
        scene: '',                // 当前启用的情境名称；空为不启用
        ost: { on: false, max: 50 },       // 剧情原声：按角色记录推荐并实际播放过的歌，每个角色至多 max 首
        langs: [],                // 语言偏好
        customLangs: [],          // 用户自己添加的语言
        hiddenLangs: [],          // 被删除的内置语言
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
        ost: {},                  // 剧情原声：角色头像文件名 -> { name, avatar, keys }
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
    if (s.nowForm !== 'sheet' && s.nowForm !== 'tab') s.nowForm = 'sheet';
    return s;
}

export function save() {
    ctx().saveSettingsDebounced();
}

export function notify(text, type = 'info') {
    const t = globalThis.toastr;
    if (t && typeof t[type] === 'function') t[type](text, NAME);
}
