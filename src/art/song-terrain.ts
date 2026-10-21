import { circle, smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import type { Audio } from '../lib/audio';
import { contourLevels, hachures, ridges, type HeightFn } from '../lib/elevation';
import { clipTo } from '../lib/gen-util';
import { FONT_OPTIONS, measureText, text } from '../lib/hershey';
import { loadLyrics, lyricsParams, type LyricLine } from '../lib/lyrics';
import { evenSpans, fitSize, loadSong, shapedSpectrum, songName, songWindow } from '../lib/music-text';
import type { Values } from '../params';
import type { Rng } from '../random';
import { defineArtwork } from './types';

type Rect = [number, number, number, number]; // x0, y0, x1, y1

const rect = ([x0, y0, x1, y1]: Rect): Polyline => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const inRect = ([x0, y0, x1, y1]: Rect, x: number, y: number) => x > x0 && x < x1 && y > y0 && y < y1;

/**
 * The song as a height field over the unit square: u along x, v along y (both 0–1).
 * time-x: time runs west to east, pitch rises to the north; time-y: time runs north to south,
 * pitch rises to the east. Pure, for testing.
 */
export function songField(audio: Audio, v: Values): { h: HeightFn; raw: HeightFn; start: number; end: number } {
  const [start, end] = songWindow(v, audio.duration);
  const nt = Math.max(16, Math.round(v.resolution));
  const nf = 96;
  const rows = shapedSpectrum(audio, evenSpans(start, end, nt), {
    bands: nf, fmin: v.fmin, fmax: v.fmax, range: v.range, tilt: v.tilt, flatten: v.flatten, smooth: 0, contrast: v.contrast,
  });
  // Separable Gaussian blur over (time, frequency) so it reads as landforms, not a spectrogram.
  const grid = new Float32Array(nt * nf);
  rows.forEach((r, i) => grid.set(r, i * nf));
  const blur = (sig: number, along: 't' | 'f') => {
    if (sig <= 0) return;
    const taps = Math.ceil(sig * 2.5);
    const kern = Array.from({ length: taps + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sig * sig)));
    const src = grid.slice();
    for (let i = 0; i < nt; i++)
      for (let k = 0; k < nf; k++) {
        let s = 0, w = 0;
        for (let d = -taps; d <= taps; d++) {
          const ii = along === 't' ? i + d : i, kk = along === 'f' ? k + d : k;
          if (ii < 0 || ii >= nt || kk < 0 || kk >= nf) continue;
          s += src[ii * nf + kk] * kern[Math.abs(d)];
          w += kern[Math.abs(d)];
        }
        grid[i * nf + k] = s / w;
      }
  };
  blur(v.blur * (nt / 100), 't');
  blur(v.blur * (nf / 100), 'f');
  const sorted = Float32Array.from(grid).sort();
  const ref = Math.max(1e-6, sorted[Math.floor(sorted.length * 0.998)]);
  for (let i = 0; i < grid.length; i++) grid[i] = Math.min(1, grid[i] / ref);
  // Sample at (time fraction, frequency fraction 0 = low).
  const at = (tf: number, ff: number) => {
    const x = Math.max(0, Math.min(1, tf)) * (nt - 1), y = Math.max(0, Math.min(1, ff)) * (nf - 1);
    const i = Math.floor(x), k = Math.floor(y), fx = x - i, fy = y - k;
    const i1 = Math.min(nt - 1, i + 1), k1 = Math.min(nf - 1, k + 1);
    return (grid[i * nf + k] * (1 - fx) + grid[i1 * nf + k] * fx) * (1 - fy) + (grid[i * nf + k1] * (1 - fx) + grid[i1 * nf + k1] * fx) * fy;
  };
  const raw: HeightFn = v.axis === 'time-y' ? (u, w) => at(w, u) : (u, w) => at(u, 1 - w);
  const sea = v.sea;
  const h: HeightFn = (u, w) => Math.max(0, (raw(u, w) - sea) / (1 - sea));
  return { h, raw, start, end };
}

/** A nice scale-bar length in seconds for a span of about `target` seconds, and its divisions. */
function niceSeconds(target: number): [number, number] {
  const opts: [number, number][] = [[0.5, 5], [1, 4], [2, 4], [5, 5], [10, 5], [15, 3], [20, 4], [30, 3], [60, 4], [120, 4], [300, 5], [600, 4]];
  let best = opts[0];
  for (const o of opts) if (Math.abs(Math.log(o[0] / target)) < Math.abs(Math.log(best[0] / target))) best = o;
  return best;
}

