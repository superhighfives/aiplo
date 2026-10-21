import type { Polyline } from './geom';
import { putFile, type FileRef } from './lib/files';
import { geocode } from './lib/terrain';

export type Values = Record<string, any>;
type Base = { key: string; label: string; show?: (v: Values) => boolean; hint?: string };

export type Location = { name: string; lat: number; lon: number };

/** Value of a `places` knob: the text as typed, and the places it resolved to. */
export type PlaceList = { text: string; places: Location[] };

/** Value of a `sketchpad` knob: strokes in [0, 1] × [0, 1 / aspect] coordinates. */
export type Sketch = Polyline[];

export type ParamDef =
  | (Base & { type: 'number'; min: number; max: number; step?: number; default: number })
  | (Base & { type: 'select'; options: [string, string][]; default: string })
  | (Base & { type: 'checkbox'; default: boolean })
  | (Base & { type: 'seed'; default: number })
  | (Base & { type: 'location'; default: Location })
  | (Base & { type: 'code'; default: string })
  /** Files are stored in IndexedDB; the value is FileRef[] (load with `loadFiles`). */
  | (Base & { type: 'file'; accept: string; multiple?: boolean; default: FileRef[] })
  | (Base & { type: 'text'; multiline?: boolean; placeholder?: string; default: string })
  /** ISO 'YYYY-MM-DD', or 'YYYY-MM-DDTHH:mm' (local time) when `time` is set. */
  | (Base & { type: 'date'; time?: boolean; default: string })
  /** One place per line: names are geocoded, "lat, lon" lines are used as-is. */
  | (Base & { type: 'places'; default: PlaceList })
  /** Draw with the mouse or a pen; `aspect` is width / height of the pad. */
  | (Base & { type: 'sketchpad'; aspect?: number; default: Sketch });

export function defaultsOf(defs: ParamDef[]): Values {
  const v: Values = {};
  for (const d of defs) v[d.key] = structuredClone(d.default);
  return v;
}

/** Fill in missing keys (e.g. after adding params) without clobbering saved ones. */
export function withDefaults(defs: ParamDef[], saved: Values | undefined): Values {
  return { ...defaultsOf(defs), ...(saved ?? {}) };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  Object.assign(e, attrs);
  e.append(...children);
  return e;
}

