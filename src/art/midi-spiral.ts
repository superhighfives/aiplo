import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { loadFile } from '../lib/files';
import { chordTones, parseChord, parseMidi } from '../lib/music';
import { demoSong } from '../lib/song';
import type { Values } from '../params';
import { defineArtwork } from './types';

export interface NoteTrack {
  name: string;
  notes: { midi: number; time: number; duration: number; channel: number; velocity: number }[];
}

/** The demo song as MIDI-like tracks: the sung melody, and its chords (with a bass note) as a second track. */
export function demoTracks(): NoteTrack[] {
  const song = demoSong();
  const melody = song.notes.map((n) => ({ midi: n.midi, time: n.time, duration: n.duration * 0.95, channel: 0, velocity: 96 }));
  const chords: NoteTrack['notes'] = [];
  for (const c of song.chords) {
    const ch = parseChord(c.name);
    if (!ch) continue;
    const tones = chordTones(ch, 48);
    for (const m of [36 + ch.root, ...tones]) chords.push({ midi: m, time: c.time, duration: c.duration * 0.98, channel: 1, velocity: 70 });
  }
  return [
    { name: 'Melody', notes: melody },
    { name: 'Chords', notes: chords },
  ];
}

/** Groups notes into at most `pens` voices, by track or by channel; the smallest are merged. */
export function groupVoices(tracks: NoteTrack[], by: 'track' | 'channel', pens: number, skipDrums: boolean): NoteTrack[] {
  let groups: NoteTrack[];
  const keep = (n: NoteTrack['notes'][number]) => !(skipDrums && n.channel === 9);
  if (by === 'channel') {
    const m = new Map<number, NoteTrack>();
    for (const t of tracks)
      for (const n of t.notes) {
        if (!keep(n)) continue;
        if (!m.has(n.channel)) m.set(n.channel, { name: `Channel ${n.channel + 1}`, notes: [] });
        m.get(n.channel)!.notes.push(n);
      }
    groups = [...m.values()];
  } else groups = tracks.map((t) => ({ name: t.name, notes: t.notes.filter(keep) }));
  groups = groups.filter((g) => g.notes.length);
  if (groups.length > pens) {
    // Keep the busiest parts on their own pens (in file order); merge the rest onto the last pen.
    const bySize = [...groups].sort((a, b) => b.notes.length - a.notes.length);
    const own = new Set(bySize.slice(0, pens - 1));
    const rest = groups.filter((g) => !own.has(g));
    groups = [...groups.filter((g) => own.has(g)), { name: rest.length > 1 ? `${rest[0].name} + ${rest.length - 1} more` : rest[0].name, notes: rest.flatMap((g) => g.notes) }];
  }
  return groups;
}

