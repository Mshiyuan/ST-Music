// 弹簧动画：按质量-刚度-阻尼模型计算位移，按帧采样后交给 Web Animations 播放。
// 动画在合成线程上运行，主线程繁忙时不掉帧。初速度可取手指离开时的速度，松手瞬间速度连续。

/** 页面切换使用的弹簧：质量 1，刚度 220，阻尼 30（阻尼比约 1.01，不越过终点）。 */
export const PAGE_SPRING = { m: 1, k: 220, c: 30 };

const FRAME = 1 / 60;
const MAX_T = 2;

/**
 * 返回弹簧的解析解：f(t) 给出 t 秒时相对终点的位移和速度。
 * x0 为起点相对终点的位移，v0 为初速度（与位移同单位，每秒）。
 */
export function solve(x0, v0, { m, k, c } = PAGE_SPRING) {
    const w = Math.sqrt(k / m);
    const z = c / (2 * Math.sqrt(k * m));
    if (Math.abs(z - 1) < 1e-4) {
        const b = v0 + w * x0;
        return (t) => {
            const e = Math.exp(-w * t);
            return { x: (x0 + b * t) * e, v: (b - w * (x0 + b * t)) * e };
        };
    }
    if (z > 1) {
        const s = w * Math.sqrt(z * z - 1);
        const r1 = -z * w + s, r2 = -z * w - s;
        const a = (v0 - r2 * x0) / (r1 - r2), b = x0 - a;
        return (t) => {
            const e1 = Math.exp(r1 * t), e2 = Math.exp(r2 * t);
            return { x: a * e1 + b * e2, v: a * r1 * e1 + b * r2 * e2 };
        };
    }
    const wd = w * Math.sqrt(1 - z * z);
    const b = (v0 + z * w * x0) / wd;
    return (t) => {
        const e = Math.exp(-z * w * t), cos = Math.cos(wd * t), sin = Math.sin(wd * t);
        const x = e * (x0 * cos + b * sin);
        const v = -z * w * x + e * (-x0 * wd * sin + b * wd * cos);
        return { x, v };
    };
}

/** 越界拖动的阻力：拖得越远，移动的比例越小；最多接近 size。 */
export function rubber(d, size) {
    const s = Math.sign(d);
    return s * (1 - 1 / ((Math.abs(d) * 0.55) / size + 1)) * size;
}

/** 根据最近 100ms 内的指针位置估算速度（像素每秒）。 */
export function velocityTracker() {
    let pts = [];
    return {
        reset(x, t) { pts = [[x, t]]; },
        add(x, t) { pts.push([x, t]); while (pts.length > 2 && t - pts[0][1] > 100) pts.shift(); },
        get() {
            if (pts.length < 2) return 0;
            const [x0, t0] = pts[0], [x1, t1] = pts[pts.length - 1];
            return t1 - t0 > 0 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0;
        },
    };
}

/** 吸附目标：位置和速度以页为单位，目标 = round(位置 + 速度 × 0.15)，限制在 [lo, hi]。 */
export const snapTarget = (pos, vel, lo, hi) => Math.min(hi, Math.max(lo, Math.round(pos + vel * 0.15)));

/** 读取元素当前的横向位移（含正在播放的动画）。 */
export function currentX(el) {
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 0;
    return new DOMMatrixReadOnly(t).m41;
}

/** 位移和速度都小于 rest 时视为停止，返回所需秒数。 */
function settleTime(f, rest) {
    for (let t = FRAME; t < MAX_T; t += FRAME) {
        const { x, v } = f(t);
        if (Math.abs(x) < rest && Math.abs(v) < rest * 10) return t;
    }
    return MAX_T;
}

/**
 * 弹簧动画。
 * from、to：起点和终点（任意单位，例如像素或比例）；v0：初速度（同单位，每秒）；
 * rest：停止阈值（同单位）；targets：[[元素, (位置) => 关键帧对象], ...]。
 * 返回控制对象：value() 当前位置，velocity() 当前速度，cancel() 停止，finished 结束时兑现。
 */
export function animate({ from, to, v0 = 0, rest = 0.5, spring = PAGE_SPRING, targets }) {
    const f = solve(from - to, v0, spring);
    const T = from === to && Math.abs(v0) < rest ? FRAME : settleTime(f, rest);
    const n = Math.max(2, Math.ceil(T / FRAME) + 1);
    const pos = [];
    for (let i = 0; i < n; i++) pos.push(i === n - 1 ? to : to + f((i / (n - 1)) * T).x);
    const anims = targets.map(([el, frame]) => el.animate(pos.map((p) => frame(p)), { duration: T * 1000, easing: 'linear', fill: 'forwards' }));
    const start = performance.now();
    const elapsed = () => Math.min(T, Math.max(0, (performance.now() - start) / 1000));
    let done = false;
    const ctl = {
        anims,
        duration: T,
        value: () => (done || elapsed() >= T ? to : to + f(elapsed()).x),
        velocity: () => (done || elapsed() >= T ? 0 : f(elapsed()).v),
        cancel() { done = true; for (const a of anims) a.cancel(); },
        finished: anims.length ? anims[0].finished.then(() => !done, () => false) : Promise.resolve(true),
    };
    return ctl;
}
