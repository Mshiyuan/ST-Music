// 按剧情选歌：让 AI 在回复末尾附一个隐藏标签，读取后到曲库搜歌。不额外调用 AI。

import { settings, ctx, notify, save } from './settings.js';
import { searchSongs, probeTrack } from './sources.js';
import * as player from './player.js';

const PROMPT_KEY = 'st_music_tag';
const IN_CHAT = 1;                 // 酒馆 extension_prompt_types.IN_CHAT
const PROBE_PARALLEL = 3;          // 同时检查几首候选能否播放
const PROBE_MAX = 15;              // 每次最多检查多少首

export const DIMS = [
    ['mood', '情绪'], ['theme', '主题'], ['relation', '关系'], ['event', '事件'],
    ['scene', '场景'], ['stance', '态度'], ['tone', '语气'], ['imagery', '意象'],
];

export const LANGS = ['华语', '粤语', '英语', '日语', '韩语', '纯音乐'];

export const VERSIONS = [
    ['live', '现场版', /live|现场|演唱会/i],
    ['dj', 'DJ / 混音版', /\bdj|remix|混音|电音|热播版|抖音|加速|降速|变速|降调|升调/i],
    ['inst', '伴奏', /伴奏|instrumental|karaoke|off ?vocal/i],
    ['cover', '翻唱', /翻唱|cover|翻自/i],
];

const TAG = /<!--\s*stmusic\b([\s\S]*?)-->|<stmusic>([\s\S]*?)<\/stmusic>/i;

let sinceLast = 0;        // 上次推荐之后又来了几条 AI 回复
let lastTags = null;      // 最近一次读到的标签 { dims: {情绪: …}, search: [...] }
let runToken = 0;
let busyListener = null;
let busy = false;
const recent = new Set(); // 本次会话里已经推荐过的歌，换一批时避开

export const getLastTags = () => lastTags;
export const isBusy = () => busy;
export const onBusy = (fn) => { busyListener = fn; };
const setBusy = (v) => { busy = v; if (busyListener) busyListener(v); };

