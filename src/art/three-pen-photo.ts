import type { Layer } from '../layers';
import { toneHatch } from '../lib/hatch';
import { imageParams, imageSampler, loadCMY, type Gray } from '../lib/image';
import { defineArtwork } from './types';

type Ink = (x: number, y: number) => number;

const COLORS = { c: '#1f9bd1', m: '#d1307a', y: '#e8c21c', k: '#1c2230' };

/** Procedural stand-in: three translucent lit balls, one per ink, overprinting where they meet. */
function demoCMY(W: number, H: number): [Ink, Ink, Ink] {
  const s = Math.min(W, H);
  const cx = W / 2, cy = H * 0.42, r = 0.3 * s;
  const balls = [
    { x: cx - 0.18 * s, y: cy - 0.12 * s, ch: 0 },
    { x: cx + 0.18 * s, y: cy - 0.12 * s, ch: 1 },
    { x: cx, y: cy + 0.21 * s, ch: 2 },
  ];
  const ink = (x: number, y: number) => {
    const out = [0, 0, 0];
    // One soft shadow on the ground under the group.
    const fx = (x - cx - 0.08 * s) / (0.38 * s), fy = (y - cy - 0.56 * s) / (0.05 * s);
    const sh = 0.55 * Math.exp(-(fx * fx + fy * fy));
    for (let c = 0; c < 3; c++) out[c] += sh;
    for (const b of balls) {
      const sx = (x - b.x) / r, sy = (y - b.y) / r;
      const r2 = sx * sx + sy * sy;
      if (r2 >= 1) continue;
      const z = Math.sqrt(1 - r2);
      const lit = Math.max(0, -0.5 * sx - 0.6 * sy + 0.62 * z);
      const shade = 1 - Math.min(1, lit);
      // The ball's own ink, deeper in shadow, with a little of the others in the core shadow.
      out[b.ch] += 0.4 + 0.55 * shade;
      for (let c = 0; c < 3; c++) if (c !== b.ch) out[c] += 0.3 * shade ** 3;
    }
    return out.map((v) => Math.min(1, v));
  };
  // Cache per-point so three channels don't recompute everything three times.
  let lx = NaN, ly = NaN, lv = [0, 0, 0];
  const at = (x: number, y: number) => {
    if (x !== lx || y !== ly) {
      lv = ink(x, y);
      lx = x;
      ly = y;
    }
    return lv;
  };
  return [(x, y) => at(x, y)[0], (x, y) => at(x, y)[1], (x, y) => at(x, y)[2]];
}

export default defineArtwork({
  slug: 'three-pen-photo',
  title: 'Three-pen photo',
  description: 'A colour photo separated into cyan, magenta and yellow (plus optional black), each hatched at its own angle.',
  order: 53,
  paper: { paper: 'a4', orientation: 'portrait', margin: 20 },
  params: [
    ...imageParams(),
    { type: 'number', key: 'spacing', label: 'Line spacing (mm)', min: 0.5, max: 4, step: 0.05, default: 1, hint: 'Closest spacing, reached at full ink' },
    { type: 'number', key: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.05, default: 1 },
    { type: 'number', key: 'floor', label: 'Cut-off', min: 0, max: 0.5, step: 0.01, default: 0.1, hint: 'Ink below this is left as blank paper (avoids stray long lines in pale areas)' },
    { type: 'number', key: 'limit', label: 'Ink limit', min: 0.5, max: 4, step: 0.05, default: 1.8, hint: 'Caps the total of all inks in one spot, so dark areas don\'t clog with lines' },
    { type: 'checkbox', key: 'useC', label: 'Cyan', default: true },
    { type: 'number', key: 'angleC', label: 'Cyan angle (°)', min: 0, max: 179, step: 1, default: 15, show: (v) => v.useC },
    { type: 'checkbox', key: 'useM', label: 'Magenta', default: true },
    { type: 'number', key: 'angleM', label: 'Magenta angle (°)', min: 0, max: 179, step: 1, default: 75, show: (v) => v.useM },
    { type: 'checkbox', key: 'useY', label: 'Yellow', default: true },
    { type: 'number', key: 'angleY', label: 'Yellow angle (°)', min: 0, max: 179, step: 1, default: 45, show: (v) => v.useY },
    { type: 'checkbox', key: 'useK', label: 'Black (fourth pen)', default: false },
    { type: 'number', key: 'gcr', label: 'Grey replacement', min: 0, max: 1, step: 0.05, default: 0.7, show: (v) => v.useK, hint: 'How much of the shared grey in C, M and Y moves to the black pen' },
    { type: 'number', key: 'angleK', label: 'Black angle (°)', min: 0, max: 179, step: 1, default: 135, show: (v) => v.useK },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const cmy = await loadCMY(v.photo);
    let ch: [Ink, Ink, Ink];
    if (cmy) {
      const exposure = v.exposure ?? 0, contrast = v.contrast ?? 1;
      ch = cmy.map((g) => {
        // Sample as brightness so areas outside a 'contain' fit read as blank paper.
        const bright: Gray = { w: g.w, h: g.h, data: g.data.map((d) => 1 - d) };
        const sample = imageSampler(bright, W, H, v.fit ?? 'cover');
        return (x: number, y: number) => {
          let b = (sample(x, y) - 0.5) * contrast + 0.5 + exposure * 0.5;
          b = Math.max(0, Math.min(1, b));
          return v.invert ? b : 1 - b;
        };
      }) as [Ink, Ink, Ink];
    } else {
      ctx.status('No photo loaded: using the demo image');
      ch = demoCMY(W, H);
    }
    const g = v.gamma;
    const k: Ink = v.useK ? (x, y) => v.gcr * Math.min(ch[0](x, y), ch[1](x, y), ch[2](x, y)) : () => 0;
    const curve = (d: number) => (d <= v.floor ? 0 : Math.pow(Math.min(1, (d - v.floor) / (1 - v.floor)), g));
    // Total ink limit: where the inks together exceed it, scale them all back.
    const limit: Ink = (x, y) => {
      const kk = k(x, y);
      const sum = ch[0](x, y) + ch[1](x, y) + ch[2](x, y) - 3 * kk + kk;
      return sum > v.limit ? v.limit / sum : 1;
    };
    const tone = (f: Ink): Ink => (x, y) => curve((f(x, y) - k(x, y)) * limit(x, y));
    const hatch = (f: Ink, angle: number) => toneHatch(f, W, H, { angle, spacing: v.spacing, step: 0.3, minLength: 0.8 });
    const layers: Layer[] = [];
    // Lightest ink first, so darker pens draw over it.
    if (v.useY) layers.push({ name: 'Yellow', color: COLORS.y, paths: hatch(tone(ch[2]), v.angleY) });
    if (v.useC) layers.push({ name: 'Cyan', color: COLORS.c, paths: hatch(tone(ch[0]), v.angleC) });
    if (v.useM) layers.push({ name: 'Magenta', color: COLORS.m, paths: hatch(tone(ch[1]), v.angleM) });
    if (v.useK) layers.push({ name: 'Black', color: COLORS.k, paths: hatch((x, y) => curve(k(x, y) * limit(x, y)), v.angleK) });
    return layers;
  },
});
