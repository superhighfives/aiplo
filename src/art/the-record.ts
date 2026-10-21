import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, toLayers, type Layer } from '../layers';
import type { Audio } from '../lib/audio';
import { FONT_OPTIONS, measureText, text, textAlong } from '../lib/hershey';
import { loadLyrics, lyricsParams, type LyricLine } from '../lib/lyrics';
import { fitSize, loadSong, songName, songWindow } from '../lib/music-text';
import type { Values } from '../params';
import { voiceGroove } from './voice-groove';
import { defineArtwork } from './types';

/** A circle from angle a0 sweeping `turns` full turns (positive = clockwise in y-down space). */
function arc(cx: number, cy: number, r: number, a0: number, turns: number): Polyline {
  const n = Math.max(32, Math.ceil(Math.abs(turns) * r * 2));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + (2 * Math.PI * turns * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

/** Groove angle (radians, screen space) at which time `t` is cut, matching voiceGroove. */
export function grooveAngle(t: number, start: number, end: number, turns: number, dir: 1 | -1): number {
  return -Math.PI / 2 + dir * 2 * Math.PI * turns * ((t - start) / (end - start));
}

export interface RingPlacement {
  line: number;
  ring: number;
  /** Start of the line along the ring, mm from the top, clockwise. */
  s: number;
  width: number;
  angle: number;
}

/**
 * Places each lyric line on a ring at the angle where it's sung, stacking lines that would
 * overlap onto rings further in. Pure, for testing.
 */
export function placeOnRings(lines: LyricLine[], o: { start: number; end: number; turns: number; dir: 1 | -1; radius: number; size: number; font: string; maxRings: number; spacing: number }): RingPlacement[] {
  const used: [number, number][][] = Array.from({ length: o.maxRings }, () => []);
  const out: RingPlacement[] = [];
  lines.forEach((l, i) => {
    if (l.time < o.start || l.time >= o.end) return;
    const angle = grooveAngle(l.time, o.start, o.end, o.turns, o.dir);
    const frac = (((angle + Math.PI / 2) / (2 * Math.PI)) % 1 + 1) % 1;
    let best = -1;
    let bestS = 0, bestW = 0;
    for (let k = 0; k < o.maxRings; k++) {
      const C = 2 * Math.PI * (o.radius - k * o.spacing);
      const s = frac * C;
      const w = measureText(l.text, { size: o.size, font: o.font }) + o.size;
      // Overlap test on the circle (intervals as fractions, so rings of different size compare).
      const a0 = s / C, a1 = (s + w) / C;
      const hit = used[k].some(([b0, b1]) => [-1, 0, 1].some((m) => a0 < b1 + m && b0 + m < a1));
      if (!hit && w < C) {
        best = k;
        bestS = s;
        bestW = w;
        used[k].push([a0, a1]);
        break;
      }
    }
    if (best >= 0) out.push({ line: i, ring: best, s: bestS, width: bestW, angle });
  });
  return out;
}

/** The drawing, from decoded audio and lyrics. Pure, so it can be tested without AudioContext. */
export function theRecord(audio: Audio, lines: LyricLine[], v: Values, W: number, H: number, title: string, isDemo: boolean): Layer[] {
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2;
  const font = v.font;
  const dir: 1 | -1 = v.direction === 'ccw' ? -1 : 1;
  const [start, end] = songWindow(v, audio.duration);
  const groove: Polyline[] = [];
  const letters: Polyline[] = [];
  const lyricsOut: Polyline[] = [];

  // --- Outer ring of lyrics ---
  const ls = v.lyricSize;
  const ringSpacing = ls * 1.75;
  const ringTop = R - 1.5; // caps reach here
  let ringsUsed = 0;
  if (v.lyricsRing !== 'off' && lines.length) {
    const rb = ringTop - ls; // baseline radius of the outermost ring
    if (v.lyricsRing === 'continuous') {
      const str = lines.map((l) => l.text.trim()).filter(Boolean).join('  ·  ') + '  ·  ';
      const C = 2 * Math.PI * rb;
      // Grow the lettering (up to 1.4×) to go round once, then track out any remainder.
      const w0 = measureText(str, { size: ls, font });
      const size = Math.min(ls * 1.4, (ls * C) / w0);
      const w = measureText(str, { size, font });
      const chars = [...str].length;
      const tracking = Math.min(0.8, Math.max(0, (C - w) / Math.max(1, chars) / size));
      lyricsOut.push(...textAlong(str, arc(cx, cy, rb, -Math.PI / 2, 1), { size, font, tracking }));
      ringsUsed = 1;
    } else {
      const places = placeOnRings(lines, { start, end, turns: v.turns, dir, radius: rb, size: ls, font, maxRings: v.maxRings, spacing: ringSpacing });
      for (const p of places) {
        const r = rb - p.ring * ringSpacing;
        // Two laps, so a line starting near the top still has room to finish.
        lyricsOut.push(...textAlong(lines[p.line].text.trim(), arc(cx, cy, r, -Math.PI / 2, 2), { size: ls, font, shift: p.s }));
        ringsUsed = Math.max(ringsUsed, p.ring + 1);
      }
    }
  }
  const leadStart = ringsUsed ? ringTop - ls - (ringsUsed - 1) * ringSpacing - ls * 0.6 - 1.2 : R - 1.5;

  // --- Grooves: lead-in, the music, run-out, locked groove ---
  const labelR = Math.max(10, R * v.labelSize);
  const lockR = labelR + 2.5;
  const r0 = labelR + v.runout;
  const leadTurns = 1.5;
  const musicOuter = leadStart - v.leadPitch * leadTurns;
  const wob = v.wobble;
  const turns = v.turns;
  const spacing = v.spacing > 0 ? v.spacing : Math.max(0.2, (musicOuter - wob / 2 - r0) / turns);
  const music = voiceGroove(audio, { ...v, start, end, inner: r0, spacing, wobble: wob, label: false, rim: false }, 2 * R, 2 * R);
  const cut = (toLayers(music)[0].paths[0] ?? []).map(([x, y]) => [x - R + cx, y - R + cy] as Pt);
  const outer = r0 + turns * spacing;
  // Lead-in: a wide-pitched spiral from the rim into the start of the music (angle -π/2).
  const lead: Polyline = [];
  const leadOuter = outer + v.leadPitch * leadTurns;
  for (let i = 0, n = Math.ceil(leadTurns * leadOuter * 2); i <= n; i++) {
    const f = i / n; // 0 at the rim
    const phi = -leadTurns * 2 * Math.PI * (1 - f);
    const r = outer - (phi / (2 * Math.PI)) * v.leadPitch;
    const a = -Math.PI / 2 + dir * phi;
    lead.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  // Run-out: from the end of the music, a fast spiral down to the locked groove.
  const total = turns * 2 * Math.PI;
  const runTurns = 1.75;
  const run: Polyline = [];
  for (let i = 1, n = Math.ceil(runTurns * r0 * 2); i <= n; i++) {
    const f = i / n;
    const phi = total + f * runTurns * 2 * Math.PI;
    // Ease in so the groove leaves the music smoothly.
    const r = r0 - (r0 - lockR) * (f * f * (3 - 2 * f));
    const a = -Math.PI / 2 + dir * phi;
    run.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  const aEnd = -Math.PI / 2 + dir * (total + runTurns * 2 * Math.PI);
  const locked = arc(cx, cy, lockR, aEnd, dir);
  groove.push([...lead, ...cut, ...run, ...locked]);
  if (v.rim) groove.push(circle(cx, cy, R, 600));

  // --- Label ---
  letters.push(circle(cx, cy, labelR, Math.ceil(labelR * 6)), circle(cx, cy, 3.6, 40));
  const ts = v.labelText * (labelR / 30);
  const pad = Math.max(1.5, ts * 0.6);
  const titleStr = (v.title || title).trim();
  const artistStr = (v.artist || (isDemo ? 'Traditional' : '')).trim();
  if (titleStr) {
    const rb = labelR - pad - ts;
    const size = fitSize(titleStr, Math.PI * rb * 0.95, ts, font);
    // Clockwise from the bottom: its middle is at the top, reading left to right.
    letters.push(...textAlong(titleStr, arc(cx, cy, labelR - pad - size, Math.PI / 2, 1), { size, font, align: 'center' }));
  }
  if (artistStr) {
    const size = fitSize(artistStr, Math.PI * (labelR - pad) * 0.8, ts * 0.8, font);
    // Anticlockwise from the top: its middle is at the bottom, glyphs standing towards the centre.
    letters.push(...textAlong(artistStr, arc(cx, cy, labelR - pad, -Math.PI / 2, -1), { size, font, align: 'center' }));
  }
  // Middle: the side above the spindle, speed beside it, the dedication below.
  const inner = labelR - pad - ts * 1.6; // room inside the curved lettering
  const ms = ts * 0.7;
  const side = String(v.side ?? '').trim();
  if (side) {
    const size = fitSize(side, inner * 1.2, ms * 1.3, font);
    letters.push(...text(side, { x: cx, y: cy - 3.6 - Math.max(3, inner * 0.28), size, font, align: 'center' }));
  }
  if (v.speed !== 'none') {
    const sp = v.speed === '45' ? '45' : '33 1/3';
    const size = ms * 0.75;
    letters.push(...text(sp, { x: cx - 3.6 - 2, y: cy + size / 2, size, font, align: 'right' }));
    letters.push(...text('RPM', { x: cx + 3.6 + 2, y: cy + size / 2, size, font, align: 'left' }));
  }
  const ded = (v.dedication || (isDemo ? 'Words by Jane Taylor, 1806' : '')).split('\n').map((s: string) => s.trim()).filter(Boolean);
  ded.forEach((line: string, k: number) => {
    const y = cy + 3.6 + Math.max(3, inner * 0.22) + ms + k * ms * 1.6;
    const half = Math.sqrt(Math.max(0, inner * inner - (y - cy) ** 2));
    const size = fitSize(line, half * 1.8, ms, font);
    letters.push(...text(line, { x: cx, y, size, font, align: 'center' }));
  });

  const layers: Layer[] = [
    { name: 'Groove', color: PALETTE[0], paths: groove },
    { name: 'Label', color: PALETTE[1], paths: letters },
  ];
  if (lyricsOut.length) layers.push({ name: 'Lyrics', color: v.lyricsPen === 'label' ? PALETTE[1] : PALETTE[0], paths: lyricsOut });
  return layers;
}

export default defineArtwork({
  slug: 'the-record',
  title: 'The record',
  description: 'A song cut as a vinyl record: lead-in, a groove that wobbles with the music, run-out, and a lettered label, with the lyrics around the rim.',
  order: 71,
  series: 'Music',
  paper: { paper: 'square', margin: 10 },
  mainThread: true,
  params: [
    { type: 'file', key: 'audio', label: 'Audio', accept: 'audio/*', default: [], hint: 'Without one, a public-domain demo song is used.' },
    { type: 'text', key: 'title', label: 'Title', default: '', placeholder: 'Blank = the song’s name' },
    { type: 'text', key: 'artist', label: 'Artist', default: '', placeholder: 'Around the bottom of the label' },
    { type: 'text', key: 'side', label: 'Above the spindle', default: 'Side A' },
    { type: 'text', key: 'dedication', label: 'Date or dedication', multiline: true, default: '', placeholder: 'For Sam · 20 October 2026', hint: 'Below the spindle' },
    { type: 'select', key: 'speed', label: 'Speed', options: [['33', '33 1/3 RPM'], ['45', '45 RPM'], ['none', 'None']], default: '33' },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
    { type: 'number', key: 'labelSize', label: 'Label size', min: 0.2, max: 0.6, step: 0.01, default: 0.36, hint: 'Label radius as a fraction of the record' },
    { type: 'number', key: 'labelText', label: 'Label lettering size', min: 1, max: 8, step: 0.1, default: 3.6 },
    ...lyricsParams(),
    { type: 'select', key: 'lyricsRing', label: 'Lyrics around the rim', options: [['timed', 'Each line where it’s sung'], ['continuous', 'One continuous ring'], ['off', 'Off']], default: 'timed', show: (v) => v.lyricsSource !== 'none' },
    { type: 'number', key: 'lyricSize', label: 'Lyrics size (mm)', min: 1, max: 6, step: 0.1, default: 2.4, show: (v) => v.lyricsRing !== 'off' },
    { type: 'number', key: 'maxRings', label: 'Max lyric rings', min: 1, max: 6, step: 1, default: 3, show: (v) => v.lyricsRing === 'timed', hint: 'Lines that would overlap stack inwards' },
    { type: 'select', key: 'lyricsPen', label: 'Lyrics pen', options: [['label', 'Label pen'], ['groove', 'Groove pen']], default: 'label', show: (v) => v.lyricsRing !== 'off' },
    { type: 'select', key: 'signal', label: 'Wobble from', options: [['zigzag', 'Loudness as wiggle width'], ['envelope', 'Loudness as radius'], ['wave', 'Waveform (downsampled)']], default: 'zigzag' },
    { type: 'number', key: 'carrier', label: 'Wiggle pitch (mm)', min: 0.3, max: 5, step: 0.05, default: 1.1, show: (v) => v.signal === 'zigzag' },
    { type: 'number', key: 'turns', label: 'Turns', min: 5, max: 150, step: 1, default: 30 },
    { type: 'number', key: 'spacing', label: 'Groove spacing (mm)', min: 0, max: 6, step: 0.05, default: 0, hint: '0 = fit between lead-in and run-out' },
    { type: 'number', key: 'wobble', label: 'Wobble (mm)', min: 0, max: 8, step: 0.05, default: 1.2 },
    { type: 'number', key: 'window', label: 'Envelope window (ms)', min: 2, max: 500, step: 1, default: 25, show: (v) => v.signal !== 'wave' },
    { type: 'number', key: 'detail', label: 'Detail (per turn)', min: 20, max: 1500, step: 10, default: 400, show: (v) => v.signal === 'wave' },
    { type: 'number', key: 'leadPitch', label: 'Lead-in pitch (mm)', min: 0.5, max: 6, step: 0.1, default: 2 },
    { type: 'number', key: 'runout', label: 'Run-out width (mm)', min: 4, max: 30, step: 0.5, default: 10 },
    { type: 'number', key: 'start', label: 'Start (s)', min: 0, max: 600, step: 0.5, default: 0 },
    { type: 'number', key: 'end', label: 'End (s)', min: 0, max: 600, step: 0.5, default: 0, hint: '0 = end of the track' },
    { type: 'select', key: 'direction', label: 'Direction', options: [['cw', 'Clockwise'], ['ccw', 'Anticlockwise']], default: 'cw' },
    { type: 'checkbox', key: 'rim', label: 'Rim', default: true },
  ],
  caption: (v) => songName(v),
  async generate(v, ctx) {
    const audio = await loadSong(v, ctx.status);
    const lines = await loadLyrics(v, audio.duration, ctx.status);
    const isDemo = !(Array.isArray(v.audio) && v.audio.length);
    return theRecord(audio, lines, v, ctx.width, ctx.height, songName(v), isDemo);
  },
});
