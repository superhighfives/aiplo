import type { Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { loadTerrainFor, terrainParams } from '../lib/elevation';
import { FONT_OPTIONS, measureText, text, textAlong } from '../lib/hershey';
import { imageParams, loadDarkness } from '../lib/image';
import { insetLoops, insideDistance, insideRings, maskFrom, maskOutline, presetRing, spansAt, type MaskGrid } from '../lib/words-shape';
import { defineArtwork } from './types';

// Emily Dickinson, "Hope" is the thing with feathers (c. 1861, published 1891): public domain.
const POEM = `"Hope" is the thing with feathers -
That perches in the soul -
And sings the tune without the words -
And never stops - at all -

And sweetest - in the Gale - is heard -
And sore must be the storm -
That could abash the little Bird
That kept so many warm -

I've heard it in the chillest land -
And on the strangest Sea -
Yet - never - in Extremity,
It asked a crumb - of me.`;

const maskArea = (m: MaskGrid) => m.data.reduce((a, x) => a + x, 0) * m.cell * m.cell;

/** Words to set, in order; `repeat` cycles them forever with a dot between passes. */
class Words {
  private i = 0;
  private pending: string | null = null;
  constructor(private list: string[], private repeat: boolean) {}
  peek(): string | null {
    if (this.pending) return this.pending;
    if (this.i < this.list.length) return this.list[this.i];
    if (this.repeat && this.list.length) return '·';
    return null;
  }
  take() {
    if (this.pending) this.pending = null;
    else if (this.i < this.list.length) this.i++;
    else this.i = 0; // the '·' between passes
  }
  /** Replace the next word with its unplaced tail (after hyphenating). */
  rest(tail: string) {
    this.take();
    this.pending = tail;
  }
  get done() {
    return !this.repeat && this.pending === null && this.i >= this.list.length;
  }
}

interface Fmt {
  size: number;
  font: string;
  hyphen: boolean;
}

/** Fills one line of `width` mm from the queue: the words (last may be hyphenated) and their natural width. */
function fillLine(q: Words, width: number, f: Fmt) {
  const space = measureText(' ', { size: f.size, font: f.font });
  const words: string[] = [];
  let w = 0;
  for (;;) {
    const word = q.peek();
    if (word === null) break;
    const ww = measureText(word, { size: f.size, font: f.font });
    const need = (words.length ? space : 0) + ww;
    if (w + need <= width) {
      words.push(word);
      w += need;
      q.take();
      continue;
    }
    // Hyphenate a long word (7+ letters) into the leftover room, keeping at least 3 letters each side.
    const room = width - w - (words.length ? space : 0);
    const letters = (t: string) => t.replace(/[^a-z]/gi, '').length;
    if (f.hyphen && letters(word) >= 7 && room > f.size * 2) {
      let cut = 0;
      for (let k = 3; k <= word.length - 3; k++) {
        if (!/[a-z]/i.test(word[k - 1]) || !/[a-z]/i.test(word[k])) continue;
        if (letters(word.slice(0, k)) < 3 || letters(word.slice(k)) < 3) continue;
        // A rough syllable break: after a vowel–consonant pair ("per-ches", not "perc-hes"),
        // or between a vowel and a consonant.
        const V = (c: string) => /[aeiouy]/i.test(c);
        const vcc = V(word[k - 2]) && !V(word[k - 1]) && !V(word[k]);
        const vc = V(word[k - 1]) && !V(word[k]);
        if (!vcc && !vc) continue;
        if (measureText(word.slice(0, k) + '-', { size: f.size, font: f.font }) <= room) cut = k;
      }
      if (cut) {
        const head = word.slice(0, cut) + '-';
        words.push(head);
        w += (words.length > 1 ? space : 0) + measureText(head, { size: f.size, font: f.font });
        q.rest(word.slice(cut));
      }
    }
    break;
  }
  return { words, natural: w, space };
}

type Layout = Fmt & { leading: number; repeat: boolean; pad: number; taper: boolean };

/**
 * Text rows flowing through every horizontal span of the shape, justified to each span.
 * With `taper`, rows where the shape is narrow get smaller letters (down to 30%), so text
 * reaches into points and lobes.
 */
export function layoutRows(m: MaskGrid, list: string[], f: Layout) {
  const q = new Words(list, f.repeat);
  const out: Polyline[] = [];
  let spanTotal = 0, inked = 0, used = 0, rowsLeft = 0;
  const padK = f.pad / f.size;
  const rowSpans = (cur: number, rs: number, minW: number) => spansAt(m, cur, cur + rs * (1.25 + 2 * padK), minW, rs * padK);
  // Find the shape's first row.
  let top = 0;
  outer: for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) if (m.data[j * m.nx + i]) { top = j * m.cell; break outer; }
  for (let cur = top; cur < m.H; ) {
    let rs = f.size;
    if (f.taper) {
      // Shrink until the widest span holds about six letters, or the floor (30%) is reached.
      // Also shrink enough for the next word to fit, so a long word can't stall the flow in a
      // narrow part (leaving the rest of the shape empty).
      const next = q.peek();
      const nextW = next ? measureText(next, { size: 1, font: f.font }) : 0;
      // The largest size (by bisection) at which the row still works; spans widen as letters
      // shrink, because the row's band gets shorter.
      const ok = (r: number) => {
        const widest = Math.max(0, ...rowSpans(cur, r, 0).map(([a, b]) => b - a));
        return r <= widest / 5 && (!nextW || r * nextW <= widest - 2 * r * padK);
      };
      if (!ok(rs)) {
        let lo = f.size * 0.3, hi = f.size;
        for (let it = 0; it < 8; it++) {
          const mid = (lo + hi) / 2;
          if (ok(mid)) lo = mid;
          else hi = mid;
        }
        rs = lo;
      }
    }
    const L = rs * f.leading;
    const base = cur + rs * (1 + padK);
    const g = { ...f, size: rs };
    const spans = rowSpans(cur, rs, rs * 2.2 + 2 * rs * padK);
    cur += L;
    if (spans.length && q.done) rowsLeft++;
    for (const [a, b] of spans) {
      spanTotal += (b - a) * L;
      if (q.done) continue;
      const { words, natural } = fillLine(q, b - a, g);
      if (!words.length) continue;
      inked += natural * L;
      used += (b - a) * L;
      const extra = b - a - natural;
      const last = q.done;
      if (words.length === 1 || last) {
        // A lone word (or the poem's last line): letter-space it a little and centre it.
        const s = words.join(' ');
        const tr = last ? 0 : Math.min(0.25, extra / Math.max(1, s.length - 1) / rs);
        const wdt = measureText(s, { size: rs, font: f.font, tracking: tr });
        out.push(...text(s, { x: a + (b - a - wdt) / 2, y: base, size: rs, font: f.font, tracking: tr }));
        continue;
      }
      // Justify: a touch of letter-spacing, the rest between words.
      const chars = words.reduce((n, w) => n + w.length, 0);
      const space = measureText(' ', { size: rs, font: f.font });
      let tr = Math.min(0.08, (extra * 0.3) / Math.max(1, chars - words.length) / rs);
      // Very loose lines: letter-space more rather than open rivers between words.
      if ((extra * 0.7) / (words.length - 1) > space * 1.5) tr = Math.min(0.25, (extra - (words.length - 1) * space * 1.5) / Math.max(1, chars - words.length) / rs);
      const widths = words.map((w) => measureText(w, { size: rs, font: f.font, tracking: tr }));
      const gap = (b - a - widths.reduce((n, x) => n + x, 0)) / (words.length - 1);
      let x = a;
      words.forEach((w, k) => {
        out.push(...text(w, { x, y: base, size: rs, font: f.font, tracking: tr }));
        x += widths[k] + gap;
      });
    }
  }
  return { paths: out, done: q.done, fill: spanTotal ? inked / spanTotal : 0, cover: used / maskArea(m), rowsLeft };
}

