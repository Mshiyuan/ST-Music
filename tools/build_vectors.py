"""
用 MuQ-MuLan 生成向量库（随剧听的「向量匹配」找歌方式使用）。在电脑上运行一次，生成的文件随扩展发布，运行时不需要模型。

步骤：
1. 读取 vocab.txt 中的描述词（情绪、场景、曲风、乐器等），计算文字向量。
2. 用其中一部分词在网易云搜索歌单，读取歌单中的歌曲（经公共 Meting 接口）。
3. 对能免费播放的歌曲，下载后取中间 30 秒，计算音频向量。不保存音频。
4. 输出 ../vectors/songs.json 与 ../vectors/vocab.json：向量归一化后乘以 127 存为 int8，base64 编码。

用法：python build_vectors.py [歌曲上限，默认 200] [每个词取的歌单数，默认 2]
需要：torch、torchaudio、muq、librosa、requests。模型权重 OpenMuQ/MuQ-MuLan-large 采用 CC-BY-NC 4.0 协议，仅限非商业用途。
"""
import base64
import io
import json
import os
import random
import sys
import time

import numpy as np
import requests
import torch
import librosa
from muq import MuQMuLan

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'vectors')
METING = 'https://api.i-meto.com/meting/api'
SR = 24000
CLIP = 30
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'}

limit = int(sys.argv[1]) if len(sys.argv) > 1 else 200
per_word = int(sys.argv[2]) if len(sys.argv) > 2 else 2


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def quantize(m):
    m = m / np.linalg.norm(m, axis=1, keepdims=True)
    return base64.b64encode(np.clip(np.round(m * 127), -127, 127).astype(np.int8).tobytes()).decode('ascii')


def search_playlists(word, n):
    url = 'https://music.163.com/api/cloudsearch/pc'
    r = requests.get(url, params={'s': word, 'type': 1000, 'limit': n, 'offset': 0}, headers=UA, timeout=20)
    return [str(p['id']) for p in (r.json().get('result') or {}).get('playlists', []) if p.get('trackCount', 0) >= 10][:n]


def playlist_tracks(pid):
    r = requests.get(METING, params={'server': 'netease', 'type': 'playlist', 'id': pid}, headers=UA, timeout=30)
    out = []
    for s in r.json():
        url = s.get('url') or ''
        sid = url.split('id=')[1].split('&')[0] if 'id=' in url else None
        if not sid:
            continue
        https = lambda u: u.replace('http://', 'https://') if isinstance(u, str) else u
        out.append({
            'key': 'netease:' + sid, 'platform': 'netease', 'id': sid,
            'title': s.get('title') or s.get('name') or '', 'artist': s.get('author') or s.get('artist') or '',
            'cover': https(s.get('pic')), 'urls': [https(url), f'https://music.163.com/song/media/outer/url?id={sid}.mp3'], 'lrcUrl': https(s.get('lrc')),
        })
    return out


def load_clip(track):
    """下载音频并取中间 30 秒；不能免费播放（跳转到错误页或不是音频）时返回 None。"""
    for u in track['urls']:
        try:
            r = requests.get(u, headers=UA, timeout=40, allow_redirects=True)
            if r.status_code != 200 or 'audio' not in r.headers.get('content-type', '') and len(r.content) < 200000:
                continue
            y, _ = librosa.load(io.BytesIO(r.content), sr=SR, mono=True)
            if len(y) < SR * 10:
                continue
            mid = len(y) // 2
            half = SR * CLIP // 2
            return y[max(0, mid - half): mid + half]
        except Exception as e:  # noqa: BLE001
            log('  下载或解码失败', track['title'], type(e).__name__)
    return None


def main():
    os.makedirs(OUT, exist_ok=True)
    words = [w.strip() for w in open(os.path.join(HERE, 'vocab.txt'), encoding='utf-8') if w.strip() and not w.startswith('#')]
    log('描述词', len(words))
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    log('加载模型', device)
    t0 = time.time()
    mulan = MuQMuLan.from_pretrained('OpenMuQ/MuQ-MuLan-large').to(device).eval()
    log('模型加载完成', round(time.time() - t0, 1), '秒')

    with torch.no_grad():
        tv = []
        for i in range(0, len(words), 32):
            tv.append(mulan(texts=words[i:i + 32]).cpu().numpy())
        text_vecs = np.concatenate(tv)
    json.dump({'model': 'MuQ-MuLan-large', 'dim': int(text_vecs.shape[1]), 'words': words, 'vecs': quantize(text_vecs)},
              open(os.path.join(OUT, 'vocab.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    log('文字向量完成', text_vecs.shape)

    # 收集候选歌曲
    pool, seen = [], set()
    order = words[:]
    random.seed(1)
    random.shuffle(order)
    for w in order:
        if len(pool) >= limit * 3:
            break
        try:
            for pid in search_playlists(w, per_word):
                for t in playlist_tracks(pid):
                    if t['key'] not in seen:
                        seen.add(t['key'])
                        pool.append(t)
        except Exception as e:  # noqa: BLE001
            log('  歌单读取失败', w, type(e).__name__)
    random.shuffle(pool)
    log('候选歌曲', len(pool))

    songs, vecs, times = [], [], []
    for t in pool:
        if len(songs) >= limit:
            break
        clip = load_clip(t)
        if clip is None:
            continue
        s = time.time()
        with torch.no_grad():
            v = mulan(wavs=torch.tensor(clip).unsqueeze(0).to(device)).cpu().numpy()[0]
        times.append(time.time() - s)
        songs.append(t)
        vecs.append(v)
        if len(songs) % 10 == 0:
            log(f'  已处理 {len(songs)} 首，平均每首 {np.mean(times):.1f} 秒')
    song_vecs = np.stack(vecs)
    json.dump({'model': 'MuQ-MuLan-large', 'dim': int(song_vecs.shape[1]), 'songs': songs, 'vecs': quantize(song_vecs)},
              open(os.path.join(OUT, 'songs.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    log('完成', len(songs), '首；每首音频向量平均', round(float(np.mean(times)), 2), '秒')

    # 抽查：几个词各自最相似的 5 首
    sims = (text_vecs / np.linalg.norm(text_vecs, axis=1, keepdims=True)) @ (song_vecs / np.linalg.norm(song_vecs, axis=1, keepdims=True)).T
    for w in ['伤感', '欢快', '钢琴', '摇滚', '安静', '电子']:
        if w in words:
            top = np.argsort(-sims[words.index(w)])[:5]
            log('抽查', w, ' | '.join(f"{songs[j]['title']}-{songs[j]['artist']}" for j in top))


if __name__ == '__main__':
    main()
