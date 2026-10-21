import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import {
  eclipticToEquatorial, julianDay, localToUTC, lst, moonDarkPolygon, moonPhase, moonPosition, RAD,
  skyProjector, stereoRadius, sunPosition, toHorizontal, zoneOffset,
} from '../lib/astro';
import { hatchPolygon } from '../lib/hatch';
import { FONT_OPTIONS, text } from '../lib/hershey';
import { defineArtwork } from './types';

const BASE = 'https://cdn.jsdelivr.net/gh/ofrohn/d3-celestial@master/data/';
const jsonCache = new Map<string, Promise<any>>();
function getJSON(name: string): Promise<any> {
  let p = jsonCache.get(name);
  if (!p) {
    p = fetch(BASE + name, { signal: AbortSignal.timeout(20000) })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .catch((e) => {
        jsonCache.delete(name);
        throw new Error(`Couldn't load star catalogue ${name}: ${e.message}`);
      });
    jsonCache.set(name, p);
  }
  return p;
}

/** Clip a polyline to the disc of radius R about (cx, cy). */
function clipToDisc(p: Polyline, cx: number, cy: number, R: number): Polyline[] {
  const inside = (q: Pt) => Math.hypot(q[0] - cx, q[1] - cy) <= R;
  const cross = (a: Pt, b: Pt): Pt => {
    // Solve |a + t(b-a) - c| = R for t in [0,1].
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const fx = a[0] - cx, fy = a[1] - cy;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - R * R;
    const disc = Math.sqrt(Math.max(0, B * B - 4 * A * C));
    let t = (-B + disc) / (2 * A);
    if (t < 0 || t > 1) t = (-B - disc) / (2 * A);
    t = Math.max(0, Math.min(1, t));
    return [a[0] + dx * t, a[1] + dy * t];
  };
  const out: Polyline[] = [];
  let cur: Polyline | null = null;
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    if (inside(q)) {
      if (!cur) {
        cur = [];
        if (i > 0) cur.push(cross(q, p[i - 1]));
        out.push(cur);
      }
      cur.push(q);
    } else if (cur) {
      cur.push(cross(p[i - 1], q));
      cur = null;
    }
  }
  return out.filter((l) => l.length > 1);
}

/** Shorten a segment by da at its start and db at its end; null if nothing is left. */
function trim(a: Pt, b: Pt, da: number, db: number): Polyline | null {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L <= da + db + 0.3) return null;
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  return [[a[0] + ux * da, a[1] + uy * da], [b[0] - ux * db, b[1] - uy * db]];
}

/** Filled-looking disc: concentric circles from the outside in. */
function solidDisc(cx: number, cy: number, r: number, pitch = 0.35): Polyline[] {
  const out: Polyline[] = [];
  for (let rr = r; rr > pitch * 0.5; rr -= pitch) out.push(circle(cx, cy, rr, Math.max(10, Math.ceil(rr * 8))));
  if (r < pitch) out.push(circle(cx, cy, Math.max(0.12, r), 8));
  return out;
}

function asterisk(cx: number, cy: number, r: number, arms: number): Polyline[] {
  const out: Polyline[] = [];
  for (let k = 0; k < arms; k++) {
    const a = (k / arms) * Math.PI;
    const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
    out.push([[cx - dx, cy - dy], [cx + dx, cy + dy]]);
  }
  return out;
}

