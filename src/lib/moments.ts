/**
 * Building blocks for the "Moments" posters (the-moment, concert-night, birth-poster,
 * powers-of-ten): a compact star chart, a hatched moon glyph, sunrise/sunset, a day's
 * weather in words, a street circle, a synthetic heartbeat, real time zones, and some
 * typographic helpers for Hershey lettering.
 */
import { circle, type Polyline, type Pt } from '../geom';
import type { Location, ParamDef, Values } from '../params';
import { mulberry32 } from '../random';
import {
  julianDay, lst, moonDarkPolygon, moonPhase, moonPosition, RAD, skyProjector, sunAltAz, sunPosition, toHorizontal,
  zoneOffset, type MoonPhase,
} from './astro';
import { hatchPolygon } from './hatch';
import { measureText, text, type TextOptions } from './hershey';
import { clipToCircle, fetchWays, offsetPolyline, projection, projectWay } from './osm';
import { archiveLatest, fetchArchive } from './weather';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ------------------------------------------------------------------ dates & places

export interface WallTime {
  y: number;
  m: number; // 1..12
  d: number;
  hh: number;
  mm: number;
  hasTime: boolean;
  /** 'YYYY-MM-DD' */
  day: string;
}

export function parseWall(date: string): WallTime {
  const m = /^(-?\d{1,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec((date ?? '').trim());
  if (!m) throw new Error(`Can't read the date "${date}" (want YYYY-MM-DD or YYYY-MM-DDTHH:mm)`);
  return { y: +m[1], m: +m[2], d: +m[3], hh: m[4] ? +m[4] : 0, mm: m[5] ? +m[5] : 0, hasTime: !!m[4], day: `${m[1]}-${m[2]}-${m[3]}` };
}

/** '20 July 1969' (optionally with the weekday). */
export function longDate(w: WallTime, weekday = false): string {
  const s = `${w.d} ${MONTHS[w.m - 1]} ${w.y}`;
  if (!weekday) return s;
  const wd = new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
  return `${WEEKDAYS[wd]}, ${s}`;
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
/** Minutes after local midnight → 'HH:MM'. */
export const hhmm = (min: number) => {
  const t = Math.round(min);
  return `${pad2(Math.floor(t / 60) % 24)}:${pad2(t % 60)}`;
};

/** 29°33'N  95°05'W */
export function coordText(lat: number, lon: number, decimals = false): string {
  if (decimals) return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}   ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
  const dm = (x: number) => {
    const a = Math.abs(x);
    let d = Math.floor(a), m = Math.round((a - d) * 60);
    if (m === 60) { d++; m = 0; }
    return `${d}°${pad2(m)}'`;
  };
  return `${dm(lat)}${lat >= 0 ? 'N' : 'S'}   ${dm(lon)}${lon >= 0 ? 'E' : 'W'}`;
}

/** First part of a geocoded place name ("Royal Albert Hall, Kensington Gore, …" → "Royal Albert Hall"). */
export const shortPlace = (name: string, parts = 1) => name.split(',').slice(0, parts).map((s) => s.trim()).join(', ');

// ------------------------------------------------------------------ time zones

const zoneCache = new Map<string, Promise<string | null>>();

/** IANA time zone of a place (Open-Meteo's `timezone=auto` lookup). Null if unreachable. */
export function placeZone(lat: number, lon: number): Promise<string | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  let p = zoneCache.get(key);
  if (!p) {
    p = (async () => {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&timezone=auto&forecast_days=1&daily=sunrise`;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (r.ok) {
            const j = await r.json();
            if (typeof j.timezone === 'string') return j.timezone;
          }
        } catch {
          /* retry */
        }
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      }
      return null;
    })();
    p.then((z) => { if (!z) zoneCache.delete(key); });
    zoneCache.set(key, p);
  }
  return p;
}

/** UTC offset in hours of an IANA zone at an instant (handles daylight saving and history). */
export function zoneOffsetAt(tz: string, ms: number): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  // Years before 1 come back as era-relative; ignore those edge cases.
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000) / 60;
}

/** Knobs for choosing how local time is interpreted. */
export function zoneParams(): ParamDef[] {
  return [
    {
      type: 'select', key: 'tz', label: 'Time zone', default: 'auto',
      options: [['auto', 'Look up the place'], ['manual', 'UTC offset…']],
      hint: "Looks up the place's zone (with daylight saving); falls back to longitude ÷ 15 offline",
    },
    { type: 'number', key: 'utcOffset', label: 'UTC offset (h)', min: -12, max: 14, step: 0.25, default: 0, show: (v) => v.tz === 'manual' },
  ];
}

export interface Moment {
  wall: WallTime;
  /** Unix ms UTC. */
  ms: number;
  /** UTC offset in hours used. */
  offset: number;
  /** 'UTC−5' etc. */
  zoneLabel: string;
  tz: string | null;
}

export const offsetLabel = (h: number) => {
  if (h === 0) return 'UTC';
  const s = h > 0 ? '+' : '-';
  const a = Math.abs(h);
  const H = Math.floor(a), M = Math.round((a - H) * 60);
  return `UTC${s}${H}${M ? ':' + pad2(M) : ''}`;
};

/** Local wall time at a place → instant, using the zone knobs (`tz`, `utcOffset`). */
export async function resolveMoment(v: Values, loc: Location, date: string): Promise<Moment> {
  const wall = parseWall(date);
  const wallMs = Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm);
  if (v.tz === 'manual') {
    const off = Number(v.utcOffset) || 0;
    return { wall, ms: wallMs - off * 3600_000, offset: off, zoneLabel: offsetLabel(off), tz: null };
  }
  const tz = await placeZone(loc.lat, loc.lon);
  if (tz) {
    try {
      let off = zoneOffsetAt(tz, wallMs);
      off = zoneOffsetAt(tz, wallMs - off * 3600_000);
      return { wall, ms: wallMs - off * 3600_000, offset: off, zoneLabel: offsetLabel(off), tz };
    } catch {
      /* unknown zone in this browser: fall through */
    }
  }
  const off = zoneOffset(loc.lon);
  return { wall, ms: wallMs - off * 3600_000, offset: off, zoneLabel: offsetLabel(off), tz: null };
}

// ------------------------------------------------------------------ sun & moon

export interface SunTimes {
  /** Minutes after local midnight, or null. */
  rise: number | null;
  set: number | null;
  /** When the sun never crosses: 'day' (midnight sun) or 'night' (polar night). */
  polar?: 'day' | 'night';
  /** Day length in minutes. */
  length: number;
}

/** Sunrise and sunset (upper limb with refraction, −0.833°) on a local calendar day. */
export function sunTimes(wall: WallTime, offsetH: number, lat: number, lon: number): SunTimes {
  const t0 = Date.UTC(wall.y, wall.m - 1, wall.d) - offsetH * 3600_000;
  const h0 = -0.833;
  const alt = (min: number) => sunAltAz(t0 + min * 60_000, lat, lon).alt - h0;
  let rise: number | null = null, set: number | null = null;
  let up = 0;
  let prev = alt(0);
  for (let m = 10; m <= 1440; m += 10) {
    const cur = alt(m);
    if (cur > 0) up += 10;
    if ((prev <= 0) !== (cur <= 0)) {
      let lo = m - 10, hi = m;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if ((alt(mid) <= 0) === (prev <= 0)) lo = mid;
        else hi = mid;
      }
      if (prev <= 0 && rise === null) rise = (lo + hi) / 2;
      else if (prev > 0 && set === null) set = (lo + hi) / 2;
    }
    prev = cur;
  }
  const polar = rise === null && set === null ? (alt(720) > 0 ? 'day' : 'night') : undefined;
  const length = rise !== null && set !== null ? (set > rise ? set - rise : 1440 - (rise - set)) : polar === 'day' ? 1440 : up;
  return { rise, set, polar, length };
}

export function phaseName(p: MoonPhase): string {
  const a = p.age; // 0 new, 0.5 full
  if (a < 0.0339 || a > 0.9661) return 'New moon';
  if (Math.abs(a - 0.25) < 0.0339) return 'First quarter';
  if (Math.abs(a - 0.5) < 0.0339) return 'Full moon';
  if (Math.abs(a - 0.75) < 0.0339) return 'Last quarter';
  if (a < 0.25) return 'Waxing crescent';
  if (a < 0.5) return 'Waxing gibbous';
  if (a < 0.75) return 'Waning gibbous';
  return 'Waning crescent';
}

/** A moon disc: outline plus the dark part hatched (northern view; `south` mirrors it). */
export function moonGlyph(cx: number, cy: number, r: number, p: MoonPhase, o: { spacing?: number; angle?: number; south?: boolean } = {}): Polyline[] {
  const out: Polyline[] = [circle(cx, cy, r, Math.max(36, Math.ceil(r * 14)))];
  if (p.fraction < 0.985) {
    const poly = moonDarkPolygon(cx, cy, r * 0.985, p, 64, !!o.south);
    const sp = o.spacing ?? Math.max(0.35, r / 14);
    out.push(...joinHatch(hatchPolygon([poly], o.angle ?? 45, sp, 0.13), sp * 1.7));
    // Terminator: a crisp edge to the lit part.
    if (p.fraction > 0.02) {
      const e = 1 - 2 * p.fraction;
      const side = (p.waxing ? 1 : -1) * (o.south ? -1 : 1);
      const t: Polyline = [];
      for (let k = 0; k <= 40; k++) {
        const a = -Math.PI / 2 + (k / 40) * Math.PI;
        t.push([cx + side * e * Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      out.push(t);
    }
  }
  return out;
}

/** Join consecutive hatch segments into zig-zags where the hop is short. */
export function joinHatch(segs: Polyline[], maxHop: number): Polyline[] {
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

// ------------------------------------------------------------------ star chart

const STAR_BASE = 'https://cdn.jsdelivr.net/gh/ofrohn/d3-celestial@master/data/';
const starCache = new Map<string, Promise<any>>();
function starJSON(name: string): Promise<any> {
  let p = starCache.get(name);
  if (!p) {
    p = fetch(STAR_BASE + name, { signal: AbortSignal.timeout(20000) })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .catch((e) => {
        starCache.delete(name);
        throw new Error(`Couldn't load the star catalogue (${e.message})`);
      });
    starCache.set(name, p);
  }
  return p;
}

export interface SkyData {
  stars: { ra: number; dec: number; mag: number }[];
  figures: number[][][];
}

let skyData: Promise<SkyData> | null = null;
/** d3-celestial stars (to mag 6) and constellation figures, cached. */
export function loadSky(): Promise<SkyData> {
  if (!skyData) {
    skyData = Promise.all([starJSON('stars.6.json'), starJSON('constellations.lines.json')]).then(([s, c]) => ({
      stars: s.features.map((f: any) => ({ ra: f.geometry.coordinates[0], dec: f.geometry.coordinates[1], mag: f.properties.mag })),
      figures: c.features.flatMap((f: any) => f.geometry.coordinates as number[][][]),
    }));
    skyData.catch(() => (skyData = null));
  }
  return skyData;
}

export interface SkyChartOptions {
  cx: number;
  cy: number;
  R: number;
  lat: number;
  lon: number;
  ms: number;
  magLimit?: number;
  starScale?: number;
  /** Gap between constellation lines and stars, mm. */
  gap?: number;
  /** Horizon decoration: 'double' ring with ticks, 'single' ring, or 'none'. */
  frame?: 'double' | 'single' | 'none';
  /** N/E/S/W letters outside the ring. */
  cardinals?: boolean;
  font?: string;
  /** Draw the sun (if up) and the moon (if up) with its phase. */
  sunMoon?: boolean;
  /** Altitude circles at 30° and 60°. */
  grid?: boolean;
}

export interface SkyChart {
  /** Stars, horizon ring, sun & moon. */
  ink: Polyline[];
  figures: Polyline[];
  grid: Polyline[];
  shown: number;
  moonUp: boolean;
  sunUp: boolean;
  /** Outer radius of the decoration (for layout). */
  outer: number;
}

function trimSeg(a: Pt, b: Pt, da: number, db: number): Polyline | null {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L <= da + db + 0.3) return null;
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  return [[a[0] + ux * da, a[1] + uy * da], [b[0] - ux * db, b[1] - uy * db]];
}