export function renderParams(root: HTMLElement, defs: ParamDef[], values: Values, onChange: (key: string) => void) {
  root.replaceChildren();
  const rows: [ParamDef, HTMLElement][] = [];
  const refresh = () => {
    for (const [d, row] of rows) row.hidden = d.show ? !d.show(values) : false;
  };
  const changed = (key: string) => {
    refresh();
    onChange(key);
  };

  for (const d of defs) {
    const row = el('div', { className: `param param-${d.type}` });
    if (d.hint) row.title = d.hint;
    const label = el('label', { textContent: d.label });
    row.append(label);

    switch (d.type) {
      case 'number': {
        const range = el('input', { type: 'range', min: d.min, max: d.max, step: d.step ?? 'any', value: values[d.key] });
        const num = el('input', { type: 'number', min: d.min, max: d.max, step: d.step ?? 'any', value: values[d.key] });
        range.addEventListener('input', () => {
          num.value = range.value;
          values[d.key] = Number(range.value);
          changed(d.key);
        });
        num.addEventListener('change', () => {
          if (num.value === '' || isNaN(Number(num.value))) return;
          range.value = num.value;
          values[d.key] = Number(num.value);
          changed(d.key);
        });
        row.append(range, num);
        break;
      }
      case 'select': {
        const sel = el('select');
        for (const [value, text] of d.options) sel.append(el('option', { value, textContent: text }));
        sel.value = values[d.key];
        sel.addEventListener('change', () => {
          values[d.key] = sel.value;
          changed(d.key);
        });
        row.append(sel);
        break;
      }
      case 'checkbox': {
        const cb = el('input', { type: 'checkbox', checked: values[d.key] });
        cb.addEventListener('change', () => {
          values[d.key] = cb.checked;
          changed(d.key);
        });
        label.prepend(cb);
        break;
      }
      case 'seed': {
        const num = el('input', { type: 'number', step: 1, value: values[d.key] });
        const dice = el('button', { textContent: '🎲', title: 'Random seed' });
        num.addEventListener('change', () => {
          values[d.key] = Math.floor(Number(num.value) || 0);
          changed(d.key);
        });
        dice.addEventListener('click', () => {
          values[d.key] = Math.floor(Math.random() * 1e6);
          num.value = String(values[d.key]);
          changed(d.key);
        });
        row.append(num, dice);
        break;
      }
      case 'location': {
        const loc = values[d.key] as Location;
        const q = el('input', { type: 'text', value: loc.name, placeholder: 'Search a place…' });
        const go = el('button', { textContent: 'Find' });
        const lat = el('input', { type: 'number', step: 'any', value: loc.lat, title: 'Latitude' });
        const lon = el('input', { type: 'number', step: 'any', value: loc.lon, title: 'Longitude' });
        const results = el('div', { className: 'geo-results' });
        const set = (l: Location) => {
          values[d.key] = l;
          q.value = l.name;
          lat.value = String(l.lat);
          lon.value = String(l.lon);
          results.replaceChildren();
          changed(d.key);
        };
        const search = async () => {
          results.textContent = 'Searching…';
          try {
            const found = await geocode(q.value);
            results.replaceChildren();
            if (!found.length) results.textContent = 'No results';
            if (found.length === 1) return set(found[0]);
            for (const f of found) {
              const b = el('button', { className: 'link', textContent: f.name });
              b.addEventListener('click', () => set(f));
              results.append(b);
            }
          } catch (e) {
            results.textContent = `Search failed: ${(e as Error).message}`;
          }
        };
        go.addEventListener('click', search);
        q.addEventListener('keydown', (e) => e.key === 'Enter' && search());
        const coords = () => set({ name: `${Number(lat.value).toFixed(4)}, ${Number(lon.value).toFixed(4)}`, lat: Number(lat.value), lon: Number(lon.value) });
        lat.addEventListener('change', coords);
        lon.addEventListener('change', coords);
        row.append(el('div', { className: 'geo-search' }, q, go), el('div', { className: 'geo-coords' }, lat, lon), results);
        break;
      }
      case 'file': {
        if (!Array.isArray(values[d.key])) values[d.key] = [];
        const input = el('input', { type: 'file', accept: d.accept, multiple: !!d.multiple });
        const list = el('div', { className: 'muted file-list' });
        const show = () => {
          const refs = values[d.key] as FileRef[];
          list.textContent = refs.length ? refs.map((r) => r.name).join(', ') : 'No file loaded';
        };
        const clear = el('button', { className: 'mini', textContent: 'Clear' });
        clear.addEventListener('click', () => {
          values[d.key] = [];
          input.value = '';
          show();
          changed(d.key);
        });
        input.addEventListener('change', async () => {
          const files = [...(input.files ?? [])];
          if (!files.length) return;
          list.textContent = 'Storing…';
          try {
            values[d.key] = await Promise.all(files.map(putFile));
          } catch (e) {
            list.textContent = `Could not store file: ${(e as Error).message}`;
            return;
          }
          show();
          changed(d.key);
        });
        show();
        row.append(input, el('div', { className: 'file-row' }, list, clear));
        break;
      }
      case 'text': {
        const input = d.multiline
          ? el('textarea', { value: values[d.key], rows: 4, placeholder: d.placeholder ?? '', spellcheck: false })
          : el('input', { type: 'text', value: values[d.key], placeholder: d.placeholder ?? '' });
        const apply = () => {
          if (values[d.key] === input.value) return;
          values[d.key] = input.value;
          changed(d.key);
        };
        input.addEventListener('change', apply);
        input.addEventListener('keydown', (e) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' && (!d.multiline || ke.metaKey || ke.ctrlKey)) apply();
        });
        row.append(input);
        break;
      }
      case 'date': {
        const input = el('input', { type: d.time ? 'datetime-local' : 'date', value: values[d.key] });
        input.addEventListener('change', () => {
          if (!input.value) return;
          values[d.key] = input.value;
          changed(d.key);
        });
        row.append(input);
        break;
      }
      case 'places': {
        const value = values[d.key] as PlaceList;
        const ta = el('textarea', { value: value.text, rows: 5, spellcheck: false, placeholder: 'One place per line, or "lat, lon"' });
        const go = el('button', { textContent: 'Find all' });
        const status = el('div', { className: 'muted geo-results' });
        const show = (p: PlaceList) => (status.textContent = p.places.map((l) => l.name.split(',')[0]).join(' · ') || 'No places');
        go.addEventListener('click', async () => {
          const lines = ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
          const places: Location[] = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const m = line.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s+(.+))?$/);
            if (m) {
              places.push({ name: m[3] ?? line, lat: Number(m[1]), lon: Number(m[2]) });
              continue;
            }
            // Reuse earlier results so editing one line doesn't re-geocode everything.
            const known = (values[d.key] as PlaceList).places.find((p) => p.name.toLowerCase().startsWith(line.toLowerCase()));
            if (known) {
              places.push(known);
              continue;
            }
            status.textContent = `Finding ${line}… (${i + 1}/${lines.length})`;
            try {
              const [hit] = await geocode(line);
              if (hit) places.push(hit);
              await new Promise((r) => setTimeout(r, 1100)); // Nominatim allows ~1 request per second
            } catch {
              /* skip places that fail */
            }
          }
          values[d.key] = { text: ta.value, places };
          show(values[d.key]);
          changed(d.key);
        });
        show(value);
        row.append(ta, go, status);
        break;
      }
      case 'sketchpad': {
        const aspect = d.aspect ?? 3;
        const W = 260;
        const H = Math.round(W / aspect);
        const canvas = el('canvas', { width: W * 2, height: H * 2, className: 'sketchpad' });
        canvas.style.aspectRatio = `${aspect}`;
        const ctx = canvas.getContext('2d')!;
        const strokes = (): Sketch => values[d.key];
        const draw = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.lineWidth = 3;
          ctx.lineCap = ctx.lineJoin = 'round';
          ctx.strokeStyle = '#1c2230';
          for (const s of strokes()) {
            ctx.beginPath();
            s.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x * canvas.width, y * aspect * canvas.height));
            ctx.stroke();
          }
        };
        let cur: Polyline | null = null;
        const at = (e: PointerEvent): [number, number] => {
          const r = canvas.getBoundingClientRect();
          return [(e.clientX - r.left) / r.width, ((e.clientY - r.top) / r.height) / aspect];
        };
        canvas.addEventListener('pointerdown', (e) => {
          canvas.setPointerCapture(e.pointerId);
          cur = [at(e)];
          values[d.key] = [...strokes(), cur];
        });
        canvas.addEventListener('pointermove', (e) => {
          if (!cur) return;
          cur.push(at(e));
          draw();
        });
        const end = () => {
          if (!cur) return;
          if (cur.length < 2) values[d.key] = strokes().filter((s) => s !== cur);
          cur = null;
          draw();
          changed(d.key);
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
        const undo = el('button', { className: 'mini', textContent: 'Undo' });
        const clear = el('button', { className: 'mini', textContent: 'Clear' });
        undo.addEventListener('click', () => {
          values[d.key] = strokes().slice(0, -1);
          draw();
          changed(d.key);
        });
        clear.addEventListener('click', () => {
          values[d.key] = [];
          draw();
          changed(d.key);
        });
        draw();
        row.append(canvas, el('div', { className: 'file-row' }, undo, clear));
        break;
      }
      case 'code': {
        const ta = el('textarea', { value: values[d.key], spellcheck: false, rows: 16 });
        const run = el('button', { textContent: 'Run (⌘↵)' });
        const apply = () => {
          values[d.key] = ta.value;
          changed(d.key);
        };
        run.addEventListener('click', apply);
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) apply();
        });
        row.append(ta, run);
        break;
      }
    }
    rows.push([d, row]);
    root.append(row);
  }
  refresh();
}
