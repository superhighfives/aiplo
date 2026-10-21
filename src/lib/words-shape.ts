// Shapes as raster masks in mm, for laying text into: preset silhouettes, horizontal spans
// per text row, an inside distance field (for concentric outlines) and outlines.
import { smooth, type Polyline, type Pt } from '../geom';
import { contourLevels } from './elevation';
import { polygonArea } from './gen-util';

/** A boolean raster over the W×H mm drawing area; cell (i, j) covers [i·c, (i+1)·c). */
export interface MaskGrid {
  nx: number;
  ny: number;
  cell: number;
  W: number;
  H: number;
  data: Uint8Array;
}

export function maskFrom(inside: (x: number, y: number) => boolean, W: number, H: number, cell = 0.5): MaskGrid {
  const nx = Math.max(2, Math.ceil(W / cell)), ny = Math.max(2, Math.ceil(H / cell));
  const data = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[j * nx + i] = inside((i + 0.5) * cell, (j + 0.5) * cell) ? 1 : 0;
  return { nx, ny, cell, W, H, data };
}

export const maskAt = (m: MaskGrid, x: number, y: number) => {
  const i = Math.floor(x / m.cell), j = Math.floor(y / m.cell);
  return i >= 0 && j >= 0 && i < m.nx && j < m.ny && m.data[j * m.nx + i] === 1;
};

/** Even-odd point in polygon. */
export function insideRings(rings: Pt[][], x: number, y: number): boolean {
  let c = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  return c;
}

/** Preset outlines, scaled to fill a W×H box (minus `pad`), as a closed ring. */
export function presetRing(name: string, W: number, H: number, pad = 0): Pt[] {
  const n = 360;
  let pts: Pt[] = [];
  const T = (i: number) => (i / n) * 2 * Math.PI;
  if (name === 'heart') {
    for (let i = 0; i < n; i++) {
      const t = T(i);
      pts.push([16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
    }
  } else if (name === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * 2 * Math.PI, r = i % 2 ? 0.47 : 1;
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
  } else if (name === 'teardrop') {
    for (let i = 0; i < n; i++) {
      const t = T(i);
      // Point at the top, round at the bottom.
      pts.push([Math.sin(t) * Math.sin(t / 2) ** 1.4, -Math.cos(t)]);
    }
  } else {
    for (let i = 0; i < n; i++) pts.push([Math.cos(T(i)), Math.sin(T(i))]);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  // Circles and stars keep their proportions; heart and teardrop too (no stretching).
  const k = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
  pts = pts.map(([x, y]) => [W / 2 + (x - (x0 + x1) / 2) * k, H / 2 + (y - (y0 + y1) / 2) * k]);
  pts.push(pts[0]);
  return pts;
}

/**
 * Horizontal runs of the shape that a line of text can occupy: x-intervals inside the mask
 * for every y in [top, bottom]. Runs narrower than `minWidth` are dropped. Sorted left to right.
 */
export function spansAt(m: MaskGrid, top: number, bottom: number, minWidth: number, inset = 0): [number, number][] {
  const j0 = Math.max(0, Math.floor(top / m.cell)), j1 = Math.min(m.ny - 1, Math.floor(bottom / m.cell));
  if (top < 0 || bottom > m.H) return [];
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= m.nx; i++) {
    let ok = i < m.nx;
    for (let j = j0; ok && j <= j1; j++) if (!m.data[j * m.nx + i]) ok = false;
    if (ok && start < 0) start = i;
    else if (!ok && start >= 0) {
      const a = start * m.cell + inset, b = i * m.cell - inset;
      if (b - a >= minWidth) out.push([a, b]);
      start = -1;
    }
  }
  return out;
}

/** Squared Euclidean distance transform of a 1D array (Felzenszwalb & Huttenlocher). */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/** Distance in mm from each inside cell to the nearest outside cell (0 outside). */
export function insideDistance(m: MaskGrid): Float32Array {
  const { nx, ny } = m;
  const INF = 1e12;
  const g = new Float64Array(nx * ny);
  // The area's border counts as outside, so the field falls to 0 at the page edge.
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) g[j * nx + i] = m.data[j * nx + i] && i > 0 && j > 0 && i < nx - 1 && j < ny - 1 ? INF : 0;
  const n = Math.max(nx, ny);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = g[j * nx + i];
    edt1(f, ny, d, v, z);
    for (let j = 0; j < ny; j++) g[j * nx + i] = d[j];
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = g[j * nx + i];
    edt1(f, nx, d, v, z);
    for (let i = 0; i < nx; i++) g[j * nx + i] = d[i];
  }
  const out = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) out[k] = Math.sqrt(g[k]) * m.cell;
  return out;
}

/** Bilinear sampler of a cell-centred field over the mask's area, as f(u, v) with u, v in 0..1. */
export function fieldSampler(m: MaskGrid, f: Float32Array) {
  return (u: number, v: number) => {
    const x = (u * m.W) / m.cell - 0.5, y = (v * m.H) / m.cell - 0.5;
    const i = Math.max(0, Math.min(m.nx - 2, Math.floor(x))), j = Math.max(0, Math.min(m.ny - 2, Math.floor(y)));
    const fx = Math.max(0, Math.min(1, x - i)), fy = Math.max(0, Math.min(1, y - j));
    const a = f[j * m.nx + i], b = f[j * m.nx + i + 1], c = f[(j + 1) * m.nx + i], d = f[(j + 1) * m.nx + i + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/**
 * Closed loops where the inside distance equals each level, smoothed, clockwise on screen
 * (so text along them reads upright across the top) and starting above their centre.
 */
export function insetLoops(m: MaskGrid, dist: Float32Array, levels: number[], smoothing: number): Polyline[][] {
  const f = fieldSampler(m, dist);
  return contourLevels(f, m.W, m.H, levels, m.cell).map((lines) =>
    lines
      .filter((p) => p.length > 3 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < m.cell * 2)
      .map((p) => {
        let q = smooth(p, smoothing);
        q = q.slice(0, -1);
        if (polygonArea(q) < 0) q.reverse();
        // Start straight above the loop's centre (so successive rings share a seam), else at the top.
        const cx = q.reduce((a, p) => a + p[0], 0) / q.length, cy = q.reduce((a, p) => a + p[1], 0) / q.length;
        let top = -1;
        for (let i = 0; i < q.length; i++) if (q[i][1] < cy && (top < 0 || Math.abs(q[i][0] - cx) < Math.abs(q[top][0] - cx))) top = i;
        if (top < 0) top = 0;
        q = [...q.slice(top), ...q.slice(0, top)];
        q.push(q[0]);
        return q;
      }),
  );
}

/** Outline of the mask (where the inside field crosses half a cell). */
export function maskOutline(m: MaskGrid, smoothing = 0.6): Polyline[] {
  const f = fieldSampler(m, m.data.reduce((a, x, i) => ((a[i] = x), a), new Float32Array(m.nx * m.ny)));
  return contourLevels(f, m.W, m.H, [0.5], m.cell)[0].map((p) => smooth(p, smoothing));
}
