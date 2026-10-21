import type { Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import type { Audio } from '../lib/audio';
import { FONT_OPTIONS, measureText, text } from '../lib/hershey';
import { loadLyrics, lyricsParams, type LyricLine } from '../lib/lyrics';
import { loadSong, loudnessCurve, songName, wordTimes, type LyricWord } from '../lib/music-text';
import type { Values } from '../params';
import { defineArtwork } from './types';

export interface SizedWord extends LyricWord {
  /** Mean loudness while sung, 0–1 of the song's loudest moment. */
  loud: number;
  /** Loudness rank-normalised to 0–1 across the words (drives size). */
  level: number;
  size: number;
}

/** Each word's timing and loudness, and its size. Pure, for testing. */
export function sizeWords(audio: Audio, lines: LyricLine[], v: Values): SizedWord[][] {
  const curve = loudnessCurve(audio, 0.02);
  const words = wordTimes(lines, audio.duration, 1, (a, b) => curve.activeEnd(a, b));
  const louds = words.flat().map((w) => curve.over(w.start, w.end));
  const sorted = louds.slice().sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const hi = sorted[sorted.length - 1] ?? 1;
  // Rank: the fraction of words quieter than this one (ties share the average rank).
  const rank = (x: number) => {
    const below = sorted.filter((y) => y < x).length, same = sorted.filter((y) => y === x).length;
    return sorted.length > 1 ? (below + (same - 1) / 2) / (sorted.length - 1) : 1;
  };
  let k = 0;
  return words.map((line) =>
    line.map((w) => {
      const loud = louds[k++];
      const level = v.scale === 'rank' ? rank(loud) : Math.max(0, Math.min(1, (loud - lo) / (hi - lo || 1)));
      return { ...w, loud, level, size: v.minSize + (v.maxSize - v.minSize) * Math.pow(level, v.emphasis) };
    }),
  );
}

interface Placed {
  w: SizedWord;
  x: number;
  y: number;
}

/** The drawing. Pure, so it can be tested without AudioContext. */
export function loudWords(audio: Audio, lines: LyricLine[], v: Values, W: number, H: number): Layer[] {
  const font = v.font;
  const sized = sizeWords(audio, lines, v).filter((l) => l.length);
  if (!sized.length) return [];
  const width = (w: SizedWord) => measureText(w.text, { size: w.size, font });
  const gap = (a: SizedWord, b: SizedWord) => v.wordSpace * Math.max(a.size, b.size);

  // Break into typeset rows, flowing words up to a measure chosen so the block has the page's
  // shape. 'lines' also breaks at the end of every lyric line.
  const natural = (row: SizedWord[]) => row.reduce((s, w, i) => s + width(w) + (i ? gap(row[i - 1], w) : 0), 0);
  const rowHeight = (row: SizedWord[]) => Math.max(...row.map((w) => w.size)) * v.leading;
  const groups = v.layout === 'flow' ? [sized.flat()] : sized;
  const flow = (m: number) => {
    const out: SizedWord[][] = [];
    for (const g of groups) {
      out.push([]);
      let x = 0;
      for (const w of g) {
        const cur = out[out.length - 1];
        const add = width(w) + (cur.length ? gap(cur[cur.length - 1], w) : 0);
        if (cur.length && x + add > m) {
          out.push([w]);
          x = width(w);
        } else {
          cur.push(w);
          x += add;
        }
      }
    }
    return out;
  };
  const all = sized.flat();
  let a = Math.max(...all.map(width)), b = Math.max(a, ...groups.map(natural));
  for (let it = 0; it < 30; it++) {
    const m = (a + b) / 2;
    const r = flow(m);
    const h = r.reduce((s, row) => s + rowHeight(row), 0);
    if (Math.max(...r.map(natural)) / h < W / H) a = m;
    else b = m;
  }
  const rows = flow(b);
  const measure = Math.max(...rows.map(natural));
  const lastOfGroup = new Set<number>();
  {
    // Mark the last row of each lyric line (not stretched, like the end of a paragraph).
    let ri = 0;
    for (const g of groups) {
      let left = g.length;
      while (left > 0 && ri < rows.length) left -= rows[ri++].length;
      lastOfGroup.add(ri - 1);
    }
  }

  // Set each row.
  const placed: Placed[] = [];
  let y = 0;
  rows.forEach((row, ri) => {
    const cap = Math.max(...row.map((w) => w.size));
    y += ri === 0 ? cap : cap * v.leading;
    const nat = natural(row);
    const last = lastOfGroup.has(ri) && (v.layout === 'flow' || natural(row) < measure * 0.75);
    let x = v.align === 'center' ? (measure - nat) / 2 : v.align === 'right' ? measure - nat : 0;
    let extra = 0;
    if (v.align === 'justify') {
      if (row.length > 1 && !last && nat > measure * 0.5) extra = (measure - nat) / (row.length - 1);
      else x = last ? 0 : (measure - nat) / 2;
    }
    row.forEach((w, i) => {
      if (i) x += gap(row[i - 1], w) + extra;
      placed.push({ w, x, y });
      x += width(w);
    });
  });
  const blockH = y + Math.max(...rows[rows.length - 1].map((w) => w.size)) * 0.4; // room for descenders
  // Scale the block to fit the page, centred.
  const bold = v.weight === 'repeat' ? (v.maxPasses - 1) * v.passOffset : 0;
  const s = Math.min((W - bold) / measure, (H - bold) / blockH) * v.fill;
  const ox = (W - measure * s) / 2, oy = (H - blockH * s) / 2;

  const ink: Polyline[] = [];
  const loud: Polyline[] = [];
  for (const { w, x, y: by } of placed) {
    const size = w.size * s;
    const passes = v.weight === 'repeat' ? 1 + Math.round(Math.max(0, (w.level - v.boldFrom) / (1 - v.boldFrom || 1)) * (v.maxPasses - 1)) : 1;
    const target = v.loudPen && w.level >= v.loudPenAt ? loud : ink;
    for (let p = 0; p < passes; p++) {
      // Offsets fan out a little to the right and up, like a heavier nib.
      const dx = p * v.passOffset, dy = -p * v.passOffset * 0.35;
      target.push(...text(w.text, { x: ox + x * s + dx, y: oy + by * s + dy, size, font }));
    }
  }
  const layers: Layer[] = [{ name: 'Words', color: PALETTE[0], paths: ink }];
  if (loud.length) layers.push({ name: 'Loudest words', color: PALETTE[1], paths: loud });
  return layers;
}

export default defineArtwork({
  slug: 'loud-words',
  title: 'Words sized by loudness',
  description: 'The lyrics typeset as a block, each word as big as the music is loud while it’s sung.',
  order: 72,
  series: 'Music',
  paper: { paper: 'a4', orientation: 'portrait', margin: 20 },
  mainThread: true,
  params: [
    { type: 'file', key: 'audio', label: 'Audio', accept: 'audio/*', default: [], hint: 'Without one, a public-domain demo song is used.' },
    ...lyricsParams(),
    { type: 'select', key: 'layout', label: 'Layout', options: [['lines', 'One row per lyric line'], ['flow', 'Flowing paragraph']], default: 'lines', hint: 'Flowing suits long songs' },
    { type: 'select', key: 'align', label: 'Alignment', options: [['justify', 'Justified'], ['center', 'Centred'], ['left', 'Left'], ['right', 'Right']], default: 'justify' },
    { type: 'select', key: 'scale', label: 'Loudness scale', options: [['rank', 'Ranked (even spread of sizes)'], ['linear', 'Linear (true dynamics)']], default: 'rank' },
    { type: 'number', key: 'minSize', label: 'Quietest size', min: 1, max: 20, step: 0.5, default: 4, hint: 'Relative: the block is scaled to fit the page' },
    { type: 'number', key: 'maxSize', label: 'Loudest size', min: 2, max: 40, step: 0.5, default: 14 },
    { type: 'number', key: 'emphasis', label: 'Emphasis', min: 0.3, max: 4, step: 0.05, default: 1.6, hint: 'Higher = only the loudest words get big' },
    { type: 'number', key: 'leading', label: 'Line spacing', min: 1, max: 2.5, step: 0.05, default: 1.35 },
    { type: 'number', key: 'wordSpace', label: 'Word spacing', min: 0.2, max: 1.5, step: 0.05, default: 0.45 },
    { type: 'number', key: 'fill', label: 'Fill', min: 0.5, max: 1, step: 0.01, default: 1, hint: 'How much of the page the block fills' },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'timesr' },
    { type: 'select', key: 'weight', label: 'Weight', options: [['repeat', 'Loud words drawn bolder (repeated strokes)'], ['none', 'Size only']], default: 'repeat' },
    { type: 'number', key: 'maxPasses', label: 'Boldest passes', min: 2, max: 5, step: 1, default: 3, show: (v) => v.weight === 'repeat' },
    { type: 'number', key: 'boldFrom', label: 'Bold from level', min: 0, max: 0.95, step: 0.05, default: 0.55, show: (v) => v.weight === 'repeat', hint: 'Words louder than this get extra passes' },
    { type: 'number', key: 'passOffset', label: 'Pass offset (mm)', min: 0.1, max: 1, step: 0.05, default: 0.3, show: (v) => v.weight === 'repeat' },
    { type: 'checkbox', key: 'loudPen', label: 'Loudest words on a second pen', default: false },
    { type: 'number', key: 'loudPenAt', label: 'Loud enough for pen 2', min: 0, max: 1, step: 0.01, default: 0.8, show: (v) => v.loudPen },
  ],
  caption: (v) => songName(v),
  async generate(v, ctx) {
    const audio = await loadSong(v, ctx.status);
    const lines = await loadLyrics(v, audio.duration, ctx.status);
    if (!lines.length) throw new Error('No lyrics: choose a lyrics source');
    return loudWords(audio, lines, v, ctx.width, ctx.height);
  },
});
