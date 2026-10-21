import { smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import type { Sketch } from '../params';
import { defineArtwork } from './types';

const ASPECT = 2.5;

/** Catmull–Rom through control points. */
function spline(pts: Pt[], per = 10): Polyline {
  const out: Polyline = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** A made-up signature: a looped capital, a run of cursive loops, and an underline flourish. */
function demoSignature(): Sketch {
  // Units: 10 wide, 4 tall, y down, baseline at y = 2.5.
  const capital = spline([
    [0.9, 2.3], [0.35, 1.7], [0.6, 0.6], [1.35, 0.15], [1.75, 0.5], [1.35, 1.5], [0.85, 2.45],
    [0.55, 3.0], [0.9, 3.15], [1.5, 2.7], [1.9, 2.3],
  ]);
  const loops: Polyline = [];
  const heights = [0.85, 0.75, 1.9, 0.8, 0.7, 1.7, 0.65, 0.9];
  let x = 1.95;
  const base = 2.5;
  heights.forEach((h, i) => {
    const s = 0.62 - 0.03 * i; // letters get a little narrower
    // Prolate cycloid: x runs backwards near the top of each stroke, closing a loop there.
    const a = s / (2 * Math.PI);
    const b = a * (h > 1 ? 2.8 : 2.2); // tall letters loop wider
    for (let k = 1; k <= 48; k++) {
      const t = (k / 48) * 2 * Math.PI;
      // Slant: lean right in proportion to height.
      const y = (h * (1 - Math.cos(t))) / 2;
      loops.push([x + a * t + b * Math.sin(t) + y * 0.25, base - y]);
    }
    x += s;
  });
  const tail = spline([
    [x, base], [x + 0.5, 2.45], [x + 1.3, 2.2], [x + 1.1, 2.65], [7.6, 3.25], [5.0, 3.6], [2.4, 3.55], [1.2, 3.35],
  ]);
  const dot = spline([[5.2, 1.3], [5.35, 1.22], [5.5, 1.25]], 4);
  const main = [...capital, ...loops.slice(1), ...tail.slice(1)];
  const k = 1 / 10;
  const norm = (p: Polyline): Polyline => p.map(([px, py]) => [+(px * k).toFixed(4), +(py * k).toFixed(4)]);
  return [norm(smooth(main, 0.06)), norm(dot)];
}

const DEFAULT = demoSignature();

type Xf = (p: Pt) => Pt;
const apply = (paths: Polyline[], f: Xf) => paths.map((p) => p.map(f));

function bounds(paths: Polyline[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const [x, y] of p) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  return { x0, y0, x1, y1, w: x1 - x0 || 1e-6, h: y1 - y0 || 1e-6 };
}

/** Scales and centres `copies` (each a set of paths) as one group into W × H, keeping aspect. */
function fit(copies: Polyline[][], W: number, H: number): Polyline[][] {
  const b = bounds(copies.flat());
  const s = Math.min(W / b.w, H / b.h);
  const ox = (W - b.w * s) / 2 - b.x0 * s, oy = (H - b.h * s) / 2 - b.y0 * s;
  return copies.map((c) => apply(c, ([x, y]) => [x * s + ox, y * s + oy]));
}

export default defineArtwork({
  slug: 'signature',
  title: 'Signature',
  description: 'Your signature, drawn in the browser, then echoed, tiled or spun into a mandala.',
  order: 42,
  paper: { paper: 'square', margin: 20 },
  params: [
    { type: 'sketchpad', key: 'sketch', label: 'Draw', aspect: ASPECT, default: DEFAULT, hint: 'Sign here. Clear it to start over.' },
    { type: 'select', key: 'style', label: 'Style', options: [['single', 'Single'], ['echo', 'Echo'], ['rotational', 'Rotational (mandala)'], ['grid', 'Grid']], default: 'rotational' },
    { type: 'number', key: 'copies', label: 'Copies', min: 2, max: 48, step: 1, default: 12, show: (v) => v.style === 'echo' || v.style === 'rotational' },
    { type: 'number', key: 'dx', label: 'Echo offset x', min: -0.5, max: 0.5, step: 0.005, default: 0.02, show: (v) => v.style === 'echo', hint: 'Per copy, as a fraction of the signature width' },
    { type: 'number', key: 'dy', label: 'Echo offset y', min: -0.5, max: 0.5, step: 0.005, default: 0.045, show: (v) => v.style === 'echo' },
    { type: 'number', key: 'scale', label: 'Echo scale', min: 0.8, max: 1.2, step: 0.005, default: 1, show: (v) => v.style === 'echo', hint: 'Each copy is this much bigger than the last' },
    { type: 'number', key: 'inner', label: 'Inner radius', min: -0.5, max: 1, step: 0.01, default: 0.15, show: (v) => v.style === 'rotational', hint: 'Gap at the centre, as a fraction of the signature width (negative overlaps)' },
    { type: 'checkbox', key: 'mirror', label: 'Mirror alternate copies', default: false, show: (v) => v.style === 'rotational' || v.style === 'grid' },
    { type: 'number', key: 'cols', label: 'Columns', min: 1, max: 12, step: 1, default: 3, show: (v) => v.style === 'grid' },
    { type: 'number', key: 'rows', label: 'Rows', min: 1, max: 20, step: 1, default: 6, show: (v) => v.style === 'grid' },
    { type: 'number', key: 'gap', label: 'Grid gap', min: 0, max: 1, step: 0.01, default: 0.12, show: (v) => v.style === 'grid' },
    { type: 'number', key: 'smooth', label: 'Smoothing (mm)', min: 0, max: 3, step: 0.05, default: 0.3 },
    { type: 'checkbox', key: 'pens', label: 'Alternate pens', default: false, hint: 'Odd copies on a second pen' },
  ],
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const sketch = ((v.sketch as Sketch) ?? []).filter((s) => Array.isArray(s) && s.length > 1);
    if (!sketch.length) return [];
    const sb = bounds(sketch);
    // Signature in its own units: width 1, left-centre at the origin.
    const sig = apply(sketch, ([x, y]) => [(x - sb.x0) / sb.w, (y - (sb.y0 + sb.y1) / 2) / sb.w]);
    const sh = sb.h / sb.w;
    const copies: Polyline[][] = [];
    if (v.style === 'single') copies.push(sig);
    else if (v.style === 'echo') {
      for (let i = 0; i < v.copies; i++) {
        const s = Math.pow(v.scale, i);
        copies.push(apply(sig, ([x, y]) => [x * s + i * v.dx, y * s + i * v.dy]));
      }
    } else if (v.style === 'rotational') {
      for (let i = 0; i < v.copies; i++) {
        const a = (i / v.copies) * 2 * Math.PI - Math.PI / 2;
        const c = Math.cos(a), s = Math.sin(a);
        const flip = v.mirror && i % 2 ? -1 : 1;
        copies.push(apply(sig, ([x, y]) => {
          const px = x + v.inner, py = y * flip;
          return [px * c - py * s, px * s + py * c];
        }));
      }
    } else {
      const cw = 1 + v.gap, ch = sh + v.gap * sh * 2;
      for (let r = 0; r < v.rows; r++)
        for (let q = 0; q < v.cols; q++) {
          const flip = v.mirror && (r + q) % 2 ? -1 : 1;
          copies.push(apply(sig, ([x, y]) => [(flip < 0 ? 1 - x : x) + q * cw, y + r * ch]));
        }
    }
    const placed = fit(copies, W, H).map((c) => (v.smooth > 0 ? c.map((p) => smooth(p, v.smooth)) : c));
    if (!v.pens) return placed.flat();
    const layers: Layer[] = [
      { name: 'Pen 1', color: PALETTE[0], paths: placed.filter((_, i) => i % 2 === 0).flat() },
      { name: 'Pen 2', color: PALETTE[1], paths: placed.filter((_, i) => i % 2 === 1).flat() },
    ];
    return layers;
  },
});
