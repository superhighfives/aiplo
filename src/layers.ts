import { clipToRect, optimize, polylineLength, resample, simplify, stats, translate, type Polyline, type Pt } from './geom';
import { estimateTime, type PlotSettings } from './plotter/plotter';
import { noise2DFrom } from './random';

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

export function processLayers(raw: Layer[], o: ProcessOptions): { layers: Layer[]; stats: LayerStats[] } {
  const [pw, ph] = o.paper;
  const m = o.margin;
  const layers = raw.map((l) => {
    let ps = l.paths;
    if (o.wobble > 0) ps = wobble(ps, o.wobble, o.wobbleScale);
    ps = clipToRect(ps, m, m, pw - m, ph - m);
    ps = ps.map((p) => simplify(p, o.simplify));
    ps = ps.filter((p) => polylineLength(p) >= o.minLen);
    if (o.optimize) ps = optimize(ps, o.mergeTol);
    return { ...l, paths: ps };
  });
  return {
    layers,
    stats: layers.map((l) => ({ ...stats(l.paths), time: estimateTime(l.paths, o.plot) })),
  };
}
