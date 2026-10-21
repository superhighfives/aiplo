import { translate, type Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { ridges } from '../lib/elevation';
import { FONT_OPTIONS, measureText, text } from '../lib/hershey';
import { defineArtwork } from './types';

const STATIONS: [string, string][] = [
  ['9414290', 'San Francisco, CA'],
  ['8518750', 'The Battery, New York'],
  ['8443970', 'Boston, MA'],
  ['8410140', 'Eastport, ME'],
  ['9447130', 'Seattle, WA'],
  ['9455920', 'Anchorage, AK'],
  ['8724580', 'Key West, FL'],
  ['8771450', 'Galveston Pier 21, TX'],
  ['1612340', 'Honolulu, HI'],
  ['custom', 'Other station ID…'],
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const STEP_MIN = 10;

const cache = new Map<string, Promise<Float64Array>>();

/** NOAA CO-OPS predictions (local standard/daylight time, metres above MLLW) for a whole month, every 10 minutes. */
function fetchTides(station: string, y: number, m: number): Promise<Float64Array> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = daysIn(y, m);
  const url =
    'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?' +
    new URLSearchParams({
      product: 'predictions', application: 'aiplo', datum: 'MLLW', units: 'metric', time_zone: 'lst_ldt', format: 'json',
      interval: String(STEP_MIN), station,
      begin_date: `${y}${pad(m + 1)}01`, end_date: `${y}${pad(m + 1)}${pad(days)} 23:59`,
    });
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      } catch (e) {
        throw new Error((e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message);
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) throw new Error(`HTTP ${res.status}`);
      if (body.error) throw new Error(String(body.error.message ?? 'error').trim());
      const n = days * 24 * (60 / STEP_MIN);
      const out = new Float64Array(n).fill(NaN);
      for (const r of body.predictions as { t: string; v: string }[]) {
        const d = +r.t.slice(8, 10), hh = +r.t.slice(11, 13), mm = +r.t.slice(14, 16);
        const i = ((d - 1) * 24 * 60 + hh * 60 + mm) / STEP_MIN;
        if (i >= 0 && i < n && Number.isInteger(i)) out[i] = Number(r.v);
      }
      // Fill holes (e.g. the skipped hour at a DST change) linearly between neighbours.
      for (let i = 0; i < n; i++) {
        if (!isNaN(out[i])) continue;
        let j = i;
        while (j < n && isNaN(out[j])) j++;
        const a = i > 0 ? out[i - 1] : j < n ? out[j] : 0;
        const b = j < n ? out[j] : a;
        for (let k = i; k < j; k++) out[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
        i = j;
      }
      return out;
    })();
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

/** A plausible semidiurnal-mixed tide from four constituents (SF-like amplitudes). Not real predictions. */
function syntheticTide(y: number, m: number): Float64Array {
  const n = daysIn(y, m) * 24 * (60 / STEP_MIN);
  const t0 = (Date.UTC(y, m, 1) - Date.UTC(2000, 0, 1)) / 3600_000; // hours since 2000
  const parts: [number, number, number][] = [
    // [amplitude m, period h, phase rad]
    [0.58, 12.4206012, 0.3],
    [0.13, 12.0, 1.1],
    [0.37, 23.9344696, 2.0],
    [0.23, 25.8193417, 0.7],
  ];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = t0 + (i * STEP_MIN) / 60;
    let s = 1.0;
    for (const [a, T, ph] of parts) s += a * Math.cos((2 * Math.PI * h) / T + ph);
    out[i] = s;
  }
  return out;
}

