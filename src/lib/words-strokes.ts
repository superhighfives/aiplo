// Pen-stroke recovery from a photographed page of handwriting: adaptive threshold, despeckle,
// Zhang–Suen thinning, then tracing the one-pixel skeleton into polylines that are joined
// across junctions and small gaps by good continuation. Pure maths on Float32Array rasters,
// so it runs in the worker and is testable in Node.
import { polylineLength, type Polyline, type Pt } from '../geom';
import type { Gray } from './image';
import type { Rng } from '../random';

/* ------------------------------------------------------------------------------------------ */
/* Rasterising (for the demo page)                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * Inks polylines into a coverage buffer (0 = paper, 1 = ink), anti-aliased, with a width per
 * point given by `width(x, y)` in pixels. Overlaps take the max.
 */
export function inkPolylines(ink: Float32Array, w: number, h: number, paths: Polyline[], width: (x: number, y: number) => number, strength = 1) {
  for (const p of paths)
    for (let i = 1; i < p.length; i++) {
      const [ax, ay] = p[i - 1], [bx, by] = p[i];
      const r = width((ax + bx) / 2, (ay + by) / 2) / 2;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + 1));
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
          const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
          const c = Math.max(0, Math.min(1, r + 0.5 - d)) * strength;
          const k = y * w + x;
          if (c > ink[k]) ink[k] = c;
        }
    }
}

/**
 * A fake phone photo of a handwritten page: the strokes inked with varying pressure on
 * slightly grainy paper with faint ruled lines, specks of dirt, and a shadow across it.
 */
export function photographPage(paths: Polyline[], w: number, h: number, o: { pen: number; ruled?: number; rng: Rng }): Gray {
  const ink = new Float32Array(w * h);
  // Pressure: the pen width swells and thins slowly across the page.
  inkPolylines(ink, w, h, paths, (x, y) => o.pen * (0.8 + 0.35 * Math.sin(x * 0.013 + y * 0.007) * Math.sin(x * 0.0041 - y * 0.011 + 1)));
  const data = new Float32Array(w * h);
  const rng = o.rng;
  // Smooth grain: a coarse random grid, bilinearly interpolated.
  const gs = 6, gw = Math.ceil(w / gs) + 2, gh = Math.ceil(h / gs) + 2;
  const grain = Float32Array.from({ length: gw * gh }, () => rng() - 0.5);
  const gr = (x: number, y: number) => {
    const fx = x / gs, fy = y / gs, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const g = (a: number, b: number) => grain[b * gw + a];
    return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - v) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * v;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      // Paper brightness with a soft diagonal shadow (a phone held over the page) and vignette.
      let b = 0.93 - 0.5 * Math.max(0, Math.min(1, (u + 0.6 * v - 0.75) * 1.6)) ** 1.5 - 0.08 * ((u - 0.5) ** 2 + (v - 0.5) ** 2);
      if (o.ruled) {
        const d = Math.abs(((y + 0.5) % o.ruled) - o.ruled * 0.78);
        b -= 0.09 * Math.max(0, 1 - d / 1.6);
      }
      b += 0.035 * gr(x, y) + 0.02 * (rng() - 0.5);
      // Ink: dark blue-black, a bit uneven.
      const c = ink[y * w + x];
      b = b * (1 - c) + (0.12 + 0.08 * gr(x * 0.5 + 77, y * 0.5)) * c;
      data[y * w + x] = Math.max(0, Math.min(1, b));
    }
  // Dirt: a scatter of small dark specks.
  const specks = Math.round((w * h) / 9000);
  for (let s = 0; s < specks; s++) {
    const cx = rng() * w, cy = rng() * h, r = 0.6 + rng() * 1.6;
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++)
        if (x >= 0 && y >= 0 && x < w && y < h && Math.hypot(x - cx, y - cy) <= r) data[y * w + x] *= 0.35;
  }
  return { w, h, data };
}

/* ------------------------------------------------------------------------------------------ */
/* Binarising                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Adaptive threshold against the local mean: a pixel is ink when it is darker than the mean
 * of the surrounding (2r+1)² window by more than `c` (0..1 brightness). A 3×3 pre-blur
 * calms paper grain. Returns 1 for ink.
 */
export function adaptiveThreshold(g: Gray, r: number, c: number, invert = false): Uint8Array {
  const { w, h } = g;
  const src = new Float32Array(w * h);
  // 3×3 box pre-blur.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++)
        for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) {
          s += g.data[j * w + i];
          n++;
        }
      src[y * w + x] = invert ? 1 - s / n : s / n;
    }
  // Integral image (doubles: sums over a million pixels).
  const W1 = w + 1;
  const I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
      if (src[y * w + x] < mean - c) out[y * w + x] = 1;
    }
  }
  return out;
}

