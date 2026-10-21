/**
 * Shared helpers for the lyric pieces: which audio to use (the public-domain demo song when
 * nothing is uploaded), word timing within lyric lines, loudness, and a shaped spectrogram.
 * All pure maths apart from `loadSong`, so it runs in Node for testing.
 */
import { envelope, loadAudio, spectrogram, type Audio } from './audio';
import { measureText } from './hershey';
import type { LyricLine } from './lyrics';
import { demoSong } from './song';
import type { Values } from '../params';

/** The uploaded audio, or the demo song (never touches AudioContext without a file). */
export async function loadSong(v: Values, status?: (m: string) => void): Promise<Audio> {
  if (Array.isArray(v.audio) && v.audio.length) return loadAudio(v.audio, status);
  return demoSong();
}

/** A display name for the song: the file name without extension, or the demo's title. */
export function songName(v: Values): string {
  const f = Array.isArray(v.audio) ? v.audio[0] : undefined;
  if (f?.name) return String(f.name).replace(/\.[^.]+$/, '');
  if (v.lyricsSource === 'lrclib' && v.track) return String(v.track);
  return 'Twinkle, Twinkle, Little Star';
}

/** Rough English syllable count (vowel groups, silent final e), at least 1. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

export interface LyricWord {
  text: string;
  /** Index of the lyric line it belongs to. */
  line: number;
  start: number;
  end: number;
}

/**
 * Splits lyric lines into words and spreads each line's time span over its words by syllable
 * count (the line's final syllable counted twice, as it's usually held). A line's span runs to the next line, capped at `maxPerSyllable` seconds per syllable
 * so instrumental gaps don't stretch the last words. `activeEnd(t0, t1)` can trim trailing
 * silence (see `loudnessCurve().activeEnd`).
 */
export function wordTimes(lines: LyricLine[], duration: number, maxPerSyllable = 1, activeEnd?: (t0: number, t1: number) => number): LyricWord[][] {
  return lines.map((l, li) => {
    const words = l.text.split(/\s+/).filter(Boolean);
    // The last syllable of a line is usually held: give it double time.
    const syl = words.map((w, k) => syllables(w) + (k === words.length - 1 ? 1 : 0));
    const total = syl.reduce((a, b) => a + b, 0) || 1;
    let end = Math.min(l.end ?? lines[li + 1]?.time ?? duration, duration);
    if (activeEnd) end = Math.max(l.time + 0.05, activeEnd(l.time, end));
    const span = Math.max(0.05, Math.min(end - l.time, total * maxPerSyllable));
    let t = l.time;
    return words.map((text, k) => {
      const d = (span * syl[k]) / total;
      const w = { text, line: li, start: t, end: t + d };
      t += d;
      return w;
    });
  });
}

/** RMS loudness envelope sampled every `dt` seconds, normalised so the loudest window is 1. */
export function loudnessCurve(audio: Audio, dt = 0.02) {
  const count = Math.max(2, Math.ceil(audio.duration / dt));
  const env = envelope(audio.samples, audio.sampleRate, count, 0, audio.duration);
  const step = audio.duration / count;
  /** Mean (power) loudness over [t0, t1]. */
  const over = (t0: number, t1: number) => {
    const a = Math.max(0, Math.floor(t0 / step));
    const b = Math.min(count, Math.max(a + 1, Math.ceil(t1 / step)));
    let s = 0;
    for (let i = a; i < b; i++) s += env[i] * env[i];
    return Math.sqrt(s / (b - a));
  };
  /** The end of [t0, t1] with trailing quiet (under `frac` of the span's peak) trimmed off. */
  const activeEnd = (t0: number, t1: number, frac = 0.3) => {
    const a = Math.max(0, Math.floor(t0 / step));
    let b = Math.min(count, Math.ceil(t1 / step));
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, env[i]);
    while (b > a + 1 && env[b - 1] < frac * peak) b--;
    return Math.min(t1, b * step);
  };
  return { env, step, over, activeEnd };
}

export interface SpectrumShape {
  bands: number;
  fmin: number;
  fmax: number;
  range: number;
  tilt: number;
  /** 0–1: subtract this fraction of the mean spectrum. */
  flatten: number;
  /** Gaussian blur across bands (in bands). */
  smooth: number;
  /** Power applied before normalising. */
  contrast: number;
}

/**
 * A spectrogram averaged over arbitrary time spans (one row per span), then flattened,
 * smoothed across bands and normalised like song-ridgelines (soft ceiling ~1.3).
 */
export function shapedSpectrum(audio: Audio, spans: [number, number][], o: SpectrumShape): Float32Array[] {
  const bands = o.bands;
  const t0 = Math.max(0, Math.min(...spans.map((s) => s[0])));
  const t1 = Math.min(audio.duration, Math.max(...spans.map((s) => s[1])));
  // Fine grid (~12 rows a second), averaged into the requested spans.
  const fineN = Math.max(8, Math.ceil((t1 - t0) * 12));
  const fine = spectrogram(audio.samples, audio.sampleRate, {
    rows: fineN, bands, fmin: Math.min(o.fmin, o.fmax - 10), fmax: o.fmax, start: t0, end: Math.max(t0 + 0.1, t1), window: 2048, range: o.range, tilt: o.tilt,
  });
  const fdt = (t1 - t0) / fineN;
  const spec = spans.map(([a, b]) => {
    const out = new Float32Array(bands);
    let i0 = Math.floor((a - t0) / fdt), i1 = Math.ceil((b - t0) / fdt);
    i0 = Math.max(0, Math.min(fineN - 1, i0));
    i1 = Math.max(i0 + 1, Math.min(fineN, i1));
    for (let i = i0; i < i1; i++) for (let k = 0; k < bands; k++) out[k] += fine[i][k] / (i1 - i0);
    return out;
  });
  const mean = new Float32Array(bands);
  for (const r of spec) for (let k = 0; k < bands; k++) mean[k] += r[k] / spec.length;
  const sigma = o.smooth;
  const taps = Math.ceil(sigma * 2.5);
  const kern = Array.from({ length: taps + 1 }, (_, k) => (sigma > 0 ? Math.exp(-(k * k) / (2 * sigma * sigma)) : k === 0 ? 1 : 0));
  const rows = spec.map((r) => {
    const flat = r.map((x, k) => Math.max(0, x - o.flatten * mean[k]));
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
  const all: number[] = [];
  for (const r of rows) for (let k = 0; k < bands; k++) all.push((r[k] = Math.pow(r[k], o.contrast)));
  all.sort((a, b) => a - b);
  const ref = Math.max(1e-9, all[Math.floor(all.length * 0.995)]);
  for (const r of rows) for (let k = 0; k < bands; k++) r[k] = 1.3 * Math.tanh(r[k] / ref / 1.3);
  return rows;
}

/** Evenly spaced spans covering [start, end]. */
export const evenSpans = (start: number, end: number, n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [start + ((end - start) * i) / n, start + ((end - start) * (i + 1)) / n]);

/** The largest size ≤ `size` at which `str` fits in `width` mm. */
export function fitSize(str: string, width: number, size: number, font: string, tracking = 0): number {
  const w = measureText(str, { size, font, tracking });
  return w > width ? (size * width) / w : size;
}

/** The song's start/end window from `start`/`end` knobs (0 = end of track). */
export function songWindow(v: Values, duration: number): [number, number] {
  const start = Math.max(0, Math.min(v.start ?? 0, duration - 0.1));
  const end = v.end > 0 ? Math.max(start + 0.1, Math.min(duration, v.end)) : duration;
  return [start, end];
}
