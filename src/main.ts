import './style.css';
import type { Polyline, Pt } from './geom';
import { Engine } from './engine';
import { findArtwork } from './art';
import type { Artwork } from './art/types';
import { renderGallery } from './gallery';
import { toLayers, translateLayers, type CaptionSpec, type Density, type Layer, type LayerStats } from './layers';
import { defaultsOf, renderParams } from './params';
import { liftTime, Plotter, type PlotSettings } from './plotter/plotter';
import { mulberry32, seedFromText } from './random';
import { captionDefs, MACHINES, paperDefaults, paperDefs, paperSize as sizeOf, pieceCaption, piecePaper, pieceValues, plotDefs, postDefs, resetInPlace, save, signatureDefs, state } from './state';
import { pathData, toSVG } from './svg';
import { inkOf, splitAt } from './timeline';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The piece open in the editor (null on the gallery). */
let piece: Artwork | null = null;
const paperValues = () => piecePaper(piece!);
const paperSize = () => sizeOf(paperValues());
const hiddenLayers = () => state.hidden[piece?.slug ?? ''] ?? [];

// ---------- pipeline ----------

let layers: Layer[] = [];
let layerStats: LayerStats[] = [];
let density: Density | null = null;

/** Resolves the caption tokens for the open piece, or undefined if captions are off. */
function captionSpec(): CaptionSpec | undefined {
  if (!piece) return undefined;
  const c = pieceCaption(piece);
  if (!c.on) return undefined;
  const v = pieceValues(piece);
  const loc = v.loc as { name: string; lat: number; lon: number } | undefined;
  const place = piece.caption?.(v) ?? (loc ? loc.name.split(',').slice(0, 2).join(',').trim() : '');
  const coords = loc ? `${Math.abs(loc.lat).toFixed(2)}°${loc.lat >= 0 ? 'N' : 'S'} ${Math.abs(loc.lon).toFixed(2)}°${loc.lon >= 0 ? 'E' : 'W'}` : '';
  const tokens: Record<string, string> = {
    title: piece.title,
    place,
    coords,
    date: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    edition: c.of > 0 ? `${c.edition}/${c.of}` : '',
  };
  // Fill tokens, then drop separators left dangling by empty ones.
  const fill = (t: string) =>
    t
      .replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? '')
      .split('·')
      .map((x) => x.trim())
      .filter(Boolean)
      .join(' · ');
  return {
    left: fill(c.left),
    right: fill(c.right),
    size: c.size,
    font: c.font,
    signature: c.sign ? state.signature.signature : [],
    ownPen: c.ownPen,
  };
}
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
    penWidth: state.post.penWidth,
    caption: captionSpec(),
  }),
  onStatus: setStatus,
  onProcessed(l, st, d) {
    if (!piece) return;
    layers = l;
    layerStats = st;
    density = d;
    if (restorePending) restoreProgress();
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
  // Timeline: ink before the start point is drawn faded.
  const timeline = startAt > 0 && !inJob ? splitAt(visible(), startAt) : null;
  for (const l of timeline?.before ?? []) add('path', { class: 'ink done', d: pathData(l.paths), stroke: l.color, 'stroke-width': state.post.penWidth });
  for (const l of timeline?.after ?? visible()) {
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
  if (state.post.showDensity && density) {
    for (const [x, y, cov] of density.hot)
      add('rect', { class: 'density', x, y, width: density.cell, height: density.cell, 'fill-opacity': Math.min(0.6, (cov - 0.5) * 0.6).toFixed(2) });
  }
  marker.setAttribute('r', '2');
  marker.setAttribute('class', 'marker');
  svg.append(marker);

  const shown = layerStats.filter((_, i) => !hiddenLayers().includes(layers[i].name));
  const sum = (k: keyof LayerStats) => shown.reduce((t, s) => t + s[k], 0);
  const pens = visible().length;
  let warn = fit === 'nofit' ? ' · ⚠ paper larger than machine travel' : fit === 'rotate' ? ' · plots rotated 90°' : '';
  if (density && density.saturated > 0.02) warn += ` · ⚠ ${Math.round(density.saturated * 100)}% of the inked area is saturated: may bleed or tear`;
  $('stats').textContent =
    `${sum('count')} strokes · ${(sum('draw') / 1000).toFixed(1)} m ink · ${(sum('travel') / 1000).toFixed(1)} m travel · ` +
    `~${fmtTime(sum('time'))}${pens > 1 ? ` · ${pens} pens` : ''}${warn}`;
  renderLayerList();
  updateTimeline();
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
  updateTimeline();
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
  const { after, total, skipped } = splitAt(visible(), startAt);
  const pens = after.filter((l) => l.paths.length);
  if (!pens.length) return plotStatus('Nothing to plot from here. Drag the timeline back or press From start.');
  paused = stopped = false;
  const toPreview = plotTransform() === 'rotate' ? ([x, y]: Pt): Pt => [paperSize()[0] - y, x] : (p: Pt) => p;
  const t0 = performance.now();
  let reached = startAt;
  const job = (async () => {
    let done = skipped;
    for (let i = 0; i < pens.length && !stopped; i++) {
      const l = pens[i];
      if (i > 0) {
        // Carriage is home with the pen up: wait for the pen swap.
        paused = true;
        updateButtons();
        plotStatus(`Swap to “${l.name}”, then press Resume.`);
        await new Promise<void>((r) => (resume = r));
        if (stopped) break;
      } else if (startAt > 0) plotStatus(`Starting at ${(startAt * 100).toFixed(1)}% with “${l.name}”.`);
      const ink = inkOf(l);
      await plotter.plot(machinePaths(l.paths), settings(), {
        onProgress: (f, pos) => {
          reached = total ? (done + f * ink) / total : 1;
          saveProgress(reached);
          ($('timeline') as HTMLInputElement).value = String(reached);
          const [x, y] = toPreview(pos);
          marker.setAttribute('cx', String(x));
          marker.setAttribute('cy', String(y));
          const el = (performance.now() - t0) / 1000;
          const pen = visible().length > 1 ? `${l.name} · ` : '';
          if (!paused) plotStatus(`${pen}${(reached * 100).toFixed(1)}% · ${fmtTime(el)} elapsed`);
        },
        isPaused: () => paused,
        isStopped: () => stopped,
        waitResume: () => new Promise<void>((r) => (resume = r)),
      });
      done += ink;
    }
  })();
  inJob = true;
  updateButtons();
  guard(async () => {
    await job;
    if (stopped) saveProgress(reached, true);
    else clearProgress();
    plotStatus(stopped ? `Stopped at ${(reached * 100).toFixed(1)}%. Press Plot to carry on from there.` : 'Done.');
  }).then(() => {
    // After a stop, the timeline stays where the plot got to, ready to resume.
    startAt = stopped && reached < 1 ? reached : 0;
    inJob = false;
    paused = false;
    updateButtons();
    render();
  });
});

