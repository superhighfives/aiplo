import { circle, type Polyline } from '../geom';
import { PALETTE } from '../layers';
import { text } from '../lib/hershey';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'calibration',
  title: 'Calibration',
  description: 'Arrow, measured square and spiral to check direction, scale and pens, plus two-pen registration marks.',
  kind: 'tool',
  order: 2,
  params: [
    { type: 'number', key: 'size', label: 'Square (mm)', min: 10, max: 150, step: 1, default: 50 },
    { type: 'checkbox', key: 'spiral', label: 'Spiral (corner speed test)', default: true },
    {
      type: 'checkbox', key: 'registration', label: 'Registration marks for a second pen', default: false,
      hint: 'Plot both pens, then read the scales: the numbered pen-2 tick that lines up with a pen-1 tick gives the offset in 0.2 mm steps. Enter the opposite as that pen\'s Nudge.',
    },
  ],
  generate(v, ctx) {
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
    if (!v.registration) return out;

    // Registration: crosshairs in both pens, plus vernier scales. Pen 1 has ticks every 2 mm and
    // pen 2 every 1.8 mm, meeting at a baseline. If pen 2 lands d mm right of (or below) pen 1,
    // its tick number k = d / 0.2 lines up with a pen-1 tick (negative k = left / above).
    const pen1: Polyline[] = [];
    const pen2: Polyline[] = [];
    const cross = (x: number, y: number, into: Polyline[]) => {
      into.push([[x - 12, y], [x + 12, y]], [[x, y - 12], [x, y + 12]], circle(x, y, 6, 48));
    };
    const W = ctx.width, H = ctx.height;
    for (const [x, y] of [[W - 25, 25], [25, H - 25], [W - 25, H - 25]] as [number, number][]) {
      cross(x, y, pen1);
      cross(x, y, pen2);
    }
    const vernier = (x0: number, y0: number, vertical: boolean) => {
      const at = (along: number, across: number): [number, number] => (vertical ? [x0 + across, y0 + along] : [x0 + along, y0 + across]);
      for (let i = -10; i <= 10; i++) {
        const long = i % 5 === 0 ? 2.5 : 0;
        pen1.push([at(i * 2, 0), at(i * 2, -(5 + long))]); // main scale
        pen2.push([at(i * 1.8, 0.4), at(i * 1.8, 5.4 + long)]); // vernier
        if (i % 5 === 0) {
          const [tx, ty] = at(i * 1.8, 12);
          pen2.push(...text(String(i), { size: 2.2, x: tx, y: ty + (vertical ? 1 : 0), align: vertical ? 'left' : 'center' }));
        }
      }
    };
    vernier(W / 2 - 10, H - 40, false);
    vernier(W - 30, H / 2 + 10, true);
    pen1.push(
      ...text('Registration: find the pen-2 tick (numbered) that lines up with a pen-1 tick.', { size: 2.4, x: W / 2 - 75, y: H - 58 }),
      ...text('k lined up = pen 2 is k x 0.2 mm right (x scale) or down (y scale). Nudge pen 2 by the opposite.', { size: 2.4, x: W / 2 - 75, y: H - 53 }),
    );
    return [
      { name: 'Pen 1', color: PALETTE[0], paths: [...out, ...pen1] },
      { name: 'Pen 2', color: PALETTE[1], paths: pen2 },
    ];
  },
});
