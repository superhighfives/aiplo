import type { Polyline, Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { FONT_OPTIONS, text } from '../lib/hershey';
import { imageSampler, loadGray, type Gray } from '../lib/image';
import { jitteredGrid, streamlines } from '../lib/streamlines';
import { mulberry32, noise2DFrom, seedFromText, shuffle, type Rng } from '../random';
import { defineArtwork } from './types';

// ---------------------------------------------------------------- shared maths

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

/**
 * Turns an orientation field (angle mod π) into a direction field for `streamlines`, flipping
 * each answer to agree with the previous call when it was close by, so a traced line never
 * reverses on itself.
 */
function directed(angle: (x: number, y: number) => number | null, near: number) {
  let px = NaN, py = NaN, pdx = 0, pdy = 0;
  return (x: number, y: number): Pt | null => {
    const a = angle(x, y);
    if (a === null) return null;
    let dx = Math.cos(a), dy = Math.sin(a);
    if ((x - px) ** 2 + (y - py) ** 2 < near * near && dx * pdx + dy * pdy < 0) {
      dx = -dx;
      dy = -dy;
    }
    px = x; py = y; pdx = dx; pdy = dy;
    return [dx, dy];
  };
}

/** Seeds spread over the area, ordered outward from a point so lines grow out from the centre. */
function seedsFrom(W: number, H: number, spacing: number, centre: Pt, rng: Rng): Pt[] {
  const pts = shuffle(jitteredGrid(W, H, spacing, rng), rng);
  const d = (p: Pt) => Math.hypot(p[0] - centre[0], p[1] - centre[1]) + rng() * spacing * 3;
  return pts.map((p) => [p, d(p)] as const).sort((a, b) => a[1] - b[1]).map(([p]) => p);
}

// ---------------------------------------------------------------- synthetic prints

export type PrintType = 'loop' | 'whorl' | 'arch' | 'tented';

interface Singular { x: number; y: number }

/**
 * A plausible fingerprint orientation field in "print units" (the print is about 1 tall, centred
 * on 0, y down), after Sherlock & Monro's zero-pole model: θ = θ∞ + ½ (Σ arg(z − core) − Σ arg(z − delta)) in y-down coordinates.
 * Plain arches have no singular points; they use ridges that hump over the middle instead.
 */
export function printField(type: PrintType, rng: Rng, seed: number) {
  const j = (s: number) => (rng() - 0.5) * s;
  const lean = (rng() < 0.5 ? -1 : 1) * (0.06 + rng() * 0.08); // which way the loop leans (left or right hand)
  let cores: Singular[] = [], deltas: Singular[] = [];
  if (type === 'loop') {
    const side = lean > 0 ? 1 : -1;
    cores = [{ x: -side * 0.03 + j(0.05), y: -0.04 + j(0.05) }];
    deltas = [{ x: side * (0.24 + j(0.05)), y: 0.12 + j(0.06) }];
  } else if (type === 'whorl') {
    const c = { x: j(0.05), y: -0.02 + j(0.05) };
    const tw = 0.025 + rng() * 0.03, ta = rng() * Math.PI;
    cores = [{ x: c.x + Math.cos(ta) * tw, y: c.y + Math.sin(ta) * tw }, { x: c.x - Math.cos(ta) * tw, y: c.y - Math.sin(ta) * tw }];
    deltas = [{ x: -0.24 + j(0.06), y: 0.24 + j(0.05) }, { x: 0.24 + j(0.06), y: 0.24 + j(0.05) }];
  } else if (type === 'tented') {
    cores = [{ x: j(0.04), y: 0.0 + j(0.04) }];
    deltas = [{ x: cores[0].x + j(0.03), y: cores[0].y + 0.1 + rng() * 0.04 }];
  }
  const noise = noise2DFrom(seed);
  const wobble = 0.1 + rng() * 0.08;
  const archA = 0.3 + rng() * 0.12, archS = 0.2 + rng() * 0.06, archY = -0.1 + j(0.08);
  const reach = 0.26 + rng() * 0.08; // how far the singular points' influence spreads
  const bgB = 1.1 + rng() * 0.6, bgY = 0.12 + j(0.08); // background arches: curvature, and where they flatten out
  return (x: number, y: number): number => {
    const n = wobble * (noise(x * 2.2, y * 2.2) + 0.5 * noise(x * 5 + 9, y * 5 - 3));
    if (type === 'arch') {
      // Ridges are level sets of φ = y + A·exp(−x²/2s²)·w(y): humped in the middle, flat below.
      const w = Math.exp(-((y - archY) ** 2) / 0.12);
      const g = Math.exp(-(x * x) / (2 * archS * archS));
      const fx = archA * w * g * (-x / (archS * archS)) + lean * 0.15 * w;
      const fy = 1 + archA * g * w * (-2 * (y - archY) / 0.12);
      return Math.atan2(-fx, fy) + n; // perpendicular to ∇φ
    }
    // Zero-pole model near the singular points…
    let a = 0;
    // (Signs are flipped from the y-up formula because y points down here.)
    for (const c of cores) a += Math.atan2(y - c.y, x - c.x);
    for (const d of deltas) a -= Math.atan2(y - d.y, x - d.x);
    const sm = 0.5 * a + lean * 0.5;
    // …blended (as doubled angles) into arches that follow the fingertip further out, which the
    // plain model gets wrong (its far field is tilted).
    let dmin = Infinity;
    for (const p of [...cores, ...deltas]) dmin = Math.min(dmin, Math.hypot(x - p.x, y - p.y));
    const w = Math.exp(-((dmin / reach) ** 2));
    const sy = 1 / (1 + Math.exp((y - bgY) / 0.08));
    const bg = Math.atan2(-(2 * bgB * x * sy), 1 - bgB * x * x * sy * (1 - sy) / 0.08) + lean * 0.3 * (1 - sy);
    const cx2 = w * Math.cos(2 * sm) + (1 - w) * Math.cos(2 * bg);
    const sy2 = w * Math.sin(2 * sm) + (1 - w) * Math.sin(2 * bg);
    return 0.5 * Math.atan2(sy2, cx2) + n;
  };
}

/** Inside the print's outline: an egg-shaped oval, flatter at the bottom, with a slightly ragged edge. */
export function printMask(cx: number, cy: number, a: number, b: number, seed: number) {
  const noise = noise2DFrom(seed ^ 0x2545f491);
  return (x: number, y: number) => {
    const u = (x - cx) / a, v = (y - cy) / b;
    // Wider below the middle, rounder on top; the bottom is cut by a gentle crease.
    const widen = 1 + 0.1 * Math.max(-1, Math.min(1, v));
    const r = Math.hypot(u / widen, v);
    const edge = 1 + 0.025 * noise(Math.atan2(v, u) * 3, 0.5) + 0.015 * noise(x * 0.3, y * 0.3);
    return r < edge && v < 0.86 + 0.03 * noise(u * 4, 7);
  };
}

/** Synthetic fingerprint ridges for the drawing area: field, mask and streamlines. */
export function syntheticPrint(W: number, H: number, o: { type: PrintType; seed: number; ridges: number; minLen: number }) {
  const rng = mulberry32(o.seed);
  const field = printField(o.type, rng, o.seed);
  const b = Math.min(H / 2, (W / 2) / 0.72) * 0.98;
  const a = b * 0.72;
  const cx = W / 2, cy = H / 2 + b * 0.06; // the bottom is cut flat, so sit a little low
  const inside = printMask(cx, cy, a, b, o.seed);
  const spacing = (2 * b) / o.ridges;
  const angle = (x: number, y: number) => (inside(x, y) ? field((x - cx) / (2 * b), (y - cy) / (2 * b)) : null);
  const lines = streamlines({
    width: W, height: H,
    field: directed(angle, spacing),
    seeds: seedsFrom(W, H, spacing * 0.7, [cx, cy - b * 0.1], rng),
    dsep: spacing,
    dtest: spacing * 0.55,
    step: Math.min(0.5, spacing / 4),
    maxLen: 4 * (a + b) * 2,
    minLen: o.minLen * spacing,
    bidirectional: true,
  });
  return { lines, spacing, oval: { cx, cy, a, b } };
}

// ---------------------------------------------------------------- photos

/** Ridge flow of a fingerprint photo: smoothed structure-tensor orientation, streamlines at ridge spacing. */
export function photoRidges(g: Gray, W: number, H: number, o: { fit: 'cover' | 'contain'; invert: boolean; spacing: number; minLen: number; threshold: number; seed: number }) {
  const sample = imageSampler(g, W, H, o.fit);
  // Raster fine enough to resolve ridges: ~4 samples per image pixel at most, ≤ 0.35 mm.
  const pxPerMm = o.fit === 'cover' ? Math.min(g.w / W, g.h / H) : Math.max(g.w / W, g.h / H);
  const res = Math.max(0.12, Math.min(0.35, 1 / pxPerMm));
  const w = Math.ceil(W / res) + 1, h = Math.ceil(H / res) + 1;
  const D = new Float32Array(w * h);
  for (let jy = 0; jy < h; jy++) for (let ix = 0; ix < w; ix++) {
    const b = sample(Math.min(W, ix * res), Math.min(H, jy * res));
    D[jy * w + ix] = o.invert ? b : 1 - b;
  }
  // Lightly smoothed image for gradients; a broad blur for the local mean (to measure ridge contrast).
  const S = D.slice();
  blur(S, w, h, 0.25 / res);
  const M = D.slice();
  blur(M, w, h, 3 / res);
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let jy = 0; jy < h; jy++) for (let ix = 0; ix < w; ix++) {
    const k = jy * w + ix;
    gx[k] = (S[jy * w + Math.min(w - 1, ix + 1)] - S[jy * w + Math.max(0, ix - 1)]) / (2 * res);
    gy[k] = (S[Math.min(h - 1, jy + 1) * w + ix] - S[Math.max(0, jy - 1) * w + ix]) / (2 * res);
  }
  // Ridge energy (gradient² averaged) marks where the print is.
  const E = new Float32Array(w * h);
  for (let k = 0; k < E.length; k++) E[k] = gx[k] * gx[k] + gy[k] * gy[k];
  blur(E, w, h, 2 / res);
  const sorted = Array.from(E).filter((_, k) => k % 5 === 0).sort((x, y) => x - y);
  const e90 = sorted[Math.floor(sorted.length * 0.9)] || 1e-9;
  const inPrint = (k: number) => E[k] > o.threshold * e90;

  // Ridge period from the image: for a sinusoid of period T, T = 2π·sqrt(var / mean |∇|²).
  let spacing = o.spacing;
  if (!(spacing > 0)) {
    let v = 0, gg = 0, n = 0;
    for (let k = 0; k < D.length; k += 3) {
      if (!inPrint(k)) continue;
      const d = S[k] - M[k];
      v += d * d;
      gg += gx[k] * gx[k] + gy[k] * gy[k];
      n++;
    }
    spacing = n && gg > 0 ? 2 * Math.PI * Math.sqrt(v / gg) : 2;
    spacing = Math.max(0.6, Math.min(8, spacing));
  }
  // Structure tensor smoothed over about a ridge and a half.
  const jxx = new Float32Array(w * h), jxy = new Float32Array(w * h), jyy = new Float32Array(w * h);
  for (let k = 0; k < D.length; k++) { jxx[k] = gx[k] * gx[k]; jxy[k] = gx[k] * gy[k]; jyy[k] = gy[k] * gy[k]; }
  const sig = (spacing * 1.5) / res;
  blur(jxx, w, h, sig); blur(jxy, w, h, sig); blur(jyy, w, h, sig);
  const at = (a: Float32Array, x: number, y: number) => {
    const fx = Math.max(0, Math.min(w - 1.001, x / res)), fy = Math.max(0, Math.min(h - 1.001, y / res));
    const i = Math.floor(fx), jj = Math.floor(fy), tx = fx - i, ty = fy - jj, k = jj * w + i;
    return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + w] * (1 - tx) + a[k + w + 1] * tx) * ty;
  };
  const angle = (x: number, y: number) => {
    if (!inPrint(Math.round(y / res) * w + Math.round(x / res))) return null;
    const a = at(jxx, x, y), b = at(jxy, x, y), c = at(jyy, x, y);
    return 0.5 * Math.atan2(2 * b, a - c) + Math.PI / 2; // ridges run across the gradient
  };
  // Centre of the print (energy-weighted) to grow lines outward from.
  let sx = 0, sy = 0, sw = 0;
  for (let jy = 0; jy < h; jy += 2) for (let ix = 0; ix < w; ix += 2) {
    const k = jy * w + ix;
    if (inPrint(k)) { sx += ix * res; sy += jy * res; sw++; }
  }
  const centre: Pt = sw ? [sx / sw, sy / sw] : [W / 2, H / 2];
  const rng = mulberry32(o.seed);
  const lines = streamlines({
    width: W, height: H,
    field: directed(angle, spacing),
    seeds: seedsFrom(W, H, spacing * 0.7, centre, rng),
    dsep: spacing,
    dtest: spacing * 0.55,
    step: Math.min(0.4, spacing / 4),
    maxLen: 2 * (W + H),
    minLen: o.minLen * spacing,
    bidirectional: true,
  });
  return { lines, spacing, coverage: sw / Math.ceil(h / 2) / Math.ceil(w / 2) };
}

