import type { Polyline, Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { gcd } from '../lib/gen-util';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'spirograph',
  title: 'Spirograph',
  description: 'Gear-and-pen curves (hypotrochoids and epitrochoids) traced until they close, nested on several pens.',
  order: 61,
  paper: { paper: 'square', margin: 15 },
  params: [
    { type: 'select', key: 'kind', label: 'Wheel', options: [['inside', 'Inside the ring (hypotrochoid)'], ['outside', 'Outside the ring (epitrochoid)']], default: 'inside' },
    { type: 'number', key: 'R', label: 'Ring teeth (R)', min: 10, max: 160, step: 1, default: 96 },
    { type: 'number', key: 'r', label: 'Wheel teeth (r)', min: 3, max: 150, step: 1, default: 52 },
    { type: 'number', key: 'd', label: 'Pen hole', min: 0, max: 1.5, step: 0.01, default: 0.95, hint: 'Distance of the pen from the wheel centre, as a fraction of the wheel radius' },
    { type: 'number', key: 'layers', label: 'Layers', min: 1, max: 8, step: 1, default: 3 },
    { type: 'number', key: 'rotate', label: 'Layer rotation (°)', min: 0, max: 180, step: 0.25, default: 3.75, show: (v) => v.layers > 1, hint: 'Each layer is turned this much more than the last' },
    { type: 'number', key: 'dStep', label: 'Pen hole step', min: -0.5, max: 0.5, step: 0.01, default: -0.25, show: (v) => v.layers > 1, hint: 'Change in pen hole per layer' },
    { type: 'number', key: 'rStep', label: 'Wheel teeth step', min: -30, max: 30, step: 1, default: 0, show: (v) => v.layers > 1, hint: 'Change in wheel size per layer' },
    { type: 'select', key: 'pens', label: 'Pens', options: [['one', 'One pen'], ['cycle', 'One pen per layer']], default: 'cycle', show: (v) => v.layers > 1 },
  ],
  generate(v, ctx) {
    const R = Math.round(v.R);
    const inside = v.kind === 'inside';
    const curves: Polyline[] = [];
    for (let L = 0; L < v.layers; L++) {
      let r = Math.round(v.r + L * v.rStep);
      r = Math.max(2, inside ? Math.min(R - 1, r) : r);
      const d = Math.max(0, v.d + L * v.dStep) * r;
      const g = gcd(R, r);
      const k = inside ? (R - r) / r : (R + r) / r;
      const C = inside ? R - r : R + r;
      // The curve closes after the wheel's centre goes round r/g times.
      const T = (2 * Math.PI * r) / g;
      // Enough points for the faster of the two rotations: ~4 per degree-ish of pen turning,
      // scaled to the curve's size.
      const turns = (r / g) * (1 + Math.abs(k));
      const n = Math.min(400000, Math.ceil(turns * Math.max(90, (C + d) * 0.6)));
      const rot = (L * v.rotate * Math.PI) / 180;
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const line: Polyline = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * T;
        const x = C * Math.cos(t) + (inside ? d : -d) * Math.cos(k * t);
        const y = C * Math.sin(t) - d * Math.sin(k * t);
        line.push([x * cr - y * sr, x * sr + y * cr]);
      }
      curves.push(line);
    }
    // Scale all layers together so the largest just fits, centred.
    let ext = 1e-9;
    for (const c of curves) for (const [x, y] of c) ext = Math.max(ext, Math.hypot(x, y));
    const s = Math.min(ctx.width, ctx.height) / 2 / ext;
    const placed = curves.map((c) => c.map(([x, y]) => [ctx.width / 2 + x * s, ctx.height / 2 + y * s] as Pt));
    if (v.layers === 1 || v.pens === 'one') return placed;
    const colors = [PALETTE[0], PALETTE[1], PALETTE[2], PALETTE[3], PALETTE[5], PALETTE[4]];
    const layers: Layer[] = [];
    placed.forEach((p, i) => {
      const pen = i % colors.length;
      (layers[pen] ??= { name: `Layer ${pen + 1}`, color: colors[pen], paths: [] }).paths.push(p);
    });
    return layers;
  },
});
