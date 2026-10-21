import { smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { FONT_OPTIONS, text } from '../lib/hershey';
import { bounds, stitch } from '../lib/gen-util';
import type { Rng } from '../random';
import { defineArtwork } from './types';

/**
 * Walks a set of unit edges on a lattice into long polylines: at each node it carries straight
 * on if it can, so walls come out as few, long strokes.
 */
function walkEdges(edges: Set<number>, nx: number, at: (i: number, j: number) => Pt): Polyline[] {
  // Edge id: node index * 2 + (0 = to the right, 1 = downwards). Nodes are (nx + 1) wide.
  const W = nx + 1;
  const deg = new Map<number, number>();
  const bump = (n: number) => deg.set(n, (deg.get(n) ?? 0) + 1);
  for (const e of edges) {
    const n = e >> 1;
    bump(n);
    bump(e & 1 ? n + W : n + 1);
  }
  const edgeFrom = (n: number, dir: number): number => {
    // dir: 0 right, 1 down, 2 left, 3 up
    if (dir === 0) return n * 2;
    if (dir === 1) return n * 2 + 1;
    if (dir === 2) return (n - 1) * 2;
    return (n - W) * 2 + 1;
  };
  const step = (n: number, dir: number) => (dir === 0 ? n + 1 : dir === 1 ? n + W : dir === 2 ? n - 1 : n - W);
  const out: Polyline[] = [];
  const take = (start: number) => {
    let n = start;
    let dir = -1;
    const line: Polyline = [at(n % W, Math.floor(n / W))];
    for (;;) {
      const order = dir < 0 ? [0, 1, 2, 3] : [dir, (dir + 1) % 4, (dir + 3) % 4];
      let moved = false;
      for (const d of order) {
        const col = n % W;
        if ((d === 2 && col === 0) || (d === 0 && col === W - 1)) continue;
        const e = edgeFrom(n, d);
        if (e < 0 || !edges.has(e)) continue;
        edges.delete(e);
        deg.set(n, deg.get(n)! - 1);
        n = step(n, d);
        deg.set(n, deg.get(n)! - 1);
        line.push(at(n % W, Math.floor(n / W)));
        dir = d;
        moved = true;
        break;
      }
      if (!moved) break;
    }
    // Collapse collinear runs.
    const simple: Polyline = [line[0]];
    for (let k = 1; k < line.length - 1; k++) {
      const a = simple[simple.length - 1], b = line[k], c = line[k + 1];
      if (Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-9) simple.push(b);
    }
    simple.push(line[line.length - 1]);
    if (simple.length > 1) out.push(simple);
  };
  // Odd-degree nodes first (line ends), then whatever is left (closed loops).
  for (const [n, d] of deg) if (d % 2 === 1) while ((deg.get(n) ?? 0) > 0) take(n);
  for (const [n] of deg) while ((deg.get(n) ?? 0) > 0) take(n);
  return out;
}

interface Maze {
  /** Wall lines. */
  walls: Polyline[];
  /** Solution paths through cell centres. */
  paths: Polyline[];
}

/**
 * Perfect maze by recursive backtracking over the cells where `mask` is set, one tree per
 * connected region. Walls separate unconnected cells and outline the region.
 */
function buildMaze(nx: number, ny: number, mask: Uint8Array, cell: number, ox: number, oy: number, rng: Rng, rect: boolean, solve: boolean): Maze {
  const N = nx * ny;
  // Passages: bit 1 = open to the right, bit 2 = open downwards.
  const open = new Uint8Array(N);
  const comp = new Int32Array(N).fill(-1);
  const comps: number[] = [];
  const nbrs = (c: number) => {
    const i = c % nx, j = (c / nx) | 0;
    const out: number[] = [];
    if (i > 0) out.push(c - 1);
    if (i < nx - 1) out.push(c + 1);
    if (j > 0) out.push(c - nx);
    if (j < ny - 1) out.push(c + nx);
    return out.filter((n) => mask[n]);
  };
  const connect = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    open[lo] |= hi - lo === 1 ? 1 : 2;
  };
  for (let s = 0; s < N; s++) {
    if (!mask[s] || comp[s] >= 0) continue;
    const id = comps.length;
    comps.push(s);
    comp[s] = id;
    const stack = [s];
    while (stack.length) {
      const c = stack[stack.length - 1];
      const free = nbrs(c).filter((n) => comp[n] < 0);
      if (!free.length) {
        stack.pop();
        continue;
      }
      const n = free[Math.floor(rng() * free.length)];
      comp[n] = id;
      connect(c, n);
      stack.push(n);
    }
  }
  const isOpen = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return (open[lo] & (hi - lo === 1 ? 1 : 2)) !== 0;
  };

  // Entrance and exit for a rectangular maze: left of the top-left cell, right of the bottom-right.
  const doorIn = rect ? 0 : -1;
  const doorOut = rect ? N - 1 : -1;

  // Wall edges on the (nx+1)×(ny+1) lattice.
  const edges = new Set<number>();
  const W = nx + 1;
  const m = (i: number, j: number) => (i >= 0 && j >= 0 && i < nx && j < ny ? mask[j * nx + i] : 0);
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i < nx; i++) {
      // Horizontal edge on lattice row j, between cells (i, j-1) and (i, j).
      const a = m(i, j - 1), b = m(i, j);
      if ((a || b) && !(a && b && isOpen((j - 1) * nx + i, j * nx + i))) edges.add((j * W + i) * 2);
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i <= nx; i++) {
      // Vertical edge on lattice column i, between cells (i-1, j) and (i, j).
      const a = m(i - 1, j), b = m(i, j);
      if (!(a || b)) continue;
      if (a && b && isOpen(j * nx + i - 1, j * nx + i)) continue;
      if (i === 0 && j * nx === doorIn) continue;
      if (i === nx && j * nx + nx - 1 === doorOut) continue;
      edges.add((j * W + i) * 2 + 1);
    }
  const walls = walkEdges(edges, nx, (i, j) => [ox + i * cell, oy + j * cell]);

  const paths: Polyline[] = [];
  if (solve) {
    const bfs = (start: number) => {
      const prev = new Int32Array(N).fill(-2);
      prev[start] = -1;
      const q = [start];
      let last = start;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        last = c;
        for (const n of nbrs(c)) if (prev[n] === -2 && isOpen(c, n)) {
          prev[n] = c;
          q.push(n);
        }
      }
      return { prev, last, size: q.length };
    };
    const centre = (c: number): Pt => [ox + ((c % nx) + 0.5) * cell, oy + (((c / nx) | 0) + 0.5) * cell];
    const trace = (prev: Int32Array, end: number) => {
      const p: Polyline = [];
      for (let c = end; c >= 0; c = prev[c]) p.push(centre(c));
      return p;
    };
    if (rect) {
      const { prev } = bfs(doorIn);
      const p = trace(prev, doorOut).reverse();
      p.unshift([ox + cell * 0.5, oy + cell * 0.5]);
      p.unshift([ox - cell * 0.5, oy + cell * 0.5]);
      p.push([ox + (nx + 0.5) * cell, oy + (ny - 0.5) * cell]);
      paths.push(p);
    } else {
      // Each region's longest path (the tree's diameter: two breadth-first searches).
      for (const s of comps) {
        const a = bfs(s);
        if (a.size < 4) continue;
        const b = bfs(a.last);
        paths.push(trace(b.prev, b.last));
      }
    }
  }
  return { walls, paths };
}

