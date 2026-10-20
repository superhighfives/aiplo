import { smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type GenOutput } from '../layers';
import type { Location, ParamDef, Values } from '../params';
import { shuffle, type Rng } from '../random';
import { jitteredGrid, streamlines } from './streamlines';
import { boxBlur, loadTerrain, makeSampler, type Terrain } from './terrain';

/** Normalised height in [0, 1] at u, v in [0, 1] across the drawing area. */
export type HeightFn = (u: number, v: number) => number;

export interface HeightMap {
  height: HeightFn;
  /** True at or below sea level. */
  isSea: (u: number, v: number) => boolean;
  /** Real elevation in metres (not flattened at sea level). */
  metres: (u: number, v: number) => number;
  /** Elevation range of the area in metres, for labelling or picking intervals. */
  min: number;
  max: number;
  /** Ground width of the drawing area in metres. */
  groundWidth: number;
  /** "123–3776 m · 21.4 km wide", for the status bar. */
  summary: string;
}

const terrainCache = new Map<string, Promise<Terrain>>();
function getTerrain(lat: number, lon: number, zoom: number, span: number, blur: number) {
  const key = [lat, lon, zoom, span, blur].join();
  let t = terrainCache.get(key);
  if (!t) {
    t = loadTerrain(lat, lon, zoom, span * 256).then((t) => boxBlur(t, blur));
    t.catch(() => terrainCache.delete(key));
    terrainCache.set(key, t);
  }
  return t;
}

/** The standard "where on Earth" knobs. Spread into a piece's params. */
export function terrainParams(loc: Location, zoom = 11): ParamDef[] {
  return [
    { type: 'location', key: 'loc', label: 'Location', default: loc },
    { type: 'number', key: 'zoom', label: 'Zoom', min: 5, max: 14, step: 1, default: zoom, hint: 'Map zoom level: lower = wider area' },
    { type: 'number', key: 'span', label: 'Area (tiles)', min: 1, max: 4, step: 1, default: 2 },
    { type: 'number', key: 'blur', label: 'Smooth', min: 0, max: 8, step: 1, default: 1 },
    { type: 'checkbox', key: 'clampSea', label: 'Flatten below sea level', default: true },
  ];
}

/** Loads terrain for the `terrainParams` values, cropped to the drawing area's aspect. */
export async function loadTerrainFor(v: Values, ctx: { width: number; height: number; status: (m: string) => void }): Promise<HeightMap> {
  ctx.status(`Loading terrain for ${v.loc.name}…`);
  const terrain = await getTerrain(v.loc.lat, v.loc.lon, v.zoom, v.span, v.blur);
  const s = makeSampler(terrain, ctx.width / ctx.height, v.clampSea);
  const summary = `${Math.round(s.min)}–${Math.round(s.max)} m · ${(s.groundWidth / 1000).toFixed(1)} km wide`;
  ctx.status(summary);
  return { height: s.height, isSea: s.isSea, metres: s.metres, min: s.min, max: s.max, groundWidth: s.groundWidth, summary };
}

/** Like `loadTerrainFor`, returning just the normalised height function. */
export const loadHeight = async (v: Values, ctx: Parameters<typeof loadTerrainFor>[1]): Promise<HeightFn> => (await loadTerrainFor(v, ctx)).height;

export interface RidgeOptions {
  rows: number;
  /** Peak height in mm. */
  height: number;
  /** 0–1: back rows shrink and bunch up. */
  perspective?: number;
  occlude?: boolean;
  /** Leave gaps wherever this returns true (e.g. `isSea`). */
  gap?: (u: number, v: number) => boolean;
  /**
   * Split lines at segments steeper than this many degrees, dropping the near-vertical
   * joins that cliffs and coastlines produce. Undefined = keep everything.
   */
  breakSteeperThan?: number;
}

/**
 * Joy Division-style ridgelines. Every row is sampled on a shared screen-space x grid,
 * which keeps hidden-line removal exact even when perspective narrows the back rows.
 */
