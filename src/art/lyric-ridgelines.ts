import { resample, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import type { Audio } from '../lib/audio';
import { FONT_OPTIONS, textAlong } from '../lib/hershey';
import { loadLyrics, lyricsParams, type LyricLine } from '../lib/lyrics';
import { evenSpans, fitSize, loadSong, shapedSpectrum, songName, songWindow } from '../lib/music-text';
import type { Values } from '../params';
import { defineArtwork } from './types';

const BIN = 0.2;

/** Which ridge row each lyric line is lettered on, and each row's time span. Pure, for testing. */
export function lyricRows(lines: LyricLine[], v: Values, duration: number): { spans: [number, number][]; rowOf: Map<number, number> } {
  const [start, end] = songWindow(v, duration);
  const rowOf = new Map<number, number>(); // row -> lyric line index
  const inside = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.time >= start && l.time < end);
  if (v.rowMode === 'perline' && inside.length) {
    const k = Math.max(1, Math.round(v.rowsPerLine));
    const spans: [number, number][] = [];
    // Rows for any intro before the first line, at the same pace as the first line.
    const first = inside[0].l;
    const firstEnd = Math.min(end, first.end ?? end);
    const per = (firstEnd - first.time) / k;
    const intro = per > 0 ? Math.floor((first.time - start) / per) : 0;
    spans.push(...evenSpans(first.time - intro * per, first.time, intro));
    inside.forEach(({ l, i }, n) => {
      const e = Math.min(end, inside[n + 1]?.l.time ?? l.end ?? end);
      rowOf.set(spans.length, i);
      spans.push(...evenSpans(l.time, Math.max(l.time + 0.05, e), k));
    });
    return { spans, rowOf };
  }
  const N = Math.max(2, Math.round(v.rows));
  const dt = (end - start) / N;
  for (const { l, i } of inside) {
    let r = Math.min(N - 1, Math.floor((l.time - start) / dt));
    while (rowOf.has(r) && r < N - 1) r++;
    if (!rowOf.has(r)) rowOf.set(r, i);
  }
  return { spans: evenSpans(start, end, N), rowOf };
}

/** Splits paths into the parts that are above (y less than) the horizon `hor`, sampled every BIN mm. */
function clipUnder(paths: Polyline[], hor: Float64Array, pad: number): Polyline[] {
  const nb = hor.length;
  const horAt = (x: number) => {
    const f = x / BIN;
    const j = Math.floor(f);
    if (j < 0 || j >= nb - 1) return j === nb - 1 ? hor[j] : Infinity;
    const a = hor[j], b = hor[j + 1];
    if (!isFinite(a) || !isFinite(b)) return Math.min(a, b);
    return a + (b - a) * (f - j);
  };
  const out: Polyline[] = [];
  for (const p of paths) {
    let cur: Polyline | null = null;
    for (const q of resample(p, 0.12)) {
      if (q[1] < horAt(q[0]) - pad) {
        if (!cur) out.push((cur = []));
        cur.push(q);
      } else cur = null;
    }
  }
  return out.filter((q) => q.length > 1);
}