/** Marks cells whose centres lie within `band` mm of any of the strokes. */
function strokeMask(strokes: Polyline[], nx: number, ny: number, cell: number, ox: number, oy: number, band: number): Uint8Array {
  const mask = new Uint8Array(nx * ny);
  for (const s of strokes)
    for (let k = 1; k < s.length; k++) {
      const [ax, ay] = s[k - 1], [bx, by] = s[k];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - band - ox) / cell));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + band - ox) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - band - oy) / cell));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + band - oy) / cell));
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const px = ox + (i + 0.5) * cell, py = oy + (j + 0.5) * cell;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
          if ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2 <= band * band) mask[j * nx + i] = 1;
        }
    }
  return mask;
}

/** Truchet tiles whose arcs (or chamfered lines) join into continuous curves. */
function truchet(W: number, H: number, cell: number, strands: number, curved: boolean, bias: number, rng: Rng): Polyline[] {
  const nx = Math.max(1, Math.floor(W / cell)), ny = Math.max(1, Math.floor(H / cell));
  const ox = (W - nx * cell) / 2, oy = (H - ny * cell) / 2;
  // Strands sit symmetrically about the edge midpoints so they meet the neighbouring tile's.
  // Arcs round opposite corners would touch beyond ±0.207 of a cell, so keep inside that.
  const span = (curved ? 0.18 : 0.4) * cell;
  const radii = Array.from({ length: strands }, (_, k) => cell / 2 + (strands > 1 ? (k / (strands - 1) - 0.5) * 2 * span : 0));
  const pieces: Polyline[] = [];
  // A piece around corner (cx, cy): from the point r along one edge to the point r along the other.
  const corner = (cx: number, cy: number, sx: number, sy: number, r: number) => {
    // sx, sy: direction from the corner into the tile.
    if (!curved) {
      pieces.push([[cx + sx * r, cy], [cx, cy + sy * r]]);
      return;
    }
    const n = Math.max(3, Math.ceil((r * Math.PI) / 2 / 0.4));
    const p: Polyline = [];
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * (Math.PI / 2);
      // k = 0 lies on the horizontal edge, k = n on the vertical one; endpoints exact for stitching.
      p.push(k === 0 ? [cx + sx * r, cy] : k === n ? [cx, cy + sy * r] : [cx + sx * r * Math.cos(a), cy + sy * r * Math.sin(a)]);
    }
    pieces.push(p);
  };
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x0 = ox + i * cell, y0 = oy + j * cell, x1 = x0 + cell, y1 = y0 + cell;
      const flip = rng() < bias;
      for (const r of radii) {
        if (flip) {
          corner(x0, y0, 1, 1, r);
          corner(x1, y1, -1, -1, r);
        } else {
          corner(x1, y0, -1, 1, r);
          corner(x0, y1, 1, -1, r);
        }
      }
    }
  return stitch(pieces);
}

