import type { Polyline, Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { fitToBox, gcd } from '../lib/gen-util';
import { FONT_OPTIONS, text } from '../lib/hershey';
import { mulberry32, seedFromText, type Rng } from '../random';
import { defineArtwork } from './types';

/**
 * A name (and a date) as a seed: the text picks one of four classic curve families and every
 * parameter of it, from ranges curated so any choice is pleasing. Each family returns curves in
 * arbitrary units plus a description for the status bar.
 */
type Figure = { curves: Polyline[]; label: string };

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const between = (rng: Rng, a: number, b: number) => a + (b - a) * rng();
const TAU = Math.PI * 2;

/** Damped two-pendulum harmonograph (one line spiralling inwards). */
function harmonograph(rng: Rng): Figure {
  const [rx, ry] = pick(rng, [[1, 1], [2, 1], [3, 2], [3, 1], [4, 3], [1, 2], [2, 3], [3, 4]] as [number, number][]);
  const detune = between(rng, 0.002, 0.008);
  const damp = between(rng, 0.016, 0.026);
  const fmax = Math.max(rx, ry);
  const det = () => 1 + (rng() * 2 - 1) * detune;
  const px = [between(rng, 0, TAU), between(rng, 0, TAU)], py = [between(rng, 0, TAU), between(rng, 0, TAU)];
  const a2 = between(rng, 0.15, 0.5), b2 = between(rng, 0.15, 0.5);
  const fx = [(rx / fmax) * det(), (ry / fmax) * det()], fy = [(ry / fmax) * det(), (rx / fmax) * det()];
  const fade = between(rng, 0.26, 0.36);
  const tEnd = Math.log(1 / fade) / damp;
  const line: Polyline = [];
  const dt = 0.004;
  for (let t = 0; t <= tEnd; t += dt) {
    const e = Math.exp(-damp * t);
    line.push([
      e * (Math.sin(TAU * fx[0] * t + px[0]) + a2 * Math.sin(TAU * fx[1] * t + px[1])),
      e * (Math.sin(TAU * fy[0] * t + py[0]) + b2 * Math.sin(TAU * fy[1] * t + py[1])),
    ]);
  }
  return { curves: [line], label: `harmonograph · ratio ${rx}:${ry} · detune ${detune.toFixed(4)} · damping ${damp.toFixed(3)} · ${Math.round(tEnd)} swings` };
}

/** Hypotrochoid / epitrochoid, one to three nested layers. */
function spirograph(rng: Rng): Figure {
  const inside = rng() < 0.75;
  // Choose ring and wheel teeth so the figure has 5–14 petals and closes in at most 9 turns.
  let R = 96, r = 52;
  for (let tries = 0; tries < 200; tries++) {
    R = 48 + Math.floor(rng() * 72);
    r = 12 + Math.floor(rng() * (R - 20));
    const g = gcd(R, r);
    const petals = R / g, turns = r / g;
    if (petals >= 5 && petals <= 14 && turns >= 2 && turns <= 9 && (!inside || r < R - 6)) break;
  }
  const d0 = between(rng, 0.55, 1.0);
  const layers = 2 + Math.floor(rng() * 2);
  const dStep = -between(rng, 0.12, 0.25);
  const rot = between(rng, 0, 360 / (R / gcd(R, r)) / 2);
  const curves: Polyline[] = [];
  for (let L = 0; L < layers; L++) {
    const d = Math.max(0.15, d0 + L * dStep) * r;
    const g = gcd(R, r);
    const k = inside ? (R - r) / r : (R + r) / r;
    const C = inside ? R - r : R + r;
    const T = (TAU * r) / g;
    const n = Math.ceil((r / g) * (1 + Math.abs(k)) * 240);
    const a = (L * rot * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const line: Polyline = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * T;
      const x = C * Math.cos(t) + (inside ? d : -d) * Math.cos(k * t);
      const y = C * Math.sin(t) - d * Math.sin(k * t);
      line.push([x * ca - y * sa, x * sa + y * ca]);
    }
    curves.push(line);
  }
  return { curves, label: `spirograph · ${inside ? 'inside' : 'outside'} · ring ${R} · wheel ${r} · pen ${d0.toFixed(2)} · ${layers} layer${layers > 1 ? 's' : ''}` };
}

/** Rhodonea (rose) curves r = cos(kθ), k = n/d, a few nested copies, turned a little each time. */
function rose(rng: Rng): Figure {
  let n = 5, d = 4;
  for (let tries = 0; tries < 100; tries++) {
    n = 2 + Math.floor(rng() * 8);
    d = 1 + Math.floor(rng() * 6);
    if (gcd(n, d) === 1 && n !== d && n * d <= 42 && (d > 1 || n >= 4)) break;
  }
  const k = n / d;
  const period = (n * d) % 2 === 1 ? Math.PI * d : TAU * d;
  const copies = 2 + Math.floor(rng() * 4);
  const shrink = between(rng, 0.1, 0.2);
  const twist = between(rng, 0.3, 1) * (Math.PI / n / copies);
  const offset = rng() < 0.4 ? between(rng, 0.15, 0.35) : 0; // a raised rose (r = o + (1-o)·cos kθ) has rounder petals
  const curves: Polyline[] = [];
  for (let c = 0; c < copies; c++) {
    const s = 1 - c * shrink;
    const a0 = c * twist;
    const steps = Math.ceil(period * 260);
    const line: Polyline = [];
    for (let i = 0; i <= steps; i++) {
      const th = (i / steps) * period;
      const rr = s * (offset + (1 - offset) * Math.cos(k * th));
      line.push([rr * Math.cos(th + a0), rr * Math.sin(th + a0)]);
    }
    curves.push(line);
  }
  return { curves, label: `rose curves · k = ${n}/${d}${offset ? ` raised ${offset.toFixed(2)}` : ''} · ${copies} copies · twist ${((twist * 180) / Math.PI).toFixed(1)}°` };
}

/** A ribbon of Lissajous figures, the phase stepping between strands. */
function lissajous(rng: Rng): Figure {
  const [a, b] = pick(rng, [[3, 2], [2, 3], [4, 3], [3, 4], [5, 4], [4, 5], [5, 3], [3, 5], [1, 2], [2, 1], [3, 1], [1, 3]] as [number, number][]);
  const strands = 7 + Math.floor(rng() * 6);
  // Some phases collapse the figure onto itself (a parabola or a line traced twice). Find them
  // numerically, then centre the ribbon in the widest gap between them.
  const bad: number[] = [];
  const STEPS = 240;
  for (let k = 0; k < STEPS; k++) if (openness(a, b, (k / STEPS) * Math.PI) < 0.9) bad.push((k / STEPS) * Math.PI);
  let gapStart = 0, gapLen = Math.PI;
  if (bad.length) {
    gapLen = 0;
    for (let i = 0; i < bad.length; i++) {
      const next = i + 1 < bad.length ? bad[i + 1] : bad[0] + Math.PI;
      if (next - bad[i] > gapLen) { gapLen = next - bad[i]; gapStart = bad[i]; }
    }
  }
  const spread = between(rng, 0.35, 0.7) * gapLen;
  const d0 = gapStart + (gapLen - spread) / 2 + (rng() - 0.5) * (gapLen - spread) * 0.5;
  const shrink = rng() < 0.5 ? between(rng, 0, 0.25) : 0;
  const curves: Polyline[] = [];
  for (let s = 0; s < strands; s++) {
    const f = s / (strands - 1);
    const delta = d0 + f * spread;
    const amp = 1 - f * shrink;
    const steps = Math.ceil((a + b) * 900);
    const line: Polyline = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * TAU;
      line.push([amp * Math.sin(a * t + delta), amp * Math.sin(b * t)]);
    }
    curves.push(line);
  }
  return { curves, label: `Lissajous · ${a}:${b} · ${strands} strands · phase ${((d0 * 180) / Math.PI).toFixed(0)}° + ${((spread * 180) / Math.PI).toFixed(0)}°${shrink ? ` · taper ${shrink.toFixed(2)}` : ''}` };
}