function solidDisc(cx: number, cy: number, r: number, pitch = 0.33): Polyline[] {
  if (r < pitch * 0.6) return [circle(cx, cy, Math.max(0.12, r), 8)];
  // The rim, then one continuous spiral inward: a single pen-down per star.
  const rim = circle(cx, cy, r, Math.max(10, Math.ceil(r * 10)));
  const turns = r / pitch;
  const n = Math.max(16, Math.ceil(turns * 18));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const rr = r * (1 - t) + 0.05 * t;
    const a = t * turns * 2 * Math.PI;
    rim.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return [rim];
}

/** The sky above a place at an instant, as a stereographic chart (looking up: east on the left). */
export function skyChart(sky: SkyData, o: SkyChartOptions): SkyChart {
  const { cx, cy, R, lat, lon } = o;
  const magLimit = o.magLimit ?? 5;
  const scale = (o.starScale ?? 1) * Math.max(0.55, Math.min(1.3, R / 80));
  const gap = o.gap ?? 0.7;
  const jd = julianDay(o.ms);
  const L = lst(jd, lon);
  const proj = skyProjector(cx, cy, R, true);
  const toXY = (ra: number, dec: number) => {
    const h = toHorizontal(ra, dec, lat, L);
    return { p: proj(h.alt, h.az), alt: h.alt };
  };
  const ink: Polyline[] = [];
  const figures: Polyline[] = [];
  const grid: Polyline[] = [];
  const frame = o.frame ?? 'double';
  let outer = R;
  if (frame !== 'none') ink.push(circle(cx, cy, R, 360));
  if (frame === 'double') {
    const g = Math.max(1.2, R * 0.025);
    ink.push(circle(cx, cy, R + g, 360));
    for (let a = 0; a < 360; a += 5) {
      const len = a % 90 === 0 ? g : a % 15 === 0 ? g * 0.65 : g * 0.35;
      const s = -Math.sin(a * RAD), c = -Math.cos(a * RAD);
      ink.push([[cx + s * R, cy + c * R], [cx + s * (R + len), cy + c * (R + len)]]);
    }
    outer = R + g;
  }
  if (o.cardinals) {
    const size = Math.max(2, Math.min(3.4, R * 0.04));
    for (const [ch, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
      const rr = outer + 1.6 + size / 2 + 0.3;
      ink.push(...text(ch, { x: cx - Math.sin(a * RAD) * rr, y: cy - Math.cos(a * RAD) * rr + size / 2, size, font: o.font, align: 'center' }));
    }
    outer += 2 + size;
  }
  if (o.grid) {
    for (const alt of [30, 60]) grid.push(circle(cx, cy, R * Math.tan(((90 - alt) / 2) * RAD), 240));
  }

  const radius = (mag: number) => scale * (0.16 + 0.24 * Math.max(0, magLimit + 0.4 - mag));
  const starAt = new Map<string, number>();
  let shown = 0;
  for (const s of sky.stars) {
    if (s.mag > magLimit) continue;
    const { p, alt } = toXY(s.ra, s.dec);
    if (alt < 0) continue;
    const r = radius(s.mag);
    if (Math.hypot(p[0] - cx, p[1] - cy) > R - r - 0.3) continue;
    starAt.set(`${s.ra},${s.dec}`, r);
    shown++;
    ink.push(...solidDisc(p[0], p[1], r));
  }
  for (const line of sky.figures) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const pa = toXY(a[0], a[1]), pb = toXY(b[0], b[1]);
      if (pa.alt < 0 && pb.alt < 0) continue;
      const ga = (starAt.get(`${a[0]},${a[1]}`) ?? 0.25) + gap;
      const gb = (starAt.get(`${b[0]},${b[1]}`) ?? 0.25) + gap;
      if (pa.alt >= 0 && pb.alt >= 0) {
        const seg = trimSeg(pa.p, pb.p, ga, gb);
        if (seg) figures.push(...clipToCircle([seg], cx, cy, R - 0.6));
      } else {
        let dra = b[0] - a[0];
        if (dra > 180) dra -= 360;
        if (dra < -180) dra += 360;
        const pts: Pt[] = [];
        for (let k = 0; k <= 16; k++) pts.push(toXY(a[0] + (dra * k) / 16, a[1] + ((b[1] - a[1]) * k) / 16).p);
        for (const piece of clipToCircle([pts], cx, cy, R - 0.6)) {
          const s = trimSeg(piece[0], piece[piece.length - 1], pa.alt >= 0 ? ga : 0, pb.alt >= 0 ? gb : 0);
          if (s) figures.push(s);
        }
      }
    }
  }
  let sunUp = false, moonUp = false;
  if (o.sunMoon) {
    const sun = sunPosition(jd);
    const sp = toXY(sun.ra, sun.dec);
    const k = Math.max(0.6, R / 90);
    if (sp.alt >= 0) {
      sunUp = true;
      const [x, y] = sp.p;
      ink.push(circle(x, y, 2.2 * k, 40), circle(x, y, 0.5 * k, 12));
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ink.push([[x + Math.cos(a) * 3 * k, y + Math.sin(a) * 3 * k], [x + Math.cos(a) * 4.3 * k, y + Math.sin(a) * 4.3 * k]]);
      }
    }
    const moon = moonPosition(jd);
    const mp = toXY(moon.ra, moon.dec);
    if (mp.alt >= 0) {
      moonUp = true;
      const [x, y] = mp.p;
      const r = 2.8 * k;
      const ph = moonPhase(jd);
      const rot = Math.atan2(sp.p[1] - y, sp.p[0] - x) / RAD;
      ink.push(circle(x, y, r, 48));
      if (ph.fraction < 0.985) {
        const dark = moonDarkPolygon(x, y, r, { fraction: ph.fraction, waxing: true }, 40, false, rot);
        ink.push(...joinHatch(hatchPolygon([dark], rot + 90, 0.38), 0.7));
      }
    }
  }
  return { ink, figures, grid, shown, moonUp, sunUp, outer };
}

