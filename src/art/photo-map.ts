import { circle, clipToRect, polylineLength, smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { contourLevels, loadTerrainFor } from '../lib/elevation';
import { parseExif, isJpeg } from '../lib/exif';
import { loadFiles, type FileRef } from '../lib/files';
import { FONT_OPTIONS, text } from '../lib/hershey';
import { fetchWays, offsetPolyline } from '../lib/osm';
import { boxOf, distanceKm, equirectangular, fitBounds, loadCoastlines, mapLines, naturalEarth, projectAll, type Box } from '../lib/world';
import { mulberry32, type Rng } from '../random';
import { defineArtwork } from './types';

export interface PhotoPoint {
  lat: number;
  lon: number;
  /** "YYYY-MM-DDTHH:MM:SS" if known. */
  date?: string;
  name: string;
}

/** Reads GPS and capture time from JPEG photos. HEIC and other formats are counted, not read. */
export async function readPhotos(files: { name: string; type: string; blob: Blob }[]) {
  const points: PhotoPoint[] = [];
  let other = 0, noGps = 0;
  for (const f of files) {
    // EXIF sits at the start of the file; 256 KB covers it (and any embedded thumbnail before GPS).
    const head = new Uint8Array(await f.blob.slice(0, 256 * 1024).arrayBuffer());
    if (!isJpeg(head)) { other++; continue; }
    const e = parseExif(head);
    if (e.lat === undefined || e.lon === undefined) { noGps++; continue; }
    points.push({ lat: e.lat, lon: e.lon, date: e.date, name: f.name });
  }
  return { points, other, noGps };
}

/** A seeded, made-up week's round trip in the Scottish Highlands: a handful of stops a day or so apart. */
export function demoTrip(rng: Rng): PhotoPoint[] {
  const pts: PhotoPoint[] = [];
  const c = { lat: 57.08, lon: -3.9 }; // the Cairngorms
  const n = 7 + Math.floor(rng() * 3);
  const a0 = rng() * Math.PI * 2, dir = rng() < 0.5 ? 1 : -1;
  const rx = 32 + rng() * 18, ry = 22 + rng() * 14, tilt = rng() * Math.PI;
  const day = new Date(Date.UTC(2025, 5, 2));
  for (let i = 0; i < n; i++) {
    // Round a tilted ellipse, most of the way back to the start, with some wander.
    const a = a0 + dir * (i / n) * Math.PI * 1.85 + (rng() - 0.5) * 0.35;
    const r = 0.8 + rng() * 0.35;
    const ex = Math.cos(a) * rx * r, ey = Math.sin(a) * ry * r;
    const xKm = ex * Math.cos(tilt) - ey * Math.sin(tilt), yKm = ex * Math.sin(tilt) + ey * Math.cos(tilt);
    const t = new Date(day.getTime());
    t.setUTCHours(9 + Math.floor(rng() * 9), Math.floor(rng() * 60));
    pts.push({ lat: c.lat + yKm / 111.32, lon: c.lon + xKm / (111.32 * Math.cos((c.lat * Math.PI) / 180)), date: t.toISOString().slice(0, 19), name: `demo-${i + 1}.jpg` });
    day.setUTCDate(day.getUTCDate() + (rng() < 0.75 ? 1 : 2));
  }
  return pts;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d: string, withYear: boolean) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}${withYear ? ` ${d.slice(0, 4)}` : ''}`;

/** Centripetal Catmull-Rom through the points (no overshoot loops). */
function catmullRom(p: Pt[], perSeg = 24): Polyline {
  if (p.length < 3) return p.slice();
  const out: Polyline = [];
  const P = [p[0], ...p, p[p.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const tj = (a: Pt, b: Pt) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
    for (let k = 0; k < perSeg; k++) {
      const t = t1 + ((t2 - t1) * k) / perSeg;
      const L = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
        const d = tb - ta || 1e-6;
        return [((tb - t) / d) * a[0] + ((t - ta) / d) * b[0], ((tb - t) / d) * a[1] + ((t - ta) / d) * b[1]];
      };
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
      out.push(L(B1, B2, t1, t2));
    }
  }
  out.push(p[p.length - 1]);
  return out;
}

/** Splits lines wherever they pass within the given circles or boxes. */
function cutAway(lines: Polyline[], circles: { c: Pt; r: number }[], boxes: Box[], step = 0.25): Polyline[] {
  const hit = ([x, y]: Pt) => circles.some(({ c, r }) => (x - c[0]) ** 2 + (y - c[1]) ** 2 < r * r) || boxes.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
  const out: Polyline[] = [];
  for (const l of lines) {
    let cur: Polyline = [];
    for (let i = 0; i < l.length; i++) {
      const pts: Pt[] = [];
      if (i === 0) pts.push(l[0]);
      else {
        const a = l[i - 1], b = l[i];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let s = 1; s <= n; s++) pts.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
      }
      for (const q of pts) {
        if (hit(q)) {
          if (cur.length > 1) out.push(cur);
          cur = [];
        } else cur.push(q);
      }
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

/** Web Mercator in "world pixels" at zoom 0 (256 px wide world). */
const merc = (lat: number, lon: number): Pt => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return [((lon + 180) / 360) * 256, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256];
};
const unmerc = ([x, y]: Pt): { lat: number; lon: number } => ({
  lon: (x / 256) * 360 - 180,
  lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 256))) * 180) / Math.PI,
});

const niceStep = (raw: number) => {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * p >= raw) return s * p;
  return 10 * p;
};

export interface TripOptions {
  base: 'auto' | 'coast' | 'terrain' | 'streets' | 'none';
  pad: number;
  dot: number;
  labels: boolean;
  summary: boolean;
  font: string;
}

/** Draws the trip: base map chosen by extent, a smooth line through the photos in date order, dots and labels. */
export async function drawTrip(points: PhotoPoint[], W: number, H: number, o: TripOptions, status: (m: string) => void) {
  // Date order (undated photos keep their file order, after the dated ones).
  const pts = points.map((p, i) => ({ ...p, i })).sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : a.date ? -1 : b.date ? 1 : a.i - b.i));
  // Extent.
  let spanKm = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) spanKm = Math.max(spanKm, distanceKm([pts[i].lon, pts[i].lat], [pts[j].lon, pts[j].lat]));
  let tripKm = 0;
  for (let i = 1; i < pts.length; i++) tripKm += distanceKm([pts[i - 1].lon, pts[i - 1].lat], [pts[i].lon, pts[i].lat]);
  const base = o.base === 'auto' ? (spanKm > 500 ? 'coast' : spanKm > 4 ? 'terrain' : 'streets') : o.base;

  const dates = pts.map((p) => p.date).filter((d): d is string => !!d);
  const years = new Set(dates.map((d) => d.slice(0, 4)));
  const sameDay = dates.length > 1 && new Set(dates.map((d) => d.slice(0, 10))).size === 1;
  const footer = o.summary ? 12 : 0;
  const AH = H - footer;
  const pad = 1 + (2 * o.pad) / 100;

  // Projection: equirectangular / Natural Earth for wide spreads, Web Mercator locally.
  let toMm: (lat: number, lon: number) => Pt;
  let mapLinesMm: Polyline[] = [];
  let mapInfo = '';
  if (base === 'coast') {
    // Centre on the circular mean longitude so trips across the antimeridian stay together.
    const lon0 = (Math.atan2(pts.reduce((s, p) => s + Math.sin((p.lon * Math.PI) / 180), 0), pts.reduce((s, p) => s + Math.cos((p.lon * Math.PI) / 180), 0)) * 180) / Math.PI;
    const latM = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const proj = spanKm > 6000 ? naturalEarth(lon0) : equirectangular(lon0, Math.max(-60, Math.min(60, latM)));
    const fp = pts.map((p) => proj.forward([p.lon, p.lat]));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of fp) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const minExt = 0.02; // about a degree
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const hw = (Math.max(minExt, x1 - x0) * pad) / 2, hh = (Math.max(minExt, y1 - y0) * pad) / 2;
    const fit = fitBounds([cx - hw, cy - hh, cx + hw, cy + hh], W, AH, 0);
    toMm = (lat, lon) => fit.map(proj.forward([lon, lat]));
    status(`Loading coastlines…`);
    const res = spanKm > 4000 ? '110m' : '50m';
    const coast = await loadCoastlines(res);
    mapLinesMm = clipToRect(mapLines(projectAll(coast, proj), fit), 0, 0, W, H);
    mapInfo = ` · coastlines (${res})`;
  } else {
    const mp = pts.map((p) => merc(p.lat, p.lon));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of mp) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const latC = (unmerc([0, (y0 + y1) / 2]).lat * Math.PI) / 180;
    const mPerPx = (40075016.686 * Math.cos(latC)) / 256;
    const minExt = 600 / mPerPx; // at least ~600 m across
    const bw = Math.max(minExt, x1 - x0) * pad, bh = Math.max(minExt, y1 - y0) * pad;
    const scale = Math.min(W / bw, AH / bh);
    const rcx = (x0 + x1) / 2, rcy = (y0 + y1) / 2;
    const fromMerc = ([x, y]: Pt): Pt => [W / 2 + (x - rcx) * scale, AH / 2 + (y - rcy) * scale];
    toMm = (lat, lon) => fromMerc(merc(lat, lon));
    const pc: Pt = [rcx, rcy + (H / 2 - AH / 2) / scale];
    const centre = unmerc(pc);
    if (base === 'terrain') {
      const pageW = W / scale, aspect = W / H;
      let view: { zoom: number; span: number; k: number } | null = null;
      for (let zoom = 15; zoom >= 4 && !view; zoom--)
        for (let span = 1; span <= 4 && !view; span++) {
          const px = (span * 256) / 2 ** zoom;
          const cw = aspect >= 1 ? px : px * aspect;
          if (cw >= pageW) view = { zoom, span, k: pageW / cw };
        }
      if (view) {
        const map = await loadTerrainFor({ loc: { name: 'the photos', ...centre }, zoom: view.zoom, span: view.span, blur: 1, clampSea: false }, { width: W, height: H, status });
        const k = view.k;
        const metres = (u: number, vv: number) => map.metres(0.5 + (u - 0.5) * k, 0.5 + (vv - 0.5) * k);
        let lo = Infinity, hi = -Infinity;
        for (let j = 0; j <= 64; j++) for (let i = 0; i <= 64; i++) { const m = Math.max(0, metres(i / 64, j / 64)); lo = Math.min(lo, m); hi = Math.max(hi, m); }
        const interval = niceStep(Math.max(1, hi - lo) / 9);
        const levels: number[] = [];
        for (let m = Math.max(interval, Math.ceil(lo / interval) * interval); m < hi; m += interval) levels.push(m);
        // Sea level as the coastline (0.5 m: tiles store open sea as ~0 m).
        const coastAt = lo <= 0.5 ? [0.5] : [];
        const sets = contourLevels(metres, W, H, [...coastAt, ...levels], 0.5);
        // Smooth, and drop the specks that noisy low-zoom tiles produce.
        mapLinesMm = sets.flat().map((l) => smooth(l, 0.8)).filter((l) => polylineLength(l) > 5);
        mapInfo = ` · contours every ${interval} m · terrain z${view.zoom}`;
      }
    } else if (base === 'streets') {
      const radius = (Math.hypot(W, H) / 2 / scale) * mPerPx;
      status('Loading streets…');
      const ways = await fetchWays(['["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|road)$"]'], { name: 'photos', ...centre }, Math.min(5000, radius), { status });
      mapLinesMm = clipToRect(ways.filter((w) => w.tags.area !== 'yes').map((w) => w.geometry.map((g) => toMm(g.lat, g.lon))), 0, 0, W, H);
      mapInfo = ` · ${ways.length} streets`;
    }
  }

  // The trip.
  const P = pts.map((p) => toMm(p.lat, p.lon));
  const dotR = o.dot;
  const path = catmullRom(P);
  const trip: Polyline[] = [];
  const dots = P.map((c) => ({ c, r: dotR + 0.9 }));
  for (const [i, c] of P.entries()) {
    trip.push(circle(c[0], c[1], dotR, 32));
    if (i === 0) trip.push(circle(c[0], c[1], dotR * 0.45, 16)); // the first photo gets a dot in the middle
  }
  trip.push(...cutAway([path, offsetPolyline(path, 0.3)], dots, []));

  // Date labels: try eight spots round each dot, keep the one clearest of the line and other labels.
  const ink: Polyline[] = [];
  const boxes: Box[] = [];
  if (o.labels) {
    const size = 2.6;
    const clearOfPath = (q: Pt) => {
      let d = Infinity;
      for (let k = 0; k < path.length; k += 2) d = Math.min(d, Math.hypot(path[k][0] - q[0], path[k][1] - q[1]));
      for (const p of P) d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1]) - dotR);
      return d;
    };
    pts.forEach((p, i) => {
      const label = p.date ? (sameDay ? p.date.slice(11, 16) : dayLabel(p.date, years.size > 1)) : `${i + 1}`;
      let best: { lines: Polyline[]; box: Box; score: number } | null = null;
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const lines0 = text(label, { x: 0, y: 0, size, font: o.font, align: 'center' });
        const b0 = boxOf(lines0);
        const hw = (b0[2] - b0[0]) / 2, hh = (b0[3] - b0[1]) / 2;
        const d = dotR + 1.6;
        const c: Pt = [P[i][0] + Math.cos(ang) * (d + hw), P[i][1] + Math.sin(ang) * (d + hh)];
        const lines = lines0.map((l) => l.map(([x, y]) => [x + c[0], y + c[1] + hh] as Pt));
        const box = boxOf(lines, 0.8);
        if (box[0] < 0 || box[1] < 0 || box[2] > W || box[3] > AH) continue;
        if (boxes.some((o2) => box[0] < o2[2] && box[2] > o2[0] && box[1] < o2[3] && box[3] > o2[1])) continue;
        const corners: Pt[] = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]], c];
        const score = Math.min(...corners.map(clearOfPath)) + (Math.abs(Math.sin(ang)) < 0.1 ? 0.3 : 0);
        if (!best || score > best.score) best = { lines, box, score };
      }
      if (best) {
        boxes.push(best.box);
        ink.push(...best.lines);
      }
    });
  }
  if (o.summary) {
    const first = dates[0], last = dates[dates.length - 1];
    const when = first ? (first.slice(0, 10) === last.slice(0, 10) ? dayLabel(first, true) : `${dayLabel(first, years.size > 1)} - ${dayLabel(last, true)}`) : '';
    const dist = tripKm >= 100 ? `${Math.round(tripKm).toLocaleString('en-US')} km` : `${tripKm.toFixed(1)} km`;
    const line = [`${pts.length} photo${pts.length > 1 ? 's' : ''}`, when, dist].filter(Boolean).join('  ·  ');
    const t = text(line, { x: W / 2, y: H, size: 3, font: o.font, align: 'center', tracking: 0.1 });
    ink.push(...t);
    boxes.push(boxOf(t, 2));
  }
  // The map stays clear of the dots, the trip line and the lettering.
  const lineClear = path.filter((_, k) => k % 2 === 0).map((c) => ({ c, r: 1 }));
  const mapLinesCut = cutAway(clipToRect(mapLinesMm, 0, 0, W, AH - (footer ? 2 : 0)), [...dots.map((d) => ({ c: d.c, r: d.r + 0.4 })), ...lineClear], boxes);
  const info = `${Math.round(spanKm)} km across · ${base === 'coast' ? 'coastline' : base} map${mapInfo}`;
  const layers: Layer[] = [
    { name: 'Map', color: PALETTE[2], paths: mapLinesCut },
    { name: 'Trip', color: PALETTE[1], paths: trip },
    { name: 'Lettering', color: PALETTE[0], paths: ink },
  ];
  return { layers: layers.filter((l) => l.paths.length), info };
}

export default defineArtwork({
  slug: 'photo-map',
  title: 'Where our photos were taken',
  description: 'Drop in your holiday photos: their GPS tags are plotted on a map that fits them, joined in the order they were taken.',
  order: 102,
  series: 'Moments',
  paper: { paper: 'a4', orientation: 'portrait', margin: 18 },
  params: [
    { type: 'file', key: 'photos', label: 'Photos (JPEG)', accept: 'image/jpeg', multiple: true, default: [], hint: 'Location and time come from each photo’s EXIF. HEIC isn’t supported: export as JPEG (keeping location). Without photos, a made-up Highlands trip is drawn' },
    { type: 'seed', key: 'seed', label: 'Demo trip', default: 4, show: (v) => !(v.photos as FileRef[])?.length },
    { type: 'select', key: 'base', label: 'Map', options: [['auto', 'Automatic (by spread)'], ['coast', 'Coastlines'], ['terrain', 'Terrain contours'], ['streets', 'Streets'], ['none', 'None']], default: 'auto', hint: 'Automatic: coastlines for trips over 500 km, terrain for a region, streets for a town' },
    { type: 'number', key: 'pad', label: 'Padding (%)', min: 2, max: 80, step: 1, default: 18 },
    { type: 'number', key: 'dot', label: 'Dot size (mm)', min: 0.5, max: 5, step: 0.1, default: 1.6 },
    { type: 'checkbox', key: 'labels', label: 'Date labels', default: true },
    { type: 'checkbox', key: 'summary', label: 'Summary line', default: true },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
  ],
  caption: () => '',
  async generate(v, ctx) {
    const files = await loadFiles(v.photos);
    let points: PhotoPoint[];
    let note = '';
    if (files.length) {
      ctx.status(`Reading ${files.length} photos…`);
      const r = await readPhotos(files);
      points = r.points;
      const skipped = [r.other ? `${r.other} not JPEG (HEIC/PNG aren't supported: export as JPEG)` : '', r.noGps ? `${r.noGps} without location` : ''].filter(Boolean).join(', ');
      if (!points.length) throw new Error(`None of the ${files.length} photos has a GPS location${skipped ? ` (${skipped})` : ''}`);
      note = skipped ? ` · skipped ${skipped}` : '';
    } else points = demoTrip(mulberry32((v.seed | 0) * 7919 + 1));
    const { layers, info } = await drawTrip(points, ctx.width, ctx.height, { base: v.base, pad: v.pad, dot: v.dot, labels: v.labels, summary: v.summary, font: v.font }, ctx.status);
    ctx.status(`${files.length ? '' : 'Demo trip · '}${points.length} photos · ${info}${note}`);
    return layers;
  },
});
