/**
 * Low-precision positional astronomy for plotting (accurate to a fraction of a degree,
 * plenty at plotter scale). Angles are degrees unless noted; times are Unix ms (UTC).
 *
 * Time zones: date knobs hold local wall-clock time at the chosen place. Without a network
 * time-zone lookup we estimate the offset from longitude, rounded to the nearest whole hour
 * (`zoneOffset(lon)`), which matches most civil zones within an hour and ignores daylight
 * saving. Pieces offer a manual UTC offset knob for exact times.
 */
import type { Polyline, Pt } from '../geom';

export const RAD = Math.PI / 180;
const sin = (d: number) => Math.sin(d * RAD);
const cos = (d: number) => Math.cos(d * RAD);
const norm360 = (d: number) => ((d % 360) + 360) % 360;

/** Estimated UTC offset in hours for a longitude: lon / 15, rounded to the nearest hour. */
export const zoneOffset = (lon: number) => Math.round(lon / 15);

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm' as local time with the given UTC offset (hours) → Unix ms UTC. */
export function localToUTC(date: string, offsetHours: number): number {
  const m = /^(-?\d{1,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(date.trim());
  if (!m) throw new Error(`Can't read the date "${date}" (want YYYY-MM-DD or YYYY-MM-DDTHH:mm)`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  return ms - offsetHours * 3600_000;
}

export const julianDay = (ms: number) => ms / 86400000 + 2440587.5;
/** Julian centuries since J2000.0. */
export const centuries = (jd: number) => (jd - 2451545) / 36525;

/** Greenwich mean sidereal time in degrees (Meeus 12.4). */
export function gmst(jd: number): number {
  const T = centuries(jd);
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * T * T - (T * T * T) / 38710000);
}

/** Local sidereal time in degrees; east longitude positive. */
export const lst = (jd: number, lon: number) => norm360(gmst(jd) + lon);

export interface AltAz {
  /** Altitude above the horizon, degrees. */
  alt: number;
  /** Azimuth clockwise from north (east = 90), degrees. */
  az: number;
}

/** Equatorial (RA, Dec) → horizontal for an observer at `lat` with local sidereal time `lstDeg`. */
export function toHorizontal(ra: number, dec: number, lat: number, lstDeg: number): AltAz {
  const H = lstDeg - ra; // hour angle
  const sa = sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sa))) / RAD;
  const y = -cos(dec) * sin(H);
  const x = sin(dec) * cos(lat) - cos(dec) * cos(H) * sin(lat);
  return { alt, az: norm360(Math.atan2(y, x) / RAD) };
}

/** Mean obliquity of the ecliptic. */
export const obliquity = (jd: number) => 23.439291 - 0.0130042 * centuries(jd);

/** Ecliptic (lon, lat) → equatorial (ra, dec). */
export function eclipticToEquatorial(lon: number, lat: number, jd: number): { ra: number; dec: number } {
  const e = obliquity(jd);
  const ra = Math.atan2(sin(lon) * cos(e) - Math.tan(lat * RAD) * sin(e), cos(lon)) / RAD;
  const dec = Math.asin(sin(lat) * cos(e) + cos(lat) * sin(e) * sin(lon)) / RAD;
  return { ra: norm360(ra), dec };
}

export interface SunPos {
  ra: number;
  dec: number;
  /** Apparent ecliptic longitude. */
  lon: number;
  /** Equation of time in minutes (apparent − mean solar time). */
  eqTime: number;
}

/** Sun position (NOAA spreadsheet / Meeus ch. 25 low precision). */
export function sunPosition(jd: number): SunPos {
  const T = centuries(jd);
  const L0 = norm360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + sin(2 * M) * (0.019993 - 0.000101 * T) + sin(3 * M) * 0.000289;
  const trueLon = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLon - 0.00569 - 0.00478 * sin(omega);
  const eps = obliquity(jd) + 0.00256 * cos(omega);
  const ra = norm360(Math.atan2(cos(eps) * sin(lambda), cos(lambda)) / RAD);
  const dec = Math.asin(sin(eps) * sin(lambda)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    (4 / RAD) *
    (y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0) - 0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M));
  return { ra, dec, lon: norm360(lambda), eqTime };
}

/** Sun altitude/azimuth at a place and moment (no refraction). */
export function sunAltAz(ms: number, lat: number, lon: number): AltAz & SunPos {
  const jd = julianDay(ms);
  const s = sunPosition(jd);
  return { ...s, ...toHorizontal(s.ra, s.dec, lat, lst(jd, lon)) };
}

