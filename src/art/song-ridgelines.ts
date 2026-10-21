import type { Polyline } from '../geom';
import { loadAudio, spectrogram, type Audio } from '../lib/audio';
import { ridges } from '../lib/elevation';
import type { Values } from '../params';
import { defineArtwork } from './types';

/** The drawing, from decoded audio. Pure, so it can be tested without AudioContext. */
export function songRidgelines(audio: Audio, v: Values, W: number, H: number): Polyline[] {
  const bands = 160;
  const start = Math.min(v.start, audio.duration - 0.1);
  const end = v.end > 0 ? Math.min(audio.duration, v.end) : audio.duration;
  const spec = spectrogram(audio.samples, audio.sampleRate, {
    rows: v.rows,
    bands,
    fmin: Math.min(v.fmin, v.fmax - 10),
    fmax: v.fmax,
    start,
    end: Math.max(start + 0.1, end),
    window: 2048,
    range: v.range,
    tilt: v.tilt,
  });
  // Flatten the spectral tilt: subtract part of the average spectrum so every row shows what's
  // different about that moment, not just "bass is loud".
  const mean = new Float32Array(bands);
  for (const r of spec) for (let k = 0; k < bands; k++) mean[k] += r[k] / spec.length;
  // Gaussian smoothing across bands.
  const sigma = v.smooth;
  const taps = Math.ceil(sigma * 2.5);
  const kern = Array.from({ length: taps + 1 }, (_, k) => (sigma > 0 ? Math.exp(-(k * k) / (2 * sigma * sigma)) : k === 0 ? 1 : 0));
  const rows = spec.map((r) => {
    const flat = r.map((x, k) => Math.max(0, x - v.flatten * mean[k]));
    const out = new Float32Array(bands);
    for (let k = 0; k < bands; k++) {
      let s = 0, sw = 0;
      for (let d = -taps; d <= taps; d++) {
        const j = k + d;
        if (j < 0 || j >= bands) continue;
        s += flat[j] * kern[Math.abs(d)];
        sw += kern[Math.abs(d)];
      }
      out[k] = s / sw;
    }
    return out;
  });
  // Contrast, then normalise to a high percentile (not the single loudest spike, which would
  // flatten everything else) with a soft ceiling so outliers don't run off the page.
  const all: number[] = [];
  for (const r of rows) for (let k = 0; k < bands; k++) all.push((r[k] = Math.pow(r[k], v.contrast)));
  all.sort((a, b) => a - b);
  const ref = Math.max(1e-9, all[Math.floor(all.length * 0.995)]);
  for (const r of rows) for (let k = 0; k < bands; k++) r[k] = 1.3 * Math.tanh(r[k] / ref / 1.3);

  // Plot narrower than the area, centred, like the album cover.
  const pw = W * v.width;
  const x0 = (W - pw) / 2;
  const N = rows.length;
  const taper = (u: number) => (v.taper > 0 ? Math.pow(Math.sin(Math.PI * u), v.taper) : 1);
  const h = (u: number, t: number) => {
    const r = rows[Math.max(0, Math.min(N - 1, Math.round(t * (N - 1))))];
    const x = u * (bands - 1);
    const i = Math.floor(x), f = x - i;
    const val = r[i] * (1 - f) + (r[Math.min(bands - 1, i + 1)] ?? 0) * f;
    return val * taper(u);
  };
  const lines = ridges(h, pw, H, { rows: v.rows, height: v.height, perspective: v.perspective });
  return lines.map((l) => l.map(([x, y]) => [x + x0, y]));
}

export default defineArtwork({
  slug: 'song-ridgelines',
  title: 'Unknown Pleasures from your song',
  description: 'A song as stacked spectra: each line a moment, peaks where it’s loud, front lines hiding the ones behind.',
  order: 40,
  paper: { paper: 'square', margin: 35 },
  mainThread: true,
  params: [
    { type: 'file', key: 'audio', label: 'Audio', accept: 'audio/*', default: [], hint: 'Any audio the browser can decode. Without one, a demo tune is used.' },
    { type: 'number', key: 'rows', label: 'Rows', min: 10, max: 200, step: 1, default: 80 },
    { type: 'number', key: 'height', label: 'Peak height (mm)', min: 2, max: 60, step: 0.5, default: 22 },
    { type: 'number', key: 'width', label: 'Width', min: 0.3, max: 1, step: 0.01, default: 0.62, hint: 'Fraction of the drawing area, centred' },
    { type: 'number', key: 'start', label: 'Start (s)', min: 0, max: 600, step: 0.5, default: 0 },
    { type: 'number', key: 'end', label: 'End (s)', min: 0, max: 600, step: 0.5, default: 0, hint: '0 = end of the track' },
    { type: 'number', key: 'fmin', label: 'Low frequency (Hz)', min: 20, max: 1000, step: 1, default: 50 },
    { type: 'number', key: 'fmax', label: 'High frequency (Hz)', min: 500, max: 20000, step: 50, default: 2500 },
    { type: 'number', key: 'smooth', label: 'Smoothing', min: 0, max: 10, step: 0.1, default: 3, hint: 'Blur across frequency bands' },
    { type: 'number', key: 'range', label: 'Dynamic range (dB)', min: 20, max: 100, step: 1, default: 50 },
    { type: 'number', key: 'tilt', label: 'Treble boost (dB/oct)', min: 0, max: 12, step: 0.5, default: 4, hint: 'Music gets quieter with pitch; this lifts the high end' },
    { type: 'number', key: 'flatten', label: 'Flatten tilt', min: 0, max: 1, step: 0.05, default: 0.7, hint: 'Subtract the average spectrum so each row shows what changed' },
    { type: 'number', key: 'contrast', label: 'Contrast', min: 0.5, max: 4, step: 0.05, default: 2.5, hint: 'Higher = flatter valleys, spikier peaks' },
    { type: 'number', key: 'taper', label: 'Taper edges', min: 0, max: 4, step: 0.1, default: 1.2, hint: 'Flattens both ends of each line, like the pulsar plot' },
    { type: 'number', key: 'perspective', label: 'Perspective', min: 0, max: 1, step: 0.01, default: 0 },
  ],
  caption: (v) => (v.audio?.[0]?.name ?? 'Demo tune').replace(/\.[^.]+$/, ''),
  async generate(v, ctx) {
    const audio = await loadAudio(v.audio, ctx.status);
    return songRidgelines(audio, v, ctx.width, ctx.height);
  },
});
