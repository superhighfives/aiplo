import { smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { loadTerrainFor, ridges } from '../lib/elevation';
import { loadFiles, type FileRef } from '../lib/files';
import { gpxSegments, parseGpx, type GpxPoint } from '../lib/gpx';
import { noise2DFrom, type Rng } from '../random';
import { defineArtwork } from './types';

const DEMO_HOME = { name: 'Boulder, Colorado', lat: 40.0150, lon: -105.2705 };

/** Web Mercator in "world pixels" at zoom 0 (256 px wide world); multiply by 2^z for zoom z. */
const merc = (lat: number, lon: number): Pt => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return [((lon + 180) / 360) * 256, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256];
};
const unmerc = ([x, y]: Pt): { lat: number; lon: number } => ({
  lon: (x / 256) * 360 - 180,
  lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 256))) * 180) / Math.PI,
});

/** A few plausible runs: loops through random waypoints, on a street grid near home or on smooth wandering trails. */
function demoRoutes(count: number, rng: Rng, seed: number): GpxPoint[][] {
  const noise = noise2DFrom(seed);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((DEMO_HOME.lat * Math.PI) / 180);
  const out: GpxPoint[][] = [];
  const BLOCK = 160; // metres between streets
  const snap = (v: number) => Math.round(v / BLOCK) * BLOCK;
  for (let r = 0; r < count; r++) {
    const street = rng() < 0.55;
    const R = (street ? 700 : 1500) + rng() * (street ? 1800 : 3500);
    const n = 3 + Math.floor(rng() * 4);
    const dir = rng() * Math.PI * 2;
    // Loop centred away from home so it starts and ends there.
    const c: Pt = [Math.cos(dir) * R, Math.sin(dir) * R];
    const start = dir + Math.PI;
    const sense = rng() < 0.5 ? 1 : -1;
    const way: Pt[] = [[0, 0]];
    for (let i = 1; i < n; i++) {
      const a = start + sense * ((i + (rng() - 0.5) * 0.6) / n) * Math.PI * 2;
      const rr = R * (0.6 + rng() * 0.6);
      way.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr]);
    }
    way.push([0, 0]);
    const path: Pt[] = [];
    let total = 0;
    if (street) {
      // Along the streets: L-shaped legs between snapped waypoints.
      const w = way.map(([x, y]) => [snap(x), snap(y)] as Pt);
      path.push(w[0]);
      for (let i = 1; i < w.length; i++) {
        const [ax, ay] = w[i - 1], [bx, by] = w[i];
        // A staircase of 1-3 steps, turning at street corners.
        const steps = 1 + Math.floor(rng() * 3);
        const xFirst = rng() < 0.5;
        let [px, py] = [ax, ay];
        for (let k = 1; k <= steps; k++) {
          const nx = k === steps ? bx : snap(ax + ((bx - ax) * k) / steps + (rng() - 0.5) * BLOCK * 2);
          const ny = k === steps ? by : snap(ay + ((by - ay) * k) / steps + (rng() - 0.5) * BLOCK * 2);
          path.push(xFirst ? [nx, py] : [px, ny], [nx, ny]);
          [px, py] = [nx, ny];
        }
      }
    } else {
      // Trails: Catmull-Rom through the waypoints, then wobble sideways with noise.
      for (let i = 0; i < way.length - 1; i++) {
        const p0 = way[Math.max(0, i - 1)], p1 = way[i], p2 = way[i + 1], p3 = way[Math.min(way.length - 1, i + 2)];
        for (let k = 0; k < 40; k++) {
          const t = k / 40, t2 = t * t, t3 = t2 * t;
          const f = (a: number, b: number, cc: number, d: number) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
          path.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
        }
      }
      path.push([0, 0]);
    }
    total = pathLen(path);
    // Resample every ~10 m with a little GPS jitter, plus meander on trails.
    const pts: GpxPoint[] = [];
    let walked = 0;
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1], [bx, by] = path[i];
      const len = Math.hypot(bx - ax, by - ay);
      const m = Math.max(1, Math.ceil(len / 10));
      for (let k = 0; k < m; k++) {
        const t = k / m;
        let x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        walked += len / m;
        const fade = Math.min(1, walked / 300, Math.max(0, (total - walked) / 300));
        if (!street) {
          const nx = -(by - ay) / (len || 1), ny = (bx - ax) / (len || 1);
          const m2 = (noise(walked / 1500, r * 5.7) * 110 + noise(walked / 260, r * 9.1 + 40) * 25) * fade;
          x += nx * m2; y += ny * m2;
        }
        x += (rng() - 0.5) * 4; y += (rng() - 0.5) * 4;
        pts.push({ lat: DEMO_HOME.lat + y / mPerDegLat, lon: DEMO_HOME.lon + x / mPerDegLon });
      }
    }
    pts.push({ lat: DEMO_HOME.lat, lon: DEMO_HOME.lon });
    out.push(pts);
  }
  return out;
}

