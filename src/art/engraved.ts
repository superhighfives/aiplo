import type { Polyline, Pt } from '../geom';
import type { ParamDef } from '../params';
import { loadTerrainFor, terrainParams } from '../lib/elevation';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'engraved',
  title: 'Engraved terrain',
  description: 'A hillshaded landscape engraved like a banknote: parallel lines that swell into waves where the ground turns from the light.',
  order: 25,
  paper: { paper: 'square', margin: 22 },
  params: [
    // Engraving reads best from broad forms, so smooth the terrain a little more than usual.
    ...terrainParams({ name: 'Half Dome, Yosemite', lat: 37.7459, lon: -119.5332 }, 14).map((p) => (p.key === 'blur' ? { ...p, default: 2 } : p)) as ParamDef[],
    {
      type: 'select', key: 'style', label: 'Style', default: 'passes',
      options: [['passes', 'Doubled lines in the shadows'], ['wave', 'Waves: amplitude follows shade'], ['zigzag', 'Zigzag: sharp engraved teeth']],
    },
    { type: 'number', key: 'angle', label: 'Line angle (°)', min: 0, max: 175, step: 5, default: 0 },
    { type: 'number', key: 'spacing', label: 'Line spacing (mm)', min: 0.5, max: 4, step: 0.05, default: 1.2, hint: 'Waves and zigzags plot slower; try 1.6 mm for those' },
    { type: 'number', key: 'amp', label: 'Swell (× spacing)', min: 0, max: 1.5, step: 0.05, default: 0.32, hint: 'Wave height in the darkest shade, as a fraction of the line spacing', show: (v) => v.style !== 'passes' },
    { type: 'number', key: 'wavelength', label: 'Wavelength (mm)', min: 0.3, max: 4, step: 0.05, default: 0.55, hint: 'Short waves read as a thicker line, like an engraver\'s swelling stroke', show: (v) => v.style !== 'passes' },
    { type: 'number', key: 'displace', label: 'Lift by elevation (mm)', min: 0, max: 20, step: 0.5, default: 3, hint: 'Push lines sideways by height, like ridgelines' },
    { type: 'number', key: 'azimuth', label: 'Light from (°)', min: 0, max: 355, step: 5, default: 315, hint: 'Clockwise from north' },
    { type: 'number', key: 'altitude', label: 'Light altitude (°)', min: 5, max: 85, step: 1, default: 35 },
    { type: 'number', key: 'exaggerate', label: 'Relief exaggeration', min: 0.2, max: 10, step: 0.1, default: 1 },
    { type: 'number', key: 'gamma', label: 'Contrast', min: 0.3, max: 3, step: 0.05, default: 1.3, hint: 'Above 1 keeps lit ground cleaner; below 1 darkens mid-tones' },
    { type: 'checkbox', key: 'frame', label: 'Frame', default: true },
  ],
  async generate(v, ctx) {
    const map = await loadTerrainFor(v, ctx);
    const { width: W, height: H } = ctx;
    const mPerMm = map.groundWidth / W;

    // Hillshade on a grid (screen y down; north is up).
    const cell = 0.4;
    const nx = Math.round(W / cell) + 1, ny = Math.round(H / cell) + 1;
    const elev = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) elev[j * nx + i] = map.metres(i / (nx - 1), j / (ny - 1));
    const az = (v.azimuth * Math.PI) / 180, alt = (v.altitude * Math.PI) / 180;
    const L = [Math.sin(az) * Math.cos(alt), -Math.cos(az) * Math.cos(alt), Math.sin(alt)];
    const dark = new Float32Array(nx * ny);
    const flat = 1 - L[2];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const e = (a: number, b: number) => elev[Math.min(ny - 1, Math.max(0, b)) * nx + Math.min(nx - 1, Math.max(0, a))];
        const gx = ((e(i + 1, j) - e(i - 1, j)) / (2 * cell * mPerMm)) * v.exaggerate;
        const gy = ((e(i, j + 1) - e(i, j - 1)) / (2 * cell * mPerMm)) * v.exaggerate;
        const n = Math.hypot(gx, gy, 1);
        const shade = Math.max(0, (-gx * L[0] - gy * L[1] + L[2]) / n);
        // Flat ground sits at a light, even tone; only real shade gets dark.
        const d = Math.max(0, Math.min(1, (1 - shade - flat * 0.6) / (1 - flat * 0.6)));
        dark[j * nx + i] = Math.pow(d, v.gamma);
      }
    const sample = (arr: Float32Array, x: number, y: number) => {
      const fx = Math.max(0, Math.min(nx - 1.001, x / cell)), fy = Math.max(0, Math.min(ny - 1.001, y / cell));
      const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, k = j * nx + i;
      return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - ty) + (arr[k + nx] * (1 - tx) + arr[k + nx + 1] * tx) * ty;
    };
    const range = map.max - map.min || 1;
    const height = (x: number, y: number) => (sample(elev, x, y) - Math.max(map.min, v.clampSea ? 0 : map.min)) / range;

    // Parallel lines across the area at the given angle.
    const th = (v.angle * Math.PI) / 180;
    const d: Pt = [Math.cos(th), Math.sin(th)];
    const nrm: Pt = [-d[1], d[0]];
    const corners: Pt[] = [[0, 0], [W, 0], [W, H], [0, H]];
    const proj = (p: Pt, a: Pt) => p[0] * a[0] + p[1] * a[1];
    const oMin = Math.min(...corners.map((c) => proj(c, nrm))) - v.displace;
    const oMax = Math.max(...corners.map((c) => proj(c, nrm)));
    const sMin = Math.min(...corners.map((c) => proj(c, d)));
    const sMax = Math.max(...corners.map((c) => proj(c, d)));
    const step = Math.min(0.12, v.wavelength / 8);
    const amp = v.amp * v.spacing;
    const inside = (x: number, y: number) => x >= -0.5 && x <= W + 0.5 && y >= -0.5 && y <= H + 0.5;
    const out: Polyline[] = [];

    for (let o = oMin; o <= oMax; o += v.spacing) {
      let cur: Polyline = [];
      let phase = 0;
      const flush = () => {
        if (cur.length > 1) out.push(cur);
        cur = [];
      };
      // Second pass in the shadows (style 'passes'): segments where it's dark enough.
      let extra: Polyline = [];
      const extras: Polyline[] = [];
      for (let s = sMin; s <= sMax; s += step) {
        const bx = d[0] * s + nrm[0] * o, by = d[1] * s + nrm[1] * o;
        if (!inside(bx, by)) {
          flush();
          continue;
        }
        const dk = sample(dark, bx, by);
        const lift = v.displace > 0 ? -v.displace * height(bx, by) : 0;
        let off = lift;
        if (v.style === 'wave') {
          phase += (2 * Math.PI * step) / v.wavelength;
          off += amp * dk * Math.sin(phase);
        } else if (v.style === 'zigzag') {
          phase += step / v.wavelength;
          const tri = 4 * Math.abs(phase - Math.floor(phase + 0.5)) - 1; // triangle wave in [-1, 1]
          off += amp * dk * tri;
        }
        const p: Pt = [bx + nrm[0] * off, by + nrm[1] * off];
        if (inside(p[0], p[1])) cur.push(p);
        else flush();
        if (v.style === 'passes') {
          // Up to two extra strokes beside the line, 0.3 spacing apart, where shade passes thresholds.
          const q: Pt = [p[0] + nrm[0] * v.spacing * 0.3, p[1] + nrm[1] * v.spacing * 0.3];
          if (dk > 0.35 && inside(q[0], q[1])) extra.push(q);
          else {
            if (extra.length > 1) extras.push(extra);
            extra = [];
          }
        }
      }
      flush();
      if (extra.length > 1) extras.push(extra);
      out.push(...extras);
    }
    if (v.style === 'passes') {
      // A third stroke in the deepest shade.
      for (let o = oMin; o <= oMax; o += v.spacing) {
        let cur: Polyline = [];
        for (let s = sMin; s <= sMax; s += 0.2) {
          const bx = d[0] * s + nrm[0] * o, by = d[1] * s + nrm[1] * o;
          const dk = inside(bx, by) ? sample(dark, bx, by) : 0;
          const lift = v.displace > 0 ? -v.displace * height(bx, by) : 0;
          const p: Pt = [bx + nrm[0] * (lift - v.spacing * 0.3), by + nrm[1] * (lift - v.spacing * 0.3)];
          if (dk > 0.7 && inside(p[0], p[1])) cur.push(p);
          else {
            if (cur.length > 1) out.push(cur);
            cur = [];
          }
        }
        if (cur.length > 1) out.push(cur);
      }
    }
    if (v.frame) out.push([[0, 0], [W, 0], [W, H], [0, H], [0, 0]]);
    return out;
  },
});
