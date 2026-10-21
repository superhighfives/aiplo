import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { FONT_OPTIONS, text, textAlong } from '../lib/hershey';
import { clipToCircle, fetchWays, projection, projectWay } from '../lib/osm';
import { distanceKm } from '../lib/world';
import type { Location } from '../params';
import { defineArtwork } from './types';

const ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'road', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'];
const PATHS = ['footway', 'path', 'cycleway', 'steps', 'pedestrian'];

const COLOURS: Record<string, [string, string]> = {
  'teal-red': [PALETTE[2], PALETTE[1]],
  'ink-red': [PALETTE[0], PALETTE[1]],
  'ink-teal': [PALETTE[0], PALETTE[2]],
  'purple-amber': [PALETTE[5], PALETTE[3]],
};

/** Short, letterable place name: first part of a geocoded name, accents folded to ASCII. */
const shortName = (n: string) =>
  (n.split(',')[0] || n).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e·°]/g, '').trim();

/** Clockwise arc (y-down screen space) from angle a0 to a1 (radians), for text along the top. */
const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 180): Polyline =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });

const formatKm = (km: number) => (km >= 100 ? Math.round(km).toLocaleString('en-US') : km.toFixed(1));

async function streets(loc: Location, radius: number, paths: boolean, status: (m: string) => void) {
  const re = [...ROADS, ...(paths ? PATHS : [])].join('|');
  status(`Loading streets around ${shortName(loc.name)}…`);
  return fetchWays([`["highway"~"^(${re})$"]`], loc, radius * 1.05, { status });
}

