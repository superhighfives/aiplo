import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import type { Audio } from '../lib/audio';
import { analyseRhythm, loadSongOrDemo } from '../lib/music';
import type { Values } from '../params';
import { defineArtwork } from './types';

/** The drawing, from decoded audio. Pure, so it can be tested without AudioContext. */
export function rhythmMandala(audio: Audio, v: Values, W: number, H: number, status?: (m: string) => void): Layer[] {
  const sens = Math.max(0, Math.min(1, v.sensitivity));
  const r = analyseRhythm(audio.samples, audio.sampleRate, { delta: 0.004 + 0.2 * (1 - sens) ** 2, minGap: 0.04 });
  const bpb = Math.max(1, Math.round(v.beats));
  const period = v.bpm > 0 ? 60 / v.bpm : r.period;
  const barDur = bpb * period;
  status?.(`${r.bpm.toFixed(1)} bpm · ${r.onsets.length} onsets`);
  if (!r.onsets.length) throw new Error('No onsets found; raise the sensitivity');

  // Downbeat: the beat phase with the most onset energy; near-ties go to the phase of the first
  // strong onset (songs usually start on a downbeat).
  const beat0 = r.beats[0] ?? r.onsets[0].time;
  const phaseOf = (t: number) => ((Math.round((t - beat0) / period) % bpb) + bpb) % bpb;
  let phase = 0;
  if (v.downbeat >= 0) phase = Math.round(v.downbeat) % bpb;
  else {
    const score = new Array(bpb).fill(0);
    for (const o of r.onsets) if (Math.abs(((t) => t - Math.round(t))((o.time - beat0) / period)) < 0.15) score[phaseOf(o.time)] += o.strength;
    const mx = Math.max(...score);
    const firstStrong = r.onsets.find((o) => o.strength > 0.5) ?? r.onsets[0];
    const fp = phaseOf(firstStrong.time);
    phase = score[fp] >= mx * 0.9 ? fp : score.indexOf(mx);
  }
  let t0 = beat0 + phase * period;
  const firstT = Math.min(r.onsets[0].time, r.beats[0] ?? Infinity);
  t0 -= Math.ceil(Math.max(0, t0 - firstT - 1e-6) / barDur) * barDur;
  const lastT = audio.duration;
  const bars = Math.max(1, Math.ceil((lastT - t0) / barDur - 1e-6));

  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2;
  const r0 = R * v.inner;
  const dr = (R - r0) / (bars + (v.rings === 'spiral' ? 1 : 0.15) + (v.spokes === 'rim' ? 1.7 : 0));
  const len = dr * v.tickLength;
  const ang = (frac: number) => -Math.PI / 2 + 2 * Math.PI * frac;
  // Radius of the ring line for time t (concentric: per bar; spiral: continuous).
  const baseR = (t: number) => {
    const b = (t - t0) / barDur;
    return r0 + (v.rings === 'spiral' ? b : Math.floor(b)) * dr;
  };
  const P = (rad: number, a: number): Pt => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];

  const ticks: Polyline[] = [];
  const guides: Polyline[] = [];
  const envLines: Polyline[] = [];
  for (const o of r.onsets) {
    const b = (o.time - t0) / barDur;
    if (b < 0) continue;
    const a = ang(b - Math.floor(b));
    const rb = baseR(o.time);
    const L = Math.max(0.4, len * o.strength ** v.gamma);
    if (v.tick === 'line') ticks.push([P(rb, a), P(rb + L, a)]);
    else if (v.tick === 'petal') {
      // A thin lens from the ring out to the tip, width growing with strength.
      const wdt = Math.min(0.3 * dr, 0.13 * L + 0.2) / Math.max(rb + L / 2, 1);
      const pts: Pt[] = [];
      for (let k = 0; k <= 16; k++) {
        const u = k / 16;
        pts.push(P(rb + L * u, a + wdt * Math.sin(Math.PI * u)));
      }
      for (let k = 15; k >= 0; k--) {
        const u = k / 16;
        pts.push(P(rb + L * u, a - wdt * Math.sin(Math.PI * u)));
      }
      ticks.push(pts);
    } else if (v.tick === 'tri') {
      const wdt = Math.min(0.45 * dr, 0.4 * L + 0.4) / Math.max(rb, 1);
      ticks.push([P(rb, a - wdt), P(rb + L, a), P(rb, a + wdt)]);
    } else {
      const c = P(rb + L / 2, a);
      ticks.push(circle(c[0], c[1], Math.max(0.3, L / 2), 24));
    }
  }
  // Rings or spiral (pen 2), optionally drawn as the onset envelope itself.
  const env = r.envelope;
  const envAt = (t: number) => {
    const x = t / r.hop;
    const i = Math.floor(x), f = x - i;
    if (i < 0 || i >= env.length - 1) return 0;
    return env[i] * (1 - f) + env[i + 1] * f;
  };
  if (v.rings === 'spiral') {
    const line: Polyline = [];
    const steps = Math.ceil(bars * 720);
    for (let k = 0; k <= steps; k++) {
      const t = t0 + (k / steps) * bars * barDur;
      const b = (t - t0) / barDur;
      line.push(P(baseR(t) - (v.envelope ? envAt(t) * dr * v.envAmp : 0), ang(b)));
    }
    (v.envelope ? envLines : guides).push(line);
  } else if (v.rings === 'rings') {
    for (let b = 0; b < bars; b++) {
      const rb = r0 + b * dr;
      if (!v.envelope) guides.push(circle(cx, cy, rb, Math.ceil(rb * 3) + 24));
      else {
        const line: Polyline = [];
        for (let k = 0; k <= 720; k++) {
          const t = t0 + (b + k / 720) * barDur;
          line.push(P(rb - envAt(t) * dr * v.envAmp, ang(k / 720)));
        }
        envLines.push(line);
      }
    }
  }
  // Beat spokes, with shorter subdivision marks: right across the rings, or only at hub and rim.
  if (v.spokes !== 'none') {
    const outer = r0 + bars * dr + (v.rings === 'spiral' ? dr : 0);
    const hub = r0 * 0.55;
    for (let k = 0; k < bpb * v.subdiv; k++) {
      const main = k % v.subdiv === 0;
      const a = ang(k / (bpb * v.subdiv));
      if (v.spokes === 'full') guides.push([P(main ? hub : r0 * 0.85, a), P(main ? outer + dr * 0.25 : r0 + dr * 0.15, a)]);
      else {
        guides.push([P(main ? hub : (hub + r0) / 2, a), P(r0 - dr * 0.2, a)]);
        guides.push([P(outer + dr * (main ? 0.5 : 0.5), a), P(outer + dr * (main ? 1.6 : 0.95), a)]);
      }
    }
    guides.push(circle(cx, cy, hub, Math.ceil(hub * 2) + 24));
  }
  const layers: Layer[] = [{ name: 'Onsets', color: PALETTE[0], paths: ticks }];
  if (envLines.length) layers.push({ name: 'Envelope', color: PALETTE[1], paths: envLines });
  if (guides.length) layers.push({ name: 'Bars and beats', color: PALETTE[2], paths: guides });
  return layers;
}

