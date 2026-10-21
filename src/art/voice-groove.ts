import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type GenOutput } from '../layers';
import { envelope, loadAudio, waveform, type Audio } from '../lib/audio';
import type { Values } from '../params';
import { defineArtwork } from './types';

/** The drawing, from decoded audio. Pure, so it can be tested without AudioContext. */
export function voiceGroove(audio: Audio, v: Values, W: number, H: number): GenOutput {
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2;
  const r0 = Math.min(v.inner, R * 0.9);
  const turns = v.turns;
  const wob = v.wobble;
  // Leave room for the wobble at the outer edge.
  const spacing = v.spacing > 0 ? v.spacing : (R - r0 - wob - 1) / turns;
  const start = Math.min(v.start, audio.duration - 0.1);
  const end = v.end > 0 ? Math.max(start + 0.1, Math.min(audio.duration, v.end)) : audio.duration;
  const count = v.signal === 'wave' ? Math.max(16, Math.round(turns * v.detail)) : Math.max(16, Math.round(((end - start) * 1000) / v.window));
  const wave = v.signal === 'wave';
  const sig = wave ? waveform(audio.samples, audio.sampleRate, count, start, end) : envelope(audio.samples, audio.sampleRate, count, start, end);
  if (!wave) {
    // Stretch the envelope so its quietest 5% sits at 0: dense music still shows its dynamics.
    const sorted = Float32Array.from(sig).sort();
    const floor = sorted[Math.floor(sorted.length * 0.05)];
    for (let i = 0; i < count; i++) sig[i] = Math.max(0, (sig[i] - floor) / (1 - floor || 1));
  }
  const at = (t: number) => {
    const x = t * (count - 1);
    const i = Math.floor(x), f = x - i;
    return sig[i] * (1 - f) + (sig[Math.min(count - 1, i + 1)] ?? 0) * f;
  };

  // Outside in, like a record: t = 0 at the rim. Step by arc length.
  const step = v.signal === 'zigzag' ? Math.min(0.25, v.carrier / 8) : 0.25;
  const groove: Polyline = [];
  const outer = r0 + turns * spacing;
  const total = turns * 2 * Math.PI;
  let th = 0;
  let arc = 0;
  while (th <= total) {
    const t = th / total;
    const base = outer - (th / (2 * Math.PI)) * spacing;
    // zigzag: a fixed-pitch wiggle whose width follows loudness (loud passages read darker, as on
    // a real record); envelope: loudness pushes the groove in and out; wave: the signal itself.
    const along = arc;
    const off = wave ? at(t) * wob * 0.5 : v.signal === 'zigzag' ? at(t) * wob * 0.5 * Math.sin((2 * Math.PI * along) / v.carrier) : (at(t) - 0.5) * wob;
    const r = base + off;
    const a = -Math.PI / 2 + th * (v.direction === 'ccw' ? -1 : 1);
    groove.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r] as Pt);
    th += step / Math.max(1, base);
    arc += step;
  }
  const layers = [{ name: 'Groove', color: PALETTE[0], paths: [groove] as Polyline[] }];
  if (v.label) {
    const label: Polyline[] = [circle(cx, cy, Math.max(2, r0 - spacing - wob), 180), circle(cx, cy, 3.6, 40)];
    if (v.rim) label.push(circle(cx, cy, Math.min(R, outer + wob + 1.5), 400));
    layers.push({ name: 'Label', color: PALETTE[1], paths: label });
  }
  return layers;
}

export default defineArtwork({
  slug: 'voice-groove',
  title: 'Voice groove',
  description: 'A recording cut as one continuous spiral groove, wobbling with its loudness like a record.',
  order: 41,
  paper: { paper: 'square', margin: 12 },
  mainThread: true,
  params: [
    { type: 'file', key: 'audio', label: 'Audio', accept: 'audio/*', default: [], hint: 'A voice note works well. Without one, a demo tune is used.' },
    { type: 'select', key: 'signal', label: 'Wobble from', options: [['zigzag', 'Loudness as wiggle width'], ['envelope', 'Loudness as radius'], ['wave', 'Waveform (downsampled)']], default: 'zigzag' },
    { type: 'number', key: 'carrier', label: 'Wiggle pitch (mm)', min: 0.3, max: 5, step: 0.05, default: 1.1, show: (v) => v.signal === 'zigzag' },
    { type: 'number', key: 'turns', label: 'Turns', min: 5, max: 150, step: 1, default: 42 },
    { type: 'number', key: 'spacing', label: 'Groove spacing (mm)', min: 0, max: 6, step: 0.05, default: 0, hint: '0 = fit the paper' },
    { type: 'number', key: 'wobble', label: 'Wobble (mm)', min: 0, max: 8, step: 0.05, default: 1.6 },
    { type: 'number', key: 'window', label: 'Envelope window (ms)', min: 2, max: 500, step: 1, default: 25, show: (v) => v.signal !== 'wave', hint: 'Longer = smoother loudness' },
    { type: 'number', key: 'detail', label: 'Detail (per turn)', min: 20, max: 1500, step: 10, default: 400, show: (v) => v.signal === 'wave', hint: 'Waveform samples per turn' },
    { type: 'number', key: 'inner', label: 'Inner radius (mm)', min: 5, max: 80, step: 0.5, default: 26 },
    { type: 'number', key: 'start', label: 'Start (s)', min: 0, max: 600, step: 0.5, default: 0 },
    { type: 'number', key: 'end', label: 'End (s)', min: 0, max: 600, step: 0.5, default: 0, hint: '0 = end of the track' },
    { type: 'select', key: 'direction', label: 'Direction', options: [['cw', 'Clockwise'], ['ccw', 'Anticlockwise']], default: 'cw' },
    { type: 'checkbox', key: 'label', label: 'Label & spindle hole', default: true, hint: 'On a second pen' },
    { type: 'checkbox', key: 'rim', label: 'Rim', default: false, show: (v) => v.label },
  ],
  caption: (v) => (v.audio?.[0]?.name ?? 'Demo tune').replace(/\.[^.]+$/, ''),
  async generate(v, ctx) {
    const audio = await loadAudio(v.audio, ctx.status);
    return voiceGroove(audio, v, ctx.width, ctx.height);
  },
});