/**
 * Connected components of pixels equal to `value` (8-connected for ink, 4 for paper);
 * components smaller than `minArea` are flipped. With value = 0 only components that don't
 * touch the border are considered (holes).
 */
export function removeSmall(bin: Uint8Array, w: number, h: number, value: 0 | 1, minArea: number) {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const comp: number[] = [];
  const eight = value === 1;
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || bin[s] !== value) continue;
    comp.length = 0;
    stack.push(s);
    seen[s] = 1;
    let border = false;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!eight && dx && dy)) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (!seen[q] && bin[q] === value) {
            seen[q] = 1;
            stack.push(q);
          }
        }
    }
    if (comp.length < minArea && !(value === 0 && border)) for (const p of comp) bin[p] = 1 - value;
  }
}

/** Zhang–Suen thinning, in place: reduces ink regions to 8-connected one-pixel skeletons. */
export function zhangSuen(bin: Uint8Array, w: number, h: number) {
  // Clear the border so neighbour lookups never leave the image.
  for (let x = 0; x < w; x++) bin[x] = bin[(h - 1) * w + x] = 0;
  for (let y = 0; y < h; y++) bin[y * w] = bin[y * w + w - 1] = 0;
  let live: number[] = [];
  for (let i = 0; i < w * h; i++) if (bin[i]) live.push(i);
  const del: number[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (const p of live) {
        if (!bin[p]) continue;
        // Neighbours P2..P9, clockwise from north.
        const n2 = bin[p - w], n3 = bin[p - w + 1], n4 = bin[p + 1], n5 = bin[p + w + 1];
        const n6 = bin[p + w], n7 = bin[p + w - 1], n8 = bin[p - 1], n9 = bin[p - w - 1];
        const B = n2 + n3 + n4 + n5 + n6 + n7 + n8 + n9;
        if (B < 2 || B > 6) continue;
        const A = (+(!n2 && n3)) + (+(!n3 && n4)) + (+(!n4 && n5)) + (+(!n5 && n6)) + (+(!n6 && n7)) + (+(!n7 && n8)) + (+(!n8 && n9)) + (+(!n9 && n2));
        if (A !== 1) continue;
        if (pass === 0 ? n2 * n4 * n6 || n4 * n6 * n8 : n2 * n4 * n8 || n2 * n6 * n8) continue;
        del.push(p);
      }
      for (const p of del) bin[p] = 0;
      if (del.length) changed = true;
    }
    live = live.filter((p) => bin[p]);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Tracing                                                                                     */
/* ------------------------------------------------------------------------------------------ */

const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * Skeleton neighbours of pixel p. Diagonal steps are skipped where a 4-neighbour path already
 * connects them, so staircase corners don't look like junctions.
 */
function neighbours(sk: Uint8Array, w: number, p: number): number[] {
  const x = p % w, y = (p / w) | 0;
  const out: number[] = [];
  for (const [dx, dy] of DIRS) {
    const q = (y + dy) * w + x + dx;
    if (!sk[q]) continue;
    if (dx && dy && (sk[y * w + x + dx] || sk[(y + dy) * w + x])) continue;
    out.push(q);
  }
  return out;
}

interface Seg {
  pts: Pt[];
  /** Pixel ids of the two ends' nodes (-1 for closed loops). */
  a: number;
  b: number;
}

/** Walks a skeleton into pixel chains split at junctions (degree ≠ 2). */
function traceSkeleton(sk: Uint8Array, w: number, h: number): Seg[] {
  const deg = new Uint8Array(w * h);
  const pix: number[] = [];
  for (let p = 0; p < w * h; p++)
    if (sk[p]) {
      deg[p] = neighbours(sk, w, p).length;
      pix.push(p);
    }
  const used = new Set<number>(); // edges, as min * N + max
  const N = w * h;
  const ek = (a: number, b: number) => (a < b ? a * N + b : b * N + a);
  const pt = (p: number): Pt => [(p % w) + 0.5, ((p / w) | 0) + 0.5];
  const segs: Seg[] = [];
  const walk = (start: number, first: number) => {
    const pts: Pt[] = [pt(start)];
    let prev = start, cur = first;
    used.add(ek(start, first));
    for (;;) {
      pts.push(pt(cur));
      if (deg[cur] !== 2 || cur === start) break;
      const next = neighbours(sk, w, cur).find((q) => q !== prev && !used.has(ek(cur, q)));
      if (next === undefined) break;
      used.add(ek(cur, next));
      prev = cur;
      cur = next;
    }
    segs.push({ pts, a: start, b: cur === start && deg[cur] === 2 ? -1 : cur });
  };
  for (const p of pix) {
    if (deg[p] === 2) continue;
    if (deg[p] === 0) {
      segs.push({ pts: [pt(p)], a: p, b: p }); // isolated pixel: a dot
      continue;
    }
    for (const q of neighbours(sk, w, p)) if (!used.has(ek(p, q))) walk(p, q);
  }
  // Closed loops: every pixel of degree 2.
  for (const p of pix)
    if (deg[p] === 2)
      for (const q of neighbours(sk, w, p))
        if (!used.has(ek(p, q))) {
          walk(p, q);
          const s = segs[segs.length - 1];
          s.a = s.b = -1;
        }
  return segs;
}

/** Unit direction pointing out of a polyline's end, averaged over `reach` px. */
function endDir(pts: Pt[], atStart: boolean, reach: number): Pt {
  const n = pts.length;
  const e = atStart ? pts[0] : pts[n - 1];
  let q = e;
  let len = 0;
  for (let k = 1; k < n; k++) {
    const p = atStart ? pts[k] : pts[n - 1 - k];
    len += Math.hypot(p[0] - q[0], p[1] - q[1]);
    q = p;
    if (len >= reach) break;
  }
  const dx = e[0] - q[0], dy = e[1] - q[1], l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

export interface RecoverOptions {
  /** Adaptive-threshold sensitivity: how much darker than its surroundings ink must be (0..1). */
  contrast: number;
  /** Local window radius in px (0 = automatic). */
  window?: number;
  /** Light ink on a dark ground. */
  invert?: boolean;
  /** Bridge gaps up to this many pen widths. */
  join: number;
  /** Max change of direction allowed when joining (degrees). */
  maxTurn?: number;
}

export interface Recovered {
  strokes: Polyline[];
  /** Blobs too small to have a direction (dots, full stops), in px. */
  dots: Pt[];
  /** Estimated pen width in px (ink area / skeleton length). */
  pen: number;
  inkPixels: number;
  skeletonPixels: number;
}

/** The whole pipeline: photo → pen strokes in pixel coordinates. */
export function recoverStrokes(g: Gray, o: RecoverOptions): Recovered {
  const { w, h } = g;
  const r = o.window && o.window > 0 ? Math.round(o.window) : Math.max(6, Math.round(Math.max(w, h) / 50));
  const bin = adaptiveThreshold(g, r, o.contrast, o.invert);
  // Despeckle: open ink specks and pinholes, then a majority pass to smooth ragged edges.
  removeSmall(bin, w, h, 1, Math.max(6, Math.round((w * h) / 60000)));
  removeSmall(bin, w, h, 0, Math.max(4, Math.round((w * h) / 150000)));
  majority(bin, w, h);
  let inkPixels = 0;
  for (let i = 0; i < w * h; i++) inkPixels += bin[i];
  const solid = bin.slice();
  zhangSuen(bin, w, h);
  let skeletonPixels = 0;
  for (let i = 0; i < w * h; i++) skeletonPixels += bin[i];
  const pen = skeletonPixels ? Math.max(1, inkPixels / skeletonPixels) : 3;
  let segs = traceSkeleton(bin, w, h);

  // Prune spurs: short branches from a junction to a free end (thinning artefacts at corners).
  const degAt = new Map<number, number>();
  for (const s of segs) for (const n of [s.a, s.b]) if (n >= 0) degAt.set(n, (degAt.get(n) ?? 0) + 1);
  segs = segs.filter((s) => {
    if (s.a < 0) return true;
    const da = degAt.get(s.a) ?? 0, db = degAt.get(s.b) ?? 0;
    const spur = (da === 1 && db >= 3) || (db === 1 && da >= 3);
    return !(spur && polylineLength(s.pts) < pen * 0.6);
  });

  const joined = joinSegments(segs.map((s) => s.pts), pen, o.join * pen + 1.5, o.maxTurn ?? 55);
  // Anything shorter than the pen is wide is a dot (an i's tittle, a full stop).
  const dots: Pt[] = [];
  for (const s of segs) if (s.pts.length === 1) dots.push(s.pts[0]);
  const strokes = joined.filter((p) => {
    if (polylineLength(p) >= pen) return true;
    dots.push([p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length]);
    return false;
  });
  // Dots must be real blobs of ink, not surviving dirt: at least about a pen-width disc.
  const minDot = Math.max(8, 0.7 * pen * pen);
  const keep = dots.filter(([x, y]) => blobArea(solid, w, h, Math.floor(x), Math.floor(y), minDot) >= minDot);
  return { strokes, dots: keep, pen, inkPixels, skeletonPixels };
}

/** Size of the ink blob around (x, y) (searching a few px for ink), counting up to `cap`. */
function blobArea(bin: Uint8Array, w: number, h: number, x: number, y: number, cap: number): number {
  let s = -1;
  for (let r = 0; r <= 2 && s < 0; r++)
    for (let j = -r; j <= r && s < 0; j++)
      for (let i = -r; i <= r && s < 0; i++) {
        const q = (y + j) * w + x + i;
        if (x + i >= 0 && y + j >= 0 && x + i < w && y + j < h && bin[q]) s = q;
      }
  if (s < 0) return 0;
  const seen = new Set<number>([s]);
  const stack = [s];
  while (stack.length && seen.size < cap) {
    const p = stack.pop()!;
    const px = p % w, py = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy, q = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && bin[q] && !seen.has(q)) {
          seen.add(q);
          stack.push(q);
        }
      }
  }
  return seen.size;
}

