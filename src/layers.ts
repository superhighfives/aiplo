import { clipToRect, optimize, polylineLength, resample, simplify, stats, translate, type Polyline, type Pt } from './geom';
import { estimateTime, type PlotSettings } from './plotter/plotter';
import { noise2DFrom } from './random';
import { text } from './lib/hershey';

/** One pen. Layers are plotted in order, pausing between them to swap pens. */
export interface Layer {
  name: string;
  color: string;
  paths: Polyline[];
}

export type GenOutput = Polyline[] | Layer[];

export const PALETTE = ['#1c2230', '#c8463d', '#1f7a8c', '#e0a030', '#5b8c4a', '#7b5ea7'];

export const isLayers = (o: GenOutput): o is Layer[] => o.length > 0 && !Array.isArray(o[0]);

export function toLayers(o: GenOutput): Layer[] {
  if (isLayers(o)) return o.map((l, i) => ({ name: l.name || `Pen ${i + 1}`, color: l.color || PALETTE[i % PALETTE.length], paths: l.paths ?? [] }));
  return [{ name: 'Pen 1', color: PALETTE[0], paths: o as Polyline[] }];
}

export const translateLayers = (layers: Layer[], dx: number, dy: number): Layer[] =>
  layers.map((l) => ({ ...l, paths: translate(l.paths, dx, dy) }));

export interface ProcessOptions {
  paper: [number, number];
  margin: number;
  wobble: number;
  wobbleScale: number;
  simplify: number;
  minLen: number;
  optimize: boolean;
  mergeTol: number;
  plot: PlotSettings;
  /** Pen width in mm, for the ink-density check. */
  penWidth?: number;
  caption?: CaptionSpec;
}

/** Caption with tokens already resolved, placed in the bottom margin. */
export interface CaptionSpec {
  left: string;
  right: string;
  size: number;
  font: string;
  /** Signature strokes in [0, 1] × [0, 1/aspect], drawn after the right-hand text. */
  signature: Polyline[];
  /** Own layer (a separate pen) or merged into the first layer. */
  ownPen: boolean;
}

export interface Density {
  /** Cell size in mm. */
  cell: number;
  /** Cells where ink covers more than half the paper: [x, y, coverage]. */
  hot: [number, number, number][];
  /** Fraction of inked cells that are saturated (coverage ≥ 1). */
  saturated: number;
  max: number;
}

export interface LayerStats {
  count: number;
  draw: number;
  travel: number;
  time: number;
}

function wobble(ps: Polyline[], amp: number, scale: number): Polyline[] {
  const nx = noise2DFrom(101);
  const ny = noise2DFrom(202);
  return ps.map((p) =>
    resample(p, Math.min(1, scale / 8)).map(([x, y]) => [x + nx(x / scale, y / scale) * amp, y + ny(x / scale, y / scale) * amp] as Pt),
  );
}

export function processLayers(raw: Layer[], o: ProcessOptions): { layers: Layer[]; stats: LayerStats[]; density: Density } {
  const [pw, ph] = o.paper;
  const m = o.margin;
  let layers = raw.map((l) => {
    let ps = l.paths;
    if (o.wobble > 0) ps = wobble(ps, o.wobble, o.wobbleScale);
    ps = clipToRect(ps, m, m, pw - m, ph - m);
    ps = ps.map((p) => simplify(p, o.simplify));
    ps = ps.filter((p) => polylineLength(p) >= o.minLen);
    if (o.optimize) ps = optimize(ps, o.mergeTol);
    return { ...l, paths: ps };
  });
  if (o.caption && (o.caption.left || o.caption.right || o.caption.signature.length)) {
    const paths = captionPaths(o.caption, pw, ph, m);
    if (o.caption.ownPen || !layers.length) layers = [...layers, { name: 'Caption', color: PALETTE[0], paths }];
    else layers = layers.map((l, i) => (i === 0 ? { ...l, paths: [...l.paths, ...paths] } : l));
  }
  return {
    layers,
    stats: layers.map((l) => ({ ...stats(l.paths), time: estimateTime(l.paths, o.plot) })),
    density: inkDensity(layers, pw, ph, o.penWidth ?? 0.35),
  };
}

/** Caption text (and optional signature) centred vertically in the bottom margin. */
function captionPaths(c: CaptionSpec, pw: number, ph: number, m: number): Polyline[] {
  const size = Math.min(c.size, Math.max(1, m * 0.5));
  const baseline = ph - m / 2 + size / 2;
  const out: Polyline[] = [];
  if (c.left) out.push(...text(c.left, { x: m, y: baseline, size, font: c.font }));
  let right = pw - m;
  if (c.signature.length) {
    // Fit the signature into a box ~2.5× the text height, right-aligned.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of c.signature) for (const [x, y] of s) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const h = size * 2.5;
    const k = h / Math.max(1e-6, maxY - minY);
    const w = (maxX - minX) * k;
    const x0 = right - w;
    const y0 = baseline - size / 2 - h / 2;
    for (const s of c.signature) out.push(s.map(([x, y]) => [x0 + (x - minX) * k, y0 + (y - minY) * k] as Pt));
    right = x0 - size * 1.5;
  }
  if (c.right) out.push(...text(c.right, { x: right, y: baseline, size, font: c.font, align: 'right' }));
  return out;
}

/** Ink coverage per 2 mm cell: total line length × pen width ÷ cell area. */
function inkDensity(layers: Layer[], pw: number, ph: number, penWidth: number): Density {
  const cell = 2;
  const gw = Math.ceil(pw / cell), gh = Math.ceil(ph / cell);
  const ink = new Float32Array(gw * gh);
  for (const l of layers)
    for (const p of l.paths)
      for (let i = 1; i < p.length; i++) {
        const [x0, y0] = p[i - 1];
        const [x1, y1] = p[i];
        const len = Math.hypot(x1 - x0, y1 - y0);
        // Split long segments so their ink lands in every cell they cross.
        const n = Math.max(1, Math.ceil(len / cell));
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const cx = Math.floor((x0 + (x1 - x0) * t) / cell), cy = Math.floor((y0 + (y1 - y0) * t) / cell);
          if (cx >= 0 && cy >= 0 && cx < gw && cy < gh) ink[cy * gw + cx] += len / n;
        }
      }
  const hot: [number, number, number][] = [];
  let inked = 0, saturated = 0, max = 0;
  for (let i = 0; i < ink.length; i++) {
    const cov = (ink[i] * penWidth) / (cell * cell);
    if (cov > 0) inked++;
    if (cov >= 1) saturated++;
    if (cov > max) max = cov;
    if (cov > 0.5) hot.push([(i % gw) * cell, Math.floor(i / gw) * cell, cov]);
  }
  return { cell, hot, saturated: inked ? saturated / inked : 0, max };
}
