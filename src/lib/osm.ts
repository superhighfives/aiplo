import type { Polyline, Pt } from '../geom';
import type { Location, ParamDef } from '../params';

/**
 * OpenStreetMap via Overpass.
 *
 * - `overpass(query)` POSTs `data=[out:json][timeout:…];<query>`. It is deliberately gentle,
 *   because Overpass blocks addresses that make too many requests:
 *   - results are cached in memory and in IndexedDB for 30 days, so a place is fetched once,
 *     not on every knob tweak, thumbnail or reload;
 *   - only one request runs at a time per worker, and identical requests share one fetch;
 *   - a server that refuses or rate-limits us is skipped for a while (it's remembered),
 *     so retries go to the server that's actually answering, honouring Retry-After.
 * - `fetchWays(filters, loc, radius)` returns ways (with `out geom` geometry) matching tag filters.
 * - `projection(loc, radius, W, H)` maps lon/lat → mm (see the comment there for the scale rule).
 */

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const NAMES: Record<string, string> = { [ENDPOINTS[0]]: 'the main server', [ENDPOINTS[1]]: 'the mirror' };
const RETRY_STATUS = new Set([406, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;
const CACHE_DAYS = 30;

export interface OsmWay {
  type: 'way';
  id: number;
  tags: Record<string, string>;
  /** Node ids, parallel to `geometry`. */
  nodes: number[];
  geometry: { lat: number; lon: number }[];
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  tags: Record<string, string>;
  members: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
}

type Element = OsmWay | OsmRelation | { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> };

const cache = new Map<string, Promise<Element[]>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Node's fetch sends a UA that overpass-api.de rejects (406). Browsers send their own and forbid overriding it.
const isNode = !!(globalThis as any).process?.versions?.node && typeof (globalThis as any).WorkerGlobalScope === 'undefined';

// ---------- persistent cache (IndexedDB; silently skipped where unavailable, e.g. Node) ----------

function idb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open('aiplo-cache', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('overpass');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function cacheGet(key: string): Promise<Element[] | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction('overpass').objectStore('overpass').get(key);
    req.onsuccess = () => {
      const v = req.result as { at: number; elements: Element[] } | undefined;
      resolve(v && Date.now() - v.at < CACHE_DAYS * 864e5 ? v.elements : null);
    };
    req.onerror = () => resolve(null);
  });
}

async function cachePut(key: string, elements: Element[]) {
  const db = await idb();
  if (!db) return;
  try {
    db.transaction('overpass', 'readwrite').objectStore('overpass').put({ at: Date.now(), elements }, key);
  } catch {
    /* quota or similar: just don't cache */
  }
}

// ---------- server health ----------

/** Endpoint → time (ms) until which we leave it alone. */
const downUntil = new Map<string, number>();
const why = new Map<string, string>();

function markDown(url: string, ms: number, reason: string) {
  downUntil.set(url, Math.max(downUntil.get(url) ?? 0, Date.now() + ms));
  why.set(url, reason);
}

/** Endpoints to try: healthy ones first (in preference order), then whichever recovers soonest. */
function ranked(): string[] {
  const now = Date.now();
  const ready = (u: string) => Math.max(now, downUntil.get(u) ?? 0);
  return [...ENDPOINTS].sort((a, b) => ready(a) - ready(b));
}

// One request at a time: Overpass allows only a couple of concurrent requests per address.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

async function attempt(url: string, body: string, timeoutMs: number): Promise<Element[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (isNode) headers['User-Agent'] = 'aiplo (pen-plotter sketchbook)';
  const res = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 0;
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retryAfter });
  }
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // Overpass reports runtime errors (timeouts, out of memory) as HTML/XML with a 200.
    throw Object.assign(new Error('an error page (server busy or query too large)'), { status: 503 });
  }
  if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark) && !json.elements?.length) {
    throw Object.assign(new Error(json.remark), { status: 504 });
  }
  return json.elements ?? [];
}

