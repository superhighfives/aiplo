import type { Polyline, Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { FONT_OPTIONS, text } from '../lib/hershey';
import { fetchArchive } from '../lib/weather';
import { defineArtwork } from './types';

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const isLeap = (y: number) => daysIn(y, 1) === 29;

interface Day {
  y: number;
  m: number;
  d: number;
  /** Day of year, 0-based. */
  doy: number;
  tmax: number | null;
  tmin: number | null;
  rain: number;
}

export default defineArtwork({
  slug: 'weather-year',
  title: 'A year of weather',
  description: "A year's daily temperatures as a spiral that swells in summer, with rain as ticks on a second pen.",
  order: 34,
  paper: { paper: 'square', margin: 18 },
  params: [
    { type: 'location', key: 'loc', label: 'Location', default: { name: 'Winnipeg, Canada', lat: 49.8954, lon: -97.1385 } },
    { type: 'number', key: 'year', label: 'Year', min: 1940, max: 2026, step: 1, default: 2025, hint: 'The last (or only) year shown' },
    {
      type: 'select', key: 'layout', label: 'Layout', default: 'year',
      options: [['month', 'Spiral, a turn per month'], ['year', 'Spiral, a turn per year'], ['rings', 'Rings, one per month']],
    },
    { type: 'number', key: 'years', label: 'Years', min: 1, max: 12, step: 1, default: 1, hint: 'How many years back to include' },
    { type: 'number', key: 'wobble', label: 'Temperature swing', min: 0, max: 8, step: 0.1, default: 3, hint: 'Full temperature range as a multiple of the gap between turns' },
    { type: 'select', key: 'temp', label: 'Temperature lines', default: 'range', options: [['both', 'Daily max and min'], ['mean', 'Daily mean'], ['range', 'Max, min and a bar per day']] },
    { type: 'checkbox', key: 'rain', label: 'Rain ticks', default: true, hint: 'On a second pen; length grows with daily precipitation' },
    { type: 'number', key: 'rainScale', label: 'Tick length per mm (mm)', min: 0.05, max: 2, step: 0.05, default: 0.35, show: (v) => v.rain },
    { type: 'checkbox', key: 'labels', label: 'Labels', default: true },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural', show: (v) => v.labels },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const Y1 = v.year, Y0 = v.year - v.years + 1;
    ctx.status(`Fetching ${v.years > 1 ? `${Y0}–${Y1}` : Y1} weather for ${v.loc.name}…`);
    const [pt] = await fetchArchive({
      lat: v.loc.lat, lon: v.loc.lon, start: `${Y0}-01-01`, end: `${Y1}-12-31`,
      daily: ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'],
    });
    const dd = pt.daily!;
    const byDate = new Map<string, number>();
    dd.time.forEach((t, i) => byDate.set(t, i));

    const days: Day[] = [];
    for (let y = Y0; y <= Y1; y++) {
      let doy = 0;
      for (let m = 0; m < 12; m++)
        for (let d = 1; d <= daysIn(y, m); d++, doy++) {
          const i = byDate.get(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
          days.push({
            y, m, d, doy,
            tmax: i === undefined ? null : dd.temperature_2m_max[i],
            tmin: i === undefined ? null : dd.temperature_2m_min[i],
            rain: i === undefined ? 0 : dd.precipitation_sum[i] ?? 0,
          });
        }
    }
    const valid = days.filter((d) => d.tmax != null && d.tmin != null);
    if (!valid.length) throw new Error(`No weather data for ${v.loc.name} in ${Y1}`);
    const lo = Math.min(...valid.map((d) => d.tmin!)), hi = Math.max(...valid.map((d) => d.tmax!));
    const rainTotal = days.reduce((s, d) => s + d.rain, 0) / v.years;

    // Geometry. `t` counts turns (or rings) from the centre.
    const turns = v.layout === 'year' ? v.years : 12 * v.years;
    const cx = W / 2, cy = H / 2;
    const Rmax = Math.min(W, H) / 2 - (v.labels ? 7 : 1);
    const r0 = Rmax * 0.2;
    const pitch = (Rmax - r0) / (turns + v.wobble + 0.3);
    const k = (v.wobble * pitch) / Math.max(1, hi - lo);
    const where = (day: Day): { t: number; a: number } => {
      if (v.layout === 'year') {
        const f = day.doy / (isLeap(day.y) ? 366 : 365);
        return { t: day.y - Y0 + f, a: f * 2 * Math.PI };
      }
      const f = (day.d - 1) / daysIn(day.y, day.m);
      const mi = (day.y - Y0) * 12 + day.m;
      return v.layout === 'rings' ? { t: mi, a: f * 2 * Math.PI * 0.97 } : { t: mi + f, a: f * 2 * Math.PI };
    };
    const at = (t: number, a: number, dr: number): Pt => {
      const r = r0 + pitch * t + dr;
      return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
    };

    // Temperature lines, broken at gaps (and between rings).
    const ink: Polyline[] = [];
    const series = (val: (d: Day) => number | null) => {
      // Runs of consecutive valid days (split at gaps and, for rings, at month ends)…
      const runs: { t: number; a: number; T: number }[][] = [];
      let cur: { t: number; a: number; T: number }[] | null = null;
      let lastT = -1;
      for (const day of days) {
        const T = val(day);
        const { t, a } = where(day);
        if (T == null || (v.layout === 'rings' && Math.floor(t) !== Math.floor(lastT))) cur = null;
        lastT = t;
        if (T == null) continue;
        if (!cur) runs.push((cur = []));
        cur.push({ t, a, T });
      }
      // …drawn as Catmull-Rom curves through the daily values, so turns read as smooth lines.
      const SUB = 4;
      for (const run of runs) {
        const line: Polyline = [];
        for (let i = 0; i < run.length; i++) {
          const p1 = run[i];
          if (i === run.length - 1) {
            line.push(at(p1.t, p1.a, (p1.T - lo) * k));
            break;
          }
          const p0 = run[Math.max(0, i - 1)], p2 = run[i + 1], p3 = run[Math.min(run.length - 1, i + 2)];
          let da = p2.a - p1.a;
          if (da < -Math.PI) da += 2 * Math.PI;
          for (let s = 0; s < SUB; s++) {
            const u = s / SUB, u2 = u * u, u3 = u2 * u;
            const T = 0.5 * (2 * p1.T + (-p0.T + p2.T) * u + (2 * p0.T - 5 * p1.T + 4 * p2.T - p3.T) * u2 + (-p0.T + 3 * p1.T - 3 * p2.T + p3.T) * u3);
            line.push(at(p1.t + (p2.t - p1.t) * u, p1.a + da * u, (T - lo) * k));
          }
        }
        if (line.length > 1) ink.push(line);
      }
    };
    if (v.temp === 'mean') series((d) => (d.tmax == null || d.tmin == null ? null : (d.tmax + d.tmin) / 2));
    else {
      series((d) => d.tmax);
      series((d) => d.tmin);
    }
    if (v.temp === 'range')
      for (const day of valid) {
        const { t, a } = where(day);
        ink.push([at(t, a, (day.tmin! - lo) * k), at(t, a, (day.tmax! - lo) * k)]);
      }

    // Rain: radial ticks outward from the day's max.
    const rain: Polyline[] = [];
    if (v.rain) {
      for (const day of days) {
        if (day.rain < 0.5 || day.tmax == null) continue;
        const { t, a } = where(day);
        const base = (day.tmax - lo) * k + 0.5;
        const len = Math.min(pitch * 1.5, day.rain * v.rainScale);
        rain.push([at(t, a, base), at(t, a, base + len)]);
      }
    }

    // Scale up so the drawing, not the worst case, fills the page.
    let maxR = 0;
    for (const l of ink) for (const [x, y] of l) maxR = Math.max(maxR, Math.hypot(x - cx, y - cy));
    const grow = maxR > 0 ? Math.min(2, (Rmax - (v.rain ? 4 : 0)) / maxR) : 1;
    for (const l of [...ink, ...rain]) for (const p of l) { p[0] = cx + (p[0] - cx) * grow; p[1] = cy + (p[1] - cy) * grow; }
    maxR *= grow;

    if (v.labels) {
      const font = v.font;
      // Month initials around the outside (spiral/rings by month) or month ticks (per year).
      const rl = Math.min(Rmax + 3.5, maxR + (v.rain ? 7 : 4));
      for (let m = 0; m < 12; m++) {
        if (v.layout !== 'year') break;
        const a = ((Date.UTC(2001, m, 1) - Date.UTC(2001, 0, 1)) / (365 * 86400000)) * 2 * Math.PI;
        ink.push(...text(MONTHS[m], { x: cx + Math.sin(a) * rl, y: cy - Math.cos(a) * rl + 1.25, size: 2.5, font, align: 'center' }));
      }
      if (v.layout !== 'year') {
        // Day-of-month marks: 1, 10, 20 at the top/edges.
        for (const dnum of [1, 8, 15, 22]) {
          const a = ((dnum - 1) / 31) * 2 * Math.PI;
          ink.push(...text(String(dnum), { x: cx + Math.sin(a) * rl, y: cy - Math.cos(a) * rl + 1.1, size: 2.2, font, align: 'center' }));
        }
      }
      const name = v.loc.name.split(',')[0];
      ink.push(...text(name, { x: cx, y: cy - 1, size: Math.min(4, r0 * grow * 0.28), font, align: 'center' }));
      ink.push(...text(v.years > 1 ? `${Y0}–${Y1}` : String(Y1), { x: cx, y: cy + Math.min(4, r0 * grow * 0.28) + 1.5, size: Math.min(2.8, r0 * grow * 0.2), font, align: 'center', tracking: 0.2 }));
    }

    ctx.status(`${v.loc.name}: ${lo.toFixed(1)} to ${hi.toFixed(1)} °C · ${Math.round(rainTotal)} mm precipitation a year`);
    const layers: Layer[] = [{ name: 'Temperature', color: PALETTE[0], paths: ink }];
    if (rain.length) layers.push({ name: 'Rain', color: PALETTE[2], paths: rain });
    return layers;
  },
});
