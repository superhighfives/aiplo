import { dist, polylineLength, type Polyline, type Pt } from './geom';
import type { Layer } from './layers';

/** Splits a polyline at distance `d` along it. */
function splitPolyline(p: Polyline, d: number): [Polyline, Polyline] {
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const seg = dist(p[i - 1], p[i]);
    if (acc + seg >= d) {
      const t = seg > 0 ? (d - acc) / seg : 0;
      const q: Pt = [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t];
      return [[...p.slice(0, i), q], [q, ...p.slice(i)]];
    }
    acc += seg;
  }
  return [p, []];
}

export interface Split {
  /** Ink before the split point (already plotted), per pen. */
  before: Layer[];
  /** Ink still to plot, per pen (same order and length as the input; done pens are empty). */
  after: Layer[];
  /** Total ink (mm) across all pens. */
  total: number;
  /** Ink (mm) before the split point. */
  skipped: number;
}

/**
 * Splits pens, in plot order, at a fraction `f` of their total ink, cutting mid-line
 * if needed. This is what lets a plot start (or resume) from any point on the timeline.
 */
export function splitAt(pens: Layer[], f: number): Split {
  const total = pens.reduce((t, l) => t + l.paths.reduce((s, p) => s + polylineLength(p), 0), 0);
  let skip = Math.max(0, Math.min(1, f)) * total;
  const skipped = skip;
  const before: Layer[] = [];
  const after: Layer[] = [];
  for (const l of pens) {
    const b: Polyline[] = [];
    const a: Polyline[] = [];
    for (const p of l.paths) {
      if (skip <= 0) {
        a.push(p);
        continue;
      }
      const len = polylineLength(p);
      if (skip >= len) {
        b.push(p);
        skip -= len;
      } else {
        const [head, tail] = splitPolyline(p, skip);
        if (head.length > 1) b.push(head);
        if (tail.length > 1) a.push(tail);
        skip = 0;
      }
    }
    before.push({ ...l, paths: b });
    after.push({ ...l, paths: a });
  }
  return { before, after, total, skipped };
}

export const inkOf = (l: Layer) => l.paths.reduce((s, p) => s + polylineLength(p), 0);