/** A synthetic print rendered as a greyscale "photo" (dark ridges on white): the photo mode's demo. */
export function demoPrintGray(seed: number, w = 360, h = 460): Gray {
  const W = w / 2, H = h / 2; // render in mm at 2 px/mm
  const { lines, spacing } = syntheticPrint(W, H, { type: 'loop', seed, ridges: 50, minLen: 2 });
  const data = new Float32Array(w * h).fill(1);
  const r = spacing * 0.3 * 2; // ridge half-width in px
  for (const l of lines)
    for (let i = 1; i < l.length; i++) {
      const [ax, ay] = l[i - 1], [bx, by] = l[i];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 4) + 1;
      for (let s = 0; s <= n; s++) {
        const x = (ax + ((bx - ax) * s) / n) * 2, y = (ay + ((by - ay) * s) / n) * 2;
        for (let yy = Math.floor(y - r - 1); yy <= Math.ceil(y + r + 1); yy++)
          for (let xx = Math.floor(x - r - 1); xx <= Math.ceil(x + r + 1); xx++) {
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const d = Math.hypot(xx - x, yy - y);
            const ink = Math.max(0, Math.min(1, r + 0.5 - d));
            const k = yy * w + xx;
            data[k] = Math.min(data[k], 1 - 0.85 * ink);
          }
      }
    }
  return { w, h, data };
}

