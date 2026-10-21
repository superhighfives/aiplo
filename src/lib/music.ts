/**
 * Music analysis for plotter pieces. Everything here is pure maths and runs anywhere
 * (worker, main thread, Node):
 *
 * - Pitch tracking (YIN, FFT-accelerated) → f0 per frame, confidence, voiced flag, median smoothing.
 * - Onsets (spectral flux + adaptive peak picking), tempo (autocorrelation of the onset envelope
 *   with a perceptual prior) and a beat grid (dynamic-programming beat tracker).
 * - Chord symbols and chord charts (`[Verse]`, `| Am F | C G |`), circle-of-fifths positions.
 * - A small Standard MIDI File reader (and writer, for tests and demos).
 */
import { fft, loadAudio, powerSpectrum, type Audio } from './audio';
import type { FileRef } from './files';
import { demoSong, type DemoSong } from './song';

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const hzToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const noteName = (m: number) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

/** Resamples to a lower rate (box-filtered linear interpolation). Returns the input if not lower. */
export function downsample(samples: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return samples;
  const ratio = from / to;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  const half = ratio / 2;
  for (let i = 0; i < n; i++) {
    const c = i * ratio;
    const a = Math.max(0, Math.floor(c - half)), b = Math.min(samples.length, Math.ceil(c + half));
    let s = 0;
    for (let k = a; k < b; k++) s += samples[k];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

// ---------------------------------------------------------------------------------------------
// Pitch (YIN)

export interface PitchFrame {
  /** Centre of the frame, seconds. */
  time: number;
  /** Fundamental in Hz (best guess even when unvoiced; 0 when silent). */
  f0: number;
  /** 0–1: 1 − the YIN aperiodicity at the chosen lag. */
  confidence: number;
  /** Frame RMS (of the analysed, possibly downsampled signal). */
  rms: number;
  voiced: boolean;
}

export interface PitchOptions {
  /** Hop in seconds. Default 0.01. */
  hop?: number;
  /** Integration window in seconds. Default 0.032. */
  window?: number;
  fmin?: number;
  fmax?: number;
  /** YIN absolute threshold on the normalised difference. Default 0.15. */
  threshold?: number;
  /** Minimum confidence for a frame to count as voiced. Default 0.75. */
  minConfidence?: number;
  /** Frames quieter than this fraction of the loudest frame's RMS are unvoiced. Default 0.04. */
  silence?: number;
  /** Median filter length in frames over voiced runs (odd; 1 = none). Default 5. */
  median?: number;
  /** Analysis rate: input is downsampled to this first. Default 16000. */
  rate?: number;
  /** High-pass cutoff in Hz applied first, to keep bass lines from pulling the lead's pitch down. Default 120; 0 = off. */
  highpass?: number;
  /** Half-lag dips below this are taken as the true period (fewer sub-octave errors). Default 0.2. */
  octaveBias?: number;
}

/** Second-order Butterworth high-pass (RBJ biquad), applied forwards. */
export function highpass(x: Float32Array, sr: number, fc: number): Float32Array {
  if (fc <= 0) return x;
  const w = (2 * Math.PI * fc) / sr, q = Math.SQRT1_2;
  const al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + al;
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = (1 + c) / 2 / a0, a1 = (-2 * c) / a0, a2 = (1 - al) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    (x2 = x1), (x1 = x[i]), (y2 = y1), (y1 = v);
    y[i] = v;
  }
  return y;
}

/**
 * YIN pitch tracker (de Cheveigné & Kawahara 2002) with the difference function computed via
 * FFT cross-correlation, so long recordings stay quick. Voicing combines aperiodicity, loudness
 * and run length; f0 is median-smoothed (in semitones) inside voiced runs.
 */
export function trackPitch(samplesIn: Float32Array, sampleRateIn: number, o: PitchOptions = {}): PitchFrame[] {
  const rate = Math.min(sampleRateIn, o.rate ?? 16000);
  const sr = rate;
  const x = highpass(downsample(samplesIn, sampleRateIn, rate), sr, o.highpass ?? 120);
  const hop = Math.max(1, Math.round((o.hop ?? 0.01) * sr));
  const W = Math.max(32, Math.round((o.window ?? 0.032) * sr));
  const fmin = o.fmin ?? 90, fmax = Math.min(o.fmax ?? 1000, sr / 4);
  const tmin = Math.max(2, Math.floor(sr / fmax));
  const tmax = Math.min(Math.ceil(sr / fmin), W);
  const thr = o.threshold ?? 0.15;
  const N = nextPow2(W + tmax + 1);
  // Prefix sums of x² for the energy terms.
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  const d = new Float64Array(tmax + 2);
  const frames: PitchFrame[] = [];
  let maxRms = 0;
  for (let s = 0; s + W + tmax < x.length; s += hop) {
    ar.fill(0), ai.fill(0), br.fill(0), bi.fill(0);
    for (let i = 0; i < W; i++) ar[i] = x[s + i];
    for (let i = 0; i < W + tmax; i++) br[i] = x[s + i];
    fft(ar, ai);
    fft(br, bi);
    // conj(A)·B, then inverse FFT via conj-FFT-conj → r(τ) = Σ a_j b_{j+τ}.
    for (let k = 0; k < N; k++) {
      const re = ar[k] * br[k] + ai[k] * bi[k];
      const im = ar[k] * bi[k] - ai[k] * br[k];
      ar[k] = re;
      ai[k] = -im;
    }
    fft(ar, ai);
    const e0 = sq[s + W] - sq[s];
    const rms = Math.sqrt(e0 / W);
    maxRms = Math.max(maxRms, rms);
    // Difference function and cumulative-mean normalisation.
    let run = 0;
    d[0] = 1;
    for (let t = 1; t <= tmax; t++) {
      const et = sq[s + t + W] - sq[s + t];
      const r = ar[t] / N;
      const diff = Math.max(0, e0 + et - 2 * r);
      run += diff;
      d[t] = run > 0 ? (diff * t) / run : 1;
    }
    let best = -1;
    for (let t = tmin; t <= tmax; t++) {
      if (d[t] < thr) {
        while (t + 1 <= tmax && d[t + 1] < d[t]) t++;
        best = t;
        break;
      }
    }
    if (best < 0) {
      // No dip under the threshold (noisy or polyphonic frame): take the global minimum, but
      // prefer the shortest-lag local minimum nearly as deep, which avoids sub-octave errors.
      let g = tmin;
      for (let t = tmin; t <= tmax; t++) if (d[t] < d[g]) g = t;
      best = g;
      for (let t = tmin + 1; t < g; t++) {
        if (d[t] <= d[t - 1] && d[t] <= d[t + 1] && d[t] < d[g] + 0.1) {
          best = t;
          break;
        }
      }
    }
    // Octave check: a mixture (a chord tone an octave below the lead) can put the deepest dip at
    // twice the true period. If half the lag is also a clear dip, the higher pitch is the lead.
    const half = Math.round(best / 2);
    if (half >= tmin) {
      let h = half;
      for (let t = Math.max(tmin, half - 2); t <= half + 2; t++) if (d[t] < d[h]) h = t;
      if (d[h] < (o.octaveBias ?? 0.2)) best = h;
    }
    // Parabolic interpolation around the minimum.
    let tau = best;
    if (best > tmin && best < tmax) {
      const a = d[best - 1], b = d[best], c = d[best + 1];
      const den = a - 2 * b + c;
      if (den > 0) tau = best + (0.5 * (a - c)) / den;
    }
    const conf = Math.max(0, Math.min(1, 1 - d[best]));
    frames.push({ time: (s + W / 2) / sr, f0: e0 > 0 ? sr / tau : 0, confidence: conf, rms, voiced: false });
  }
  const minConf = o.minConfidence ?? 0.75;
  const gate = (o.silence ?? 0.04) * maxRms;
  for (const f of frames) f.voiced = f.f0 > 0 && f.confidence >= minConf && f.rms >= gate && f.f0 >= fmin * 0.97 && f.f0 <= fmax * 1.03;
  // Drop voiced runs shorter than 3 frames (clicks), fill unvoiced holes of 1–2 frames.
  setRuns(frames, 3);
  fixOctaves(frames, Math.round(0.3 / (hop / sr)));
  medianPitch(frames, o.median ?? 5);
  return frames;
}

function setRuns(frames: PitchFrame[], minRun: number) {
  const n = frames.length;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && frames[j].voiced === frames[i].voiced) j++;
    const len = j - i;
    if (!frames[i].voiced && len <= 2 && i > 0 && j < n) {
      const a = hzToMidi(frames[i - 1].f0), b = hzToMidi(frames[j].f0);
      if (Math.abs(a - b) < 1.5) for (let k = i; k < j; k++) frames[k].voiced = true;
    } else if (frames[i].voiced && len < minRun) for (let k = i; k < j; k++) frames[k].voiced = false;
    i = j;
  }
}