/** The drawing, from decoded audio and lyrics. Pure, so it can be tested without AudioContext. */
export function lyricRidgelines(audio: Audio, lines: LyricLine[], v: Values, W: number, H: number): Layer[] {
  const { spans, rowOf } = lyricRows(lines, v, audio.duration);
  const bands = 160;
  const rows = shapedSpectrum(audio, spans, {
    bands, fmin: v.fmin, fmax: v.fmax, range: v.range, tilt: v.tilt, flatten: v.flatten, smooth: v.smooth, contrast: v.contrast,
  });
  const N = rows.length;
  const pw = W * v.width;
  const margin = v.placement === 'margin';
  const x0 = margin ? W - pw : (W - pw) / 2;
  const E = v.height;
  const p = v.perspective;
  const taper = (u: number) => (v.taper > 0 ? Math.pow(Math.sin(Math.PI * u), v.taper) : 1);
  const h = (u: number, i: number) => {
    const r = rows[i];
    const x = u * (bands - 1);
    const k = Math.floor(x), f = x - k;
    return (r[k] * (1 - f) + (r[Math.min(bands - 1, k + 1)] ?? 0) * f) * taper(u);
  };

  const nb = Math.floor(W / BIN) + 1;
  const xs = Array.from({ length: nb }, (_, j) => Math.min(W, j * BIN));
  const horizon = new Float64Array(nb).fill(Infinity);
  const ridgesOut: Polyline[] = [];
  const textOut: Polyline[] = [];
  const font = v.font;

  for (let i = N - 1; i >= 0; i--) {
    const t = N === 1 ? 0.5 : i / (N - 1); // 0 = back (earliest), 1 = front (latest)
    const scale = 1 - p * (1 - t) * 0.6;
    const base = E + Math.pow(t, 1 + p) * (H - E);
    const half = (pw * scale) / 2;
    const cx = x0 + pw / 2;
    const ys = new Float64Array(nb).fill(NaN);
    for (let j = 0; j < nb; j++) {
      const u = (xs[j] - cx) / (2 * half) + 0.5;
      if (u < 0 || u > 1) continue;
      ys[j] = base - h(u, i) * E * scale;
    }

    // Lettering for this row: clipped by the rows in front, and occluding the rows behind.
    const occ = horizon.slice(); // what hides this row's own ridge
    const band = new Float64Array(nb).fill(Infinity); // what the text hides behind it
    const li = rowOf.get(i);
    if (li !== undefined) {
      const str = lines[li].text.trim();
      const size0 = v.textSize * (0.6 + 0.4 * scale);
      let glyphs: Polyline[] = [];
      let top: Polyline = [];
      if (margin) {
        const avail = x0 - 4;
        const size = fitSize(str, avail, size0, font);
        const path: Polyline = [[0, base - 0.2], [x0 - 3, base - 0.2]];
        glyphs = textAlong(str, path, { size, font, align: 'end' });
      } else {
        const j0 = Math.ceil((cx - half) / BIN), j1 = Math.floor((cx + half) / BIN);
        let path: Polyline;
        let size: number;
        let off: number;
        if (v.placement === 'above') {
          // Float above the ridge's silhouette: a smooth curve that drapes over the peaks
          // (repeatedly blurred and pushed back above the hull), so glyphs only tilt gently.
          size = size0;
          const step = 0.5;
          const hull: number[] = [];
          const R = Math.max(1, Math.round((size * 0.8) / BIN));
          for (let x = xs[j0]; x <= xs[j1] + 1e-6; x += step) {
            const j = Math.round(x / BIN);
            let m = Infinity;
            for (let d = -R; d <= R; d++) {
              const y = ys[j + d];
              if (y === y && y < m) m = y;
            }
            hull.push(m);
          }
          const n = hull.length;
          const sig = Math.max(1, v.drape / step);
          const taps = Math.ceil(sig * 2);
          const kern = Array.from({ length: taps + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sig * sig)));
          let e = hull.slice();
          for (let it = 0; it < 12; it++) {
            const b = new Array<number>(n);
            for (let q = 0; q < n; q++) {
              let s = 0, w = 0;
              for (let d = -taps; d <= taps; d++) {
                const r = Math.max(0, Math.min(n - 1, q + d));
                s += e[r] * kern[Math.abs(d)];
                w += kern[Math.abs(d)];
              }
              b[q] = s / w;
            }
            e = it < 11 ? b.map((y, q) => Math.min(y, hull[q])) : b;
          }
          let lift = 0;
          for (let q = 0; q < n; q++) lift = Math.max(lift, e[q] - hull[q]);
          path = e.map((y, q) => [xs[j0] + q * step, y - lift] as Pt);
          off = v.gap + size * 0.35; // clear descenders
        } else {
          size = size0;
          path = [[xs[j0], base], [xs[j1], base]];
          off = v.gap;
        }
        let len = 0;
        for (let k = 1; k < path.length; k++) len += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
        size = fitSize(str, len * 0.94, size, font);
        if (v.placement === 'above') off = v.gap + size * 0.35;
        glyphs = textAlong(str, path, { size, font, align: v.align, offset: off });
        // The band the text occupies, from just under its baseline to above its caps.
        const xsG = glyphs.flat().map((q) => q[0]);
        const gx0 = Math.min(...xsG) - size * 0.3, gx1 = Math.max(...xsG) + size * 0.3;
        for (const [x, y] of resample(path, BIN)) if (x >= gx0 && x <= gx1) top.push([x, y - off - size * 1.25]);
      }
      textOut.push(...clipUnder(glyphs, horizon, 0.3));
      for (const [x, y] of top) {
        const j = Math.round(x / BIN);
        if (j >= 0 && j < nb) band[j] = Math.min(band[j], y);
      }
      // Fill gaps in the band from coarse sampling.
      for (let j = 1; j < nb - 1; j++) if (!isFinite(band[j]) && isFinite(band[j - 1]) && isFinite(band[j + 1])) band[j] = Math.max(band[j - 1], band[j + 1]);
      if (v.placement === 'baseline') for (let j = 0; j < nb; j++) occ[j] = Math.min(occ[j], band[j]);
    }

    // The row's ridge with hidden-line removal against `occ`.
    let cur: Polyline | null = null;
    for (let j = 0; j < nb; j++) {
      if (isNaN(ys[j])) {
        cur = null;
        continue;
      }
      const d1 = ys[j] - occ[j];
      const visible = d1 < 0;
      if (j > 0 && !isNaN(ys[j - 1])) {
        const d0 = ys[j - 1] - occ[j - 1];
        if (d0 < 0 !== visible && isFinite(d0) && isFinite(d1)) {
          const tt = d0 / (d0 - d1);
          const q: Pt = [xs[j - 1] + (xs[j] - xs[j - 1]) * tt, ys[j - 1] + (ys[j] - ys[j - 1]) * tt];
          if (cur) {
            cur.push(q);
            cur = null;
          } else ridgesOut.push((cur = [q]));
        }
      }
      if (visible) {
        if (!cur) ridgesOut.push((cur = []));
        cur.push([xs[j], ys[j]]);
      } else cur = null;
    }
    for (let j = 0; j < nb; j++) {
      if (!isNaN(ys[j])) horizon[j] = Math.min(horizon[j], ys[j]);
      horizon[j] = Math.min(horizon[j], band[j]);
    }
  }
  return [
    { name: 'Ridges', color: PALETTE[0], paths: ridgesOut.filter((q) => q.length > 1) },
    { name: 'Lyrics', color: PALETTE[1], paths: textOut },
  ];
}