// ---------------------------------------------------------------- the piece

export default defineArtwork({
  slug: 'fingerprint',
  title: 'Fingerprint',
  description: 'A fingerprint as flowing ridge lines: traced from a photo of your own, or grown from a name with a loop, whorl or arch.',
  order: 106,
  series: 'Words and hands',
  paper: { paper: 'a4', orientation: 'portrait', margin: 25 },
  params: [
    { type: 'select', key: 'mode', label: 'Source', options: [['synthetic', 'Grown from a name'], ['photo', 'Photo of a fingerprint']], default: 'synthetic' },
    { type: 'text', key: 'name', label: 'Name', default: 'Alan Turing', show: (v) => v.mode === 'synthetic', hint: 'Seeds the print: the same name always gives the same fingerprint' },
    { type: 'select', key: 'type', label: 'Pattern', options: [['auto', 'From the name'], ['loop', 'Loop'], ['whorl', 'Whorl'], ['arch', 'Arch'], ['tented', 'Tented arch']], default: 'auto', show: (v) => v.mode === 'synthetic' },
    { type: 'number', key: 'ridges', label: 'Ridges (top to bottom)', min: 20, max: 120, step: 1, default: 72, show: (v) => v.mode === 'synthetic', hint: 'How many ridges span the print: fewer = bolder' },
    { type: 'file', key: 'photo', label: 'Fingerprint photo', accept: 'image/*', default: [], show: (v) => v.mode === 'photo', hint: 'A sharp, well-lit close-up (or an ink print). Without one, a synthetic print image is used' },
    { type: 'select', key: 'fit', label: 'Fit', options: [['contain', 'Fit inside'], ['cover', 'Fill (crop)']], default: 'contain', show: (v) => v.mode === 'photo' },
    { type: 'checkbox', key: 'invert', label: 'Ridges are light', default: false, show: (v) => v.mode === 'photo', hint: 'Tick for photos where ridges are brighter than the valleys' },
    { type: 'number', key: 'spacing', label: 'Ridge spacing (mm)', min: 0, max: 8, step: 0.1, default: 0, show: (v) => v.mode === 'photo', hint: '0 = measure it from the photo' },
    { type: 'number', key: 'threshold', label: 'Print edge', min: 0.02, max: 0.8, step: 0.01, default: 0.15, show: (v) => v.mode === 'photo', hint: 'Where ridge contrast falls below this (relative), the print ends' },
    { type: 'number', key: 'minLen', label: 'Shortest ridge (× spacing)', min: 0, max: 10, step: 0.5, default: 1.5, hint: 'Drop fragments shorter than this' },
    { type: 'checkbox', key: 'letter', label: 'Letter the name beneath', default: false, show: (v) => v.mode === 'synthetic' },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural', show: (v) => v.mode === 'synthetic' && v.letter },
    { type: 'select', key: 'pen', label: 'Pen', options: [['0', 'Ink'], ['1', 'Red'], ['2', 'Teal'], ['5', 'Purple']], default: '0' },
  ],
  caption: (v) => (v.mode === 'synthetic' ? v.name : ''),
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const color = PALETTE[Number(v.pen)] ?? PALETTE[0];
    if (v.mode === 'photo') {
      let g = await loadGray(v.photo, 900);
      const demo = !g;
      if (!g) g = demoPrintGray(7);
      ctx.status(demo ? 'No photo loaded: tracing a synthetic print image' : 'Tracing ridge flow…');
      const r = photoRidges(g, W, H, { fit: demo ? 'contain' : v.fit, invert: demo ? false : v.invert, spacing: v.spacing, minLen: v.minLen, threshold: v.threshold, seed: ctx.seed });
      if (!r.lines.length) throw new Error('No ridges found: try a sharper photo, “Ridges are light”, or a lower print edge');
      ctx.status(`${demo ? 'Demo print · ' : ''}ridge spacing ${r.spacing.toFixed(2)} mm${v.spacing > 0 ? '' : ' (measured)'} · ${r.lines.length} ridges · print covers ${Math.round(r.coverage * 100)}%`);
      return [{ name: 'Ridges', color, paths: r.lines }];
    }
    const name = (v.name as string).trim() || 'anonymous';
    const seed = seedFromText(name.toLowerCase().replace(/\s+/g, ' '));
    const types: PrintType[] = ['loop', 'loop', 'loop', 'whorl', 'whorl', 'arch', 'tented']; // roughly their real frequencies
    const type: PrintType = v.type === 'auto' ? types[seed % types.length] : v.type;
    const letterH = v.letter ? 14 : 0;
    const { lines, spacing } = syntheticPrint(W, H - letterH, { type, seed, ridges: v.ridges, minLen: v.minLen });
    const layers: Layer[] = [{ name: 'Ridges', color, paths: lines }];
    if (v.letter) {
      const t: Polyline[] = text(name.normalize('NFD').replace(/[̀-ͯ]/g, ''), { x: W / 2, y: H, size: 5, font: v.font, align: 'center', tracking: 0.12 });
      if (color === PALETTE[0]) layers[0].paths.push(...t);
      else layers.push({ name: 'Lettering', color: PALETTE[0], paths: t });
    }
    const label = { loop: 'Loop', whorl: 'Whorl', arch: 'Plain arch', tented: 'Tented arch' }[type];
    ctx.status(`${label} grown from “${name}” · ${lines.length} ridges · spacing ${spacing.toFixed(2)} mm`);
    return layers;
  },
});