/** Moves frames that sit about an octave away from the local (±reach frames) median back by an octave. */
function fixOctaves(frames: PitchFrame[], reach: number) {
  const m = frames.map((f) => (f.f0 > 0 ? hzToMidi(f.f0) : 0));
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i].voiced) continue;
    const win: number[] = [];
    for (let k = Math.max(0, i - reach); k <= Math.min(frames.length - 1, i + reach); k++) if (frames[k].voiced) win.push(m[k]);
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1];
    const dlt = m[i] - med;
    if (Math.abs(dlt) > 8) frames[i].f0 = midiToHz(m[i] - 12 * Math.round(dlt / 12));
  }
}

/** Median filter of f0 (in semitones) within each voiced run. */
export function medianPitch(frames: PitchFrame[], len: number) {
  const h = Math.floor(Math.max(1, len) / 2);
  if (h < 1) return;
  const m = frames.map((f) => (f.f0 > 0 ? hzToMidi(f.f0) : 0));
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i].voiced) continue;
    const win: number[] = [];
    for (let k = i - h; k <= i + h; k++) if (k >= 0 && k < frames.length && frames[k].voiced) win.push(m[k]);
    win.sort((a, b) => a - b);
    frames[i].f0 = midiToHz(win[win.length >> 1]);
  }
}

