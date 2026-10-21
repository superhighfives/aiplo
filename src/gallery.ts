import { artworks } from './art';
import type { Artwork } from './art/types';
import { createWorker } from './engine';
import { toLayers, translateLayers, type Layer, type ProcessOptions } from './layers';
import { mulberry32 } from './random';
import { pieceValues, piecePaper, paperSize, state } from './state';
import { pathData } from './svg';
import type { WorkerRequest, WorkerResponse } from './worker';

const THUMB_PREFIX = 'aiplo:thumb:';

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
  const key = JSON.stringify({ values, paper, wobble: state.post.wobble, wobbleScale: state.post.wobbleScale });
  try {
    const cached = JSON.parse(localStorage.getItem(THUMB_PREFIX + a.slug) ?? 'null');
    if (cached?.key === key) {
      if (box.dataset.key !== key) box.innerHTML = cached.svg;
      box.dataset.key = key;
      return;
    }
  } catch {
    /* ignore */
  }
  box.classList.add('loading');
  const m = paper.margin;
  const width = Math.max(1, pw - 2 * m);
  const height = Math.max(1, ph - 2 * m);
  if (box.dataset.loading === key) return;
  box.dataset.loading = key;
  void (async () => {
    const release = await slot();
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
    release();
    box.classList.remove('loading');
    delete box.dataset.loading;
    if (r.type !== 'processed') {
      box.innerHTML = `<div class="thumb-label error">${r.type === 'error' ? r.message : 'Failed'}</div>`;
      return;
    }
    const svg = thumbSVG(r.result.layers, pw, ph);
    box.innerHTML = svg;
    box.dataset.key = key;
    try {
      localStorage.setItem(THUMB_PREFIX + a.slug, JSON.stringify({ key, svg }));
    } catch {
      /* quota: thumbnail just won't be cached */
    }
  })();
}

// ---------- what a piece uses (derived from its knobs) ----------

type Use = 'place' | 'date' | 'photo' | 'audio' | 'files' | 'words' | 'drawing';
const USE_LABELS: Record<Use, string> = {
  place: 'A place',
  date: 'A date',
  photo: 'A photo',
  audio: 'Audio',
  files: 'Your files',
  words: 'Your words',
  drawing: 'A drawing',
};

function usesOf(a: Artwork): Use[] {
  const out = new Set<Use>();
  for (const p of a.params) {
    if (p.type === 'location' || p.type === 'places') out.add('place');
    else if (p.type === 'date') out.add('date');
    else if (p.type === 'sketchpad') out.add('drawing');
    else if (p.type === 'text' && p.multiline) out.add('words');
    else if (p.type === 'file') {
      if (/audio/.test(p.accept)) out.add('audio');
      else if (/image\/(\*|jpe?g|png)/.test(p.accept)) out.add('photo');
      else if (/lrc|text/.test(p.accept)) out.add('words');
      else out.add('files');
    }
  }
  return [...out];
}

/** Gallery grouping: artworks by series; studies and tools as their own groups. */
const groupOf = (a: Artwork) => (a.kind === 'study' ? 'Studies' : a.kind === 'tool' ? 'Tools' : seriesOf(a));
const GROUP_ORDER = [...SERIES_ORDER, 'Studies', 'Tools'];
const rank = (g: string) => GROUP_ORDER.indexOf(g) + 1 || GROUP_ORDER.length + 1;

// ---------- lazy thumbnails ----------

const MAX_IN_FLIGHT = 3;
let inFlight = 0;
const waiting: (() => void)[] = [];
/** Runs thumbnail jobs a few at a time, so one slow (network-bound) piece doesn't block the rest. */
function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const go = () => {
      inFlight++;
      resolve(() => {
        inFlight--;
        waiting.shift()?.();
      });
    };
    if (inFlight < MAX_IN_FLIGHT) go();
    else waiting.push(go);
  });
}

const observer =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            observer!.unobserve(e.target);
            (e.target as HTMLElement & { load?: () => void }).load?.();
          }
        },
        { rootMargin: '400px' },
      )
    : null;

// ---------- filters ----------

interface Filters {
  q: string;
  group: string;
  uses: Use[];
}
const FILTER_KEY = 'aiplo:gallery';
function loadFilters(): Filters {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    return { q: String(f.q ?? ''), group: String(f.group ?? ''), uses: Array.isArray(f.uses) ? f.uses : [] };
  } catch {
    return { q: '', group: '', uses: [] };
  }
}
const filters = loadFilters();
const saveFilters = () => {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
  } catch {
    /* ignore */
  }
};

// ---------- building the gallery ----------

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

interface CardInfo {
  a: Artwork;
  node: HTMLElement;
  group: string;
  uses: Use[];
  haystack: string;
  thumb: HTMLElement;
}
let cards: CardInfo[] = [];
let built = false;

