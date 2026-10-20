import { circle, resample, type Polyline } from '../geom';
import { noise2DFrom } from '../random';
import { defineArtwork } from './types';
import { isLayers, type GenOutput } from '../layers';

const DEFAULT = `// Return an array of polylines: [[x, y], ...] in mm,
// or layers for multiple pens: [{ name, color, paths: [...] }, ...]
// In scope: width, height, rng(), noise(x, y) in [-1, 1],
//           circle(cx, cy, r, n?), resample(line, spacing)
const lines = [];
const cx = width / 2, cy = height / 2;
for (let i = 0; i < 60; i++) {
  const r = 4 + i * 1.6;
  const ring = circle(cx, cy, r, 360).map(([x, y]) => {
    const n = noise(x * 0.02, y * 0.02 + i * 0.01);
    return [cx + (x - cx) * (1 + n * 0.15), cy + (y - cy) * (1 + n * 0.15)];
  });
  lines.push(ring);
}
return lines;
`;

export default defineArtwork({
  slug: 'scratchpad',
  title: 'Scratchpad',
  description: 'Write a quick sketch in the browser. For keepers, make a file in src/art.',
  kind: 'tool',
  order: 3,
  params: [
    { type: 'seed', key: 'seed', label: 'Seed', default: 3 },
    { type: 'code', key: 'code', label: 'Code', default: DEFAULT },
  ],
  generate(v, ctx) {
    const fn = new Function('width', 'height', 'rng', 'noise', 'circle', 'resample', v.code);
    const result: GenOutput = fn(ctx.width, ctx.height, ctx.rng, noise2DFrom(ctx.seed), circle, resample);
    if (!Array.isArray(result)) throw new Error('Sketch must return an array of polylines or layers');
    const clean = (ps: Polyline[]) => ps.filter((p) => Array.isArray(p) && p.length > 1);
    if (isLayers(result)) return result.map((l) => ({ ...l, paths: clean(l.paths) }));
    return clean(result as Polyline[]);
  },
});
