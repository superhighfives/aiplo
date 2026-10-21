import { circle, clipToRect, smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { contourLevels, loadTerrainFor, ridges } from '../lib/elevation';
import { FONT_OPTIONS, measureText, text } from '../lib/hershey';
import { formatDuration, MODE_OPTIONS, route, type RouteMode } from '../lib/routing';
import { boxOf, type Box } from '../lib/world';
import type { Location, PlaceList } from '../params';
import { defineArtwork } from './types';

// The Stelvio Pass from Trafoi: the famous stack of hairpins up to 2757 m.
const FROM: Location = { name: 'Trafoi', lat: 46.5527, lon: 10.5115 };
const TO: Location = { name: 'Passo dello Stelvio', lat: 46.5287, lon: 10.453 };

/** Web Mercator in "world pixels" at zoom 0 (256 px wide world). */
const merc = (lat: number, lon: number): Pt => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return [((lon + 180) / 360) * 256, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256];
};
const unmerc = ([x, y]: Pt): { lat: number; lon: number } => ({
  lon: (x / 256) * 360 - 180,
  lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 256))) * 180) / Math.PI,
});

/** Short, letterable place name: first part of a geocoded name, accents folded to ASCII. */
export const shortName = (n: string) =>
  (n.split(',')[0] || n).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e·°]/g, '').trim();

const haversineKm = (a: [number, number], b: [number, number]) => {
  const k = Math.PI / 180;
  const dLat = (b[1] - a[1]) * k, dLon = (b[0] - a[0]) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * k) * Math.cos(b[1] * k) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
};

const niceStep = (raw: number, steps = [1, 2, 2.5, 5, 10]) => {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const s of steps) if (s * p >= raw) return s * p;
  return 10 * p;
};

/** A coarse raster mask of "keep clear" areas: thick polylines and boxes. Lines are cut where they enter it. */
function clearMask(W: number, H: number, cell = 0.25) {
  const nx = Math.ceil(W / cell) + 1, ny = Math.ceil(H / cell) + 1;
  const m = new Uint8Array(nx * ny);
  const set = (i: number, j: number) => { if (i >= 0 && i < nx && j >= 0 && j < ny) m[j * nx + i] = 1; };
  return {
    line(p: Polyline, r: number) {
      const rr = Math.ceil(r / cell);
      const stamp = (x: number, y: number) => {
        const ci = Math.round(x / cell), cj = Math.round(y / cell);
        for (let j = -rr; j <= rr; j++) for (let i = -rr; i <= rr; i++) if (i * i + j * j <= rr * rr) set(ci + i, cj + j);
      };
      for (let k = 1; k < p.length; k++) {
        const [ax, ay] = p[k - 1], [bx, by] = p[k];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / cell));
        for (let s = 0; s <= n; s++) stamp(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n);
      }
    },
    box([x0, y0, x1, y1]: Box) {
      for (let j = Math.floor(y0 / cell); j <= Math.ceil(y1 / cell); j++) for (let i = Math.floor(x0 / cell); i <= Math.ceil(x1 / cell); i++) set(i, j);
    },
    hit: ([x, y]: Pt) => {
      const i = Math.round(x / cell), j = Math.round(y / cell);
      return i >= 0 && i < nx && j >= 0 && j < ny && m[j * nx + i] === 1;
    },
    cut(lines: Polyline[]): Polyline[] {
      const out: Polyline[] = [];
      for (const l of lines) {
        let cur: Polyline = [];
        for (let k = 0; k < l.length; k++) {
          // Subdivide so short masked spans inside long segments are caught.
          const pts: Pt[] = [l[k]];
          if (k > 0) {
            const a = l[k - 1], b = l[k];
            const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / cell);
            pts.length = 0;
            for (let s = 1; s <= n; s++) pts.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
            if (!n) pts.push(b);
          }
          for (const q of pts) {
            if (this.hit(q)) {
              if (cur.length > 1) out.push(cur);
              cur = [];
            } else cur.push(q);
          }
        }
        if (cur.length > 1) out.push(cur);
      }
      return out;
    },
  };
}

const MODE_WORD: Record<RouteMode, string> = { driving: 'by car', cycling: 'by bike', walking: 'on foot' };

