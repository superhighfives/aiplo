import { artworks } from './art';
import type { Artwork } from './art/types';
import { createWorker } from './engine';
import { toLayers, translateLayers, type Layer, type ProcessOptions } from './layers';
import { mulberry32 } from './random';
import { pieceValues, piecePaper, paperSize, state } from './state';
import { pathData } from './svg';
import type { WorkerRequest, WorkerResponse } from './worker';

const THUMB_PREFIX = 'aiplo:thumb:';
const SECTIONS: [Artwork['kind'], string][] = [
  ['art', 'Artworks'],
  ['study', 'Studies'],
  ['tool', 'Tools'],
];

/** Artworks are grouped into series by their `order` range unless they name one. */
const SERIES: [number, string][] = [
  [10, 'Terrain'],
  [20, 'Streets and water'],
  [30, 'World'],
  [40, 'Sky and time'],
  [50, 'Sound and personal'],
  [60, 'Photographs'],
  [Infinity, 'Generative'],
];
/** Display order of series headings (pieces can also name their own series). */
const SERIES_ORDER = ['Terrain', 'Streets and water', 'World', 'Sky and time', 'Moments', 'Music', 'Sound and personal', 'Words and hands', 'Photographs', 'Generative'];
const seriesOf = (a: Artwork) => a.series ?? SERIES.find(([max]) => (a.order ?? 100) < max)![1];

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: WorkerResponse) => void>();
let queue: Promise<unknown> = Promise.resolve();

type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;

function render(req: Unsent<Extract<WorkerRequest, { type: 'render' | 'processRaw' }>>): Promise<WorkerResponse> {
  if (!worker) {
    worker = createWorker();
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === 'status') return;
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
  }
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ ...req, id });
  });
}

function thumbSVG(layers: Layer[], w: number, h: number) {
  const ink = layers
    .map((l) => `<path d="${pathData(l.paths)}" stroke="${l.color}" />`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" class="paper"/><g fill="none" stroke-width="${Math.max(w, h) / 500}" stroke-linecap="round" stroke-linejoin="round">${ink}</g></svg>`;
}

/** Thumbnails reflect each piece's current knobs; cached until they change. */
function loadThumb(a: Artwork, box: HTMLElement) {
  const values = pieceValues(a);
  const paper = piecePaper(a);
  const [pw, ph] = paperSize(paper);
  box.style.aspectRatio = `${pw} / ${ph}`;
  const key = JSON.stringify({ values, paper, wobble: state.post.wobble, wobbleScale: state.post.wobbleScale });
  try {
    const cached = JSON.parse(localStorage.getItem(THUMB_PREFIX + a.slug) ?? 'null');
    if (cached?.key === key) {
      box.innerHTML = cached.svg;
      return;
    }
  } catch {
    /* ignore */
  }
  box.classList.add('loading');
  const m = paper.margin;
  const width = Math.max(1, pw - 2 * m);
  const height = Math.max(1, ph - 2 * m);
  queue = queue.then(async () => {
    const opts: ProcessOptions = {
      paper: [pw, ph],
      margin: m,
      wobble: state.post.wobble,
      wobbleScale: state.post.wobbleScale,
      simplify: 0.15,
      minLen: 0.3,
      optimize: false,
      mergeTol: 0,
      plot: state.plot as ProcessOptions['plot'],
    };
    let r: WorkerResponse;
    if (a.mainThread) {
      // Needs the DOM (audio decoding, SVG layout): generate here, process in the worker.
      try {
        const seed = Number(values.seed ?? 1);
        const out = await a.generate(values, { width, height, margin: m, seed, rng: mulberry32(seed), status: () => {} });
        r = await render({ type: 'processRaw', layers: translateLayers(toLayers(out), m, m), opts });
      } catch (e) {
        r = { type: 'error', id: 0, message: String((e as Error)?.message ?? e) };
      }
    } else r = await render({ type: 'render', slug: a.slug, values, width, height, margin: m, opts });
    box.classList.remove('loading');
    if (r.type !== 'processed') {
      box.innerHTML = `<div class="thumb-label error">${r.type === 'error' ? r.message : 'Failed'}</div>`;
      return;
    }
    const svg = thumbSVG(r.result.layers, pw, ph);
    box.innerHTML = svg;
    try {
      localStorage.setItem(THUMB_PREFIX + a.slug, JSON.stringify({ key, svg }));
    } catch {
      /* quota: thumbnail just won't be cached */
    }
  });
}

function card(a: Artwork) {
  const card = document.createElement('a');
  card.className = 'card';
  card.href = `#/art/${a.slug}`;
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const t = document.createElement('div');
  t.className = 'card-title';
  t.textContent = a.title;
  const d = document.createElement('div');
  d.className = 'card-desc';
  d.textContent = a.description ?? '';
  meta.append(t, d);
  card.append(thumb, meta);
  loadThumb(a, thumb);
  return card;
}

export function renderGallery(root: HTMLElement) {
  root.querySelector('.gallery-sections')?.remove();
  const sections = document.createElement('div');
  sections.className = 'gallery-sections';
  for (const [kind, title] of SECTIONS) {
    const pieces = artworks.filter((a) => (a.kind ?? 'art') === kind);
    if (!pieces.length) continue;
    const section = document.createElement('section');
    section.innerHTML = `<h2>${title}</h2>`;
    // Artworks get a sub-heading per series; studies and tools are one grid each.
    const groups = new Map<string, Artwork[]>();
    for (const a of pieces) {
      const g = kind === 'art' ? seriesOf(a) : '';
      groups.set(g, [...(groups.get(g) ?? []), a]);
    }
    const rank = (name: string) => (SERIES_ORDER.indexOf(name) + 1 || SERIES_ORDER.length + 1);
    for (const [series, list] of [...groups].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      if (series) {
        const h = document.createElement('h3');
        h.textContent = series;
        section.append(h);
      }
      const grid = document.createElement('div');
      grid.className = `grid grid-${kind}`;
      for (const a of list) grid.append(card(a));
      section.append(grid);
    }
    sections.append(section);
  }
  root.append(sections);
}