// ---------------------------------------------------------------------------------------------
// Onsets, tempo, beats

export interface OnsetAnalysis {
  /** Onset strength envelope (spectral flux), normalised to max 1, one value per hop. */
  envelope: Float32Array;
  /** Seconds per envelope sample. */
  hop: number;
  /** Picked onsets: time in seconds, strength 0–1. */
  onsets: { time: number; strength: number }[];
}

export interface OnsetOptions {
  /** Hop in seconds. Default 0.01. */
  hop?: number;
  /** FFT window in samples (power of two). Default 1024 at 16 kHz, scaled with rate. */
  window?: number;
  /** Peak threshold above the local mean, as a fraction of the max envelope. Default 0.05. Lower = more onsets. */
  delta?: number;
  /** Minimum gap between onsets in seconds. Default 0.05. */
  minGap?: number;
  rate?: number;
}

/** Spectral-flux onset detection with log compression, adaptive threshold and peak picking. */
export function detectOnsets(samplesIn: Float32Array, sampleRateIn: number, o: OnsetOptions = {}): OnsetAnalysis {
  const sr = Math.min(sampleRateIn, o.rate ?? 16000);
  const x = downsample(samplesIn, sampleRateIn, sr);
  const hopS = Math.max(1, Math.round((o.hop ?? 0.01) * sr));
  const size = o.window ?? nextPow2(Math.round(0.064 * sr));
  const frames = Math.max(1, Math.floor(x.length / hopS));
  const bins = size / 2 + 1;
  let prev = new Float64Array(bins);
  const env = new Float32Array(frames);
  // The flux peaks as an attack enters the window, about a quarter-window before it reaches the
  // centre; shift the window earlier so envelope times line up with the attacks.
  const lag = Math.round(size / 3);
  for (let f = 0; f < frames; f++) {
    const p = powerSpectrum(x, f * hopS - size / 2 - lag, size);
    const cur = new Float64Array(bins);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(1000 * Math.sqrt(p[k]));
      const dd = cur[k] - prev[k];
      if (dd > 0) flux += dd;
    }
    env[f] = f === 0 ? 0 : flux;
    prev = cur;
  }
  let mx = 0;
  for (const e of env) mx = Math.max(mx, e);
  if (mx > 0) for (let i = 0; i < frames; i++) env[i] /= mx;
  const hop = hopS / sr;
  // Adaptive threshold: local mean over ±0.1 s, plus delta; local max over ±0.03 s.
  const delta = o.delta ?? 0.05;
  const wMean = Math.max(1, Math.round(0.1 / hop)), wMax = Math.max(1, Math.round(0.03 / hop));
  const minGap = o.minGap ?? 0.05;
  const onsets: OnsetAnalysis['onsets'] = [];
  for (let i = 1; i < frames - 1; i++) {
    const e = env[i];
    let isMax = true;
    for (let k = Math.max(0, i - wMax); k <= Math.min(frames - 1, i + wMax) && isMax; k++) if (env[k] > e) isMax = false;
    if (!isMax) continue;
    let s = 0, n = 0;
    for (let k = Math.max(0, i - wMean); k <= Math.min(frames - 1, i + wMean); k++) (s += env[k]), n++;
    if (e < s / n + delta) continue;
    const t = i * hop;
    const last = onsets[onsets.length - 1];
    if (last && t - last.time < minGap) {
      if (e > last.strength) (last.time = t), (last.strength = e);
      continue;
    }
    onsets.push({ time: t, strength: e });
  }
  return { envelope: env, hop, onsets };
}

