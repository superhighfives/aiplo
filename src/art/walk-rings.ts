import { circle, clipToRect, polylineLength, smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { contourLevels } from '../lib/elevation';
import { clipToCircle, fetchWays, offsetPolyline, osmParams, projection, projectWay } from '../lib/osm';
import { defineArtwork } from './types';

// Everything with a highway tag that people can walk on (motorways, trunk roads and non-roads excluded).
const NOT_WALKABLE = 'motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway|bus_guideway|abandoned|platform|corridor|elevator|services|rest_area|escape|busway';
// Ground distance (m) over which a street's travel time spreads into the surrounding blocks;
// farther than this from any walkable way counts as unreachable (water, rail yards, big parks).
const SPREAD_M = 140;
const BIG = 1e9;
// A jump in time between neighbouring cells of more than this many ring intervals marks a barrier.
const BARRIER = 1.2;

/** Binary-heap Dijkstra over an adjacency list; returns seconds from `src` (Infinity if unreachable). */
function dijkstra(n: number, adj: number[][], wt: number[][], src: number): Float64Array {
  const d = new Float64Array(n).fill(Infinity);
  d[src] = 0;
  const heap: [number, number][] = [[0, src]];
  const push = (e: [number, number]) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [du, u] = pop();
    if (du > d[u]) continue;
    const a = adj[u], w = wt[u];
    for (let k = 0; k < a.length; k++) {
      const nd = du + w[k];
      if (nd < d[a[k]]) {
        d[a[k]] = nd;
        push([nd, a[k]]);
      }
    }
  }
  return d;
}

