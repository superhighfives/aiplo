import type { Artwork } from './art/types';
import type { ParamDef, Values } from './params';
import { withDefaults } from './params';
import { FONT_OPTIONS } from './lib/hershey';

export const MACHINES: Record<string, [string, number, number]> = {
  v3: ['AxiDraw V3 / SE/A4 (300×218)', 300, 218],
  a3: ['AxiDraw V3/A3, SE/A3 (430×297)', 430, 297],
  xlx: ['AxiDraw V3 XLX (595×218)', 595, 218],
  mini: ['AxiDraw MiniKit (160×101)', 160, 101.6],
};
export const PAPERS: Record<string, [string, number, number]> = {
  a4: ['A4', 297, 210],
  a5: ['A5', 210, 148],
  a3: ['A3', 420, 297],
  letter: ['US Letter', 279.4, 215.9],
  '9x12': ['9×12 in', 304.8, 228.6],
  postcard: ['Postcard 6×4 in', 152.4, 101.6],
  square: ['Square 200', 200, 200],
  custom: ['Custom', 0, 0],
};

export const paperDefs: ParamDef[] = [
  { type: 'select', key: 'machine', label: 'Machine', options: Object.entries(MACHINES).map(([k, v]) => [k, v[0]]), default: 'v3' },
  { type: 'select', key: 'paper', label: 'Paper', options: Object.entries(PAPERS).map(([k, v]) => [k, v[0]]), default: 'letter' },
  { type: 'select', key: 'orientation', label: 'Orientation', options: [['landscape', 'Landscape'], ['portrait', 'Portrait']], default: 'landscape' },
  { type: 'number', key: 'w', label: 'Width (mm)', min: 20, max: 600, step: 0.1, default: 200, show: (v) => v.paper === 'custom' },
  { type: 'number', key: 'h', label: 'Height (mm)', min: 20, max: 600, step: 0.1, default: 150, show: (v) => v.paper === 'custom' },
  { type: 'number', key: 'margin', label: 'Margin (mm)', min: 0, max: 60, step: 0.5, default: 15 },
];

export const postDefs: ParamDef[] = [
  { type: 'number', key: 'wobble', label: 'Hand wobble (mm)', min: 0, max: 3, step: 0.05, default: 0, hint: 'Displaces lines with low-frequency noise for a hand-drawn feel' },
  { type: 'number', key: 'wobbleScale', label: 'Wobble scale (mm)', min: 2, max: 80, step: 1, default: 20, show: (v) => v.wobble > 0 },
  { type: 'number', key: 'simplify', label: 'Simplify (mm)', min: 0, max: 0.5, step: 0.01, default: 0.03 },
  { type: 'number', key: 'minLen', label: 'Drop strokes under (mm)', min: 0, max: 5, step: 0.1, default: 0.3 },
  { type: 'checkbox', key: 'optimize', label: 'Optimise pen travel', default: true },
  { type: 'number', key: 'mergeTol', label: 'Join gaps under (mm)', min: 0, max: 2, step: 0.05, default: 0.3, show: (v) => v.optimize, hint: 'Draws across small gaps instead of lifting the pen, but only where the line carries straight on' },
  { type: 'number', key: 'penWidth', label: 'Preview pen width (mm)', min: 0.05, max: 2, step: 0.05, default: 0.35 },
  { type: 'checkbox', key: 'showTravel', label: 'Show pen-up travel', default: false },
  { type: 'checkbox', key: 'showDensity', label: 'Show ink density', default: false, hint: 'Highlights areas so dense the ink may bleed or tear the paper' },
];

export const plotDefs: ParamDef[] = [
  { type: 'number', key: 'drawSpeed', label: 'Draw speed (mm/s)', min: 5, max: 200, step: 1, default: 40 },
  { type: 'number', key: 'travelSpeed', label: 'Travel speed (mm/s)', min: 10, max: 220, step: 1, default: 120 },
  { type: 'number', key: 'accel', label: 'Acceleration (mm/s²)', min: 50, max: 3000, step: 10, default: 800 },
  { type: 'number', key: 'cornering', label: 'Cornering (mm)', min: 0.005, max: 1, step: 0.005, default: 0.05, hint: 'Junction deviation: higher = faster through corners, looser lines' },
  { type: 'number', key: 'penUp', label: 'Pen up (%)', min: 0, max: 100, step: 1, default: 70 },
  { type: 'number', key: 'penDown', label: 'Pen down (%)', min: 0, max: 100, step: 1, default: 30 },
  { type: 'number', key: 'penUpSpeed', label: 'Lift speed (%)', min: 5, max: 100, step: 1, default: 60, hint: 'How fast the pen rises. Slower is gentler; the plotter waits exactly as long as the lift takes' },
  { type: 'number', key: 'penDownSpeed', label: 'Lower speed (%)', min: 5, max: 100, step: 1, default: 40, hint: 'How fast the pen drops. Slower avoids blobs and bounces at the start of lines' },
  { type: 'number', key: 'penUpWait', label: 'Extra wait after lift (ms)', min: 0, max: 1000, step: 10, default: 100, hint: 'Added to the lift time. Raise this if travel moves leave short tails' },
  { type: 'number', key: 'penDownWait', label: 'Extra wait after lowering (ms)', min: 0, max: 1000, step: 10, default: 100, hint: 'Added to the lowering time. Raise this if line starts are faint' },
];