/** The drawing, from decoded audio and lyrics. Pure, so it can be tested without AudioContext. */
export function songTerrain(audio: Audio, lines: LyricLine[], v: Values, W: number, H: number, title: string, rng: Rng): Layer[] {
  const font = v.font;
  const ink: Polyline[] = [];
  const red: Polyline[] = [];
  const { h, raw, start, end } = songField(audio, v);
  const timeX = v.axis !== 'time-y';

  // --- Layout: frame, a border for the graticule, the map, and the legend underneath ---
  const border = v.frame ? 7 : 0;
  const ls = v.legendSize;
  const shown = v.legend ? lines.filter((l) => l.time >= start && l.time < end) : [];
  const cols = shown.length ? Math.max(1, Math.min(4, Math.floor(W / 70))) : 0;
  const perCol = cols ? Math.ceil(shown.length / cols) : 0;
  const legendH = shown.length ? perCol * ls * 1.8 + ls * 1.2 : 0;
  const map: Rect = [border, border, W - border, H - border - legendH];
  const [mx0, my0, mx1, my1] = map;
  const MW = mx1 - mx0, MH = my1 - my0;
  // Map position of a time and of a frequency.
  const tPos = (t: number) => (t - start) / (end - start);
  const fPos = (f: number) => Math.log(f / v.fmin) / Math.log(v.fmax / v.fmin);
  const timeXY = (t: number): number => (timeX ? mx0 + tPos(t) * MW : my0 + tPos(t) * MH);
  const freqXY = (f: number): number => (timeX ? my1 - fPos(f) * MH : mx0 + fPos(f) * MW);

  // --- Knockouts: the cartouche, scale bar and lyric markers sit on clear paper ---
  const knock: Rect[] = [];
  const furniture: Polyline[] = [];
  // Cartouche.
  const ts = v.titleSize;
  const name = (v.title || title).trim();
  const sub = `${(end - start).toFixed(0)} seconds surveyed · ${Math.round(v.fmin)}–${Math.round(v.fmax)} Hz`;
  const tw = Math.min(MW * 0.6, Math.max(measureText(name, { size: ts, font }), measureText(sub, { size: ts * 0.42, font })) + ts * 2);
  const tSize = fitSize(name, tw - ts * 2, ts, font);
  const th = tSize * 2.6 + ts * 0.42 * 1.2;
  const corner = v.cartouche as string;
  const cx0 = corner.endsWith('l') ? mx0 + 5 : mx1 - 5 - tw;
  const cy0 = corner.startsWith('t') ? my0 + 5 : my1 - 5 - th;
  const cart: Rect = [cx0, cy0, cx0 + tw, cy0 + th];
  knock.push([cx0 - 2, cy0 - 2, cx0 + tw + 2, cy0 + th + 2]);
  red.push(rect(cart), rect([cx0 + 1, cy0 + 1, cx0 + tw - 1, cy0 + th - 1]));
  red.push(...text(name, { x: cx0 + tw / 2, y: cy0 + tSize * 1.5, size: tSize, font, align: 'center' }));
  const subSize = fitSize(sub, tw - 4, ts * 0.42, font);
  red.push(...text(sub, { x: cx0 + tw / 2, y: cy0 + th - tSize * 0.55, size: subSize, font, align: 'center' }));

  // Scale bar along the time axis, in the corner diagonally opposite the cartouche.
  if (v.scaleBar) {
    const axisLen = timeX ? MW : MH;
    const secPerMm = (end - start) / axisLen;
    const [len, divs] = niceSeconds(axisLen * 0.22 * secPerMm);
    const L = len / secPerMm, bh = 1.6, lab = 2.2;
    // Local frame: along = time axis, across = perpendicular. Bottom-right for time-x, mirrored otherwise.
    const right = !corner.endsWith('r');
    const bottom = !corner.startsWith('b');
    let bx: number, by: number;
    const local: Polyline[] = [];
    // Bar in local coordinates (0..L along, 0..bh across), labels underneath.
    local.push(rect([0, 0, L, bh]));
    for (let d = 1; d < divs; d++) local.push([[(L * d) / divs, 0], [(L * d) / divs, bh]]);
    for (let d = 0; d < divs; d += 2)
      for (let k = 1; k <= 3; k++) local.push([[(L * d) / divs, (bh * k) / 4], [(L * (d + 1)) / divs, (bh * k) / 4]]);
    const labels: Polyline[] = [];
    const fmt = (s: number) => (Math.abs(s - Math.round(s)) < 1e-6 ? String(Math.round(s)) : s.toFixed(1));
    labels.push(...text('0', { x: 0, y: bh + lab * 1.5, size: lab, font, align: 'center' }));
    labels.push(...text(fmt(len / 2), { x: L / 2, y: bh + lab * 1.5, size: lab, font, align: 'center' }));
    labels.push(...text(`${fmt(len)} s`, { x: L, y: bh + lab * 1.5, size: lab, font, align: 'left' }));
    labels.push(...text('SECONDS', { x: L / 2, y: -lab * 0.7, size: lab * 0.8, font, align: 'center', tracking: 0.3 }));
    const extentAcross = bh + lab * 1.5 + 1;
    let place: (p: Pt) => Pt;
    if (timeX) {
      bx = right ? mx1 - 6 - L - measureText(' s', { size: lab, font }) : mx0 + 6;
      by = bottom ? my1 - 5 - extentAcross : my0 + 5 + lab * 1.6;
      place = ([a, c]) => [bx + a, by + c];
      knock.push([bx - 3, by - lab * 1.6 - 1, bx + L + 6, by + extentAcross + 1]);
    } else {
      // Time runs down the page: bar vertical, lettering still upright beside it.
      bx = right ? mx1 - 6 - extentAcross : mx0 + 6;
      by = bottom ? my1 - 6 - L : my0 + 6;
      place = ([a, c]) => [bx + c, by + a];
      local.length = 0;
      local.push(rect([0, 0, L, bh]));
      for (let d = 1; d < divs; d++) local.push([[(L * d) / divs, 0], [(L * d) / divs, bh]]);
      for (let d = 0; d < divs; d += 2)
        for (let k = 1; k <= 3; k++) local.push([[(L * d) / divs, (bh * k) / 4], [(L * (d + 1)) / divs, (bh * k) / 4]]);
      labels.length = 0;
      labels.push(...text('0', { x: bx + bh + 1.2, y: by + lab / 2, size: lab, font }));
      labels.push(...text(fmt(len / 2), { x: bx + bh + 1.2, y: by + L / 2 + lab / 2, size: lab, font }));
      labels.push(...text(`${fmt(len)} s`, { x: bx + bh + 1.2, y: by + L + lab / 2, size: lab, font }));
      knock.push([bx - 2, by - 3, bx + bh + 2 + measureText(`${fmt(len)} s`, { size: lab, font }) + 2, by + L + 3]);
      furniture.push(...local.map((p) => p.map(place)), ...labels);
    }
    if (timeX) furniture.push(...local.map((p) => p.map(place)), ...labels.map((p) => p.map(place)));
    // A "north" arrow that points to the treble.
    const ax = timeX ? (right ? mx1 - 10 : mx0 + 10) : bx + (right ? -8 : extentAcross + 8);
    const ay = timeX ? (bottom ? by - 16 : by + extentAcross + 16) : by + L / 2;
    const dirx = timeX ? 0 : 1, diry = timeX ? -1 : 0; // towards higher pitch
    const A = 5;
    const tip: Pt = [ax + dirx * A, ay + diry * A];
    const tail: Pt = [ax - dirx * A, ay - diry * A];
    const px = -diry, py = dirx;
    furniture.push([tail, tip], [[tip[0] - dirx * 2 + px * 1.3, tip[1] - diry * 2 + py * 1.3], tip, [tip[0] - dirx * 2 - px * 1.3, tip[1] - diry * 2 - py * 1.3]]);
    furniture.push(...text('Hz', { x: tip[0] + dirx * 3.2, y: tip[1] + diry * 1.6 + (timeX ? 0 : 0.9), size: 2, font, align: timeX ? 'center' : 'left' }));
    knock.push([ax - 6, ay - 8, ax + 9, ay + 8]);
  }

  // Lyric markers: circled numbers along the time axis, keyed to the legend.
  shown.forEach((l, i) => {
    const r = Math.max(1.8, ls * 0.75);
    const p = timeXY(l.time);
    const c: Pt = timeX ? [p, my1 - r - 1.5] : [mx0 + r + 1.5, p];
    red.push(circle(c[0], c[1], r, 28));
    red.push(...text(String(i + 1), { x: c[0], y: c[1] + r * 0.45, size: r * 0.9, font, align: 'center' }));
    // A short tick from the marker to the map edge.
    red.push(timeX ? [[p, my1], [p, my1 - 1.5]] : [[mx0, p], [mx0 + 1.5, p]]);
    knock.push([c[0] - r - 0.8, c[1] - r - 0.8, c[0] + r + 0.8, c[1] + r + 0.8]);
  });

  // --- Terrain ---
  const local = (u: number, w: number) => h(u, w);
  let terrain: Polyline[] = [];
  if (v.style === 'contours') {
    const n = v.levels;
    const levels = Array.from({ length: n }, (_, k) => (k + 1) / (n + 1));
    terrain = contourLevels(local, MW, MH, levels, v.cell).flatMap((ls2) => ls2.map((l) => smooth(l, v.curves)));
  } else if (v.style === 'hachures') {
    terrain = hachures(local, MW, MH, { spacing: v.hachureSpacing, spacingGentle: v.hachureSpacing * 2.2, minSlope: 0.08, maxLength: 8, light: { strength: 0.6, azimuth: 315 } }, rng);
    // A coastline (and index contour) frames the hachured ground.
    terrain.push(...contourLevels(local, MW, MH, [0.02], v.cell)[0].map((l) => smooth(l, v.curves)));
  } else {
    terrain = ridges((u, w) => raw(u, w) ** 1.5, MW, MH, { rows: v.ridgeRows, height: v.ridgeHeight });
  }
  if (v.waterlines && v.style !== 'ridges' && v.sea > 0) {
    // Water lining: ripples offshore, parallel to the coast, like engraved maps.
    const lv = [0.8, 0.6, 0.4].map((f) => v.sea * f);
    terrain.push(...contourLevels(raw, MW, MH, lv, v.cell).flatMap((ls2, k) => ls2.map((l) => smooth(l, v.curves * (1 + k)))));
  }
  terrain = terrain.map((p) => p.map(([x, y]) => [x + mx0, y + my0] as Pt));
  terrain = clipTo(terrain, (x, y) => inRect(map, x, y) && !knock.some((r) => inRect(r, x, y)), 0.4);
  ink.push(...terrain);

  // --- Frame and graticule (time and frequency ticks in the border) ---
  if (v.frame) {
    furniture.push(rect([0, 0, W, H]), rect(map));
    const gs = 1.8;
    const [secs] = niceSeconds((end - start) / 6);
    for (let t = Math.ceil(start / secs) * secs; t <= end + 1e-6; t += secs) {
      const p = timeXY(t);
      const label = `${Math.round(t * 10) / 10}s`;
      if (timeX) {
        furniture.push([[p, my0], [p, my0 - 1.5]], [[p, my1], [p, my1 + 1.5]]);
        furniture.push(...text(label, { x: p, y: my0 - 2.2, size: gs, font, align: 'center' }));
      } else {
        furniture.push([[mx0, p], [mx0 - 1.5, p]], [[mx1, p], [mx1 + 1.5, p]]);
        furniture.push(...text(label, { x: mx0 - 2, y: p + gs / 2, size: gs * 0.85, font, align: 'right' }));
      }
    }
    for (let f = 100; f <= v.fmax; f *= 2) {
      if (f < v.fmin) continue;
      const p = freqXY(f);
      const label = f >= 1000 ? `${+(f / 1000).toFixed(1)}k` : String(f);
      if (timeX) {
        furniture.push([[mx0, p], [mx0 - 1.5, p]], [[mx1, p], [mx1 + 1.5, p]]);
        furniture.push(...text(label, { x: mx0 - 2, y: p + gs / 2, size: gs * 0.85, font, align: 'right' }));
      } else {
        furniture.push([[p, my0], [p, my0 - 1.5]], [[p, my1], [p, my1 + 1.5]]);
        furniture.push(...text(label, { x: p, y: my0 - 2.2, size: gs, font, align: 'center' }));
      }
    }
  }

  // --- Legend: the numbered lyric lines ---
  if (shown.length) {
    const ly0 = H - legendH + ls * 1.6 + (v.frame ? 0 : 0);
    const colW = (W - 2 * (border + 3)) / cols;
    shown.forEach((l, i) => {
      const c = Math.floor(i / perCol), r = i % perCol;
      const x = border + 3 + c * colW;
      const y = ly0 + r * ls * 1.8;
      const num = `${i + 1}`;
      red.push(...text(num, { x: x + ls * 0.9, y, size: ls * 0.9, font, align: 'right' }));
      const str = l.text.trim();
      ink.push(...text(str, { x: x + ls * 1.6, y, size: fitSize(str, colW - ls * 4, ls, font), font }));
    });
  }

  ink.push(...furniture);
  return [
    { name: 'Map', color: PALETTE[0], paths: ink },
    { name: 'Lettering', color: PALETTE[1], paths: red },
  ];
}

