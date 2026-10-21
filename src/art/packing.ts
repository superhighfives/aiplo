import { Delaunay } from 'd3-delaunay';
import { circle, smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { insetConvex, polygonArea, polygonCentroid } from '../lib/gen-util';
import { imageParams, loadDarkness } from '../lib/image';
import type { Rng } from '../random';
import { defineArtwork } from './types';

type Circle = [number, number, number];

/** Largest-first random packing with a spatial grid. `cap(x, y)` limits the radius locally. */
function packCircles(W: number, H: number, rmin: number, rmax: number, gap: number, cap: (x: number, y: number) => number, rng: Rng, budget: number): Circle[] {
  const cell = 2 * rmax + gap;
  const gw = Math.ceil(W / cell) + 1, gh = Math.ceil(H / cell) + 1;
  const grid: Circle[][] = Array.from({ length: gw * gh }, () => []);
  const out: Circle[] = [];
  const fits = (x: number, y: number, r: number) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let j = gy - 1; j <= gy + 1; j++) {
      if (j < 0 || j >= gh) continue;
      for (let i = gx - 1; i <= gx + 1; i++) {
        if (i < 0 || i >= gw) continue;
        for (const [cx, cy, cr] of grid[j * gw + i]) {
          const d = r + cr + gap;
          if ((x - cx) ** 2 + (y - cy) ** 2 < d * d) return false;
        }
      }
    }
    return true;
  };
  // Radii shrink geometrically; each level gets attempts in proportion to how many such circles
  // could fit, within an overall budget.
  const levels = 40;
  const weights = Array.from({ length: levels }, (_, k) => 1 / (rmax * Math.pow(rmin / rmax, k / (levels - 1))) ** 2);
  const wsum = weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k < levels; k++) {
    const r = rmax * Math.pow(rmin / rmax, k / (levels - 1));
    const tries = Math.max(50, Math.round((budget * weights[k]) / wsum));
    for (let t = 0; t < tries; t++) {
      const x = r + rng() * (W - 2 * r), y = r + rng() * (H - 2 * r);
      if (r > cap(x, y) + 1e-9 || !fits(x, y, r)) continue;
      const c: Circle = [x, y, r];
      out.push(c);
      grid[Math.floor(y / cell) * gw + Math.floor(x / cell)].push(c);
    }
  }
  return out;
}

