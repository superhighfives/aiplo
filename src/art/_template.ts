// Copy this file to e.g. src/art/my-piece.ts (no leading underscore) and it appears in the gallery.
import type { Polyline } from '../geom';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'my-piece',
  title: 'My piece',
  description: 'One line for the gallery card.',
  paper: { paper: 'a4', orientation: 'landscape', margin: 15 },
  params: [
    { type: 'seed', key: 'seed', label: 'Seed', default: 1 },
    { type: 'number', key: 'count', label: 'Count', min: 1, max: 200, step: 1, default: 40 },
  ],
  // ctx.width/height: drawing area in mm. Return polylines ([[x, y], ...]) or
  // layers ([{ name, color, paths }]) for several pens. Can be async (e.g. fetch data).
  generate(v, ctx) {
    const lines: Polyline[] = [];
    for (let i = 0; i < v.count; i++) {
      const y = ((i + 0.5) / v.count) * ctx.height;
      lines.push([[0, y], [ctx.width * (0.3 + 0.7 * ctx.rng()), y]]);
    }
    return lines;
  },
});