export default defineArtwork({
  slug: 'song-terrain',
  title: 'The song as a mountain range',
  description: 'A song surveyed as a landscape: time runs east, pitch north, and loudness rises into hills, drawn as a map with a cartouche and a scale bar in seconds.',
  order: 73,
  series: 'Music',
  paper: { paper: 'a4', orientation: 'landscape', margin: 15 },
  mainThread: true,
  params: [
    { type: 'file', key: 'audio', label: 'Audio', accept: 'audio/*', default: [], hint: 'Without one, a public-domain demo song is used.' },
    { type: 'select', key: 'style', label: 'Style', options: [['contours', 'Contours'], ['hachures', 'Hachures'], ['ridges', 'Ridgelines']], default: 'contours' },
    { type: 'select', key: 'axis', label: 'Orientation', options: [['time-x', 'Time east, pitch north'], ['time-y', 'Time south, pitch east']], default: 'time-x' },
    { type: 'number', key: 'levels', label: 'Contour levels', min: 3, max: 60, step: 1, default: 10, show: (v) => v.style === 'contours' },
    { type: 'number', key: 'curves', label: 'Curves (mm)', min: 0, max: 6, step: 0.1, default: 1.5, show: (v) => v.style !== 'ridges' },
    { type: 'number', key: 'cell', label: 'Resolution (mm)', min: 0.3, max: 3, step: 0.1, default: 0.7, show: (v) => v.style !== 'ridges' },
    { type: 'number', key: 'hachureSpacing', label: 'Hachure spacing (mm)', min: 0.5, max: 4, step: 0.1, default: 1.5, show: (v) => v.style === 'hachures' },
    { type: 'number', key: 'ridgeRows', label: 'Ridge rows', min: 10, max: 200, step: 1, default: 70, show: (v) => v.style === 'ridges' },
    { type: 'number', key: 'ridgeHeight', label: 'Ridge height (mm)', min: 2, max: 40, step: 0.5, default: 10, show: (v) => v.style === 'ridges' },
    { type: 'number', key: 'sea', label: 'Sea level', min: 0, max: 0.6, step: 0.01, default: 0.12, hint: 'Quieter ground is under water' },
    { type: 'checkbox', key: 'waterlines', label: 'Water lining offshore', default: true, show: (v) => v.style !== 'ridges' },
    { type: 'number', key: 'blur', label: 'Erosion', min: 0, max: 10, step: 0.1, default: 2.6, hint: 'Blurs the spectrogram into rounder landforms' },
    { type: 'number', key: 'resolution', label: 'Time slices', min: 30, max: 600, step: 10, default: 220 },
    { type: 'checkbox', key: 'frame', label: 'Frame & graticule', default: true },
    { type: 'checkbox', key: 'scaleBar', label: 'Scale bar & pitch arrow', default: true },
    { type: 'text', key: 'title', label: 'Title', default: '', placeholder: 'Blank = the song’s name' },
    { type: 'select', key: 'cartouche', label: 'Cartouche', options: [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']], default: 'tl' },
    { type: 'number', key: 'titleSize', label: 'Title size (mm)', min: 2, max: 14, step: 0.1, default: 6 },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'timesr' },
    ...lyricsParams(),
    { type: 'checkbox', key: 'legend', label: 'Lyrics legend', default: true, hint: 'Numbered markers along the time axis', show: (v) => v.lyricsSource !== 'none' },
    { type: 'number', key: 'legendSize', label: 'Legend text (mm)', min: 1.2, max: 5, step: 0.1, default: 2.4, show: (v) => v.legend },
    { type: 'number', key: 'start', label: 'Start (s)', min: 0, max: 600, step: 0.5, default: 0 },
    { type: 'number', key: 'end', label: 'End (s)', min: 0, max: 600, step: 0.5, default: 0, hint: '0 = end of the track' },
    { type: 'number', key: 'fmin', label: 'Low frequency (Hz)', min: 20, max: 1000, step: 1, default: 80 },
    { type: 'number', key: 'fmax', label: 'High frequency (Hz)', min: 500, max: 20000, step: 50, default: 3000 },
    { type: 'number', key: 'range', label: 'Dynamic range (dB)', min: 20, max: 100, step: 1, default: 50 },
    { type: 'number', key: 'tilt', label: 'Treble boost (dB/oct)', min: 0, max: 12, step: 0.5, default: 4 },
    { type: 'number', key: 'flatten', label: 'Flatten tilt', min: 0, max: 1, step: 0.05, default: 0.5 },
    { type: 'number', key: 'contrast', label: 'Contrast', min: 0.5, max: 4, step: 0.05, default: 1.6 },
    { type: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  caption: (v) => songName(v),
  async generate(v, ctx) {
    const audio = await loadSong(v, ctx.status);
    const lines = v.legend ? await loadLyrics(v, audio.duration, ctx.status) : [];
    return songTerrain(audio, lines, v, ctx.width, ctx.height, songName(v), ctx.rng);
  },
});
