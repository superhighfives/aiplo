import { circle, type Polyline } from '../geom';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'calibration',
  title: 'Calibration',
  description: 'Arrow, measured square and spiral to check direction, scale and pens.',
  kind: 'tool',
  order: 2,
  params: [
    { type: 'number', key: 'size', label: 'Square (mm)', min: 10, max: 150, step: 1, default: 50 },
    { type: 'checkbox', key: 'spiral', label: 'Spiral (corner speed test)', default: true },
  ],
  generate(v) {
    const s = v.size;
    const out: Polyline[] = [
      // Arrow at origin pointing +x, so you can verify axis directions.
      [[0, 0], [12, 0]], [[9, -2], [12, 0], [9, 2]],
      [[0, 0], [0, 6]],
      // Square of known size: measure it to check scale.
      [[0, 10], [s, 10], [s, 10 + s], [0, 10 + s], [0, 10]],
      circle(s / 2, 10 + s / 2, s / 2 - 2, 120),
    ];
    if (v.spiral) {
      const pts: Polyline = [];
      const cx = s + 10 + s / 2, cy = 10 + s / 2;
      for (let a = 0; a < Math.PI * 2 * 12; a += 0.05) {
        const r = (a / (Math.PI * 2 * 12)) * (s / 2);
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      out.push(pts);
    }
    return out;
  },
});
