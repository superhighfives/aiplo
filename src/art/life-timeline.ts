import type { Polyline, Pt } from '../geom';
import { circle } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { clipTo } from '../lib/gen-util';
import { FONT_OPTIONS, measureText, text, textAlong } from '../lib/hershey';
import { defineArtwork } from './types';

// A fictional life (Ruth Quill, from the family tree piece).
const EVENTS = `1960-09-05 First day of school
1966-07-30 Saw the sea at Kynance
1973-10-01 Left for art school
1977-06-18 Moved to Lisbon
1979-04-11 Met Daniel
1981-08-23 Sam born
1986 Opened the print shop
1993-02-14 Married Daniel
1999-12-31 Fireworks from the roof
2004-05 Walked the Camino
2011-09-09 First grandchild
2015-03-02 Sixty, in Porto
2020-03-23 Learned the cello
2024-06-01 Retired`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Fractional calendar year of a UTC date: 1977.5 is about 2 July 1977. */
function yearFrac(y: number, m = 0, d = 1): number {
  const t = Date.UTC(y, m, d), a = Date.UTC(y, 0, 1), b = Date.UTC(y + 1, 0, 1);
  return y + (t - a) / (b - a);
}

/** 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY' → fractional year (month → its middle, year → 1 July). */
function parseDate(s: string): number | null {
  const m = s.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/);
  if (!m) return null;
  const y = Number(m[1]);
  if (!m[2]) return yearFrac(y, 6, 1);
  if (!m[3]) return yearFrac(y, Number(m[2]) - 1, 15);
  return yearFrac(y, Number(m[2]) - 1, Number(m[3]));
}

export interface LifeEvent {
  t: number;
  label: string;
  year: number;
}

