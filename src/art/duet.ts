import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { demoAudio, envelope, loadAudio, spectrogram, type Audio } from '../lib/audio';
import { demoSong } from '../lib/song';
import type { Values } from '../params';
import { defineArtwork } from './types';

/** Spectral rows for ridgelines: flattened, smoothed, contrast-shaped, roughly 0..1.3. */
function ridgeRows(a: Audio, rows: number, v: Values): Float32Array[] {
  const bands = 140;
  const spec = spectrogram(a.samples, a.sampleRate, { rows, bands, fmin: 60, fmax: v.fmax, window: 2048, range: 50, tilt: 4 });
  const mean = new Float32Array(bands);
  for (const r of spec) for (let k = 0; k < bands; k++) mean[k] += r[k] / spec.length;
  const sig = v.smooth, taps = Math.ceil(sig * 2.5);
  const out = spec.map((r) => {
    const flat = r.map((x, k) => Math.max(0, x - 0.7 * mean[k]));
    const o = new Float32Array(bands);
    for (let k = 0; k < bands; k++) {
      let s = 0, w = 0;
      for (let d = -taps; d <= taps; d++) {
        const j = k + d;
        if (j < 0 || j >= bands) continue;
        const g = sig > 0 ? Math.exp(-(d * d) / (2 * sig * sig)) : d === 0 ? 1 : 0;
        s += flat[j] * g;
        w += g;
      }
      o[k] = Math.pow(s / w, 2.2);
    }
    return o;
  });
  const all = out.flatMap((r) => Array.from(r)).sort((x, y) => x - y);
  const ref = Math.max(1e-9, all[Math.floor(all.length * 0.995)]);
  for (const r of out) for (let k = 0; k < bands; k++) r[k] = 1.3 * Math.tanh(r[k] / ref / 1.3);
  return out;
}

/** Interleaved ridgelines: A's and B's rows alternate front to back, hiding each other. */
function interleaved(a: Audio, b: Audio, v: Values, W: number, H: number): Layer[] {
  const N = Math.max(2, Math.round(v.rows));
  const ra = ridgeRows(a, N, v), rb = ridgeRows(b, N, v);
  const M = 2 * N;
  const E = v.height;
  const pw = W * v.width, x0 = (W - pw) / 2;
  const BIN = 0.25;
  const nb = Math.floor(pw / BIN) + 1;
  const horizon = new Float64Array(nb).fill(Infinity);
  const out: Polyline[][] = [[], []];
  const taper = (u: number) => Math.pow(Math.sin(Math.PI * u), 1.2);
  for (let j = M - 1; j >= 0; j--) {
    const who = j % 2;
    const row = (who ? rb : ra)[Math.floor(j / 2)];
    const base = E + (j / (M - 1)) * (H - E);
    const ys = new Float64Array(nb);
    for (let i = 0; i < nb; i++) {
      const u = i / (nb - 1);
      const x = u * (row.length - 1);
      const k = Math.floor(x), f = x - k;
      const val = row[k] * (1 - f) + (row[Math.min(row.length - 1, k + 1)] ?? 0) * f;
      ys[i] = base - val * taper(u) * E;
    }
    let cur: Polyline | null = null;
    for (let i = 0; i < nb; i++) {
      const X = x0 + i * BIN;
      const d1 = ys[i] - horizon[i];
      const vis = d1 < 0;
      if (i > 0) {
        const d0 = ys[i - 1] - horizon[i - 1];
        if (d0 < 0 !== vis && isFinite(d0) && isFinite(d1)) {
          const t = d0 / (d0 - d1);
          const q: Pt = [X - BIN + BIN * t, ys[i - 1] + (ys[i] - ys[i - 1]) * t];
          if (cur) (cur.push(q), (cur = null));
          else out[who].push((cur = [q]));
        }
      }
      if (vis) {
        if (!cur) out[who].push((cur = []));
        cur.push([X, ys[i]]);
      } else cur = null;
    }
    for (let i = 0; i < nb; i++) horizon[i] = Math.min(horizon[i], ys[i]);
  }
  return [
    { name: v.nameA || 'A', color: PALETTE[0], paths: out[0].filter((p) => p.length > 1) },
    { name: v.nameB || 'B', color: PALETTE[1], paths: out[1].filter((p) => p.length > 1) },
  ];
}

