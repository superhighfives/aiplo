import { polylineLength, smooth, type Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { contourLevels, loadTerrainFor, terrainParams } from '../lib/elevation';
import { defineArtwork } from './types';

const FAR = 1e20;

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/** Euclidean distance (in cells) from every cell to the nearest `true` cell of the mask. */
export function distanceTransform(mask: Uint8Array, nx: number, ny: number): Float32Array {
  const g = new Float64Array(nx * ny);
  for (let i = 0; i < g.length; i++) g[i] = mask[i] ? 0 : FAR;
  const n = Math.max(nx, ny);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = g[j * nx + i];
    edt1d(f, ny, d, v, z);
    for (let j = 0; j < ny; j++) g[j * nx + i] = d[j];
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = g[j * nx + i];
    edt1d(f, nx, d, v, z);
    for (let i = 0; i < nx; i++) g[j * nx + i] = d[i];
  }
  const out = new Float32Array(nx * ny);
  for (let i = 0; i < g.length; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

export default defineArtwork({
  slug: 'coast-ripples',
  title: 'Coastline ripples',
  description: 'Water drawn as ripple lines echoing the coast outward, like the seas on old Japanese maps.',
  order: 20,
  paper: { paper: 'letter', orientation: 'landscape', margin: 18 },
  params: [
    ...terrainParams({ name: 'Matsushima Bay, Japan', lat: 38.3500, lon: 141.1050 }, 12),
    { type: 'number', key: 'seaLevel', label: 'Sea level (m)', min: -5, max: 10, step: 0.5, default: 1, hint: 'Ground at or below this counts as sea; raise it if flat coasts come out noisy' },
    { type: 'number', key: 'count', label: 'Ripples', min: 1, max: 60, step: 1, default: 14 },
    { type: 'number', key: 'spacing', label: 'Spacing (mm)', min: 0.4, max: 8, step: 0.1, default: 1.1, hint: 'Gap from the coast to the first ripple, and between the first few' },
    { type: 'number', key: 'growth', label: 'Spacing growth', min: 1, max: 1.5, step: 0.01, default: 1.12, hint: 'Each ripple sits this much further from the last' },
    { type: 'number', key: 'curves', label: 'Curves (mm)', min: 0, max: 6, step: 0.1, default: 1.2 },
    { type: 'number', key: 'minIsland', label: 'Skip islets under (mm)', min: 0, max: 10, step: 0.5, default: 1.5, hint: 'Rocks with a coastline shorter than this are ignored' },
    { type: 'checkbox', key: 'land', label: 'Land contours', default: false, hint: 'Elevation contours on land, on a second pen' },
    { type: 'number', key: 'interval', label: 'Contour interval (m)', min: 5, max: 500, step: 5, default: 50, show: (v) => v.land },
    { type: 'number', key: 'cell', label: 'Resolution (mm)', min: 0.2, max: 2, step: 0.05, default: 0.4 },
    { type: 'checkbox', key: 'frame', label: 'Frame', default: true },
  ],
  async generate(v, ctx) {
    const map = await loadTerrainFor(v, ctx);
    const { width: W, height: H } = ctx;
    const cell = v.cell;
    const nx = Math.round(W / cell) + 1, ny = Math.round(H / cell) + 1;
    const land = new Uint8Array(nx * ny);
    let landCount = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const l = map.metres(i / (nx - 1), j / (ny - 1)) > v.seaLevel;
        land[j * nx + i] = l ? 1 : 0;
        landCount += l ? 1 : 0;
      }
    if (landCount === 0) throw new Error('No land here: move the location towards a coast or zoom out');
    if (landCount === nx * ny) throw new Error('No sea here: move the location towards a coast or zoom out');

    // Drop tiny islets from the mask before measuring distance (flood fill each land blob).
    const coastRaw = contourLevels(map.metres, W, H, [v.seaLevel], cell)[0];
    if (v.minIsland > 0) {
      const seen = new Uint8Array(nx * ny);
      const stack: number[] = [];
      const minCells = Math.pow(v.minIsland / cell / Math.PI, 2) * Math.PI; // area of a circle of that perimeter
      for (let s = 0; s < land.length; s++) {
        if (!land[s] || seen[s]) continue;
        const blob: number[] = [];
        stack.push(s);
        seen[s] = 1;
        while (stack.length) {
          const c = stack.pop()!;
          blob.push(c);
          const ci = c % nx, cj = (c - ci) / nx;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const a = ci + di, b = cj + dj;
            if (a < 0 || a >= nx || b < 0 || b >= ny) continue;
            const q = b * nx + a;
            if (land[q] && !seen[q]) {
              seen[q] = 1;
              stack.push(q);
            }
          }
        }
        if (blob.length < minCells) for (const c of blob) land[c] = 0;
      }
    }
    const dist = distanceTransform(land, nx, ny);
    const field = (u: number, vv: number) => {
      const x = Math.min(nx - 1.001, u * (nx - 1)), y = Math.min(ny - 1.001, vv * (ny - 1));
      const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, k = j * nx + i;
      return ((dist[k] * (1 - fx) + dist[k + 1] * fx) * (1 - fy) + (dist[k + nx] * (1 - fx) + dist[k + nx + 1] * fx) * fy) * cell;
    };
    const levels: number[] = [];
    let d = 0, gap = v.spacing;
    for (let k = 0; k < v.count; k++) {
      d += gap;
      levels.push(d);
      gap *= v.growth;
    }
    const minLen = Math.max(0.5, v.minIsland);
    const keep = (l: Polyline) => polylineLength(l) >= minLen;
    const ripples = contourLevels(field, W, H, levels, cell).flatMap((ls) => ls.map((l) => smooth(l, v.curves)).filter(keep));
    const coast = coastRaw.map((l) => smooth(l, Math.min(v.curves, 0.6))).filter(keep);

    const layers: Layer[] = [
      { name: 'Coast', color: PALETTE[0], paths: coast },
      { name: 'Ripples', color: PALETTE[2], paths: ripples },
    ];
    if (v.land) {
      const lo = Math.max(0, map.min);
      const lv: number[] = [];
      for (let m = Math.ceil((lo + 1) / v.interval) * v.interval; m < map.max && lv.length < 300; m += v.interval) lv.push(m);
      const contours = contourLevels(map.metres, W, H, lv, cell).flatMap((ls) => ls.map((l) => smooth(l, v.curves)).filter(keep));
      layers.push({ name: 'Land contours', color: PALETTE[3], paths: contours });
    }
    if (v.frame) layers[0].paths.push([[0, 0], [W, 0], [W, H], [0, H], [0, 0]]);
    ctx.status(`${map.summary} · ${levels.length} ripples out to ${d.toFixed(1)} mm`);
    return layers;
  },
});
