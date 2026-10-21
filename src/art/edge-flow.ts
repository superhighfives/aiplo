import type { Pt } from '../geom';
import { imageParams, loadDarkness } from '../lib/image';
import { jitteredGrid, streamlines } from '../lib/streamlines';
import { shuffle } from '../random';
import { defineArtwork } from './types';

/** Separable Gaussian blur of a w×h raster, in place. */
function blur(a: Float32Array, w: number, h: number, sigma: number) {
  if (sigma < 0.3) return;
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const tmp = new Float32Array(Math.max(w, h));
  const pass = (n: number, count: number, idx: (line: number, i: number) => number) => {
    for (let line = 0; line < count; line++) {
      for (let i = 0; i < n; i++) {
        let s = 0, sw = 0;
        for (let j = -r; j <= r; j++) {
          const q = i + j;
          if (q < 0 || q >= n) continue;
          s += a[idx(line, q)] * k[j + r];
          sw += k[j + r];
        }
        tmp[i] = s / sw;
      }
      for (let i = 0; i < n; i++) a[idx(line, i)] = tmp[i];
    }
  };
  pass(w, h, (y, x) => y * w + x);
  pass(h, w, (x, y) => y * w + x);
}

export default defineArtwork({
  slug: 'edge-flow',
  title: 'Edge flow',
  description: 'Streamlines that run along the edges and contours of a photo, packed tighter where it is dark.',
  order: 54,
  paper: { paper: 'a4', orientation: 'portrait', margin: 20 },
  params: [
    ...imageParams(),
    { type: 'number', key: 'dmin', label: 'Spacing, dark (mm)', min: 0.4, max: 5, step: 0.05, default: 0.8 },
    { type: 'number', key: 'dmax', label: 'Spacing, light (mm)', min: 0.5, max: 15, step: 0.1, default: 4 },
    { type: 'number', key: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.05, default: 1 },
    { type: 'number', key: 'blur', label: 'Blur (mm)', min: 0, max: 10, step: 0.1, default: 1.5, hint: 'Smooths the image before finding its edges' },
    { type: 'number', key: 'smooth', label: 'Flow smoothing (mm)', min: 0, max: 15, step: 0.5, default: 3, hint: 'Averages the edge direction over this distance, so lines curve gracefully' },
    { type: 'number', key: 'flat', label: 'Flat areas', min: 0, max: 1, step: 0.01, default: 0.08, hint: 'Where edges are weaker than this, lines drift toward the fallback direction' },
    { type: 'number', key: 'fallback', label: 'Fallback angle (°)', min: 0, max: 179, step: 1, default: 90 },
    { type: 'number', key: 'blank', label: 'Blank below', min: 0, max: 0.5, step: 0.01, default: 0.05, hint: 'Darkness below this is left as empty paper' },
    { type: 'number', key: 'maxLen', label: 'Max line length (mm)', min: 5, max: 400, step: 5, default: 120 },
    { type: 'number', key: 'minLen', label: 'Min line length (mm)', min: 0, max: 30, step: 0.5, default: 3 },
    { type: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const dark = await loadDarkness(v, W, H, ctx.status);
    const dmin = Math.min(v.dmin, v.dmax), dmax = Math.max(v.dmin, v.dmax);

    // Raster the image at ~0.5 mm, blur it, and build a smoothed structure tensor.
    const res = Math.max(0.35, Math.min(dmin, 0.5));
    const w = Math.ceil(W / res) + 1, h = Math.ceil(H / res) + 1;
    const D = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) D[j * w + i] = dark(Math.min(W, i * res), Math.min(H, j * res));
    const B = D.slice();
    blur(B, w, h, v.blur / res);
    const jxx = new Float32Array(w * h), jxy = new Float32Array(w * h), jyy = new Float32Array(w * h);
    const mags: number[] = [];
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const gx = (B[j * w + Math.min(w - 1, i + 1)] - B[j * w + Math.max(0, i - 1)]) / 2;
        const gy = (B[Math.min(h - 1, j + 1) * w + i] - B[Math.max(0, j - 1) * w + i]) / 2;
        const k = j * w + i;
        jxx[k] = gx * gx;
        jxy[k] = gx * gy;
        jyy[k] = gy * gy;
        if ((i + j) % 7 === 0) mags.push(gx * gx + gy * gy);
      }
    blur(jxx, w, h, v.smooth / res);
    blur(jxy, w, h, v.smooth / res);
    blur(jyy, w, h, v.smooth / res);
    // Fallback: a weak tensor whose edges run along the fallback angle, scaled to the image's typical edge strength.
    mags.sort((a, b) => a - b);
    const typical = mags[Math.floor(mags.length * 0.9)] || 1e-6;
    const eps = v.flat * typical + 1e-9;
    const fa = (v.fallback * Math.PI) / 180;
    const fnx = -Math.sin(fa), fny = Math.cos(fa); // gradient normal to the fallback direction
    const fxx = eps * fnx * fnx, fxy = eps * fnx * fny, fyy = eps * fny * fny;

    const bilerp = (a: Float32Array, x: number, y: number) => {
      const fx = Math.max(0, Math.min(w - 1.001, x / res)), fy = Math.max(0, Math.min(h - 1.001, y / res));
      const i = Math.floor(fx), j = Math.floor(fy);
      const tx = fx - i, ty = fy - j, k = j * w + i;
      return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + w] * (1 - tx) + a[k + w + 1] * tx) * ty;
    };
    const tone = (x: number, y: number) => Math.pow(Math.max(0, Math.min(1, bilerp(D, x, y))), v.gamma);

    // Orientation field (doubled-angle), turned into a direction that stays consistent
    // along each traced line: flip to agree with the previous call when it was close by.
    let px = NaN, py = NaN, pdx = 0, pdy = 0;
    const near = 1;
    const field = (x: number, y: number): Pt | null => {
      if (tone(x, y) < v.blank) return null;
      const a = bilerp(jxx, x, y) + fxx, b = bilerp(jxy, x, y) + fxy, c = bilerp(jyy, x, y) + fyy;
      // Dominant gradient angle, then the tangent is perpendicular to it.
      const phi = 0.5 * Math.atan2(2 * b, a - c) + Math.PI / 2;
      let dx = Math.cos(phi), dy = Math.sin(phi);
      if ((x - px) ** 2 + (y - py) ** 2 < near * near && dx * pdx + dy * pdy < 0) {
        dx = -dx;
        dy = -dy;
      }
      px = x; py = y; pdx = dx; pdy = dy;
      return [dx, dy];
    };

    ctx.status('Tracing…');
    const seeds = shuffle(jitteredGrid(W, H, dmin * 1.5, ctx.rng), ctx.rng);
    const step = Math.min(0.4, dmin / 2);
    return streamlines({
      width: W,
      height: H,
      field,
      seeds,
      dsep: dmax,
      dtest: dmax * 0.5,
      // Line density (1 / spacing) is linear in darkness, so tone reads true.
      sep: (x, y) => {
        const t = tone(x, y);
        return 1 / (t / dmin + (1 - t) / dmax);
      },
      step,
      maxLen: v.maxLen,
      minLen: v.minLen,
      bidirectional: true,
    });
  },
});