export default defineArtwork({
  slug: 'tides',
  title: 'Tides',
  description: "A month of a harbour's tide, one ridgeline per day, from NOAA predictions.",
  order: 35,
  paper: { paper: 'a4', orientation: 'portrait', margin: 20 },
  params: [
    { type: 'select', key: 'station', label: 'Station', options: STATIONS, default: '9414290' },
    { type: 'text', key: 'customId', label: 'NOAA station ID', default: '', placeholder: 'e.g. 9410170', show: (v) => v.station === 'custom', hint: 'Find IDs at tidesandcurrents.noaa.gov' },
    { type: 'date', key: 'month', label: 'Month', default: '2024-01-01', hint: 'Any day in the month' },
    { type: 'select', key: 'source', label: 'Data', default: 'noaa', options: [['noaa', 'NOAA predictions (synthetic if unavailable)'], ['synthetic', 'Synthetic tide (M2+S2+K1+O1)']] },
    { type: 'number', key: 'height', label: 'Wave height (mm)', min: 2, max: 80, step: 0.5, default: 30, hint: 'Height of the full tidal range' },
    { type: 'checkbox', key: 'occlude', label: 'Hide lines behind', default: true },
    { type: 'checkbox', key: 'labels', label: 'Labels', default: true, hint: 'Day numbers, hours and a title on a second pen' },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural', show: (v) => v.labels },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const md = /^(\d{4})-(\d{2})/.exec(v.month);
    if (!md) throw new Error('Pick a month');
    const y = +md[1], m = +md[2] - 1;
    const id = v.station === 'custom' ? String(v.customId).trim() : v.station;
    const name = v.station === 'custom' ? `Station ${id}` : STATIONS.find((s) => s[0] === v.station)![1];

    let data: Float64Array;
    let note: string;
    let synthetic = false;
    if (v.source === 'synthetic') {
      data = syntheticTide(y, m);
      synthetic = true;
      note = 'SYNTHETIC tide (M2+S2+K1+O1), not real predictions';
    } else {
      if (!/^\d{7}$/.test(id)) throw new Error('NOAA station IDs are 7 digits');
      ctx.status(`Fetching NOAA tide predictions for ${name}…`);
      try {
        data = await fetchTides(id, y, m);
        note = `NOAA predictions, ${name} (${id}), metres above MLLW`;
      } catch (e) {
        data = syntheticTide(y, m);
        synthetic = true;
        note = `NOAA failed (${(e as Error).message}): showing a SYNTHETIC tide instead`;
      }
    }

    const perDay = 24 * (60 / STEP_MIN);
    const days = data.length / perDay;
    let lo = Infinity, hi = -Infinity;
    for (const x of data) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    const range = hi - lo || 1;

    const font = v.font;
    const lab = 2.4;
    const labelW = v.labels ? measureText('31', { size: lab, font }) + 3 : 0;
    const titleH = v.labels ? 14 : 0;
    const footH = v.labels ? 7 : 0;
    const gw = W - labelW, gh = H - titleH - footH;
    // Height function for ridges: row t (0 = first day, at the back/top) and u across the day.
    const h = (u: number, t: number) => {
      const d = Math.min(days - 1, Math.round(t * (days - 1)));
      const x = Math.max(0, Math.min(perDay, u * perDay));
      const i0 = Math.floor(x), f = x - i0;
      const a = data[d * perDay + Math.min(perDay - 1, i0)];
      // Continue into the next day for the last sample so 24:00 meets the next row's 00:00.
      const bIdx = d * perDay + i0 + 1;
      const b = bIdx < data.length ? data[bIdx] : a;
      return ((a * (1 - f) + b * f) - lo) / range;
    };
    const lines = translate(ridges(h, gw, gh, { rows: days, height: v.height, occlude: v.occlude }), labelW, titleH);

    const labels: Polyline[] = [];
    if (v.labels) {
      // Row baselines: ridges puts row i at E + (i/(N-1)) · (H - E).
      const base = (d: number) => titleH + v.height + (days === 1 ? 0.5 : d / (days - 1)) * (gh - v.height);
      for (let d = 0; d < days; d++) {
        // At the row's mid-tide level, so labels stay evenly spaced.
        labels.push(...text(String(d + 1), { x: labelW - 2.5, y: base(d) - v.height / 2 + lab / 2, size: lab, font, align: 'right' }));
      }
      const title = `${name}  ·  ${MONTHS[m]} ${y}`;
      labels.push(...text(title, { x: labelW, y: 5, size: 4, font, tracking: 0.05 }));
      if (synthetic) labels.push(...text('synthetic tide', { x: W, y: 5, size: 2.4, font, align: 'right' }));
      else labels.push(...text(`range ${(hi - lo).toFixed(2)} m`, { x: W, y: 5, size: 2.4, font, align: 'right' }));
      const fy = H - 1.5;
      for (const hr of [0, 6, 12, 18, 24]) {
        const x = labelW + (hr / 24) * gw;
        labels.push([[x, fy - 4.5], [x, fy - 3.2]]);
        labels.push(...text(hr === 24 ? '24' : String(hr).padStart(2, '0'), { x, y: fy, size: 2, font, align: hr === 0 ? 'left' : hr === 24 ? 'right' : 'center' }));
      }
    }
    ctx.status(note);
    const layers: Layer[] = [{ name: 'Tide', color: PALETTE[0], paths: lines }];
    if (labels.length) layers.push({ name: 'Labels', color: PALETTE[2], paths: labels });
    return layers;
  },
});