function card(a: Artwork): CardInfo {
  const group = groupOf(a);
  const uses = usesOf(a);
  const node = el('a', 'card') as HTMLAnchorElement;
  node.href = `#/art/${a.slug}`;
  const frame = el('div', 'thumb-frame');
  const thumb = el('div', 'thumb');
  frame.append(thumb);
  const meta = el('div', 'card-meta');
  meta.append(el('div', 'card-eyebrow', group), el('div', 'card-title', a.title), el('div', 'card-desc', a.description ?? ''));
  if (uses.length) {
    const badges = el('div', 'badges');
    for (const u of uses) badges.append(el('span', 'badge', USE_LABELS[u]));
    meta.append(badges);
  }
  node.append(frame, meta);
  const info: CardInfo = {
    a,
    node,
    group,
    uses,
    thumb,
    haystack: [a.title, a.description, group, a.slug, ...uses.map((u) => USE_LABELS[u])].join(' ').toLowerCase(),
  };
  queueThumb(info);
  return info;
}

/** Sizes the thumbnail to its paper and loads it once it scrolls near the viewport. */
function queueThumb(c: CardInfo) {
  const [pw, ph] = paperSize(piecePaper(c.a));
  c.thumb.style.aspectRatio = `${pw} / ${ph}`;
  c.thumb.classList.toggle('portrait', ph > pw);
  const load = () => loadThumb(c.a, c.thumb);
  if (observer) {
    (c.node as HTMLElement & { load?: () => void }).load = load;
    observer.observe(c.node);
  } else load();
}

function applyFilters(root: HTMLElement) {
  const terms = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const c of cards) {
    const ok =
      (!filters.group || c.group === filters.group) &&
      filters.uses.every((u) => c.uses.includes(u)) &&
      terms.every((t) => c.haystack.includes(t));
    c.node.hidden = !ok;
    if (ok) shown++;
  }
  root.querySelectorAll<HTMLButtonElement>('.chip[data-group]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === filters.group)));
  root.querySelectorAll<HTMLButtonElement>('.chip[data-use]').forEach((b) => b.setAttribute('aria-pressed', String(filters.uses.includes(b.dataset.use as Use))));
  root.querySelector('.gallery-count')!.textContent = shown === cards.length ? `${cards.length} pieces` : `${shown} of ${cards.length} pieces`;
  (root.querySelector('.gallery-empty') as HTMLElement).hidden = shown > 0;
  saveFilters();
}

function build(root: HTMLElement) {
  root.replaceChildren();
  const sorted = [...artworks].sort((x, y) => rank(groupOf(x)) - rank(groupOf(y)) || (x.order ?? 100) - (y.order ?? 100));
  cards = sorted.map(card);

  const head = el('header', 'gallery-head');
  const titles = el('div', 'gallery-titles');
  titles.append(el('h1', '', 'aiplo'), el('p', 'sub', 'Pen plotter sketchbook. Each piece is a script in src/art/.'));
  const search = el('input', 'gallery-search') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = 'Search pieces';
  search.value = filters.q;
  search.setAttribute('aria-label', 'Search pieces (press / to focus)');
  search.addEventListener('input', () => {
    filters.q = search.value;
    applyFilters(root);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = filters.q = '';
      applyFilters(root);
      search.blur();
    }
  });
  head.append(titles, search);

  const groups = el('div', 'chips');
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c.group, (counts.get(c.group) ?? 0) + 1);
  const groupChip = (g: string, label: string, n: number) => {
    const b = el('button', 'chip') as HTMLButtonElement;
    b.dataset.group = g;
    b.append(label, el('span', 'chip-count', String(n)));
    b.addEventListener('click', () => {
      filters.group = filters.group === g ? '' : g;
      applyFilters(root);
    });
    return b;
  };
  groups.append(groupChip('', 'All', cards.length));
  for (const g of [...counts.keys()].sort((x, y) => rank(x) - rank(y))) groups.append(groupChip(g, g, counts.get(g)!));

  const uses = el('div', 'chips chips-uses');
  uses.append(el('span', 'chips-label', 'Uses'));
  for (const u of Object.keys(USE_LABELS) as Use[]) {
    if (!cards.some((c) => c.uses.includes(u))) continue;
    const b = el('button', 'chip chip-small', USE_LABELS[u]) as HTMLButtonElement;
    b.dataset.use = u;
    b.addEventListener('click', () => {
      filters.uses = filters.uses.includes(u) ? filters.uses.filter((x) => x !== u) : [...filters.uses, u];
      applyFilters(root);
    });
    uses.append(b);
  }
  const bar = el('div', 'gallery-bar');
  bar.append(groups, uses, el('div', 'gallery-count'));

  const grid = el('div', 'gallery-grid');
  for (const c of cards) grid.append(c.node);
  const empty = el('p', 'gallery-empty', 'No pieces match. Try a different search or clear the filters.');
  root.append(head, bar, grid, empty);
  applyFilters(root);

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || root.hidden) return;
    const t = e.target as HTMLElement;
    if (t.matches('input, textarea, select')) return;
    e.preventDefault();
    search.focus();
  });
  built = true;
}

export function renderGallery(root: HTMLElement) {
  if (!built) return build(root);
  // Coming back from a piece: refresh thumbnails whose knobs or paper changed.
  for (const c of cards) queueThumb(c);
}
