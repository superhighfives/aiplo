// World maps: Natural Earth coastlines, a few projections that cut lines properly at their
// seams (antimeridian, antipode, clip circle), great-circle interpolation and graticules.
// Projections work in "unit" coordinates (radians-ish, y up); `fitBounds` maps them to mm.
import type { Polyline, Pt } from '../geom';

/** [lon, lat] in degrees. */
export type LonLat = [number, number];

const RAD = Math.PI / 180;
export const EARTH_RADIUS_KM = 6371.0088;

// ---------------------------------------------------------------- coastlines

const NE_URL = (res: string) =>
  `https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_${res}_coastline.geojson`;
const coastCache = new Map<string, Promise<LonLat[][]>>();

/** Natural Earth coastlines as lon/lat polylines (cached per resolution). */
export function loadCoastlines(res: '110m' | '50m' = '110m'): Promise<LonLat[][]> {
  let p = coastCache.get(res);
  if (!p) {
    p = (async () => {
      let r: Response;
      try {
        r = await fetch(NE_URL(res), { signal: AbortSignal.timeout(20000) });
      } catch (e) {
        throw new Error(`Couldn't load Natural Earth ${res} coastlines (${(e as Error).message})`);
      }
      if (!r.ok) throw new Error(`Natural Earth ${res} coastlines: HTTP ${r.status}`);
      return parseGeoLines(await r.json());
    })();
    p.catch(() => coastCache.delete(res));
    coastCache.set(res, p);
  }
  return p;
}

/** All LineString / MultiLineString / Polygon rings in a GeoJSON object, as lon/lat lines. */
export function parseGeoLines(gj: any): LonLat[][] {
  const out: LonLat[][] = [];
  const geom = (g: any) => {
    if (!g) return;
    const c = g.coordinates;
    switch (g.type) {
      case 'LineString': out.push(c); break;
      case 'MultiLineString': case 'Polygon': out.push(...c); break;
      case 'MultiPolygon': for (const poly of c) out.push(...poly); break;
      case 'GeometryCollection': g.geometries.forEach(geom); break;
    }
  };
  if (gj.type === 'FeatureCollection') for (const f of gj.features) geom(f.geometry);
  else if (gj.type === 'Feature') geom(gj.geometry);
  else geom(gj);
  return out.map((l) => l.map(([x, y]) => [x, y] as LonLat)).filter((l) => l.length > 1);
}

// ---------------------------------------------------------------- sphere maths