/** The drawing. */
export function midiSpiral(voices: NoteTrack[], v: Values, W: number, H: number): Layer[] {
  const all = voices.flatMap((g) => g.notes);
  if (!all.length) throw new Error('No notes found in the MIDI file');
  const t0 = Math.min(...all.map((n) => n.time));
  const t1 = Math.max(...all.map((n) => n.time + n.duration));
  const span = Math.max(1e-3, t1 - t0);
  const ms = all.map((n) => n.midi).sort((a, b) => a - b);
  // Pitch range from percentiles, so one stray note doesn't squash everything.
  const lo = ms[Math.floor(ms.length * 0.01)], hi = Math.max(lo + 1, ms[Math.ceil(ms.length * 0.99) - 1]);
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2;
  const turns = v.turns;
  const r0 = R * v.inner;
  const spacing = (R - r0) / (turns + 1);
  const band = spacing * v.fill;
  const total = turns * 2 * Math.PI;
  const dir = v.direction === 'ccw' ? -1 : 1;
  const thetaOf = (t: number) => ((t - t0) / span) * total;
  const P = (r: number, th: number): Pt => {
    const a = -Math.PI / 2 + dir * th;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const baseR = (th: number) => r0 + (th / (2 * Math.PI)) * spacing;
  const pitchOff = (m: number) => band * Math.max(-0.1, Math.min(1.1, (m - lo) / (hi - lo)));

  const layers: Layer[] = voices.map((g, i) => {
    const paths: Polyline[] = [];
    for (const n of g.notes) {
      const a = thetaOf(n.time);
      let b = thetaOf(n.time + n.duration);
      const rA = baseR(a) + pitchOff(n.midi);
      // At least `minLen` mm long, so staccato notes still read as marks.
      const minDth = v.minLen / Math.max(1, rA);
      if (b - a < minDth) b = a + minDth;
      const steps = Math.max(2, Math.ceil(((b - a) * rA) / 0.4));
      const arc: Polyline = [];
      for (let k = 0; k <= steps; k++) {
        const th = a + ((b - a) * k) / steps;
        arc.push(P(baseR(th) + pitchOff(n.midi), th));
      }
      paths.push(arc);
      if (v.ticks !== 'none') {
        const h = v.tickLen / 2;
        const tick = (th: number) => [P(baseR(th) + pitchOff(n.midi) - h, th), P(baseR(th) + pitchOff(n.midi) + h, th)] as Polyline;
        paths.push(tick(a));
        if (v.ticks === 'both') paths.push(tick(b));
      }
    }
    return { name: g.name, color: PALETTE[i % PALETTE.length], paths };
  });
  if (v.guide) {
    const guide: Polyline = [];
    const steps = Math.ceil(total * (r0 + R) * 0.5 / 0.5);
    for (let k = 0; k <= steps; k++) {
      const th = (k / steps) * total;
      guide.push(P(baseR(th) - spacing * 0.08, th));
    }
    layers[layers.length - 1].paths.push(guide);
  }
  if (v.hub) layers[0].paths.push(circle(cx, cy, Math.max(1, r0 - spacing * 0.5), 120));
  return layers;
}

const parsed = new Map<string, Promise<ReturnType<typeof parseMidi>>>();

export default defineArtwork({
  slug: 'midi-spiral',
  title: 'MIDI spiral',
  description: 'A MIDI file wound into a spiral: time turns around the centre, pitch lifts each note off the line, one pen per part.',
  order: 83,
  series: 'Music',
  paper: { paper: 'square', margin: 15 },
  params: [
    { type: 'file', key: 'midi', label: 'MIDI file', accept: '.mid,.midi,audio/midi,audio/x-midi', default: [], hint: 'Without one, the public-domain demo song (melody and chords).' },
    { type: 'select', key: 'by', label: 'Pens by', options: [['track', 'Track'], ['channel', 'Channel']], default: 'track' },
    { type: 'number', key: 'pens', label: 'Pens', min: 1, max: 4, step: 1, default: 4, hint: 'Extra parts are merged onto the last pen' },
    { type: 'checkbox', key: 'skipDrums', label: 'Skip drums (channel 10)', default: true },
    { type: 'number', key: 'turns', label: 'Turns', min: 2, max: 60, step: 1, default: 9 },
    { type: 'number', key: 'inner', label: 'Inner radius', min: 0.02, max: 0.6, step: 0.01, default: 0.12 },
    { type: 'number', key: 'fill', label: 'Pitch band (× turn spacing)', min: 0.2, max: 2.5, step: 0.05, default: 0.8, hint: 'Above 1, high notes reach into the next turn' },
    { type: 'number', key: 'minLen', label: 'Shortest note (mm)', min: 0.3, max: 5, step: 0.1, default: 1.2 },
    { type: 'select', key: 'ticks', label: 'End ticks', options: [['start', 'At note starts'], ['both', 'Start and end'], ['none', 'None']], default: 'start' },
    { type: 'number', key: 'tickLen', label: 'Tick length (mm)', min: 0.3, max: 4, step: 0.1, default: 1.2, show: (v) => v.ticks !== 'none' },
    { type: 'select', key: 'direction', label: 'Direction', options: [['cw', 'Clockwise'], ['ccw', 'Anticlockwise']], default: 'cw' },
    { type: 'checkbox', key: 'guide', label: 'Guide spiral (last pen)', default: false },
    { type: 'checkbox', key: 'hub', label: 'Hub circle', default: true },
  ],
  caption: (v) => (v.midi?.[0]?.name ?? 'Twinkle, Twinkle, Little Star').replace(/\.[^.]+$/, ''),
  async generate(v, ctx) {
    let tracks: NoteTrack[];
    const ref = v.midi?.[0];
    if (!ref) tracks = demoTracks();
    else {
      let p = parsed.get(ref.id);
      if (!p) {
        p = (async () => {
          const f = await loadFile(v.midi);
          if (!f) throw new Error(`MIDI file ${ref.name} is missing; upload it again`);
          return parseMidi(new Uint8Array(await f.blob.arrayBuffer()));
        })();
        p.catch(() => parsed.delete(ref.id));
        parsed.set(ref.id, p);
      }
      const mf = await p;
      tracks = mf.tracks.map((t) => ({ name: t.name, notes: t.notes }));
      ctx.status(`${ref.name}: ${mf.tracks.filter((t) => t.notes.length).length} tracks, ${mf.tracks.reduce((a, t) => a + t.notes.length, 0)} notes, ${mf.duration.toFixed(1)} s`);
    }
    const voices = groupVoices(tracks, v.by, Math.max(1, Math.min(4, Math.round(v.pens))), v.skipDrums);
    return midiSpiral(voices, v, ctx.width, ctx.height);
  },
});
