import type { Polyline, Pt } from '../geom';
import { mulberry32 } from '../random';
import { fitToBox } from '../lib/gen-util';
import { defineArtwork } from './types';

// Frequency pairs (per axis) that give classic, legible harmonograph figures.
const RATIOS: [number, number][] = [[1, 1], [2, 1], [3, 2], [3, 1], [4, 3], [5, 4], [5, 3], [2, 3]];

interface Pendulum {
  amp: number;
  freq: number; // swings per unit time
  phase: number;
  damp: number; // per swing
}

export default defineArtwork({
  slug: 'harmonograph',
  title: 'Harmonograph',
  description: 'Damped pendulums swinging a pen: one long line that spirals into the centre.',
  order: 60,
  paper: { paper: 'square', margin: 18 },
  params: [
    { type: 'seed', key: 'seed', label: 'Seed', default: 5, hint: 'Picks a pleasing preset: frequency ratio, phases and amplitudes' },
    {
      type: 'select', key: 'ratio', label: 'Ratio (x : y)', default: 'auto',
      options: [['auto', 'From seed'], ...RATIOS.map(([a, b]) => [`${a}:${b}`, `${a} : ${b}`] as [string, string]), ['manual', 'Manual']],
    },
    { type: 'number', key: 'fx1', label: 'x pendulum 1 freq', min: 0.5, max: 8, step: 0.01, default: 2, show: (v) => v.ratio === 'manual' },
    { type: 'number', key: 'fx2', label: 'x pendulum 2 freq', min: 0.5, max: 8, step: 0.01, default: 3, show: (v) => v.ratio === 'manual' },
    { type: 'number', key: 'fy1', label: 'y pendulum 1 freq', min: 0.5, max: 8, step: 0.01, default: 3, show: (v) => v.ratio === 'manual' },
    { type: 'number', key: 'fy2', label: 'y pendulum 2 freq', min: 0.5, max: 8, step: 0.01, default: 2, show: (v) => v.ratio === 'manual' },
    { type: 'number', key: 'detune', label: 'Detune', min: 0, max: 0.03, step: 0.0005, default: 0.006, hint: 'How far frequencies drift from the exact ratio: makes the figure slowly precess' },
    { type: 'number', key: 'phase', label: 'Phase shift (°)', min: 0, max: 180, step: 1, default: 0, hint: 'Added to the y pendulums’ phase; 0 keeps the seeded phases' },
    { type: 'number', key: 'damping', label: 'Damping', min: 0.002, max: 0.1, step: 0.001, default: 0.02, hint: 'Fraction of the swing lost each cycle' },
    { type: 'number', key: 'duration', label: 'Duration (swings)', min: 10, max: 600, step: 5, default: 300, hint: 'Maximum length; drawing also stops when the swing fades (below)' },
    { type: 'number', key: 'fade', label: 'Stop at size', min: 0.01, max: 0.9, step: 0.01, default: 0.3, hint: 'Stop when the swing has shrunk to this fraction of its start' },
    { type: 'number', key: 'rotary', label: 'Rotary pendulum', min: 0, max: 1, step: 0.05, default: 0, hint: 'Amplitude of a third, circular pendulum moving the paper' },
    { type: 'number', key: 'resolution', label: 'Smoothness (mm)', min: 0.05, max: 1, step: 0.05, default: 0.1, hint: 'Maximum chord error; smaller = more points' },
  ],
  generate(v, ctx) {
    const rng = mulberry32((v.seed | 0) * 7919 + 13);
    const R = (a: number, b: number) => a + (b - a) * rng();
    let ratio: [number, number];
    if (v.ratio === 'auto') ratio = RATIOS[Math.floor(rng() * 4)]; // the simplest ratios read best
    else if (v.ratio !== 'manual') ratio = v.ratio.split(':').map(Number) as [number, number];
    else ratio = [1, 1];
    const [rx, ry] = ratio;
    const det = () => 1 + (rng() * 2 - 1) * v.detune;
    const p2 = Math.PI * 2;
    const shift = (v.phase * Math.PI) / 180;
    const pend = (freq: number, phase: number, amp: number): Pendulum => ({ amp, freq, phase, damp: v.damping * R(0.95, 1.05) });

    // Two pendulums per axis: a main one at that axis' ratio, a weaker one at the other axis'
    // ratio. Time is measured in swings of the fastest pendulum.
    const fmax = Math.max(rx, ry);
    const xs: Pendulum[] = v.ratio === 'manual'
      ? [pend(v.fx1, R(0, p2), 1), pend(v.fx2, R(0, p2), R(0.3, 0.8))]
      : [pend((rx / fmax) * det(), R(0, p2), 1), pend((ry / fmax) * det(), R(0, p2), R(0.15, 0.6))];
    const ys: Pendulum[] = v.ratio === 'manual'
      ? [pend(v.fy1, R(0, p2) + shift, 1), pend(v.fy2, R(0, p2) + shift, R(0.3, 0.8))]
      : [pend((ry / fmax) * det(), R(0, p2) + shift, 1), pend((rx / fmax) * det(), R(0, p2) + shift, R(0.15, 0.6))];
    if (v.ratio === 'manual') {
      const m = Math.max(v.fx1, v.fx2, v.fy1, v.fy2);
      for (const p of [...xs, ...ys]) p.freq /= m;
    }
    const rot: Pendulum = { amp: v.rotary, freq: (Math.min(rx, ry) / fmax) * det() * (rng() < 0.5 ? 1 : -1), phase: R(0, p2), damp: v.damping };

    const pos = (t: number): Pt => {
      let x = 0, y = 0;
      for (const p of xs) x += p.amp * Math.sin(p2 * p.freq * t + p.phase) * Math.exp(-p.damp * t);
      for (const p of ys) y += p.amp * Math.sin(p2 * p.freq * t + p.phase) * Math.exp(-p.damp * t);
      if (rot.amp > 0) {
        const e = rot.amp * Math.exp(-rot.damp * t);
        x += e * Math.sin(p2 * rot.freq * t + rot.phase);
        y += e * Math.cos(p2 * rot.freq * t + rot.phase);
      }
      return [x, y];
    };

    // Step size: chord error ≈ r·(ω·dt)²/8 for a circle of radius r, so pick dt from the fastest
    // angular rate and the curve's size in mm, letting it grow as the swing decays.
    const all = [...xs, ...ys, rot].filter((p) => p.amp > 0);
    const totalAmp = xs.reduce((s, p) => s + p.amp, 0) + rot.amp;
    // Measure the curve's actual extent with a coarse pass, to know the final mm per unit.
    let ext = 1e-6;
    for (let t = 0; t < Math.min(v.duration, 10); t += 0.005) {
      const [x, y] = pos(t);
      ext = Math.max(ext, Math.abs(x), Math.abs(y));
    }
    const mmPerUnit = Math.min(ctx.width, ctx.height) / 2 / ext;
    const omega = p2 * Math.max(...all.map((p) => Math.abs(p.freq)));
    const minDamp = Math.min(...all.map((p) => p.damp));
    const line: Polyline = [];
    let t = 0;
    // Stop once the swing has died down to `fade` of its starting size: the very centre would
    // otherwise be solid ink.
    const tEnd = Math.min(v.duration, Math.log(1 / v.fade) / minDamp);
    while (t <= tEnd) {
      line.push(pos(t));
      const r = mmPerUnit * totalAmp * Math.exp(-minDamp * t);
      const dt = Math.sqrt((8 * v.resolution) / Math.max(1e-6, r)) / omega;
      t += Math.min(dt, 0.05);
    }
    return fitToBox([line], ctx.width, ctx.height, 0);
  },
});
