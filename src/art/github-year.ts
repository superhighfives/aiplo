import type { Polyline, Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { ridges } from '../lib/elevation';
import { defineArtwork } from './types';

interface Day {
  date: string;
  count: number;
}

const cache = new Map<string, Promise<Day[]>>();
function fetchYear(user: string, year: number): Promise<Day[]> {
  const key = `${user.toLowerCase()}/${year}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      let res: Response;
      try {
        res = await fetch(`https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(user)}?y=${year}`, { signal: AbortSignal.timeout(20000) });
      } catch (e) {
        throw new Error(`Couldn't reach the GitHub contributions API: ${(e as Error).message}`);
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `GitHub contributions API error ${res.status}`);
      const days = (body?.contributions ?? []) as Day[];
      if (!days.length) throw new Error(`No contributions data for ${user} in ${year}`);
      return days;
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Contribution grid: grid[week][weekday] (Sunday = 0), NaN outside the year. */
function toGrid(days: Day[]): number[][] {
  const first = new Date(days[0].date + 'T00:00:00Z');
  const offset = first.getUTCDay();
  const weeks = Math.ceil((days.length + offset) / 7);
  const grid = Array.from({ length: weeks }, () => new Array(7).fill(NaN));
  days.forEach((d, k) => {
    const n = k + offset;
    grid[Math.floor(n / 7)][n % 7] = d.count;
  });
  return grid;
}

// ---------------------------------------------------------------------------------------------
// Hidden lines for boxes: draw nearest first, and clip every edge against the silhouettes
// (convex hulls) of the boxes already drawn.

type Poly = { pts: Pt[]; x0: number; y0: number; x1: number; y1: number };

function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)); // counter-clockwise (in y-up terms)
}

const poly = (pts: Pt[]): Poly => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  return { pts, x0, y0, x1, y1 };
};

/** Parameter interval of segment a→b strictly inside convex polygon (hull order), or null. */
function inside(a: Pt, b: Pt, P: Poly, eps: number): [number, number] | null {
  let t0 = 0, t1 = 1;
  const n = P.pts.length;
  if (n < 3) return null;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (let i = 0; i < n; i++) {
    const v = P.pts[i], w = P.pts[(i + 1) % n];
    // Inward normal for a counter-clockwise hull: (-ey, ex).
    const ex = w[0] - v[0], ey = w[1] - v[1];
    const len = Math.hypot(ex, ey) || 1;
    const nx = -ey / len, ny = ex / len;
    const num = nx * (a[0] - v[0]) + ny * (a[1] - v[1]) - eps; // ≥ 0 inside
    const den = nx * dx + ny * dy;
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return null;
    } else {
      const t = -num / den;
      if (den > 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 >= t1) return null;
    }
  }
  return [t0, t1];
}

/** Pieces of segment a→b not covered by any polygon. */
function visibleParts(a: Pt, b: Pt, polys: Poly[], eps: number): Polyline[] {
  const bx0 = Math.min(a[0], b[0]), bx1 = Math.max(a[0], b[0]), by0 = Math.min(a[1], b[1]), by1 = Math.max(a[1], b[1]);
  const hidden: [number, number][] = [];
  for (const P of polys) {
    if (P.x1 < bx0 || P.x0 > bx1 || P.y1 < by0 || P.y0 > by1) continue;
    const iv = inside(a, b, P, eps);
    if (iv) hidden.push(iv);
  }
  hidden.sort((p, q) => p[0] - q[0]);
  const out: Polyline[] = [];
  let t = 0;
  const at = (s: number): Pt => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  for (const [s0, s1] of hidden) {
    if (s0 > t + 1e-9) out.push([at(t), at(s0)]);
    t = Math.max(t, s1);
  }
  if (t < 1 - 1e-9) out.push([at(t), at(1)]);
  return out;
}

