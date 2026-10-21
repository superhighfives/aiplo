import { circle, clipToRect, polylineLength, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { hatchPolygon } from '../lib/hatch';
import { clipToCircle, fetchWaysAndRelations, osmParams, parallelStrokes, projection, projectWay, stitchRings, type OsmWay } from '../lib/osm';
import { defineArtwork } from './types';

/** Parallel strokes per waterway class (scaled by the Weight knob). */
const STROKES: Record<string, number> = { river: 3, canal: 2, stream: 1, drain: 1, ditch: 1 };

/** Drop waterways shorter than this on paper (mm) and ponds smaller than this (mm²). */
const MIN_STREAM = 1.5;
const MIN_POND = 2;

const ringArea = (r: Pt[]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a / 2);
};

export default defineArtwork({
  slug: 'rivers',
  title: 'Rivers',
  description: 'The mapped waterways of an area from OpenStreetMap (rivers, canals, streams and lakes), weighted by size. Everything in the area, not a traced watershed.',
  order: 12,
  paper: { paper: 'letter', orientation: 'landscape', margin: 20 },
  params: [
    ...osmParams({ name: 'Lake District, England', lat: 54.46, lon: -3.05 }, 6000, { min: 500, max: 20000, step: 500 }),
    { type: 'checkbox', key: 'streams', label: 'Streams', default: true },
    { type: 'checkbox', key: 'drains', label: 'Drains and ditches', default: false, hint: 'Can be very dense in farmland' },
    { type: 'checkbox', key: 'water', label: 'Lakes and coastline', default: true, hint: 'Outlines of mapped water bodies, on a second pen' },
    { type: 'number', key: 'hatch', label: 'Hatch water (mm)', min: 0, max: 5, step: 0.1, default: 1.6, show: (v) => v.water, hint: 'Spacing of hatching inside lakes; 0 = outlines only' },
    { type: 'number', key: 'weight', label: 'Weight (mm)', min: 0, max: 1.5, step: 0.05, default: 0.4, hint: 'Gap between the parallel strokes that thicken rivers (3) and canals (2)' },
    { type: 'select', key: 'crop', label: 'Crop', default: 'rect', options: [['circle', 'Circle'], ['rect', 'Rectangle']] },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const proj = projection(v.loc, v.radius, W, H);
    const fetchR = (v.crop === 'circle' ? v.radius : proj.cornerRadius) * 1.02;
    const kinds = ['river', 'canal', ...(v.streams ? ['stream'] : []), ...(v.drains ? ['drain', 'ditch'] : [])];
    const filters = [`["waterway"~"^(${kinds.join('|')})$"]`];
    // Big river-surface multipolygons can span hundreds of km; the weighted centrelines stand in for them.
    if (v.water) filters.push('["natural"="water"]["water"!~"^(river|canal|stream|riverbank)$"]', '["natural"="coastline"]');
    ctx.status(`Loading waterways around ${v.loc.name}…`);
    const { ways, relations } = await fetchWaysAndRelations(filters, v.loc, fetchR, { status: ctx.status, timeout: 90 });

    const crop = (ps: Polyline[]) => (v.crop === 'circle' ? clipToCircle(ps, proj.cx, proj.cy, proj.r) : clipToRect(ps, 0, 0, W, H));
    const rivers: Polyline[] = [];
    const outlines: Polyline[] = [];
    const polys: Pt[][][] = []; // each: outer + inner rings
    let nWaterways = 0;
    const isWater = (w: { tags: Record<string, string> }) => w.tags.natural === 'water' || w.tags.natural === 'coastline';
    for (const w of ways) {
      const line = projectWay(w, proj);
      if (w.tags.waterway && STROKES[w.tags.waterway]) {
        if (polylineLength(line) < MIN_STREAM) continue; // specks that only add pen lifts
        nWaterways++;
        rivers.push(...parallelStrokes(line, v.weight > 0 ? STROKES[w.tags.waterway] : 1, v.weight * (STROKES[w.tags.waterway] - 1)));
      } else if (isWater(w)) {
        const closed = line.length > 3 && line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1];
        if (closed && ringArea(line) < MIN_POND) continue;
        outlines.push(line);
        if (w.tags.natural === 'water' && closed) polys.push([line]);
      }
    }
    for (const r of relations) {
      const geom = (role: string) => r.members.filter((m) => m.type === 'way' && m.role === role && m.geometry).map((m) => projectWay(m as unknown as OsmWay, proj));
      const outer = stitchRings(geom('outer'), 1e-4);
      const inner = stitchRings(geom('inner'), 1e-4);
      outlines.push(...outer.closed, ...outer.open, ...inner.closed, ...inner.open);
      for (const o of outer.closed) polys.push([o, ...inner.closed]);
    }

    const water: Polyline[] = [...crop(outlines)];
    if (v.water && v.hatch > 0) {
      const minArea = (v.hatch * 3) ** 2; // skip ponds too small to read as hatched
      const hatch: Polyline[] = [];
      for (const rings of polys) if (ringArea(rings[0]) > minArea) hatch.push(...hatchPolygon(rings, 30, v.hatch));
      water.push(...crop(hatch));
    }
    const border: Polyline[] = v.crop === 'circle' ? [circle(proj.cx, proj.cy, proj.r, 360)] : [];
    ctx.status(`${v.loc.name} · ${nWaterways} waterways · ${polys.length} water bodies`);
    const layers: Layer[] = [
      { name: 'Waterways', color: PALETTE[2], paths: [...crop(rivers), ...border] },
      { name: 'Water bodies', color: PALETTE[0], paths: water },
    ];
    const out = layers.filter((l) => l.paths.length);
    if (!out.length) throw new Error(`No mapped waterways near ${v.loc.name}; try a larger radius`);
    return out;
  },
});
