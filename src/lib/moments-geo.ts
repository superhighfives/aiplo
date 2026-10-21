/**
 * Map helpers for "Powers of ten": an orthographic globe, frame clipping (square or circle),
 * terrain sampling around a point, Natural Earth layers at several resolutions, and
 * the hull-based "callout" connectors between a magnified region and its enlargement.
 */
import { clipToRect, type Polyline, type Pt } from '../geom';
import { clipToCircle } from './osm';
import { loadTerrain } from './terrain';
import { contourLevels } from './elevation';
import { parseGeoLines, type LonLat } from './world';

const RAD = Math.PI / 180;
export const EARTH_R = 6371008.8; // m

// ------------------------------------------------------------------ frames

export interface Frame {
  cx: number;
  cy: number;
  /** Half the side (square) or the radius (circle), mm. */
  h: number;
  shape: 'square' | 'circle';
}

export function clipToFrame(paths: Polyline[], f: Frame): Polyline[] {
  return f.shape === 'circle' ? clipToCircle(paths, f.cx, f.cy, f.h) : clipToRect(paths, f.cx - f.h, f.cy - f.h, f.cx + f.h, f.cy + f.h);
}

export function frameOutline(f: Frame, inset = 0): Polyline {
  const h = f.h - inset;
  if (f.shape === 'circle') {
    const n = Math.max(48, Math.ceil(h * 4));
    return Array.from({ length: n + 1 }, (_, i) => [f.cx + Math.cos((i / n) * 2 * Math.PI) * h, f.cy + Math.sin((i / n) * 2 * Math.PI) * h] as Pt);
  }
  return [[f.cx - h, f.cy - h], [f.cx + h, f.cy - h], [f.cx + h, f.cy + h], [f.cx - h, f.cy + h], [f.cx - h, f.cy - h]];
}

const insideFrame = (p: Pt, f: Frame, eps = 1e-6) =>
  f.shape === 'circle' ? Math.hypot(p[0] - f.cx, p[1] - f.cy) < f.h - eps : Math.abs(p[0] - f.cx) < f.h - eps && Math.abs(p[1] - f.cy) < f.h - eps;

/** Removes the parts of lines that fall inside any of the frames (sampled every `step` mm). */
export function cutFrames(lines: Polyline[], frames: Frame[], step = 0.25): Polyline[] {
  const out: Polyline[] = [];
  const hit = (p: Pt) => frames.some((f) => insideFrame(p, f));
  for (const l of lines) {
    let cur: Polyline = [];
    for (let i = 1; i < l.length; i++) {
      const a = l[i - 1], b = l[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const q: Pt = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
        if (hit(q)) {
          if (cur.length > 1) out.push(cur);
          cur = [];
        } else cur.push(q);
      }
    }
    if (cur.length > 1) out.push(cur);
  }
  return out.map((l) => (l.length > 2 ? [l[0], l[l.length - 1]] : l)); // connectors are straight
}

/** Convex hull (Andrew's monotone chain), counter-clockwise in y-up terms. */
function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Callout lines from a small region (`a`) to its enlargement (`b`): the edges of the convex
 * hull of both outlines that join one to the other (the two outer tangents / corner lines).
 */
export function calloutLines(a: Frame, b: Frame): Polyline[] {
  const pa = frameOutline(a).slice(0, -1).map((p) => ({ p, s: 0 }));
  const pb = frameOutline(b).slice(0, -1).map((p) => ({ p, s: 1 }));
  const all = [...pa, ...pb];
  const key = (p: Pt) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const side = new Map(all.map((q) => [key(q.p), q.s]));
  const h = hull(all.map((q) => q.p));
  const out: Polyline[] = [];
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    if (side.get(key(p)) !== side.get(key(q))) out.push([p, q]);
  }
  return out;
}

// ------------------------------------------------------------------ globe

/** Orthographic globe centred on (lon0, lat0): lon/lat lines → mm, cut at the horizon. */
export function orthographic(lon0: number, lat0: number, cx: number, cy: number, R: number) {
  const sp0 = Math.sin(lat0 * RAD), cp0 = Math.cos(lat0 * RAD);
  const cosc = ([lon, lat]: LonLat) => sp0 * Math.sin(lat * RAD) + cp0 * Math.cos(lat * RAD) * Math.cos((lon - lon0) * RAD);
  const fwd = ([lon, lat]: LonLat): Pt => {
    const p = lat * RAD, dl = (lon - lon0) * RAD;
    return [cx + R * Math.cos(p) * Math.sin(dl), cy - R * (cp0 * Math.sin(p) - sp0 * Math.cos(p) * Math.cos(dl))];
  };
  const project = (line: LonLat[]): Polyline[] => {
    const out: Polyline[] = [];
    let cur: Polyline = [];
    for (let i = 0; i < line.length; i++) {
      const q = line[i];
      // Densify long steps so lines curve with the globe.
      const prev = i > 0 ? line[i - 1] : null;
      const steps = prev ? Math.max(1, Math.ceil(Math.max(Math.abs(q[0] - prev[0]) % 360, Math.abs(q[1] - prev[1])) / 2)) : 1;
      for (let k = prev ? 1 : 0; k <= (prev ? steps : 0); k++) {
        const t = prev ? k / steps : 1;
        const s: LonLat = prev ? [prev[0] + (q[0] - prev[0]) * t, prev[1] + (q[1] - prev[1]) * t] : q;
        if (cosc(s) >= 0) cur.push(fwd(s));
        else if (cur.length) {
          out.push(cur);
          cur = [];
        }
      }
    }
    if (cur.length > 1) out.push(cur);
    return out.filter((l) => l.length > 1);
  };
  return { fwd, project, visible: (p: LonLat) => cosc(p) >= 0 };
}