export default defineArtwork({
  slug: 'packing',
  title: 'Circle packing and Voronoi',
  description: 'Circles packed largest-first, or relaxed Voronoi cells, optionally sized by a photo so dark areas fill with small, dense shapes.',
  order: 67,
  paper: { paper: 'letter', orientation: 'portrait', margin: 15 },
  params: [
    { type: 'select', key: 'style', label: 'Style', options: [['circles', 'Circle packing'], ['voronoi', 'Voronoi cells']], default: 'circles' },
    { type: 'seed', key: 'seed', label: 'Seed', default: 1 },
    { type: 'checkbox', key: 'useImage', label: 'Size by image', default: true, hint: 'Dark areas get small, dense shapes' },
    { type: 'number', key: 'rmax', label: 'Largest radius (mm)', min: 2, max: 60, step: 0.5, default: 14, show: (v) => v.style === 'circles' },
    { type: 'number', key: 'rmin', label: 'Smallest radius (mm)', min: 0.5, max: 10, step: 0.1, default: 1.5, show: (v) => v.style === 'circles' },
    { type: 'number', key: 'gap', label: 'Gap (mm)', min: 0, max: 5, step: 0.1, default: 0.6, show: (v) => v.style === 'circles' },
    { type: 'number', key: 'cells', label: 'Cells', min: 20, max: 4000, step: 10, default: 500, show: (v) => v.style === 'voronoi' },
    { type: 'number', key: 'lloyd', label: 'Relaxation steps', min: 0, max: 50, step: 1, default: 8, show: (v) => v.style === 'voronoi', hint: 'Lloyd iterations: moves each site to its cell’s (darkness-weighted) centre' },
    { type: 'number', key: 'inset', label: 'Inset (mm)', min: 0, max: 5, step: 0.05, default: 0.7, show: (v) => v.style === 'voronoi', hint: 'Shrinks each cell, leaving a gutter' },
    { type: 'number', key: 'round', label: 'Rounding (mm)', min: 0, max: 8, step: 0.1, default: 1.5, show: (v) => v.style === 'voronoi' },
    { type: 'number', key: 'rings', label: 'Ring spacing (mm)', min: 0, max: 6, step: 0.1, default: 2, hint: 'Concentric rings inside each shape on a second pen; 0 = none' },
    { type: 'number', key: 'gamma', label: 'Tone curve', min: 0.3, max: 3, step: 0.05, default: 1, show: (v) => v.useImage },
    ...imageParams().map((p) => ({ ...p, show: (v: Record<string, any>) => !!v.useImage })),
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const dark = v.useImage ? await loadDarkness(v, W, H, ctx.status) : null;
    const tone = (x: number, y: number) => (dark ? Math.pow(Math.max(0, Math.min(1, dark(x, y))), v.gamma) : 0);
    const outlines: Polyline[] = [];
    const rings: Polyline[] = [];

    if (v.style === 'circles') {
      const rmin = Math.max(0.3, Math.min(v.rmin, v.rmax));
      const rmax = Math.max(rmin, v.rmax);
      const cap = dark ? (x: number, y: number) => rmax * Math.pow(rmin / rmax, tone(x, y)) : () => rmax;
      const circles = packCircles(W, H, rmin, rmax, v.gap, cap, ctx.rng, 250000);
      ctx.status(`${circles.length} circles`);
      for (const [x, y, r] of circles) {
        outlines.push(circle(x, y, r, Math.max(16, Math.ceil(r * 4))));
        if (v.rings > 0) for (let rr = r - v.rings; rr > v.rings * 0.5; rr -= v.rings) rings.push(circle(x, y, rr, Math.max(12, Math.ceil(rr * 4))));
      }
    } else {
      // Sites: rejection-sampled by darkness (with a floor so light areas still get some).
      const n = Math.max(3, Math.round(v.cells));
      const weight = (x: number, y: number) => (dark ? 0.06 + tone(x, y) : 1);
      const sites: Pt[] = [];
      for (let guard = 0; sites.length < n && guard < n * 400; guard++) {
        const x = ctx.rng() * W, y = ctx.rng() * H;
        if (ctx.rng() * 1.06 < weight(x, y)) sites.push([x, y]);
      }
      // Lloyd relaxation. With an image, centroids are weighted by darkness over a sample grid,
      // which keeps the cells small where it's dark; without one, plain polygon centroids.
      const step = Math.max(0.5, Math.sqrt((W * H) / n) / 6);
      const samples: [number, number, number][] = [];
      if (dark) for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) samples.push([x, y, weight(x, y)]);
      for (let it = 0; it < v.lloyd; it++) {
        const dl = Delaunay.from(sites);
        if (dark) {
          const sx = new Float64Array(sites.length), sy = new Float64Array(sites.length), sw = new Float64Array(sites.length);
          let last = 0;
          for (const [x, y, w] of samples) {
            last = dl.find(x, y, last);
            sx[last] += x * w;
            sy[last] += y * w;
            sw[last] += w;
          }
          for (let i = 0; i < sites.length; i++) if (sw[i] > 0) sites[i] = [sx[i] / sw[i], sy[i] / sw[i]];
        } else {
          const vor = dl.voronoi([0, 0, W, H]);
          for (let i = 0; i < sites.length; i++) {
            const poly = vor.cellPolygon(i);
            if (poly) sites[i] = polygonCentroid(poly.slice(0, -1) as Pt[]);
          }
        }
      }
      const vor = Delaunay.from(sites).voronoi([0, 0, W, H]);
      const shape = (ring: Pt[]): Polyline | null => {
        if (ring.length < 3 || Math.abs(polygonArea(ring)) < 0.05) return null;
        const p: Polyline = [...ring, ring[0]];
        return v.round > 0 ? smooth(p, Math.min(v.round, Math.sqrt(Math.abs(polygonArea(ring))) * 0.4)) : p;
      };
      for (let i = 0; i < sites.length; i++) {
        const poly = vor.cellPolygon(i);
        if (!poly) continue;
        let ring = insetConvex(poly as Pt[], v.inset);
        const outline = shape(ring);
        if (!outline) continue;
        outlines.push(outline);
        if (v.rings > 0)
          for (let k = 1; k < 50; k++) {
            ring = insetConvex(poly as Pt[], v.inset + k * v.rings);
            const s = shape(ring);
            if (!s) break;
            rings.push(s);
          }
      }
      ctx.status(`${outlines.length} cells`);
    }
    const layers: Layer[] = [{ name: 'Outlines', color: PALETTE[0], paths: outlines }];
    if (rings.length) layers.push({ name: 'Rings', color: PALETTE[2], paths: rings });
    return layers;
  },
});
