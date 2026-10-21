import { circle, clipToRect, type Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { clipToCircle, fetchWays, offsetPolyline, osmParams, projection, projectWay } from '../lib/osm';
import { defineArtwork } from './types';

const CLASSES = {
  major: ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link'],
  streets: ['tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'road'],
  service: ['service'],
  paths: ['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'track'],
} as const;
type Cls = keyof typeof CLASSES;
const classOf = new Map<string, Cls>();
for (const [k, list] of Object.entries(CLASSES)) for (const h of list) classOf.set(h, k as Cls);

export default defineArtwork({
  slug: 'street-grid',
  title: 'Street grid',
  description: 'Every street within a radius of anywhere, from OpenStreetMap: major roads, streets and paths on separate pens.',
  order: 10,
  paper: { paper: 'a4', orientation: 'portrait', margin: 20 },
  params: [
    ...osmParams({ name: 'Eixample, Barcelona', lat: 41.3905, lon: 2.1600 }, 1200, { min: 100, max: 3000, step: 50 }),
    { type: 'select', key: 'crop', label: 'Crop', default: 'circle', options: [['circle', 'Circle'], ['rect', 'Rectangle']] },
    { type: 'checkbox', key: 'border', label: 'Border', default: true, hint: 'Outline the crop' },
    { type: 'checkbox', key: 'major', label: 'Major roads', default: true, hint: 'Motorway, trunk, primary, secondary' },
    { type: 'checkbox', key: 'streets', label: 'Streets', default: true, hint: 'Tertiary, residential, unclassified, living streets' },
    { type: 'checkbox', key: 'service', label: 'Service roads', default: false, hint: 'Alleys, driveways, car parks' },
    { type: 'checkbox', key: 'paths', label: 'Paths', default: true, hint: 'Footways, cycleways, steps, pedestrian streets' },
    { type: 'checkbox', key: 'sidewalks', label: 'Include sidewalks', default: false, show: (v) => v.paths, hint: 'Mapped pavements double every street; usually best left off' },
    {
      type: 'select', key: 'pens', label: 'Pens', default: 'three',
      options: [['three', 'Major / streets / paths'], ['two', 'Roads / paths'], ['one', 'One pen']],
    },
    { type: 'checkbox', key: 'doubled', label: 'Major roads doubled', default: true, show: (v) => v.major, hint: 'Draw major roads as two parallel lines' },
    { type: 'number', key: 'gap', label: 'Double gap (mm)', min: 0.3, max: 3, step: 0.1, default: 0.8, show: (v) => v.major && v.doubled },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const proj = projection(v.loc, v.radius, W, H);
    const fetchR = v.crop === 'circle' ? v.radius * 1.05 : proj.cornerRadius * 1.02;
    const wanted = (Object.keys(CLASSES) as Cls[]).filter((c) => v[c]);
    if (!wanted.length) throw new Error('Pick at least one road class');
    const re = wanted.flatMap((c) => CLASSES[c]).join('|');
    ctx.status(`Loading streets around ${v.loc.name}…`);
    const ways = await fetchWays([`["highway"~"^(${re})$"]`], v.loc, fetchR, { status: ctx.status });

    const groups: Record<Cls, Polyline[]> = { major: [], streets: [], service: [], paths: [] };
    for (const w of ways) {
      const cls = classOf.get(w.tags.highway);
      if (!cls || !v[cls]) continue;
      if (cls === 'paths' && !v.sidewalks && /^(sidewalk|crossing|traffic_island)$/.test(w.tags.footway ?? '')) continue;
      if (w.tags.area === 'yes') continue;
      const line = projectWay(w, proj);
      if (cls === 'major' && v.doubled) {
        groups.major.push(offsetPolyline(line, v.gap / 2), offsetPolyline(line, -v.gap / 2));
      } else groups[cls].push(line);
    }

    const crop = (ps: Polyline[]) => (v.crop === 'circle' ? clipToCircle(ps, proj.cx, proj.cy, proj.r) : clipToRect(ps, 0, 0, W, H));
    const major = crop(groups.major);
    const streets = crop([...groups.streets, ...groups.service]);
    const paths = crop(groups.paths);
    const count = (ps: Polyline[]) => ps.length;
    ctx.status(`${v.loc.name} · ${ways.length} ways · ${count(major)} major, ${count(streets)} street, ${count(paths)} path segments`);

    const border: Polyline[] = v.border ? [v.crop === 'circle' ? circle(proj.cx, proj.cy, proj.r, 360) : [[0, 0], [W, 0], [W, H], [0, H], [0, 0]]] : [];
    let layers: Layer[];
    if (v.pens === 'three') {
      layers = [
        { name: 'Streets', color: PALETTE[0], paths: [...streets, ...border] },
        { name: 'Major roads', color: PALETTE[1], paths: major },
        { name: 'Paths', color: PALETTE[2], paths },
      ];
    } else if (v.pens === 'two') {
      layers = [
        { name: 'Roads', color: PALETTE[0], paths: [...major, ...streets, ...border] },
        { name: 'Paths', color: PALETTE[2], paths },
      ];
    } else layers = [{ name: 'Streets', color: PALETTE[0], paths: [...major, ...streets, ...paths, ...border] }];
    return layers.filter((l) => l.paths.length);
  },
});
