// Small helpers shared by the generative pieces (harmonograph, spirograph, space-filling curves…).
import { dist, type Polyline, type Pt } from '../geom';

/** Bounding box of a set of polylines. */
export function bounds(paths: Polyline[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths)
    for (const [x, y] of p) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  return { x0, y0, x1, y1 };
}

/** Uniformly scales and centres paths to fit a W×H box with `pad` mm on every side. */
export function fitToBox(paths: Polyline[], W: number, H: number, pad = 0): Polyline[] {
  const b = bounds(paths);
  const bw = Math.max(1e-9, b.x1 - b.x0), bh = Math.max(1e-9, b.y1 - b.y0);
  const k = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
  const ox = W / 2 - ((b.x0 + b.x1) / 2) * k;
  const oy = H / 2 - ((b.y0 + b.y1) / 2) * k;
  return paths.map((p) => p.map(([x, y]) => [x * k + ox, y * k + oy] as Pt));
}

/**
 * Keeps only the parts of each polyline inside `inside(x, y)`, splitting where it leaves.
 * Segments are subdivided to `step` mm so curved boundaries are followed closely; crossing
 * points are refined by bisection.
 */
export function clipTo(paths: Polyline[], inside: (x: number, y: number) => boolean, step = 0.5): Polyline[] {
  const out: Polyline[] = [];
  const cross = (a: Pt, b: Pt): Pt => {
    // a inside, b outside: bisect for the boundary.
    let lo = 0, hi = 1;
    for (let k = 0; k < 12; k++) {
      const m = (lo + hi) / 2;
      if (inside(a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m)) lo = m;
      else hi = m;
    }
    return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
  };
  for (const p of paths) {
    let cur: Polyline | null = null;
    let prev = p[0];
    let prevIn = inside(prev[0], prev[1]);
    if (prevIn) cur = [prev];
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const n = Math.max(1, Math.ceil(dist(a, b) / step));
      for (let s = 1; s <= n; s++) {
        const q: Pt = s === n ? b : [a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n];
        const qIn = inside(q[0], q[1]);
        if (qIn && prevIn) {
          if (s === n || n === 1) cur!.push(q);
        } else if (qIn && !prevIn) {
          cur = [cross(q, prev), q];
        } else if (!qIn && prevIn) {
          cur!.push(cross(prev, q));
          if (cur!.length > 1) out.push(cur!);
          cur = null;
        }
        prev = q;
        prevIn = qIn;
      }
    }
    if (cur && cur.length > 1) out.push(cur);
  }
  return out;
}

export const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/** Signed area of a closed polygon (positive = counter-clockwise in y-up, clockwise on screen). */
export function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return a / 2;
}

export function polygonCentroid(p: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const f = p[j][0] * p[i][1] - p[i][0] * p[j][1];
    a += f;
    cx += (p[j][0] + p[i][0]) * f;
    cy += (p[j][1] + p[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = p.length || 1;
    return [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * Insets a convex polygon by `d` mm (each edge moved inward), by clipping it against the
 * moved edges' half-planes. Returns [] if the polygon vanishes. Ring may be open or closed.
 */
export function insetConvex(ring: Pt[], d: number): Pt[] {
  let poly = ring.slice();
  if (poly.length > 1 && dist(poly[0], poly[poly.length - 1]) < 1e-9) poly.pop();
  if (poly.length < 3) return [];
  const sign = polygonArea(poly) > 0 ? 1 : -1;
  const edges = poly.map((a, i) => [a, poly[(i + 1) % poly.length]] as [Pt, Pt]);
  for (const [a, b] of edges) {
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    // Inward normal (left of edge for CCW in this coordinate system's sense).
    const nx = (-ey / len) * sign, ny = (ex / len) * sign;
    const ox = a[0] + nx * d, oy = a[1] + ny * d;
    const side = (q: Pt) => (q[0] - ox) * nx + (q[1] - oy) * ny;
    const next: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    poly = next;
    if (poly.length < 3) return [];
  }
  return poly;
}

/**
 * Stitches short pieces that share end points into long polylines. Pieces whose ends coincide
 * (within ~1 µm) are joined; every junction should have at most two pieces meeting.
 */
export function stitch(pieces: Polyline[]): Polyline[] {
  const key = (p: Pt) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  const at = new Map<string, number[]>();
  pieces.forEach((p, i) => {
    for (const k of [key(p[0]), key(p[p.length - 1])]) (at.get(k) ?? at.set(k, []).get(k)!).push(i);
  });
  const used = new Uint8Array(pieces.length);
  const out: Polyline[] = [];
  const walk = (start: number) => {
    used[start] = 1;
    let line = pieces[start].slice();
    // Extend forwards, then backwards.
    for (let dir = 0; dir < 2; dir++) {
      for (;;) {
        const end = line[line.length - 1];
        const next = (at.get(key(end)) ?? []).find((j) => !used[j]);
        if (next === undefined) break;
        used[next] = 1;
        const p = pieces[next];
        const seg = key(p[0]) === key(end) ? p : p.slice().reverse();
        for (let k = 1; k < seg.length; k++) line.push(seg[k]);
      }
      line = line.reverse();
    }
    out.push(line);
  };
  // Start from open ends so lines aren't broken in the middle, then the closed loops.
  for (const [, idx] of at) if (idx.length === 1 && !used[idx[0]]) walk(idx[0]);
  for (let i = 0; i < pieces.length; i++) if (!used[i]) walk(i);
  return out;
}