const toVec = ([lon, lat]: LonLat): [number, number, number] => {
  const l = lon * RAD, p = lat * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const fromVec = ([x, y, z]: [number, number, number]): LonLat => [Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD];

/** Angle between two points on the sphere, in radians. */
export function angularDistance(a: LonLat, b: LonLat): number {
  const p1 = a[1] * RAD, p2 = b[1] * RAD;
  const dp = p2 - p1, dl = (b[0] - a[0]) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const distanceKm = (a: LonLat, b: LonLat) => angularDistance(a, b) * EARTH_RADIUS_KM;

/** Point a fraction `t` of the way along the great circle from a to b (spherical slerp). */
export function slerp(a: LonLat, b: LonLat, t: number): LonLat {
  const va = toVec(a), vb = toVec(b);
  const d = angularDistance(a, b);
  if (d < 1e-12) return [a[0], a[1]];
  const s = Math.sin(d);
  if (s < 1e-9) return a; // antipodal: the path is undefined
  const ka = Math.sin((1 - t) * d) / s, kb = Math.sin(t * d) / s;
  return fromVec([ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]]);
}

/** Great-circle path from a to b, with a point at least every `stepDeg` degrees. */
export function greatCircle(a: LonLat, b: LonLat, stepDeg = 1): LonLat[] {
  const n = Math.max(1, Math.ceil(angularDistance(a, b) / RAD / stepDeg));
  return Array.from({ length: n + 1 }, (_, i) => slerp(a, b, i / n));
}

/** The point `distKm` from `from` along initial bearing `bearingDeg` (clockwise from north). */
export function destination(from: LonLat, bearingDeg: number, distKm: number): LonLat {
  const d = distKm / EARTH_RADIUS_KM, b = bearingDeg * RAD;
  const p1 = from[1] * RAD, l1 = from[0] * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [wrapLon(l2 / RAD), p2 / RAD];
}

export const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
export const antipode = ([lon, lat]: LonLat): LonLat => [wrapLon(lon + 180), -lat];

/** Densify a line along great circles so no step exceeds `stepDeg`. */
export function densifyGreat(line: LonLat[], stepDeg: number): LonLat[] {
  const out: LonLat[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const seg = greatCircle(line[i - 1], line[i], stepDeg);
    for (let k = 1; k < seg.length; k++) out.push(seg[k]);
  }
  return out;
}

// ---------------------------------------------------------------- projections

export interface Projection {
  name: string;
  /** Lon/lat → unit coordinates (y up). Only meaningful for points the projection shows. */
  forward(p: LonLat): Pt;
  /** A lon/lat line → projected pieces, cut at the projection's seams and clip edge. */
  project(line: LonLat[]): Polyline[];
  /** The edge of the map (globe outline, or clip circle), projected. */
  outline(): Polyline[];
  /** Extent of the whole projected map: [x0, y0, x1, y1]. */
  bounds: [number, number, number, number];
}

/** Splits a lon/lat line wherever it crosses the antimeridian of `lon0`, returning relative lons in [-180, 180]. */
export function cutAntimeridian(line: LonLat[], lon0: number): LonLat[][] {
  const pieces: LonLat[][] = [];
  let cur: LonLat[] = [];
  let prev: LonLat | null = null;
  for (const [lon, lat] of line) {
    let rel = wrapLon(lon - lon0);
    if (prev) {
      // Keep points sitting exactly on the seam on the same side as the previous point.
      if (Math.abs(rel) === 180) rel = prev[0] < 0 ? -180 : 180;
      const d = rel - prev[0];
      if (Math.abs(d) > 180) {
        // Crossed the seam: interpolate the crossing latitude on the unwrapped segment.
        const s = prev[0] > 0 ? 180 : -180;
        const relU = rel + (d > 0 ? -360 : 360);
        const t = (s - prev[0]) / (relU - prev[0]);
        const latX = prev[1] + (lat - prev[1]) * (isFinite(t) ? t : 0);
        cur.push([s, latX]);
        pieces.push(cur);
        cur = [[-s, latX]];
      }
    }
    cur.push([rel, lat]);
    prev = [rel, lat];
  }
  pieces.push(cur);
  return pieces.filter((p) => p.length > 1 && p.some((q) => q[0] !== p[0][0] || q[1] !== p[0][1]));
}

/** Linear densify in lon/lat (for cylindrical maps, where parallels and meridians are the natural steps). */
function densifyLinear(line: LonLat[], stepDeg: number): LonLat[] {
  const out: LonLat[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / stepDeg));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** World projection with a central meridian, x = f(λ, φ) on relative longitude. */
function worldProjection(name: string, lon0: number, raw: (l: number, p: number) => Pt, densify: number): Projection {
  const forward = ([lon, lat]: LonLat): Pt => raw(wrapLon(lon - lon0) * RAD, lat * RAD);
  const fwdRel = ([rel, lat]: LonLat): Pt => raw(rel * RAD, lat * RAD);
  const edge: LonLat[] = [];
  for (let lat = -90; lat <= 90; lat += 1) edge.push([180, lat]);
  for (let lat = 90; lat >= -90; lat -= 1) edge.push([-180, lat]);
  edge.push(edge[0]);
  const outlinePts = densifyLinear(edge, 1).map(fwdRel);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outlinePts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return {
    name,
    forward,
    project: (line) => cutAntimeridian(line, lon0).map((piece) => (densify > 0 ? densifyLinear(piece, densify) : piece).map(fwdRel)),
    outline: () => [outlinePts],
    bounds: [x0, y0, x1, y1],
  };
}

/** Plate carrée (equirectangular), optionally with true scale at `standardLat`. */
export function equirectangular(lon0 = 0, standardLat = 0): Projection {
  const k = Math.cos(standardLat * RAD);
  return worldProjection('Equirectangular', lon0, (l, p) => [l * k, p], 0);
}

/** Natural Earth I (Šavrič, Patterson & Jenny 2011): a compromise world map with rounded corners. */
export function naturalEarth(lon0 = 0): Projection {
  return worldProjection(
    'Natural Earth',
    lon0,
    (l, p) => {
      const p2 = p * p, p4 = p2 * p2;
      return [
        l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
        p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
      ];
    },
    2,
  );
}

/**
 * Azimuthal equidistant centred on `centre`: every point sits at its true distance and bearing
 * from the centre. Unit radius π is the antipode. `clipDeg` (≤ 180) limits the map to that many
 * degrees of arc from the centre; lines are cut exactly at the clip circle.
 */
export function azimuthalEquidistant(centre: LonLat, clipDeg = 180): Projection {
  const l0 = centre[0] * RAD, p0 = centre[1] * RAD;
  const sp0 = Math.sin(p0), cp0 = Math.cos(p0);
  const clip = Math.min(180, clipDeg) * RAD;
  const full = clip >= Math.PI - 1e-9;
  const limit = full ? Math.PI - 0.5 * RAD : clip; // stay off the antipode itself, where the map tears
  const cosC = (lon: number, lat: number) => {
    const p = lat * RAD, dl = lon * RAD - l0;
    return sp0 * Math.sin(p) + cp0 * Math.cos(p) * Math.cos(dl);
  };
  const forward = ([lon, lat]: LonLat): Pt => {
    const p = lat * RAD, dl = lon * RAD - l0;
    const cc = Math.max(-1, Math.min(1, cosC(lon, lat)));
    const c = Math.acos(cc);
    const k = c < 1e-9 ? 1 : c / Math.sin(c);
    if (!isFinite(k)) return [0, -Math.PI]; // the antipode itself
    return [k * Math.cos(p) * Math.sin(dl), k * (cp0 * Math.sin(p) - sp0 * Math.cos(p) * Math.cos(dl))];
  };
  const inside = (q: LonLat) => Math.acos(Math.max(-1, Math.min(1, cosC(q[0], q[1])))) <= limit;
  const crossing = (a: LonLat, b: LonLat): LonLat => {
    // a inside, b outside: bisect along the great circle for the clip circle.
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      if (inside(slerp(a, b, m))) lo = m;
      else hi = m;
    }
    return slerp(a, b, lo);
  };
  const R = full ? Math.PI : clip;
  // Near the antipode, neighbouring points can still land on opposite sides of the map: cut long jumps.
  const maxJump = R * 0.15;
  return {
    name: 'Azimuthal equidistant',
    forward,
    project(line) {
      const pts = densifyGreat(line, 0.5);
      const pieces: Polyline[] = [];
      let cur: Polyline = [];
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i];
        const inQ = inside(q);
        const prev = i > 0 ? pts[i - 1] : null;
        const inP = prev ? inside(prev) : false;
        if (prev && inP && !inQ) {
          cur.push(forward(crossing(prev, q)));
          pieces.push(cur);
          cur = [];
        } else if (prev && !inP && inQ) {
          cur = [forward(crossing(q, prev))];
        }
        if (inQ) {
          const f = forward(q);
          const last = cur[cur.length - 1];
          if (last && Math.hypot(f[0] - last[0], f[1] - last[1]) > maxJump) {
            pieces.push(cur);
            cur = [];
          }
          cur.push(f);
        }
      }
      pieces.push(cur);
      return pieces.filter((p) => p.length > 1);
    },
    outline: () => [Array.from({ length: 361 }, (_, i) => [R * Math.cos(i * RAD), R * Math.sin(i * RAD)] as Pt)],
    bounds: [-R, -R, R, R],
  };
}