const nameOf = (t) => `${t.title}`.replace(/[\s（(].*$/, '').toLowerCase();

/** 「避免重复推荐」开启时，最近推荐过的歌（按编号或歌名）不再推荐。 */
function repeated(t) {
    const r = settings().rec;
    if (!r.noRepeat) return false;
    const name = nameOf(t);
    return r.history.slice(0, r.noRepeatCount).some((x) => { const [k, n] = x.split('|'); return k === t.key || n === name; });
}

function remember(tracks) {
    const r = settings().rec;
    const items = tracks.map((t) => `${t.key}|${nameOf(t)}`);
    r.history = [...items, ...r.history.filter((x) => !items.includes(x))].slice(0, 200);
}

/** 默认的说明模板。{{…}} 是变量，生成时替换为实际内容。 */
export const DEFAULT_PROMPT = [
    '[音乐标签] 在本次回复的正文全部结束后，另起一行，输出且只输出一次下面这种格式的 HTML 注释，用于为当前剧情匹配背景音乐。不要在正文里提到它，也不要解释。',
    '{{格式}}',
    '填写要求：',
    '{{维度说明}}',
    '- 搜索：填 2–3 个可以直接在音乐平台搜索歌曲的短语，由氛围、情绪、曲风、乐器等词组成（例如「雨夜 钢琴」「伤感 民谣」），不要填具体歌名。',
    '- 用户在消息中明确提出想听的音乐类型时，以用户的要求为准填写搜索短语。',
    '{{语言说明}}',
    '{{偏好说明}}',
].join('\n');

/** 按当前设置生成发给模型的说明。 */
export function buildPrompt() {
    const r = settings().rec;
    const dims = DIMS.filter(([k]) => r.dims[k]).map(([, name]) => name);
    const vars = {
        '格式': `<!--stmusic ${[...dims.map((d) => `${d}=…`), '搜索=短语1;短语2;短语3'].join('|')}-->`,
        '维度说明': dims.length ? `- ${dims.join('、')}：各填 1–2 个简短的词，概括到本次回复为止的剧情氛围。` : '',
        '语言说明': r.langs.length ? `- 歌曲语言偏好：${r.langs.join('、')}。搜索短语要体现这一偏好。` : '',
        '偏好说明': r.prefer.trim() ? `- 用户的音乐偏好：${r.prefer.trim()}` : '',
    };
    const tpl = r.prompt.trim() ? r.prompt : DEFAULT_PROMPT;
    return tpl.replace(/\{\{(格式|维度说明|语言说明|偏好说明)\}\}/g, (m, k) => vars[k]).split('\n').filter((line) => line.trim()).join('\n');
}

function parseTag(body) {
    const dims = {};
    let search = [];
    for (const part of body.split(/[|｜]/)) {
        const i = part.search(/[=＝:：]/);
        if (i < 0) continue;
        const key = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        if (!key || !value || /^[….]+$/.test(value)) continue;
        if (key === '搜索') search = value.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
        else dims[key] = value;
    }
    return { dims, search };
}

/** 从消息文本里取出标签；返回 { clean: 去掉标签后的文本, tags } 或 null。 */
export function extract(text) {
    const m = TAG.exec(text || '');
    if (!m) return null;
    return { clean: text.replace(TAG, '').replace(/\s+$/, ''), tags: parseTag(m[1] || m[2] || '') };
}

function excluded(track) {
    const ex = settings().rec.exclude;
    const text = `${track.title} ${track.artist}`;
    return VERSIONS.some(([k, , re]) => ex[k] && re.test(text));
}

/** 从候选里并行检查，取够 count 首能播的歌。 */
async function pickPlayable(cands, count, token) {
    const picked = [];
    let cursor = 0;
    const worker = async () => {
        while (picked.length < count && cursor < Math.min(cands.length, PROBE_MAX) && token === runToken) {
            const track = cands[cursor++];
            if (await probeTrack(track) && picked.length < count) picked.push(track);
        }
    };
    await Promise.all(Array.from({ length: PROBE_PARALLEL }, worker));
    return picked;
}

async function recommend(manual) {
    if (!lastTags) {
        if (manual) notify('还没有可用的剧情标签，AI 回复一次后再试');
        return;
    }
    const r = settings().rec;
    const token = ++runToken;
    setBusy(true);
    try {
        const d = lastTags.dims;
        const phrases = lastTags.search.length ? lastTags.search : [[d['情绪'], d['场景']].filter(Boolean).join(' ')].filter(Boolean);
        if (!phrases.length) { if (manual) notify('标签里没有可用于搜索的内容', 'warning'); return; }
        const results = await Promise.allSettled(phrases.map((p) => searchSongs(p)));
        if (token !== runToken) return;
        const lists = results.filter((x) => x.status === 'fulfilled').map((x) => x.value);
        // 各短语的结果交替排列，避免只取到第一个短语的歌
        const merged = [];
        const seen = new Set();
        const longest = Math.max(0, ...lists.map((l) => l.length));
        for (let i = 0; i < longest; i++) {
            for (const list of lists) {
                const t = list[i];
                if (!t || excluded(t) || repeated(t)) continue;
                const name = nameOf(t);
                if (seen.has(t.key) || seen.has(name)) continue;
                seen.add(t.key); seen.add(name);
                merged.push({ ...t });
            }
        }
        const unseen = merged.filter((t) => !recent.has(t.key));
        const cands = unseen.length >= r.count ? unseen : merged;
        const picked = await pickPlayable(cands, r.count, token);
        if (token !== runToken) return;
        if (!picked.length) { if (manual) notify('没有找到可以播放的歌曲', 'warning'); return; }
        picked.forEach((t) => recent.add(t.key));
        remember(picked);
        save();
        const n = player.setRecommended(picked, manual);
        if (manual) notify(n ? `已按剧情推荐 ${n} 首` : '推荐结果与当前列表相同');
    } catch (e) {
        console.warn('[ST-Music] 推荐失败', e);
        if (manual) notify('推荐失败，接口暂时不可用', 'warning');
    } finally {
        if (token === runToken) setBusy(false);
    }
}

/** 手动重新推荐：用同一组标签换一批，不调用 AI。 */
export const refresh = () => recommend(true);

function active() {
    const s = settings();
    return s.enabled && s.rec.enabled;
}

/** 生成开始前决定这一条回复要不要附标签：只在到了推荐间隔的那一条附，其余不占输出。 */
function onGenerationStarted(type, opts, dryRun) {
    if (dryRun) return;
    const normal = type !== 'quiet' && type !== 'impersonate' && !(opts && opts.quiet_prompt);
    const due = active() && normal && sinceLast + 1 >= settings().rec.every;
    ctx().setExtensionPrompt(PROMPT_KEY, due ? buildPrompt() : '', IN_CHAT, 0);
}

function onMessageReceived(id) {
    const c = ctx();
    const m = c.chat[id];
    if (!m || m.is_user || m.is_system) return;
    const found = extract(m.mes);
    if (found) {
        // 标签不留在正文里，避免占用后续上下文；内容存到这条消息的附加数据
        m.mes = found.clean;
        if (Array.isArray(m.swipes) && typeof m.swipe_id === 'number' && m.swipes[m.swipe_id] !== undefined) m.swipes[m.swipe_id] = found.clean;
        m.extra = m.extra || {};
        m.extra.stmusic = found.tags;
    }
    if (!active()) return;
    sinceLast += 1;
    if (found && sinceLast >= settings().rec.every) {
        sinceLast = 0;
        lastTags = found.tags;
        recommend(false);
    }
}

function onChatChanged() {
    sinceLast = 0;
    lastTags = null;
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const t = chat[i] && chat[i].extra && chat[i].extra.stmusic;
        if (t) { lastTags = t; break; }
    }
}

/** 关闭功能时立即撤掉注入的说明。 */
export function syncPrompt() {
    if (!active()) ctx().setExtensionPrompt(PROMPT_KEY, '', IN_CHAT, 0);
}

export function init() {
    const c = ctx();
    const ev = c.eventTypes || c.event_types;
    c.eventSource.on(ev.GENERATION_STARTED, onGenerationStarted);
    c.eventSource.on(ev.MESSAGE_RECEIVED, onMessageReceived);
    c.eventSource.on(ev.CHAT_CHANGED, onChatChanged);
    onChatChanged();
}