export default defineArtwork({
  slug: 'maze',
  title: 'Mazes and Truchet tiles',
  description: 'A perfect maze, optionally grown inside letterforms with its solution on a second pen, or Truchet tiles that join into long curves.',
  order: 62,
  paper: { paper: 'a4', orientation: 'landscape', margin: 15 },
  params: [
    { type: 'select', key: 'style', label: 'Style', options: [['maze', 'Maze'], ['arcs', 'Truchet: arcs'], ['lines', 'Truchet: diagonals']], default: 'maze' },
    { type: 'seed', key: 'seed', label: 'Seed', default: 1 },
    { type: 'number', key: 'cell', label: 'Cell (mm)', min: 1, max: 30, step: 0.25, default: 2.5, show: (v) => v.style === 'maze' },
    { type: 'number', key: 'tile', label: 'Tile (mm)', min: 3, max: 60, step: 0.5, default: 12, show: (v) => v.style !== 'maze' },
    { type: 'text', key: 'text', label: 'Text', default: 'maze', placeholder: 'Empty: a rectangular maze', show: (v) => v.style === 'maze', hint: 'The maze grows inside these letters' },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural', show: (v) => v.style === 'maze' && !!v.text?.trim() },
    { type: 'number', key: 'band', label: 'Letter weight (mm)', min: 1, max: 30, step: 0.5, default: 7, show: (v) => v.style === 'maze' && !!v.text?.trim(), hint: 'How far the maze reaches either side of each letter stroke' },
    { type: 'checkbox', key: 'solve', label: 'Solution on pen 2', default: true, show: (v) => v.style === 'maze', hint: 'For lettering, the longest path through each letter' },
    { type: 'number', key: 'strands', label: 'Strands per tile', min: 1, max: 6, step: 1, default: 3, show: (v) => v.style !== 'maze' },
    { type: 'number', key: 'bias', label: 'Orientation bias', min: 0, max: 1, step: 0.01, default: 0.5, show: (v) => v.style !== 'maze', hint: 'Chance of each tile being flipped; 0.5 is random' },
  ],
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    if (v.style !== 'maze') return truchet(W, H, Math.max(1, v.tile), v.strands, v.style === 'arcs', v.bias, ctx.rng);
    const cell = Math.max(0.5, v.cell);

    const words = String(v.text ?? '').trim();
    const nx = Math.max(2, Math.floor(W / cell)), ny = Math.max(2, Math.floor(H / cell));
    const ox = (W - nx * cell) / 2, oy = (H - ny * cell) / 2;
    let mask: Uint8Array;
    if (words) {
      // Lay the text out at unit size, then scale its actual ink bounds (x-height, descenders and
      // all) to fit the page, leaving room for the band around the strokes.
      const raw = text(words, { size: 10, font: v.font, align: 'center', leading: 1.5 });
      const b = bounds(raw);
      const k = Math.min((W - 2 * v.band - 2 * cell) / Math.max(1e-6, b.x1 - b.x0), (H - 2 * v.band - 2 * cell) / Math.max(1e-6, b.y1 - b.y0));
      const strokes = raw.map((p) => p.map(([x, y]) => [W / 2 + (x - (b.x0 + b.x1) / 2) * k, H / 2 + (y - (b.y0 + b.y1) / 2) * k] as Pt));
      const size = 10 * k;
      mask = strokeMask(strokes, nx, ny, cell, ox, oy, v.band);
      ctx.status(`Text at ${size.toFixed(0)} mm cap height`);
    } else mask = new Uint8Array(nx * ny).fill(1);

    const { walls, paths } = buildMaze(nx, ny, mask, cell, ox, oy, ctx.rng, !words, v.solve);
    const layers: Layer[] = [{ name: 'Walls', color: PALETTE[0], paths: walls }];
    if (paths.length) layers.push({ name: 'Solution', color: PALETTE[1], paths: paths.map((p) => smooth(p, cell * 0.6)) });
    return layers;
  },
});
