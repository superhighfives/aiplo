import { smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { defineArtwork } from './types';

const MAX_NODES = 4000;

export default defineArtwork({
  slug: 'differential-growth',
  title: 'Differential growth',
  description: 'A line that keeps growing but can’t cross itself, folding into coral and brain-like meanders.',
  order: 66,
  paper: { paper: 'square', margin: 15 },
  params: [
    { type: 'seed', key: 'seed', label: 'Seed', default: 3 },
    { type: 'select', key: 'shape', label: 'Start from', options: [['circle', 'Circle'], ['line', 'Line'], ['ring', 'Several circles']], default: 'circle' },
    { type: 'number', key: 'iterations', label: 'Iterations', min: 10, max: 3000, step: 10, default: 900 },
    { type: 'number', key: 'radius', label: 'Repulsion radius (mm)', min: 1, max: 10, step: 0.1, default: 4.5, hint: 'Spacing between neighbouring folds' },
    { type: 'number', key: 'maxNodes', label: 'Max nodes', min: 200, max: MAX_NODES, step: 100, default: 4000, hint: 'Growth stops here (keeps it fast and bounded)' },
    { type: 'number', key: 'alignment', label: 'Smoothness', min: 0, max: 1, step: 0.01, default: 0.45, hint: 'Pull towards the midpoint of each node’s neighbours' },
    { type: 'number', key: 'growth', label: 'Growth rate', min: 0.05, max: 1, step: 0.01, default: 0.5, hint: 'Chance of each edge sprouting a new node per iteration; new nodes push the line into folds' },
    { type: 'number', key: 'inlines', label: 'Parallel lines', min: 0, max: 3, step: 1, default: 0, hint: 'Lines either side of the growth, on a second pen, for a ribbon look' },
  ],
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const rng = ctx.rng;
    const R = v.radius;
    const maxEdge = R * 0.55;
    const restLen = R * 0.4;
    const cap = Math.min(MAX_NODES, Math.round(v.maxNodes));

    // Each curve is a separate list of nodes; open lines have pinned ends.
    type Curve = { x: number[]; y: number[]; closed: boolean };
    let curves: Curve[] = [];
    const ring = (cx: number, cy: number, r: number): Curve => {
      const n = Math.max(8, Math.round((2 * Math.PI * r) / (maxEdge * 0.8)));
      const c: Curve = { x: [], y: [], closed: true };
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        const rr = r * (1 + 0.04 * (rng() - 0.5));
        c.x.push(cx + Math.cos(a) * rr);
        c.y.push(cy + Math.sin(a) * rr);
      }
      return c;
    };
    if (v.shape === 'line') {
      const c: Curve = { x: [], y: [], closed: false };
      const n = Math.round((W * 0.8) / (maxEdge * 0.8));
      for (let i = 0; i <= n; i++) {
        c.x.push(W * 0.1 + (i / n) * W * 0.8);
        c.y.push(H / 2 + (i > 0 && i < n ? (rng() - 0.5) * 0.2 : 0));
      }
      curves.push(c);
    } else if (v.shape === 'ring') {
      const k = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < k; i++) curves.push(ring(W * (0.25 + 0.5 * rng()), H * (0.25 + 0.5 * rng()), Math.min(W, H) * 0.04));
    } else curves.push(ring(W / 2, H / 2, Math.min(W, H) * 0.08));

    const count = () => curves.reduce((s, c) => s + c.x.length, 0);
    const toLines = (cs: Curve[]): Polyline[] =>
      cs.map((c) => {
        const p: Polyline = c.x.map((x, i) => [x, c.y[i]] as Pt);
        if (c.closed) p.push(p[0]);
        return smooth(p, R * 0.3);
      });

    const inv = 1 / R;
    const gw = Math.ceil(W * inv) + 1, gh = Math.ceil(H * inv) + 1;
    const pad = R * 0.5;
    for (let it = 0; it < v.iterations; it++) {
      // Flatten all nodes into one array for the spatial grid.
      const N = count();
      const X = new Float64Array(N), Y = new Float64Array(N);
      let o = 0;
      for (const c of curves) for (let i = 0; i < c.x.length; i++, o++) {
        X[o] = c.x[i];
        Y[o] = c.y[i];
      }
      const head = new Int32Array(gw * gh).fill(-1);
      const next = new Int32Array(N);
      for (let i = 0; i < N; i++) {
        const g = Math.min(gh - 1, Math.max(0, Math.floor(Y[i] * inv))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(X[i] * inv)));
        next[i] = head[g];
        head[g] = i;
      }
      o = 0;
      for (const c of curves) {
        const n = c.x.length;
        const nx = new Array<number>(n), ny = new Array<number>(n);
        for (let i = 0; i < n; i++, o++) {
          const x = X[o], y = Y[o];
          if (!c.closed && (i === 0 || i === n - 1)) {
            nx[i] = x;
            ny[i] = y;
            continue;
          }
          const ip = (i - 1 + n) % n, inx = (i + 1) % n;
          const px = c.x[ip], py = c.y[ip], qx = c.x[inx], qy = c.y[inx];
          let fx = 0, fy = 0;
          // Attraction: neighbours pull towards a rest length.
          for (const [ax, ay] of [[px, py], [qx, qy]]) {
            const dx = ax - x, dy = ay - y, d = Math.hypot(dx, dy);
            if (d > restLen) {
              fx += (dx / d) * (d - restLen) * 0.15;
              fy += (dy / d) * (d - restLen) * 0.15;
            }
          }
          // Alignment: towards the neighbours' midpoint.
          fx += ((px + qx) / 2 - x) * v.alignment * 0.5;
          fy += ((py + qy) / 2 - y) * v.alignment * 0.5;
          // Repulsion from every node within R.
          const gx = Math.floor(x * inv), gy = Math.floor(y * inv);
          let rx = 0, ry = 0;
          for (let yy = gy - 1; yy <= gy + 1; yy++) {
            if (yy < 0 || yy >= gh) continue;
            for (let xx = gx - 1; xx <= gx + 1; xx++) {
              if (xx < 0 || xx >= gw) continue;
              for (let j = head[yy * gw + xx]; j >= 0; j = next[j]) {
                if (j === o) continue;
                const dx = x - X[j], dy = y - Y[j];
                const d2 = dx * dx + dy * dy;
                if (d2 >= R * R || d2 < 1e-12) continue;
                const d = Math.sqrt(d2);
                const f = (R - d) / R;
                rx += (dx / d) * f;
                ry += (dy / d) * f;
              }
            }
          }
          fx += rx * R * 0.12;
          fy += ry * R * 0.12;
          // Limit the step so the line can't jump through itself.
          const m = Math.hypot(fx, fy), lim = R * 0.25;
          if (m > lim) {
            fx *= lim / m;
            fy *= lim / m;
          }
          nx[i] = Math.min(W - pad, Math.max(pad, x + fx));
          ny[i] = Math.min(H - pad, Math.max(pad, y + fy));
        }
        c.x = nx;
        c.y = ny;
      }
      // Growth: split long edges, plus a few random ones, until the node budget runs out.
      let budget = cap - count();
      if (budget > 0) {
        curves = curves.map((c) => {
          const n = c.x.length;
          const x: number[] = [], y: number[] = [];
          for (let i = 0; i < n; i++) {
            x.push(c.x[i]);
            y.push(c.y[i]);
            if (!c.closed && i === n - 1) break;
            const j = (i + 1) % n;
            const len = Math.hypot(c.x[j] - c.x[i], c.y[j] - c.y[i]);
            if (budget > 0 && (len > maxEdge || rng() < v.growth * 0.01)) {
              x.push((c.x[i] + c.x[j]) / 2);
              y.push((c.y[i] + c.y[j]) / 2);
              budget--;
            }
          }
          return { x, y, closed: c.closed };
        });
      }
    }
    ctx.status(`${count()} nodes`);

    const final = toLines(curves);
    const k = Math.max(0, Math.round(v.inlines));
    if (!k) return final;
    // Offsets along the normals; folds sit about R apart, so stay within ±0.38 R.
    const step = (R * 0.38) / k;
    const offsets: Polyline[] = [];
    for (const p of final) {
      const closed = Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-6;
      const n = p.length;
      const normal = (i: number): Pt => {
        const a = p[closed ? (i - 1 + n - 1) % (n - 1) : Math.max(0, i - 1)];
        const b = p[closed ? (i + 1) % (n - 1) : Math.min(n - 1, i + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
        return [-dy / d, dx / d];
      };
      const normals = p.map((_, i) => normal(closed && i === n - 1 ? 0 : i));
      for (let j = 1; j <= k; j++)
        for (const sgn of [-1, 1]) offsets.push(p.map(([x, y], i) => [x + normals[i][0] * sgn * j * step, y + normals[i][1] * sgn * j * step] as Pt));
    }
    const layers: Layer[] = [
      { name: 'Growth', color: PALETTE[0], paths: final },
      { name: 'Parallel lines', color: PALETTE[2], paths: offsets },
    ];
    return layers;
  },
});
