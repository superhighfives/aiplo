import type { Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { loadFile } from '../lib/files';
import { mulberry32 } from '../random';
import { defineArtwork } from './types';

type Signal = (t: number) => number;

/**
 * Synthetic ECG: each beat is a sum of Gaussian bumps (P, Q, R, S, T), with RR intervals that
 * drift with breathing (sinus arrhythmia) plus a little randomness. Peak (R) ≈ 1.
 */
function ecg(bpm: number, variability: number, seed: number, duration: number): Signal {
  const rng = mulberry32(seed);
  const beats: { t: number; rr: number; amp: number }[] = [];
  const rr0 = 60 / bpm;
  let t = 0.3;
  while (t < duration + 2) {
    const rr = rr0 * (1 + variability * (0.6 * Math.sin((2 * Math.PI * t) / 4.2) + 0.4 * (rng() * 2 - 1)));
    beats.push({ t, rr, amp: 1 + variability * 0.6 * (rng() * 2 - 1) });
    t += rr;
  }
  // [offset (fraction of a 1 s beat, scaled by sqrt(rr)), amplitude, width (s)]
  const waves: [number, number, number][] = [
    [-0.2, 0.12, 0.025], // P
    [-0.035, -0.12, 0.01], // Q
    [0, 1, 0.011], // R
    [0.04, -0.22, 0.012], // S
    [0.28, 0.28, 0.05], // T
  ];
  return (x) => {
    let s = 0;
    // Binary search for the nearest beat; only neighbours contribute.
    let lo = 0, hi = beats.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (beats[m].t <= x) lo = m;
      else hi = m;
    }
    for (let k = Math.max(0, lo - 1); k <= Math.min(beats.length - 1, lo + 2); k++) {
      const b = beats[k];
      const q = Math.sqrt(b.rr);
      for (const [o, a, w] of waves) {
        const d = x - (b.t + o * q);
        s += a * b.amp * Math.exp(-(d * d) / (2 * w * w));
      }
    }
    return s;
  };
}

/** Breathing: a slow rise, quicker fall and a pause, with gently varying depth. Range ≈ -0.5..0.5. */
function breathing(rate: number, variability: number, seed: number): Signal {
  const rng = mulberry32(seed);
  const ph = Array.from({ length: 6 }, () => rng() * 2 * Math.PI);
  const period = 60 / rate;
  // Smooth wander from a few incommensurate sines.
  const wander = (t: number, o: number) => (Math.sin(t / (period * 3.1) + ph[o]) + Math.sin(t / (period * 7.7) + ph[o + 1]) + Math.sin(t / (period * 1.9) + ph[o + 2])) / 3;
  return (t) => {
    const drift = 1 + variability * 4 * wander(t, 0);
    const u = (((t / period + variability * 3 * wander(t, 3)) % 1) + 1) % 1;
    // Inhale over 40%, exhale over 45%, rest 15%.
    const shape = u < 0.4 ? 0.5 - 0.5 * Math.cos((Math.PI * u) / 0.4) : u < 0.85 ? 0.5 + 0.5 * Math.cos((Math.PI * (u - 0.4)) / 0.45) : 0;
    return (shape - 0.4) * drift;
  };
}

const csvCache = new Map<string, Signal>();
/** Parses "time,value" or single-column "value" text into a signal normalised to peak ≈ 1. */
export function parseTrace(txt: string, rate: number): Signal {
  const rows: number[][] = [];
  for (const line of txt.split(/\r?\n/)) {
    const cells = line.split(/[,;\t ]+/).filter(Boolean).map(Number);
    if (cells.length && cells.every((c) => Number.isFinite(c))) rows.push(cells);
  }
  if (rows.length < 2) throw new Error('No numeric rows found in the file');
  const two = rows[0].length >= 2;
  const ts = rows.map((r, i) => (two ? r[0] : i / rate));
  const vs = rows.map((r) => (two ? r[1] : r[0]));
  const t0 = ts[0];
  for (let i = 0; i < ts.length; i++) ts[i] -= t0;
  const sorted = [...vs].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const peak = Math.max(1e-9, ...[sorted[Math.floor(sorted.length * 0.995)] - mid, mid - sorted[Math.floor(sorted.length * 0.005)]]);
  const norm = vs.map((v) => (v - mid) / peak);
  return (t) => {
    if (t < 0 || t > ts[ts.length - 1]) return NaN;
    let lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (ts[m] <= t) lo = m;
      else hi = m;
    }
    const span = ts[hi] - ts[lo] || 1;
    const f = Math.max(0, Math.min(1, (t - ts[lo]) / span));
    return norm[lo] * (1 - f) + norm[hi] * f;
  };
}