/** Spectral centroid in Hz over the whole track (a rough "brightness"). */
function centroid(a: Audio): number {
  const spec = spectrogram(a.samples, a.sampleRate, { rows: 16, bands: 64, fmin: 50, fmax: 6000, window: 2048, range: 60 });
  let s = 0, w = 0;
  for (const r of spec)
    for (let k = 0; k < r.length; k++) {
      const f = 50 * Math.pow(6000 / 50, (k + 0.5) / r.length);
      s += f * r[k] ** 4;
      w += r[k] ** 4;
    }
  return w > 0 ? s / w : 500;
}

/**
 * Two wave sources, one per song. Each song's rings spread from its own centre (radius = time),
 * and are pushed in and out by the other song's wave where they cross: interference.
 */
function rings(a: Audio, b: Audio, v: Values, W: number, H: number): Layer[] {
  const n = Math.max(4, Math.round(v.rings));
  const land = W >= H;
  const sep = v.separation * Math.max(W, H);
  const c: Pt[] = land
    ? [[W / 2 - sep / 2, H / 2], [W / 2 + sep / 2, H / 2]]
    : [[W / 2, H / 2 - sep / 2], [W / 2, H / 2 + sep / 2]];
  // Reach: far enough for every ring source to cover the page.
  const reach = Math.max(...c.map(([x, y]) => Math.max(Math.hypot(x, y), Math.hypot(W - x, y), Math.hypot(x, H - y), Math.hypot(W - x, H - y)))) * v.reach;
  const envs = [a, b].map((s) => envelope(s.samples, s.sampleRate, 400));
  const cents = [a, b].map(centroid);
  const lam0 = reach / n;
  // Brighter song → slightly shorter waves.
  const lam = cents.map((f) => lam0 * v.wavelength * Math.max(0.6, Math.min(1.6, Math.sqrt(Math.sqrt(cents[0] * cents[1]) / f))));
  const envAt = (s: number, r: number) => {
    const e = envs[s];
    const x = Math.max(0, Math.min(1, r / reach)) * (e.length - 1);
    const i = Math.floor(x), f = x - i;
    return e[i] * (1 - f) + (e[Math.min(e.length - 1, i + 1)] ?? 0) * f;
  };
  const wave = (s: number, p: Pt) => {
    const r = Math.hypot(p[0] - c[s][0], p[1] - c[s][1]);
    return envAt(s, r) * Math.sin((2 * Math.PI * r) / lam[s]);
  };
  const out: Polyline[][] = [[], []];
  for (let s = 0; s < 2; s++) {
    const o = 1 - s;
    for (let i = 1; i <= n; i++) {
      const r = (i / n) * reach;
      const amp = v.amplitude * (0.25 + 0.75 * envAt(s, r)) * lam0;
      const steps = Math.max(48, Math.ceil((2 * Math.PI * r) / 0.4));
      const line: Polyline = [];
      for (let k = 0; k <= steps; k++) {
        const ang = (k / steps) * 2 * Math.PI;
        const p: Pt = [c[s][0] + r * Math.cos(ang), c[s][1] + r * Math.sin(ang)];
        const d = amp * wave(o, p);
        line.push([c[s][0] + (r + d) * Math.cos(ang), c[s][1] + (r + d) * Math.sin(ang)]);
      }
      out[s].push(line);
    }
    if (v.centres) out[s].push(circle(c[s][0], c[s][1], 1.2, 16));
  }
  return [
    { name: v.nameA || 'A', color: PALETTE[0], paths: out[0] },
    { name: v.nameB || 'B', color: PALETTE[1], paths: out[1] },
  ];
}

