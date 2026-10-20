import { noise2DFrom, shuffle } from '../random';
import { jitteredGrid, streamlines } from '../lib/streamlines';
import { defineArtwork } from './types';
import { PALETTE, type Layer } from '../layers';

export default defineArtwork({
  slug: 'flow-field',
  title: 'Flow field',
  description: 'Evenly spaced streamlines over simplex noise, optionally split across pens.',
  kind: 'study',
  params: [
    { type: 'seed', key: 'seed', label: 'Seed', default: 7 },
    { type: 'number', key: 'scale', label: 'Noise scale', min: 0.002, max: 0.08, step: 0.001, default: 0.012 },
    { type: 'number', key: 'turb', label: 'Turbulence', min: 0.25, max: 4, step: 0.05, default: 1 },
    { type: 'number', key: 'dsep', label: 'Spacing (mm)', min: 0.6, max: 12, step: 0.1, default: 2.5 },
    { type: 'number', key: 'maxLen', label: 'Max length (mm)', min: 5, max: 600, step: 5, default: 160 },
    { type: 'number', key: 'minLen', label: 'Min length (mm)', min: 0, max: 50, step: 1, default: 6 },
    { type: 'number', key: 'pens', label: 'Pens', min: 1, max: 6, step: 1, default: 1, hint: 'Splits lines into colour regions, one layer per pen' },
    { type: 'number', key: 'penScale', label: 'Colour region scale', min: 0.002, max: 0.05, step: 0.001, default: 0.008, show: (v) => v.pens > 1 },
  ],
  generate(v, ctx) {
    const noise = noise2DFrom(ctx.seed);
    const lines = streamlines({
      width: ctx.width,
      height: ctx.height,
      field: (x, y) => {
        const a = noise(x * v.scale, y * v.scale) * Math.PI * v.turb;
        return [Math.cos(a), Math.sin(a)];
      },
      seeds: shuffle(jitteredGrid(ctx.width, ctx.height, v.dsep, ctx.rng), ctx.rng),
      dsep: v.dsep,
      dtest: v.dsep * 0.5,
      step: Math.min(0.5, v.dsep / 3),
      maxLen: v.maxLen,
      minLen: v.minLen,
      bidirectional: true,
    });
    if (v.pens <= 1) return lines;
    const regions = noise2DFrom(ctx.seed + 1);
    const layers: Layer[] = Array.from({ length: v.pens }, (_, i) => ({ name: `Pen ${i + 1}`, color: PALETTE[i % PALETTE.length], paths: [] }));
    for (const l of lines) {
      const [x, y] = l[Math.floor(l.length / 2)];
      const n = (regions(x * v.penScale, y * v.penScale) + 1) / 2;
      layers[Math.min(v.pens - 1, Math.floor(n * v.pens))].paths.push(l);
    }
    return layers;
  },
});
