import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { clipTo } from '../lib/gen-util';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'moire',
  title: 'Moiré',
  description: 'Two families of lines on two pens, slightly offset, so their interference draws ghost patterns neither contains.',
  order: 64,
  paper: { paper: 'square', margin: 15 },
  params: [
    { type: 'select', key: 'mode', label: 'Pattern', options: [['circles', 'Concentric circles'], ['lines', 'Parallel lines'], ['radial', 'Radial lines']], default: 'circles' },
    { type: 'number', key: 'spacing', label: 'Spacing (mm)', min: 0.6, max: 8, step: 0.1, default: 2, show: (v) => v.mode !== 'radial' },
    { type: 'number', key: 'rays', label: 'Rays', min: 24, max: 720, step: 1, default: 240, show: (v) => v.mode === 'radial' },
    { type: 'number', key: 'offset', label: 'Centre offset (mm)', min: 0, max: 80, step: 0.5, default: 9, show: (v) => v.mode !== 'lines', hint: 'Distance between the two centres' },
    { type: 'number', key: 'direction', label: 'Offset direction (°)', min: 0, max: 360, step: 1, default: 30, show: (v) => v.mode !== 'lines' },
    { type: 'number', key: 'rotation', label: 'Rotation (°)', min: 0, max: 30, step: 0.1, default: 4, show: (v) => v.mode !== 'circles', hint: 'Angle between the two families' },
    { type: 'number', key: 'angle', label: 'Angle (°)', min: 0, max: 180, step: 1, default: 0, show: (v) => v.mode === 'lines' },
    { type: 'number', key: 'scale', label: 'Second pen scale', min: 0.9, max: 1.1, step: 0.005, default: 1, show: (v) => v.mode !== 'radial', hint: 'Spacing of the second family relative to the first' },
    { type: 'select', key: 'shape', label: 'Shape', options: [['disc', 'Disc'], ['full', 'Full page']], default: 'disc' },
  ],
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const cx = W / 2, cy = H / 2;
    const reach = Math.hypot(W, H) / 2 + 2;
    const rot = (v.rotation * Math.PI) / 180;
    const dir = (v.direction * Math.PI) / 180;
    // Family 0 sits at -offset/2, family 1 at +offset/2 (and rotated by `rotation`).
    const centre = (f: number): Pt => [cx + (f ? 0.5 : -0.5) * v.offset * Math.cos(dir), cy + (f ? 0.5 : -0.5) * v.offset * Math.sin(dir)];

    const family = (f: number): Polyline[] => {
      const out: Polyline[] = [];
      const sp = v.spacing * (f ? v.scale : 1);
      if (v.mode === 'circles') {
        const [ox, oy] = centre(f);
        const far = reach + v.offset;
        for (let r = sp; r < far; r += sp) out.push(circle(ox, oy, r, Math.max(24, Math.ceil(r * 2))));
      } else if (v.mode === 'lines') {
        const a = (v.angle * Math.PI) / 180 + f * rot;
        const ux = Math.cos(a), uy = Math.sin(a);
        const n = Math.ceil(reach / sp);
        for (let k = -n; k <= n; k++) {
          const px = cx - uy * k * sp, py = cy + ux * k * sp;
          out.push([[px - ux * reach, py - uy * reach], [px + ux * reach, py + uy * reach]]);
        }
      } else {
        const [ox, oy] = centre(f);
        const n = Math.max(3, Math.round(v.rays));
        // Start each ray where neighbours are ≥ 0.6 mm apart so the hub isn't solid ink.
        const r0 = (0.6 * n) / (2 * Math.PI);
        const far = reach + v.offset;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * 2 * Math.PI + f * rot;
          out.push([[ox + Math.cos(a) * r0, oy + Math.sin(a) * r0], [ox + Math.cos(a) * far, oy + Math.sin(a) * far]]);
        }
      }
      return out;
    };

    const R = Math.min(W, H) / 2;
    const inside = v.shape === 'disc' ? (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= R * R : (x: number, y: number) => x >= 0 && y >= 0 && x <= W && y <= H;
    const layers: Layer[] = [0, 1].map((f) => ({ name: f ? 'Second family' : 'First family', color: f ? PALETTE[1] : PALETTE[0], paths: clipTo(family(f), inside, 1) }));
    return layers;
  },
});