export default defineArtwork({
  slug: 'walk-rings',
  title: 'How far you can walk',
  description: 'Isochrones on the real street network: a ring for every few minutes you could walk from one spot, from OpenStreetMap.',
  order: 11,
  paper: { paper: 'a4', orientation: 'portrait', margin: 20 },
  params: [
    ...osmParams({ name: 'Rialto, Venice', lat: 45.4380, lon: 12.3359 }, 1000, { min: 300, max: 2500, step: 50 }),
    { type: 'number', key: 'speed', label: 'Walking speed (km/h)', min: 2, max: 8, step: 0.1, default: 4.8 },
    { type: 'number', key: 'every', label: 'Ring every (min)', min: 1, max: 30, step: 1, default: 2 },
    { type: 'number', key: 'emphasis', label: 'Double every Nth ring', min: 0, max: 10, step: 1, default: 5, hint: '0 = off. Doubles e.g. every 10 minutes for weight' },
    { type: 'select', key: 'crop', label: 'Crop', default: 'rect', options: [['circle', 'Circle'], ['rect', 'Rectangle']] },
    { type: 'select', key: 'network', label: 'Streets', default: 'all', options: [['none', 'None'], ['roads', 'Roads only'], ['all', 'Roads and paths']], hint: 'The walkable network, drawn on its own pen' },
    { type: 'number', key: 'curves', label: 'Curves (mm)', min: 0, max: 6, step: 0.1, default: 3 },
    { type: 'number', key: 'cell', label: 'Resolution (mm)', min: 0.4, max: 3, step: 0.1, default: 0.8 },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const proj = projection(v.loc, v.radius, W, H);
    const fetchR = (v.crop === 'circle' ? v.radius : proj.cornerRadius) * 1.08;
    ctx.status(`Loading walkable streets around ${v.loc.name}…`);
    const ways = await fetchWays([`["highway"]["highway"!~"^(${NOT_WALKABLE})$"]["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"]["area"!="yes"]`], v.loc, fetchR, { status: ctx.status });
    if (!ways.length) throw new Error(`No walkable streets found near ${v.loc.name}`);

    // Graph: OSM node ids shared between ways are the junctions.
    const index = new Map<number, number>();
    const pos: Pt[] = [];
    const adj: number[][] = [];
    const wt: number[][] = [];
    const metresPerSec = (v.speed * 1000) / 3600;
    const mmToSec = 1 / proj.scale / metresPerSec;
    const edges: [number, number][] = [];
    const id = (osm: number, p: Pt) => {
      let i = index.get(osm);
      if (i === undefined) {
        i = pos.length;
        index.set(osm, i);
        pos.push(p);
        adj.push([]);
        wt.push([]);
      }
      return i;
    };
    const lines: { line: Polyline; path: boolean }[] = [];
    for (const w of ways) {
      const line = projectWay(w, proj);
      const hw = w.tags.highway;
      const path = /^(footway|path|cycleway|steps|pedestrian|bridleway|track)$/.test(hw);
      if (!/^(sidewalk|crossing)$/.test(w.tags.footway ?? '')) lines.push({ line, path });
      const slow = hw === 'steps' ? 1.6 : 1;
      for (let k = 1; k < line.length; k++) {
        const a = id(w.nodes[k - 1], line[k - 1]);
        const b = id(w.nodes[k], line[k]);
        if (a === b) continue;
        const s = Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]) * mmToSec * slow;
        adj[a].push(b); wt[a].push(s);
        adj[b].push(a); wt[b].push(s);
        edges.push([a, b]);
      }
    }

    // Start at the node nearest the chosen point (which is the centre of the drawing).
    let src = 0, best = Infinity;
    pos.forEach(([x, y], i) => {
      const d = (x - proj.cx) ** 2 + (y - proj.cy) ** 2;
      if (d < best && adj[i].length) { best = d; src = i; }
    });
    ctx.status(`Routing over ${pos.length} junctions…`);
    const t = dijkstra(pos.length, adj, wt, src);

    // Splat travel times onto the same grid `contourLevels` samples: each cell takes the quickest
    // time of any street point within SPREAD_M, plus the time to walk the rest of the way to it.
    const cell = v.cell;
    const nx = Math.max(2, Math.round(W / cell) + 1);
    const ny = Math.max(2, Math.round(H / cell) + 1);
    const gx = W / (nx - 1), gy = H / (ny - 1);
    const g = new Float32Array(nx * ny).fill(BIG);
    const spread = SPREAD_M * proj.scale;
    const ri = Math.ceil(spread / gx), rj = Math.ceil(spread / gy);
    const splat = (x: number, y: number, tt: number) => {
      const ci = Math.round(x / gx), cj = Math.round(y / gy);
      if (ci < -ri || cj < -rj || ci > nx + ri || cj > ny + rj) return;
      for (let j = Math.max(0, cj - rj); j <= Math.min(ny - 1, cj + rj); j++) {
        const dy = j * gy - y;
        for (let i = Math.max(0, ci - ri); i <= Math.min(nx - 1, ci + ri); i++) {
          const d = Math.hypot(i * gx - x, dy);
          if (d > spread) continue;
          const val = tt + d * mmToSec;
          const k = j * nx + i;
          if (val < g[k]) g[k] = val;
        }
      }
    };
    const step = Math.min(gx, gy);
    for (const [a, b] of edges) {
      const ta = t[a], tb = t[b];
      if (!isFinite(ta) && !isFinite(tb)) continue;
      const [ax, ay] = pos[a], [bx, by] = pos[b];
      const L = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(L / step));
      for (let s = 0; s <= n; s++) {
        const f = s / n;
        splat(ax + (bx - ax) * f, ay + (by - ay) * f, Math.min(ta + f * L * mmToSec, tb + (1 - f) * L * mmToSec));
      }
    }

    // Levels up to the slowest point in view.
    let maxT = 0;
    for (const val of g) if (val < BIG && val > maxT) maxT = val;
    const every = v.every * 60;
    const levels: number[] = [];
    for (let s = every; s < maxT && levels.length < 200; s += every) levels.push(s);
    const sample = (u: number, w: number) => g[Math.round(w * (ny - 1)) * nx + Math.round(u * (nx - 1))];
    // Where reachable ground meets unreachable ground (open water, rail yards), or the two sides of a
    // canal with no bridge, every later ring would trace the same edge. Where time jumps by more than
    // a ring interval between neighbouring cells, rings would pile up: cut them there so they end at
    // the shore instead.
    const cliff = BARRIER * every;
    const nearUnreachable = ([x, y]: Pt) => {
      const ci = Math.round(x / gx), cj = Math.round(y / gy);
      for (let j = Math.max(0, cj - 1); j <= Math.min(ny - 1, cj + 1); j++)
        for (let i = Math.max(0, ci - 1); i <= Math.min(nx - 1, ci + 1); i++) {
          const a = g[j * nx + i];
          if (a >= BIG) return true;
          if (i + 1 < nx && Math.abs(g[j * nx + i + 1] - a) > cliff) return true;
          if (j + 1 < ny && Math.abs(g[(j + 1) * nx + i] - a) > cliff) return true;
        }
      return false;
    };
    const cutAtEdge = (l: Polyline): Polyline[] => {
      const out: Polyline[] = [];
      let cur: Polyline = [];
      for (const p of l) {
        if (nearUnreachable(p)) {
          if (cur.length > 1) out.push(cur);
          cur = [];
        } else cur.push(p);
      }
      if (cur.length > 1) out.push(cur);
      return out;
    };
    const traced = contourLevels(sample, W, H, levels, cell).map((ls) => ls.flatMap(cutAtEdge));

    const crop = (ps: Polyline[]) => (v.crop === 'circle' ? clipToCircle(ps, proj.cx, proj.cy, proj.r) : clipToRect(ps, 0, 0, W, H));
    const rings: Polyline[] = [];
    const minLen = 3 * cell + 2;
    traced.forEach((ls, k) => {
      const strong = v.emphasis > 0 && (k + 1) % v.emphasis === 0;
      for (const l of ls) {
        if (polylineLength(l) < minLen) continue; // specks around single blocks
        const sm = smooth(l, v.curves);
        if (strong) rings.push(offsetPolyline(sm, 0.35), offsetPolyline(sm, -0.35));
        else rings.push(sm);
      }
    });
    const [sx, sy] = pos[src];
    const marker: Polyline[] = [circle(sx, sy, 1.6, 32), [[sx - 2.6, sy], [sx + 2.6, sy]], [[sx, sy - 2.6], [sx, sy + 2.6]]];

    const net = v.network === 'none' ? [] : lines.filter((l) => v.network === 'all' || !l.path).map((l) => l.line);
    const border: Polyline[] = v.crop === 'circle' ? [circle(proj.cx, proj.cy, proj.r, 360)] : [];
    ctx.status(`${v.loc.name} · ${ways.length} ways · ${levels.length} rings every ${v.every} min · ${Math.round(maxT / 60)} min to the farthest point in view`);
    const layers: Layer[] = [
      { name: 'Streets', color: PALETTE[0], paths: [...crop(net), ...border] },
      { name: 'Rings', color: PALETTE[1], paths: [...crop(rings), ...marker] },
    ];
    return layers.filter((l) => l.paths.length);
  },
});
