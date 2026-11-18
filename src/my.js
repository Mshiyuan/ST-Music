// 「我的」页面：用户信息、收藏、最近播放、播放排行、歌单与导入。

import { ctx, notify } from './settings.js';
import { h, iconButton, songRow, hint, fmtDuration } from './dom.js';
import * as player from './player.js';
import * as library from './library.js';
import { askText } from './settingsUi.js';

export const askName = (title, value = '') => askText(title, value);

/** 取酒馆当前用户人设的头像地址和名字。 */
function userInfo() {
    const img = document.querySelector('#user_avatar_block .avatar-container.selected img')
        || document.querySelector('#chat .mes[is_user="true"] .avatar img');
    return { avatar: img ? img.getAttribute('src') : '', name: ctx().name1 || '' };
}

function tile(icon, title, sub, onClick, i) {
    const t = h('div', 'stm-tile stm-press');
    t.style.setProperty('--i', i);
    t.append(h('i', `fa-solid ${icon} stm-tile-icon`), h('div', 'stm-tile-title', title), h('div', 'stm-tile-sub', sub));
    t.addEventListener('click', onClick);
    return t;
}

/** 「我的」首页。 */
export function renderMy(box, api) {
    const l = library.lib();
    const u = userInfo();
    box.replaceChildren();

    const head = h('div', 'stm-my-head');
    const avatar = h('div', 'stm-avatar');
    if (u.avatar) {
        const img = h('img');
        img.alt = '';
        img.addEventListener('error', () => avatar.replaceChildren(h('i', 'fa-solid fa-user')));
        img.src = u.avatar;
        avatar.appendChild(img);
    } else avatar.appendChild(h('i', 'fa-solid fa-user'));
    const info = h('div', 'stm-my-info');
    info.append(h('div', 'stm-my-name', u.name || '用户'), h('div', 'stm-my-stat', `累计收听 ${fmtDuration(l.totalSec)}`));
    head.append(avatar, info);

    const tiles = h('div', 'stm-tiles');
    tiles.append(
        tile('fa-heart', '收藏', `${l.fav.length} 首`, () => api.go('detail', 'fav'), 0),
        tile('fa-clock-rotate-left', '最近播放', `${l.recent.length} 首`, () => api.go('detail', 'recent'), 1),
        tile('fa-ranking-star', '播放排行', `${Object.keys(l.plays).length} 首`, () => api.go('detail', 'rank'), 2),
    );

    const bar = h('div', 'stm-sec-bar');
    const create = iconButton('fa-plus', '新建歌单', 'stm-small');
    create.addEventListener('click', async () => {
        const name = await askName('歌单名称');
        if (name) library.createList(name);
    });
    const imp = iconButton('fa-file-import', '导入歌单', 'stm-small');
    imp.addEventListener('click', () => openImport(api));
    bar.append(h('div', 'stm-sec-title', `歌单（${l.lists.length}）`), imp, create);

    const lists = h('div', 'stm-list');
    if (!l.lists.length) hint(lists, '尚未创建歌单。可新建，或从网易云歌单、文本清单导入。');
    l.lists.forEach((list, i) => {
        const row = h('div', 'stm-row stm-list-row stm-press');
        row.style.setProperty('--i', i);
        const cover = h('div', 'stm-thumb');
        const first = library.tracksOf(list.keys)[0];
        if (first && first.cover) { const img = h('img'); img.alt = ''; img.loading = 'lazy'; img.src = first.cover; cover.appendChild(img); } else cover.appendChild(h('i', 'fa-solid fa-music'));
        const text = h('div', 'stm-row-main');
        text.append(h('div', 'stm-row-title', list.name), h('div', 'stm-row-sub', `${list.keys.length} 首`));
        row.append(cover, text, h('i', 'fa-solid fa-angle-right stm-row-go'));
        row.addEventListener('click', () => api.go('detail', list.id));
        lists.appendChild(row);
    });

    box.append(head, tiles, bar, lists);
}