// ------------------------------------------------------------------ weather

const WMO: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorms', 96: 'Thunderstorms with hail', 99: 'Thunderstorms with hail',
};
/** WMO weather code (as used by Open-Meteo) → words. */
export const weatherWords = (code: number | null | undefined) => (code == null ? 'Unknown' : WMO[code] ?? `Code ${code}`);

export type DayWeather =
  | { ok: true; tmax: number; tmin: number; precip: number; code: number; words: string; wind: number | null }
  | { ok: false; reason: string };

/** The day's weather from the Open-Meteo archive, or a reason it isn't available. Never throws. */
export async function dayWeather(loc: Location, day: string): Promise<DayWeather> {
  if (day < '1940-01-01') return { ok: false, reason: 'before weather records' };
  if (day > archiveLatest()) return { ok: false, reason: day > new Date().toISOString().slice(0, 10) ? 'still to come' : 'not yet in the archive' };
  try {
    const [pt] = await fetchArchive({
      lat: loc.lat, lon: loc.lon, start: day, end: day,
      daily: ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'weather_code', 'wind_speed_10m_max'],
    });
    const d = pt.daily!;
    const tmax = d.temperature_2m_max?.[0], tmin = d.temperature_2m_min?.[0];
    if (tmax == null || tmin == null) return { ok: false, reason: 'no record for that day' };
    const code = d.weather_code?.[0] ?? null;
    return { ok: true, tmax, tmin, precip: d.precipitation_sum?.[0] ?? 0, code: code ?? -1, words: weatherWords(code), wind: d.wind_speed_10m_max?.[0] ?? null };
  } catch (e) {
    return { ok: false, reason: `unavailable (${(e as Error).message})` };
  }
}

