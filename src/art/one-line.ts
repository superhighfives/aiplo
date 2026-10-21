import { smooth, type Polyline } from '../geom';
import { imageParams, loadDarkness } from '../lib/image';
import { stipple, tour } from '../lib/stipple';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'one-line',
  title: 'One-line drawing',
  description: 'A photo as a single unbroken line: stippled dots joined by a short travelling-salesman tour.',
  order: 52,
  paper: { paper: 'letter', orientation: 'portrait', margin: 20 },
  params: [
    ...imageParams(),
    { type: 'number', key: 'points', label: 'Points', min: 300, max: 20000, step: 100, default: 9000, hint: 'More points, more detail and a longer line' },
    { type: 'number', key: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.05, default: 2.4, hint: 'Higher pushes points into the darkest areas' },
    { type: 'number', key: 'relax', label: 'Relaxation', min: 0, max: 30, step: 1, default: 10, hint: 'Weighted Lloyd passes: evens out the dot spacing' },
    { type: 'number', key: 'effort', label: 'Tour effort', min: 0, max: 10, step: 0.5, default: 3, hint: 'Seconds of 2-opt / Or-opt improvement (stops early when done)' },
    { type: 'number', key: 'round', label: 'Rounding (mm)', min: 0, max: 3, step: 0.1, default: 0, hint: 'Smooths the corners of the line' },
    { type: 'checkbox', key: 'closed', label: 'Closed loop', default: false },
    { type: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const dark = await loadDarkness(v, W, H, ctx.status);
    ctx.status('Stippling…');
    const pts = stipple(dark, W, H, ctx.rng, { count: v.points, gamma: v.gamma, iterations: v.relax });
    if (pts.length < 2) return [];
    ctx.status('Routing the line…');
    let line: Polyline = tour(pts, W, H, { timeBudget: v.effort * 1000, closed: v.closed });
    if (v.round > 0) line = smooth(line, v.round);
    return [line];
  },
});