/** 详情页：收藏、最近播放、播放排行，或某一个歌单。 */
export function renderDetail(box, arg, api) {
    box.replaceChildren();
    const list = library.getList(arg);
    let title, tracks, subOf = null;
    if (arg === 'fav') { title = '收藏'; tracks = library.tracksOf(library.lib().fav); }
    else if (arg === 'recent') { title = '最近播放'; tracks = library.tracksOf(library.lib().recent); }
    else if (arg === 'rank') {
        const rank = library.ranking();
        title = '播放排行';
        tracks = rank.map((x) => x.track);
        const counts = new Map(rank.map((x) => [x.track.key, x.n]));
        subOf = (t) => `${t.artist} · ${counts.get(t.key)} 次`;
    } else if (list) { title = list.name; tracks = library.tracksOf(list.keys); }
    else { api.go('my'); return; }

    const bar = h('div', 'stm-sec-bar');
    const playAll = iconButton('fa-play', '播放全部', 'stm-small');
    playAll.disabled = !tracks.length;
    playAll.addEventListener('click', () => { player.playAll(tracks, 0); api.go('now'); });
    bar.append(h('div', 'stm-sec-title', `${title}（${tracks.length}）`));
    if (list) {
        const rename = iconButton('fa-pen', '重命名', 'stm-small');
        rename.addEventListener('click', async () => {
            const name = await askName('歌单名称', list.name);
            if (name) library.renameList(list.id, name);
        });
        const del = iconButton('fa-trash-can', '删除歌单', 'stm-small');
        del.addEventListener('click', async () => {
            const c = ctx();
            let yes = true;
            try { if (typeof c.callGenericPopup === 'function') yes = !!(await c.callGenericPopup(`删除歌单「${list.name}」？歌单内的歌曲不会从收藏中移除。`, (c.POPUP_TYPE && c.POPUP_TYPE.CONFIRM) || 2)); } catch (e) { yes = window.confirm(`删除歌单「${list.name}」？`); }
            if (yes) { library.deleteList(list.id); api.go('my'); }
        });
        bar.append(rename, del);
    }
    bar.appendChild(playAll);

    const rows = h('div', 'stm-list');
    if (!tracks.length) hint(rows, arg === 'fav' ? '尚无收藏。在播放页点击歌名右侧的心形图标收藏。' : arg === 'recent' || arg === 'rank' ? '尚无播放记录。' : '歌单为空。可在搜索结果或播放列表中将歌曲加入歌单。');
    tracks.forEach((track, i) => {
        const actions = [];
        if (arg === 'fav') {
            const un = iconButton('fa-heart', '取消收藏');
            un.classList.add('stm-on');
            un.addEventListener('click', () => library.toggleFav(track));
            actions.push(un);
        } else if (list) {
            const rm = iconButton('fa-xmark', '移出歌单');
            rm.addEventListener('click', () => library.removeFromList(list.id, track.key));
            actions.push(rm);
        } else {
            const add = iconButton('fa-folder-plus', '加入歌单');
            add.addEventListener('click', () => api.openAddTo(track));
            actions.push(add);
        }
        const { row, main } = songRow(subOf ? { ...track, artist: subOf(track) } : track, i, actions);
        main.addEventListener('click', () => { player.playAll(tracks, i); api.go('now'); });
        rows.appendChild(row);
    });
    box.append(bar, rows);
}

/** 导入歌单：粘贴网易云歌单链接或编号，或每行一首的文本清单。 */
function openImport(api) {
    api.openSheet('import', '导入歌单', (body) => {
        const form = h('div', 'stm-import');
        const input = h('textarea', 'stm-input stm-textarea');
        input.rows = 5;
        input.placeholder = '网易云歌单的分享文字、链接或编号；或每行一首：歌名 - 歌手';
        const name = h('input', 'stm-input');
        name.type = 'text';
        name.placeholder = '歌单名称（可留空）';
        const status = h('div', 'stm-set-desc', '歌单数据仅保存在本地。读取网易云歌单时只向接口发送歌单编号。');
        const run = h('button', 'stm-text-btn stm-press', '导入');
        run.type = 'button';
        run.addEventListener('click', async () => {
            const text = input.value.trim();
            if (!text) { status.textContent = '请先粘贴内容。'; return; }
            run.disabled = true;
            const PRIVATE = '读取失败。该歌单可能在网易云中设为隐私，公共接口无法读取隐私歌单；可在网易云中将其改为公开后重试，或改用文本清单导入。';
            try {
                const parsed = library.parsePlaylistInput(text);
                let id = parsed && parsed.id;
                if (parsed && parsed.short) {
                    status.textContent = '正在解析短链接';
                    try { id = await library.resolveShort(parsed.short); } catch (e) { id = undefined; }
                    if (id === undefined) status.textContent = '短链接解析失败。请在浏览器中打开该链接，复制地址栏中的完整地址后粘贴。';
                    else if (!id) status.textContent = PRIVATE;
                }
                if (id) {
                    status.textContent = '正在读取歌单';
                    try {
                        const out = await library.importPlaylist(id, name.value);
                        api.closeSheet();
                        notify(`已导入 ${out.count} 首：${out.list.name}`);
                    } catch (e) {
                        status.textContent = PRIVATE;
                    }
                } else if (!parsed) {
                    const out = await library.importText(text, name.value, (done, total) => { status.textContent = `正在匹配 ${done} / ${total}`; });
                    if (!out.list) { status.textContent = '没有匹配到任何歌曲。'; }
                    else if (out.missed.length) { status.textContent = `已导入 ${out.count} 首。未匹配：${out.missed.join('、')}`; }
                    else { api.closeSheet(); notify(`已导入 ${out.count} 首：${out.list.name}`); }
                }
            } catch (e) {
                status.textContent = e && e.message === 'empty' ? '歌单为空，或该歌单不公开。' : '读取失败，接口暂时不可用。';
            }
            run.disabled = false;
        });
        form.append(input, name, status, run);
        body.appendChild(form);
    });
}