function skyline(grid: number[][], W: number, H: number, v: Record<string, any>): Layer[] {
  const nw = grid.length;
  const max = Math.max(1, ...grid.flat().filter((c) => !isNaN(c)));
  const f = (c: number) => (v.scale === 'sqrt' ? Math.sqrt(c / max) : c / max) * v.height;
  const al = (v.angle * Math.PI) / 180;
  const be = ((90 - v.angle) * Math.PI) / 180;
  // Weeks run along ex, weekdays along ey; both point down-screen (towards the viewer).
  const ex: Pt = [Math.cos(al), Math.sin(al) * v.tilt];
  const ey: Pt = [-Math.cos(be), Math.sin(be) * v.tilt];
  const proj = (i: number, j: number, z: number): Pt => [i * ex[0] + j * ey[0], i * ex[1] + j * ey[1] - z];
  // Fit to the area.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < nw; i++)
    for (let j = 0; j < 7; j++) {
      if (isNaN(grid[i][j])) continue;
      for (const [di, dj, z] of [[0, 0, f(grid[i][j])], [1, 1, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0]] as const) {
        const [x, y] = proj(i + di, j + dj, z);
        (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
      }
    }
  const s = Math.min(W / (x1 - x0), H / (y1 - y0));
  const ox = (W - (x1 - x0) * s) / 2 - x0 * s, oy = (H - (y1 - y0) * s) / 2 - y0 * s;
  const P = (i: number, j: number, z: number): Pt => {
    const [x, y] = proj(i, j, z);
    return [x * s + ox, y * s + oy];
  };
  const gap = v.gap / 2;
  const cells: [number, number][] = [];
  for (let i = 0; i < nw; i++) for (let j = 0; j < 7; j++) if (!isNaN(grid[i][j])) cells.push([i, j]);
  cells.sort((a, b) => b[0] + b[1] - (a[0] + a[1])); // nearest first
  const drawn: Poly[] = [];
  const lines: Polyline[] = [];
  const shade: Polyline[] = [];
  const eps = 1e-4;
  for (const [i, j] of cells) {
    const z = f(grid[i][j]);
    const a0 = i + gap, a1 = i + 1 - gap, b0 = j + gap, b1 = j + 1 - gap;
    const T = [P(a0, b0, z), P(a1, b0, z), P(a1, b1, z), P(a0, b1, z)];
    const edges: [Pt, Pt][] = [[T[0], T[1]], [T[1], T[2]], [T[2], T[3]], [T[3], T[0]]];
    const corners = [...T];
    if (z > 1e-9) {
      const B1 = P(a1, b0, 0), B2 = P(a1, b1, 0), B3 = P(a0, b1, 0);
      edges.push([T[1], B1], [T[2], B2], [T[3], B3], [B1, B2], [B2, B3]);
      corners.push(B1, B2, B3);
      if (v.shade > 0) {
        // Vertical hatching on the end face (towards later weeks), the shadow side.
        const len = Math.hypot(B2[0] - B1[0], B2[1] - B1[1]);
        const n = Math.floor(len / v.shade);
        for (let k = 1; k <= n; k++) {
          const t = k / (n + 1);
          const bot: Pt = [B1[0] + (B2[0] - B1[0]) * t, B1[1] + (B2[1] - B1[1]) * t];
          const top: Pt = [T[1][0] + (T[2][0] - T[1][0]) * t, T[1][1] + (T[2][1] - T[1][1]) * t];
          for (const piece of visibleParts(bot, top, drawn, eps)) shade.push(piece);
        }
      }
    }
    for (const [a, b] of edges) for (const piece of visibleParts(a, b, drawn, eps)) lines.push(piece);
    drawn.push(poly(hull(corners)));
  }
  const layers: Layer[] = [{ name: 'Skyline', color: PALETTE[0], paths: lines }];
  if (shade.length) layers.push({ name: 'Shading', color: v.shadePen ? PALETTE[2] : PALETTE[0], paths: shade });
  return layers;
}

function ridgeView(grid: number[][], W: number, H: number, v: Record<string, any>): Polyline[] {
  const max = Math.max(1, ...grid.flat().filter((c) => !isNaN(c)));
  const val = (c: number) => (isNaN(c) ? 0 : v.ridgeScale === 'sqrt' ? Math.sqrt(c / max) : c / max);
  const byWeek = v.rows === 'week';
  const rows = byWeek ? grid.length : 7;
  const cols = byWeek ? 7 : grid.length;
  const get = (r: number, c: number) => val(byWeek ? grid[r][c] : grid[c][r]);
  // Catmull–Rom along the row, flat at both ends.
  const h = (u: number, t: number) => {
    const r = Math.round(t * (rows - 1));
    const pad = 1;
    const x = u * (cols - 1 + 2 * pad) - pad;
    const i = Math.floor(x), f = x - i;
    const g = (k: number) => (k < 0 || k >= cols ? 0 : get(r, k));
    const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
    const y = 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
    return Math.max(0, y);
  };
  const w = W * v.ridgeWidth;
  return ridges(h, w, H, { rows, height: v.ridgeHeight, perspective: v.perspective }).map((l) => l.map(([x, y]) => [x + (W - w) / 2, y] as Pt));
}

const lastYear = new Date().getFullYear() - 1;

export default defineArtwork({
  slug: 'github-year',
  title: 'GitHub year',
  description: 'A year of GitHub contributions as an isometric skyline of days, or as ridgelines.',
  order: 44,
  paper: { paper: 'letter', orientation: 'landscape', margin: 18 },
  params: [
    { type: 'text', key: 'user', label: 'GitHub user', default: 'torvalds' },
    { type: 'number', key: 'year', label: 'Year', min: 2008, max: lastYear + 1, step: 1, default: lastYear },
    { type: 'select', key: 'style', label: 'Style', options: [['skyline', 'Isometric skyline'], ['ridges', 'Ridgelines']], default: 'skyline' },
    { type: 'select', key: 'scale', label: 'Height scale', options: [['linear', 'Linear'], ['sqrt', 'Square root (lifts quiet days)']], default: 'sqrt', show: (v) => v.style === 'skyline' },
    { type: 'select', key: 'ridgeScale', label: 'Height scale', options: [['linear', 'Linear'], ['sqrt', 'Square root (lifts quiet days)']], default: 'linear', show: (v) => v.style === 'ridges' },
    { type: 'number', key: 'height', label: 'Tallest bar (cells)', min: 1, max: 30, step: 0.5, default: 10, show: (v) => v.style === 'skyline' },
    { type: 'number', key: 'angle', label: 'View angle (°)', min: 5, max: 85, step: 1, default: 25, show: (v) => v.style === 'skyline', hint: 'Angle of the week axis; the weekday axis is perpendicular in plan' },
    { type: 'number', key: 'tilt', label: 'Tilt', min: 0.2, max: 1, step: 0.01, default: 0.85, show: (v) => v.style === 'skyline', hint: 'Lower = looking from closer to the ground' },
    { type: 'number', key: 'gap', label: 'Gap between bars', min: 0, max: 0.6, step: 0.01, default: 0.14, show: (v) => v.style === 'skyline' },
    { type: 'number', key: 'shade', label: 'Side hatching (mm)', min: 0, max: 3, step: 0.05, default: 0.9, show: (v) => v.style === 'skyline', hint: 'Spacing of vertical lines on the shadow side; 0 = off' },
    { type: 'checkbox', key: 'shadePen', label: 'Hatching on a second pen', default: false, show: (v) => v.style === 'skyline' && v.shade > 0 },
    { type: 'select', key: 'rows', label: 'One row per', options: [['week', 'Week'], ['weekday', 'Weekday']], default: 'week', show: (v) => v.style === 'ridges' },
    { type: 'number', key: 'ridgeHeight', label: 'Peak height (mm)', min: 2, max: 80, step: 0.5, default: 30, show: (v) => v.style === 'ridges' },
    { type: 'number', key: 'ridgeWidth', label: 'Width', min: 0.2, max: 1, step: 0.01, default: 0.45, show: (v) => v.style === 'ridges', hint: 'Fraction of the drawing area, centred' },
    { type: 'number', key: 'perspective', label: 'Perspective', min: 0, max: 1, step: 0.01, default: 0, show: (v) => v.style === 'ridges' },
  ],
  caption: (v) => `${v.user} · ${v.year}`,
  async generate(v, ctx) {
    const user = String(v.user ?? '').trim().replace(/^@/, '');
    if (!user) throw new Error('Enter a GitHub username');
    ctx.status(`Loading contributions for ${user} in ${v.year}…`);
    const days = await fetchYear(user, v.year);
    const total = days.reduce((s, d) => s + d.count, 0);
    ctx.status(`${user}: ${total.toLocaleString()} contributions in ${v.year}`);
    const grid = toGrid(days);
    return v.style === 'ridges' ? ridgeView(grid, ctx.width, ctx.height, v) : skyline(grid, ctx.width, ctx.height, v);
  },
});
