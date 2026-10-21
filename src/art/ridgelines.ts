import type { Polyline } from '../geom';
import { loadTerrainFor, ridges, terrainParams } from '../lib/elevation';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'ridgelines',
  title: 'Ridgelines',
  description: 'Any place on Earth as stacked terrain profiles, front rows hiding the ones behind.',
  order: 1,
  paper: { paper: 'square', margin: 25 },
  params: [
    ...terrainParams({ name: 'Mount Fuji, Japan', lat: 35.3606, lon: 138.7274 }, 11),
    { type: 'number', key: 'rows', label: 'Rows', min: 10, max: 250, step: 1, default: 70 },
    { type: 'number', key: 'height', label: 'Height (mm)', min: 0, max: 80, step: 0.5, default: 40 },
    { type: 'number', key: 'perspective', label: 'Perspective', min: 0, max: 1, step: 0.01, default: 0.3, hint: 'Back rows shrink and bunch up' },
    { type: 'select', key: 'water', label: 'Sea', options: [['lines', 'Flat lines'], ['blank', 'Leave blank']], default: 'lines', hint: 'Blank leaves the ocean empty so land floats on the page' },
    { type: 'checkbox', key: 'joins', label: 'Vertical joins', default: true, hint: 'Off: lines break at near-vertical drops (coastlines, cliffs) instead of joining up and down' },
    { type: 'number', key: 'joinAngle', label: 'Break steeper than (°)', min: 45, max: 89, step: 1, default: 80, show: (v) => !v.joins },
    { type: 'checkbox', key: 'frame', label: 'Frame', default: false },
  ],
  async generate(v, ctx) {
    const { height, isSea } = await loadTerrainFor(v, ctx);
    const { width: W, height: H } = ctx;
    const out: Polyline[] = ridges(height, W, H, {
      rows: v.rows,
      height: v.height,
      perspective: v.perspective,
      gap: v.water === 'blank' ? isSea : undefined,
      breakSteeperThan: v.joins ? undefined : v.joinAngle,
    });
    if (v.frame) out.push([[0, 0], [W, 0], [W, H], [0, H], [0, 0]]);
    return out;
  },
});
