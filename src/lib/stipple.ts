import type { Pt } from '../geom';
import type { Rng } from '../random';

/** Uniform-grid point index for nearest-neighbour queries. */
class PointGrid {
  readonly cell: number;
  readonly gw: number;
  readonly gh: number;
  readonly start: Int32Array;
  readonly items: Int32Array;
  constructor(readonly xs: Float64Array, readonly ys: Float64Array, W: number, H: number, cell: number) {
    this.cell = cell;
    this.gw = Math.max(1, Math.ceil(W / cell));
    this.gh = Math.max(1, Math.ceil(H / cell));
    const n = xs.length;
    const count = new Int32Array(this.gw * this.gh + 1);
    const ci = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      ci[i] = this.cellOf(xs[i], ys[i]);
      count[ci[i] + 1]++;
    }
    for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
    this.start = count.slice();
    this.items = new Int32Array(n);
    const fill = count.slice();
    for (let i = 0; i < n; i++) this.items[fill[ci[i]]++] = i;
  }
  cellOf(x: number, y: number) {
    const gx = Math.min(this.gw - 1, Math.max(0, Math.floor(x / this.cell)));
    const gy = Math.min(this.gh - 1, Math.max(0, Math.floor(y / this.cell)));
    return gy * this.gw + gx;
  }
  /** Index of the nearest point, or -1 if none. */
  nearest(x: number, y: number): number {
    const gx = Math.min(this.gw - 1, Math.max(0, Math.floor(x / this.cell)));
    const gy = Math.min(this.gh - 1, Math.max(0, Math.floor(y / this.cell)));
    let best = -1, bd = Infinity;
    const maxR = Math.max(this.gw, this.gh);
    for (let r = 0; r <= maxR; r++) {
      // Once a ring is farther than the best hit, nothing closer can remain.
      if (best >= 0 && (r - 1) * this.cell > Math.sqrt(bd)) break;
      for (let yy = gy - r; yy <= gy + r; yy++) {
        if (yy < 0 || yy >= this.gh) continue;
        const edge = yy === gy - r || yy === gy + r;
        for (let xx = gx - r; xx <= gx + r; xx += edge ? 1 : 2 * r || 1) {
          if (xx < 0 || xx >= this.gw) continue;
          const c = yy * this.gw + xx;
          for (let k = this.start[c]; k < this.start[c + 1]; k++) {
            const i = this.items[k];
            const d = (this.xs[i] - x) ** 2 + (this.ys[i] - y) ** 2;
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
      }
    }
    return best;
  }
  /** Up to k nearest other points to point i (sorted by distance). */
  knn(i: number, k: number): number[] {
    const x = this.xs[i], y = this.ys[i];
    const gx = Math.min(this.gw - 1, Math.max(0, Math.floor(x / this.cell)));
    const gy = Math.min(this.gh - 1, Math.max(0, Math.floor(y / this.cell)));
    const cand: [number, number][] = [];
    const maxR = Math.max(this.gw, this.gh);
    for (let r = 0; r <= maxR; r++) {
      if (cand.length >= k) {
        cand.sort((a, b) => a[1] - b[1]);
        cand.length = k;
        if ((r - 1) * this.cell > Math.sqrt(cand[k - 1][1])) break;
      }
      for (let yy = gy - r; yy <= gy + r; yy++) {
        if (yy < 0 || yy >= this.gh) continue;
        const edge = yy === gy - r || yy === gy + r;
        for (let xx = gx - r; xx <= gx + r; xx += edge ? 1 : 2 * r || 1) {
          if (xx < 0 || xx >= this.gw) continue;
          const c = yy * this.gw + xx;
          for (let q = this.start[c]; q < this.start[c + 1]; q++) {
            const j = this.items[q];
            if (j !== i) cand.push([j, (this.xs[j] - x) ** 2 + (this.ys[j] - y) ** 2]);
          }
        }
      }
    }
    cand.sort((a, b) => a[1] - b[1]);
    return cand.slice(0, k).map((c) => c[0]);
  }
}

export interface StippleOptions {
  /** Number of points. */
  count: number;
  /** Darkness is raised to this power before use (higher = more contrast). */
  gamma?: number;
  /** Weighted Lloyd relaxation passes (0 = raw importance sampling). */
  iterations?: number;
  /** Density raster cell size in mm (auto if omitted). */
  res?: number;
}

/**
 * Weighted stippling: points with density proportional to darkness^gamma, spread
 * evenly by a few passes of weighted Lloyd relaxation (Secord's weighted Voronoi
 * stippling, computed on a raster with a grid nearest-point search).
 */
export function stipple(darkness: (x: number, y: number) => number, W: number, H: number, rng: Rng, o: StippleOptions): Pt[] {
  const n = Math.max(1, Math.round(o.count));
  const gamma = o.gamma ?? 1;
  const res = o.res ?? Math.max(0.25, Math.sqrt((W * H) / Math.max(150_000, n * 40)));
  const rw = Math.max(1, Math.ceil(W / res)), rh = Math.max(1, Math.ceil(H / res));
  const dens = new Float64Array(rw * rh);
  let total = 0;
  for (let j = 0; j < rh; j++)
    for (let i = 0; i < rw; i++) {
      const d = Math.max(0, Math.min(1, darkness((i + 0.5) * res, (j + 0.5) * res)));
      const w = d < 0.004 ? 0 : Math.pow(d, gamma);
      dens[j * rw + i] = w;
      total += w;
    }
  if (total <= 0) return [];

  // Importance sampling from the raster's CDF.
  const cdf = new Float64Array(rw * rh);
  let acc = 0;
  for (let i = 0; i < cdf.length; i++) cdf[i] = acc += dens[i];
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const t = rng() * acc;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    xs[k] = ((lo % rw) + rng()) * res;
    ys[k] = (Math.floor(lo / rw) + rng()) * res;
  }

  // Weighted Lloyd relaxation.
  const inked: number[] = [];
  for (let i = 0; i < dens.length; i++) if (dens[i] > 0) inked.push(i);
  const cell = Math.max(res * 2, Math.sqrt((W * H) / n));
  const sx = new Float64Array(n), sy = new Float64Array(n), sw = new Float64Array(n);
  for (let it = 0; it < (o.iterations ?? 8); it++) {
    const grid = new PointGrid(xs, ys, W, H, cell);
    sx.fill(0); sy.fill(0); sw.fill(0);
    for (const c of inked) {
      const x = ((c % rw) + 0.5) * res, y = (Math.floor(c / rw) + 0.5) * res;
      const p = grid.nearest(x, y);
      const w = dens[c];
      sx[p] += x * w;
      sy[p] += y * w;
      sw[p] += w;
    }
    for (let k = 0; k < n; k++)
      if (sw[k] > 0) {
        xs[k] = sx[k] / sw[k];
        ys[k] = sy[k] / sw[k];
      }
  }
  return Array.from({ length: n }, (_, k) => [xs[k], ys[k]] as Pt);
}

