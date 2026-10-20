import type { Polyline, Pt } from '../geom';

export interface StreamOptions {
  width: number;
  height: number;
  /** Unit direction at (x, y), or null to stop tracing there. */
  field: (x: number, y: number) => Pt | null;
  seeds: Pt[];
  /** Minimum spacing between lines when seeding (upper bound if `sep` is given). */
  dsep: number;
  /** Lines stop when they get this close to another line (as a fraction of the local spacing if `sep` is given). */
  dtest: number;
  /** Optional variable spacing at (x, y); must never exceed `dsep`. */
  sep?: (x: number, y: number) => number;
  step: number;
  maxLen: number;
  minLen: number;
  bidirectional?: boolean;
}

/** Evenly-spaced streamlines (simplified Jobard–Lefer). */
export function streamlines(o: StreamOptions): Polyline[] {
  const cell = Math.max(o.dsep, o.dtest);
  const sepAt = o.sep ?? (() => o.dsep);
  const testAt = o.sep ? (x: number, y: number) => o.sep!(x, y) * (o.dtest / o.dsep) : () => o.dtest;
  const gw = Math.ceil(o.width / cell) + 1;
  const gh = Math.ceil(o.height / cell) + 1;
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const px: number[] = [];
  const py: number[] = [];
  const pl: number[] = [];
  const pi: number[] = [];
  const dead = new Set<number>();
  const window = Math.ceil((o.dtest * 3) / o.step) + 2;

  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x <= o.width && y <= o.height;
  const free = (x: number, y: number, d: number, line: number, idx: number) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    const d2 = d * d;
    for (let yy = gy - 1; yy <= gy + 1; yy++) {
      if (yy < 0 || yy >= gh) continue;
      for (let xx = gx - 1; xx <= gx + 1; xx++) {
        if (xx < 0 || xx >= gw) continue;
        for (const k of grid[yy * gw + xx]) {
          if (dead.has(pl[k])) continue;
          if (pl[k] === line && Math.abs(pi[k] - idx) < window) continue;
          if ((px[k] - x) ** 2 + (py[k] - y) ** 2 < d2) return false;
        }
      }
    }
    return true;
  };
  const add = (x: number, y: number, line: number, idx: number) => {
    const k = px.length;
    px.push(x); py.push(y); pl.push(line); pi.push(idx);
    grid[Math.floor(y / cell) * gw + Math.floor(x / cell)].push(k);
  };

  const trace = (seed: Pt, line: number, sign: number, budget: number): Pt[] => {
    const out: Pt[] = [];
    let [x, y] = seed;
    let len = 0;
    let idx = 0;
    const h = o.step * sign;
    while (len < budget) {
      const f1 = o.field(x, y);
      if (!f1) break;
      const f2 = o.field(x + f1[0] * h * 0.5, y + f1[1] * h * 0.5);
      if (!f2) break;
      const nx = x + f2[0] * h;
      const ny = y + f2[1] * h;
      idx += sign;
      if (!inside(nx, ny) || !free(nx, ny, testAt(nx, ny), line, idx)) break;
      add(nx, ny, line, idx);
      out.push([nx, ny]);
      x = nx;
      y = ny;
      len += o.step;
    }
    return out;
  };

  const lines: Polyline[] = [];
  let lineId = 0;
  for (const s of o.seeds) {
    if (!inside(s[0], s[1]) || !free(s[0], s[1], sepAt(s[0], s[1]), -1, 0)) continue;
    const id = lineId++;
    add(s[0], s[1], id, 0);
    const budget = o.bidirectional ? o.maxLen / 2 : o.maxLen;
    const fwd = trace(s, id, 1, budget);
    const back = o.bidirectional ? trace(s, id, -1, budget) : [];
    const line: Polyline = [...back.reverse(), s, ...fwd];
    if ((line.length - 1) * o.step < o.minLen) dead.add(id);
    else lines.push(line);
  }
  return lines;
}

export function jitteredGrid(width: number, height: number, spacing: number, rng: () => number): Pt[] {
  const pts: Pt[] = [];
  for (let y = spacing / 2; y < height; y += spacing)
    for (let x = spacing / 2; x < width; x += spacing)
      pts.push([x + (rng() - 0.5) * spacing, y + (rng() - 0.5) * spacing]);
  return pts;
}
