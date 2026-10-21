import { simplify, smooth, polylineLength, type Polyline, type Pt } from '../geom';
import { text } from '../lib/hershey';
import { loadGray, type Gray } from '../lib/image';
import { bounds } from '../lib/gen-util';
import { mulberry32 } from '../random';
import { photographPage, recoverStrokes } from '../lib/words-strokes';
import { defineArtwork } from './types';

const DEMO = "Lemon cake, from Nan\n2 cups flour, 1 cup sugar\n3 eggs and a pinch of salt\nzest and juice of 2 lemons\nbake at 180° for 40 min\nwith love, June x";

/** The demo "photo": a recipe card in Hershey script, inked thick onto grainy paper. */
export function demoPage(message = DEMO): { gray: Gray; source: Polyline[] } {
  const w = 1500, h = 1000;
  const cap = 62, lead = 2.25;
  const lines = message.split('\n');
  const source = text(lines.join('\n'), { font: 'scripts', size: cap, leading: lead, x: 90, y: 150 });
  // A little hand-written irregularity: each line drifts and tilts.
  const rng = mulberry32(7);
  const tilts = lines.map(() => [(rng() - 0.5) * 0.03, (rng() - 0.5) * 18]);
  const warped = source.map((p) =>
    p.map(([x, y]): Pt => {
      const li = Math.max(0, Math.min(lines.length - 1, Math.round((y - 150) / (cap * lead))));
      const [t, dx] = tilts[li];
      return [x + dx, y + (x - 90) * t];
    }),
  );
  const b = bounds(warped);
  const k = Math.min(1, (w - 120) / (b.x1 - b.x0), (h - 120) / (b.y1 - b.y0));
  const placed = warped.map((p) => p.map(([x, y]): Pt => [60 + (x - b.x0) * k, 60 + (y - b.y0) * k]));
  const gray = photographPage(placed, w, h, { pen: 7, ruled: cap * lead * k, rng: mulberry32(11) });
  return { gray, source: placed };
}

/** A filled-looking dot: two turns spiralling in to the centre. */
function dotSpiral(cx: number, cy: number, r: number): Polyline {
  const n = 24;
  return Array.from({ length: n + 1 }, (_, i): Pt => {
    const t = i / n, a = t * 4 * Math.PI, rr = r * (1 - t * 0.85);
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  });
}