/** Text running round concentric outlines of the shape, outside in. */
function layoutRings(m: MaskGrid, dist: Float32Array, list: string[], f: Layout) {
  const q = new Words(list, f.repeat);
  const out: Polyline[] = [];
  const L = f.size * f.leading;
  let maxD = 0;
  for (const d of dist) maxD = Math.max(maxD, d);
  const levels: number[] = [];
  for (let d = f.size * 1.1 + f.pad; d < maxD - f.size * 0.3; d += L) levels.push(d);
  let total = 0, inked = 0, used = 0, rowsLeft = 0;
  const loops = insetLoops(m, dist, levels, Math.max(1, f.size * 0.8));
  for (const level of loops)
    for (const loop of level.sort((a, b) => a[0][1] - b[0][1])) {
      let len = 0;
      for (let i = 1; i < loop.length; i++) len += Math.hypot(loop[i][0] - loop[i - 1][0], loop[i][1] - loop[i - 1][1]);
      if (len < f.size * 4) continue;
      const room = len - f.size * 1.2; // a gap where the loop closes
      total += room;
      if (q.done) {
        rowsLeft++;
        continue;
      }
      const { words, natural } = fillLine(q, room, f);
      if (!words.length) continue;
      inked += natural;
      used += room;
      const s = words.join(' ');
      const tr = q.done ? 0 : Math.min(0.3, (room - natural) / Math.max(1, s.length - 1) / f.size);
      out.push(...textAlong(s, loop, { size: f.size, font: f.font, tracking: tr, shift: f.size * 0.6 }));
    }
  return { paths: out, done: q.done, fill: total ? inked / total : 0, cover: (used * L) / maskArea(m), rowsLeft };
}