export interface TempoOptions {
  minBpm?: number;
  maxBpm?: number;
  /** Centre of the log-Gaussian tempo prior. Default 120. */
  preferredBpm?: number;
}

/** Tempo from the autocorrelation of the (mean-removed) onset envelope, weighted by a perceptual prior. */
export function estimateTempo(a: OnsetAnalysis, o: TempoOptions = {}): { bpm: number; period: number; confidence: number } {
  const env = a.envelope;
  const n = env.length;
  let mean = 0;
  for (const e of env) mean += e / n;
  const z = Float64Array.from(env, (e) => e - mean);
  const minBpm = o.minBpm ?? 50, maxBpm = o.maxBpm ?? 220;
  const lo = Math.max(1, Math.floor(60 / maxBpm / a.hop)), hi = Math.min(n - 1, Math.ceil(60 / minBpm / a.hop));
  const ac = new Float64Array(hi + 2);
  for (let L = 0; L <= hi + 1 && L < n; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += z[i] * z[i + L];
    ac[L] = s / (n - L);
  }
  const pref = o.preferredBpm ?? 120;
  let best = lo, bestScore = -Infinity;
  for (let L = lo; L <= hi; L++) {
    const bpm = 60 / (L * a.hop);
    const w = Math.exp(-0.5 * (Math.log2(bpm / pref) / 1.0) ** 2);
    // Reward lags whose double also correlates (metrical consistency).
    const s = w * (ac[L] + 0.5 * (2 * L < ac.length ? ac[2 * L] : 0));
    if (s > bestScore) (bestScore = s), (best = L);
  }
  let lag = best;
  if (best > lo && best < hi) {
    const p = ac[best - 1], q = ac[best], r = ac[best + 1];
    const den = p - 2 * q + r;
    if (den < 0) lag = best + (0.5 * (p - r)) / den;
  }
  const period = lag * a.hop;
  return { bpm: 60 / period, period, confidence: ac[0] > 0 ? Math.max(0, ac[best] / ac[0]) : 0 };
}

/**
 * Beat grid by dynamic programming (Ellis 2007): beats sit on strong onsets while keeping
 * close to the tempo period. Returns beat times in seconds.
 */
export function trackBeats(a: OnsetAnalysis, period: number, tightness = 100): number[] {
  const env = a.envelope;
  const n = env.length;
  if (!n) return [];
  const P = period / a.hop;
  // Smooth the envelope a little with a Gaussian of ~P/32.
  const sig = Math.max(1, P / 32);
  const taps = Math.ceil(sig * 3);
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -taps; k <= taps; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += env[j] * Math.exp(-(k * k) / (2 * sig * sig));
    }
    local[i] = s;
  }
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let bestV = 0, bestJ = -1;
    const a0 = Math.round(i - 2 * P), a1 = Math.round(i - P / 2);
    for (let j = Math.max(0, a0); j <= a1; j++) {
      const v = score[j] - tightness * Math.log((i - j) / P) ** 2;
      if (bestJ < 0 || v > bestV) (bestV = v), (bestJ = j);
    }
    score[i] = local[i] + (bestJ >= 0 ? Math.max(0, bestV) : 0);
    back[i] = bestJ >= 0 && bestV > 0 ? bestJ : -1;
  }
  // Best end point in the last period.
  let end = n - 1;
  for (let i = Math.max(0, Math.floor(n - P)); i < n; i++) if (score[i] > score[end]) end = i;
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) {
    beats.push(i * a.hop);
    if (back[i] < 0) break;
  }
  beats.reverse();
  // Extend the grid back towards the start if the chain stopped early.
  while (beats.length && beats[0] - period >= -0.05 * period) beats.unshift(Math.max(0, beats[0] - period));
  return beats;
}

/** Everything rhythmic in one call. */
export function analyseRhythm(samples: Float32Array, sampleRate: number, o: OnsetOptions & TempoOptions = {}) {
  const onsets = detectOnsets(samples, sampleRate, o);
  const tempo = estimateTempo(onsets, o);
  const beats = trackBeats(onsets, tempo.period);
  return { ...onsets, ...tempo, beats };
}

// ---------------------------------------------------------------------------------------------
// Chords and charts

export type ChordQuality = 'maj' | 'min' | 'dim' | 'aug' | 'sus2' | 'sus4' | '5';

