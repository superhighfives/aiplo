import type { Polyline, Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { localToUTC, zoneOffset } from '../lib/astro';
import { coastline, loadTerrainFor, terrainParams } from '../lib/elevation';
import { jitteredGrid, streamlines } from '../lib/streamlines';
import { fetchArchive } from '../lib/weather';
import { shuffle } from '../random';
import { defineArtwork } from './types';

/** Catmull-Rom weights for fractional position t. */
function cr(t: number): [number, number, number, number] {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}
/** Bicubic interpolation of an n×n grid (row-major, row 0 = top) at u, v in [0, 1]. */
function bicubic(g: Float64Array, n: number, u: number, v: number): number {
  const x = u * (n - 1), y = v * (n - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const wx = cr(x - x0), wy = cr(y - y0);
  let s = 0;
  for (let j = 0; j < 4; j++) {
    const yy = Math.max(0, Math.min(n - 1, y0 - 1 + j));
    for (let i = 0; i < 4; i++) {
      const xx = Math.max(0, Math.min(n - 1, x0 - 1 + i));
      s += g[yy * n + xx] * wx[i] * wy[j];
    }
  }
  return s;
}

const addDays = (date: string, n: number) => new Date(Date.parse(date.slice(0, 10) + 'T00:00Z') + n * 86400_000).toISOString().slice(0, 10);

export default defineArtwork({
  slug: 'wind',
  title: 'Wind on a day',
  description: 'The real wind at a place and hour, from reanalysis data, drawn as evenly spaced streamlines.',
  order: 33,
  paper: { paper: 'letter', orientation: 'landscape', margin: 15 },
  params: [
    ...terrainParams({ name: 'Brest, France', lat: 48.39, lon: -4.49 }, 6),
    { type: 'date', key: 'date', label: 'Date & time (local)', time: true, default: '2023-11-02T03:00', hint: 'Default: Storm Ciarán crossing the Channel' },
    {
      type: 'select', key: 'tz', label: 'Time zone', default: 'auto',
      options: [['auto', 'Guess from longitude'], ['manual', 'UTC offset…']],
      hint: 'The guess is longitude ÷ 15 rounded to the hour, ignoring daylight saving',
    },
    { type: 'number', key: 'utcOffset', label: 'UTC offset (h)', min: -12, max: 14, step: 0.25, default: 0, show: (v) => v.tz === 'manual' },
    { type: 'number', key: 'grid', label: 'Sample grid', min: 4, max: 10, step: 1, default: 8, hint: 'Points per side fetched from Open-Meteo' },
    { type: 'number', key: 'dsep', label: 'Spacing (mm)', min: 1, max: 12, step: 0.1, default: 3 },
    { type: 'number', key: 'maxLen', label: 'Max length (mm)', min: 5, max: 400, step: 5, default: 60 },
    { type: 'number', key: 'density', label: 'Denser where windier', min: 0, max: 0.8, step: 0.05, default: 0.5, hint: '0 = even spacing everywhere' },
    { type: 'checkbox', key: 'lengthBySpeed', label: 'Longer where windier', default: true },
    { type: 'checkbox', key: 'arrows', label: 'Arrowheads', default: true, hint: 'Show which way the wind blows' },
    { type: 'checkbox', key: 'coast', label: 'Coastline', default: true, hint: 'On a second pen' },
    { type: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const { lat, lon } = v.loc;
    const n = Math.round(v.grid);

    // Area: the same ground the terrain knobs would show (so the coastline lines up).
    let map: Awaited<ReturnType<typeof loadTerrainFor>> | null = null;
    let groundW: number;
    if (v.coast) {
      map = await loadTerrainFor(v, ctx);
      groundW = map.groundWidth;
    } else {
      const latR = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
      const side = v.span * 256 * ((40075016.686 * Math.cos(latR)) / (256 * 2 ** v.zoom));
      groundW = W >= H ? side : side * (W / H);
    }
    const groundH = groundW * (H / W);
    const mPerDegLat = 110574;
    const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const lats: number[] = [], lons: number[] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        lats.push(lat + ((0.5 - j / (n - 1)) * groundH) / mPerDegLat);
        lons.push(lon + ((i / (n - 1) - 0.5) * groundW) / mPerDegLon);
      }

    const offset = v.tz === 'manual' ? v.utcOffset : zoneOffset(lon);
    const utc = new Date(localToUTC(v.date, offset));
    const iso = utc.toISOString().slice(0, 13) + ':00';
    const day = iso.slice(0, 10);
    ctx.status(`Fetching wind at ${n * n} points…`);
    const pts = await fetchArchive({
      lat: lats, lon: lons, start: addDays(day, -1), end: addDays(day, 1),
      hourly: ['wind_speed_10m', 'wind_direction_10m'], extra: { timezone: 'GMT' },
    });
    if (pts.length !== n * n) throw new Error(`Open-Meteo returned ${pts.length} points, expected ${n * n}`);
    const U = new Float64Array(n * n), V = new Float64Array(n * n), S = new Float64Array(n * n);
    pts.forEach((p, k) => {
      const i = p.hourly!.time.indexOf(iso);
      if (i < 0) throw new Error(`No wind data for ${iso} UTC`);
      const sp = p.hourly!.wind_speed_10m[i], dir = p.hourly!.wind_direction_10m[i];
      if (sp == null || dir == null) throw new Error(`Missing wind data for ${iso} UTC`);
      const a = (dir * Math.PI) / 180;
      // Direction is where the wind comes FROM; paper y points south.
      U[k] = -Math.sin(a) * sp;
      V[k] = Math.cos(a) * sp;
      S[k] = sp;
    });
    let smin = Infinity, smax = 0, mean = 0;
    for (const s of S) { smin = Math.min(smin, s); smax = Math.max(smax, s); mean += s / S.length; }

    const field = (x: number, y: number): Pt | null => {
      const u = bicubic(U, n, x / W, y / H), w = bicubic(V, n, x / W, y / H);
      const m = Math.hypot(u, w);
      return m < 1e-6 ? null : [u / m, w / m];
    };
    const speed = (x: number, y: number) => Math.hypot(bicubic(U, n, x / W, y / H), bicubic(V, n, x / W, y / H));
    const norm = (s: number) => (smax > smin ? Math.max(0, Math.min(1, (s - smin) / (smax - smin))) : 0.5);

    let lines = streamlines({
      width: W, height: H, field,
      seeds: shuffle(jitteredGrid(W, H, v.dsep * 0.6, ctx.rng), ctx.rng),
      dsep: v.dsep,
      dtest: v.dsep * 0.5,
      sep: v.density > 0 ? (x, y) => v.dsep * (1 - v.density * norm(speed(x, y))) : undefined,
      step: Math.min(0.5, v.dsep / 4),
      maxLen: v.maxLen,
      minLen: Math.min(v.maxLen * 0.3, v.dsep * 2),
      bidirectional: true,
    });

    if (v.lengthBySpeed) {
      // Trim each line around its middle to a length that grows with local wind speed.
      lines = lines.map((l) => {
        const mid = l[Math.floor(l.length / 2)];
        const want = v.maxLen * (0.3 + 0.7 * norm(speed(mid[0], mid[1])));
        const step = Math.min(0.5, v.dsep / 4);
        const keep = Math.max(2, Math.round(want / step));
        if (l.length <= keep) return l;
        const s = Math.floor((l.length - keep) / 2);
        return l.slice(s, s + keep);
      });
    }

    const ink: Polyline[] = [...lines];
    if (v.arrows) {
      for (const l of lines) {
        if (l.length < 4) continue;
        const tip = l[l.length - 1];
        // Direction from a point ~1 mm back.
        let k = l.length - 2, d = 0;
        while (k > 0 && d < 1) { d = Math.hypot(tip[0] - l[k][0], tip[1] - l[k][1]); k--; }
        const dx = (tip[0] - l[k][0]) / (d || 1), dy = (tip[1] - l[k][1]) / (d || 1);
        const s = Math.min(1.4, v.dsep * 0.4);
        const back: Pt = [tip[0] - dx * s, tip[1] - dy * s];
        ink.push([[back[0] - dy * s * 0.45, back[1] + dx * s * 0.45], tip, [back[0] + dy * s * 0.45, back[1] - dx * s * 0.45]]);
      }
    }

    ctx.status(`${iso.replace('T', ' ')} UTC · wind ${Math.round(smin)}–${Math.round(smax)} km/h (mean ${Math.round(mean)}) · ${lines.length} lines`);
    const layers: Layer[] = [{ name: 'Wind', color: PALETTE[0], paths: ink }];
    const coast = map ? coastline(map, W, H) : [];
    if (coast.length) layers.push({ name: 'Coastline', color: PALETTE[2], paths: coast });
    return layers;
  },
});
