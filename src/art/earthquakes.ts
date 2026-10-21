import { circle, type Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { EARTH_RADIUS_KM, azimuthalEquidistant, coverBounds, graticule, loadCoastlines, mapLines, projectAll, type LonLat } from '../lib/world';
import { defineArtwork } from './types';

interface Quake {
  lon: number;
  lat: number;
  depth: number;
  mag: number;
  time: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = new Date();
const yearAgo = new Date(today.getTime() - 365 * 86400000);

const cache = new Map<string, Promise<Quake[]>>();

/** USGS FDSN event search (GeoJSON), biggest first. */
function fetchQuakes(lat: number, lon: number, radiusKm: number, start: string, end: string, minMag: number): Promise<Quake[]> {
  const q = new URLSearchParams({
    format: 'geojson',
    starttime: start,
    endtime: end,
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    maxradiuskm: String(Math.min(20001, Math.round(radiusKm))),
    minmagnitude: String(minMag),
    orderby: 'magnitude',
    limit: '3000',
  });
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${q}`;
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      } catch (e) {
        throw new Error(`Couldn't reach USGS (${(e as Error).message})`);
      }
      if (!res.ok) {
        const msg = (await res.text().catch(() => '')).split('\n').find((l) => l.startsWith('Error')) ?? '';
        throw new Error(`USGS: HTTP ${res.status} ${msg}`.trim());
      }
      const json = (await res.json()) as { features: { properties: { mag: number | null; time: number }; geometry: { coordinates: number[] } }[] };
      return json.features
        .filter((f) => f.properties.mag !== null && f.geometry?.coordinates?.length >= 2)
        .map((f) => ({
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          depth: f.geometry.coordinates[2] ?? 0,
          mag: f.properties.mag as number,
          time: f.properties.time,
        }));
    })();
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

export default defineArtwork({
  slug: 'earthquakes',
  title: 'Earthquakes',
  description: "A year of a region's earthquakes, each drawn as ripples that grow with its magnitude.",
  order: 26,
  paper: { paper: 'letter', orientation: 'portrait', margin: 18 },
  params: [
    { type: 'location', key: 'loc', label: 'Centre', default: { name: 'Japan', lat: 37.5, lon: 140.5 } },
    { type: 'number', key: 'radius', label: 'Radius (km)', min: 50, max: 5000, step: 50, default: 900, hint: 'Map half-width; quakes are searched a little beyond it' },
    { type: 'date', key: 'start', label: 'From', default: iso(yearAgo) },
    { type: 'date', key: 'end', label: 'To', default: iso(today) },
    { type: 'number', key: 'minMag', label: 'Minimum magnitude', min: 1, max: 8, step: 0.1, default: 4.5 },
    { type: 'number', key: 'perMag', label: 'Rings per magnitude', min: 0.5, max: 8, step: 0.5, default: 4 },
    { type: 'number', key: 'gap', label: 'Ring spacing (mm)', min: 0.3, max: 4, step: 0.05, default: 0.8 },
    { type: 'number', key: 'core', label: 'Centre dot (mm)', min: 0.2, max: 3, step: 0.05, default: 0.35 },
    { type: 'select', key: 'overlap', label: 'Overlaps', options: [['stack', 'Bigger quakes on top'], ['all', 'Draw every ring']], default: 'stack' },
    { type: 'select', key: 'pens', label: 'Quake pens', options: [['one', 'One pen'], ['depth', 'By depth: shallow, intermediate, deep']], default: 'depth' },
    { type: 'select', key: 'res', label: 'Coastline detail', options: [['50m', 'Detailed (1:50m)'], ['110m', 'Simple (1:110m)']], default: '50m' },
    { type: 'checkbox', key: 'graticule', label: 'Graticule (5°)', default: false },
    { type: 'checkbox', key: 'frame', label: 'Frame', default: true },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    if (!v.start || !v.end || v.start >= v.end) throw new Error('Pick a "From" date before the "To" date');
    const centre: LonLat = [v.loc.lon, v.loc.lat];
    // Map: azimuthal equidistant about the centre, filling the page with the radius across the short side.
    const r = v.radius / EARTH_RADIUS_KM;
    const aspect = W / H;
    const bounds: [number, number, number, number] = aspect < 1 ? [-r, -r / aspect, r, r / aspect] : [-r * aspect, -r, r * aspect, r];
    const searchKm = v.radius * Math.hypot(1, Math.max(aspect, 1 / aspect)) * 1.02; // reach the corners
    const proj = azimuthalEquidistant(centre, Math.min(180, (searchKm / EARTH_RADIUS_KM) * (180 / Math.PI) * 1.1));
    const fit = coverBounds(bounds, W, H);

    ctx.status('Loading coastlines and earthquakes…');
    const [coast, quakes] = await Promise.all([
      loadCoastlines(v.res),
      fetchQuakes(v.loc.lat, v.loc.lon, searchKm, v.start, v.end, v.minMag),
    ]);
    const land = mapLines(projectAll(coast, proj), fit);
    const grid = v.graticule ? mapLines(projectAll(graticule(5, { maxLat: 85 }), proj), fit) : [];

    // Biggest first: each quake's ripples hide behind the discs of bigger ones already drawn,
    // like overlapping ripple patterns, so busy aftershock clusters don't flood with ink.
    const shown = quakes.filter((q) => q.mag >= v.minMag).sort((a, b) => b.mag - a.mag);
    const bands = v.pens === 'depth' ? [70, 300, Infinity] : [Infinity];
    const rings: Polyline[][] = bands.map(() => []);
    const discs: [number, number, number][] = [];
    const hidden = (x: number, y: number) => v.overlap === 'stack' && discs.some(([cx, cy, R]) => (x - cx) ** 2 + (y - cy) ** 2 < R * R);
    let maxMag = 0;
    for (const q of shown) {
      const [x, y] = fit.map(proj.forward([q.lon, q.lat]));
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      maxMag = Math.max(maxMag, q.mag);
      const n = 1 + Math.floor((q.mag - v.minMag) * v.perMag);
      const band = bands.findIndex((b) => q.depth < b);
      const out = rings[band < 0 ? bands.length - 1 : band];
      const R = v.core + n * v.gap;
      for (let k = 0; k <= n; k++) {
        const rr = v.core + k * v.gap;
        const c = circle(x, y, rr, Math.max(12, Math.round(rr * 5)));
        let cur: Polyline = [];
        for (const p of c) {
          if (hidden(p[0], p[1])) {
            if (cur.length > 1) out.push(cur);
            cur = [];
          } else cur.push(p);
        }
        if (cur.length > 1) out.push(cur);
      }
      discs.push([x, y, R + v.gap * 0.5]);
    }
    ctx.status(`${shown.length} earthquakes ≥ M${v.minMag}${shown.length ? `, largest M${maxMag.toFixed(1)}` : ''} · ${v.start} to ${v.end}`);

    const layers: Layer[] = [{ name: 'Coastline', color: PALETTE[0], paths: [...land, ...grid] }];
    if (v.frame) layers[0].paths.push([[0, 0], [W, 0], [W, H], [0, H], [0, 0]]);
    if (v.pens === 'depth') {
      const names = ['Shallow (< 70 km)', 'Intermediate (70–300 km)', 'Deep (> 300 km)'];
      const colors = [PALETTE[1], PALETTE[5], PALETTE[2]];
      rings.forEach((paths, i) => paths.length && layers.push({ name: names[i], color: colors[i], paths }));
    } else layers.push({ name: 'Earthquakes', color: PALETTE[1], paths: rings[0] });
    return layers;
  },
});
