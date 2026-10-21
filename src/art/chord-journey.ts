import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { FONT_OPTIONS, text } from '../lib/hershey';
import { CIRCLE_MAJOR, CIRCLE_MINOR, parseChart, type Chart } from '../lib/music';
import type { Values } from '../params';
import { defineArtwork } from './types';

/** The demo song's chords (two per 4/4 bar), as `chartFromTimed(demoSong().chords, …)` writes them. */
export const DEMO_CHART = `[Verse]
| C C | F C | F C | G C |

[Bridge]
| C F | C G | C F | C G |

[Verse]
| C C | F C | F C | G C |`;

/** The drawing, from a parsed chart. */
export function chordJourney(chart: Chart, v: Values, W: number, H: number): Layer[] {
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2;
  const label = v.labels ? v.labelSize : 0;
  const rMaj = R - label * 2.2 - 2;
  const rMin = rMaj * v.innerRatio;
  const rot = (-v.rotate * Math.PI) / 6; // rotate by circle steps
  const angle = (pos: number) => -Math.PI / 2 + (pos * Math.PI) / 6 + rot;
  const P = (r: number, a: number): Pt => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  // Each visit to a chord lands a little to one side, so lines arriving and leaving fan apart.
  const visitCount = new Map<string, number>();
  const nodeOf = (c: Chart['chords'][number]['chord'], bump = false) => {
    const key = `${c.minor ? 'm' : 'M'}${c.fifths}`;
    const k = visitCount.get(key) ?? 0;
    if (bump) visitCount.set(key, k + 1);
    // Alternate sides along the ring: 0, +1, −1, +2, −2… spreads, wrapping after 12 visits.
    const j = k % 12;
    const side = ((j + 1) >> 1) * (j % 2 ? 1 : -1) * v.spread;
    const rr = c.minor ? rMin : rMaj;
    return P(rr, angle(c.fifths) + side / rr);
  };

  // The wheel: rings, node marks, labels.
  const wheel: Polyline[] = [];
  if (v.rings) {
    wheel.push(circle(cx, cy, rMaj, 360));
    if (v.inner) wheel.push(circle(cx, cy, rMin, 300));
  }
  const visits = new Map<string, number>();
  for (const c of chart.chords) {
    const k = `${c.chord.minor ? 'm' : 'M'}${c.chord.fifths}`;
    visits.set(k, (visits.get(k) ?? 0) + c.len);
  }
  for (let i = 0; i < 12; i++) {
    const a = angle(i);
    for (const minor of v.inner ? [false, true] : [false]) {
      const [x, y] = P(minor ? rMin : rMaj, a);
      const bars = visits.get(`${minor ? 'm' : 'M'}${i}`) ?? 0;
      // Every position gets a small mark; chords the song visits get rings, more for longer stays.
      // (Rings start outside the spread of arriving lines, so ink doesn't pile up on the node.)
      if (!bars) wheel.push(circle(x, y, v.node, 20));
      else for (let k = 1; k <= Math.min(3, Math.ceil(Math.sqrt(bars))); k++) wheel.push(circle(x, y, v.node + 0.8 + k * 1.3, 32));
      if (label) {
        const name = minor ? CIRCLE_MINOR[i] : CIRCLE_MAJOR[i];
        const lr = minor ? rMin - label * 1.6 - v.node : rMaj + label * 1.3 + v.node;
        const [lx, ly] = P(lr, a);
        wheel.push(...text(name, { x: lx, y: ly + label / 2, size: minor ? label * 0.8 : label, font: v.font, align: 'center' }));
      }
    }
  }

  // Journeys: one continuous path per section occurrence, curving through the interior.
  const pens = chart.sections.slice(0, 5);
  const paths = pens.map(() => [] as Polyline[]);
  const hopCount = new Map<string, number>();
  const runs = new Map<string, Chart['chords']>();
  for (const c of chart.chords) {
    const key = `${c.section}\u0000${c.occurrence}`;
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key)!.push(c);
  }
  // Carry the journey across section boundaries: each run starts from the previous chord.
  let prev: Chart['chords'][number] | null = null;
  for (const run of runs.values()) {
    const pen = Math.min(pens.length - 1, Math.max(0, pens.indexOf(run[0].section)));
    const seq = prev && v.connect ? [prev, ...run] : run;
    const line: Polyline = [];
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1].chord, b = seq[i].chord;
      const pa = line.length ? line[line.length - 1] : nodeOf(a, true);
      const pb = a.fifths === b.fifths && a.minor === b.minor ? pa : nodeOf(b, true);
      // Count the move in either direction, so there-and-back trips stack too.
      const ends = [`${a.minor ? 'm' : ''}${a.fifths}`, `${b.minor ? 'm' : ''}${b.fifths}`].sort();
      const key = `${pen}:${ends.join('-')}`;
      const k = hopCount.get(key) ?? 0;
      hopCount.set(key, k + 1);
      if (!line.length) line.push(pa);
      if (a.fifths === b.fifths && a.minor === b.minor) {
        // Same chord again (a new bar): a small loop from the node into the interior and back.
        if (!v.loops) continue;
        const aa = Math.atan2(pa[1] - cy, pa[0] - cx);
        const rad = (v.loopSize + Math.min(6, k) * v.offset * 0.25) / 2;
        const lc = P(Math.hypot(pa[0] - cx, pa[1] - cy) - rad, aa);
        for (let s = 1; s <= 36; s++) {
          const u = aa + (s / 36) * 2 * Math.PI;
          line.push([lc[0] + rad * Math.cos(u), lc[1] + rad * Math.sin(u)]);
        }
        continue;
      }
      // Cubic Bézier whose control points are pulled from each chord towards the centre, so moves
      // swoop through the interior; repeats of the same move pull a little further and fan out.
      // The controls also swing away from the direction of travel, so each move is a rounded lobe
      // rather than a spike, even between neighbouring chords.
      const pull = Math.min(1.6, v.pull + (k * v.offset) / R);
      const aA = Math.atan2(pa[1] - cy, pa[0] - cx), aB = Math.atan2(pb[1] - cy, pb[0] - cx);
      let dA = aB - aA;
      while (dA > Math.PI) dA -= 2 * Math.PI;
      while (dA < -Math.PI) dA += 2 * Math.PI;
      const sw = ((v.swing * Math.PI) / 180) * Math.sign(dA || 1) * (1 + k * 0.15);
      const ctl = (p: Pt, a: number, s: number): Pt => {
        const rr = Math.hypot(p[0] - cx, p[1] - cy) * (1 - pull);
        return [cx + rr * Math.cos(a + s), cy + rr * Math.sin(a + s)];
      };
      const c1 = ctl(pa, aA, -sw);
      const c2 = ctl(pb, aB, sw);
      const n = 64;
      for (let s = 1; s <= n; s++) {
        const t = s / n, u = 1 - t;
        const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
        line.push([w0 * pa[0] + w1 * c1[0] + w2 * c2[0] + w3 * pb[0], w0 * pa[1] + w1 * c1[1] + w2 * c2[1] + w3 * pb[1]]);
      }
    }
    if (line.length > 1) paths[pen].push(line);
    prev = run[run.length - 1];
  }
  const layers: Layer[] = [{ name: 'Circle of fifths', color: PALETTE[0], paths: wheel }];
  pens.forEach((name, i) => layers.push({ name, color: PALETTE[1 + (i % (PALETTE.length - 1))], paths: paths[i] }));
  return layers;
}

