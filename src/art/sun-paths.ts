import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { RAD, stereoRadius, sunAltAz, zoneOffset } from '../lib/astro';
import { FONT_OPTIONS, text } from '../lib/hershey';
import { defineArtwork } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Split a sampled sky track into the pieces above the horizon, interpolating the crossings. */
function aboveHorizon(samples: { alt: number; az: number }[], proj: (alt: number, az: number) => Pt): Polyline[] {
  const out: Polyline[] = [];
  let cur: Polyline | null = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.alt >= 0) {
      if (!cur) {
        cur = [];
        if (i > 0) cur.push(cross(samples[i - 1], s, proj));
        out.push(cur);
      }
      cur.push(proj(s.alt, s.az));
    } else if (cur) {
      cur.push(cross(samples[i - 1], s, proj));
      cur = null;
    }
  }
  return out.filter((l) => l.length > 1);
}
function cross(a: { alt: number; az: number }, b: { alt: number; az: number }, proj: (alt: number, az: number) => Pt): Pt {
  const t = a.alt / (a.alt - b.alt);
  let d = b.az - a.az;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return proj(0, a.az + d * t);
}

export default defineArtwork({
  slug: 'sun-paths',
  title: 'Sun paths',
  description: "The sun's daily arcs across the sky through the year, with the figure-of-eight analemma each hour traces.",
  order: 31,
  paper: { paper: 'square', margin: 18 },
  params: [
    { type: 'location', key: 'loc', label: 'Location', default: { name: 'Stonehenge, England', lat: 51.1789, lon: -1.8262 } },
    { type: 'number', key: 'year', label: 'Year', min: 1800, max: 2200, step: 1, default: 2025 },
    {
      type: 'select', key: 'days', label: 'Day arcs', default: 'months',
      options: [['months', '21st of each month'], ['solstices', 'Solstices and equinoxes'], ['none', 'None']],
    },
    { type: 'checkbox', key: 'analemmas', label: 'Hour analemmas', default: true, hint: 'Where the sun is at each hour, every day of the year' },
    {
      type: 'select', key: 'clock', label: 'Hours in', default: 'solar',
      options: [['solar', 'Local mean solar time'], ['zone', 'Clock time']],
      hint: 'Solar time centres the noon figure-eight on the meridian; clock time uses the UTC offset (no daylight saving)',
    },
    { type: 'number', key: 'utcOffset', label: 'UTC offset (h)', min: -12, max: 14, step: 0.25, default: 0, show: (v) => v.clock === 'zone', hint: 'Leave at 0 for longitude ÷ 15' },
    { type: 'select', key: 'projection', label: 'Projection', default: 'stereo', options: [['stereo', 'Stereographic'], ['polar', 'Equidistant (altitude linear)']] },
    { type: 'number', key: 'rings', label: 'Altitude rings every (°)', min: 0, max: 30, step: 5, default: 10, hint: '0 = none' },
    { type: 'number', key: 'spokes', label: 'Azimuth lines every (°)', min: 0, max: 90, step: 5, default: 30, hint: '0 = none' },
    { type: 'checkbox', key: 'labels', label: 'Labels', default: true },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
  ],
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const { lat, lon } = v.loc;
    const R = Math.min(W, H) / 2 - (v.labels ? 13 : 3);
    const cx = W / 2, cy = H / 2;
    const rad = (alt: number) => (v.projection === 'polar' ? (R * (90 - alt)) / 90 : stereoRadius(alt, R));
    // Seen from above, like a map: north up, east right.
    const proj = (alt: number, az: number): Pt => {
      const r = rad(alt);
      return [cx + Math.sin(az * RAD) * r, cy - Math.cos(az * RAD) * r];
    };
    // Hours → UTC offset.
    const off = v.clock === 'solar' ? lon / 15 : v.utcOffset || zoneOffset(lon);
    const at = (y: number, m: number, d: number, hours: number) => sunAltAz(Date.UTC(y, m, d) + (hours - off) * 3600_000, lat, lon);

    const grid: Polyline[] = [];
    const arcs: Polyline[] = [];
    const eights: Polyline[] = [];

    grid.push(circle(cx, cy, R, 360));
    if (v.rings > 0) for (let a = v.rings; a < 90; a += v.rings) grid.push(circle(cx, cy, rad(a), 240));
    if (v.spokes > 0) for (let az = 0; az < 360; az += v.spokes) grid.push([proj(0, az), proj(90 - Math.min(v.rings || 10, 10), az)]);
    for (let az = 0; az < 360; az += 5) {
      const len = az % 15 === 0 ? 2 : 1;
      const s = Math.sin(az * RAD), c = Math.cos(az * RAD);
      grid.push([[cx + s * R, cy - c * R], [cx + s * (R + len), cy - c * (R + len)]]);
    }
    if (v.labels) {
      for (const [ch, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
        const rr = R + 10.5;
        grid.push(...text(ch, { x: cx + Math.sin(az * RAD) * rr, y: cy - Math.cos(az * RAD) * rr + 1.75, size: 3.5, font: v.font, align: 'center' }));
      }
      if (v.rings > 0) {
        // Altitude labels up the north-east diagonal... placed along the 45° azimuth just off the line.
        for (let a = v.rings; a < 90; a += v.rings * (v.rings < 10 ? 2 : 1)) {
          const p = proj(a, 0);
          grid.push(...text(`${a}°`, { x: p[0] + 1, y: p[1] - 0.8, size: 1.8, font: v.font }));
        }
      }
    }

    // Day arcs.
    const dayList: [number, number, string][] =
      v.days === 'months' ? MONTHS.map((n, m) => [m, 21, n]) : v.days === 'solstices' ? [[2, 20, 'Mar'], [5, 21, 'Jun'], [8, 22, 'Sep'], [11, 21, 'Dec']] : [];
    for (const [m, d] of dayList) {
      const samples = [];
      for (let t = 0; t <= 24 * 60; t += 4) samples.push(at(v.year, m, d, t / 60));
      arcs.push(...aboveHorizon(samples, proj));
    }
    if (v.labels && dayList.length) {
      // Label each arc just outside the horizon: Jan–Jun where the sun rises, Jul–Dec where it
      // sets, so months with mirrored arcs (Apr/Aug…) don't collide. Days the sun never sets
      // are labelled on the arc itself, in the north-east.
      for (const [m, d, name] of dayList) {
        const late = m >= 6;
        let cross: number | null = null;
        let prev = at(v.year, m, d, 0);
        let up = prev.alt >= 0;
        for (let t = 2; t <= 24 * 60; t += 2) {
          const s = at(v.year, m, d, t / 60);
          if (s.alt >= 0) up = true;
          const rising = prev.alt < 0 && s.alt >= 0, setting = prev.alt >= 0 && s.alt < 0;
          if (cross === null && (late ? setting : rising)) cross = prev.az + (s.az - prev.az) * (prev.alt / (prev.alt - s.alt));
          prev = s;
        }
        if (!up) continue;
        if (cross !== null) {
          const sx = Math.sin(cross * RAD);
          const p: Pt = [cx + sx * (R + 2.8), cy - Math.cos(cross * RAD) * (R + 2.8) + 0.9];
          arcs.push(...text(name, { x: p[0], y: p[1], size: 1.8, font: v.font, align: sx > 0.2 ? 'left' : sx < -0.2 ? 'right' : 'center' }));
        } else {
          // Midnight sun: find the arc's radius at azimuth ~45° and label just outside it.
          let best = { alt: 0, az: 0, d: 999 };
          for (let t = 0; t <= 24 * 60; t += 4) {
            const s = at(v.year, m, d, t / 60);
            const dd = Math.abs(((s.az - 40 + 540) % 360) - 180);
            if (dd < best.d) best = { alt: s.alt, az: s.az, d: dd };
          }
          const rr = rad(best.alt) + 2.5;
          arcs.push(...text(name, { x: cx + Math.sin(best.az * RAD) * rr, y: cy - Math.cos(best.az * RAD) * rr + 0.9, size: 1.8, font: v.font, align: 'left' }));
        }
      }
    }

    // Hour analemmas: the sun at the same clock time every few days.
    if (v.analemmas) {
      for (let h = 0; h < 24; h++) {
        const samples = [];
        for (let d = 0; d <= 366; d += 2) samples.push(at(v.year, 0, 1 + d, h));
        const pieces = aboveHorizon(samples, proj);
        if (!pieces.length) continue;
        eights.push(...pieces);
        if (v.labels) {
          let top = samples[0];
          for (const s of samples) if (s.alt > top.alt) top = s;
          if (top.alt < 3) continue;
          // Label just beyond the summer end of the figure, pointing away from the zenith.
          const p = proj(top.alt, top.az);
          const dx = p[0] - cx, dy = p[1] - cy, L = Math.hypot(dx, dy) || 1;
          const off2 = 3.2;
          const q: Pt = L < 3 ? [p[0], p[1] - off2] : [p[0] - (dx / L) * off2, p[1] - (dy / L) * off2];
          eights.push(...text(String(h), { x: q[0], y: q[1] + 0.9, size: 1.8, font: v.font, align: 'center' }));
        }
      }
    }

    ctx.status(`${v.loc.name} · ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} · hours in ${v.clock === 'solar' ? 'local mean solar time' : `UTC${off >= 0 ? '+' : ''}${off}`}`);

    const layers: Layer[] = [{ name: 'Grid', color: PALETTE[0], paths: grid }];
    if (arcs.length) layers.push({ name: 'Day arcs', color: PALETTE[1], paths: arcs });
    if (eights.length) layers.push({ name: 'Analemmas', color: PALETTE[2], paths: eights });
    return layers;
  },
});