/** Runs an Overpass QL query (without the `[out:json]` header), with caching, server fallback and retries. */
export function overpass(query: string, opts: { timeout?: number; status?: (m: string) => void } = {}): Promise<Element[]> {
  const timeout = opts.timeout ?? 60;
  const full = `[out:json][timeout:${timeout}];${query}`;
  const hit = cache.get(full);
  if (hit) return hit;
  const p = (async () => {
    const stored = await cacheGet(full);
    if (stored) return stored;
    return serial(async () => {
      const body = 'data=' + encodeURIComponent(full);
      let lastErr: any;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const url = ranked()[0];
        const wait = (downUntil.get(url) ?? 0) - Date.now();
        if (wait > 0) {
          // Every server is resting; wait for the soonest (briefly), or give up.
          if (wait > 90000) break;
          opts.status?.(`OpenStreetMap is busy; waiting ${Math.ceil(wait / 1000)} s before trying again…`);
          await sleep(wait);
        }
        if (i > 0) opts.status?.(`Asking OpenStreetMap via ${NAMES[url]} (attempt ${i + 1}/${MAX_ATTEMPTS})…`);
        const t0 = Date.now();
        try {
          const elements = await attempt(url, body, (timeout + 15) * 1000);
          downUntil.delete(url);
          void cachePut(full, elements);
          return elements;
        } catch (e: any) {
          lastErr = e;
          if (e?.status !== undefined && !RETRY_STATUS.has(e.status)) throw new Error(`OpenStreetMap request failed: ${e.message}`);
          if (e?.status === 429) markDown(url, Math.max(e.retryAfter * 1000, 60000), 'rate limit');
          else if (e?.status === undefined && e?.name !== 'TimeoutError' && Date.now() - t0 < 5000)
            // An instant network error is almost always a refused connection: Overpass blocks
            // addresses that made too many requests, usually for a while. Leave it alone.
            markDown(url, 20 * 60000, 'refusing connections');
          else markDown(url, 5000 * 2 ** Math.min(i, 3), e?.name === 'TimeoutError' ? 'timed out' : e?.status ? `HTTP ${e.status}` : 'network error');
          opts.status?.(`OpenStreetMap: ${NAMES[url]} ${why.get(url)}${e?.status ? '' : ` (${e?.message ?? e})`}`);
        }
      }
      const main = why.get(ENDPOINTS[0]) === 'refusing connections' && (downUntil.get(ENDPOINTS[0]) ?? 0) > Date.now();
      throw new Error(
        main
          ? 'OpenStreetMap is unavailable: the main Overpass server is refusing connections from your network (it temporarily blocks addresses that make lots of requests, usually for an hour or so) and the mirror is busy. Try again later; places you have already loaded are cached and still work.'
          : `OpenStreetMap (Overpass) is busy right now (${lastErr?.message ?? lastErr}). Try again in a minute, or use a smaller radius.`,
      );
    });
  })();
  cache.set(full, p);
  p.catch(() => cache.delete(full)); // don't cache failures
  return p;
}

/**
 * Ways matching any of the tag filters (e.g. `["highway"~"^(primary|secondary)$"]`) within `radius`
 * metres of `loc`, with geometry. Ways crossing the radius come back whole.
 */
export async function fetchWays(filters: string[], loc: Location, radius: number, opts: { timeout?: number; status?: (m: string) => void } = {}): Promise<OsmWay[]> {
  const around = `(around:${Math.round(radius)},${loc.lat.toFixed(6)},${loc.lon.toFixed(6)})`;
  const q = `(${filters.map((f) => `way${f}${around};`).join('')});out geom;`;
  const els = await overpass(q, opts);
  return els.filter((e): e is OsmWay => e.type === 'way' && Array.isArray((e as OsmWay).geometry));
}