/** Distinct cells visited per unit length: about half for curves that retrace themselves. */
function openness(a: number, b: number, d: number): number {
  const cells = new Set<number>();
  const N = 2400;
  let len = 0, px = 0, py = 0;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * TAU;
    const x = Math.sin(a * t + d), y = Math.sin(b * t);
    if (i) len += Math.hypot(x - px, y - py);
    px = x; py = y;
    cells.add(Math.round(x * 50) * 1000 + Math.round(y * 50));
  }
  return cells.size / (len * 50);
}

const STYLES = { harmonograph, spirograph, rose, lissajous } as const;
type Style = keyof typeof STYLES;
const STYLE_NAMES = Object.keys(STYLES) as Style[];
const INKS = [PALETTE[0], PALETTE[1], PALETTE[2], PALETTE[5], PALETTE[4]];

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
/** Hershey fonts are ASCII only: fold accents (é → e) for the lettering. */
const letterable = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** The figure for a name and date: deterministic, so the same person always gets the same one. */
export function figureFor(name: string, date: string, style: Style | 'auto' = 'auto') {
  const seed = seedFromText(`${normalise(name)}|${normalise(date)}`);
  const rng = mulberry32(seed);
  const chosen = style === 'auto' ? STYLE_NAMES[Math.floor(rng() * STYLE_NAMES.length)] : style;
  const ink = INKS[Math.floor(rng() * INKS.length)];
  const fig = STYLES[chosen](mulberry32(seed ^ 0x5bd1e995));
  return { seed, style: chosen, ink, ...fig };
}

