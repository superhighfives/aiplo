import { circle, resample, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { text } from '../lib/hershey';
import {
  boxOf, cutAround, distanceKm, equirectangular, fitBounds, graticule, greatCircle, loadCoastlines, mapLines, naturalEarth, projectAll,
  type Box, type LonLat,
} from '../lib/world';
import type { Location, PlaceList } from '../params';
import { defineArtwork } from './types';

const DEFAULT_PLACES = [
  '51.5072, -0.1276 London',
  '40.7128, -74.0060 New York',
  '19.4326, -99.1332 Mexico City',
  '-33.4489, -70.6693 Santiago',
  '-33.8688, 151.2093 Sydney',
  '35.6762, 139.6503 Tokyo',
  '1.3521, 103.8198 Singapore',
  '-33.9249, 18.4241 Cape Town',
  '64.1466, -21.9426 Reykjavik',
].join('\n');

function parseDefault(t: string): Location[] {
  return t.split('\n').map((l) => {
    const m = l.match(/^(-?[\d.]+),\s*(-?[\d.]+)\s+(.+)$/)!;
    return { name: m[3], lat: Number(m[1]), lon: Number(m[2]) };
  });
}

/** Breaks lines into dashes: `on` mm drawn, `off` mm skipped. */
function dashed(lines: Polyline[], on: number, off: number): Polyline[] {
  const out: Polyline[] = [];
  for (const l of lines) {
    const pts = resample(l, Math.min(on, off) / 2);
    let d = 0, cur: Polyline = [];
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const phase = d % (on + off);
      if (phase <= on) cur.push(pts[i]);
      else if (cur.length) {
        if (cur.length > 1) out.push(cur);
        cur = [];
      }
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

export default defineArtwork({
  slug: 'everywhere',
  title: "Everywhere you've been",
  description: 'Great-circle arcs between the places in your life, over a world map.',
  order: 22,
  paper: { paper: 'letter', orientation: 'landscape', margin: 15 },
  params: [
    { type: 'places', key: 'places', label: 'Places', default: { text: DEFAULT_PLACES, places: parseDefault(DEFAULT_PLACES) }, hint: 'One place per line, in order; or "lat, lon Name"' },
    { type: 'select', key: 'link', label: 'Connect', options: [['chain', 'One after another'], ['home', 'All from the first place'], ['all', 'Every pair']], default: 'chain' },
    { type: 'checkbox', key: 'loop', label: 'Back to the start', default: false, show: (v) => v.link === 'chain' },
    { type: 'select', key: 'proj', label: 'Projection', options: [['ne', 'Natural Earth'], ['eq', 'Equirectangular']], default: 'ne' },
    { type: 'number', key: 'lon0', label: 'Centre longitude', min: -180, max: 180, step: 5, default: 10, hint: 'Shift where the map splits; arcs crossing the edge are cut cleanly' },
    { type: 'select', key: 'res', label: 'Coastline detail', options: [['110m', 'Simple (1:110m)'], ['50m', 'Detailed (1:50m)']], default: '110m' },
    { type: 'select', key: 'coastStyle', label: 'Coastline', options: [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['none', 'None']], default: 'solid' },
    { type: 'checkbox', key: 'graticule', label: 'Graticule', default: true },
    { type: 'checkbox', key: 'outline', label: 'Map outline', default: true },
    { type: 'number', key: 'dot', label: 'Place circles (mm)', min: 0, max: 5, step: 0.25, default: 1.25 },
    { type: 'checkbox', key: 'labels', label: 'Labels', default: true },
    { type: 'number', key: 'labelSize', label: 'Label size (mm)', min: 1.2, max: 5, step: 0.1, default: 2.2, show: (v) => v.labels },
  ],
  caption: (v) => (v.places as PlaceList).places.map((p) => p.name.split(',')[0]).join(' · '),
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const places = (v.places as PlaceList).places;
    if (!places.length) throw new Error('No places: add some and press "Find all"');
    ctx.status('Loading coastlines…');
    const coast = v.coastStyle === 'none' ? [] : await loadCoastlines(v.res);
    const proj = v.proj === 'eq' ? equirectangular(v.lon0) : naturalEarth(v.lon0);
    const fit = fitBounds(proj.bounds, W, H, 0.5);
    const pt = (p: Location): LonLat => [p.lon, p.lat];

    // Arcs
    const pairs: [Location, Location][] = [];
    if (v.link === 'home') for (let i = 1; i < places.length; i++) pairs.push([places[0], places[i]]);
    else if (v.link === 'all') for (let i = 0; i < places.length; i++) for (let j = i + 1; j < places.length; j++) pairs.push([places[i], places[j]]);
    else {
      for (let i = 1; i < places.length; i++) pairs.push([places[i - 1], places[i]]);
      if (v.loop && places.length > 2) pairs.push([places[places.length - 1], places[0]]);
    }
    const arcs = mapLines(projectAll(pairs.map(([a, b]) => greatCircle(pt(a), pt(b), 0.5)), proj), fit);

    // Places + labels (dedupe repeated places)
    const seen = new Set<string>();
    const unique = places.filter((p) => {
      const k = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    const dots: Polyline[] = [];
    const labels: Polyline[] = [];
    const boxes: Box[] = [];
    for (const p of unique) {
      const [x, y]: Pt = fit.map(proj.forward(pt(p)));
      if (v.dot > 0) {
        dots.push(circle(x, y, v.dot, 24));
        boxes.push([x - v.dot - 0.6, y - v.dot - 0.6, x + v.dot + 0.6, y + v.dot + 0.6]);
      }
      if (v.labels) {
        const s = v.labelSize;
        const right = x < W - 30;
        const t = text(p.name.split(',')[0], { size: s, x: x + (right ? 1 : -1) * (v.dot + s * 0.6), y: y + s / 2, align: right ? 'left' : 'right' });
        labels.push(...t);
        boxes.push(boxOf(t, s * 0.35));
      }
    }

    let land = mapLines(projectAll(coast, proj), fit);
    if (v.coastStyle === 'dashed') land = dashed(land, 1.6, 1.0);
    if (v.coastStyle === 'dotted') land = dashed(land, 0.3, 0.9);
    const grid = v.graticule ? dashed(mapLines(projectAll(graticule(30), proj), fit), 0.6, 1.4) : [];
    const outline = v.outline ? mapLines(proj.outline(), fit) : [];

    const layers: Layer[] = [
      { name: 'Map', color: PALETTE[0], paths: cutAround([...land, ...grid, ...outline], boxes) },
      { name: 'Journeys', color: PALETTE[1], paths: [...cutAround(arcs, boxes), ...dots] },
    ];
    if (labels.length) layers.push({ name: 'Labels', color: PALETTE[0], paths: labels });
    const km = pairs.reduce((s, [a, b]) => s + distanceKm(pt(a), pt(b)), 0);
    ctx.status(`${unique.length} places · ${pairs.length} journeys · ${Math.round(km).toLocaleString('en-US')} km`);
    return layers;
  },
});