export function ridges(h: HeightFn, W: number, H: number, o: RidgeOptions): Polyline[] {
  const N = o.rows;
  const E = o.height;
  const p = o.perspective ?? 0;
  const occlude = o.occlude ?? true;
  const BIN = 0.2;
  const nb = Math.floor(W / BIN) + 1;
  const xs = Array.from({ length: nb }, (_, j) => Math.min(W, j * BIN));
  const horizon = new Float64Array(nb).fill(Infinity);
  const out: Polyline[] = [];
  for (let i = N - 1; i >= 0; i--) {
    const t = N === 1 ? 0.5 : i / (N - 1); // 0 = back row, 1 = front row
    const scale = 1 - p * (1 - t) * 0.6;
    const base = E + Math.pow(t, 1 + p) * (H - E);
    const half = (W * scale) / 2;
    const ys = new Float64Array(nb).fill(NaN);
    for (let j = 0; j < nb; j++) {
      const u = (xs[j] - W / 2) / (2 * half) + 0.5;
      if (u < 0 || u > 1) continue;
      if (o.gap?.(u, t)) continue;
      ys[j] = base - h(u, t) * E * scale;
    }
    let cur: Polyline | null = null;
    for (let j = 0; j < nb; j++) {
      if (isNaN(ys[j])) {
        cur = null;
        continue;
      }
      if (!occlude) {
        if (!cur) out.push((cur = []));
        cur.push([xs[j], ys[j]]);
        continue;
      }
      const d1 = ys[j] - horizon[j];
      const visible = d1 < 0;
      if (j > 0 && !isNaN(ys[j - 1])) {
        const d0 = ys[j - 1] - horizon[j - 1];
        if (d0 < 0 !== visible && isFinite(d0) && isFinite(d1)) {
          const tt = d0 / (d0 - d1);
          const q: Pt = [xs[j - 1] + (xs[j] - xs[j - 1]) * tt, ys[j - 1] + (ys[j] - ys[j - 1]) * tt];
          if (cur) {
            cur.push(q);
            cur = null;
          } else {
            cur = [q];
            out.push(cur);
          }
        }
      }
      if (visible) {
        if (!cur) out.push((cur = []));
        cur.push([xs[j], ys[j]]);
      } else cur = null;
    }
    for (let j = 0; j < nb; j++) if (!isNaN(ys[j])) horizon[j] = Math.min(horizon[j], ys[j]);
  }
  const lines = out.filter((q) => q.length > 1);
  return o.breakSteeperThan === undefined ? lines : splitSteep(lines, o.breakSteeperThan);
}

