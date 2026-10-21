/**
 * Audio analysis for plotter pieces. `decodeAudio` / `loadAudio` need `AudioContext`, so they
 * only work on the main thread (pieces using them set `mainThread: true`). Everything else is
 * pure maths and runs anywhere, including Node: FFT, short-time spectra, RMS envelopes and a
 * deterministic demo signal for when no file is uploaded.
 */
import { loadFile, type FileRef } from './files';

export interface Audio {
  /** Mono samples in [-1, 1]. */
  samples: Float32Array;
  sampleRate: number;
  /** Seconds. */
  duration: number;
  name: string;
}

/** Decodes an audio file to mono samples. Main thread only (uses AudioContext). */
export async function decodeAudio(blob: Blob): Promise<Omit<Audio, 'name'>> {
  const AC: typeof AudioContext | undefined = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  if (!AC) throw new Error('Audio decoding needs a browser (AudioContext unavailable)');
  const ac = new AC();
  try {
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    const n = buf.length;
    const samples = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) samples[i] += ch[i] / buf.numberOfChannels;
    }
    return { samples, sampleRate: buf.sampleRate, duration: n / buf.sampleRate };
  } catch (e) {
    throw new Error(`Couldn't decode audio: ${(e as Error).message || e}`);
  } finally {
    ac.close?.();
  }
}

const decoded = new Map<string, Promise<Audio>>();

/**
 * The uploaded audio for a `file` knob, decoded and cached; the demo signal when no file is set
 * (without touching AudioContext, so it works headlessly and for gallery thumbnails).
 */
export async function loadAudio(refs: FileRef[] | undefined, status?: (m: string) => void): Promise<Audio> {
  const ref = Array.isArray(refs) ? refs[0] : undefined;
  if (!ref) return demoAudio();
  let p = decoded.get(ref.id);
  if (!p) {
    status?.(`Decoding ${ref.name}…`);
    p = (async () => {
      const f = await loadFile([ref]);
      if (!f) throw new Error(`Audio file ${ref.name} is missing; upload it again`);
      return { ...(await decodeAudio(f.blob)), name: ref.name };
    })();
    p.catch(() => decoded.delete(ref.id));
    decoded.set(ref.id, p);
  }
  const a = await p;
  status?.(`${a.name} · ${a.duration.toFixed(1)} s`);
  return a;
}