export interface Chord {
  symbol: string;
  /** Pitch class of the root, 0 = C. */
  root: number;
  quality: ChordQuality;
  /** Anything after the triad quality: '7', 'maj7', 'add9'… */
  extension: string;
  /** Pitch class of a slash-chord bass, if any. */
  bass?: number;
  /** Minor-type chords (min, dim) sit on the circle's inner ring at their relative major. */
  minor: boolean;
  /** 0–11 around the circle of fifths, 0 = C (major) / Am (minor), clockwise G, D, A… */
  fifths: number;
}

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pcOf = (letter: string, acc: string) => (LETTER[letter.toUpperCase()] + (acc === '#' || acc === '♯' ? 1 : acc === 'b' || acc === '♭' ? -1 : 0) + 12) % 12;
export const fifthsOf = (pc: number) => (pc * 7) % 12;

/** Labels for the 12 circle positions: majors outside, relative minors inside. */
export const CIRCLE_MAJOR = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'];
export const CIRCLE_MINOR = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm'];

/** Parses a chord symbol: Am, F#m7, Bb, Gsus4, C/E, Ebmaj7, Bdim, C+, D5, A7(b9)… Null if not a chord. */
export function parseChord(sym: string): Chord | null {
  const m = sym.trim().match(/^([A-Ga-g])([#b♯♭]?)([^/]*)(?:\/([A-Ga-g])([#b♯♭]?))?$/);
  if (!m) return null;
  if (m[1] !== m[1].toUpperCase()) return null; // 'a', 'b' are words, not chords
  const root = pcOf(m[1], m[2]);
  let rest = m[3];
  let quality = 'maj' as ChordQuality;
  const take = (re: RegExp, q: ChordQuality) => {
    const mm = rest.match(re);
    if (!mm) return false;
    quality = q;
    rest = rest.slice(mm[0].length);
    return true;
  };
  if (/^(maj|M|Δ)/.test(rest)) quality = 'maj';
  else take(/^(dim|°|o(?![a-z]))/, 'dim') || take(/^(aug|\+)/, 'aug') || take(/^(min|mi|m|-)/, 'min');
  if (/^(sus4|sus)/.test(rest) && quality === 'maj') take(/^(sus4|sus)/, 'sus4');
  else if (/^sus2/.test(rest) && quality === 'maj') take(/^sus2/, 'sus2');
  else if (/^5$/.test(rest) && quality === 'maj') take(/^5/, '5');
  // Whatever is left must look like an extension.
  if (rest && !/^(maj|M|Δ|add|sus|[0-9]|[#b♯♭(),°ø+]|alt)[a-zA-Z0-9#b♯♭(),°ø+]*$/.test(rest)) return null;
  const minor = quality === 'min' || quality === 'dim';
  const bass = m[4] ? pcOf(m[4], m[5]) : undefined;
  return { symbol: sym.trim(), root, quality, extension: rest, bass, minor, fifths: fifthsOf(minor ? (root + 3) % 12 : root) };
}

/** MIDI notes for a chord voiced in the octave starting at `base` (default C3 = 48), bass note first if slash. */
export function chordTones(c: Chord, base = 48): number[] {
  const iv: Record<ChordQuality, number[]> = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], '5': [0, 7] };
  const tones = iv[c.quality].map((i) => base + c.root + i);
  if (/7/.test(c.extension)) tones.push(base + c.root + (/maj7|M7|Δ/.test(c.extension) ? 11 : c.quality === 'dim' && /°7|dim7/.test(c.symbol) ? 9 : 10));
  if (c.bass !== undefined) tones.unshift(base - 12 + c.bass);
  return tones;
}

export interface ChartChord {
  chord: Chord;
  section: string;
  /** Which occurrence of this section name (0 = first time it appears). */
  occurrence: number;
  /** Bar index across the whole chart. */
  bar: number;
  /** Position within the bar, 0 ≤ beat < 1 (fraction of the bar). */
  pos: number;
  /** Fraction of the bar this chord lasts. */
  len: number;
}

export interface Chart {
  /** Chords in order of play. */
  chords: ChartChord[];
  /** Section names in order of first appearance. */
  sections: string[];
  /** Tokens that weren't recognised (lyrics, typos), for a status message. */
  unknown: string[];
  bars: number;
}

/**
 * Parses a chord chart. `[Verse]` / `Chorus:` lines start sections; `|` separates bars (a line
 * without bars is one bar per chord); `%` repeats the previous bar; `xN` at the end of a line
 * repeats the line; `N.C.` is no chord. Lines that are mostly not chords (lyrics) are skipped.
 */
export function parseChart(text: string): Chart {
  const chords: ChartChord[] = [];
  const sections: string[] = [];
  const unknown: string[] = [];
  const seen = new Map<string, number>();
  let section = '';
  let occurrence = 0;
  let bar = 0;
  const startSection = (name: string) => {
    section = name;
    if (!sections.includes(name)) sections.push(name);
    occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
  };
  for (const raw0 of text.split(/\r?\n/)) {
    let raw = raw0.replace(/\s\/\/.*$/, '').trim();
    if (!raw || raw.startsWith('//') || /^#\s/.test(raw)) continue;
    const head = raw.match(/^\[([^\]]+)\]\s*/) ?? raw.match(/^([A-Za-z][A-Za-z ]*\d*):\s*/);
    if (head && !(raw.match(/^([A-Za-z][A-Za-z ]*\d*):/) && parseChord(head[1]))) {
      startSection(head[1].trim());
      raw = raw.slice(head[0].length).trim();
      if (!raw) continue;
    }
    if (!section) startSection('Song');
    let repeat = 1;
    const rep = raw.match(/\s*[x×](\d+)\s*$/i);
    if (rep) {
      repeat = Number(rep[1]);
      raw = raw.slice(0, rep.index).trim();
    }
    const hasBars = raw.includes('|');
    const barTexts = hasBars ? raw.split('|').map((s) => s.trim()).filter(Boolean) : raw.split(/\s+/);
    // Skip lyric lines: fewer than half the tokens are chords.
    const toks = raw.split(/[\s|]+/).filter(Boolean);
    const good = toks.filter((t) => parseChord(t) || t === '%' || /^n\.?c\.?$/i.test(t) || t === '-' || t === '/').length;
    if (good < toks.length / 2) {
      unknown.push(...toks.slice(0, 3));
      continue;
    }
    const lineBars: Chord[][] = [];
    for (const bt of barTexts) {
      if (bt === '%') {
        lineBars.push(lineBars[lineBars.length - 1] ?? []);
        continue;
      }
      const cs: Chord[] = [];
      for (const t of bt.split(/\s+/).filter(Boolean)) {
        const c = parseChord(t);
        if (c) cs.push(c);
        else if ((t === '/' || t === '-') && cs.length) cs.push(cs[cs.length - 1]); // slash = repeat chord for a beat
        else if (!/^n\.?c\.?$/i.test(t)) unknown.push(t);
      }
      lineBars.push(cs);
    }
    for (let r = 0; r < repeat; r++) {
      for (const cs of lineBars) {
        // Merge consecutive identical chords within a bar into longer ones.
        const merged: { c: Chord; n: number }[] = [];
        for (const c of cs) {
          const last = merged[merged.length - 1];
          if (last && last.c.symbol === c.symbol) last.n++;
          else merged.push({ c, n: 1 });
        }
        let k = 0;
        for (const { c, n } of merged) {
          chords.push({ chord: c, section, occurrence, bar, pos: k / cs.length, len: n / cs.length });
          k += n;
        }
        bar++;
      }
    }
  }
  return { chords, sections, unknown, bars: bar };
}

/** A chord chart in text form from timed chords (e.g. `demoSong().chords`), `perBar` chords per bar. */
export function chartFromTimed(chords: { time: number; name: string }[], sections: { name: string; start: number; end: number }[], perBar: number, barsPerLine = 4): string {
  const out: string[] = [];
  for (const s of sections) {
    out.push(`[${s.name}]`);
    const cs = chords.filter((c) => c.time >= s.start - 1e-6 && c.time < s.end - 1e-6).map((c) => c.name);
    const bars: string[] = [];
    for (let i = 0; i < cs.length; i += perBar) bars.push(cs.slice(i, i + perBar).join(' '));
    for (let i = 0; i < bars.length; i += barsPerLine) out.push(`| ${bars.slice(i, i + barsPerLine).join(' | ')} |`);
    out.push('');
  }
  return out.join('\n').trim();
}

// ---------------------------------------------------------------------------------------------
// Standard MIDI Files

export interface MidiNote {
  midi: number;
  velocity: number;
  channel: number;
  /** Seconds. */
  time: number;
  duration: number;
  startTick: number;
  endTick: number;
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
  /** Channels used by the notes, ascending. */
  channels: number[];
  /** First program change seen (GM instrument), if any. */
  program?: number;
}

export interface MidiFile {
  format: number;
  /** Ticks per quarter note (or ticks per second for SMPTE timing, flagged by `smpte`). */
  division: number;
  smpte: boolean;
  tracks: MidiTrack[];
  tempos: { tick: number; usPerQuarter: number }[];
  /** First time signature, e.g. [4, 4]. */
  timeSignature?: [number, number];
  /** Seconds, end of the last note. */
  duration: number;
}

/** Parses a Standard MIDI File (formats 0, 1, 2): notes with running status, tempo map, track names. */
export function parseMidi(bytes: Uint8Array): MidiFile {
  let p = 0;
  const u8 = () => {
    if (p >= bytes.length) throw new Error('MIDI file is truncated');
    return bytes[p++];
  };
  const u16 = () => (u8() << 8) | u8();
  const u32 = () => ((u8() << 24) >>> 0) + (u8() << 16) + (u8() << 8) + u8();
  const str = (n: number) => String.fromCharCode(...bytes.subarray(p, (p += n)));
  const vlq = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('MIDI: bad variable-length number');
  };
  // Some files are wrapped in RIFF (RMID); find MThd.
  const at = findChunk(bytes, 'MThd');
  if (at < 0) throw new Error('Not a MIDI file (no MThd header)');
  p = at + 4;
  const hlen = u32();
  const hstart = p;
  const format = u16();
  const ntrks = u16();
  const divRaw = u16();
  p = hstart + hlen;
  const smpte = (divRaw & 0x8000) !== 0;
  const division = smpte ? (256 - (divRaw >> 8)) * (divRaw & 0xff) : divRaw;
  if (!division) throw new Error('MIDI: zero time division');

  type Raw = { name: string; program?: number; notes: Omit<MidiNote, 'time' | 'duration'>[] };
  const raws: Raw[] = [];
  const tempos: MidiFile['tempos'] = [];
  let timeSignature: [number, number] | undefined;
  let fmt2Offset = 0;
  for (let t = 0; t < ntrks && p < bytes.length; t++) {
    // Skip unknown chunks until the next MTrk.
    let id = str(4);
    let len = u32();
    while (id !== 'MTrk') {
      p += len;
      if (p + 8 > bytes.length) break;
      id = str(4);
      len = u32();
    }
    if (id !== 'MTrk') break;
    const end = Math.min(bytes.length, p + len);
    const raw: Raw = { name: '', notes: [] };
    const open = new Map<number, { tick: number; vel: number }[]>();
    let tick = format === 2 ? fmt2Offset : 0;
    let status = 0;
    while (p < end) {
      tick += vlq();
      let b = u8();
      if (b & 0x80) {
        if (b < 0xf0) status = b;
      } else {
        if (!status) throw new Error('MIDI: running status without a status byte');
        p--;
        b = status;
      }
      if (b === 0xff) {
        const type = u8();
        const l = vlq();
        const s = p;
        if (type === 0x51 && l === 3) tempos.push({ tick, usPerQuarter: (bytes[s] << 16) | (bytes[s + 1] << 8) | bytes[s + 2] });
        else if (type === 0x03 && !raw.name) raw.name = new TextDecoder('latin1').decode(bytes.subarray(s, s + l)).trim();
        else if (type === 0x58 && l >= 2 && !timeSignature) timeSignature = [bytes[s], 2 ** bytes[s + 1]];
        p = s + l;
        if (type === 0x2f) break;
      } else if (b === 0xf0 || b === 0xf7) {
        const len = vlq(); // (not `p += vlq()`: that reads p before vlq advances it)
        p += len;
      } else {
        const kind = b & 0xf0, ch = b & 0x0f;
        const d1 = u8();
        const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : u8();
        if (kind === 0x90 && d2 > 0) {
          const key = ch * 128 + d1;
          const list = open.get(key) ?? [];
          list.push({ tick, vel: d2 });
          open.set(key, list);
        } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
          const key = ch * 128 + d1;
          const on = open.get(key)?.shift(); // FIFO: first on pairs with first off
          if (on) raw.notes.push({ midi: d1, velocity: on.vel, channel: ch, startTick: on.tick, endTick: tick });
        } else if (kind === 0xc0 && raw.program === undefined) raw.program = d1;
      }
    }
    // Close hanging notes at the track end.
    for (const [key, list] of open) for (const on of list) raw.notes.push({ midi: key % 128, velocity: on.vel, channel: key >> 7, startTick: on.tick, endTick: Math.max(on.tick + 1, tick) });
    if (format === 2) fmt2Offset = tick;
    p = end;
    raws.push(raw);
  }
  tempos.sort((a, b) => a.tick - b.tick);
  const toSec = ticksToSeconds(division, smpte, tempos);
  let duration = 0;
  const tracks: MidiTrack[] = raws.map((r, i) => {
    const notes = r.notes
      .map((n) => {
        const time = toSec(n.startTick);
        const dur = toSec(n.endTick) - time;
        duration = Math.max(duration, time + dur);
        return { ...n, time, duration: dur };
      })
      .sort((a, b) => a.time - b.time || a.midi - b.midi);
    return { name: r.name || `Track ${i + 1}`, notes, channels: [...new Set(notes.map((n) => n.channel))].sort((a, b) => a - b), program: r.program };
  });
  return { format, division, smpte, tracks, tempos, timeSignature, duration };
}

function findChunk(bytes: Uint8Array, id: string): number {
  const c = [...id].map((ch) => ch.charCodeAt(0));
  for (let i = 0; i + 4 <= Math.min(bytes.length, 4096); i++) if (bytes[i] === c[0] && bytes[i + 1] === c[1] && bytes[i + 2] === c[2] && bytes[i + 3] === c[3]) return i;
  return -1;
}

/** Tick → seconds converter for a tempo map (default 120 bpm until the first tempo event). */
export function ticksToSeconds(division: number, smpte: boolean, tempos: { tick: number; usPerQuarter: number }[]): (tick: number) => number {
  if (smpte) return (t) => t / division;
  // Precompute the seconds at each tempo change.
  const segs: { tick: number; sec: number; spt: number }[] = [{ tick: 0, sec: 0, spt: 0.5 / division }];
  for (const tp of tempos) {
    const last = segs[segs.length - 1];
    const sec = last.sec + (tp.tick - last.tick) * last.spt;
    const spt = tp.usPerQuarter / 1e6 / division;
    if (tp.tick === last.tick) (last.spt = spt), (last.sec = sec);
    else segs.push({ tick: tp.tick, sec, spt });
  }
  return (t) => {
    let i = segs.length - 1;
    while (i > 0 && segs[i].tick > t) i--;
    return segs[i].sec + (t - segs[i].tick) * segs[i].spt;
  };
}

/** Writes a format-1 SMF (tempo track + one track per note list), using running status. */
export function writeMidi(tracks: { name: string; channel?: number; notes: { midi: number; time: number; duration: number; velocity?: number }[] }[], bpm = 120, ppq = 480): Uint8Array {
  const out: number[] = [];
  const u16 = (v: number) => out.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => out.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  const vlq = (v: number, arr: number[]) => {
    const b = [v & 0x7f];
    while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80);
    arr.push(...b);
  };
  const chunk = (id: string, data: number[]) => {
    out.push(...[...id].map((c) => c.charCodeAt(0)));
    u32(data.length);
    out.push(...data);
  };
  out.push(...[...'MThd'].map((c) => c.charCodeAt(0)));
  u32(6);
  u16(1);
  u16(tracks.length + 1);
  u16(ppq);
  const us = Math.round(60e6 / bpm);
  chunk('MTrk', [0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255, 0, 0xff, 0x58, 4, 4, 2, 24, 8, 0, 0xff, 0x2f, 0]);
  const tick = (s: number) => Math.round((s * bpm * ppq) / 60);
  tracks.forEach((tr, i) => {
    const ch = (tr.channel ?? i) & 15;
    const ev: { t: number; on: boolean; m: number; v: number }[] = [];
    for (const n of tr.notes) {
      ev.push({ t: tick(n.time), on: true, m: n.midi, v: n.velocity ?? 90 });
      ev.push({ t: tick(n.time + n.duration), on: false, m: n.midi, v: 0 });
    }
    ev.sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on));
    const data: number[] = [0, 0xff, 0x03];
    const name = [...tr.name].map((c) => c.charCodeAt(0) & 0x7f);
    vlq(name.length, data);
    data.push(...name);
    let last = 0;
    let first = true;
    for (const e of ev) {
      vlq(e.t - last, data);
      last = e.t;
      // Note-off as note-on with velocity 0, so running status applies throughout.
      if (first) data.push(0x90 | ch), (first = false);
      data.push(e.m, e.on ? e.v : 0);
    }
    data.push(0, 0xff, 0x2f, 0);
    chunk('MTrk', data);
  });
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------------
// Loading

/**
 * The audio behind a `file` knob, or the public-domain demo song (with its ground truth) when
 * none is uploaded. Doesn't touch AudioContext for the demo, so it works headlessly.
 */
export async function loadSongOrDemo(refs: FileRef[] | undefined, status?: (m: string) => void): Promise<{ audio: Audio; demo: DemoSong | null }> {
  if (!Array.isArray(refs) || !refs.length) {
    const demo = demoSong();
    return { audio: demo, demo };
  }
  return { audio: await loadAudio(refs, status), demo: null };
}