export default defineArtwork({
  slug: 'lyric-ridgelines',
  title: 'Lyric ridgelines',
  description: 'A song as stacked spectra, each lyric lettered along the ridge of the moment it’s sung, hidden where nearer ridges rise in front.',
  order: 70,
  series: 'Music',
  paper: { paper: 'square', margin: 22 },
  mainThread: true,
  params: [
    { type: 'file', key: 'audio', label: 'Audio', accept: 'audio/*', default: [], hint: 'Any audio the browser can decode. Without one, a public-domain demo song is used.' },
    ...lyricsParams(),
    { type: 'select', key: 'placement', label: 'Lyrics placement', options: [['above', 'Floating above the ridge'], ['baseline', 'On the row’s baseline'], ['margin', 'In the left margin']], default: 'above' },
    { type: 'number', key: 'textSize', label: 'Text size (mm)', min: 1, max: 10, step: 0.1, default: 3.2, hint: 'Long lines shrink to fit' },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
    { type: 'select', key: 'align', label: 'Align on ridge', options: [['start', 'Left'], ['center', 'Centre'], ['end', 'Right']], default: 'center', show: (v) => v.placement !== 'margin' },
    { type: 'number', key: 'gap', label: 'Gap above ridge (mm)', min: 0, max: 5, step: 0.1, default: 0.8, show: (v) => v.placement !== 'margin' },
    { type: 'number', key: 'drape', label: 'Text curve softness (mm)', min: 1, max: 40, step: 0.5, default: 10, show: (v) => v.placement === 'above', hint: 'Higher = flatter lettering arching over the peaks' },
    { type: 'select', key: 'rowMode', label: 'Rows', options: [['fixed', 'Fixed count (lyrics on the row they start)'], ['perline', 'Per lyric line']], default: 'fixed' },
    { type: 'number', key: 'rows', label: 'Row count', min: 10, max: 200, step: 1, default: 70, show: (v) => v.rowMode === 'fixed' },
    { type: 'number', key: 'rowsPerLine', label: 'Rows per line', min: 1, max: 30, step: 1, default: 10, show: (v) => v.rowMode === 'perline', hint: 'The first row of each line carries its words' },
    { type: 'number', key: 'height', label: 'Peak height (mm)', min: 2, max: 60, step: 0.5, default: 20 },
    { type: 'number', key: 'width', label: 'Width', min: 0.3, max: 1, step: 0.01, default: 0.7, hint: 'Fraction of the drawing area' },
    { type: 'number', key: 'start', label: 'Start (s)', min: 0, max: 600, step: 0.5, default: 0 },
    { type: 'number', key: 'end', label: 'End (s)', min: 0, max: 600, step: 0.5, default: 0, hint: '0 = end of the track' },
    { type: 'number', key: 'fmin', label: 'Low frequency (Hz)', min: 20, max: 1000, step: 1, default: 80 },
    { type: 'number', key: 'fmax', label: 'High frequency (Hz)', min: 500, max: 20000, step: 50, default: 2500 },
    { type: 'number', key: 'smooth', label: 'Smoothing', min: 0, max: 10, step: 0.1, default: 2.5, hint: 'Blur across frequency bands' },
    { type: 'number', key: 'range', label: 'Dynamic range (dB)', min: 20, max: 100, step: 1, default: 50 },
    { type: 'number', key: 'tilt', label: 'Treble boost (dB/oct)', min: 0, max: 12, step: 0.5, default: 4 },
    { type: 'number', key: 'flatten', label: 'Flatten tilt', min: 0, max: 1, step: 0.05, default: 0.7 },
    { type: 'number', key: 'contrast', label: 'Contrast', min: 0.5, max: 4, step: 0.05, default: 2.5 },
    { type: 'number', key: 'taper', label: 'Taper edges', min: 0, max: 4, step: 0.1, default: 1.2 },
    { type: 'number', key: 'perspective', label: 'Perspective', min: 0, max: 1, step: 0.01, default: 0 },
  ],
  caption: (v) => songName(v),
  async generate(v, ctx) {
    const audio = await loadSong(v, ctx.status);
    const lines = await loadLyrics(v, audio.duration, ctx.status);
    return lyricRidgelines(audio, lines, v, ctx.width, ctx.height);
  },
});
