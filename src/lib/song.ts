/**
 * A public-domain demo song: "Twinkle, Twinkle, Little Star" (lyrics Jane Taylor, 1806; the
 * melody is the traditional "Ah! vous dirai-je, maman"). Synthesized with a sung-ish lead
 * (harmonics, vibrato, vowel formants), soft chords and bass, with exact note and lyric
 * timings. Music pieces use it as their default, so thumbnails never need copyrighted material.
 */
import type { Audio } from './audio';
import type { LyricLine } from './lyrics';

/** One sung note: MIDI pitch, start and length in seconds, and the syllable sung on it. */
export interface SongNote {
  midi: number;
  time: number;
  duration: number;
  syllable: string;
}

export interface DemoSong extends Audio {
  notes: SongNote[];
  lyrics: LyricLine[];
  /** Chord per bar, e.g. 'C', 'F', 'G'. */
  chords: { time: number; duration: number; name: string }[];
  bpm: number;
}

const LINES: [string, string[], number[]][] = [
  // [line, syllables (one per note), MIDI pitches]
  ['Twinkle, twinkle, little star', ['Twin', 'kle', 'twin', 'kle', 'lit', 'tle', 'star'], [60, 60, 67, 67, 69, 69, 67]],
  ['How I wonder what you are', ['How', 'I', 'won', 'der', 'what', 'you', 'are'], [65, 65, 64, 64, 62, 62, 60]],
  ['Up above the world so high', ['Up', 'a', 'bove', 'the', 'world', 'so', 'high'], [67, 67, 65, 65, 64, 64, 62]],
  ['Like a diamond in the sky', ['Like', 'a', 'dia', 'mond', 'in', 'the', 'sky'], [67, 67, 65, 65, 64, 64, 62]],
  ['Twinkle, twinkle, little star', ['Twin', 'kle', 'twin', 'kle', 'lit', 'tle', 'star'], [60, 60, 67, 67, 69, 69, 67]],
  ['How I wonder what you are', ['How', 'I', 'won', 'der', 'what', 'you', 'are'], [65, 65, 64, 64, 62, 62, 60]],
];
// Chords per half-line (each half-line is 2 beats + 2 beats).
const CHORDS: string[][] = [
  ['C', 'C', 'F', 'C'],
  ['F', 'C', 'G', 'C'],
  ['C', 'F', 'C', 'G'],
  ['C', 'F', 'C', 'G'],
  ['C', 'C', 'F', 'C'],
  ['F', 'C', 'G', 'C'],
];
const CHORD_NOTES: Record<string, number[]> = { C: [48, 52, 55], F: [48, 53, 57], G: [47, 50, 55] };

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

let cached: DemoSong | null = null;

export function demoSong(sampleRate = 16000): DemoSong {
  if (cached && cached.sampleRate === sampleRate) return cached;
  const bpm = 100;
  const beat = 60 / bpm;
  const intro = 2 * beat;
  const lineDur = 8 * beat; // six quarter notes + one half note
  const duration = intro + LINES.length * lineDur + 2 * beat;
  const n = Math.ceil(duration * sampleRate);
  const out = new Float32Array(n);
  const notes: SongNote[] = [];
  const lyrics: LyricLine[] = [];
  const chords: DemoSong['chords'] = [];

  LINES.forEach(([text, syl, pitches], li) => {
    const t0 = intro + li * lineDur;
    lyrics.push({ time: t0, text });
    for (let k = 0; k < 7; k++) notes.push({ midi: pitches[k], time: t0 + k * beat, duration: k === 6 ? 2 * beat : beat, syllable: syl[k] });
    CHORDS[li].forEach((name, q) => chords.push({ time: t0 + q * 2 * beat, duration: 2 * beat, name }));
  });

  // Lead "voice": harmonics shaped by a vowel-ish formant, gentle vibrato, legato envelope.
  for (const note of notes) {
    const f0 = hz(note.midi);
    const s0 = Math.floor(note.time * sampleRate);
    const len = Math.floor(note.duration * 0.95 * sampleRate);
    // Formants near 700 Hz and 1200 Hz ("ah"), per harmonic.
    const amps = Array.from({ length: 8 }, (_, k) => {
      const fh = f0 * (k + 1);
      return (1 / (k + 1)) * (0.35 + Math.exp(-(((fh - 700) / 250) ** 2)) + 0.6 * Math.exp(-(((fh - 1200) / 300) ** 2)));
    });
    // Accumulate phase so vibrato bends the pitch by ±10 cents, rather than drifting with time.
    let phase = 0;
    for (let i = 0; i < len && s0 + i < n; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t / 0.04) * Math.min(1, (len - i) / (0.08 * sampleRate));
      const vib = 1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3);
      phase += (2 * Math.PI * f0 * vib) / sampleRate;
      let v = 0;
      for (let h = 1; h <= 8; h++) v += amps[h - 1] * Math.sin(h * phase);
      out[s0 + i] += 0.22 * env * v;
    }
  }
  // Soft chords and a bass note per chord.
  for (const c of chords) {
    const s0 = Math.floor(c.time * sampleRate);
    const len = Math.floor(c.duration * sampleRate);
    const tones = CHORD_NOTES[c.name];
    for (let i = 0; i < len && s0 + i < n; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t / 0.02) * Math.exp(-t * 1.2);
      let v = 0;
      for (const m of tones) v += Math.sin(2 * Math.PI * hz(m) * t) + 0.3 * Math.sin(4 * Math.PI * hz(m) * t);
      v += 1.4 * Math.sin(2 * Math.PI * hz(tones[0] - 12) * t);
      out[s0 + i] += 0.05 * env * v;
    }
  }
  // Light tick on every beat so beat detection has something to find.
  for (let b = 0; b * beat < duration - beat; b++) {
    const s0 = Math.floor(b * beat * sampleRate);
    for (let i = 0; i < 0.03 * sampleRate && s0 + i < n; i++) out[s0 + i] += 0.08 * Math.exp(-i / (0.004 * sampleRate)) * Math.sin(i * 1.7);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] /= peak * 1.05;
  cached = { samples: out, sampleRate, duration, name: 'Twinkle, Twinkle, Little Star (demo)', notes, lyrics, chords, bpm };
  return cached;
}
