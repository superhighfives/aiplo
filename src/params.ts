import { geocode } from './lib/terrain';

export type Values = Record<string, any>;
type Base = { key: string; label: string; show?: (v: Values) => boolean; hint?: string };

export type Location = { name: string; lat: number; lon: number };

export type ParamDef =
  | (Base & { type: 'number'; min: number; max: number; step?: number; default: number })
  | (Base & { type: 'select'; options: [string, string][]; default: string })
  | (Base & { type: 'checkbox'; default: boolean })
  | (Base & { type: 'seed'; default: number })
  | (Base & { type: 'location'; default: Location })
  | (Base & { type: 'code'; default: string })
  | (Base & { type: 'file'; accept: string; default: { name: string; text: string } });

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
        const input = el('input', { type: 'file', accept: d.accept });
        const name = el('span', { className: 'muted', textContent: values[d.key].name || 'No file loaded' });
        input.addEventListener('change', async () => {
          const f = input.files?.[0];
          if (!f) return;
          values[d.key] = { name: f.name, text: await f.text() };
          name.textContent = f.name;
          changed(d.key);
        });
        row.append(input, name);
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
