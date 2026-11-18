// 音频线程播放：把整首歌下载并解码后，用 Web Audio 播放。
// 用途：部分浏览器（如 Via）在后台暂停页面脚本，播放器自带的循环和「播完切下一首」都需要脚本参与，因而中断。
// Web Audio 的播放、循环、以及预先安排好的下一首都在音频线程上进行，不需要脚本参与。
// 对外提供与 HTMLAudioElement 相同的常用接口（src、currentTime、duration、paused、loop、volume、play、pause、load 和事件），
// 播放器可以直接替换使用。另外提供 setNext(url, key)：预先解码下一首，并安排在当前这首结束的同一时刻开始播放。

const TICK = 250;

/** 读取音频数据：先直接请求（Meting 接口和歌曲 CDN 允许跨域）；不允许跨域时经酒馆服务器转发。 */
async function fetchBytes(url) {
    try {
        const res = await fetch(url);
        if (res.ok) return await res.arrayBuffer();
    } catch (e) { /* 改经酒馆服务器转发 */ }
    const c = globalThis.SillyTavern.getContext();
    const res = await fetch('/api/search/visit', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ url, html: false }) });
    if (!res.ok) throw new Error('fetch ' + res.status);
    return res.arrayBuffer();
}

export class BufferPlayer extends EventTarget {
    constructor() {
        super();
        this.ctx = null;
        this.gain = null;
        this._src = '';
        this.buffer = null;
        this.node = null;          // 正在播放的音源
        this.startedAt = 0;        // 当前音源开始时 ctx.currentTime 的值
        this.offset = 0;           // 当前音源从歌曲的第几秒开始
        this.paused = true;
        this.ended = false;
        this.error = null;
        this._loop = false;
        this._volume = 1;
        this.loadToken = 0;
        this.next = null;          // 预先安排的下一首：{ url, key, buffer, node, at }
        this.timer = 0;
        this.cache = new Map();    // url -> 解码后的数据（最多两首）
    }

    _ensureCtx() {
        if (this.ctx) return;
        this.ctx = new AudioContext({ latencyHint: 'playback' });
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this._volume;
        this.gain.connect(this.ctx.destination);
    }

    _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

    async _decode(url) {
        if (this.cache.has(url)) return this.cache.get(url);
        this._ensureCtx();
        const data = await this.ctx.decodeAudioData(await fetchBytes(url));
        this.cache.set(url, data);
        while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
        return data;
    }

    get src() { return this._src; }
    set src(url) {
        this._stopNode();
        this._clearNext();
        this._src = url || '';
        this.buffer = null;
        this.offset = 0;
        this.ended = false;
        this.error = null;
    }
    removeAttribute(name) { if (name === 'src') this.src = ''; }

    /** 开始下载和解码当前地址；完成后发出 canplay，失败发出 error。 */
    load() {
        const url = this._src;
        const token = ++this.loadToken;
        if (!url) return;
        this._decode(url).then((data) => {
            if (token !== this.loadToken) return;
            this.buffer = data;
            this._emit('durationchange');
            this._emit('canplay');
            if (this._wantPlay) this._startNode();
        }, (e) => {
            if (token !== this.loadToken) return;
            this.error = { code: 4, message: String(e && e.message) };
            this._emit('error');
        });
    }

    get duration() { return this.buffer ? this.buffer.duration : NaN; }

    get currentTime() {
        if (!this.buffer) return this.offset;
        if (this.paused || !this.node) return this.offset;
        let t = this.offset + (this.ctx.currentTime - this.startedAt);
        if (this._loop) t %= this.buffer.duration;
        return Math.min(t, this.buffer.duration);
    }
    set currentTime(t) {
        const d = this.buffer ? this.buffer.duration : 0;
        this.offset = Math.max(0, Math.min(d ? d - 0.05 : t, t));
        this.ended = false;
        if (!this.paused && this.buffer) this._startNode();
        this._emit('timeupdate');
    }

