import { dist, type Polyline, type Pt } from '../geom';

/** A constant-velocity chunk of motion ending at (x, y) mm, lasting dt seconds. */
export interface Block {
  x: number;
  y: number;
  dt: number;
}

const SLICE = 0.02; // seconds per emitted block (approximates acceleration ramps)

/**
 * Trapezoidal velocity planning along a polyline, starting and ending at rest.
 * Corner speeds use GRBL-style junction deviation (`cornering`, mm).
 */
export function planPath(points: Polyline, vmax: number, accel: number, cornering: number): Block[] {
  const pts: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) if (dist(pts[pts.length - 1], points[i]) > 1e-3) pts.push(points[i]);
  const n = pts.length;
  if (n < 2) return [];

  const L: number[] = [];
  const D: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const l = dist(pts[i], pts[i + 1]);
    L.push(l);
    D.push([(pts[i + 1][0] - pts[i][0]) / l, (pts[i + 1][1] - pts[i][1]) / l]);
  }

  const v = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const cos = -(D[i - 1][0] * D[i][0] + D[i - 1][1] * D[i][1]);
    if (cos < -0.9999) v[i] = vmax;
    else {
      const sinHalf = Math.sqrt((1 - cos) / 2);
      v[i] = Math.min(vmax, Math.sqrt((accel * cornering * sinHalf) / (1 - sinHalf)));
    }
  }
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * accel * L[i]));
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * accel * L[i - 1]));

  const blocks: Block[] = [];
  for (let i = 0; i < n - 1; i++) {
    const len = L[i];
    const vi = v[i];
    const vo = v[i + 1];
    let vp = vmax;
    let sa = (vp * vp - vi * vi) / (2 * accel);
    let sd = (vp * vp - vo * vo) / (2 * accel);
    if (sa + sd > len) {
      vp = Math.sqrt(Math.max(0, (2 * accel * len + vi * vi + vo * vo) / 2));
      vp = Math.max(vp, vi, vo);
      sa = Math.max(0, (vp * vp - vi * vi) / (2 * accel));
      sd = Math.max(0, (vp * vp - vo * vo) / (2 * accel));
    }
    const sc = Math.max(0, len - sa - sd);
    const ta = (vp - vi) / accel;
    const tc = vp > 0 ? sc / vp : 0;
    const td = (vp - vo) / accel;
    const T = ta + tc + td;
    if (!(T > 0)) continue;
    const s = (t: number) => {
      if (t < ta) return vi * t + 0.5 * accel * t * t;
      if (t < ta + tc) return sa + vp * (t - ta);
      const u = t - ta - tc;
      return sa + sc + vp * u - 0.5 * accel * u * u;
    };
    const k = Math.max(1, Math.ceil(T / SLICE));
    for (let j = 1; j <= k; j++) {
      const d = j === k ? len : Math.min(len, s((T * j) / k));
      blocks.push({ x: pts[i][0] + D[i][0] * d, y: pts[i][1] + D[i][1] * d, dt: T / k });
    }
  }
  return blocks;
}

export const blocksTime = (b: Block[]) => b.reduce((t, x) => t + x.dt, 0);
