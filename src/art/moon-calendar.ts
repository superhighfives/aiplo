import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { julianDay, moonDarkPolygon, moonPhase } from '../lib/astro';
import { hatchPolygon } from '../lib/hatch';
import { FONT_OPTIONS, measureText, text } from '../lib/hershey';
import { defineArtwork } from './types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

interface Day {
  m: number;
  d: number;
  fraction: number;
  waxing: boolean;
  /** Nearest day to a full (+1) or new (−1) moon. */
  event: number;
}

export default defineArtwork({
  slug: 'moon-calendar',
  title: 'Moon calendar',
  description: 'Every night of a year as a little hatched moon, in a month-by-day grid or one long spiral.',
  order: 32,
  paper: { paper: 'a4', orientation: 'landscape', margin: 15 },
  params: [
    { type: 'number', key: 'year', label: 'Year', min: 1800, max: 2200, step: 1, default: 2026 },
    { type: 'select', key: 'layout', label: 'Layout', default: 'grid', options: [['grid', 'Months × days'], ['spiral', 'Spiral']] },
    { type: 'number', key: 'size', label: 'Moon size', min: 0.3, max: 1, step: 0.01, default: 0.78, hint: 'Disc diameter as a fraction of its cell' },
    { type: 'number', key: 'spacing', label: 'Hatch spacing (mm)', min: 0.25, max: 2, step: 0.05, default: 0.5 },
    { type: 'number', key: 'angle', label: 'Hatch angle (°)', min: 0, max: 175, step: 5, default: 45 },
    { type: 'checkbox', key: 'outline', label: 'Outline discs', default: true },
    { type: 'checkbox', key: 'terminator', label: 'Draw the terminator', default: false, hint: 'Outline the edge between light and dark' },
    { type: 'checkbox', key: 'events', label: 'Ring full moons', default: true, hint: 'A second-pen ring around the night nearest each full moon' },
    { type: 'select', key: 'hemisphere', label: 'Seen from', default: 'north', options: [['north', 'Northern hemisphere'], ['south', 'Southern hemisphere']], hint: 'The south sees the Moon flipped: waxing lit on the left' },
    { type: 'number', key: 'hour', label: 'Hour of night', min: 0, max: 23, step: 1, default: 21, hint: 'UTC time each phase is computed for; the phase changes little within a day' },
    { type: 'number', key: 'turns', label: 'Spiral turns', min: 2, max: 15, step: 0.5, default: 6.5, show: (v) => v.layout === 'spiral' },
    { type: 'checkbox', key: 'labels', label: 'Labels', default: true },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural', show: (v) => v.labels },
  ],
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const Y = v.year;

    const days: Day[] = [];
    for (let m = 0; m < 12; m++)
      for (let d = 1; d <= daysIn(Y, m); d++) {
        const p = moonPhase(julianDay(Date.UTC(Y, m, d, v.hour)));
        days.push({ m, d, fraction: p.fraction, waxing: p.waxing, event: 0 });
      }
    // Mark local extremes of illumination: the nights closest to full and new.
    for (let i = 0; i < days.length; i++) {
      const prev = i > 0 ? days[i - 1].fraction : moonPhase(julianDay(Date.UTC(Y, 0, 0, v.hour))).fraction;
      const next = i < days.length - 1 ? days[i + 1].fraction : moonPhase(julianDay(Date.UTC(Y + 1, 0, 1, v.hour))).fraction;
      const f = days[i].fraction;
      if (f >= prev && f > next) days[i].event = 1;
      if (f <= prev && f < next) days[i].event = -1;
    }

    const ink: Polyline[] = [];
    const red: Polyline[] = [];
    const flip = v.hemisphere === 'south';
    const drawMoon = (c: Pt, r: number, day: Day) => {
      if (v.outline) ink.push(circle(c[0], c[1], r, Math.max(24, Math.ceil(r * 12))));
      if (day.fraction < 0.97) {
        const poly = moonDarkPolygon(c[0], c[1], r, day, 32, flip);
        // Hatch inset a hair so lines end inside the outline rather than poking through.
        const segs = hatchPolygon([poly], v.angle, v.spacing, (c[0] * 0.37 + c[1] * 0.11) % v.spacing).map((l) => shrink(l, 0.08));
        ink.push(...zigzag(segs, v.spacing * 1.6));
      }
      if (v.terminator && day.fraction > 0.01 && day.fraction < 0.99) {
        const e = 1 - 2 * day.fraction;
        const side = (day.waxing ? 1 : -1) * (flip ? -1 : 1);
        const t: Polyline = [];
        for (let k = 0; k <= 24; k++) {
          const a = -Math.PI / 2 + (k / 24) * Math.PI;
          t.push([c[0] + side * e * Math.cos(a) * r, c[1] + Math.sin(a) * r]);
        }
        ink.push(t);
      }
      if (v.events && day.event === 1) red.push(circle(c[0], c[1], r + Math.max(0.6, r * 0.22), Math.max(24, Math.ceil(r * 14))));
    };

    let fulls = 0;
    for (const d of days) if (d.event === 1) fulls++;

    if (v.layout === 'grid') {
      const font = v.font;
      const lab = v.labels ? 3 : 0;
      const labelW = v.labels ? Math.max(...MONTHS.map((n) => measureText(n.slice(0, 3), { size: lab, font }))) + 4 : 0;
      const topH = v.labels ? lab + 4 : 0;
      const titleH = v.labels ? 12 : 0;
      const cell = Math.min((W - labelW) / 31, (H - topH - titleH) / 12);
      const gridW = labelW + cell * 31;
      const gridH = topH + cell * 12 + titleH;
      const x0 = (W - gridW) / 2 + labelW;
      const y0 = (H - gridH) / 2 + titleH + topH;
      const r = (cell * v.size) / 2;
      for (const day of days) drawMoon([x0 + (day.d - 0.5) * cell, y0 + (day.m + 0.5) * cell], r, day);
      if (v.labels) {
        ink.push(...text(String(Y), { x: x0 + cell * 15.5, y: y0 - topH - 4, size: 6, font, align: 'center', tracking: 0.4 }));
        for (let m = 0; m < 12; m++) ink.push(...text(MONTHS[m].slice(0, 3), { x: x0 - 3, y: y0 + (m + 0.5) * cell + lab / 2, size: lab, font, align: 'right' }));
        for (let d = 1; d <= 31; d += d < 2 ? 4 : 5) ink.push(...text(String(d), { x: x0 + (d - 0.5) * cell, y: y0 - 2.2, size: lab * 0.7, font, align: 'center' }));
      }
    } else {
      // Archimedean spiral from the centre out; discs evenly spaced along it.
      const lab = v.labels ? 3 : 0;
      const Rmax = Math.min(W, H) / 2 - (v.labels ? 10 : 2);
      const pitch = Rmax / (v.turns + 0.6);
      const r0 = pitch * 1.7;
      const cx = W / 2, cy = H / 2;
      // Arc length of r = r0 + b θ, numerically.
      const b = pitch / (2 * Math.PI);
      const thetaMax = (Rmax - r0 - pitch * 0.5) / b;
      const N = 4000;
      const arc: number[] = [0];
      for (let i = 1; i <= N; i++) {
        const t = (i / N) * thetaMax;
        arc.push(arc[i - 1] + (thetaMax / N) * Math.hypot(b, r0 + b * t));
      }
      const total = arc[N];
      const stepLen = total / (days.length - 1);
      const rDisc = Math.min(pitch, stepLen) * v.size * 0.5;
      let j = 0;
      days.forEach((day, i) => {
        const s = i * stepLen;
        while (j < N && arc[j + 1] < s) j++;
        const t = ((j + (s - arc[j]) / Math.max(1e-9, arc[j + 1] - arc[j])) / N) * thetaMax;
        const rr = r0 + b * t;
        const a = t - Math.PI / 2;
        const c: Pt = [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
        drawMoon(c, rDisc, day);
        if (v.labels && day.d === 1) {
          // A short radial tick between the arms marks the first of each month.
          const r1 = rr - rDisc * 1.3, r2 = rr - pitch + rDisc * 1.3;
          if (i > 0 && rr - pitch > r0) red.push([[cx + Math.cos(a) * r1, cy + Math.sin(a) * r1], [cx + Math.cos(a) * r2, cy + Math.sin(a) * r2]]);
        }
      });
      if (v.labels) {
        ink.push(...text(String(Y), { x: cx, y: cy + lab * 0.6, size: lab * 1.2, font: v.font, align: 'center', tracking: 0.3 }));
      }
    }

    ctx.status(`${Y}: ${days.length} nights, ${fulls} full moons · phases at ${String(v.hour).padStart(2, '0')}:00 UTC`);
    const layers: Layer[] = [{ name: 'Moons', color: PALETTE[0], paths: ink }];
    if (red.length) layers.push({ name: v.layout === 'spiral' ? 'Full moons & months' : 'Full moons', color: PALETTE[1], paths: red });
    return layers;
  },
});

/** Pull both ends of a straight hatch segment in by `d` mm. */
function shrink(l: Polyline, d: number): Polyline {
  if (l.length !== 2) return l;
  const [a, b] = l;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L <= 2 * d + 0.05) return l;
  const ux = ((b[0] - a[0]) / L) * d, uy = ((b[1] - a[1]) / L) * d;
  return [[a[0] + ux, a[1] + uy], [b[0] - ux, b[1] - uy]];
}

/** Join consecutive hatch segments end-to-start into one pen-down zig-zag where they're close. */
function zigzag(segs: Polyline[], maxHop: number): Polyline[] {
  const out: Polyline[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last) {
      const e = last[last.length - 1];
      if (Math.hypot(s[0][0] - e[0], s[0][1] - e[1]) <= maxHop) {
        last.push(...s);
        continue;
      }
    }
    out.push([...s]);
  }
  return out;
}