/** One pass of a 3×3 majority filter (smooths staircase edges before thinning). */
function majority(bin: Uint8Array, w: number, h: number) {
  const src = bin.slice();
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += src[(y + j) * w + x + i];
      bin[y * w + x] = s >= 5 ? 1 : 0;
    }
}

/**
 * Joins chains end to end by good continuation: at junctions and across gaps up to `gap` px,
 * the pair of ends that best continue each other's direction are linked (greedy, best first).
 */
export function joinSegments(segs: Pt[][], pen: number, gap: number, maxTurn: number): Polyline[] {
  segs = segs.filter((s) => s.length > 1);
  const n = segs.length;
  // End e: segment e >> 1, start if (e & 1) === 0.
  const P = (e: number) => (e & 1 ? segs[e >> 1][segs[e >> 1].length - 1] : segs[e >> 1][0]);
  const reach = Math.max(3, pen * 2);
  const D = Array.from({ length: n * 2 }, (_, e) => endDir(segs[e >> 1], !(e & 1), reach));
  // Spatial hash of ends.
  const cell = Math.max(2, gap);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (let e = 0; e < n * 2; e++) {
    const [x, y] = P(e);
    (grid.get(key(x, y)) ?? grid.set(key(x, y), []).get(key(x, y))!).push(e);
  }
  const cosMax = Math.cos((maxTurn * Math.PI) / 180);
  const cand: [number, number, number][] = [];
  for (let e = 0; e < n * 2; e++) {
    const [x, y] = P(e);
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++)
        for (const f of grid.get(`${cx + i},${cy + j}`) ?? []) {
          if (f <= e) continue;
          if (f >> 1 === e >> 1 && polylineLength(segs[e >> 1]) < gap * 3) continue; // tiny self-loop
          const q = P(f);
          const d = Math.hypot(q[0] - x, q[1] - y);
          if (d > gap) continue;
          const da = D[e], db = D[f];
          // Continuation: the ends should point at each other (opposite outward directions).
          const cont = -(da[0] * db[0] + da[1] * db[1]);
          if (cont < cosMax) continue;
          // Across a real gap the bridge itself must also follow the strokes.
          if (d > pen * 0.75) {
            const bx = (q[0] - x) / d, by = (q[1] - y) / d;
            if (da[0] * bx + da[1] * by < cosMax || -(db[0] * bx + db[1] * by) < cosMax) continue;
          }
          cand.push([e, f, d / gap + (1 - cont) * 1.5]);
        }
  }
  cand.sort((a, b) => a[2] - b[2]);
  const link = new Int32Array(n * 2).fill(-1);
  for (const [e, f] of cand) {
    if (link[e] >= 0 || link[f] >= 0) continue;
    link[e] = f;
    link[f] = e;
  }
  // Walk chains of linked segments.
  const used = new Uint8Array(n);
  const out: Polyline[] = [];
  const chain = (s0: number, startEnd: number) => {
    // Enter segment s0 at end `startEnd`, leave by the other end, follow links.
    const line: Polyline = [];
    let s = s0, inEnd = startEnd;
    while (s >= 0 && !used[s]) {
      used[s] = 1;
      const pts = inEnd & 1 ? segs[s].slice().reverse() : segs[s];
      for (const p of pts) if (!line.length || Math.hypot(p[0] - line[line.length - 1][0], p[1] - line[line.length - 1][1]) > 1e-6) line.push(p);
      const outEnd = inEnd ^ 1;
      const nx = link[outEnd];
      if (nx < 0) break;
      s = nx >> 1;
      inEnd = nx;
    }
    if (line.length > 1) out.push(line);
  };
  for (let s = 0; s < n; s++) if (!used[s] && link[s * 2] < 0) chain(s, s * 2);
  for (let s = 0; s < n; s++) if (!used[s] && link[s * 2 + 1] < 0) chain(s, s * 2 + 1);
  for (let s = 0; s < n; s++) if (!used[s]) chain(s, s * 2); // closed rings of links
  return out;
}