export default defineArtwork({
  slug: 'the-route',
  title: 'The route',
  description: 'A journey from one place to another, routed along real roads and drawn over the terrain it crosses, with distance markers.',
  order: 101,
  series: 'Moments',
  paper: { paper: 'a4', orientation: 'landscape', margin: 18 },
  params: [
    { type: 'location', key: 'from', label: 'From', default: FROM },
    { type: 'location', key: 'to', label: 'To', default: TO },
    { type: 'places', key: 'via', label: 'Via (optional)', default: { text: '', places: [] }, hint: 'Waypoints in order, one per line' },
    { type: 'select', key: 'mode', label: 'Travel', options: MODE_OPTIONS, default: 'driving' },
    { type: 'select', key: 'terrain', label: 'Terrain', options: [['contours', 'Contours'], ['ridges', 'Ridgelines'], ['none', 'None']], default: 'contours' },
    { type: 'number', key: 'interval', label: 'Contour interval (m)', min: 0, max: 500, step: 5, default: 0, show: (v) => v.terrain === 'contours', hint: '0 = automatic' },
    { type: 'number', key: 'rows', label: 'Ridge rows', min: 20, max: 200, step: 1, default: 90, show: (v) => v.terrain === 'ridges' },
    { type: 'number', key: 'ridgeHeight', label: 'Ridge height (mm)', min: 1, max: 40, step: 0.5, default: 14, show: (v) => v.terrain === 'ridges' },
    { type: 'number', key: 'pad', label: 'Padding (%)', min: 0, max: 60, step: 1, default: 14 },
    { type: 'number', key: 'tick', label: 'Marker every (km)', min: 0, max: 500, step: 1, default: 0, hint: '0 = automatic' },
    { type: 'checkbox', key: 'tickLabels', label: 'Number the markers', default: true },
    { type: 'checkbox', key: 'names', label: 'Letter the place names', default: true },
    { type: 'checkbox', key: 'summary', label: 'Distance and time line', default: true },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
    { type: 'number', key: 'weight', label: 'Route strokes', min: 1, max: 4, step: 1, default: 2, hint: 'Parallel passes for a bolder route line' },
    { type: 'number', key: 'clearance', label: 'Gap round route (mm)', min: 0, max: 4, step: 0.1, default: 1.2 },
  ],
  caption: (v) => `${shortName(v.from.name)} to ${shortName(v.to.name)}`,
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const via = ((v.via as PlaceList)?.places ?? []) as Location[];
    const stops: Location[] = [v.from, ...via, v.to];
    const mode = v.mode as RouteMode;
    const r = await route(stops, mode, { status: ctx.status });
    const coords = r.coords;
    if (coords.length < 2) throw new Error('The router returned an empty route');

    // Fit the route (Mercator) into the page, above a footer for the summary line.
    const footer = v.summary ? 16 : 0;
    const mpts = coords.map(([lon, lat]) => merc(lat, lon));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of mpts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = 1 + (2 * v.pad) / 100;
    const AH = H - footer;
    const bw = Math.max(1e-7, x1 - x0) * pad, bh = Math.max(1e-7, y1 - y0) * pad;
    const scale = Math.min(W / bw, AH / bh); // mm per zoom-0 px
    const rcx = (x0 + x1) / 2, rcy = (y0 + y1) / 2;
    const toMm = ([x, y]: Pt): Pt => [W / 2 + (x - rcx) * scale, AH / 2 + (y - rcy) * scale];
    // Page centre in Mercator (the terrain is loaded around it).
    const pc: Pt = [rcx, rcy + (H / 2 - AH / 2) / scale];

    // Terrain: the most detailed (zoom, span) whose crop covers the page.
    let height: ((u: number, vv: number) => number) | null = null;
    let metres: ((u: number, vv: number) => number) | null = null;
    let zinfo = '';
    if (v.terrain !== 'none') {
      const pageW = W / scale;
      const aspect = W / H;
      let view: { zoom: number; span: number; k: number } | null = null;
      for (let zoom = 15; zoom >= 4 && !view; zoom--)
        for (let span = 1; span <= 4 && !view; span++) {
          const px = (span * 256) / 2 ** zoom;
          const cw = aspect >= 1 ? px : px * aspect;
          if (cw >= pageW) view = { zoom, span, k: pageW / cw };
        }
      if (view) {
        const map = await loadTerrainFor({ loc: { name: 'the route', ...unmerc(pc) }, zoom: view.zoom, span: view.span, blur: 1, clampSea: true }, ctx);
        const k = view.k;
        height = (u, vv) => map.height(0.5 + (u - 0.5) * k, 0.5 + (vv - 0.5) * k);
        metres = (u, vv) => Math.max(0, map.metres(0.5 + (u - 0.5) * k, 0.5 + (vv - 0.5) * k));
        zinfo = ` · terrain z${view.zoom}`;
      }
    }

    // Route in mm; in ridgeline mode, drape it over the ridge surface.
    const E = v.ridgeHeight;
    const drape = v.terrain === 'ridges' && height
      ? ([x, y]: Pt): Pt => [x, E + (y / H) * (H - E) - height!(x / W, y / H) * E]
      : (p: Pt) => p;
    const flat = smooth(mpts.map(toMm), 0.3);
    const routeMm = flat.map(drape);

    // Cumulative km along the route, mapped onto the smoothed polyline by index fraction.
    const cumKm = [0];
    for (let i = 1; i < coords.length; i++) cumKm.push(cumKm[i - 1] + haversineKm(coords[i - 1], coords[i]));
    const totalKm = cumKm[cumKm.length - 1];
    const projAt = (km: number): { p: Pt; t: Pt } => {
      let i = 1;
      while (i < cumKm.length - 1 && cumKm[i] < km) i++;
      const f = (km - cumKm[i - 1]) / (cumKm[i] - cumKm[i - 1] || 1);
      const a = toMm(mpts[i - 1]), b = toMm(mpts[i]);
      const p: Pt = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      // Tangent over a short window (raw OSRM vertices can be very close together).
      let j0 = i - 1, j1 = i;
      while (j0 > 0 && Math.hypot(toMm(mpts[j0])[0] - p[0], toMm(mpts[j0])[1] - p[1]) < 2) j0--;
      while (j1 < mpts.length - 1 && Math.hypot(toMm(mpts[j1])[0] - p[0], toMm(mpts[j1])[1] - p[1]) < 2) j1++;
      const A = drape(toMm(mpts[j0])), B = drape(toMm(mpts[j1]));
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      return { p: drape(p), t: [(B[0] - A[0]) / L, (B[1] - A[1]) / L] };
    };
    // Distance from a point to the route (for choosing label sides).
    const routeClearance = (q: Pt) => {
      let best = Infinity;
      for (let i = 0; i < routeMm.length; i += 2) best = Math.min(best, Math.hypot(routeMm[i][0] - q[0], routeMm[i][1] - q[1]));
      return best;
    };

    const ink: Polyline[] = [];
    const red: Polyline[] = [];
    const mask = clearMask(W, H);
    const labelBoxes: Box[] = [];
    const fits = (b: Box) => b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && !labelBoxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

    // Route line, possibly doubled.
    const n = Math.max(1, Math.round(v.weight));
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 0.3;
      red.push(off === 0 ? routeMm : offsetLine(routeMm, off));
    }
    mask.line(routeMm, v.clearance + 0.15 * n);

    // Milestones.
    const step = v.tick > 0 ? v.tick : niceStep(totalKm / 10, [1, 2, 5, 10]);
    let ticks = 0;
    const tickSize = 2.3;
    for (let km = step; km < totalKm - step * 0.4; km += step) {
      const { p, t } = projAt(km);
      const nrm: Pt = [-t[1], t[0]];
      const tl = 2.2;
      red.push([[p[0] - nrm[0] * tl, p[1] - nrm[1] * tl], [p[0] + nrm[0] * tl, p[1] + nrm[1] * tl]]);
      ticks++;
      if (v.tickLabels) {
        const label = String(Math.round(km * 10) / 10);
        const w = measureText(label, { size: tickSize, font: v.font });
        // Try both sides, a little way out along the normal; keep the one furthest from the route.
        let best: { box: Box; lines: Polyline[]; score: number } | null = null;
        for (const s of [1, -1]) {
          for (const dist of [4.5, 6.5]) {
            const c: Pt = [p[0] + nrm[0] * s * (dist + w / 2 * Math.abs(nrm[0])), p[1] + nrm[1] * s * (dist + tickSize / 2 * Math.abs(nrm[1]))];
            const lines = text(label, { x: c[0], y: c[1] + tickSize / 2, size: tickSize, font: v.font, align: 'center' });
            const box = boxOf(lines, 0.8);
            if (!fits(box)) continue;
            const corners: Pt[] = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]], c];
            const score = Math.min(...corners.map(routeClearance)) - dist * 0.05;
            if (!best || score > best.score) best = { box, lines, score };
          }
        }
        if (best && best.score > 0.6) {
          labelBoxes.push(best.box);
          ink.push(...best.lines);
          mask.box(best.box);
        }
      }
    }

    // Stops: start ring, end bullseye, small rings at waypoints; names lettered beside them.
    const stopPts = stops.map((s) => drape(toMm(merc(s.lat, s.lon))));
    // Snap the markers onto the route ends (the router snaps the places to the nearest road).
    stopPts[0] = routeMm[0];
    stopPts[stopPts.length - 1] = routeMm[routeMm.length - 1];
    for (let i = 1; i < stopPts.length - 1; i++) {
      let best = routeMm[0], bd = Infinity;
      for (const q of routeMm) {
        const d = Math.hypot(q[0] - stopPts[i][0], q[1] - stopPts[i][1]);
        if (d < bd) { bd = d; best = q; }
      }
      stopPts[i] = best;
    }
    stopPts.forEach((p, i) => {
      const last = i === stopPts.length - 1;
      const R = i === 0 || last ? 2 : 1.3;
      red.push(circle(p[0], p[1], R, 40));
      if (last) red.push(circle(p[0], p[1], 0.9, 24), circle(p[0], p[1], 0.3, 12));
      mask.line([p, p], R + v.clearance);
    });
    if (v.names) {
      const size = 4;
      stops.forEach((s, i) => {
        const name = shortName(s.name);
        if (!name) return;
        const p = stopPts[i];
        const sz = i === 0 || i === stops.length - 1 ? size : size * 0.75;
        const w = measureText(name, { size: sz, font: v.font });
        let best: { lines: Polyline[]; box: Box; score: number } | null = null;
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const d = 5;
          const c: Pt = [p[0] + Math.cos(ang) * (d + w / 2 * Math.abs(Math.cos(ang))), p[1] + Math.sin(ang) * (d + sz / 2 * Math.abs(Math.sin(ang)))];
          const lines = text(name, { x: c[0], y: c[1] + sz / 2, size: sz, font: v.font, align: 'center' });
          const box = boxOf(lines, 1);
          if (!fits(box)) continue;
          const corners: Pt[] = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]], [(box[0] + box[2]) / 2, box[1]], [(box[0] + box[2]) / 2, box[3]]];
          const score = Math.min(...corners.map(routeClearance)) + (Math.abs(Math.cos(ang)) > 0.9 ? 0.5 : 0);
          if (!best || score > best.score) best = { lines, box, score };
        }
        if (best) {
          labelBoxes.push(best.box);
          ink.push(...best.lines);
          mask.box(best.box);
        }
      });
    }

    const distLabel = totalKm >= 100 ? `${Math.round(totalKm)} km` : `${totalKm.toFixed(1)} km`;
    if (v.summary) {
      const a = shortName(v.from.name), b = shortName(v.to.name);
      const line1 = `${a}  -  ${b}`.toUpperCase();
      const line2 = `${distLabel}  ·  ${formatDuration(r.duration)} ${MODE_WORD[mode]}${via.length ? `  ·  via ${via.map((p) => shortName(p.name)).join(', ')}` : ''}`;
      const s1 = Math.min(4.2, (W * 0.9) / Math.max(1, measureText(line1, { size: 1, font: v.font, tracking: 0.25 })));
      const s2 = Math.min(3, (W * 0.9) / Math.max(1, measureText(line2, { size: 1, font: v.font })));
      const l1 = text(line1, { x: W / 2, y: H - s2 - 4.5, size: s1, font: v.font, align: 'center', tracking: 0.25 });
      const l2 = text(line2, { x: W / 2, y: H, size: s2, font: v.font, align: 'center' });
      ink.push(...l1, ...l2);
      mask.box(boxOf([...l1, ...l2], 2.5));
    }

    // Terrain linework, cut clear of the route and lettering.
    let terrainLines: Polyline[] = [];
    let terrainInfo = '';
    if (height && metres && v.terrain === 'contours') {
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j <= 64; j++) for (let i = 0; i <= 64; i++) { const m = metres(i / 64, j / 64); lo = Math.min(lo, m); hi = Math.max(hi, m); }
      const interval = v.interval > 0 ? v.interval : niceStep((hi - lo) / 36, [1, 2, 2.5, 5, 10]);
      const levels: number[] = [];
      for (let m = Math.ceil((lo + 1e-6) / interval) * interval; m < hi; m += interval) levels.push(m);
      if (levels.length > 400) throw new Error(`Contour interval ${interval} m gives ${levels.length} contours: try a larger one`);
      terrainLines = contourLevels(metres, W, H, levels, 0.5).flat().map((l) => smooth(l, 0.8));
      terrainInfo = ` · contours every ${interval} m (${Math.round(lo)}–${Math.round(hi)} m)`;
    } else if (height && v.terrain === 'ridges') {
      terrainLines = ridges(height, W, H, { rows: v.rows, height: E, perspective: 0, breakSteeperThan: 80 });
    }
    terrainLines = mask.cut(clipToRect(terrainLines, 0, 0, W, H));

    ctx.status(`${distLabel} · ${formatDuration(r.duration)} ${MODE_WORD[mode]} · ${ticks} markers every ${step} km${terrainInfo}${zinfo}`);
    const layers: Layer[] = [
      { name: 'Terrain', color: PALETTE[0], paths: terrainLines },
      { name: 'Route', color: PALETTE[1], paths: red },
      { name: 'Lettering', color: PALETTE[0], paths: ink },
    ];
    // Lettering shares the terrain pen: merge so it's one pen swap.
    layers[0].paths.push(...layers[2].paths);
    return layers.slice(0, 2).filter((l) => l.paths.length);
  },
});

/** A polyline offset sideways by d mm (simple per-vertex normals; fine for small offsets on smooth lines). */
function offsetLine(p: Polyline, d: number): Polyline {
  return p.map((q, i) => {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    return [q[0] - (dy / L) * d, q[1] + (dx / L) * d] as Pt;
  });
}
