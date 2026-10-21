import { circle, type Polyline, type Pt } from '../geom';
import type { Box } from '../lib/world';
import { PALETTE, type Layer } from '../layers';
import { measureText, text } from '../lib/hershey';
import { EARTH_RADIUS_KM, azimuthalEquidistant, boxOf, cutAround, fitBounds, graticule, loadCoastlines, mapLines, projectAll, type LonLat } from '../lib/world';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'world-from-home',
  title: 'The world from your door',
  description: 'The whole Earth as seen from one place: true distances and directions out to the far side of the world.',
  order: 21,
  paper: { paper: 'square', margin: 18 },
  params: [
    { type: 'location', key: 'loc', label: 'Home', default: { name: 'London, UK', lat: 51.5072, lon: -0.1276 } },
    { type: 'select', key: 'res', label: 'Coastline detail', options: [['110m', 'Simple (1:110m)'], ['50m', 'Detailed (1:50m)']], default: '110m' },
    { type: 'number', key: 'ringKm', label: 'Ring every (km)', min: 500, max: 10000, step: 250, default: 2500 },
    { type: 'checkbox', key: 'labels', label: 'Distance labels', default: true },
    { type: 'number', key: 'labelAngle', label: 'Labels along (°)', min: 0, max: 355, step: 5, default: 150, show: (v) => v.labels, hint: 'Bearing from home the labels line up along; clockwise from north' },
    { type: 'number', key: 'spokes', label: 'Radial lines', min: 0, max: 72, step: 1, default: 8, hint: 'Compass bearings out from home; 0 = none' },
    { type: 'checkbox', key: 'graticule', label: 'Graticule', default: false, hint: 'Lines of latitude and longitude every 30°, bent by the projection' },
    { type: 'checkbox', key: 'oneColour', label: 'Single pen', default: false },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    ctx.status('Loading coastlines…');
    const coast = await loadCoastlines(v.res);
    const home: LonLat = [v.loc.lon, v.loc.lat];
    const proj = azimuthalEquidistant(home);
    const fit = fitBounds(proj.bounds, W, H, 0.5);
    const R = Math.PI * fit.scale; // mm radius of the antipode circle
    const kmToMm = fit.scale / EARTH_RADIUS_KM;
    const c: Pt = fit.map([0, 0]);

    const land = mapLines(projectAll(coast, proj), fit);
    const grid: Polyline[] = v.graticule ? mapLines(projectAll(graticule(30), proj), fit) : [];
    const rings: Polyline[] = [circle(c[0], c[1], R, 720)];
    const labels: Polyline[] = [];
    const spokes: Polyline[] = [];
    const boxes: Box[] = [];
    const maxKm = Math.PI * EARTH_RADIUS_KM;
    const la = (v.labelAngle * Math.PI) / 180;
    const dir: Pt = [Math.sin(la), -Math.cos(la)];
    for (let km = v.ringKm; km < maxKm - v.ringKm * 0.3; km += v.ringKm) {
      const r = km * kmToMm;
      if (!v.labels) {
        rings.push(circle(c[0], c[1], r, Math.max(64, Math.round(r * 3))));
        continue;
      }
      // Break the ring where its label sits, and write the distance there.
      const str = `${km.toLocaleString('en-US')} km`;
      const size = Math.max(1.6, Math.min(2.6, R / 45));
      const tw = measureText(str, { size });
      const gap = (tw / 2 + size * 0.8) / r; // half-angle of the gap
      const n = Math.max(64, Math.round(r * 3));
      const a0 = Math.atan2(dir[1], dir[0]);
      const arc: Polyline = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + gap + (i / n) * (2 * Math.PI - 2 * gap);
        arc.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
      }
      rings.push(arc);
      const lp: Pt = [c[0] + dir[0] * r, c[1] + dir[1] * r];
      const t = text(str, { size, x: lp[0], y: lp[1] + size / 2, align: 'center' });
      boxes.push(boxOf(t, size * 0.5));
      labels.push(...t);
    }
    if (v.spokes > 0) {
      const inner = Math.max(2, R * 0.03);
      for (let k = 0; k < v.spokes; k++) {
        const a = (k / v.spokes) * Math.PI * 2;
        const d: Pt = [Math.sin(a), -Math.cos(a)];
        spokes.push([[c[0] + d[0] * inner, c[1] + d[1] * inner], [c[0] + d[0] * R, c[1] + d[1] * R]]);
      }
    }
    // Home: a small cross.
    const m = Math.max(1.5, R * 0.015);
    const landCut = cutAround(land, boxes);
    const gridCut = cutAround(grid, boxes);
    const spokesCut = cutAround(spokes, boxes);
    rings.push([[c[0] - m, c[1]], [c[0] + m, c[1]]], [[c[0], c[1] - m], [c[0], c[1] + m]]);

    ctx.status(`${v.loc.name.split(',')[0]} · antipode ${Math.round(maxKm).toLocaleString('en-US')} km away`);
    if (v.oneColour) return [...landCut, ...gridCut, ...rings, ...labels, ...spokesCut];
    const layers: Layer[] = [
      { name: 'Coastlines', color: PALETTE[0], paths: landCut },
      { name: 'Distances', color: PALETTE[1], paths: [...rings, ...labels, ...spokesCut] },
    ];
    if (grid.length) layers.splice(1, 0, { name: 'Graticule', color: PALETTE[2], paths: gridCut });
    return layers;
  },
});