export function parseEvents(src: string): LifeEvent[] {
  const out: LifeEvent[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^(\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?)\s+(.*)$/);
    if (!m) continue;
    const t = parseDate(m[1]);
    if (t !== null) out.push({ t, label: m[2].trim(), year: Math.floor(t) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Where a moment sits on the spiral: one loop per calendar year, 1 January at the top, turning
 * clockwise; `k` is the radius (or the square's half-side) at that moment.
 */
function placer(style: string, cx: number, cy: number, r0: number, pitch: number, t0: number) {
  const k = (t: number) => r0 + pitch * (t - t0);
  if (style === 'squares') {
    // Uniform speed round a square: eight half-sides starting at the top centre.
    return (t: number): Pt => {
      const h = k(t);
      const s = (((t % 1) + 1) % 1) * 8;
      if (s < 1) return [cx + h * s, cy - h];
      if (s < 3) return [cx + h, cy - h + h * (s - 1)];
      if (s < 5) return [cx + h - h * (s - 3), cy + h];
      if (s < 7) return [cx - h, cy + h - h * (s - 5)];
      return [cx - h + h * (s - 7), cy - h];
    };
  }
  return (t: number): Pt => {
    const a = -Math.PI / 2 + 2 * Math.PI * (t % 1);
    return [cx + k(t) * Math.cos(a), cy + k(t) * Math.sin(a)];
  };
}

export default defineArtwork({
  slug: 'life-timeline',
  title: 'Life timeline',
  description: 'A lifetime as one spiralling line, a loop per year, with decades on a second pen and life events marked and labelled.',
  order: 113,
  series: 'Words and hands',
  paper: { paper: 'a4', orientation: 'landscape', margin: 12 },
  params: [
    { type: 'text', key: 'who', label: 'Name', default: 'Ruth Quill', placeholder: 'Shown in the centre (optional)' },
    { type: 'date', key: 'birth', label: 'Born', default: '1955-03-02' },
    { type: 'checkbox', key: 'today', label: 'Up to today', default: true },
    { type: 'date', key: 'end', label: 'Until', default: '2026-01-01', show: (v) => !v.today },
    { type: 'text', key: 'events', label: 'Events', multiline: true, default: EVENTS, hint: 'One per line: "YYYY-MM-DD Label", "YYYY-MM Label" or "YYYY Label"' },
    { type: 'select', key: 'style', label: 'Spiral', options: [['archimedean', 'Archimedean'], ['squares', 'Spiral of squares']], default: 'archimedean' },
    { type: 'checkbox', key: 'months', label: 'Month ticks', default: true },
    { type: 'checkbox', key: 'decades', label: 'Decades on pen 2', default: true },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
    { type: 'number', key: 'size', label: 'Label size (mm)', min: 1, max: 6, step: 0.1, default: 2.4 },
  ],
  caption: (v) => v.who ?? '',
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const t0 = parseDate(v.birth);
    if (t0 === null) throw new Error('Set a birth date');
    let t1: number;
    if (v.today) {
      const d = new Date();
      t1 = yearFrac(d.getFullYear(), d.getMonth(), d.getDate());
    } else t1 = parseDate(v.end) ?? t0 + 1;
    if (t1 <= t0) throw new Error('The end date must be after the birth date');
    const events = parseEvents(String(v.events ?? '')).filter((e) => e.t >= t0 && e.t <= t1);
    const font = v.font;

    // Geometry: the spiral leaves room either side for a column of labels.
    const leftText = (e: LifeEvent) => `${e.label}  ${e.year}`;
    const rightText = (e: LifeEvent) => `${e.year}  ${e.label}`;
    // Labels shrink (to no less than 1.4 mm) if the longest would take more than 22% of the width.
    const widest = Math.max(1, ...events.map((e) => measureText(rightText(e), { size: 1, font })));
    const size = Math.max(Math.min(1.4, v.size), Math.min(v.size, (W * 0.22) / widest));
    const colW = Math.max(15, widest * size);
    const cx = W / 2, cy = H / 2;
    const square = v.style === 'squares';
    const Rmax = Math.min(H / 2 - 2, W / 2 - colW - 10);
    const title = String(v.who ?? '').trim();
    const titleSize = Math.max(1.6, size * 1.1);
    const r0 = Math.max(8, title ? measureText(title, { size: titleSize, font }) / 2 + 3 : 8) * (square ? 0.85 : 1);
    if (Rmax <= r0 + 5) throw new Error('Not enough room: use bigger paper or a smaller label size');
    const pitch = (Rmax - r0) / (t1 - t0);
    const at = placer(v.style, cx, cy, r0, pitch, t0);
    ctx.status(`${(t1 - t0).toFixed(1)} years · ${pitch.toFixed(2)} mm between loops`);

    // Unit normal at t (pointing outward), for month ticks.
    const normal = (t: number): Pt => {
      const a = at(t - 1e-4), b = at(t + 1e-4);
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [dy / l, -dx / l];
    };

    // The line, month by month, with ticks drawn inline (no pen lifts). Decade years go to pen 2.
    const ink: Polyline[] = [];
    const red: Polyline[] = [];
    let cur: Polyline = [];
    let curRed = false;
    const tick = pitch * 0.25;
    for (let y = Math.floor(t0); y < t1; y++) {
      const isRed = v.decades && y % 10 === 0;
      if (isRed !== curRed && cur.length) {
        (curRed ? red : ink).push(cur);
        cur = [cur[cur.length - 1]];
      }
      curRed = isRed;
      for (let m = 0; m < 12; m++) {
        const a = Math.max(t0, yearFrac(y, m, 1)), b = Math.min(t1, yearFrac(y, m + 1, 1));
        if (b <= a) continue;
        const ta = yearFrac(y, m, 1);
        if (v.months && m > 0 && ta >= t0) {
          const p = at(ta), [nx, ny] = normal(ta);
          cur.push(p, [p[0] + nx * tick, p[1] + ny * tick], [p[0] - nx * tick, p[1] - ny * tick], p);
        }
        // Sample finely enough for the curve (about every 0.6 mm).
        const len = 2 * Math.PI * (r0 + pitch * (b - t0)) * (b - a);
        const n = Math.max(2, Math.ceil(len / 0.6));
        for (let i = 0; i <= n; i++) cur.push(at(a + ((b - a) * i) / n));
      }
    }
    if (cur.length > 1) (curRed ? red : ink).push(cur);

    // Decade years lettered up a narrow slot cut through the loops at 1 January (top centre).
    const labelsRed: Polyline[] = [];
    let spiral = ink, decadeLoops = red;
    if (v.decades) {
      const ds = Math.min(size * 0.9, pitch * 10 * 0.6 / 2.6);
      const slot = ds * 0.75 + 0.6;
      const inSlot = (x: number, y: number) => Math.abs(x - cx) < slot && y < cy - r0 * 0.6;
      spiral = clipTo(ink, (x, y) => !inSlot(x, y), 0.3);
      decadeLoops = clipTo(red, (x, y) => !inSlot(x, y), 0.3);
      for (let y = Math.ceil(t0 / 10) * 10; y < t1; y += 10) {
        const p = at(y);
        const r = cy - p[1];
        const path: Polyline = [[cx, cy - r - pitch * 0.6], [cx, cy - r - pitch * 0.6 - 30]];
        labelsRed.push(...textAlong(String(y), path, { size: ds, font, offset: -ds / 2 }));
      }
    }

    // Month initials round the outside.
    const outer: Polyline[] = [];
    if (v.months) {
      for (let m = 0; m < 12; m++) {
        // The outermost loop at this month's angle.
        let tm = Math.floor(t1) + (m + 0.5) / 12;
        if (tm > t1) tm -= 1;
        if (tm < t0) continue;
        const [x, y] = at(tm);
        const [nx, ny] = normal(tm);
        const k = pitch * 1.5 + size * 0.9;
        outer.push(...text(MONTHS[m][0], { x: x + nx * k, y: y + ny * k + size * 0.4, size: size * 0.8, font, align: 'center' }));
      }
    }

    // Centre: name and birth date.
    if (title) {
      outer.push(...text(title, { x: cx, y: cy + titleSize * 0.2, size: titleSize, font, align: 'center' }));
      const [by, bm, bd] = String(v.birth).split('-').map(Number);
      outer.push(...text(`${bd} ${MONTHS[(bm || 1) - 1]} ${by}`, { x: cx, y: cy + titleSize * 1.5, size: titleSize * 0.6, font, align: 'center' }));
    }

    // Events: a circle on the line, a leader out of the spiral, and a label in a side column.
    // Greedy placement: each column is filled in order of the events' heights, pushing
    // labels down (then back up from the bottom) so none overlap.
    const marks: Polyline[] = [];
    const labels: Polyline[] = [];
    const lineH = size * 1.7;
    // Each leader leaves the spiral straight out from the centre; labels are ordered by where
    // their leaders leave, so leaders don't cross outside the spiral.
    const cols: { e: LifeEvent; p: Pt; out: Pt; y: number }[][] = [[], []];
    for (const e of events) {
      const p = at(e.t);
      const dx = p[0] - cx, dy = p[1] - cy, d = Math.hypot(dx, dy) || 1;
      const reach = square ? Rmax / Math.max(Math.abs(dx / d), Math.abs(dy / d)) : Rmax;
      const out: Pt = [cx + (dx / d) * (reach + 2), cy + (dy / d) * (reach + 2)];
      cols[p[0] >= cx ? 1 : 0].push({ e, p, out, y: out[1] });
    }
    for (const [side, col] of cols.entries()) {
      // Order by angle round from the top (clockwise on the right, anticlockwise on the left).
      const ang = (q: Pt) => Math.atan2(side ? q[0] - cx : cx - q[0], cy - q[1]);
      col.sort((a, b) => ang(a.out) - ang(b.out));
      for (let i = 0; i < col.length; i++) col[i].y = Math.max(col[i].out[1], i ? col[i - 1].y + lineH : size);
      for (let i = col.length - 1; i >= 0; i--) col[i].y = Math.min(col[i].y, i < col.length - 1 ? col[i + 1].y - lineH : H - size * 0.5);
      for (let i = 0; i < col.length; i++) col[i].y = Math.max(col[i].y, i ? col[i - 1].y + lineH : size);
      const xLabel = side ? cx + Rmax + 6 : cx - Rmax - 6;
      for (const { e, p, out, y } of col) {
        const mr = Math.max(0.5, Math.min(1.2, pitch * 0.7));
        marks.push(circle(p[0], p[1], mr, 20));
        // Leader: out from the centre to just beyond the spiral, then across to the label.
        const dx = p[0] - cx, dy = p[1] - cy, d = Math.hypot(dx, dy) || 1;
        const start: Pt = [p[0] + (dx / d) * mr, p[1] + (dy / d) * mr];
        const end: Pt = [xLabel + (side ? -1.2 : 1.2), y - size * 0.4];
        marks.push([start, out, end]);
        labels.push(...text(side ? rightText(e) : leftText(e), { x: xLabel, y, size, font, align: side ? 'left' : 'right' }));
      }
    }

    const layers: Layer[] = [
      { name: 'Life', color: PALETTE[0], paths: [...spiral, ...outer, ...labels] },
      { name: 'Decades', color: PALETTE[1], paths: [...decadeLoops, ...labelsRed] },
      { name: 'Events', color: PALETTE[2], paths: marks },
    ];
    return layers.filter((l) => l.paths.length);
  },
});