// ---------------------------------------------------------------------------------------------
// FFT and spectra

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n & (n - 1)) throw new Error('fft size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();
export function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/** Power spectrum (|X|², bins 0..n/2) of a Hann-windowed frame starting at `start`. */
export function powerSpectrum(samples: Float32Array, start: number, size: number): Float64Array {
  const w = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const k = start + i;
    re[i] = k >= 0 && k < samples.length ? samples[k] * w[i] : 0;
  }
  fft(re, im);
  const out = new Float64Array(size / 2 + 1);
  for (let i = 0; i <= size / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
  return out;
}

export interface SpectrumOptions {
  /** Number of output rows (time slices), evenly spaced between start and end. */
  rows: number;
  /** Number of log-spaced frequency bands per row. */
  bands: number;
  fmin?: number;
  fmax?: number;
  /** Seconds. */
  start?: number;
  end?: number;
  /** FFT window size (power of two). Default 2048. */
  window?: number;
  /** Hop between FFT frames in samples; frames inside a row's time slice are averaged. Default window/2. */
  hop?: number;
  /** dB range below the loudest band that maps to 0. Default 60. */
  range?: number;
  /** Boost in dB per octave above fmin, to counter music's natural high-frequency roll-off. Default 0. */
  tilt?: number;
}

/**
 * Short-time spectrum: `rows` time slices × `bands` log-frequency bands, each value in [0, 1]
 * (dB, normalised so the loudest band of the whole selection is 1 and `range` dB below is 0).
 */
export function spectrogram(samples: Float32Array, sampleRate: number, o: SpectrumOptions): Float32Array[] {
  const size = o.window ?? 2048;
  const hop = Math.max(1, Math.round(o.hop ?? size / 2));
  const nyq = sampleRate / 2;
  const fmin = Math.max(1, o.fmin ?? 40);
  const fmax = Math.min(nyq, o.fmax ?? 8000);
  const dur = samples.length / sampleRate;
  const t0 = Math.max(0, Math.min(dur, o.start ?? 0));
  const t1 = Math.max(t0 + 1e-3, Math.min(dur, o.end ?? dur));
  const range = o.range ?? 60;
  const binHz = sampleRate / size;
  // Band edges in bins.
  const edges = Array.from({ length: o.bands + 1 }, (_, k) => fmin * Math.pow(fmax / fmin, k / o.bands) / binHz);
  const rows: Float32Array[] = [];
  let peak = -Infinity;
  for (let r = 0; r < o.rows; r++) {
    const a = t0 + ((t1 - t0) * r) / o.rows;
    const b = t0 + ((t1 - t0) * (r + 1)) / o.rows;
    // Frames centred inside [a, b); at least one.
    const s0 = Math.round(a * sampleRate) - size / 2;
    const s1 = Math.round(b * sampleRate) - size / 2;
    const acc = new Float64Array(size / 2 + 1);
    let frames = 0;
    for (let s = s0; frames === 0 || s < s1; s += hop) {
      const p = powerSpectrum(samples, s, size);
      for (let i = 0; i < acc.length; i++) acc[i] += p[i];
      frames++;
    }
    const row = new Float32Array(o.bands);
    for (let k = 0; k < o.bands; k++) {
      const lo = edges[k], hi = edges[k + 1];
      let pw: number;
      if (hi - lo < 1) {
        // Narrower than a bin: interpolate at the band centre.
        const c = (lo + hi) / 2;
        const i = Math.floor(c), f = c - i;
        pw = acc[i] * (1 - f) + acc[Math.min(acc.length - 1, i + 1)] * f;
      } else {
        let sum = 0, n = 0;
        for (let i = Math.ceil(lo); i < hi && i < acc.length; i++) (sum += acc[i]), n++;
        pw = n ? sum / n : 0;
      }
      const db = 10 * Math.log10(pw / frames + 1e-12) + (o.tilt ?? 0) * (k / o.bands) * Math.log2(fmax / fmin);
      row[k] = db;
      if (db > peak) peak = db;
    }
    rows.push(row);
  }
  for (const row of rows) for (let k = 0; k < row.length; k++) row[k] = Math.max(0, Math.min(1, 1 + (row[k] - peak) / range));
  return rows;
}

/** RMS per window: `count` values evenly covering [start, end] seconds, normalised so the max is 1. */
export function envelope(samples: Float32Array, sampleRate: number, count: number, start = 0, end?: number): Float32Array {
  const dur = samples.length / sampleRate;
  const t0 = Math.max(0, Math.min(dur, start));
  const t1 = Math.max(t0 + 1e-3, Math.min(dur, end ?? dur));
  const out = new Float32Array(count);
  let mx = 0;
  for (let i = 0; i < count; i++) {
    const a = Math.floor((t0 + ((t1 - t0) * i) / count) * sampleRate);
    const b = Math.max(a + 1, Math.floor((t0 + ((t1 - t0) * (i + 1)) / count) * sampleRate));
    let s = 0;
    for (let k = a; k < b; k++) s += (samples[k] ?? 0) ** 2;
    out[i] = Math.sqrt(s / (b - a));
    mx = Math.max(mx, out[i]);
  }
  if (mx > 0) for (let i = 0; i < count; i++) out[i] /= mx;
  return out;
}

/** Peak-preserving downsample of the raw waveform: `count` signed values in [-1, 1], normalised. */
export function waveform(samples: Float32Array, sampleRate: number, count: number, start = 0, end?: number): Float32Array {
  const dur = samples.length / sampleRate;
  const t0 = Math.max(0, Math.min(dur, start));
  const t1 = Math.max(t0 + 1e-3, Math.min(dur, end ?? dur));
  const out = new Float32Array(count);
  let mx = 0;
  for (let i = 0; i < count; i++) {
    const a = Math.floor((t0 + ((t1 - t0) * i) / count) * sampleRate);
    const b = Math.max(a + 1, Math.floor((t0 + ((t1 - t0) * (i + 1)) / count) * sampleRate));
    // Alternate max / min so the downsampled line still oscillates.
    let best = 0;
    for (let k = a; k < b; k++) {
      const s = samples[k] ?? 0;
      if (i % 2 ? s < best : s > best) best = s;
    }
    out[i] = best;
    mx = Math.max(mx, Math.abs(best));
  }
  if (mx > 0) for (let i = 0; i < count; i++) out[i] /= mx;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Demo signal

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/**
 * A deterministic little tune: 8 bars at 112 bpm of Am–F–C–G pads, a bass line, an arpeggio,
 * kick on every beat and off-beat hats. Mono, 16 kHz by default.
 */
export function demoSignal(sampleRate = 16000): Float32Array {
  const bpm = 112;
  const beat = 60 / bpm;
  const bars = 8;
  const dur = bars * 4 * beat;
  const n = Math.ceil(dur * sampleRate);
  const out = new Float32Array(n);
  const chords = [
    [57, 60, 64], // Am
    [53, 57, 60], // F
    [55, 60, 64], // C
    [55, 59, 62], // G
  ];
  const roots = [45, 41, 48, 43];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;

  const add = (t0: number, len: number, fn: (t: number) => number) => {
    const a = Math.max(0, Math.floor(t0 * sampleRate));
    const b = Math.min(n, Math.ceil((t0 + len) * sampleRate));
    for (let i = a; i < b; i++) out[i] += fn(i / sampleRate - t0);
  };
  const tone = (f: number, harmonics: number, bright: number) => (t: number) => {
    let s = 0;
    for (let h = 1; h <= harmonics; h++) s += Math.sin(2 * Math.PI * f * h * t) * Math.pow(bright, h - 1) / h;
    return s;
  };

  for (let bar = 0; bar < bars; bar++) {
    const c = bar % 4;
    const tb = bar * 4 * beat;
    // Pad: whole bar, slow attack/release.
    for (const m of chords[c]) {
      const osc = tone(midi(m), 10, 0.75);
      add(tb, 4 * beat, (t) => osc(t) * 0.12 * Math.min(1, t / 0.3) * Math.min(1, (4 * beat - t) / 0.4));
    }
    // Bass: root on beats 1 and 3, fifth on the "and" of 4.
    const bass = [[0, roots[c]], [2, roots[c]], [3.5, roots[c] + 7]] as const;
    for (const [b, m] of bass) {
      const osc = tone(midi(m), 4, 0.5);
      add(tb + b * beat, beat * 0.9, (t) => osc(t) * 0.35 * Math.exp(-t * 3));
    }
    // Arpeggio in 8ths, an octave up, rising through the chord. Thins out in bars 0–1, fills in later.
    if (bar >= 2) {
      for (let k = 0; k < 8; k++) {
        const notes = chords[c];
        const m = notes[k % 3] + 12 + (k >= 6 ? 12 : 0);
        const osc = tone(midi(m), 6, 0.6);
        add(tb + (k * beat) / 2, beat / 2, (t) => osc(t) * 0.12 * Math.exp(-t * 8));
      }
    }
    // Lead melody (bars 4–7): a quarter-note line two octaves up, with a little vibrato.
    if (bar >= 4) {
      const line = [
        [76, 74, 72, 74],
        [72, 69, 72, 77],
        [79, 76, 72, 76],
        [74, 79, 83, 86],
      ][c];
      line.forEach((m, k) => {
        const f = midi(m);
        add(tb + k * beat, beat, (t) => {
          let s = 0;
          const ph = 2 * Math.PI * f * t + 0.3 * Math.sin(2 * Math.PI * 5.5 * t);
          for (let h = 1; h <= 5; h++) s += Math.sin(ph * h) / (h * h);
          return s * 0.2 * Math.min(1, t / 0.02) * Math.exp(-t * 2.5);
        });
      });
    }
    // Kick: pitch-swept sine on every beat.
    for (let b = 0; b < 4; b++) {
      add(tb + b * beat, 0.25, (t) => Math.sin(2 * Math.PI * (50 * t + 60 * (1 - Math.exp(-t * 30)) / 30)) * 0.8 * Math.exp(-t * 14));
    }
    // Hats on the off-beats from bar 4: differenced noise (crude high-pass).
    if (bar >= 4) {
      for (let b = 0; b < 4; b++) {
        let prev = 0;
        add(tb + (b + 0.5) * beat, 0.06, (t) => {
          const x = rnd();
          const y = x - prev;
          prev = x;
          return y * 0.08 * Math.exp(-t * 60);
        });
      }
    }
  }
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] /= mx;
  return out;
}

let demo: Audio | null = null;
/** The demo signal as an `Audio`, cached. */
export function demoAudio(): Audio {
  if (!demo) {
    const sampleRate = 16000;
    const samples = demoSignal(sampleRate);
    demo = { samples, sampleRate, duration: samples.length / sampleRate, name: 'Demo tune' };
  }
  return demo;
}