/** Like `fetchWays` but also returns relations (e.g. multipolygons) with member geometry. */
export async function fetchWaysAndRelations(filters: string[], loc: Location, radius: number, opts: { timeout?: number; status?: (m: string) => void } = {}) {
  const around = `(around:${Math.round(radius)},${loc.lat.toFixed(6)},${loc.lon.toFixed(6)})`;
  const q = `(${filters.map((f) => `way${f}${around};relation${f}${around};`).join('')});out geom;`;
  const els = await overpass(q, opts);
  return {
    ways: els.filter((e): e is OsmWay => e.type === 'way' && Array.isArray((e as OsmWay).geometry)),
    relations: els.filter((e): e is OsmRelation => e.type === 'relation'),
  };
}

export interface Projection {
  /** lon/lat → mm in the drawing area. */
  (lon: number, lat: number): Pt;
  /** mm per metre on the ground. */
  scale: number;
  /** Centre of the drawing area in mm. */
  cx: number;
  cy: number;
  /** Radius of the chosen area in mm (half the short side). */
  r: number;
  /** Metres from the centre to the drawing area's farthest corner: query this far to fill a rectangle. */
  cornerRadius: number;
}

/**
 * Local equirectangular projection around `loc` (fine at city scale; distortion is negligible
 * within a few tens of km). Scale rule, used by every OSM piece: the `radius` circle exactly fits
 * the drawing area's SHORT side (it's "contained"), so a circular crop shows exactly the
 * requested area and a rectangular crop shows extra ground along the long side. Pieces that crop
 * to the rectangle should fetch out to `cornerRadius` so the corners aren't empty.
 */
export function projection(loc: Location, radius: number, W: number, H: number): Projection {
  const R = 6371008.8;
  const k = Math.PI / 180;
  const r = Math.min(W, H) / 2;
  const scale = r / radius;
  const cosLat = Math.cos(loc.lat * k);
  const cx = W / 2, cy = H / 2;
  const f = ((lon: number, lat: number): Pt => [cx + (lon - loc.lon) * k * R * cosLat * scale, cy - (lat - loc.lat) * k * R * scale]) as Projection;
  f.scale = scale;
  f.cx = cx;
  f.cy = cy;
  f.r = r;
  f.cornerRadius = (Math.hypot(W, H) / 2) / scale;
  return f;
}

export const projectWay = (w: OsmWay, proj: Projection): Polyline => w.geometry.map((g) => proj(g.lon, g.lat));

/** Shared knobs: location and radius (metres). */
export function osmParams(loc: Location, radius: number, range: { min: number; max: number; step?: number } = { min: 100, max: 3000, step: 50 }): ParamDef[] {
  return [
    { type: 'location', key: 'loc', label: 'Location', default: loc },
    { type: 'number', key: 'radius', label: 'Radius (m)', min: range.min, max: range.max, step: range.step ?? 50, default: radius, hint: 'Ground distance from the centre to the edge of the short side' },
  ];
}

// ---- geometry helpers shared by the OSM pieces ----

/** Clip polylines to a circle (segment-wise, exact intersections). */
export function clipToCircle(paths: Polyline[], cx: number, cy: number, r: number): Polyline[] {
  const out: Polyline[] = [];
  const r2 = r * r;
  const inside = (p: Pt) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 <= r2;
  for (const p of paths) {
    let cur: Polyline | null = null;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const fx = a[0] - cx, fy = a[1] - cy;
      const A = dx * dx + dy * dy;
      let t0 = 0, t1 = 1;
      if (A < 1e-12) {
        if (!inside(a)) { cur = null; continue; }
      } else {
        const B = 2 * (fx * dx + fy * dy);
        const C = fx * fx + fy * fy - r2;
        const disc = B * B - 4 * A * C;
        if (disc <= 0) { cur = null; continue; }
        const s = Math.sqrt(disc);
        t0 = Math.max(0, (-B - s) / (2 * A));
        t1 = Math.min(1, (-B + s) / (2 * A));
        if (t0 >= t1) { cur = null; continue; }
      }
      const lerp = (t: number): Pt => [a[0] + dx * t, a[1] + dy * t];
      if (!cur || t0 > 0) {
        cur = [lerp(t0)];
        out.push(cur);
      }
      cur.push(lerp(t1));
      if (t1 < 1) cur = null;
    }
  }
  return out.filter((q) => q.length > 1);
}