export interface TourOptions {
  /** Neighbour candidates per point for 2-opt / Or-opt. */
  neighbours?: number;
  /** Wall-clock budget for improvements, ms. */
  timeBudget?: number;
  /** Return a closed loop (last point = first). Otherwise the longest edge is cut. */
  closed?: boolean;
}

/**
 * A short single tour through all points: grid nearest-neighbour construction,
 * then 2-opt and Or-opt with neighbour lists and don't-look bits, within a time budget.
 */
export function tour(pts: Pt[], W: number, H: number, o: TourOptions = {}): Pt[] {
  const n = pts.length;
  if (n < 4) return pts.slice();
  const xs = Float64Array.from(pts, (p) => p[0]);
  const ys = Float64Array.from(pts, (p) => p[1]);
  const cell = Math.max(0.5, Math.sqrt((W * H) / n) * 1.5);
  const grid = new PointGrid(xs, ys, W, H, cell);
  const d = (a: number, b: number) => Math.hypot(xs[a] - xs[b], ys[a] - ys[b]);
  const K = o.neighbours ?? 8;
  const neigh = Array.from({ length: n }, (_, i) => grid.knn(i, K));

  // Nearest-neighbour construction: grow from the current point using a "removed" mask
  // and ring search, falling back to the next unvisited index when the grid is sparse.
  const order = new Int32Array(n);
  const used = new Uint8Array(n);
  const alive = new Int32Array(grid.gw * grid.gh); // unvisited count per cell
  for (let i = 0; i < n; i++) alive[grid.cellOf(xs[i], ys[i])]++;
  let cur = 0;
  used[0] = 1;
  alive[grid.cellOf(xs[0], ys[0])]--;
  for (let k = 1; k < n; k++) {
    const x = xs[cur], y = ys[cur];
    const gx = Math.min(grid.gw - 1, Math.max(0, Math.floor(x / cell)));
    const gy = Math.min(grid.gh - 1, Math.max(0, Math.floor(y / cell)));
    let best = -1, bd = Infinity;
    const maxR = Math.max(grid.gw, grid.gh);
    for (let r = 0; r <= maxR; r++) {
      if (best >= 0 && (r - 1) * cell > Math.sqrt(bd)) break;
      for (let yy = gy - r; yy <= gy + r; yy++) {
        if (yy < 0 || yy >= grid.gh) continue;
        const edge = yy === gy - r || yy === gy + r;
        for (let xx = gx - r; xx <= gx + r; xx += edge ? 1 : 2 * r || 1) {
          if (xx < 0 || xx >= grid.gw) continue;
          const c = yy * grid.gw + xx;
          if (!alive[c]) continue;
          for (let q = grid.start[c]; q < grid.start[c + 1]; q++) {
            const j = grid.items[q];
            if (used[j]) continue;
            const dd = (xs[j] - x) ** 2 + (ys[j] - y) ** 2;
            if (dd < bd) {
              bd = dd;
              best = j;
            }
          }
        }
      }
    }
    order[k] = best;
    used[best] = 1;
    alive[grid.cellOf(xs[best], ys[best])]--;
    cur = best;
  }

  // Doubly-indexed tour for 2-opt.
  const t = order; // position -> city
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[t[i]] = i;
  const succ = (c: number) => t[(pos[c] + 1) % n];
  const pred = (c: number) => t[(pos[c] - 1 + n) % n];
  /** Reverse the tour between positions i..j inclusive (cyclic), choosing the shorter side. */
  const reverse = (i: number, j: number) => {
    let len = (j - i + n) % n + 1;
    if (len * 2 > n) {
      // Reverse the complement instead: positions j+1 .. i-1.
      const ni = (j + 1) % n, nj = (i - 1 + n) % n;
      i = ni;
      j = nj;
      len = n - len;
    }
    for (let s = 0; s < len >> 1; s++) {
      const a = t[i], b = t[j];
      t[i] = b; pos[b] = i;
      t[j] = a; pos[a] = j;
      i = (i + 1) % n;
      j = (j - 1 + n) % n;
    }
  };

  const deadline = performance.now() + (o.timeBudget ?? 1500);
  const queue: number[] = [];
  const inQ = new Uint8Array(n).fill(1);
  for (let i = n - 1; i >= 0; i--) queue.push(t[i]);
  const push = (c: number) => {
    if (!inQ[c]) {
      inQ[c] = 1;
      queue.push(c);
    }
  };
  let steps = 0;
  while (queue.length) {
    if ((++steps & 255) === 0 && performance.now() > deadline) break;
    const a = queue.pop()!;
    inQ[a] = 0;
    let improved = false;
    // 2-opt, both orientations.
    for (const dir of [1, -1]) {
      const b = dir > 0 ? succ(a) : pred(a);
      const dab = d(a, b);
      for (const c of neigh[a]) {
        const dac = d(a, c);
        if (dac >= dab) break;
        const e = dir > 0 ? succ(c) : pred(c);
        if (c === b || e === a) continue;
        const delta = dac + d(b, e) - dab - d(c, e);
        if (delta < -1e-9) {
          if (dir > 0) reverse(pos[b], pos[c]);
          else reverse(pos[c], pos[b]);
          push(a); push(b); push(c); push(e);
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
    if (improved) continue;
    // Or-opt: move a segment of 1..3 cities starting at a next to one of its neighbours.
    for (let L = 1; L <= 3 && !improved; L++) {
      const s0 = a;
      let s1 = a;
      for (let q = 1; q < L; q++) s1 = succ(s1);
      const p = pred(s0), nx = succ(s1);
      if (nx === p || L + 2 >= n) continue;
      const removeGain = d(p, s0) + d(s1, nx) - d(p, nx);
      for (const c of neigh[s0]) {
        // Insert between c and one of its tour neighbours, outside the segment.
        let inSeg = false;
        for (let q = 0, z = s0; q < L; q++, z = succ(z)) if (z === c) inSeg = true;
        if (inSeg) continue;
        for (const e of [succ(c), pred(c)]) {
          if (e === s0 || e === s1 && L > 1) continue;
          let eInSeg = false;
          for (let q = 0, z = s0; q < L; q++, z = succ(z)) if (z === e) eInSeg = true;
          if (eInSeg) continue;
          // Two orientations of the segment between c and e.
          const add1 = d(c, s0) + d(s1, e) - d(c, e);
          const add2 = d(c, s1) + d(s0, e) - d(c, e);
          const add = Math.min(add1, add2);
          if (add - removeGain < -1e-9) {
            // Rebuild by array splice (O(n)), rare enough to be fine.
            const seg: number[] = [];
            for (let q = 0, z = s0; q < L; q++, z = succ(z)) seg.push(z);
            const rest: number[] = [];
            for (let q = 0, z = nx; q < n - L; q++, z = succ(z)) rest.push(z);
            // c and e are adjacent in rest; insert between them with the cheaper orientation.
            const ic = rest.indexOf(c), ie = rest.indexOf(e);
            const first = Math.min(ic, ie), second = Math.max(ic, ie);
            const wrap = second - first !== 1; // adjacency across the ends of the array
            // X is the city the segment follows in the new order.
            const X = wrap ? rest[second] : rest[first];
            const ins = (add1 <= add2) === (X === c) ? seg : seg.slice().reverse();
            const merged = wrap ? [...rest, ...ins] : [...rest.slice(0, second), ...ins, ...rest.slice(second)];
            for (let q = 0; q < n; q++) {
              t[q] = merged[q];
              pos[merged[q]] = q;
            }
            push(p); push(nx); push(c); push(e); for (const z of seg) push(z);
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
    }
  }

  const out: Pt[] = [];
  if (o.closed) {
    for (let i = 0; i < n; i++) out.push(pts[t[i]]);
    out.push(pts[t[0]]);
    return out;
  }
  // Open path: cut the longest edge.
  let cut = 0, longest = -1;
  for (let i = 0; i < n; i++) {
    const l = d(t[i], t[(i + 1) % n]);
    if (l > longest) {
      longest = l;
      cut = i;
    }
  }
  for (let q = 1; q <= n; q++) out.push(pts[t[(cut + q) % n]]);
  return out;
}

/** Total length of a point sequence. */
export function tourLength(p: Pt[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return s;
}
