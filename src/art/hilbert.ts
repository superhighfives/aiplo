import type { Polyline, Pt } from '../geom';
import { imageParams, loadDarkness } from '../lib/image';
import { fitToBox } from '../lib/gen-util';
import { defineArtwork } from './types';

interface LSystem {
  axiom: string;
  rules: Record<string, string>;
  angle: number;
  /** Symbols that draw a step forward. */
  draw: string;
}

const CURVES: Record<string, LSystem> = {
  hilbert: { axiom: 'A', rules: { A: '+BF-AFA-FB+', B: '-AF+BFB+FA-' }, angle: 90, draw: 'F' },
  peano: { axiom: 'X', rules: { X: 'XFYFX+F+YFXFY-F-XFYFX', Y: 'YFXFY-F-XFYFX+F+YFXFY' }, angle: 90, draw: 'F' },
  gosper: { axiom: 'A', rules: { A: 'A-B--B+A++AA+B-', B: '+A-BB--B-A++A+B' }, angle: 60, draw: 'AB' },
};

// Segment counts grow fast (Hilbert 4ⁿ, Peano 9ⁿ, Gosper 7ⁿ): cap so the line stays plottable.
const MAX_SEGMENTS = 70000;
const GROWTH: Record<string, number> = { hilbert: 4, peano: 9, gosper: 7 };

/** Expands and walks an L-system with a turtle, returning one polyline of unit steps. */
function turtle(sys: LSystem, order: number): Polyline {
  const pts: Polyline = [[0, 0]];
  let x = 0, y = 0, a = 0;
  const da = (sys.angle * Math.PI) / 180;
  // Depth-first expansion avoids building the (huge) final string.
  const walk = (s: string, depth: number) => {
    for (const c of s) {
      if (depth > 0 && sys.rules[c]) walk(sys.rules[c], depth - 1);
      else if (sys.draw.includes(c)) {
        x += Math.cos(a);
        y += Math.sin(a);
        pts.push([x, y]);
      } else if (c === '+') a += da;
      else if (c === '-') a -= da;
    }
  };
  walk(sys.axiom, order);
  return pts;
}

export default defineArtwork({
  slug: 'space-filling-curve',
  title: 'Space-filling curve',
  description: 'A Hilbert, Peano or Gosper curve as one unbroken line, optionally wiggling with the darkness of a photo.',
  order: 63,
  paper: { paper: 'square', margin: 15 },
  params: [
    { type: 'select', key: 'curve', label: 'Curve', options: [['hilbert', 'Hilbert'], ['peano', 'Peano'], ['gosper', 'Gosper (flowsnake)']], default: 'hilbert' },
    { type: 'number', key: 'order', label: 'Order', min: 1, max: 8, step: 1, default: 6, hint: 'Each step multiplies the length: ×4 Hilbert, ×9 Peano, ×7 Gosper' },
    { type: 'select', key: 'mode', label: 'Image', options: [['none', 'None: plain curve'], ['wiggle', 'Wiggle with darkness']], default: 'wiggle' },
    { type: 'number', key: 'waves', label: 'Waves per step', min: 1, max: 6, step: 1, default: 2, show: (v) => v.mode === 'wiggle', hint: 'Whole waves per segment, so the line passes straight through every corner' },
    { type: 'number', key: 'amount', label: 'Amplitude', min: 0, max: 1, step: 0.05, default: 0.9, show: (v) => v.mode === 'wiggle', hint: 'Of the room available: 1 = nearly touching the neighbouring line' },
    { type: 'number', key: 'gamma', label: 'Tone curve', min: 0.3, max: 3, step: 0.05, default: 1.6, show: (v) => v.mode === 'wiggle', hint: 'Above 1 keeps mid-tones calmer, below 1 makes them busier' },
    ...imageParams().map((p) => ({ ...p, show: (v: Record<string, any>) => v.mode === 'wiggle' })),
  ],
  async generate(v, ctx) {
    const sys = CURVES[v.curve] ?? CURVES.hilbert;
    const g = GROWTH[v.curve] ?? 4;
    let order = Math.max(1, Math.round(v.order));
    while (order > 1 && g ** order > MAX_SEGMENTS) order--;
    if (order !== v.order) ctx.status(`Order capped at ${order} to keep the line plottable`);
    const raw = turtle(sys, order);
    let [line] = fitToBox([raw], ctx.width, ctx.height, 0);
    if (v.mode !== 'wiggle') return [line];
    // Inset by the widest wiggle so the edge runs aren't clipped (which would break the line).
    const pad = 0.5 * Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]);
    [line] = fitToBox([raw], ctx.width, ctx.height, pad);

    const dark = await loadDarkness(v, ctx.width, ctx.height, ctx.status);
    const seg = Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]);
    // Room either side: half the gap to the nearest parallel line (the step length); a bit
    // less for Gosper, whose lines sit closer at 60°.
    const room = (v.curve === 'gosper' ? 0.4 : 0.48) * seg * v.amount;
    const waves = Math.max(1, Math.round(v.waves));
    // ~12 samples per wave keeps the sine smooth.
    const per = waves * 12;
    const out: Polyline = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1], [bx, by] = line[i];
      const dx = (bx - ax) / seg, dy = (by - ay) / seg;
      const nx = -dy, ny = dx;
      for (let k = 1; k <= per; k++) {
        const t = k / per;
        const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        const amp = room * Math.pow(Math.max(0, Math.min(1, dark(px, py))), v.gamma);
        const o = amp * Math.sin(2 * Math.PI * waves * t);
        out.push(k === per ? [bx, by] : ([px + nx * o, py + ny * o] as Pt));
      }
    }
    return [out];
  },
});
