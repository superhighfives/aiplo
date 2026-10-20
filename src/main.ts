import './style.css';
import type { Polyline, Pt } from './geom';
import { Engine } from './engine';
import { findArtwork } from './art';
import type { Artwork } from './art/types';
import { renderGallery } from './gallery';
import { toLayers, translateLayers, type Layer, type LayerStats } from './layers';
import { defaultsOf, renderParams } from './params';
import { Plotter, type PlotSettings } from './plotter/plotter';
import { mulberry32 } from './random';
import { MACHINES, paperDefaults, paperDefs, paperSize as sizeOf, piecePaper, pieceValues, plotDefs, postDefs, resetInPlace, save, state } from './state';
import { pathData, toSVG } from './svg';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The piece open in the editor (null on the gallery). */
let piece: Artwork | null = null;
const paperValues = () => piecePaper(piece!);
const paperSize = () => sizeOf(paperValues());
const hiddenLayers = () => state.hidden[piece?.slug ?? ''] ?? [];

// ---------- pipeline ----------

let layers: Layer[] = [];
let layerStats: LayerStats[] = [];
const visible = () => layers.filter((l) => !hiddenLayers().includes(l.name) && l.paths.length);

const setStatus = (msg: string, error = false) => {
  const s = $('status');
  s.textContent = msg;
  s.classList.toggle('error', error);
};

function genRequest() {
  const [pw, ph] = paperSize();
  const m = paperValues().margin;
  return { slug: piece!.slug, values: pieceValues(piece!), width: Math.max(1, pw - 2 * m), height: Math.max(1, ph - 2 * m), margin: m };
}

const engine = new Engine({
  genRequest,
  isMainThread: (slug) => !!findArtwork(slug)?.mainThread,
  async mainGenerate() {
    const req = genRequest();
    const seed = Number(req.values.seed ?? 1);
    let info = '';
    const t0 = performance.now();
    const out = await piece!.generate(req.values, {
      ...req,
      seed,
      rng: mulberry32(seed),
      status: (msg) => (info = msg),
    });
    return { layers: translateLayers(toLayers(out), req.margin, req.margin), info, ms: performance.now() - t0 };
  },
  processOptions: () => ({
    paper: paperSize(),
    margin: paperValues().margin,
    wobble: state.post.wobble,
    wobbleScale: state.post.wobbleScale,
    simplify: state.post.simplify,
    minLen: state.post.minLen,
    optimize: state.post.optimize,
    mergeTol: state.post.mergeTol,
    plot: settings(),
  }),
  onStatus: setStatus,
  onProcessed(l, st) {
    if (!piece) return;
    layers = l;
    layerStats = st;
    render();
  },
});
const regenerate = () => engine.generate();

// ---------- preview ----------

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = $('preview') as unknown as SVGSVGElement;
const marker = document.createElementNS(SVGNS, 'circle');

