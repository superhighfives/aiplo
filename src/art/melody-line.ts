import { smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import type { Audio } from '../lib/audio';
import { FONT_OPTIONS, measureText, text } from '../lib/hershey';
import { loadLyrics, lyricsParams, type LyricLine } from '../lib/lyrics';
import { hzToMidi, loadSongOrDemo, noteName, trackPitch } from '../lib/music';
import type { SongNote } from '../lib/song';
import type { Values } from '../params';
import { defineArtwork } from './types';

/** Matches syllables (one per note) to the words of a lyric line, so we know where to hyphenate. */
function wordEnds(line: string, syllables: string[]): boolean[] {
  const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, '');
  const words = line.split(/\s+/).map(letters).filter(Boolean);
  const ends: boolean[] = [];
  let w = 0, acc = '';
  for (const s of syllables) {
    acc += letters(s);
    const done = w < words.length && acc.length >= words[w].length;
    ends.push(done || w >= words.length);
    if (done) (w++, (acc = ''));
  }
  return ends;
}

/** The drawing, from decoded audio and lyrics. Pure, so it can be tested without AudioContext. */
export function melodyLine(audio: Audio, lyrics: LyricLine[], notes: SongNote[] | null, v: Values, W: number, H: number): Layer[] {
  const s = Math.max(0, v.smoothing);
  const frames = trackPitch(audio.samples, audio.sampleRate, {
    minConfidence: v.confidence,
    median: 5,
    fmin: 70,
    fmax: 1100,
  });
  // Pitch per frame in semitones (NaN = rest). Split at leaps of more than a fifth in one frame
  // (tracking glitches, not singing), drop scraps, then Gaussian-smooth over time within runs.
  const pm = frames.map((f) => (f.voiced ? hzToMidi(f.f0) : NaN));
  for (let i = 1; i < pm.length; i++) if (Math.abs(pm[i] - pm[i - 1]) > 7) pm[i] = NaN;
  const sig = s * 2.5; // frames (10 ms each)
  const taps = Math.ceil(sig * 2.5);
  for (let i = 0; i < pm.length; ) {
    if (isNaN(pm[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < pm.length && !isNaN(pm[j])) j++;
    if (j - i < 10) for (let k = i; k < j; k++) pm[k] = NaN;
    else if (sig > 0) {
      const src = pm.slice(i, j);
      for (let k = i; k < j; k++) {
        let a = 0, w = 0;
        for (let d = -taps; d <= taps; d++) {
          const q = k + d;
          if (q < i || q >= j) continue;
          const g = Math.exp(-(d * d) / (2 * sig * sig));
          a += src[q - i] * g;
          w += g;
        }
        pm[k] = a / w;
      }
    }
    i = j;
  }
  // Legato: bridge short rests between notes so phrases read as one line.
  const gap = Math.round(v.bridge / 10);
  for (let i = 1; i < pm.length && gap > 0; i++) {
    if (!isNaN(pm[i]) || isNaN(pm[i - 1])) continue;
    let j = i;
    while (j < pm.length && isNaN(pm[j])) j++;
    if (j < pm.length && j - i <= gap && Math.abs(pm[j] - pm[i - 1]) <= 12) {
      const a = pm[i - 1], b = pm[j];
      for (let k = i; k < j; k++) {
        const t = (k - i + 1) / (j - i + 1);
        pm[k] = a + (b - a) * (t * t * (3 - 2 * t));
      }
    }
    i = j;
  }
  const voiced = frames.filter((_, i) => !isNaN(pm[i]));
  if (!voiced.length) throw new Error('No sung or played pitch found; try a lower confidence threshold');
  const midis = pm.filter((m) => !isNaN(m)).sort((a, b) => a - b);
  let lo = v.autoRange ? Math.floor(midis[Math.floor(midis.length * 0.02)] - 1.5) : v.low;
  let hi = v.autoRange ? Math.ceil(midis[Math.floor(midis.length * 0.98)] + 1.5) : v.high;
  if (hi - lo < 6) (lo -= (6 - (hi - lo)) / 2), (hi = lo + 6);

  // Systems (rows of the score): one per lyric line, or evenly split.
  const first = voiced[0].time, last = voiced[voiced.length - 1].time;
  const lead = 0.25;
  let spans: [number, number][] = [];
  if (v.systems === 'lyrics' && lyrics.length) {
    const starts = lyrics.map((l) => l.time);
    for (let i = 0; i < starts.length; i++) {
      const a = (i === 0 ? Math.min(first, starts[0]) : starts[i]) - lead;
      const b = i + 1 < starts.length ? starts[i + 1] - lead : last + 0.3;
      if (b > a) spans.push([a, b]);
    }
    // Long instrumental stretches inside one line: split lines much longer than the median.
    const lens = spans.map(([a, b]) => b - a).sort((x, y) => x - y);
    const med = lens[lens.length >> 1];
    spans = spans.flatMap(([a, b]) => {
      const k = Math.max(1, Math.ceil((b - a) / (med * 1.25)));
      return Array.from({ length: k }, (_, j) => [a + ((b - a) * j) / k, a + ((b - a) * (j + 1)) / k] as [number, number]);
    });
    // One time scale for every row (like bars lining up down a page): short rows end early.
    const scale = Math.max(...spans.map(([a, b]) => b - a).filter((d) => d <= med * 1.25 + 1e-6));
    spans = spans.map(([a, b]) => [a, Math.max(b, a + scale)]);
  } else {
    const n = Math.max(1, Math.round(v.count));
    const a0 = first - lead, a1 = last + lead;
    spans = Array.from({ length: n }, (_, i) => [a0 + ((a1 - a0) * i) / n, a0 + ((a1 - a0) * (i + 1)) / n]);
  }
  const N = spans.length;
  const rowH = H / N;
  const lyricSize = v.lyricSize;
  const hasLyrics = lyrics.length > 0;
  const lyricBand = hasLyrics ? lyricSize * 2.6 : 0;
  const staffH = Math.max(4, Math.min(rowH * 0.78, rowH - lyricBand - rowH * 0.12));
  const labelW = v.labels && v.grid !== 'none' ? measureText('C#5', { size: 2.2 }) + 2.5 : 0;
  const x0 = labelW, x1 = W;

  const ink: Polyline[] = [];
  const grid: Polyline[] = [];
  const words: Polyline[] = [];
  spans.forEach(([ta, tb], si) => {
    const top = si * rowH + (rowH - staffH - lyricBand) * 0.35;
    const yOf = (m: number) => top + staffH * (1 - (m - lo) / (hi - lo));
    const xOf = (t: number) => x0 + ((t - ta) / (tb - ta)) * (x1 - x0);
    // Grid on pen 2.
    if (v.grid === 'staff') {
      for (let k = 0; k < 5; k++) {
        const y = top + staffH * (0.1 + 0.2 * k);
        grid.push([[x0, y], [x1, y]]);
      }
    } else if (v.grid === 'semitones') {
      for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
        const y = yOf(m);
        grid.push([[x0, y], [x1, y]]);
        if (m % 12 === 0) grid.push([[x0, y + 0.35], [x1, y + 0.35]]);
        if (v.labels && (m % 12 === 0 || m === Math.ceil(lo) || m === Math.floor(hi))) words.push(...text(noteName(m), { x: x0 - 1.2, y: y + 1.1, size: 2.2, align: 'right' }));
      }
    }
    if (v.grid !== 'none' && v.barline) {
      grid.push([[x0, top + (v.grid === 'staff' ? staffH * 0.1 : 0)], [x0, top + (v.grid === 'staff' ? staffH * 0.9 : staffH)]]);
      grid.push([[x1, top + (v.grid === 'staff' ? staffH * 0.1 : 0)], [x1, top + (v.grid === 'staff' ? staffH * 0.9 : staffH)]]);
    }
    // The melody: voiced runs inside this system, as continuous lines.
    let run: Pt[] = [];
    const flush = () => {
      if (run.length > 2) ink.push(smooth(run, 0.3));
      run = [];
    };
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const m = pm[i];
      if (f.time < ta || f.time >= tb || isNaN(m) || m < lo - 0.5 || m > hi + 0.5) {
        flush();
        continue;
      }
      run.push([xOf(f.time), yOf(m)]);
    }
    flush();
    // Lyrics beneath, in time with the line.
    if (!hasLyrics) return;
    const base = top + staffH + lyricSize * 1.9;
    const put = (str: string, t: number, align: 'left' | 'center') => {
      if (t < ta || t >= tb) return;
      words.push(...text(str, { x: xOf(t), y: base, size: lyricSize, font: v.font, align }));
    };
    const pending: { w: string; x: number }[] = [];
    if (notes && v.lyricsSource === 'demo') {
      // Syllables under their notes, hyphens between syllables of one word, like sheet music.
      lyrics.forEach((line, li) => {
        const ns = notes.filter((n) => n.time >= line.time - 0.01 && (li + 1 >= lyrics.length || n.time < lyrics[li + 1].time - 0.01));
        const ends = wordEnds(line.text, ns.map((n) => n.syllable));
        ns.forEach((n, k) => {
          const x = n.time + Math.min(0.12, n.duration * 0.2);
          put(n.syllable, x, 'left');
          if (!ends[k] && ns[k + 1]) {
            const mid = (x + ns[k + 1].time) / 2 + 0.05;
            put('-', mid, 'center');
          }
        });
      });
    } else {
      // Words spread across each line's time, proportional to their length.
      for (const line of lyrics) {
        const ws = line.text.split(/\s+/).filter(Boolean);
        const end = Math.min(line.end ?? line.time + 4, line.time + Math.max(2, ws.length * 0.9));
        const total = ws.reduce((a, w) => a + w.length + 1, 0);
        let acc = 0;
        for (const w of ws) {
          let t = line.time + ((end - line.time) * acc) / total;
          if (si === N - 1) t = Math.min(t, tb - 1e-3);
          if (t >= ta && t < tb) pending.push({ w, x: xOf(t) });
          acc += w.length + 1;
        }
      }
      // Keep words from colliding, and pull the row's tail back inside the right edge.
      pending.sort((a, b) => a.x - b.x);
      const gapW = measureText(' ', { size: lyricSize, font: v.font }) * 1.2;
      let right = -Infinity;
      for (const p of pending) {
        p.x = Math.max(p.x, right + gapW);
        right = p.x + measureText(p.w, { size: lyricSize, font: v.font });
      }
      const over = right - x1;
      for (let k = pending.length - 1, lim = x1; k >= 0 && over > 0; k--) {
        const wd = measureText(pending[k].w, { size: lyricSize, font: v.font });
        if (pending[k].x + wd <= lim) break;
        pending[k].x = lim - wd;
        lim = pending[k].x - gapW;
      }
      for (const p of pending) words.push(...text(p.w, { x: p.x, y: base, size: lyricSize, font: v.font }));
    }
  });
  const layers: Layer[] = [{ name: 'Melody', color: PALETTE[0], paths: ink }];
  if (words.length) layers.push({ name: 'Lyrics', color: PALETTE[0], paths: words });
  if (grid.length) layers.push({ name: 'Staff', color: PALETTE[2], paths: grid });
  return layers;
}