const pathLen = (p: Pt[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0), 0);

/** Splits lines wherever `mask` is true at a sample point. */
function cutByMask(lines: Polyline[], mask: (p: Pt) => boolean): Polyline[] {
  const out: Polyline[] = [];
  for (const l of lines) {
    let cur: Polyline = [];
    for (const p of l) {
      if (mask(p)) {
        if (cur.length > 1) out.push(cur);
        cur = [];
      } else cur.push(p);
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

export default defineArtwork({
  slug: 'routes',
  title: 'Your runs or rides',
  description: 'Every GPS track you drop in, layered over each other, optionally over the terrain they crossed.',
  order: 24,
  paper: { paper: 'square', margin: 20 },
  params: [
    { type: 'file', key: 'files', label: 'GPX files', accept: '.gpx,application/gpx+xml', multiple: true, default: [], hint: 'Without files, a few made-up loops around Boulder are drawn' },
    { type: 'number', key: 'demoCount', label: 'Demo routes', min: 1, max: 40, step: 1, default: 14, show: (v) => !(v.files as FileRef[])?.length },
    { type: 'seed', key: 'seed', label: 'Seed', default: 3 },
    { type: 'number', key: 'pad', label: 'Padding (%)', min: 0, max: 40, step: 1, default: 8 },
    { type: 'number', key: 'curves', label: 'Smoothing (mm)', min: 0, max: 3, step: 0.1, default: 0.4, hint: 'Rounds off GPS jitter' },
    { type: 'number', key: 'repeat', label: 'Pass each route', min: 1, max: 3, step: 1, default: 1, hint: 'Draw each route this many times for a bolder line' },
    { type: 'select', key: 'colours', label: 'Route pens', options: [['one', 'One pen'], ['cycle', 'Alternate 3 pens']], default: 'one' },
    { type: 'checkbox', key: 'terrain', label: 'Terrain ridgelines underneath', default: true },
    { type: 'number', key: 'rows', label: 'Ridge rows', min: 20, max: 200, step: 1, default: 70, show: (v) => v.terrain },
    { type: 'number', key: 'ridgeHeight', label: 'Ridge height (mm)', min: 0, max: 30, step: 0.5, default: 9, show: (v) => v.terrain },
    { type: 'number', key: 'clearance', label: 'Gap round routes (mm)', min: 0, max: 4, step: 0.1, default: 1.2, show: (v) => v.terrain, hint: 'Ridgelines stop short of the routes so they read clearly' },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const files = await loadFiles(v.files);
    let segs: GpxPoint[][] = [];
    for (const f of files) {
      ctx.status(`Reading ${f.name}…`);
      const tracks = parseGpx(await f.blob.text());
      if (!tracks.length) throw new Error(`${f.name}: no track or route points found`);
      segs.push(...gpxSegments(tracks));
    }
    const demo = !segs.length;
    if (demo) segs = demoRoutes(v.demoCount, ctx.rng, ctx.seed);
    segs = segs.filter((s) => s.length > 1);
    if (!segs.length) throw new Error('The GPX files have no usable tracks');

    // Bounding box in Mercator world px (zoom 0).
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const mpts = segs.map((s) => s.map((p) => merc(p.lat, p.lon)));
    for (const s of mpts) for (const [x, y] of s) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const pad = 1 + (2 * v.pad) / 100;
    const bw = Math.max(1e-7, x1 - x0) * pad, bh = Math.max(1e-7, y1 - y0) * pad;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const aspect = W / H;

    const scale = Math.min(W / bw, H / bh); // mm per zoom-0 px
    // Terrain: the most detailed (zoom, span) whose crop covers the page; its height field is then
    // rescaled about the shared centre so it lines up with the routes exactly.
    let terrainView: { zoom: number; span: number; k: number } | null = null;
    if (v.terrain) {
      const pageW = W / scale;
      for (let zoom = 16; zoom >= 5 && !terrainView; zoom--)
        for (let span = 1; span <= 3 && !terrainView; span++) {
          const px = (span * 256) / 2 ** zoom;
          const cw = aspect >= 1 ? px : px * aspect;
          if (cw >= pageW) terrainView = { zoom, span, k: pageW / cw };
        }
    }
    const toMm = ([x, y]: Pt): Pt => [W / 2 + (x - cx) * scale, H / 2 + (y - cy) * scale];
    const routes = mpts.map((s) => smooth(s.map(toMm), v.curves));

    const routeLayers: Layer[] =
      v.colours === 'cycle'
        ? [1, 2, 3].map((c, k) => ({ name: `Routes ${k + 1}`, color: PALETTE[c], paths: [] as Polyline[] }))
        : [{ name: 'Routes', color: PALETTE[1], paths: [] }];
    routes.forEach((r, i) => {
      const layer = routeLayers[i % routeLayers.length];
      for (let k = 0; k < v.repeat; k++) layer.paths.push(k % 2 ? r.slice().reverse() : r);
    });

    const layers: Layer[] = [];
    if (terrainView) {
      const centre = unmerc([cx, cy]);
      const tv = { loc: { name: demo ? DEMO_HOME.name : 'route area', ...centre }, zoom: terrainView.zoom, span: terrainView.span, blur: 1, clampSea: true };
      const map = await loadTerrainFor(tv, ctx);
      const k = terrainView.k;
      const height = (u: number, vv: number) => map.height(0.5 + (u - 0.5) * k, 0.5 + (vv - 0.5) * k);
      let ridgeLines = ridges(height, W, H, { rows: v.rows, height: v.ridgeHeight, perspective: 0 });
      if (v.clearance > 0) {
        // Rasterise the routes into a coarse mask, grown by the clearance.
        const cell = 0.25;
        const nx = Math.ceil(W / cell) + 1, ny = Math.ceil(H / cell) + 1;
        const mask = new Uint8Array(nx * ny);
        const rr = Math.ceil(v.clearance / cell);
        const stamp = (x: number, y: number) => {
          const ci = Math.round(x / cell), cj = Math.round(y / cell);
          for (let j = -rr; j <= rr; j++)
            for (let i = -rr; i <= rr; i++) {
              if (i * i + j * j > rr * rr) continue;
              const a = ci + i, b = cj + j;
              if (a >= 0 && a < nx && b >= 0 && b < ny) mask[b * nx + a] = 1;
            }
        };
        for (const r of routes)
          for (let k = 1; k < r.length; k++) {
            const [ax, ay] = r[k - 1], [bx, by] = r[k];
            const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / cell));
            for (let s = 0; s <= n; s++) stamp(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n);
          }
        ridgeLines = cutByMask(ridgeLines, ([x, y]) => {
          const i = Math.round(x / cell), j = Math.round(y / cell);
          return i >= 0 && i < nx && j >= 0 && j < ny && mask[j * nx + i] === 1;
        });
      }
      layers.push({ name: 'Terrain', color: PALETTE[0], paths: ridgeLines });
    }
    layers.push(...routeLayers.filter((l) => l.paths.length));
    const km = segs.reduce((s, seg) => {
      for (let i = 1; i < seg.length; i++) {
        const a = seg[i - 1], b = seg[i];
        const dy = (b.lat - a.lat) * 111.32, dx = (b.lon - a.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
        s += Math.hypot(dx, dy);
      }
      return s;
    }, 0);
    ctx.status(`${demo ? 'Demo: ' : ''}${segs.length} routes · ${Math.round(km)} km${terrainView ? ` · terrain z${terrainView.zoom}` : ''}`);
    return layers;
  },
});