export default defineArtwork({
  slug: 'chord-journey',
  title: 'Chord journey',
  description: 'A song’s chord progression travelling around the circle of fifths, one pen per section.',
  order: 82,
  series: 'Music',
  paper: { paper: 'square', margin: 18 },
  params: [
    { type: 'text', key: 'chart', label: 'Chord chart', multiline: true, default: DEMO_CHART, placeholder: '[Verse]\n| Am | F | C | G |', hint: '[Section] lines, | between bars; % repeats a bar, x2 repeats a line. Lyric lines are ignored.' },
    { type: 'number', key: 'pull', label: 'Pull towards the centre', min: 0, max: 1.4, step: 0.01, default: 0.7, hint: "Past 1 the curves swing beyond the centre" },
    { type: 'number', key: 'swing', label: 'Swing (°)', min: -90, max: 90, step: 1, default: 40, hint: 'Rounds each move into a lobe; 0 = straight in and out' },
    { type: 'number', key: 'offset', label: 'Offset per repeat (mm)', min: 0, max: 20, step: 0.1, default: 9, hint: 'Repeated moves bow a little further each time so they stack' },
    { type: 'number', key: 'spread', label: 'Spread per visit (mm)', min: 0, max: 3, step: 0.05, default: 0.6, hint: 'Each return to a chord lands a little to the side, so lines don’t pile up on the node' },
    { type: 'checkbox', key: 'connect', label: 'Join sections into one journey', default: true },
    { type: 'checkbox', key: 'loops', label: 'Loop when a chord repeats', default: true },
    { type: 'number', key: 'loopSize', label: 'Loop size (mm)', min: 1, max: 30, step: 0.5, default: 8, show: (v) => v.loops },
    { type: 'checkbox', key: 'inner', label: 'Relative minors (inner ring)', default: true },
    { type: 'number', key: 'innerRatio', label: 'Inner ring size', min: 0.3, max: 0.9, step: 0.01, default: 0.66 },
    { type: 'checkbox', key: 'rings', label: 'Draw the rings', default: true },
    { type: 'number', key: 'node', label: 'Node mark (mm)', min: 0.3, max: 4, step: 0.1, default: 1 },
    { type: 'number', key: 'rotate', label: 'Rotate (steps)', min: -6, max: 6, step: 1, default: 0, hint: 'Turn the wheel so the song’s key sits at the top' },
    { type: 'checkbox', key: 'labels', label: 'Labels', default: true },
    { type: 'number', key: 'labelSize', label: 'Label size (mm)', min: 2, max: 10, step: 0.1, default: 4.5, show: (v) => v.labels },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural', show: (v) => v.labels },
  ],
  generate(v, ctx) {
    const chart = parseChart(v.chart ?? '');
    if (chart.chords.length < 2) throw new Error('Write at least two chords, e.g. “| Am | F | C | G |”');
    const skipped = chart.unknown.length ? ` · ignored ${chart.unknown.slice(0, 4).join(' ')}${chart.unknown.length > 4 ? '…' : ''}` : '';
    ctx.status(`${chart.chords.length} chords, ${chart.bars} bars, ${chart.sections.length} section${chart.sections.length === 1 ? '' : 's'}${skipped}`);
    return chordJourney(chart, v, ctx.width, ctx.height);
  },
});
