import { contours, hachures, loadHeight, rays, ridges, rings, terrainParams } from '../lib/elevation';
import type { Values } from '../params';
import { defineArtwork } from './types';

const is = (...styles: string[]) => (v: Values) => styles.includes(v.style);

export default defineArtwork({
  slug: 'terrain-study',
  title: 'Terrain explorer',
  description: 'Every elevation style in one place: ridgelines, contours, hachures, rays and rings.',
  kind: 'study',
  params: [
    ...terrainParams({ name: 'Mount Fuji, Japan', lat: 35.3606, lon: 138.7274 }, 11),
    {
      type: 'select', key: 'style', label: 'Style', default: 'contours',
      options: [['ridges', 'Ridgelines'], ['contours', 'Contours'], ['hachures', 'Hachures (fall lines)'], ['rays', 'Rays from centre'], ['rings', 'Rings from centre']],
    },
    { type: 'number', key: 'lines', label: 'Lines', min: 5, max: 400, step: 1, default: 70, show: is('ridges', 'rays', 'rings') },
    { type: 'number', key: 'samples', label: 'Detail', min: 50, max: 1500, step: 10, default: 400, show: is('rays', 'rings') },
    { type: 'number', key: 'exag', label: 'Height (mm)', min: 0, max: 80, step: 0.5, default: 18, show: is('ridges', 'rays', 'rings') },
    { type: 'checkbox', key: 'occlude', label: 'Hide occluded lines', default: true, show: is('ridges') },
    { type: 'number', key: 'persp', label: 'Perspective', min: 0, max: 1, step: 0.01, default: 0, show: is('ridges') },
    { type: 'number', key: 'inner', label: 'Inner radius (mm)', min: 0, max: 100, step: 1, default: 4, show: is('rays', 'rings') },
    { type: 'number', key: 'levels', label: 'Levels', min: 3, max: 200, step: 1, default: 40, show: is('contours') },
    { type: 'number', key: 'curves', label: 'Curves (mm)', min: 0, max: 6, step: 0.1, default: 1.5, show: is('contours') },
    { type: 'number', key: 'cell', label: 'Resolution (mm)', min: 0.3, max: 4, step: 0.1, default: 0.8, show: is('contours') },
    { type: 'number', key: 'indexEvery', label: 'Index contour every', min: 0, max: 10, step: 1, default: 0, show: is('contours'), hint: 'Every Nth contour goes on a second pen (0 = off)' },
    { type: 'number', key: 'dsep', label: 'Spacing (mm)', min: 0.6, max: 10, step: 0.1, default: 1.6, show: is('hachures') },
    { type: 'checkbox', key: 'slopeDensity', label: 'Denser on steep slopes', default: true, show: is('hachures') },
    { type: 'number', key: 'dsepMax', label: 'Spacing on gentle slopes (mm)', min: 1, max: 20, step: 0.1, default: 5, show: (v) => v.style === 'hachures' && v.slopeDensity },
    { type: 'number', key: 'minSlope', label: 'Min slope', min: 0, max: 0.6, step: 0.01, default: 0.08, show: is('hachures') },
    { type: 'number', key: 'maxLen', label: 'Max length (mm)', min: 2, max: 300, step: 1, default: 25, show: is('hachures') },
    { type: 'seed', key: 'seed', label: 'Seed', default: 1, show: is('hachures') },
  ],
  async generate(v, ctx) {
    const h = await loadHeight(v, ctx);
    const { width: W, height: H } = ctx;
    const radial = { count: v.lines, samples: v.samples, height: v.exag, inner: v.inner };
    switch (v.style) {
      case 'ridges': return ridges(h, W, H, { rows: v.lines, height: v.exag, perspective: v.persp, occlude: v.occlude });
      case 'contours': return contours(h, W, H, { levels: v.levels, cell: v.cell, indexEvery: v.indexEvery, curves: v.curves });
      case 'hachures':
        return hachures(h, W, H, { spacing: v.dsep, spacingGentle: v.slopeDensity ? v.dsepMax : v.dsep, minSlope: v.minSlope, maxLength: v.maxLen }, ctx.rng);
      case 'rays': return rays(h, W, H, radial);
      case 'rings': return rings(h, W, H, radial);
    }
    return [];
  },
});
