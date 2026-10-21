import { smooth, type Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { coastline, contourLevels, loadTerrainFor, terrainParams } from '../lib/elevation';
import { defineArtwork } from './types';

const MAX_LEVELS = 400;

export default defineArtwork({
  slug: 'contours',
  title: 'Contours',
  description: 'A topographic map of anywhere, with index lines, height bands and a coastline across up to four pens.',
  order: 2,
  paper: { paper: 'letter', orientation: 'landscape', margin: 20 },
  params: [
    ...terrainParams({ name: 'Taranaki Maunga, New Zealand', lat: -39.2968, lon: 174.0634 }, 11),
    { type: 'number', key: 'interval', label: 'Interval (m)', min: 5, max: 500, step: 5, default: 50, hint: 'Height between contour lines' },
    {
      type: 'select', key: 'pens', label: 'Pens', default: 'index',
      options: [['one', 'One pen'], ['index', 'Index lines on a second pen'], ['bands', 'Bands by height']],
    },
    { type: 'number', key: 'indexEvery', label: 'Index line every', min: 2, max: 10, step: 1, default: 5, show: (v) => v.pens === 'index' },
    { type: 'number', key: 'bands', label: 'Bands', min: 2, max: 4, step: 1, default: 3, show: (v) => v.pens === 'bands' },
    { type: 'checkbox', key: 'coast', label: 'Coastline', default: true, hint: 'Traced at 0 m on its own pen; empty if the area has no sea' },
    { type: 'number', key: 'curves', label: 'Curves (mm)', min: 0, max: 6, step: 0.1, default: 1.5, hint: 'Smooths each line into flowing curves; 0 = raw traced lines' },
    { type: 'number', key: 'cell', label: 'Resolution (mm)', min: 0.3, max: 3, step: 0.1, default: 0.6 },
    { type: 'checkbox', key: 'frame', label: 'Frame', default: false },
  ],
  async generate(v, ctx) {
    const map = await loadTerrainFor(v, ctx);
    const { width: W, height: H } = ctx;

    // Real heights in metres: round-number levels from the lowest point (or sea level) to the top.
    const lo = v.clampSea ? Math.max(0, map.min) : map.min;
    const levels: number[] = [];
    for (let m = Math.ceil(lo / v.interval) * v.interval; m < map.max; m += v.interval) if (m > lo) levels.push(m);
    if (levels.length > MAX_LEVELS) throw new Error(`${levels.length} contours: raise the interval (max ${MAX_LEVELS})`);
    ctx.status(`${map.summary} · ${levels.length} contours every ${v.interval} m`);

    const lines = contourLevels(map.metres, W, H, levels, v.cell).map((ls) => ls.map((l) => smooth(l, v.curves)));
    let layers: Layer[];
    if (v.pens === 'index') {
      const isIndex = (m: number) => Math.round(m / v.interval) % v.indexEvery === 0;
      layers = [
        { name: 'Contours', color: PALETTE[0], paths: lines.filter((_, k) => !isIndex(levels[k])).flat() },
        { name: 'Index lines', color: PALETTE[1], paths: lines.filter((_, k) => isIndex(levels[k])).flat() },
      ];
    } else if (v.pens === 'bands') {
      const bandColors = [PALETTE[4], PALETTE[3], PALETTE[1], PALETTE[0]];
      layers = Array.from({ length: v.bands }, (_, b) => ({ name: `Band ${b + 1}`, color: bandColors[b] ?? PALETTE[b], paths: [] as Polyline[] }));
      lines.forEach((ls, k) => {
        const b = Math.min(v.bands - 1, Math.floor(((levels[k] - lo) / (map.max - lo)) * v.bands));
        layers[b].paths.push(...ls);
      });
    } else {
      layers = [{ name: 'Contours', color: PALETTE[0], paths: lines.flat() }];
    }

    if (v.coast) {
      const coast = coastline(map, W, H, Math.min(v.cell, 0.5)).map((l) => smooth(l, v.curves));
      if (coast.length) {
        if (v.pens === 'one') layers[0].paths.push(...coast);
        else layers.push({ name: 'Coastline', color: PALETTE[2], paths: coast });
      }
    }
    if (v.frame) layers[0].paths.push([[0, 0], [W, 0], [W, H], [0, H], [0, 0]]);
    return layers;
  },
});