/** The drawing, from two decoded songs. Pure, so it can be tested without AudioContext. */
export function duet(a: Audio, b: Audio, v: Values, W: number, H: number): Layer[] {
  return v.mode === 'rings' ? rings(a, b, v, W, H) : interleaved(a, b, v, W, H);
}

export default defineArtwork({
  slug: 'duet',
  title: 'Duet',
  description: 'Two songs on one page: their spectra interleaved as ridgelines that hide each other, or as interfering ripples from two centres.',
  order: 84,
  series: 'Music',
  paper: { paper: 'square', margin: 20 },
  mainThread: true,
  params: [
    { type: 'file', key: 'audioA', label: 'Song A', accept: 'audio/*', default: [], hint: 'Without one, the public-domain demo song' },
    { type: 'file', key: 'audioB', label: 'Song B', accept: 'audio/*', default: [], hint: 'Without one, a synthesized demo tune' },
    { type: 'text', key: 'nameA', label: 'Pen 1 name', default: '' },
    { type: 'text', key: 'nameB', label: 'Pen 2 name', default: '' },
    { type: 'select', key: 'mode', label: 'Mode', options: [['ridges', 'Interleaved ridgelines'], ['rings', 'Interfering ripples']], default: 'ridges' },
    { type: 'number', key: 'rows', label: 'Rows per song', min: 5, max: 100, step: 1, default: 34, show: (v) => v.mode === 'ridges' },
    { type: 'number', key: 'height', label: 'Peak height (mm)', min: 2, max: 60, step: 0.5, default: 18, show: (v) => v.mode === 'ridges' },
    { type: 'number', key: 'width', label: 'Width', min: 0.3, max: 1, step: 0.01, default: 0.78, show: (v) => v.mode === 'ridges' },
    { type: 'number', key: 'fmax', label: 'High frequency (Hz)', min: 500, max: 8000, step: 50, default: 3000, show: (v) => v.mode === 'ridges' },
    { type: 'number', key: 'smooth', label: 'Smoothing', min: 0, max: 8, step: 0.1, default: 2.5, show: (v) => v.mode === 'ridges' },
    { type: 'number', key: 'rings', label: 'Rings per song', min: 5, max: 120, step: 1, default: 30, show: (v) => v.mode === 'rings' },
    { type: 'number', key: 'separation', label: 'Distance between centres', min: 0, max: 1, step: 0.01, default: 0.42, show: (v) => v.mode === 'rings' },
    { type: 'number', key: 'amplitude', label: 'Ripple depth', min: 0, max: 2, step: 0.02, default: 0.45, show: (v) => v.mode === 'rings', hint: 'In ring spacings' },
    { type: 'number', key: 'wavelength', label: 'Wavelength', min: 0.5, max: 8, step: 0.1, default: 2.6, show: (v) => v.mode === 'rings', hint: 'In ring spacings; each song’s brightness stretches or shortens it' },
    { type: 'number', key: 'reach', label: 'Reach', min: 0.3, max: 1.2, step: 0.01, default: 0.62, show: (v) => v.mode === 'rings', hint: 'How far the rings spread (1 = every corner)' },
    { type: 'checkbox', key: 'centres', label: 'Mark the centres', default: true, show: (v) => v.mode === 'rings' },
  ],
  caption: (v) => [v.audioA?.[0]?.name ?? 'Twinkle, Twinkle, Little Star', v.audioB?.[0]?.name ?? 'Demo tune'].map((s: string) => s.replace(/\.[^.]+$/, '')).join(' × '),
  async generate(v, ctx) {
    const a = v.audioA?.length ? await loadAudio(v.audioA, ctx.status) : demoSong();
    const b = v.audioB?.length ? await loadAudio(v.audioB, ctx.status) : demoAudio();
    return duet(a, b, v, ctx.width, ctx.height);
  },
});
