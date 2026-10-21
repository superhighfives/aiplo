import { circle, smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { contourLevels } from '../lib/elevation';
import type { Location, PlaceList } from '../params';
import { defineArtwork } from './types';

/** Places onto the page: equirectangular around their mean latitude, fitted with a margin. */
function placeSources(places: Location[], W: number, H: number): Pt[] {
  if (places.length === 1) return [[W / 2, H / 2]];
  const lat0 = (places.reduce((s, p) => s + p.lat, 0) / places.length) * (Math.PI / 180);
  // Unwrap longitudes around the first place so a set straddling the antimeridian stays together.
  const lon0 = places[0].lon;
  const xy = places.map((p) => [(((p.lon - lon0 + 540) % 360) - 180) * Math.cos(lat0), -p.lat] as Pt);
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = 0.2;
  const k = Math.min((W * (1 - 2 * pad)) / Math.max(1e-9, x1 - x0), (H * (1 - 2 * pad)) / Math.max(1e-9, y1 - y0));
  return xy.map(([x, y]) => [W / 2 + (x - (x0 + x1) / 2) * k, H / 2 + (y - (y0 + y1) / 2) * k]);
}

export default defineArtwork({
  slug: 'interference',
  title: 'Wave interference',
  description: 'Ripples spreading from several sources, drawn as contour lines where they add up and cancel out.',
  order: 65,
  paper: { paper: 'a4', orientation: 'landscape', margin: 15 },
  params: [
    { type: 'select', key: 'from', label: 'Sources', options: [['random', 'Random'], ['places', 'Places']], default: 'random' },
    { type: 'number', key: 'count', label: 'Source count', min: 1, max: 12, step: 1, default: 3, show: (v) => v.from === 'random' },
    { type: 'seed', key: 'seed', label: 'Seed', default: 2, hint: 'Source positions (random) and phases' },
    {
      type: 'places', key: 'places', label: 'Places', show: (v) => v.from === 'places',
      default: { text: 'London\nParis\nEdinburgh', places: [{ name: 'London', lat: 51.5074, lon: -0.1278 }, { name: 'Paris', lat: 48.8566, lon: 2.3522 }, { name: 'Edinburgh', lat: 55.9533, lon: -3.1883 }] },
      hint: 'One per line (e.g. family homes); placed on the page by their relative positions',
    },
    { type: 'number', key: 'wavelength', label: 'Wavelength (mm)', min: 2, max: 60, step: 0.5, default: 16 },
    { type: 'number', key: 'falloff', label: 'Falloff', min: 0, max: 0.2, step: 0.002, default: 0.02, hint: 'How quickly each ripple fades with distance (per mm)' },
    { type: 'number', key: 'levels', label: 'Levels', min: 1, max: 9, step: 1, default: 3, hint: '1 draws only the zero crossings, where waves cancel' },
    { type: 'number', key: 'spread', label: 'Level spread', min: 0.1, max: 2, step: 0.05, default: 0.8, show: (v) => v.levels > 1, hint: 'How far the outer levels sit from zero, in standard deviations of the field' },
    { type: 'select', key: 'pens', label: 'Pens', options: [['one', 'One pen'], ['two', 'Crests and troughs on two pens']], default: 'two', show: (v) => v.levels > 1 },
    { type: 'number', key: 'curves', label: 'Smoothing (mm)', min: 0, max: 4, step: 0.1, default: 1 },
    { type: 'checkbox', key: 'marks', label: 'Mark sources', default: true },
  ],
  caption: (v) => (v.from === 'places' ? (v.places as PlaceList).places.map((p) => p.name.split(',')[0]).join(' · ') : ''),
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const places: Location[] = (v.places as PlaceList | undefined)?.places ?? [];
    let src: Pt[];
    if (v.from === 'places' && places.length) src = placeSources(places, W, H);
    else {
      if (v.from === 'places') ctx.status('No places resolved yet: using random sources');
      src = Array.from({ length: v.count }, () => [W * (0.15 + 0.7 * ctx.rng()), H * (0.15 + 0.7 * ctx.rng())] as Pt);
    }
    const phase = src.map(() => ctx.rng() * 2 * Math.PI);
    const k = (2 * Math.PI) / v.wavelength;
    const field = (u: number, w: number) => {
      const x = u * W, y = w * H;
      let s = 0;
      for (let i = 0; i < src.length; i++) {
        const r = Math.hypot(x - src[i][0], y - src[i][1]);
        s += Math.sin(k * r + phase[i]) / (1 + v.falloff * r);
      }
      return s;
    };

    // Levels: symmetric about zero, scaled to the field's spread.
    let sum2 = 0, n = 0;
    for (let j = 0; j <= 60; j++) for (let i = 0; i <= 60; i++, n++) sum2 += field(i / 60, j / 60) ** 2;
    const sd = Math.sqrt(sum2 / n);
    const L = Math.max(1, Math.round(v.levels));
    const levels = L === 1 ? [0] : Array.from({ length: L }, (_, i) => sd * v.spread * ((i / (L - 1)) * 2 - 1));
    // Resolution: ~12 samples per wavelength, within 0.3–1 mm.
    const cell = Math.max(0.3, Math.min(1, v.wavelength / 12));
    const lines = contourLevels(field, W, H, levels, cell).map((ls) => ls.map((l) => smooth(l, v.curves)));

    const marks: Polyline[] = v.marks ? src.map(([x, y]) => circle(x, y, 1.5, 24)) : [];
    if (L === 1 || v.pens === 'one') return [{ name: 'Waves', color: PALETTE[0], paths: [...lines.flat(), ...marks] }];
    const layers: Layer[] = [
      { name: 'Troughs', color: PALETTE[2], paths: lines.filter((_, i) => levels[i] < -1e-9).flat() },
      { name: 'Crests', color: PALETTE[1], paths: lines.filter((_, i) => levels[i] > 1e-9).flat() },
    ];
    const zero = lines.filter((_, i) => Math.abs(levels[i]) <= 1e-9).flat();
    if (zero.length || marks.length) layers.unshift({ name: 'Nodes', color: PALETTE[0], paths: [...zero, ...marks] });
    return layers;
  },
});