export default defineArtwork({
  slug: 'rhythm-mandala',
  title: 'Rhythm mandala',
  description: 'A song’s rhythm as a mandala: bars as rings, beats as spokes, every onset a tick at its moment in the bar.',
  order: 81,
  series: 'Music',
  paper: { paper: 'square', margin: 15 },
  mainThread: true,
  params: [
    { type: 'file', key: 'audio', label: 'Audio', accept: 'audio/*', default: [], hint: 'Anything with a beat. Without one, a public-domain demo song is used.' },
    { type: 'number', key: 'beats', label: 'Beats per bar', min: 1, max: 16, step: 1, default: 4 },
    { type: 'number', key: 'subdiv', label: 'Subdivisions per beat', min: 1, max: 4, step: 1, default: 2, hint: 'Short spokes between the beats' },
    { type: 'number', key: 'downbeat', label: 'Downbeat (beat)', min: -1, max: 15, step: 1, default: -1, hint: '−1 = guess; otherwise which detected beat starts the bar' },
    { type: 'number', key: 'bpm', label: 'Tempo override (bpm)', min: 0, max: 240, step: 0.1, default: 0, hint: '0 = detect' },
    { type: 'number', key: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.01, default: 0.8, hint: 'Higher picks up softer onsets' },
    { type: 'select', key: 'tick', label: 'Tick style', options: [['petal', 'Petal'], ['line', 'Line'], ['tri', 'Triangle'], ['dot', 'Circle']], default: 'petal' },
    { type: 'number', key: 'tickLength', label: 'Tick length (× ring gap)', min: 0.2, max: 3, step: 0.05, default: 1.5 },
    { type: 'number', key: 'gamma', label: 'Strength curve', min: 0.2, max: 3, step: 0.05, default: 0.7, hint: '<1 lifts soft onsets, >1 favours the loud ones' },
    { type: 'select', key: 'rings', label: 'Bars as', options: [['rings', 'Concentric rings'], ['spiral', 'Spiral'], ['none', 'Nothing']], default: 'rings' },
    { type: 'checkbox', key: 'envelope', label: 'Rings follow the onset envelope (pen 2)', default: true, show: (v) => v.rings !== 'none' },
    { type: 'number', key: 'envAmp', label: 'Envelope depth (× ring gap)', min: 0, max: 1.5, step: 0.05, default: 0.7, show: (v) => v.rings !== 'none' && v.envelope },
    { type: 'select', key: 'spokes', label: 'Beat spokes', options: [['rim', 'At hub and rim'], ['full', 'Across the rings'], ['none', 'None']], default: 'rim' },
    { type: 'number', key: 'inner', label: 'Inner radius', min: 0.05, max: 0.6, step: 0.01, default: 0.16 },
  ],
  caption: (v) => (v.audio?.[0]?.name ?? 'Twinkle, Twinkle, Little Star').replace(/\.[^.]+$/, ''),
  async generate(v, ctx) {
    const { audio } = await loadSongOrDemo(v.audio, ctx.status);
    return rhythmMandala(audio, v, ctx.width, ctx.height, ctx.status);
  },
});