// ------------------------------------------------------------------ Natural Earth

const NE = (name: string) => `https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/${name}.geojson`;
const neCache = new Map<string, Promise<LonLat[][]>>();

/** Any Natural Earth GeoJSON layer as lon/lat lines (cached). */
export function naturalEarth(name: string): Promise<LonLat[][]> {
  let p = neCache.get(name);
  if (!p) {
    p = (async () => {
      let r: Response;
      try {
        r = await fetch(NE(name), { signal: AbortSignal.timeout(30000) });
      } catch (e) {
        throw new Error(`Couldn't load Natural Earth ${name} (${(e as Error).message})`);
      }
      if (!r.ok) throw new Error(`Natural Earth ${name}: HTTP ${r.status}`);
      return parseGeoLines(await r.json());
    })();
    p.catch(() => neCache.delete(name));
    neCache.set(name, p);
  }
  return p;
}

/** Keep only lines with a vertex within `deg` degrees (lat/lon box) of a point. */
export function nearLines(lines: LonLat[][], lon: number, lat: number, deg: number): LonLat[][] {
  const dlon = deg / Math.max(0.05, Math.cos(lat * RAD));
  const wrap = (d: number) => Math.abs(((((d + 180) % 360) + 360) % 360) - 180);
  return lines.filter((l) => l.some(([x, y]) => Math.abs(y - lat) <= deg && wrap(x - lon) <= dlon));
}

// ------------------------------------------------------------------ terrain

export interface TerrainPatch {
  /** Elevation in metres at a ground offset (east, north) in metres from the centre. */
  at(dx: number, dy: number): number;
  min: number;
  max: number;
}

/** Elevation tiles covering ±`half` metres around a point, at a zoom that gives ~600 px across. */
export async function terrainPatch(lat: number, lon: number, half: number): Promise<TerrainPatch> {
  const cosLat = Math.cos(lat * RAD);
  const want = (2 * half * 1.05) / 600; // m per px
  const z = Math.max(3, Math.min(15, Math.round(Math.log2((40075016.686 * cosLat) / (256 * want)))));
  const mpp = (40075016.686 * cosLat) / (256 * 2 ** z);
  const size = Math.min(1100, Math.ceil((2 * half * 1.05) / mpp) + 4);
  let t: Awaited<ReturnType<typeof loadTerrain>>;
  try {
    t = await loadTerrain(lat, lon, z, size);
  } catch (e) {
    throw new Error(`Couldn't load elevation tiles (${(e as Error).message})`);
  }
  const c = size / 2;
  // Robust range (tiles have the odd spike): 0.5th and 99.5th percentiles of a sample.
  const sample: number[] = [];
  for (let i = 0; i < t.data.length; i += 7) sample.push(t.data[i]);
  sample.sort((a, b) => a - b);
  const min = sample[Math.floor(sample.length * 0.005)] ?? 0;
  const max = sample[Math.floor(sample.length * 0.995)] ?? 0;
  return {
    min,
    max,
    at(dx, dy) {
      const x = Math.max(0, Math.min(size - 1.001, c + dx / mpp));
      const y = Math.max(0, Math.min(size - 1.001, c - dy / mpp));
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const i = y0 * size + x0, d = t.data;
      return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + size] * (1 - fx) + d[i + size + 1] * fx) * fy;
    },
  };
}

/** Contours of a terrain patch inside a frame whose half-size `h` mm spans `half` metres. */
export function patchContours(t: TerrainPatch, f: Frame, half: number, thresholds: number[], cell = 0.45): Polyline[][] {
  const W = 2 * f.h;
  const field = (u: number, v: number) => t.at((u - 0.5) * 2 * half, (0.5 - v) * 2 * half);
  return contourLevels(field, W, W, thresholds, cell).map((ls) => ls.map((l) => l.map(([x, y]) => [x + f.cx - f.h, y + f.cy - f.h] as Pt)));
}
