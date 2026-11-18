// 向量匹配：用事先在电脑上用 MuQ-MuLan 算好的向量库，在浏览器里按与标签的相似度给歌曲排序。
// 运行时不需要模型，手机和云酒馆都可以使用。
//
// 向量库文件（由 tools/build_vectors.py 生成，放在扩展目录的 vectors/ 下）：
//   songs.json  { model, dim, songs: [{ key, title, artist, cover, urls, lrcUrl }], vecs: base64 }
//   vocab.json  { model, dim, words: [词], vecs: base64 }
// vecs 为按行排列的 int8 向量（已归一化后乘以 127），行数与 songs / words 相同。

const BASE = new URL('../vectors/', import.meta.url).href;

let loading = null;
let data = null;          // { dim, songs, songVecs: Int8Array, words, wordVecs: Int8Array }

function decode(b64) {
    const bin = atob(b64);
    const out = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
    return out;
}

/** 读取向量库；不存在时返回 null（之后不再重复请求）。 */
export function load() {
    if (!loading) {
        loading = (async () => {
            try {
                const [s, v] = await Promise.all([fetch(BASE + 'songs.json'), fetch(BASE + 'vocab.json')]);
                if (!s.ok || !v.ok) return null;
                const sj = await s.json(), vj = await v.json();
                data = { dim: sj.dim, songs: sj.songs, songVecs: decode(sj.vecs), words: vj.words, wordVecs: decode(vj.vecs) };
                return data;
            } catch (e) {
                return null;
            }
        })();
    }
    return loading;
}

export const available = async () => !!(await load());

/** 标签里的词对应到词表：完全相同优先，其次互相包含。返回词表中的序号。 */
function matchWords(text, words) {
    const parts = String(text || '').split(/[\s,，、;；/|]+/).map((x) => x.trim()).filter(Boolean);
    const hits = new Set();
    for (const p of parts) {
        const exact = words.indexOf(p);
        if (exact >= 0) { hits.add(exact); continue; }
        words.forEach((w, i) => { if (w.length >= 2 && (p.includes(w) || w.includes(p))) hits.add(i); });
    }
    return [...hits];
}

/**
 * 按标签给向量库中的歌排序，返回最相似的至多 limit 首（统一的歌曲格式）。
 * 查询向量为标签中各词对应的词向量的平均。向量库不可用或标签中没有可对应的词时返回 null。
 */
export async function rank(candidates, tags, limit = 40) {
    const d = await load();
    if (!d) return null;
    const text = [...Object.values(tags.dims || {}), ...(tags.search || [])].join(' ');
    const idx = matchWords(text, d.words);
    if (!idx.length) return null;
    const q = new Float32Array(d.dim);
    for (const i of idx) for (let k = 0; k < d.dim; k++) q[k] += d.wordVecs[i * d.dim + k];
    const scores = d.songs.map((s, j) => {
        let dot = 0;
        for (let k = 0; k < d.dim; k++) dot += q[k] * d.songVecs[j * d.dim + k];
        return [dot, j];
    });
    // 候选（本次歌单检索的结果）中已在向量库里的歌略加分，使结果兼顾当前的搜索短语
    const inCands = new Set((candidates || []).map((t) => t.key));
    for (const s of scores) if (inCands.has(d.songs[s[1]].key)) s[0] *= 1.1;
    scores.sort((a, b) => b[0] - a[0]);
    return scores.slice(0, limit).map(([, j]) => ({ ...d.songs[j] }));
}