const on = (v: Values) => v.on;
export const captionDefs: ParamDef[] = [
  { type: 'checkbox', key: 'on', label: 'Add caption', default: false },
  { type: 'text', key: 'left', label: 'Left', default: '{title} · {place}', show: on, hint: 'Tokens: {title} {place} {coords} {date} {edition}' },
  { type: 'text', key: 'right', label: 'Right', default: '{edition}', show: on, hint: 'Tokens: {title} {place} {coords} {date} {edition}' },
  { type: 'number', key: 'edition', label: 'Edition number', min: 1, max: 500, step: 1, default: 1, show: on },
  { type: 'number', key: 'of', label: 'Edition size', min: 0, max: 500, step: 1, default: 0, show: on, hint: '0 = no edition number' },
  { type: 'number', key: 'size', label: 'Size (mm)', min: 1.5, max: 10, step: 0.5, default: 3, show: on },
  { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural', show: on },
  { type: 'checkbox', key: 'sign', label: 'Signature', default: false, show: on },
  { type: 'checkbox', key: 'ownPen', label: 'Caption on its own pen', default: false, show: on },
];

export const signatureDefs: ParamDef[] = [
  { type: 'sketchpad', key: 'signature', label: 'Your signature (shared by all pieces)', aspect: 3, default: [] },
];

export interface State {
  /** Knob values per piece slug. */
  gen: Record<string, Values>;
  /** Paper settings per piece slug. */
  paper: Record<string, Values>;
  post: Values;
  plot: Values;
  /** Layer names hidden from preview, export and plotting, per piece slug. */
  hidden: Record<string, string[]>;
  /** Caption settings per piece slug. */
  caption: Record<string, Values>;
  signature: Values;
}

const STORAGE_KEY = 'aiplo:v2';

function loadState(): State {
  let saved: Partial<State> = {};
  try {
    // v1 had a single global paper and generator; only its post and plot settings carry over.
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('aiplo:v1') ?? '{}');
  } catch {
    /* ignore */
  }
  const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, any>) : {});
  const paper = obj(saved.paper);
  return {
    gen: obj(saved.gen),
    paper: Object.values(paper).every((v) => typeof v === 'object') ? paper : {},
    post: withDefaults(postDefs, saved.post),
    plot: withDefaults(plotDefs, saved.plot),
    hidden: obj(saved.hidden),
    caption: obj(saved.caption),
    signature: withDefaults(signatureDefs, saved.signature),
  };
}

export const state = loadState();

let saveTimer = 0;
export const save = () => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore (e.g. quota exceeded by a large imported SVG) */
    }
  }, 300);
};

/**
 * Returns the stored object for `slug`, creating it or filling in missing keys in place.
 * The same object must come back every time: the knob UI mutates it directly.
 */
function ensure(store: Record<string, Values>, slug: string, defaults: Values): Values {
  const cur = store[slug];
  if (!cur || typeof cur !== 'object') return (store[slug] = defaults);
  for (const k of Object.keys(defaults)) if (!(k in cur)) cur[k] = defaults[k];
  return cur;
}

/** A piece's knob values, filled in with defaults for any params added since they were saved. */
export const pieceValues = (a: Artwork): Values => ensure(state.gen, a.slug, withDefaults(a.params, {}));

export const paperDefaults = (a: Artwork): Values => withDefaults(paperDefs, { ...a.paper });
export const piecePaper = (a: Artwork): Values => ensure(state.paper, a.slug, paperDefaults(a));
export const pieceCaption = (a: Artwork): Values => ensure(state.caption, a.slug, withDefaults(captionDefs, {}));

/** Resets a values object to `defaults` in place, keeping its identity (the knob UI holds it). */
export function resetInPlace(target: Values, defaults: Values) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, structuredClone(defaults));
  save();
}

export function paperSize(p: Values): [number, number] {
  let [, w, h] = PAPERS[p.paper] ?? PAPERS.letter;
  if (p.paper === 'custom') [w, h] = [p.w, p.h];
  const long = Math.max(w, h), short = Math.min(w, h);
  return p.orientation === 'landscape' ? [long, short] : [short, long];
}