/** Splits polylines wherever a segment is steeper than `degrees` from horizontal, dropping that segment. */
export function splitSteep(lines: Polyline[], degrees: number): Polyline[] {
  const tan = Math.tan((Math.min(89.9, degrees) * Math.PI) / 180);
  const out: Polyline[] = [];
  for (const l of lines) {
    let cur: Polyline = [l[0]];
    for (let i = 1; i < l.length; i++) {
      const dx = Math.abs(l[i][0] - l[i - 1][0]);
      const dy = Math.abs(l[i][1] - l[i - 1][1]);
      if (dy > tan * dx && dy > 0.05) {
        if (cur.length > 1) out.push(cur);
        cur = [l[i]];
      } else cur.push(l[i]);
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

export interface ContourOptions {
  levels: number;
  /** Grid resolution in mm. */
  cell: number;
  /** Every Nth contour goes on a second pen (0 = off). */
  indexEvery?: number;
  /** Smoothing radius in mm (see `smooth`); 0 = raw traced lines. */
  curves?: number;
}

/** Evenly spaced contours of normalised height, optionally with index contours on a second pen. */
export function contours(h: HeightFn, W: number, H: number, o: ContourOptions): GenOutput {
  const indexEvery = o.indexEvery ?? 0;
  const thresholds = Array.from({ length: o.levels }, (_, k) => (k + 1) / (o.levels + 1));
  const lines = contourLevels(h, W, H, thresholds, o.cell).map((ls) => ls.map((l) => smooth(l, o.curves ?? 0)));
  if (indexEvery <= 0) return lines.flat();
  return [
    { name: 'Contours', color: PALETTE[0], paths: lines.filter((_, k) => (k + 1) % indexEvery !== 0).flat() },
    { name: 'Index contours', color: PALETTE[1], paths: lines.filter((_, k) => (k + 1) % indexEvery === 0).flat() },
  ];
}

/** The coastline (0 m), traced from real elevation. Empty if the area has no sea. */
export function coastline(map: HeightMap, W: number, H: number, cell = 0.5): Polyline[] {
  if (map.min > 0) return [];
  return contourLevels(map.metres, W, H, [0], cell)[0];
}

/**
 * Marching squares over any field f(u, v): one set of polylines per threshold,
 * stitched into continuous lines via shared grid-edge ids.
 */
export function contourLevels(f: HeightFn, W: number, H: number, thresholds: number[], cell: number): Polyline[][] {
  const nx = Math.max(2, Math.round(W / cell) + 1);
  const ny = Math.max(2, Math.round(H / cell) + 1);
  const g = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) g[j * nx + i] = f(i / (nx - 1), j / (ny - 1));
  const X = (i: number) => (i / (nx - 1)) * W;
  const Y = (j: number) => (j / (ny - 1)) * H;

  return thresholds.map((level) => {
    const out: Polyline[] = [];
    const pts = new Map<number, Pt>();
    const adj = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    };
    const hEdge = (i: number, j: number) => {
      const id = (j * nx + i) * 2;
      if (!pts.has(id)) {
        const a = g[j * nx + i], b = g[j * nx + i + 1];
        pts.set(id, [X(i + (level - a) / (b - a)), Y(j)]);
      }
      return id;
    };
    const vEdge = (i: number, j: number) => {
      const id = (j * nx + i) * 2 + 1;
      if (!pts.has(id)) {
        const a = g[j * nx + i], b = g[(j + 1) * nx + i];
        pts.set(id, [X(i), Y(j + (level - a) / (b - a))]);
      }
      return id;
    };
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const tl = g[j * nx + i], tr = g[j * nx + i + 1], br = g[(j + 1) * nx + i + 1], bl = g[(j + 1) * nx + i];
        const c = (tl > level ? 8 : 0) | (tr > level ? 4 : 0) | (br > level ? 2 : 0) | (bl > level ? 1 : 0);
        if (c === 0 || c === 15) continue;
        const T = () => hEdge(i, j), B = () => hEdge(i, j + 1), L = () => vEdge(i, j), R = () => vEdge(i + 1, j);
        const centre = (tl + tr + br + bl) / 4 > level;
        switch (c) {
          case 1: case 14: link(L(), B()); break;
          case 2: case 13: link(B(), R()); break;
          case 3: case 12: link(L(), R()); break;
          case 4: case 11: link(T(), R()); break;
          case 6: case 9: link(T(), B()); break;
          case 7: case 8: link(L(), T()); break;
          case 5: if (centre) { link(L(), T()); link(B(), R()); } else { link(T(), R()); link(L(), B()); } break;
          case 10: if (centre) { link(T(), R()); link(L(), B()); } else { link(L(), T()); link(B(), R()); } break;
        }
      }
    }
    // Walk chains: open ends first, then closed loops.
    const take = (start: number) => {
      const line: Polyline = [pts.get(start)!];
      let cur = start;
      for (;;) {
        const nbrs = adj.get(cur);
        if (!nbrs || !nbrs.length) break;
        const next = nbrs.pop()!;
        const back = adj.get(next)!;
        back.splice(back.indexOf(cur), 1);
        line.push(pts.get(next)!);
        cur = next;
      }
      if (line.length > 1) out.push(line);
    };
    for (const [id, n] of adj) if (n.length === 1) take(id);
    for (const [id, n] of adj) if (n.length) take(id);
    return out;
  });
}

export interface HachureOptions {
  /** Spacing on the steepest ground, mm. */
  spacing: number;
  /** Spacing on gentle ground, mm; equal to `spacing` for uniform density. */
  spacingGentle?: number;
  /** Below this fraction of the max slope, nothing is drawn. */
  minSlope: number;
  maxLength: number;
  /**
   * Oblique lighting: slopes facing the light get sparser, slopes facing away denser.
   * `strength` 0–1, `azimuth` in degrees clockwise from north (315 = classic north-west light).
   */
  light?: { strength: number; azimuth: number };
}