/** True if any point of the polyline is within the circle (cheap pre-filter). */
export const touchesCircle = (p: Polyline, cx: number, cy: number, r: number) => p.some(([x, y]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);

/** Offset an open or closed polyline sideways by `d` mm (positive = left of travel), with mitred joins (limited). */
export function offsetPolyline(p: Polyline, d: number): Polyline {
  const n = p.length;
  if (n < 2 || d === 0) return p;
  const closed = n > 2 && Math.hypot(p[0][0] - p[n - 1][0], p[0][1] - p[n - 1][1]) < 1e-9;
  const normal = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  const segN: Pt[] = [];
  for (let i = 0; i < n - 1; i++) segN.push(normal(p[i], p[i + 1]));
  const out: Polyline = [];
  for (let i = 0; i < n; i++) {
    let n1: Pt | undefined = segN[i - 1], n2: Pt | undefined = segN[i];
    if (closed && (i === 0 || i === n - 1)) { n1 = segN[n - 2]; n2 = segN[0]; }
    let nx: number, ny: number;
    if (!n1) [nx, ny] = n2!;
    else if (!n2) [nx, ny] = n1;
    else {
      const mx = n1[0] + n2[0], my = n1[1] + n2[1];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) [nx, ny] = n2;
      else {
        const cos = (mx / ml) * n1[0] + (my / ml) * n1[1];
        const m = 1 / Math.max(cos, 0.5); // miter limit 2×
        nx = (mx / ml) * m;
        ny = (my / ml) * m;
      }
    }
    out.push([p[i][0] + nx * d, p[i][1] + ny * d]);
  }
  return out;
}

/** `count` parallel copies of a line spread across `width` mm (count 1 = the line itself). */
export function parallelStrokes(p: Polyline, count: number, width: number): Polyline[] {
  if (count <= 1) return [p];
  const out: Polyline[] = [];
  for (let k = 0; k < count; k++) out.push(offsetPolyline(p, (k / (count - 1) - 0.5) * width));
  return out;
}

/**
 * Join open member lines (e.g. a multipolygon's outer ways) end-to-end into rings.
 * Returns closed rings, plus any chains that couldn't be closed (e.g. cut off by the query area).
 */
export function stitchRings(parts: Polyline[], tol = 1e-6): { closed: Polyline[]; open: Polyline[] } {
  const key = (p: Pt) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`;
  const closed: Polyline[] = [];
  const pending: Polyline[] = [];
  for (const p of parts) {
    if (p.length < 2) continue;
    if (key(p[0]) === key(p[p.length - 1]) && p.length > 3) closed.push(p);
    else pending.push(p.slice());
  }
  const open: Polyline[] = [];
  while (pending.length) {
    let chain = pending.pop()!;
    for (let grew = true; grew && key(chain[0]) !== key(chain[chain.length - 1]); ) {
      grew = false;
      const end = key(chain[chain.length - 1]);
      const start = key(chain[0]);
      for (let i = 0; i < pending.length; i++) {
        const q = pending[i];
        const qs = key(q[0]), qe = key(q[q.length - 1]);
        if (qs === end) chain = chain.concat(q.slice(1));
        else if (qe === end) chain = chain.concat(q.slice(0, -1).reverse());
        else if (qe === start) chain = q.concat(chain.slice(1));
        else if (qs === start) chain = q.slice().reverse().concat(chain.slice(1));
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (chain.length > 3 && key(chain[0]) === key(chain[chain.length - 1])) closed.push(chain);
    else open.push(chain);
  }
  return { closed, open };
}