export default defineArtwork({
  slug: 'star-chart',
  title: 'Star chart',
  description: 'The sky above any place at any moment: stars by magnitude, constellation figures, horizon and cardinal points.',
  order: 30,
  paper: { paper: 'a4', orientation: 'portrait', margin: 18 },
  params: [
    { type: 'location', key: 'loc', label: 'Location', default: { name: 'Royal Observatory, Greenwich', lat: 51.4769, lon: -0.0005 } },
    { type: 'date', key: 'date', label: 'Date & time (local)', time: true, default: '2000-01-01T00:00', hint: 'Wall-clock time at the place' },
    {
      type: 'select', key: 'tz', label: 'Time zone', default: 'auto',
      options: [['auto', 'Guess from longitude'], ['manual', 'UTC offset…']],
      hint: 'The guess is longitude ÷ 15 rounded to the hour, ignoring daylight saving',
    },
    { type: 'number', key: 'utcOffset', label: 'UTC offset (h)', min: -12, max: 14, step: 0.25, default: 0, show: (v) => v.tz === 'manual' },
    { type: 'number', key: 'magLimit', label: 'Faintest magnitude', min: 2, max: 6, step: 0.1, default: 5, hint: 'Higher shows fainter stars; 6 is the naked-eye limit' },
    {
      type: 'select', key: 'style', label: 'Stars as', default: 'discs',
      options: [['discs', 'Discs'], ['rings', 'Open circles'], ['mixed', 'Discs, asterisks for the brightest'], ['crosses', 'Crosses']],
    },
    { type: 'number', key: 'starScale', label: 'Star size', min: 0.3, max: 3, step: 0.05, default: 1 },
    { type: 'checkbox', key: 'lines', label: 'Constellation lines', default: true, hint: 'On a second pen' },
    { type: 'number', key: 'gap', label: 'Gap around stars (mm)', min: 0, max: 3, step: 0.1, default: 0.8, show: (v) => v.lines },
    { type: 'checkbox', key: 'grid', label: 'Alt/az grid', default: false },
    { type: 'checkbox', key: 'ecliptic', label: 'Ecliptic', default: false },
    { type: 'checkbox', key: 'sunMoon', label: 'Sun and Moon', default: true, hint: 'When above the horizon; the Moon shows its phase' },
    { type: 'checkbox', key: 'label', label: 'Title', default: true },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const { lat, lon } = v.loc;
    const offset = v.tz === 'manual' ? v.utcOffset : zoneOffset(lon);
    const ms = localToUTC(v.date, offset);
    const jd = julianDay(ms);
    const L = lst(jd, lon);

    ctx.status('Loading stars…');
    const [stars, figures] = await Promise.all([getJSON('stars.6.json'), v.lines ? getJSON('constellations.lines.json') : null]);

    const labelH = v.label ? 24 : 0;
    const R = Math.min(W / 2 - 9, (H - labelH) / 2 - 9);
    const cx = W / 2;
    // Centre the chart + title block vertically.
    const top = Math.max(0, (H - (2 * R + 18 + labelH)) / 2);
    const cy = top + 9 + R;
    const proj = skyProjector(cx, cy, R, true);
    const toXY = (ra: number, dec: number) => {
      const h = toHorizontal(ra, dec, lat, L);
      return { p: proj(h.alt, h.az), alt: h.alt };
    };

    const ink: Polyline[] = [];
    const figureLines: Polyline[] = [];
    const extra: Polyline[] = [];

    // Horizon: a double ring with azimuth ticks, letters outside.
    ink.push(circle(cx, cy, R, 360));
    ink.push(circle(cx, cy, R + 2.2, 360));
    for (let a = 0; a < 360; a += 5) {
      const len = a % 30 === 0 ? 2.2 : a % 10 === 0 ? 1.4 : 0.8;
      const s = -Math.sin(a * RAD), c = -Math.cos(a * RAD);
      ink.push([[cx + s * R, cy + c * R], [cx + s * (R + len), cy + c * (R + len)]]);
    }
    const letter = 4;
    for (const [ch, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
      const rr = R + 2.2 + 1.8 + letter / 2;
      const x = cx - Math.sin(a * RAD) * rr;
      const y = cy - Math.cos(a * RAD) * rr + letter / 2;
      ink.push(...text(ch, { x, y, size: letter, font: v.font, align: 'center' }));
    }

    if (v.grid) {
      for (const alt of [30, 60]) extra.push(circle(cx, cy, stereoRadius(alt, R), 240));
      for (let az = 0; az < 360; az += 30) extra.push([proj(0, az), proj(60, az)]);
    }

    // Stars.
    const radius = (mag: number) => v.starScale * (0.2 + 0.27 * Math.max(0, v.magLimit + 0.5 - mag));
    const starAt = new Map<string, number>();
    let shown = 0;
    for (const f of stars.features) {
      const mag = f.properties.mag;
      if (mag > v.magLimit) continue;
      const [ra, dec] = f.geometry.coordinates;
      const { p, alt } = toXY(ra, dec);
      if (alt < 0) continue;
      const r = radius(mag);
      const extent = v.style === 'crosses' ? r * 1.4 : v.style === 'mixed' && mag < 1.5 ? r * 1.8 : r;
      starAt.set(`${ra},${dec}`, extent);
      shown++;
      const [x, y] = p;
      if (v.style === 'crosses') ink.push(...asterisk(x, y, r * 1.4, mag < 1 ? 4 : 2));
      else if (v.style === 'rings') ink.push(circle(x, y, Math.max(0.2, r), Math.max(10, Math.ceil(r * 10))));
      else if (v.style === 'mixed' && mag < 1.5) ink.push(...asterisk(x, y, r * 1.8, 4), circle(x, y, r * 0.45, 12));
      else ink.push(...solidDisc(x, y, r));
    }

    if (figures) {
      for (const f of figures.features) {
        for (const line of f.geometry.coordinates as number[][][]) {
          for (let i = 1; i < line.length; i++) {
            const a = line[i - 1], b = line[i];
            const pa = toXY(a[0], a[1]), pb = toXY(b[0], b[1]);
            if (pa.alt < 0 && pb.alt < 0) continue;
            const ga = (starAt.get(`${a[0]},${a[1]}`) ?? 0.3) + v.gap;
            const gb = (starAt.get(`${b[0]},${b[1]}`) ?? 0.3) + v.gap;
            if (pa.alt >= 0 && pb.alt >= 0) {
              const seg = trim(pa.p, pb.p, ga, gb);
              if (seg) figureLines.push(seg);
            } else {
              // Crosses the horizon: densify along RA/Dec and clip to the disc.
              let dra = b[0] - a[0];
              if (dra > 180) dra -= 360;
              if (dra < -180) dra += 360;
              const pts: Pt[] = [];
              for (let k = 0; k <= 16; k++) pts.push(toXY(a[0] + (dra * k) / 16, a[1] + ((b[1] - a[1]) * k) / 16).p);
              for (const piece of clipToDisc(pts, cx, cy, R - 0.6)) {
                const first = piece[0], last = piece[piece.length - 1];
                const s = trim(first, last, pa.alt >= 0 ? ga : 0, pb.alt >= 0 ? gb : 0);
                if (s) figureLines.push(s);
              }
            }
          }
        }
      }
    }

    if (v.ecliptic) {
      const pts: Pt[] = [];
      for (let l = 0; l <= 360; l += 1) {
        const e = eclipticToEquatorial(l, 0, jd);
        pts.push(toXY(e.ra, e.dec).p);
      }
      // Dashed.
      for (const piece of clipToDisc(pts, cx, cy, R)) {
        let acc = 0, on = true, cur: Polyline = [piece[0]];
        for (let i = 1; i < piece.length; i++) {
          const d = Math.hypot(piece[i][0] - piece[i - 1][0], piece[i][1] - piece[i - 1][1]);
          acc += d;
          cur.push(piece[i]);
          if (acc > (on ? 2.5 : 1.5)) {
            if (on) figureLines.push(cur);
            on = !on;
            acc = 0;
            cur = [piece[i]];
          }
        }
        if (on && cur.length > 1) figureLines.push(cur);
      }
    }

    const notes: string[] = [];
    if (v.sunMoon) {
      const sun = sunPosition(jd);
      const sp = toXY(sun.ra, sun.dec);
      if (sp.alt >= 0) {
        const [x, y] = sp.p;
        ink.push(circle(x, y, 2.4, 40), circle(x, y, 0.6, 12));
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          ink.push([[x + Math.cos(a) * 3.2, y + Math.sin(a) * 3.2], [x + Math.cos(a) * 4.6, y + Math.sin(a) * 4.6]]);
        }
        notes.push('sun up');
      }
      const moon = moonPosition(jd);
      const mp = toXY(moon.ra, moon.dec);
      const ph = moonPhase(jd);
      if (mp.alt >= 0) {
        const [x, y] = mp.p;
        const r = 3;
        ink.push(circle(x, y, r, 48));
        // Orient the lit limb toward the Sun on the chart.
        const sunXY = toXY(sun.ra, sun.dec).p;
        const rot = (Math.atan2(sunXY[1] - y, sunXY[0] - x) / RAD);
        const dark = moonDarkPolygon(x, y, r, { fraction: ph.fraction, waxing: true }, 40, false, rot);
        ink.push(...hatchPolygon([dark], rot + 90, 0.4));
        notes.push(`moon ${Math.round(ph.fraction * 100)}% lit`);
      }
    }

    if (v.label) {
      const ty = cy + R + 9 + 15;
      const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
      const when = v.date.replace('T', '  ');
      ink.push(...text(v.loc.name.split(',').slice(0, 2).join(','), { x: cx, y: ty, size: 4.2, font: v.font, align: 'center', tracking: 0.05 }));
      ink.push(...text(`${when}   ${Math.abs(lat).toFixed(2)}° ${ns}  ${Math.abs(lon).toFixed(2)}° ${ew}`, { x: cx, y: ty + 8, size: 2.6, font: v.font, align: 'center', tracking: 0.08 }));
    }

    const tzs = offset >= 0 ? `+${offset}` : `${offset}`;
    ctx.status(`${shown} stars above the horizon · UTC${tzs}${notes.length ? ' · ' + notes.join(' · ') : ''}`);

    const layers: Layer[] = [{ name: 'Stars', color: PALETTE[0], paths: ink }];
    if (figureLines.length) layers.push({ name: 'Constellations', color: PALETTE[1], paths: figureLines });
    if (extra.length) layers.push({ name: 'Grid', color: PALETTE[2], paths: extra });
    return layers;
  },
});