/** Hachures: evenly spaced lines following the direction of steepest descent. */
export function hachures(h: HeightFn, W: number, H: number, o: HachureOptions, rng: Rng): Polyline[] {
  const e = 0.5;
  const grad = (x: number, y: number): Pt => [
    (h((x + e) / W, y / H) - h((x - e) / W, y / H)) / (2 * e),
    (h(x / W, (y + e) / H) - h(x / W, (y - e) / H)) / (2 * e),
  ];
  // Normalise slope by the 95th percentile rather than the max, so one cliff doesn't wash out the rest.
  const samples: number[] = [];
  for (let j = 0; j <= 64; j++) for (let i = 0; i <= 64; i++) samples.push(Math.hypot(...grad((i / 64) * W, (j / 64) * H)));
  samples.sort((a, b) => a - b);
  const maxG = Math.max(1e-9, samples[Math.floor(samples.length * 0.95)]);
  const dmin = o.spacing;
  const dmax = Math.max(dmin, o.spacingGentle ?? dmin);
  // Direction towards the light in screen space (y down).
  const az = ((o.light?.azimuth ?? 315) * Math.PI) / 180;
  const lx = Math.sin(az), ly = -Math.cos(az);
  const strength = o.light?.strength ?? 0;
  /** 0 = blank paper, 1 = darkest: steep slopes, turned away from the light. */
  const darkness = (x: number, y: number) => {
    const [gx, gy] = grad(x, y);
    const m = Math.hypot(gx, gy);
    const slope = Math.min(1, m / maxG);
    if (!strength || m === 0) return slope;
    const facing = (-gx * lx - gy * ly) / m; // downhill direction · light: 1 = lit
    return Math.max(0, Math.min(1, slope * (1 - strength * facing)));
  };
  return streamlines({
    width: W,
    height: H,
    field: (x, y) => {
      const [gx, gy] = grad(x, y);
      const m = Math.hypot(gx, gy);
      if (m / maxG < o.minSlope) return null;
      return [-gx / m, -gy / m];
    },
    // Steeper ground gets tighter spacing, like engraved hachure maps.
    sep: dmax > dmin ? (x, y) => dmax - (dmax - dmin) * Math.sqrt(darkness(x, y)) : undefined,
    seeds: shuffle(jitteredGrid(W, H, dmin, rng), rng),
    dsep: dmax,
    dtest: dmax * 0.5,
    step: Math.min(0.5, dmin / 3),
    maxLen: o.maxLength,
    minLen: Math.max(1, dmin),
    bidirectional: true,
  });
}

export interface RadialOptions {
  count: number;
  /** Samples per line. */
  samples: number;
  /** Displacement at the highest point, mm. */
  height: number;
  /** Radius of the empty centre, mm. */
  inner: number;
}

/** Lines spreading out from the centre, pushed sideways by elevation. */
export function rays(h: HeightFn, W: number, H: number, o: RadialOptions): Polyline[] {
  const cx = W / 2, cy = H / 2;
  const R = Math.hypot(W, H) / 2;
  const out: Polyline[] = [];
  for (let k = 0; k < o.count; k++) {
    const a = (k / o.count) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    const line: Polyline = [];
    for (let s = 0; s < o.samples; s++) {
      const r = o.inner + ((R - o.inner) * s) / (o.samples - 1);
      const x = cx + dx * r, y = cy + dy * r;
      const d = h(x / W, y / H) * o.height;
      line.push([x - dy * d, y + dx * d]);
    }
    out.push(line);
  }
  return out;
}

/** Concentric rings pushed outward by elevation. */
export function rings(h: HeightFn, W: number, H: number, o: RadialOptions): Polyline[] {
  const cx = W / 2, cy = H / 2;
  const R = Math.hypot(W, H) / 2;
  const out: Polyline[] = [];
  for (let k = 1; k <= o.count; k++) {
    const r = o.inner + ((R - o.inner) * k) / o.count;
    const n = Math.max(32, Math.round((o.samples * r) / R));
    const line: Polyline = [];
    for (let s = 0; s <= n; s++) {
      const a = (s / n) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      const rr = r + h((cx + dx * r) / W, (cy + dy * r) / H) * o.height;
      line.push([cx + dx * rr, cy + dy * rr]);
    }
    out.push(line);
  }
  return out;
}