export default defineArtwork({
  slug: 'calligram',
  title: 'Calligram',
  description: 'A poem typeset to fill a shape (a heart, a star, a coastline, a photo silhouette), sized so the words fill it exactly.',
  order: 111,
  series: 'Words and hands',
  paper: { paper: 'square', orientation: 'portrait', margin: 12 },
  params: [
    { type: 'text', key: 'text', label: 'Text', multiline: true, default: POEM, hint: 'Default: Emily Dickinson, "Hope" is the thing with feathers (public domain)' },
    { type: 'select', key: 'shape', label: 'Shape', options: [['heart', 'Heart'], ['circle', 'Circle'], ['star', 'Star'], ['teardrop', 'Teardrop'], ['coast', 'Coastline of a place'], ['photo', 'Photo silhouette']], default: 'heart' },
    { type: 'select', key: 'style', label: 'Style', options: [['rows', 'Rows'], ['rings', 'Concentric outlines']], default: 'rows' },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
    { type: 'select', key: 'fill', label: 'Size', options: [['fit', 'Fit the text to the shape'], ['repeat', 'Fixed size, repeat the text']], default: 'fit' },
    { type: 'number', key: 'size', label: 'Letter size (mm)', min: 1, max: 20, step: 0.1, default: 3, show: (v) => v.fill === 'repeat' },
    { type: 'number', key: 'leading', label: 'Line spacing', min: 1.1, max: 3, step: 0.05, default: 1.55 },
    { type: 'checkbox', key: 'taper', label: 'Smaller letters in narrow parts', default: true, show: (v) => v.style === 'rows', hint: 'Lets the text reach into points, tips and thin necks' },
    { type: 'checkbox', key: 'hyphen', label: 'Hyphenate', default: true, hint: 'Break long words to fill the ends of lines' },
    { type: 'checkbox', key: 'outline', label: 'Faint outline (pen 2)', default: true },
    ...terrainParams({ name: 'Isle of Wight', lat: 50.672, lon: -1.33 }, 10).map((p) => ({ ...p, show: (v: Record<string, any>) => v.shape === 'coast' })),
    ...imageParams().map((p) => ({ ...p, show: (v: Record<string, any>) => v.shape === 'photo' })),
    { type: 'number', key: 'threshold', label: 'Silhouette threshold', min: 0.05, max: 0.95, step: 0.01, default: 0.5, show: (v) => v.shape === 'photo', hint: 'Darker than this counts as inside' },
  ],
  caption: (v) => (v.shape === 'coast' ? v.loc.name : ''),
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    let inside: (x: number, y: number) => boolean;
    if (v.shape === 'coast') {
      const map = await loadTerrainFor(v, ctx);
      inside = (x, y) => !map.isSea(x / W, y / H);
    } else if (v.shape === 'photo') {
      const dark = await loadDarkness(v, W, H, ctx.status);
      inside = (x, y) => dark(x, y) > v.threshold;
    } else {
      const ring = presetRing(v.shape, W, H, 2);
      inside = (x, y) => insideRings([ring], x, y);
    }
    const m = maskFrom(inside, W, H, 0.4);
    if (!m.data.some((x) => x)) throw new Error(v.shape === 'coast' ? 'No land here: move the map or zoom out' : 'The shape is empty: adjust the threshold');

    const words = String(v.text ?? '').split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error('No text to set');
    const rings = v.style === 'rings';
    const dist = rings ? insideDistance(m) : new Float32Array(0);
    const run = (size: number, leading = v.leading) => {
      const f = { size, font: v.font, hyphen: v.hyphen, leading, repeat: v.fill === 'repeat', pad: v.outline ? size * 0.35 : 0, taper: v.taper };
      return rings ? layoutRings(m, dist, words, f) : layoutRows(m, words, f);
    };
    // Biggest letters at which the whole text still fits: bisection, then nudging up while it
    // still fits (fitting isn't perfectly monotonic).
    const fit = (leading: number, iters: number) => {
      let lo = 0.5, hi = Math.min(W, H) / 4, size = lo;
      let best: ReturnType<typeof run> | null = null;
      for (let it = 0; it < iters; it++) {
        const mid = (lo + hi) / 2;
        const r = run(mid, leading);
        if (r.done) [lo, best, size] = [mid, r, mid];
        else hi = mid;
      }
      for (let s = size * 1.005; best && s < size * 1.05; s *= 1.005) {
        const r = run(s, leading);
        if (r.done) [best, size] = [r, s];
      }
      return { res: best ?? run(lo, leading), size, leading };
    };

    let res: ReturnType<typeof run>;
    let size = v.size, leading = v.leading;
    if (v.fill === 'repeat') res = run(size);
    else {
      // The text should end on (or within a row of) the shape's last usable row. If it runs out
      // early, open up the line spacing (refitting the size) rather than stopping short, then
      // stretch the spacing at that size until the text only just fits.
      const base = fit(v.leading, 18);
      let pick = base;
      for (let k = 1.05; pick.res.rowsLeft > 1 && k <= 1.6; k += 0.05) {
        const c = fit(v.leading * k, 14);
        if (c.size >= base.size * 0.85 && c.res.rowsLeft < pick.res.rowsLeft) pick = c;
      }
      if (pick.res.rowsLeft > 1) {
        let lo = pick.leading, hi = pick.leading * 1.6;
        for (let it = 0; it < 12; it++) {
          const mid = (lo + hi) / 2;
          const r = run(pick.size, mid);
          if (r.done) [lo, pick] = [mid, { res: r, size: pick.size, leading: mid }];
          else hi = mid;
        }
      }
      ({ res, size, leading } = pick);
    }
    ctx.status(`${size.toFixed(2)} mm letters, ${leading.toFixed(2)} line spacing · text rows cover ${Math.min(100, res.cover * 100).toFixed(0)}% of the shape, ${res.rowsLeft} empty rows after the end (rows ${(res.fill * 100).toFixed(0)}% full before justifying)`);

    const layers: Layer[] = [{ name: 'Text', color: PALETTE[0], paths: res.paths }];
    if (v.outline) layers.push({ name: 'Outline', color: PALETTE[1], paths: maskOutline(m, 0.8) });
    return layers;
  },
});