// ---------- saved progress ----------
// A plot's position is saved as it goes, so if the page reloads or crashes mid-plot, reopening
// the piece puts the timeline back where it got to. It's keyed to the exact drawing (a
// fingerprint of the visible pens and paper), so changed knobs don't resume the wrong plot.

const PROGRESS_KEY = 'aiplo:progress:';
let restorePending = false;
let lastSaved = 0;

function fingerprint(): string {
  const pens = visible().map((l) => [l.name, l.paths.length, Math.round(inkOf(l) * 10)]);
  return String(seedFromText(JSON.stringify([pens, paperSize(), plotTransform()])));
}

function saveProgress(f: number, force = false) {
  if (!piece || (!force && performance.now() - lastSaved < 1000)) return;
  lastSaved = performance.now();
  try {
    localStorage.setItem(PROGRESS_KEY + piece.slug, JSON.stringify({ fp: fingerprint(), f, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

function clearProgress() {
  if (!piece) return;
  try {
    localStorage.removeItem(PROGRESS_KEY + piece.slug);
  } catch {
    /* ignore */
  }
}

function restoreProgress() {
  restorePending = false;
  if (!piece || inJob) return;
  let saved: { fp: string; f: number; at: number } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(PROGRESS_KEY + piece.slug) ?? 'null');
  } catch {
    /* ignore */
  }
  if (!saved || saved.fp !== fingerprint() || !(saved.f > 0 && saved.f < 1)) return;
  startAt = saved.f;
  const when = new Date(saved.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  plotStatus(
    `A plot of this piece stopped at ${(saved.f * 100).toFixed(1)}% (${when}). The timeline is set to carry on from there: ` +
      'press Motors off, push the carriage to home (top-left), reconnect, then Plot.',
  );
  render();
}

// Warn before anything (including the dev server's live reload) unloads the page mid-plot.
window.addEventListener('beforeunload', (e) => {
  if (!inJob) return;
  e.preventDefault();
  e.returnValue = '';
});

// ---------- timeline ----------

/** Where the next plot starts, as a fraction of the visible pens' total ink. */
let startAt = 0;

function updateTimeline() {
  const input = $('timeline') as HTMLInputElement;
  input.disabled = inJob || !layers.length;
  ($('timeline-reset') as HTMLButtonElement).hidden = inJob || startAt === 0;
  if (inJob) return;
  input.value = String(startAt);
  const pens = visible();
  const shown = layerStats.filter((_, i) => !hiddenLayers().includes(layers[i].name));
  const time = shown.reduce((t, s) => t + s.time, 0) * (1 - startAt);
  if (!pens.length) return void ($('timeline-label').textContent = '');
  if (startAt === 0) {
    $('timeline-label').textContent = `From the start · ~${fmtTime(time)}`;
    return;
  }
  const first = splitAt(pens, startAt).after.find((l) => l.paths.length);
  const pen = first && pens.length > 1 ? ` · ${first.name}` : '';
  $('timeline-label').textContent = `Start at ${(startAt * 100).toFixed(1)}%${pen} · ~${fmtTime(time)} left`;
}

$('timeline').addEventListener('input', () => {
  if (inJob) return;
  startAt = Number(($('timeline') as HTMLInputElement).value);
  render();
});
$('timeline-reset').addEventListener('click', () => {
  startAt = 0;
  render();
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
  if (piece !== a) restorePending = true;
  const switching = piece !== a;
  piece = a;
  document.title = `${a.title} · aiplo`;
  $('piece-title').textContent = a.title;
  $('piece-desc').textContent = a.description ?? '';
  mountKnobs();
  mountPaper();
  mountCaption();
  if (switching) {
    layers = [];
    layerStats = [];
    density = null;
    startAt = 0;
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
const mountCaption = () => {
  const c = pieceCaption(piece!);
  renderParams($('caption-params'), captionDefs, c, (key) => {
    save();
    if (key === 'on' || key === 'sign') $('signature-params').hidden = !(c.on && c.sign);
    engine.process();
  });
  renderParams($('signature-params'), signatureDefs, state.signature, () => {
    save();
    engine.process();
  });
  $('signature-params').hidden = !(c.on && c.sign);
};
const mountPost = () =>
  renderParams($('post-params'), postDefs, state.post, (key) => {
    save();
    if (key === 'showTravel' || key === 'showDensity') render();
    else engine.process();
  });
const mountPlot = () =>
  renderParams($('plot-params'), plotDefs, state.plot, (key) => {
    save();
    // Speeds change the time estimate; pen settings don't need reprocessing.
    if (['drawSpeed', 'travelSpeed', 'accel', 'cornering', 'penUp', 'penDown', 'penUpSpeed', 'penDownSpeed', 'penUpWait', 'penDownWait'].includes(key)) engine.process();
    updateLiftInfo();
  });

/** Shows how long each lift and drop will take with the current pen settings. */
function updateLiftInfo() {
  const s = settings();
  $('lift-info').textContent = `Pen lift ${liftTime(s, true)} ms · drop ${liftTime(s, false)} ms`;
}

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
$('reset-caption').addEventListener('click', () => {
  resetInPlace(pieceCaption(piece!), captionDefs.reduce((o, d) => ({ ...o, [d.key]: d.default }), {}));
  mountCaption();
  engine.process();
});
$('reset-post').addEventListener('click', () => {
  resetInPlace(state.post, defaultsOf(postDefs));
  mountPost();
  engine.process();
});
$('reset-plot').addEventListener('click', () => {
  resetInPlace(state.plot, defaultsOf(plotDefs));
  mountPlot();
  updateLiftInfo();
  engine.process();
});

mountPost();
mountPlot();
updateLiftInfo();

if (!('serial' in navigator)) plotStatus('WebSerial unavailable: plotting needs Chrome or Edge. Export SVG still works.');
updateButtons();
window.addEventListener('hashchange', route);
route();