export default defineArtwork({
  slug: 'handwriting',
  title: 'Handwriting restored',
  description: 'Recovers the pen strokes from a photographed letter or recipe (threshold, thinning, tracing) and plots them as single lines.',
  order: 110,
  series: 'Words and hands',
  paper: { paper: 'a4', orientation: 'landscape', margin: 15 },
  params: [
    { type: 'file', key: 'photo', label: 'Photo of handwriting', accept: 'image/*', default: [], hint: 'Without a photo, a demo recipe card is used' },
    { type: 'number', key: 'res', label: 'Analysis size (px)', min: 400, max: 3000, step: 100, default: 1500, hint: 'Longest side the photo is scaled to before tracing' },
    { type: 'checkbox', key: 'invert', label: 'Light ink on dark (chalkboard)', default: false },
    { type: 'number', key: 'contrast', label: 'Sensitivity', min: 0.01, max: 0.4, step: 0.01, default: 0.1, hint: 'How much darker than its surroundings ink must be. Lower picks up fainter writing (and more noise)' },
    { type: 'number', key: 'window', label: 'Local window (px)', min: 0, max: 200, step: 1, default: 0, hint: 'Neighbourhood for the adaptive threshold; 0 = automatic' },
    { type: 'number', key: 'join', label: 'Join gaps (pen widths)', min: 0, max: 4, step: 0.1, default: 1, hint: 'Bridge breaks in a stroke up to this size when the ends line up' },
    { type: 'number', key: 'minLen', label: 'Minimum stroke (mm)', min: 0, max: 20, step: 0.25, default: 1.5 },
    { type: 'checkbox', key: 'dots', label: 'Keep dots', default: true, hint: 'Tittles and full stops: blobs too small to trace' },
    { type: 'number', key: 'smooth', label: 'Smoothing (mm)', min: 0, max: 5, step: 0.05, default: 0.8 },
    { type: 'select', key: 'scale', label: 'Scale', options: [['fit', 'Fit the page'], ['mmpx', 'mm per pixel']], default: 'fit' },
    { type: 'number', key: 'mmpx', label: 'mm per pixel', min: 0.02, max: 1, step: 0.01, default: 0.15, show: (v) => v.scale === 'mmpx' },
    { type: 'number', key: 'passes', label: 'Nib passes', min: 1, max: 6, step: 1, default: 1, hint: 'Repeat each stroke offset across a broad nib' },
    { type: 'number', key: 'nib', label: 'Nib width (mm)', min: 0.1, max: 3, step: 0.05, default: 0.6, show: (v) => v.passes > 1 },
    { type: 'number', key: 'nibAngle', label: 'Nib angle (°)', min: -90, max: 90, step: 1, default: 40, show: (v) => v.passes > 1 },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    let gray = await loadGray(v.photo, v.res);
    if (!gray) {
      ctx.status('No photo loaded: using the demo recipe card');
      gray = demoPage().gray;
    }
    const rec = recoverStrokes(gray, { contrast: v.contrast, window: v.window, invert: v.invert, join: v.join });
    if (!rec.strokes.length) throw new Error('No writing found: try a lower sensitivity');

    // Pixels → mm.
    const b = bounds(rec.strokes);
    const k = v.scale === 'mmpx' ? v.mmpx : Math.min(W / Math.max(1, b.x1 - b.x0), H / Math.max(1, b.y1 - b.y0));
    const bw = (b.x1 - b.x0) * k, bh = (b.y1 - b.y0) * k;
    const ox = (W - bw) / 2 - b.x0 * k, oy = (H - bh) / 2 - b.y0 * k;
    let strokes = rec.strokes
      .map((p) => p.map(([x, y]): Pt => [ox + x * k, oy + y * k]))
      .filter((p) => polylineLength(p) >= v.minLen)
      .map((p) => simplify(smooth(p, v.smooth), 0.02));
    // Dots (tittles, full stops) as tiny spirals, if they sit near some writing (not dirt in the margin).
    if (v.dots) {
      const near = new Set<string>();
      const c = rec.pen * 10;
      for (const p of rec.strokes) for (const [x, y] of p) near.add(`${Math.floor(x / c)},${Math.floor(y / c)}`);
      const r = Math.max(0.2, rec.pen * k * 0.3);
      for (const [x, y] of rec.dots) {
        const i = Math.floor(x / c), j = Math.floor(y / c);
        let ok = false;
        for (let a = -1; a <= 1 && !ok; a++) for (let bb = -1; bb <= 1 && !ok; bb++) ok = near.has(`${i + a},${j + bb}`);
        if (ok) strokes.push(dotSpiral(ox + x * k, oy + y * k, r));
      }
    }
    ctx.status(`${strokes.length} strokes · pen ≈ ${(rec.pen * k).toFixed(2)} mm wide at this scale`);

    // A broad nib: the stroke repeated across the nib's width at a fixed angle.
    if (v.passes > 1) {
      const a = (v.nibAngle * Math.PI) / 180;
      const dx = Math.cos(a), dy = -Math.sin(a);
      const out: Polyline[] = [];
      for (const p of strokes)
        for (let i = 0; i < v.passes; i++) {
          const t = (i / (v.passes - 1) - 0.5) * v.nib;
          const q = p.map(([x, y]): Pt => [x + dx * t, y + dy * t]);
          out.push(i % 2 ? q.reverse() : q);
        }
      strokes = out;
    }
    return strokes;
  },
});
