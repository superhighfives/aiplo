import { circle, clipToRect, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { hatchPolygon } from '../lib/hatch';
import { clipToCircle, fetchWaysAndRelations, osmParams, projection, projectWay, stitchRings, touchesCircle, type OsmWay } from '../lib/osm';
import { defineArtwork } from './types';

/** Direction (degrees) of a ring's longest edge. */
function longestEdgeAngle(r: Pt[]): number {
  let best = 0, ang = 0;
  for (let i = 1; i < r.length; i++) {
    const dx = r[i][0] - r[i - 1][0], dy = r[i][1] - r[i - 1][1];
    const l = dx * dx + dy * dy;
    if (l > best) { best = l; ang = (Math.atan2(dy, dx) * 180) / Math.PI; }
  }
  return ang;
}

export default defineArtwork({
  slug: 'buildings',
  title: 'Buildings',
  description: 'Every building footprint around a place, from OpenStreetMap, each one outlined and hatched at its own angle.',
  order: 13,
  paper: { paper: 'letter', orientation: 'portrait', margin: 20 },
  params: [
    ...osmParams({ name: 'San Polo, Venice', lat: 45.4375, lon: 12.3330 }, 300, { min: 50, max: 1000, step: 25 }),
    { type: 'select', key: 'angle', label: 'Hatch angle', default: 'edge', options: [['edge', 'Along the longest wall'], ['across', 'Across the longest wall'], ['random', 'Random'], ['fixed', 'Fixed']] },
    { type: 'number', key: 'fixedAngle', label: 'Angle (°)', min: 0, max: 175, step: 5, default: 45, show: (v) => v.angle === 'fixed' },
    { type: 'number', key: 'spacing', label: 'Hatch spacing (mm)', min: 0, max: 4, step: 0.05, default: 1.4, hint: '0 = outlines only' },
    { type: 'number', key: 'minSize', label: 'Skip hatching below (mm²)', min: 0, max: 50, step: 1, default: 4, hint: 'Tiny sheds and kiosks stay as outlines' },
    { type: 'select', key: 'crop', label: 'Crop', default: 'circle', options: [['circle', 'Circle'], ['rect', 'Rectangle']] },
    { type: 'checkbox', key: 'border', label: 'Border', default: false },
    { type: 'select', key: 'pens', label: 'Pens', default: 'two', options: [['one', 'One pen'], ['two', 'Outlines / hatching']] },
    { type: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const proj = projection(v.loc, v.radius, W, H);
    const circ = v.crop === 'circle';
    const fetchR = circ ? v.radius : proj.cornerRadius;
    ctx.status(`Loading buildings around ${v.loc.name}…`);
    const { ways, relations } = await fetchWaysAndRelations(['["building"]'], v.loc, fetchR, { status: ctx.status, timeout: 90 });

    // Each building: outer ring + holes (simple multipolygons: stitched outer/inner members).
    const shapes: Pt[][][] = [];
    for (const w of ways) if (w.geometry.length > 3) shapes.push([projectWay(w, proj)]);
    for (const r of relations) {
      if (r.tags.type !== 'multipolygon') continue;
      const geom = (role: string) => r.members.filter((m) => m.type === 'way' && m.role === role && m.geometry).map((m) => projectWay(m as unknown as OsmWay, proj));
      const inner = stitchRings(geom('inner'), 1e-4).closed;
      for (const o of stitchRings(geom('outer'), 1e-4).closed) shapes.push([o, ...inner]);
    }
    const visible = shapes.filter((s) => (circ ? touchesCircle(s[0], proj.cx, proj.cy, proj.r) : s[0].some(([x, y]) => x >= 0 && y >= 0 && x <= W && y <= H)));

    const area = (r: Pt[]) => {
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
      return Math.abs(a / 2);
    };
    const outlines: Polyline[] = [];
    const hatch: Polyline[] = [];
    for (const rings of visible) {
      outlines.push(...rings);
      if (v.spacing <= 0 || area(rings[0]) < v.minSize) continue;
      const base = longestEdgeAngle(rings[0]);
      const ang = v.angle === 'edge' ? base : v.angle === 'across' ? base + 90 : v.angle === 'random' ? ctx.rng() * 180 : v.fixedAngle;
      hatch.push(...hatchPolygon(rings, ang, v.spacing, ctx.rng() * v.spacing));
    }
    const crop = (ps: Polyline[]) => (circ ? clipToCircle(ps, proj.cx, proj.cy, proj.r) : clipToRect(ps, 0, 0, W, H));
    const border: Polyline[] = v.border ? [circ ? circle(proj.cx, proj.cy, proj.r, 360) : [[0, 0], [W, 0], [W, H], [0, H], [0, 0]]] : [];
    ctx.status(`${v.loc.name} · ${visible.length} buildings (${ways.length} ways, ${relations.length} relations)`);
    if (!visible.length) throw new Error(`No mapped buildings near ${v.loc.name}`);
    const o = [...crop(outlines), ...border];
    const h = crop(hatch);
    const layers: Layer[] = v.pens === 'two'
      ? [{ name: 'Outlines', color: PALETTE[0], paths: o }, { name: 'Hatching', color: PALETTE[1], paths: h }]
      : [{ name: 'Buildings', color: PALETTE[0], paths: [...o, ...h] }];
    return layers.filter((l) => l.paths.length);
  },
});