export const temp = (c: number, unit: string) => (unit === 'f' ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`);
export const precipText = (mm: number, unit: string) => (unit === 'f' ? `${(mm / 25.4).toFixed(2)} in` : `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`);

// ------------------------------------------------------------------ streets in a circle

const MAJOR = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link';
const MINOR = 'tertiary|tertiary_link|residential|unclassified|living_street|road|pedestrian';
const PATHS = 'footway|path|cycleway|steps|bridleway|track|service';

export interface StreetCircle {
  major: Polyline[];
  minor: Polyline[];
  paths: Polyline[];
  ways: number;
}

/**
 * The streets within `radiusM` of a place, projected into a circle of `rmm` mm at (cx, cy)
 * and clipped to it. Major roads are doubled (`gap` mm apart).
 */
export async function streetCircle(loc: Location, radiusM: number, cx: number, cy: number, rmm: number, o: { paths?: boolean; gap?: number; status?: (m: string) => void } = {}): Promise<StreetCircle> {
  const re = o.paths ? `${MAJOR}|${MINOR}|${PATHS}` : `${MAJOR}|${MINOR}`;
  const ways = await fetchWays([`["highway"~"^(${re})$"]`], loc, radiusM * 1.04, { status: o.status });
  const proj = projection(loc, radiusM, 2 * rmm, 2 * rmm);
  const major: Polyline[] = [], minor: Polyline[] = [], paths: Polyline[] = [];
  const isMajor = new RegExp(`^(${MAJOR})$`), isMinor = new RegExp(`^(${MINOR})$`);
  const gap = o.gap ?? 0.7;
  for (const w of ways) {
    if (w.tags.area === 'yes') continue;
    if (/^(sidewalk|crossing|traffic_island)$/.test(w.tags.footway ?? '')) continue;
    if (w.tags.service && w.tags.service !== 'alley') continue;
    const line = projectWay(w, proj).map(([x, y]) => [x - rmm + cx, y - rmm + cy] as Pt);
    const h = w.tags.highway;
    if (isMajor.test(h)) {
      if (gap > 0) major.push(offsetPolyline(line, gap / 2), offsetPolyline(line, -gap / 2));
      else major.push(line);
    } else if (isMinor.test(h)) minor.push(line);
    else paths.push(line);
  }
  return {
    major: clipToCircle(major, cx, cy, rmm),
    minor: clipToCircle(minor, cx, cy, rmm),
    paths: clipToCircle(paths, cx, cy, rmm),
    ways: ways.length,
  };
}

// ------------------------------------------------------------------ heartbeat

/** Synthetic ECG (Gaussian P-QRS-T bumps with breathing-modulated RR). Peak R ≈ 1. */
export function ecgSignal(bpm: number, variability: number, seed: number, duration: number): (t: number) => number {
  const rng = mulberry32(seed);
  const beats: { t: number; rr: number; amp: number }[] = [];
  const rr0 = 60 / bpm;
  let t = 0.25 * rr0;
  while (t < duration + 2) {
    const rr = rr0 * (1 + variability * (0.6 * Math.sin((2 * Math.PI * t) / 3.1) + 0.4 * (rng() * 2 - 1)));
    beats.push({ t, rr, amp: 1 + variability * 0.6 * (rng() * 2 - 1) });
    t += rr;
  }
  const waves: [number, number, number][] = [
    [-0.18, 0.12, 0.022], [-0.032, -0.13, 0.009], [0, 1, 0.01], [0.036, -0.24, 0.011], [0.25, 0.27, 0.042],
  ];
  return (x) => {
    let s = 0;
    let lo = 0, hi = beats.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (beats[m].t <= x) lo = m;
      else hi = m;
    }
    for (let k = Math.max(0, lo - 1); k <= Math.min(beats.length - 1, lo + 2); k++) {
      const b = beats[k];
      const q = Math.sqrt(b.rr);
      for (const [off, a, w] of waves) {
        const d = x - (b.t + off * q);
        s += a * b.amp * Math.exp(-(d * d) / (2 * w * w));
      }
    }
    return s;
  };
}

// ------------------------------------------------------------------ typography

/** Text, returning its polylines and width. */
export function line(str: string, o: TextOptions): { paths: Polyline[]; width: number } {
  return { paths: text(str, o), width: measureText(str, o) };
}

/** Largest size (≤ max) at which `str` fits in `width` mm. */
export function fitSize(str: string, width: number, max: number, o: TextOptions = {}): number {
  const w = measureText(str, { ...o, size: max });
  return w <= width ? max : (max * width) / w;
}

/** A thin rule with a small diamond in the middle. */
export function ornamentRule(cx: number, y: number, half: number, d = 1.1): Polyline[] {
  return [
    [[cx - half, y], [cx - d * 2.2, y]],
    [[cx + d * 2.2, y], [cx + half, y]],
    [[cx - d, y], [cx, y - d], [cx + d, y], [cx, y + d], [cx - d, y]],
  ];
}

/** Uppercase with letter-spacing. */
export const caps = (s: string) => s.toUpperCase();

/** Lines laid out in centred columns: each column is a list of [text, options] rows. */
export function columns(cols: { x: number; rows: { s: string; size: number; font?: string; tracking?: number; gap?: number }[] }[], y0: number): { paths: Polyline[]; bottom: number } {
  const paths: Polyline[] = [];
  let bottom = y0;
  for (const c of cols) {
    let y = y0;
    for (const r of c.rows) {
      y += r.size;
      paths.push(...text(r.s, { x: c.x, y, size: r.size, font: r.font, tracking: r.tracking, align: 'center' }));
      y += r.gap ?? r.size * 0.7;
    }
    bottom = Math.max(bottom, y);
  }
  return { paths, bottom };
}

/** A circle path running clockwise (y down) starting at angle a0 (radians, 0 = east). */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number, n = 360): Polyline {
  const pts: Polyline = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/**
 * Lettering for the script fonts with letters actually joined: each glyph is placed so it starts
 * where the previous one's stroke ends (the stock advances leave gaps after some letters, e.g. "s").
 * Other fonts fall back to plain `text`. Returns the polylines and the width.
 */
export function joinedText(str: string, o: { x?: number; y?: number; size: number; font: string; align?: 'left' | 'center' | 'right' }): { paths: Polyline[]; width: number } {
  const script = /^(scripts|scriptc|cursive)$/.test(o.font);
  if (!script) {
    const width = measureText(str, o);
    return { paths: text(str, o), width };
  }
  const glyphs: { paths: Polyline[]; x0: number; x1: number; space: boolean }[] = [];
  for (const ch of str) {
    if (ch === ' ') {
      glyphs.push({ paths: [], x0: 0, x1: o.size * 0.55, space: true });
      continue;
    }
    const paths = text(ch, { x: 0, y: 0, size: o.size, font: o.font });
    let x0 = Infinity, x1 = -Infinity;
    for (const p of paths) for (const [x] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    if (!paths.length) { x0 = 0; x1 = measureText(ch, { size: o.size, font: o.font }); }
    glyphs.push({ paths, x0, x1, space: false });
  }
  // Total width.
  const width = glyphs.reduce((w, g) => w + (g.x1 - g.x0), 0);
  let x = (o.x ?? 0) - (o.align === 'center' ? width / 2 : o.align === 'right' ? width : 0);
  const y = o.y ?? 0;
  const out: Polyline[] = [];
  for (const g of glyphs) {
    if (!g.space) for (const p of g.paths) out.push(p.map(([px, py]) => [px - g.x0 + x, py + y] as Pt));
    x += g.x1 - g.x0;
  }
  return { paths: out, width };
}