/** Moon's geocentric position, ~0.3° (main terms of Meeus ch. 47). */
export function moonPosition(jd: number): { ra: number; dec: number; lon: number; lat: number } {
  const d = jd - 2451545;
  const T = d / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T;
  const D = 297.8501921 + 445267.1114034 * T;
  const M = 357.5291092 + 35999.0502909 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const F = 93.272095 + 483202.0175233 * T;
  const lon =
    Lp + 6.289 * sin(Mp) + 1.274 * sin(2 * D - Mp) + 0.658 * sin(2 * D) + 0.214 * sin(2 * Mp) - 0.186 * sin(M) - 0.114 * sin(2 * F);
  const lat = 5.128 * sin(F) + 0.281 * sin(Mp + F) + 0.278 * sin(Mp - F) + 0.173 * sin(2 * D - F);
  const eq = eclipticToEquatorial(norm360(lon), lat, jd);
  return { ...eq, lon: norm360(lon), lat };
}

export interface MoonPhase {
  /** Illuminated fraction 0 (new) … 1 (full). */
  fraction: number;
  /** Phase angle i (Sun–Moon–Earth), degrees: 180 new, 0 full. */
  phaseAngle: number;
  /** Elongation-based age through the cycle, 0..1 (0 new, 0.5 full). */
  age: number;
  waxing: boolean;
}

/** Moon phase (Meeus ch. 48 low precision). */
export function moonPhase(jd: number): MoonPhase {
  const T = centuries(jd);
  const D = norm360(297.8501921 + 445267.1114034 * T);
  const M = 357.5291092 + 35999.0502909 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const i = norm360(
    180 - D - 6.289 * sin(Mp) + 2.1 * sin(M) - 1.274 * sin(2 * D - Mp) - 0.658 * sin(2 * D) - 0.214 * sin(2 * Mp) - 0.11 * sin(D),
  );
  const pa = i > 180 ? 360 - i : i;
  const sunLon = sunPosition(jd).lon;
  const elong = norm360(moonPosition(jd).lon - sunLon);
  return { fraction: (1 + cos(pa)) / 2, phaseAngle: pa, age: elong / 360, waxing: elong < 180 };
}

/**
 * The dark part of a moon disc as a closed polygon (for hatching), in a frame where the
 * lit limb is on the right while waxing (the northern-hemisphere view). Pass `flip` to
 * mirror it (southern hemisphere). `rotate` turns it by degrees (clockwise on paper).
 */
export function moonDarkPolygon(cx: number, cy: number, r: number, p: Pick<MoonPhase, 'fraction' | 'waxing'>, n = 48, flip = false, rotate = 0): Pt[] {
  const e = 1 - 2 * p.fraction; // terminator x = e · half-chord
  const side = (p.waxing ? 1 : -1) * (flip ? -1 : 1); // +1: lit limb on the right
  const pts: Pt[] = [];
  // Dark limb (opposite the lit one), top → bottom.
  for (let k = 0; k <= n; k++) {
    const a = -Math.PI / 2 + (k / n) * Math.PI;
    pts.push([-side * Math.cos(a) * r, Math.sin(a) * r]);
  }
  // Terminator, bottom → top.
  for (let k = n; k >= 0; k--) {
    const a = -Math.PI / 2 + (k / n) * Math.PI;
    pts.push([side * e * Math.cos(a) * r, Math.sin(a) * r]);
  }
  const c = Math.cos(rotate * RAD), s = Math.sin(rotate * RAD);
  return pts.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

/** Terminator line alone (open polyline) for the same frame as `moonDarkPolygon`. */
export function moonTerminator(cx: number, cy: number, r: number, p: Pick<MoonPhase, 'fraction' | 'waxing'>, n = 48, flip = false): Polyline {
  const e = 1 - 2 * p.fraction;
  const side = (p.waxing ? 1 : -1) * (flip ? -1 : 1);
  const out: Polyline = [];
  for (let k = 0; k <= n; k++) {
    const a = -Math.PI / 2 + (k / n) * Math.PI;
    out.push([cx + side * e * Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/**
 * Stereographic sky projection: zenith at (cx, cy), horizon on a circle of radius R.
 * North is up. `lookingUp` (a star chart held overhead) puts east on the left; otherwise
 * (a sun-path diagram seen from above, like a map) east is on the right.
 * Points below the horizon land outside R.
 */
export function skyProjector(cx: number, cy: number, R: number, lookingUp: boolean) {
  const sx = lookingUp ? -1 : 1;
  return (alt: number, az: number): Pt => {
    const r = R * Math.tan(((90 - alt) / 2) * RAD);
    return [cx + sx * sin(az) * r, cy - cos(az) * r];
  };
}

/** Radius on the stereographic chart for an altitude (horizon = R). */
export const stereoRadius = (alt: number, R: number) => R * Math.tan(((90 - alt) / 2) * RAD);