export default defineArtwork({
  slug: 'melody-line',
  title: 'Melody line',
  description: 'The sung melody traced as one continuous line, broken where the voice rests, with the words lettered beneath like a score.',
  order: 80,
  series: 'Music',
  paper: { paper: 'a4', orientation: 'portrait', margin: 20 },
  mainThread: true,
  params: [
    { type: 'file', key: 'audio', label: 'Audio', accept: 'audio/*', default: [], hint: 'A cappella or a clear vocal works best. Without one, a public-domain demo song is used.' },
    ...lyricsParams(),
    { type: 'select', key: 'systems', label: 'Rows', options: [['lyrics', 'One per lyric line'], ['even', 'Evenly split']], default: 'lyrics', hint: 'Wrap the line into rows like the systems of a score' },
    { type: 'number', key: 'count', label: 'Number of rows', min: 1, max: 20, step: 1, default: 6, show: (v) => v.systems === 'even' },
    { type: 'number', key: 'smoothing', label: 'Smoothing', min: 0, max: 12, step: 0.5, default: 1.5, hint: 'Averages the pitch over time; around 5 irons out vibrato' },
    { type: 'number', key: 'confidence', label: 'Confidence threshold', min: 0.4, max: 0.98, step: 0.01, default: 0.75, hint: 'Higher breaks the line more often, keeping only clearly pitched sound' },
    { type: 'number', key: 'bridge', label: 'Join rests shorter than (ms)', min: 0, max: 500, step: 10, default: 160, hint: 'Connects notes across breaths and consonants; 0 breaks at every gap' },
    { type: 'checkbox', key: 'autoRange', label: 'Auto pitch range', default: true },
    { type: 'number', key: 'low', label: 'Lowest note (MIDI)', min: 24, max: 96, step: 1, default: 55, show: (v) => !v.autoRange, hint: '60 = middle C' },
    { type: 'number', key: 'high', label: 'Highest note (MIDI)', min: 30, max: 108, step: 1, default: 74, show: (v) => !v.autoRange },
    { type: 'select', key: 'grid', label: 'Grid (pen 2)', options: [['staff', 'Five-line staff'], ['semitones', 'Semitone lines'], ['none', 'None']], default: 'staff' },
    { type: 'checkbox', key: 'labels', label: 'Note names', default: true, show: (v) => v.grid === 'semitones' },
    { type: 'checkbox', key: 'barline', label: 'Close the staff ends', default: true, show: (v) => v.grid !== 'none' },
    { type: 'number', key: 'lyricSize', label: 'Lyric size (mm)', min: 1.5, max: 8, step: 0.1, default: 3.4 },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'scripts' },
  ],
  caption: (v) => (v.audio?.[0]?.name ?? 'Twinkle, Twinkle, Little Star').replace(/\.[^.]+$/, ''),
  async generate(v, ctx) {
    const { audio, demo } = await loadSongOrDemo(v.audio, ctx.status);
    const lyrics = await loadLyrics(v, audio.duration, ctx.status);
    return melodyLine(audio, lyrics, demo?.notes ?? null, v, ctx.width, ctx.height);
  },
});
