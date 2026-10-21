import type { Polyline } from '../geom';
import { imageParams, loadDarkness } from '../lib/image';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'spiral-halftone',
  title: 'Spiral halftone',
  description: 'One continuous spiral from the centre out, wobbling wider wherever the photo is dark.',
  order: 51,
  paper: { paper: 'letter', orientation: 'portrait', margin: 20 },
  params: [
    ...imageParams(),
    { type: 'number', key: 'spacing', label: 'Turn spacing (mm)', min: 0.8, max: 8, step: 0.1, default: 2.6 },
    { type: 'number', key: 'amp', label: 'Max amplitude', min: 0.1, max: 1.5, step: 0.05, default: 0.95, hint: 'Peak wobble relative to the turn spacing; above 1 turns overlap' },
    { type: 'number', key: 'freq', label: 'Wobble (waves/mm)', min: 0.1, max: 3, step: 0.05, default: 0.5 },
    { type: 'number', key: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.05, default: 1.2 },
    { type: 'number', key: 'floor', label: 'Cut-off', min: 0, max: 0.5, step: 0.01, default: 0.06, hint: 'Darkness below this draws a plain spiral' },
    { type: 'select', key: 'shape', label: 'Shape', options: [['fill', 'Fill the page'], ['circle', 'Circle']], default: 'fill' },
    { type: 'number', key: 'cx', label: 'Centre x', min: 0, max: 1, step: 0.01, default: 0.5 },
    { type: 'number', key: 'cy', label: 'Centre y', min: 0, max: 1, step: 0.01, default: 0.45 },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const cx = v.cx * W, cy = v.cy * H;
    const sp = v.spacing;
    const amp = (v.amp * sp) / 2;
    // In circle mode the photo is fitted to the circle's bounding square, not the page.
    const R = Math.min(cx, cy, W - cx, H - cy);
    const circle = v.shape === 'circle';
    const box = circle ? { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R } : { x: 0, y: 0, w: W, h: H };
    const img = await loadDarkness(v, Math.max(1, box.w), Math.max(1, box.h), ctx.status);
    const dark = (x: number, y: number) => img(x - box.x, y - box.y);
    // Farthest corner (fill) or the largest circle that fits (circle).
    const rMax =
      circle
        ? R - amp
        : Math.max(Math.hypot(cx, cy), Math.hypot(W - cx, cy), Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy)) + amp;
    const tone = (x: number, y: number) => {
      if (x < box.x || y < box.y || x > box.x + box.w || y > box.y + box.h) return 0;
      const d = dark(x, y);
      if (d <= v.floor) return 0;
      return Math.pow((d - v.floor) / (1 - v.floor), v.gamma);
    };
    const ds = Math.min(0.15, 0.1 / v.freq); // arc-length step, mm
    const out: Polyline[] = [];
    let line: Polyline = [];
    let theta = 0, phase = 0, d = 0;
    // r = sp * theta / 2π (Archimedean); advance theta so each step covers ~ds of arc.
    for (;;) {
      const r = (sp * theta) / (2 * Math.PI);
      if (r > rMax) break;
      const c = Math.cos(theta), s = Math.sin(theta);
      const bx = cx + r * c, by = cy + r * s;
      // Fade the wobble in over the first turn so the centre isn't a knot.
      const fade = Math.min(1, r / sp);
      d += (tone(bx, by) - d) * 0.35;
      const rr = r + Math.sin(phase) * amp * d * fade;
      const x = cx + rr * c, y = cy + rr * s;
      // Break the line where it leaves the page so off-page turns don't cost points.
      if (x < -1 || y < -1 || x > W + 1 || y > H + 1) {
        if (line.length > 1) out.push(line);
        line = [];
      } else line.push([x, y]);
      phase += 2 * Math.PI * v.freq * (1 + d) * ds;
      theta += ds / Math.max(Math.hypot(r, sp / (2 * Math.PI)), 0.05);
    }
    if (line.length > 1) out.push(line);
    return out;
  },
});