function render() {
  const [pw, ph] = paperSize();
  const [, mw, mh] = MACHINES[paperValues().machine];
  const m = paperValues().margin;
  const pad = 10;
  const vw = Math.max(pw, mw), vh = Math.max(ph, mh);
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${vw + pad * 2} ${vh + pad * 2}`);
  svg.replaceChildren();
  const add = (tag: string, attrs: Record<string, string | number>) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    svg.append(e);
    return e;
  };
  const fit = plotTransform();
  const mRect = fit === 'rotate' ? { width: mh, height: mw } : { width: mw, height: mh };
  add('rect', { class: 'machine', x: 0, y: 0, ...mRect });
  add('rect', { class: 'paper', x: 0, y: 0, width: pw, height: ph });
  add('rect', { class: 'margin', x: m, y: m, width: Math.max(0, pw - 2 * m), height: Math.max(0, ph - 2 * m) });
  for (const l of visible()) {
    if (state.post.showTravel) {
      const travel: Polyline[] = [];
      let cur: Pt = [0, 0];
      for (const p of l.paths) {
        travel.push([cur, p[0]]);
        cur = p[p.length - 1];
      }
      add('path', { class: 'travel', d: pathData(travel) });
    }
    add('path', { class: 'ink', d: pathData(l.paths), stroke: l.color, 'stroke-width': state.post.penWidth });
  }
  marker.setAttribute('r', '2');
  marker.setAttribute('class', 'marker');
  svg.append(marker);

  const shown = layerStats.filter((_, i) => !hiddenLayers().includes(layers[i].name));
  const sum = (k: keyof LayerStats) => shown.reduce((t, s) => t + s[k], 0);
  const pens = visible().length;
  const warn = fit === 'nofit' ? ' · ⚠ paper larger than machine travel' : fit === 'rotate' ? ' · plots rotated 90°' : '';
  $('stats').textContent =
    `${sum('count')} strokes · ${(sum('draw') / 1000).toFixed(1)} m ink · ${(sum('travel') / 1000).toFixed(1)} m travel · ` +
    `~${fmtTime(sum('time'))}${pens > 1 ? ` · ${pens} pens` : ''}${warn}`;
  renderLayerList();
}

const fmtTime = (t: number) => (t > 3600 ? `${Math.floor(t / 3600)}h ${Math.round((t % 3600) / 60)}m` : `${Math.floor(t / 60)}m ${Math.round(t % 60)}s`);

function renderLayerList() {
  const root = $('layers');
  root.replaceChildren();
  layers.forEach((l, i) => {
    const row = document.createElement('label');
    row.className = 'layer';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !hiddenLayers().includes(l.name);
    cb.addEventListener('change', () => {
      const hidden = hiddenLayers();
      state.hidden[piece!.slug] = cb.checked ? hidden.filter((n) => n !== l.name) : [...hidden, l.name];
      save();
      render();
    });
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = l.color;
    const name = document.createElement('span');
    name.textContent = l.name;
    const meta = document.createElement('span');
    meta.className = 'muted';
    const st = layerStats[i];
    meta.textContent = st ? `${st.count} · ${(st.draw / 1000).toFixed(1)} m · ${fmtTime(st.time)}` : '';
    row.append(cb, sw, name, meta);
    root.append(row);
  });
}

// ---------- plotting ----------

/** How paper coordinates map onto machine coordinates. */
function plotTransform(): 'none' | 'rotate' | 'nofit' {
  const [pw, ph] = paperSize();
  const [, mw, mh] = MACHINES[paperValues().machine];
  if (pw <= mw + 0.01 && ph <= mh + 0.01) return 'none';
  if (ph <= mw + 0.01 && pw <= mh + 0.01) return 'rotate';
  return 'nofit';
}

function machinePaths(paths: Polyline[]): Polyline[] {
  const [pw] = paperSize();
  // Rotate so the paper's left edge runs along the machine's top (x) axis.
  if (plotTransform() === 'rotate') return paths.map((p) => p.map(([x, y]) => [y, pw - x] as Pt));
  return paths;
}

const plotter = new Plotter();
let paused = false;
let stopped = false;
let resume: (() => void) | null = null;
/** True for the whole multi-pen job, including pen-swap pauses between layers. */
let inJob = false;

const plotStatus = (msg: string) => ($('plot-status').textContent = msg);
const settings = () => state.plot as PlotSettings;

async function guard(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(e);
    plotStatus(String((e as Error).message ?? e));
  }
}

function updateButtons() {
  const c = plotter.connected;
  const busy = plotter.busy || inJob;
  // Pen buttons stay usable during a pen-swap pause so the new pen can be tested.
  const swapping = inJob && !plotter.busy;
  for (const id of ['pen-up', 'pen-down']) ($(id) as HTMLButtonElement).disabled = !c || (busy && !swapping);
  for (const id of ['motors-off', 'home', 'plot']) ($(id) as HTMLButtonElement).disabled = !c || busy;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-jog]')) b.disabled = !c || busy;
  ($('pause') as HTMLButtonElement).disabled = !busy;
  ($('stop') as HTMLButtonElement).disabled = !busy;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('conn-status').textContent = c ? plotter.version.replace(/^EBBv\S+\s*/, '') || 'connected' : 'not connected';
  $('connect').textContent = c ? 'Reconnect' : 'Connect';
}

$('connect').addEventListener('click', () =>
  guard(async () => {
    if (plotter.connected) await plotter.ebb!.close();
    await plotter.connect();
    await plotter.configurePen(settings());
    await plotter.penUp(settings());
    plotStatus('Connected. Make sure the carriage is at the home corner (top-left).');
    updateButtons();
  }).then(updateButtons),
);
$('pen-up').addEventListener('click', () => guard(async () => { await plotter.configurePen(settings()); await plotter.penUp(settings()); }));
$('pen-down').addEventListener('click', () => guard(async () => { await plotter.configurePen(settings()); await plotter.penDown(settings()); }));
$('motors-off').addEventListener('click', () => guard(async () => { await plotter.motorsOff(); plotStatus('Motors off. Position reset: move the carriage to home before plotting.'); }));
$('home').addEventListener('click', () => guard(async () => { await plotter.penUp(settings()); await plotter.moveTo([0, 0], settings()); }));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-jog]')) {
  b.addEventListener('click', () =>
    guard(async () => {
      const [dx, dy] = b.dataset.jog!.split(',').map(Number);
      const step = Number(($('jog-step') as HTMLSelectElement).value);
      const [x, y] = plotter.pos;
      await plotter.penUp(settings());
      await plotter.moveTo([Math.max(0, x + dx * step), Math.max(0, y + dy * step)], settings());
      plotStatus(`At ${plotter.pos.map((v) => v.toFixed(1)).join(', ')} mm`);
    }),
  );
}

$('plot').addEventListener('click', () => {
  if (plotTransform() === 'nofit') return plotStatus('Paper is larger than the machine travel. Pick a smaller paper or another machine.');
  const pens = visible();
  if (!pens.length) return plotStatus('Nothing to plot.');
  paused = stopped = false;
  const toPreview = plotTransform() === 'rotate' ? ([x, y]: Pt): Pt => [paperSize()[0] - y, x] : (p: Pt) => p;
  const t0 = performance.now();
  const job = (async () => {
    for (let i = 0; i < pens.length && !stopped; i++) {
      const l = pens[i];
      if (i > 0) {
        // Carriage is home with the pen up: wait for the pen swap.
        paused = true;
        updateButtons();
        plotStatus(`Swap to “${l.name}”, then press Resume.`);
        await new Promise<void>((r) => (resume = r));
        if (stopped) break;
      }
      await plotter.plot(machinePaths(l.paths), settings(), {
        onProgress: (f, pos) => {
          ($('progress') as HTMLProgressElement).value = (i + f) / pens.length;
          const [x, y] = toPreview(pos);
          marker.setAttribute('cx', String(x));
          marker.setAttribute('cy', String(y));
          const el = (performance.now() - t0) / 1000;
          const pen = pens.length > 1 ? `${l.name} (${i + 1}/${pens.length}) · ` : '';
          if (!paused) plotStatus(`${pen}${(f * 100).toFixed(1)}% · ${fmtTime(el)} elapsed`);
        },
        isPaused: () => paused,
        isStopped: () => stopped,
        waitResume: () => new Promise<void>((r) => (resume = r)),
      });
    }
  })();
  inJob = true;
  updateButtons();
  guard(async () => {
    await job;
    plotStatus(stopped ? 'Stopped.' : 'Done.');
  }).then(() => {
    inJob = false;
    paused = false;
    updateButtons();
  });
});
$('pause').addEventListener('click', () => {
  paused = !paused;
  if (!paused) {
    resume?.();
    resume = null;
  }
  plotStatus(paused ? 'Pausing… (pen lifts; you can swap pens)' : 'Resumed');
  updateButtons();
});
$('stop').addEventListener('click', () => {
  stopped = true;
  paused = false;
  resume?.();
  resume = null;
  plotStatus('Stopping, returning home…');
});

// ---------- output ----------

$('export-svg').addEventListener('click', () => {
  const [pw, ph] = paperSize();
  const blob = new Blob([toSVG(visible(), pw, ph, state.post.penWidth)], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${piece!.slug}-${Date.now()}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('regen').addEventListener('click', regenerate);

// ---------- wiring ----------

let regenTimer = 0;
const scheduleRegen = () => {
  clearTimeout(regenTimer);
  regenTimer = window.setTimeout(regenerate, 120);
};

function openPiece(a: Artwork) {
  const switching = piece !== a;
  piece = a;
  document.title = `${a.title} · aiplo`;
  $('piece-title').textContent = a.title;
  $('piece-desc').textContent = a.description ?? '';
  mountKnobs();
  mountPaper();
  if (switching) {
    layers = [];
    layerStats = [];
    render();
  }
  $('gallery').hidden = true;
  $('app').hidden = false;
  regenerate();
}

function showGallery() {
  piece = null;
  document.title = 'aiplo';
  $('app').hidden = true;
  $('gallery').hidden = false;
  renderGallery($('gallery'));
}

function route() {
  const m = location.hash.match(/^#\/art\/([\w-]+)/);
  const a = m ? findArtwork(m[1]) : undefined;
  if (a) openPiece(a);
  else showGallery();
}

const mountKnobs = () =>
  renderParams($('gen-params'), piece!.params, pieceValues(piece!), () => {
    save();
    scheduleRegen();
  });
const mountPaper = () =>
  renderParams($('paper-params'), paperDefs, piecePaper(piece!), () => {
    save();
    scheduleRegen();
  });
const mountPost = () =>
  renderParams($('post-params'), postDefs, state.post, (key) => {
    save();
    if (key === 'penWidth' || key === 'showTravel') render();
    else engine.process();
  });
const mountPlot = () =>
  renderParams($('plot-params'), plotDefs, state.plot, (key) => {
    save();
    // Speeds change the time estimate; pen settings don't need reprocessing.
    if (['drawSpeed', 'travelSpeed', 'accel', 'cornering'].includes(key)) engine.process();
  });

// Each group's Reset restores just that group, in place, then redraws its controls.
$('reset-knobs').addEventListener('click', () => {
  resetInPlace(pieceValues(piece!), defaultsOf(piece!.params));
  mountKnobs();
  regenerate();
});
$('reset-paper').addEventListener('click', () => {
  resetInPlace(piecePaper(piece!), paperDefaults(piece!));
  mountPaper();
  regenerate();
});
$('reset-post').addEventListener('click', () => {
  resetInPlace(state.post, defaultsOf(postDefs));
  mountPost();
  engine.process();
});
$('reset-plot').addEventListener('click', () => {
  resetInPlace(state.plot, defaultsOf(plotDefs));
  mountPlot();
  engine.process();
});

mountPost();
mountPlot();

if (!('serial' in navigator)) plotStatus('WebSerial unavailable: plotting needs Chrome or Edge. Export SVG still works.');
updateButtons();
window.addEventListener('hashchange', route);
route();
