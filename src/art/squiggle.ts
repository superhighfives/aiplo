import type { Polyline } from '../geom';
import { imageParams, loadDarkness } from '../lib/image';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'squiggle',
  title: 'Squiggle portrait',
  description: 'A photo drawn as rows of sine squiggles that swell and tighten where the image is dark.',
  order: 50,
  paper: { paper: 'a4', orientation: 'portrait', margin: 20 },
  params: [
    ...imageParams(),
    { type: 'number', key: 'rows', label: 'Rows', min: 20, max: 250, step: 1, default: 80 },
    { type: 'number', key: 'amp', label: 'Max amplitude', min: 0.1, max: 1.5, step: 0.05, default: 0.95, hint: 'Peak height relative to the row spacing; above 1 rows overlap' },
    { type: 'number', key: 'freq', label: 'Frequency (waves/mm)', min: 0.1, max: 3, step: 0.05, default: 0.5 },
    { type: 'number', key: 'freqGain', label: 'Frequency boost', min: 0, max: 3, step: 0.1, default: 1, hint: 'Extra frequency in dark areas: 1 doubles it at full black' },
    { type: 'number', key: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.05, default: 1.2 },
    { type: 'number', key: 'floor', label: 'Cut-off', min: 0, max: 0.5, step: 0.01, default: 0.06, hint: 'Darkness below this draws a flat line' },
    { type: 'checkbox', key: 'snake', label: 'Join rows', default: false, hint: 'One continuous line, turning at the ends of the rows' },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const dark = await loadDarkness(v, W, H, ctx.status);
    const rows = Math.round(v.rows);
    const gap = H / rows;
    const amp = (v.amp * gap) / 2;
    const step = Math.min(0.15, 0.1 / v.freq);
    // Average darkness over the row's band so thin features between rows still register.
    const tone = (x: number, y: number) => {
      let s = 0;
      for (const f of [-0.33, 0, 0.33]) s += dark(x, Math.min(H, Math.max(0, y + f * gap)));
      const d = s / 3;
      if (d <= v.floor) return 0;
      return Math.pow((d - v.floor) / (1 - v.floor), v.gamma);
    };
    const lines: Polyline[] = [];
    for (let r = 0; r < rows; r++) {
      const y = (r + 0.5) * gap;
      const rev = v.snake && r % 2 === 1;
      const line: Polyline = [];
      let phase = 0;
      // Leave room at the ends for the turns when joining rows.
      const x0 = v.snake ? gap * 0.35 : 0, x1 = W - x0;
      let d = tone(rev ? x1 : x0, y);
      for (let t = x0; t <= x1 + 1e-9; t += step) {
        const x = rev ? x1 + x0 - t : t;
        // Low-pass the tone so amplitude changes don't make abrupt jumps.
        d += (tone(x, y) - d) * 0.35;
        line.push([x, y + Math.sin(phase) * amp * d]);
        phase += 2 * Math.PI * v.freq * (1 + v.freqGain * d) * step;
      }
      lines.push(line);
    }
    if (!v.snake) return lines;
    // Join the rows into one path with half-circle turns at the ends.
    const out: Polyline = [];
    for (let r = 0; r < lines.length; r++) {
      if (r > 0) {
        const [x0, y0] = out[out.length - 1];
        const [, y1] = lines[r][0];
        const side = r % 2 === 1 ? 1 : -1;
        const rad = (y1 - y0) / 2;
        for (let k = 1; k < 12; k++) {
          const a = (k / 12) * Math.PI;
          out.push([x0 + side * Math.sin(a) * rad * 0.6, y0 + rad - Math.cos(a) * rad]);
        }
      }
      out.push(...lines[r]);
    }
    return [out];
  },
});