    get loop() { return this._loop; }
    set loop(v) {
        this._loop = !!v;
        if (this.node) {
            // 切换循环时以当前位置重新开始，保证位置计算准确
            if (!this.paused) { this.offset = this.currentTime; this._startNode(); }
        }
        if (this._loop) this._clearNext(); else this._scheduleNext();
    }

    get volume() { return this._volume; }
    set volume(v) { this._volume = v; if (this.gain) this.gain.gain.value = v; }

    play() {
        this._ensureCtx();
        this.paused = false;
        this._wantPlay = true;
        const resume = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
        return resume.then(() => {
            if (this.paused) return;
            if (this.ended) { this.offset = 0; this.ended = false; }
            if (this.buffer) this._startNode();
            this._emit('play');
        });
    }

    pause() {
        if (this.paused) return;
        this.offset = this.currentTime;
        this.paused = true;
        this._wantPlay = false;
        this._stopNode();
        this._clearNext(true);
        this._emit('pause');
    }

    _stopNode() {
        clearInterval(this.timer);
        if (this.node) { this.node.onended = null; try { this.node.stop(); } catch (e) { /* 已停止 */ } this.node.disconnect(); }
        this.node = null;
    }

    _startNode() {
        this._stopNode();
        const n = this.ctx.createBufferSource();
        n.buffer = this.buffer;
        n.loop = this._loop;
        n.connect(this.gain);
        this.startedAt = this.ctx.currentTime;
        n.start(this.startedAt, this.offset);
        n.onended = () => this._onNodeEnded(n);
        this.node = n;
        this.timer = setInterval(() => this._emit('timeupdate'), TICK);
        this._emit('playing');
        this._scheduleNext();
    }

    /** 当前音源结束：若已安排下一首，则状态切到下一首（声音已在音频线程上无缝接上），发出 advance；否则发出 ended。 */
    _onNodeEnded(n) {
        if (n !== this.node) return;
        const nx = this.next;
        if (nx && nx.node) {
            this.next = null;
            this.node = nx.node;
            this.buffer = nx.buffer;
            this._src = nx.url;
            this.startedAt = nx.at;
            this.offset = 0;
            nx.node.onended = () => this._onNodeEnded(nx.node);
            this._emit('durationchange');
            this._emit('advance', { key: nx.key, url: nx.url });
            return;
        }
        clearInterval(this.timer);
        this.node = null;
        this.offset = this.buffer ? this.buffer.duration : 0;
        this.ended = true;
        this.paused = true;
        this._emit('pause');
        this._emit('ended');
    }

    /** 预先解码下一首，并安排在当前这首结束的时刻开始。key 为下一首的标识，在 advance 事件中带回。 */
    setNext(url, key) {
        if (this.next && this.next.url === url && this.next.key === key) return;
        this._clearNext();
        if (!url) return;
        const nx = { url, key, buffer: null, node: null, at: 0 };
        this.next = nx;
        this._decode(url).then((data) => {
            if (this.next !== nx) return;
            nx.buffer = data;
            this._scheduleNext();
        }, () => { if (this.next === nx) this.next = null; });
    }

    _scheduleNext() {
        const nx = this.next;
        if (!nx || !nx.buffer || this._loop || this.paused || !this.node || !this.buffer) return;
        if (nx.node) { try { nx.node.stop(); } catch (e) { /* 未开始 */ } nx.node.disconnect(); nx.node = null; }
        const at = this.startedAt + (this.buffer.duration - this.offset);
        if (at <= this.ctx.currentTime) return;
        const n = this.ctx.createBufferSource();
        n.buffer = nx.buffer;
        n.connect(this.gain);
        n.start(at);
        nx.node = n;
        nx.at = at;
    }

    /** keepData 为 true 时保留已解码的数据（暂停后继续播放时可重新安排）。 */
    _clearNext(keepData = false) {
        const nx = this.next;
        if (!nx) return;
        if (nx.node) { nx.node.onended = null; try { nx.node.stop(); } catch (e) { /* 未开始 */ } nx.node.disconnect(); nx.node = null; }
        if (!keepData) this.next = null;
    }
}