export default defineArtwork({
  slug: 'two-hometowns',
  title: 'Two hometowns',
  description: 'The streets of two places, at the same scale, laid over each other in one circle: where you are from, and where you live now.',
  order: 100,
  series: 'Moments',
  paper: { paper: 'square', margin: 18 },
  params: [
    { type: 'location', key: 'a', label: 'First place', default: { name: 'Barcelona', lat: 41.3925, lon: 2.162 } },
    { type: 'location', key: 'b', label: 'Second place', default: { name: 'Kyoto', lat: 35.0045, lon: 135.7615 } },
    { type: 'number', key: 'radius', label: 'Radius (m)', min: 200, max: 3000, step: 50, default: 900, hint: 'Ground distance from each centre to the edge of its circle; both places use the same scale' },
    { type: 'select', key: 'layout', label: 'Layout', options: [['overlay', 'Overlaid in one circle'], ['side', 'Side by side']], default: 'overlay' },
    { type: 'number', key: 'rotateB', label: 'Turn second place (°)', min: -180, max: 180, step: 1, default: 0, hint: 'Rotate the second grid about its centre' },
    { type: 'checkbox', key: 'paths', label: 'Include footpaths', default: false },
    { type: 'select', key: 'colours', label: 'Pens', options: [['teal-red', 'Teal / red'], ['ink-red', 'Ink / red'], ['ink-teal', 'Ink / teal'], ['purple-amber', 'Purple / amber']], default: 'teal-red' },
    { type: 'checkbox', key: 'border', label: 'Circle outline', default: true },
    { type: 'checkbox', key: 'names', label: 'Letter the names', default: true },
    { type: 'text', key: 'nameA', label: 'First name (lettering)', default: '', placeholder: 'From the place', show: (v) => v.names },
    { type: 'text', key: 'nameB', label: 'Second name (lettering)', default: '', placeholder: 'From the place', show: (v) => v.names },
    { type: 'checkbox', key: 'distance', label: 'Distance between them', default: true },
    { type: 'number', key: 'size', label: 'Lettering size (mm)', min: 2, max: 10, step: 0.5, default: 5, show: (v) => v.names || v.distance },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural', show: (v) => v.names || v.distance },
  ],
  caption: (v) => `${shortName(v.a.name)} & ${shortName(v.b.name)}`,
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const [colA, colB] = COLOURS[v.colours] ?? COLOURS['teal-red'];
    const size = v.size as number;
    const font = v.font as string;
    const nameA = (v.nameA as string).trim() || shortName(v.a.name);
    const nameB = (v.nameB as string).trim() || shortName(v.b.name);
    const km = distanceKm([v.a.lon, v.a.lat], [v.b.lon, v.b.lat]);
    const distText = `${formatKm(km)} km apart`;

    // Fetch one after the other: kinder to Overpass.
    const waysA = await streets(v.a, v.radius, v.paths, ctx.status);
    const waysB = await streets(v.b, v.radius, v.paths, ctx.status);

    const ring = v.names ? size * 1.9 : 0; // room for lettering round a circle
    const foot = v.distance ? size * 0.8 * 2.4 : 0; // room for the distance line
    const pensA: Polyline[] = [];
    const pensB: Polyline[] = [];

    /** Streets of `ways` around `loc`, clipped to a circle at (cx, cy) of radius r mm. */
    const disc = (ways: typeof waysA, loc: Location, cx: number, cy: number, r: number, rot = 0) => {
      const proj = projection(loc, v.radius, 2 * r, 2 * r);
      const c = Math.cos((rot * Math.PI) / 180), s = Math.sin((rot * Math.PI) / 180);
      const lines = ways
        .filter((w) => w.tags.area !== 'yes')
        .map((w) => projectWay(w, proj).map(([x, y]) => {
          const dx = x - r, dy = y - r;
          return [cx + dx * c - dy * s, cy + dx * s + dy * c] as Pt;
        }));
      return clipToCircle(lines, cx, cy, r);
    };
    /** Name across the top of a circle (reads left to right, clockwise). */
    const topName = (s: string, cx: number, cy: number, r: number) =>
      textAlong(s.toUpperCase(), arc(cx, cy, r + size * 0.6, Math.PI, 2 * Math.PI), { size, font, align: 'center', tracking: 0.3 });
    /** Name across the bottom (path runs left to right underneath, so the baseline sits a cap height out). */
    const bottomName = (s: string, cx: number, cy: number, r: number) =>
      textAlong(s.toUpperCase(), arc(cx, cy, r + size * 1.6, Math.PI, 0), { size, font, align: 'center', tracking: 0.3 });

    let nA = 0, nB = 0;
    if (v.layout === 'overlay') {
      const r = Math.max(10, Math.min(W / 2 - ring, (H - foot) / 2 - ring));
      const top = (H - (2 * (r + ring) + foot)) / 2; // centre the whole block when the width limits it
      const cx = W / 2, cy = top + r + ring;
      const a = disc(waysA, v.a, cx, cy, r);
      const b = disc(waysB, v.b, cx, cy, r, v.rotateB);
      nA = a.length; nB = b.length;
      pensA.push(...a);
      pensB.push(...b);
      if (v.border) pensA.push(circle(cx, cy, r, 360));
      if (v.names) {
        pensA.push(...topName(nameA, cx, cy, r));
        pensB.push(...bottomName(nameB, cx, cy, r));
      }
      if (v.distance) pensA.push(...text(distText, { x: W / 2, y: H - top, size: size * 0.8, font, align: 'center' }));
    } else {
      const horizontal = W >= H;
      const gap = size * 2;
      const r = horizontal
        ? Math.max(10, Math.min((W - gap) / 4 - ring, (H - foot) / 2 - ring))
        : Math.max(10, Math.min(W / 2 - ring, (H - foot - gap) / 4 - ring));
      const blockH = horizontal ? 2 * (r + ring) + foot : 4 * (r + ring) + gap + foot;
      const top = (H - blockH) / 2;
      const mid = top + (blockH - foot) / 2;
      const cs: Pt[] = horizontal
        ? [[W / 2 - (r + ring + gap / 2), mid], [W / 2 + (r + ring + gap / 2), mid]]
        : [[W / 2, mid - (r + ring + gap / 2)], [W / 2, mid + (r + ring + gap / 2)]];
      const a = disc(waysA, v.a, cs[0][0], cs[0][1], r);
      const b = disc(waysB, v.b, cs[1][0], cs[1][1], r, v.rotateB);
      nA = a.length; nB = b.length;
      pensA.push(...a);
      pensB.push(...b);
      if (v.border) pensA.push(circle(cs[0][0], cs[0][1], r, 360)), pensB.push(circle(cs[1][0], cs[1][1], r, 360));
      if (v.names) {
        pensA.push(...(horizontal ? bottomName : topName)(nameA, cs[0][0], cs[0][1], r));
        pensB.push(...bottomName(nameB, cs[1][0], cs[1][1], r));
      }
      if (v.distance) pensA.push(...text(distText, { x: W / 2, y: H - top, size: size * 0.8, font, align: 'center' }));
    }
    if (!nA) ctx.status(`No streets found around ${nameA}`);
    else if (!nB) ctx.status(`No streets found around ${nameB}`);
    else ctx.status(`${nameA}: ${nA} street segments · ${nameB}: ${nB} · ${formatKm(km)} km apart · ${v.radius} m radius`);
    const layers: Layer[] = [
      { name: nameA, color: colA, paths: pensA },
      { name: nameB, color: colB, paths: pensB },
    ];
    return layers.filter((l) => l.paths.length);
  },
});
