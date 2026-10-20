export type Pt = [number, number];
export type Polyline = Pt[];

export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polylineLength(p: Polyline): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]);
  return l;
}

export function translate(paths: Polyline[], dx: number, dy: number): Polyline[] {
  return paths.map((p) => p.map(([x, y]) => [x + dx, y + dy] as Pt));
}

export function circle(cx: number, cy: number, r: number, n = Math.max(16, Math.ceil(r * 2))): Polyline {
  const pts: Polyline = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/** Liang–Barsky clip of segment p→q; returns [t0, t1] or null. */
function clipSegment(p: Pt, q: Pt, x0: number, y0: number, x1: number, y1: number): [number, number] | null {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const P = [-dx, dx, -dy, dy];
  const Q = [p[0] - x0, x1 - p[0], p[1] - y0, y1 - p[1]];
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 4; k++) {
    if (P[k] === 0) {
      if (Q[k] < 0) return null;
    } else {
      const r = Q[k] / P[k];
      if (P[k] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [t0, t1];
}

export function clipToRect(paths: Polyline[], x0: number, y0: number, x1: number, y1: number): Polyline[] {
  const out: Polyline[] = [];
  for (const p of paths) {
    let cur: Polyline | null = null;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1];
      const b = p[i];
      const t = clipSegment(a, b, x0, y0, x1, y1);
      if (!t) {
        cur = null;
        continue;
      }
      const lerp = (s: number): Pt => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
      if (!cur || t[0] > 0) {
        cur = [lerp(t[0])];
        out.push(cur);
      }
      cur.push(lerp(t[1]));
      if (t[1] < 1) cur = null;
    }
  }
  return out.filter((p) => p.length > 1);
}

/** Ramer–Douglas–Peucker simplification. */
export function simplify(p: Polyline, tol: number): Polyline {
  if (p.length < 3 || tol <= 0) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = p[s];
    const [bx, by] = p[e];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = p[i];
      let d2: number;
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

/** Resample a polyline to roughly uniform spacing. */
export function resample(p: Polyline, spacing: number): Polyline {
  const out: Polyline = [p[0]];
  let carry = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const len = dist(a, b);
    let d = spacing - carry;
    while (d < len) {
      const t = d / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  const last = p[p.length - 1];
  if (dist(out[out.length - 1], last) > 1e-6) out.push(last);
  return out;
}

/**
 * Greedy nearest-neighbour ordering (paths may be reversed) using a grid index,
 * then joins consecutive paths whose endpoints are within mergeTol.
 */
export function optimize(paths: Polyline[], mergeTol: number, start: Pt = [0, 0]): Polyline[] {
  const n = paths.length;
  if (n === 0) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    for (const q of [p[0], p[p.length - 1]]) {
      minX = Math.min(minX, q[0]); minY = Math.min(minY, q[1]);
      maxX = Math.max(maxX, q[0]); maxY = Math.max(maxY, q[1]);
    }
  }
  const cell = Math.max(1e-3, Math.max(maxX - minX, maxY - minY) / Math.ceil(Math.sqrt(n)));
  const gw = Math.floor((maxX - minX) / cell) + 1;
  const gh = Math.floor((maxY - minY) / cell) + 1;
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const cx = (x: number) => Math.min(gw - 1, Math.max(0, Math.floor((x - minX) / cell)));
  const cy = (y: number) => Math.min(gh - 1, Math.max(0, Math.floor((y - minY) / cell)));
  paths.forEach((p, i) => {
    const a = p[0];
    const b = p[p.length - 1];
    grid[cy(a[1]) * gw + cx(a[0])].push(i * 2);
    grid[cy(b[1]) * gw + cx(b[0])].push(i * 2 + 1);
  });
  const used = new Uint8Array(n);
  const ordered: Polyline[] = [];
  let cur = start;
  for (let k = 0; k < n; k++) {
    const gx = cx(cur[0]);
    const gy = cy(cur[1]);
    let best = -1;
    let bestD = Infinity;
    const maxR = Math.max(gw, gh);
    for (let r = 0; r <= maxR; r++) {
      for (let y = gy - r; y <= gy + r; y++) {
        if (y < 0 || y >= gh) continue;
        const ring = y === gy - r || y === gy + r;
        for (let x = gx - r; x <= gx + r; x += ring ? 1 : 2 * r || 1) {
          if (x < 0 || x >= gw) continue;
          for (const e of grid[y * gw + x]) {
            const i = e >> 1;
            if (used[i]) continue;
            const p = paths[i];
            const q = e & 1 ? p[p.length - 1] : p[0];
            const d = (q[0] - cur[0]) ** 2 + (q[1] - cur[1]) ** 2;
            if (d < bestD) {
              bestD = d;
              best = e;
            }
          }
        }
      }
      if (best >= 0 && Math.sqrt(bestD) <= r * cell) break;
    }
    const i = best >> 1;
    used[i] = 1;
    const p = best & 1 ? paths[i].slice().reverse() : paths[i];
    ordered.push(p);
    cur = p[p.length - 1];
  }
  if (mergeTol <= 0) return ordered;
  const merged: Polyline[] = [ordered[0].slice()];
  for (let i = 1; i < ordered.length; i++) {
    const last = merged[merged.length - 1];
    const p = ordered[i];
    if (canJoin(last, p, mergeTol)) {
      for (let j = 1; j < p.length; j++) last.push(p[j]);
    } else merged.push(p.slice());
  }
  return merged;
}

const JOIN_COS = Math.cos((30 * Math.PI) / 180);

/** Unit direction of the polyline's first (or last) ~0.5 mm, or null if it's degenerate. */
function endDirection(p: Polyline, atEnd: boolean): Pt | null {
  const n = p.length;
  const a = atEnd ? p[n - 1] : p[0];
  for (let i = 1; i < n; i++) {
    const b = atEnd ? p[n - 1 - i] : p[i];
    const d = dist(a, b);
    if (d >= 0.5 || i === n - 1) {
      if (d < 1e-9) return null;
      // Direction of travel: into the end point, or out of the start point.
      return atEnd ? [(a[0] - b[0]) / d, (a[1] - b[1]) / d] : [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
    }
  }
  return null;
}

/**
 * Joining draws ink across the gap, so only do it where it reads as the same line carrying on:
 * tiny gaps always, otherwise only if the gap runs in roughly the direction of both strokes.
 * This stops e.g. ridgeline rows being stitched to the row below with short vertical lines.
 */
function canJoin(a: Polyline, b: Polyline, tol: number): boolean {
  const from = a[a.length - 1];
  const to = b[0];
  const gap = dist(from, to);
  if (gap > tol) return false;
  if (gap < 0.05) return true;
  const g: Pt = [(to[0] - from[0]) / gap, (to[1] - from[1]) / gap];
  const da = endDirection(a, true);
  const db = endDirection(b, false);
  if (!da || !db) return false;
  return da[0] * g[0] + da[1] * g[1] >= JOIN_COS && db[0] * g[0] + db[1] * g[1] >= JOIN_COS;
}

export function stats(paths: Polyline[], start: Pt = [0, 0]) {
  let draw = 0;
  let travel = 0;
  let cur = start;
  for (const p of paths) {
    travel += dist(cur, p[0]);
    draw += polylineLength(p);
    cur = p[p.length - 1];
  }
  travel += dist(cur, start);
  return { draw, travel, count: paths.length };
}

/**
 * Gaussian smoothing along a polyline: turns kinked lines (e.g. marching-squares contours)
 * into curves. `radius` is roughly the distance in mm over which wiggles are averaged out.
 * Closed loops wrap around; open lines keep their endpoints fixed.
 */
export function smooth(p: Polyline, radius: number): Polyline {
  if (radius <= 0 || p.length < 3) return p;
  const spacing = Math.max(0.1, radius / 4);
  const closed = dist(p[0], p[p.length - 1]) < 1e-6;
  const pts = resample(p, spacing);
  if (closed && pts.length > 1) pts.pop(); // drop the duplicate closing point
  const n = pts.length;
  if (n < 3) return p;
  const taps = Math.ceil(radius / spacing);
  const sigma = taps / 2;
  const w = Array.from({ length: taps + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out: Polyline = [];
  for (let i = 0; i < n; i++) {
    // Open lines: shrink the window symmetrically near the ends so endpoints stay put.
    const reach = closed ? taps : Math.min(taps, i, n - 1 - i);
    let sx = 0, sy = 0, sw = 0;
    for (let k = -reach; k <= reach; k++) {
      const q = pts[closed ? (((i + k) % n) + n) % n : i + k];
      const wk = w[Math.abs(k)];
      sx += q[0] * wk;
      sy += q[1] * wk;
      sw += wk;
    }
    out.push([sx / sw, sy / sw]);
  }
  if (closed) out.push(out[0]);
  return out;
}