/** Project many lines. */
export const projectAll = (lines: LonLat[][], proj: Projection): Polyline[] => lines.flatMap((l) => proj.project(l));

// ---------------------------------------------------------------- fitting to the page

export interface Fit {
  /** Unit coordinates (y up) → mm (y down). */
  map: (p: Pt) => Pt;
  /** mm per unit. */
  scale: number;
}

/** Scale and centre `bounds` ([x0, y0, x1, y1], y up) into a W × H area, leaving `pad` mm all round. */
export function fitBounds(bounds: [number, number, number, number], W: number, H: number, pad = 0): Fit {
  const [x0, y0, x1, y1] = bounds;
  const scale = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { scale, map: ([x, y]) => [W / 2 + (x - cx) * scale, H / 2 - (y - cy) * scale] };
}

/** Like `fitBounds`, but fills the area (cropping the long side) instead of fitting inside it. */
export function coverBounds(bounds: [number, number, number, number], W: number, H: number): Fit {
  const [x0, y0, x1, y1] = bounds;
  const scale = Math.max(W / (x1 - x0 || 1), H / (y1 - y0 || 1));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { scale, map: ([x, y]) => [W / 2 + (x - cx) * scale, H / 2 - (y - cy) * scale] };
}

export const mapLines = (lines: Polyline[], fit: Fit): Polyline[] => lines.map((l) => l.map(fit.map));

// ---------------------------------------------------------------- graticule

/** Meridians every `stepDeg` and parallels every `stepDeg` (as lon/lat lines, densified every 1°). */
export function graticule(stepDeg = 30, o: { maxLat?: number; parallelStep?: number } = {}): LonLat[][] {
  const maxLat = o.maxLat ?? 90 - stepDeg / 3;
  const pStep = o.parallelStep ?? stepDeg;
  const out: LonLat[][] = [];
  for (let lon = -180; lon < 180; lon += stepDeg) {
    const m: LonLat[] = [];
    for (let lat = -maxLat; lat <= maxLat + 1e-9; lat += 1) m.push([lon, Math.min(lat, maxLat)]);
    out.push(m);
  }
  for (let lat = -90 + pStep; lat < 90 - 1e-9; lat += pStep) {
    const p: LonLat[] = [];
    for (let lon = -180; lon <= 180; lon += 1) p.push([lon, lat]);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- labels

export type Box = [number, number, number, number];

/** Bounding box of some polylines (e.g. Hershey text), grown by `pad` mm. */
export function boxOf(lines: Polyline[], pad = 0): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const [x, y] of l) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** Erases lines inside any of the boxes (so linework doesn't run through labels). */
export function cutAround(lines: Polyline[], boxes: Box[], step = 0.25): Polyline[] {
  if (!boxes.length) return lines;
  const hit = ([x, y]: Pt) => boxes.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
  const out: Polyline[] = [];
  for (const l of lines) {
    let cur: Polyline = [];
    for (let i = 0; i < l.length; i++) {
      const b = l[i];
      if (i > 0) {
        const a = l[i - 1];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let k = 1; k < n; k++) {
          const q: Pt = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
          if (hit(q)) {
            if (cur.length > 1) out.push(cur);
            cur = [];
          } else if (cur.length && hit(cur[cur.length - 1])) cur = [q];
          else cur.push(q);
        }
      }
      if (hit(b)) {
        if (cur.length > 1) out.push(cur);
        cur = [];
      } else cur.push(b);
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}
