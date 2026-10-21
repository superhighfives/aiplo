import type { Polyline, Pt } from '../geom';

/**
 * Even-odd scanline hatching of a shape made of one or more closed rings (holes allowed).
 * `angle` in degrees; lines are `spacing` mm apart. Alternate lines run in opposite
 * directions so the pen zig-zags instead of returning.
 */
export function hatchPolygon(rings: Pt[][], angle: number, spacing: number, offset = 0): Polyline[] {
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // Rotate into a frame where hatch lines are horizontal.
  const rot = rings.map((r) => r.map(([x, y]) => [x * c + y * s, -x * s + y * c] as Pt));
  let minY = Infinity, maxY = -Infinity;
  for (const r of rot) for (const p of r) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const out: Polyline[] = [];
  let k = 0;
  for (let y = Math.ceil((minY - offset) / spacing) * spacing + offset; y <= maxY; y += spacing, k++) {
    const xs: number[] = [];
    for (const r of rot) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [x1, y1] = r[i];
        const [x2, y2] = r[j];
        if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((p, q) => p - q);
    const segs: Polyline[] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const back = (x: number): Pt => [x * c - y * s, x * s + y * c];
      segs.push(k % 2 ? [back(xs[i + 1]), back(xs[i])] : [back(xs[i]), back(xs[i + 1])]);
    }
    out.push(...(k % 2 ? segs.reverse() : segs));
  }
  return out;
}

export interface ToneHatchOptions {
  /** Degrees. */
  angle: number;
  /** Closest line spacing in mm (reached where darkness = 1). */
  spacing: number;
  /** Sampling step along each line in mm. */
  step?: number;
  /** Drop dashes shorter than this (mm). */
  minLength?: number;
}

/**
 * Tone by hatching: parallel lines, each with its own darkness threshold, drawn only
 * where `darkness(x, y)` (0 = paper, 1 = full) exceeds it. Darker areas get more lines.
 */
export function toneHatch(darkness: (x: number, y: number) => number, W: number, H: number, o: ToneHatchOptions): Polyline[] {
  const a = (o.angle * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a); // along the line
  const nx = -dy, ny = dx; // across lines
  const step = o.step ?? 0.3;
  const R = Math.hypot(W, H) / 2;
  const cx = W / 2, cy = H / 2;
  const out: Polyline[] = [];
  let i = 0;
  for (let off = -R; off <= R; off += o.spacing, i++) {
    // Low-discrepancy thresholds spread each darkness level evenly across the lines.
    const threshold = (i * 0.6180339887498949) % 1;
    let cur: Polyline | null = null;
    for (let t = -R; t <= R; t += step) {
      const x = cx + dx * t + nx * off;
      const y = cy + dy * t + ny * off;
      const inside = x >= 0 && y >= 0 && x <= W && y <= H;
      if (inside && darkness(x, y) > threshold) {
        if (!cur) out.push((cur = []));
        cur.push([x, y]);
      } else cur = null;
    }
  }
  const min = o.minLength ?? 0.6;
  return out.filter((p) => p.length > 1 && Math.hypot(p[p.length - 1][0] - p[0][0], p[p.length - 1][1] - p[0][1]) >= min);
}