export default defineArtwork({
  slug: 'heartbeat',
  title: 'Heartbeat',
  description: 'A pulse printed like an ECG strip: consecutive seconds stacked in rows, on optional graph paper.',
  order: 43,
  paper: { paper: 'a4', orientation: 'landscape', margin: 15 },
  params: [
    { type: 'file', key: 'file', label: 'Trace (CSV / text)', accept: '.csv,.txt,.tsv,text/*', default: [], hint: 'Two columns (time in s, value) or one column of values. Without one, a synthetic trace is drawn.' },
    { type: 'number', key: 'rate', label: 'Sample rate (Hz)', min: 1, max: 5000, step: 1, default: 250, hint: 'For single-column files' },
    { type: 'select', key: 'style', label: 'Synthetic signal', options: [['ecg', 'ECG (heartbeat)'], ['breath', 'Breathing']], default: 'ecg' },
    { type: 'number', key: 'bpm', label: 'Heart rate (bpm)', min: 30, max: 200, step: 1, default: 68, show: (v) => v.style === 'ecg' },
    { type: 'number', key: 'breaths', label: 'Breaths per minute', min: 4, max: 40, step: 1, default: 14, show: (v) => v.style === 'breath' },
    { type: 'number', key: 'variability', label: 'Variability', min: 0, max: 0.3, step: 0.01, default: 0.06 },
    { type: 'number', key: 'rows', label: 'Rows', min: 1, max: 30, step: 1, default: 6 },
    { type: 'number', key: 'seconds', label: 'Seconds per row', min: 1, max: 120, step: 0.5, default: 10 },
    { type: 'number', key: 'start', label: 'Start (s)', min: 0, max: 3600, step: 0.5, default: 0 },
    { type: 'number', key: 'amplitude', label: 'Amplitude (mm)', min: 1, max: 60, step: 0.5, default: 12, hint: 'Height of the tallest peak' },
    { type: 'select', key: 'grid', label: 'ECG paper', options: [['none', 'None'], ['major', 'Large squares (0.2 s)'], ['fine', 'Large + small squares']], default: 'major', hint: 'On pen 2, light' },
    { type: 'seed', key: 'seed', label: 'Seed', default: 7 },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const total = v.rows * v.seconds;
    let sig: Signal;
    const f = await loadFile(v.file);
    if (f) {
      const key = `${f.id}:${v.rate}`;
      let s = csvCache.get(key);
      if (!s) csvCache.set(key, (s = parseTrace(await f.blob.text(), v.rate)));
      sig = s;
    } else sig = v.style === 'breath' ? breathing(v.breaths, v.variability, ctx.seed) : ecg(v.bpm, v.variability, ctx.seed, v.start + total);

    const rowH = H / v.rows;
    const mmPerS = W / v.seconds;
    const step = Math.min(0.15, mmPerS * 0.004);
    const traces: Polyline[] = [];
    for (let r = 0; r < v.rows; r++) {
      // Baseline a little below centre: ECG peaks point up.
      const base = (r + 0.62) * rowH;
      let cur: Polyline | null = null;
      for (let x = 0; x <= W + 1e-9; x += step) {
        const t = v.start + r * v.seconds + x / mmPerS;
        const s = sig(t);
        if (!Number.isFinite(s)) {
          cur = null;
          continue;
        }
        if (!cur) traces.push((cur = []));
        cur.push([x, base - s * v.amplitude]);
      }
    }
    const layers: Layer[] = [{ name: 'Trace', color: PALETTE[0], paths: traces }];
    if (v.grid !== 'none') {
      // Square grid locked to time: a large square is 0.2 s wide.
      const big = 0.2 * mmPerS;
      const cell = v.grid === 'fine' ? big / 5 : big;
      const grid: Polyline[] = [];
      for (let k = 0, x = 0; x <= W + 1e-6; k++, x = k * cell) grid.push([[x, 0], [x, H]]);
      // Horizontal lines from each row's baseline so the trace sits on a line.
      const ys = new Set<number>();
      for (let r = 0; r < v.rows; r++) {
        const base = (r + 0.62) * rowH;
        for (let y = base; y >= r * rowH - 1e-6; y -= cell) ys.add(+y.toFixed(3));
        for (let y = base + cell; y <= (r + 1) * rowH + 1e-6; y += cell) ys.add(+y.toFixed(3));
      }
      const sorted = [...ys].sort((a, b) => a - b).filter((y, i, a) => i === 0 || y - a[i - 1] > cell * 0.3);
      sorted.forEach((y, i) => grid.push(i % 2 ? [[W, y], [0, y]] : [[0, y], [W, y]]));
      layers.push({ name: 'Grid', color: PALETTE[1], paths: grid });
    }
    return layers;
  },
});