export default defineArtwork({
  slug: 'name-seed',
  title: 'A name as a seed',
  description: 'Type a name and a date: they choose a harmonograph, spirograph, rose or Lissajous figure and all of its settings, so each person gets their own.',
  order: 105,
  series: 'Generative',
  paper: { paper: 'square', margin: 18 },
  params: [
    { type: 'text', key: 'name', label: 'Name', default: 'Nina Simone', placeholder: 'A name' },
    { type: 'text', key: 'date', label: 'Date', default: '21 February 1933', placeholder: 'A birthday, a wedding day…', hint: 'Any text: the same name and date always give the same figure' },
    { type: 'select', key: 'style', label: 'Style', options: [['auto', 'Chosen by the name'], ['harmonograph', 'Harmonograph'], ['spirograph', 'Spirograph'], ['rose', 'Rose curves'], ['lissajous', 'Lissajous']], default: 'auto' },
    { type: 'checkbox', key: 'letterName', label: 'Letter the name beneath', default: true },
    { type: 'checkbox', key: 'letterDate', label: 'Letter the date too', default: true, show: (v) => v.letterName },
    { type: 'number', key: 'size', label: 'Lettering size (mm)', min: 2, max: 12, step: 0.5, default: 5, show: (v) => v.letterName },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural', show: (v) => v.letterName },
    { type: 'checkbox', key: 'colour', label: 'Pen colour from the name', default: true, hint: 'Otherwise the figure is drawn in ink' },
  ],
  caption: (v) => v.name,
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const name = (v.name as string).trim();
    const date = (v.date as string).trim();
    if (!name && !date) throw new Error('Type a name (or a date)');
    const f = figureFor(name, date, v.style);
    const size = v.size as number;
    const letters: Polyline[] = [];
    let textH = 0;
    if (v.letterName && name) {
      const dateSize = size * 0.6;
      const hasDate = v.letterDate && date;
      textH = size + (hasDate ? dateSize * 2.2 : 0) + size * 1.6;
      const y0 = H - (hasDate ? dateSize * 2.2 : 0);
      letters.push(...text(letterable(name), { x: W / 2, y: y0, size, font: v.font, align: 'center', tracking: 0.08 }));
      if (hasDate) letters.push(...text(letterable(date), { x: W / 2, y: H, size: dateSize, font: v.font, align: 'center', tracking: 0.15 }));
    }
    const box = Math.min(W, H - textH);
    const placed = fitToBox(f.curves, box, box, 0).map((c) => c.map(([x, y]) => [x + (W - box) / 2, y + (H - textH - box) / 2] as Pt));
    ctx.status(`${f.label[0].toUpperCase()}${f.label.slice(1)} · seed ${f.seed}`);
    const ink = v.colour ? f.ink : PALETTE[0];
    if (ink === PALETTE[0]) return [{ name: 'Figure', color: ink, paths: [...placed, ...letters] }];
    const layers: Layer[] = [
      { name: 'Figure', color: ink, paths: placed },
      { name: 'Lettering', color: PALETTE[0], paths: letters },
    ];
    return layers.filter((l) => l.paths.length);
  },
});
