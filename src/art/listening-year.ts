import type { Polyline, Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { loadFiles } from '../lib/files';
import { FONT_OPTIONS, measureText, text, textAlong } from '../lib/hershey';
import { mulberry32 } from '../random';
import type { Values } from '../params';
import { defineArtwork } from './types';

/** One listen: when it ended (ms since epoch), who, what, for how long. */
export interface Play {
  end: number;
  artist: string;
  track: string;
  ms: number;
}

/**
 * Reads Spotify data-export JSON: the account-data `StreamingHistory_music_*.json`
 * (`endTime`, `artistName`, `trackName`, `msPlayed`) or the Extended history
 * `Streaming_History_Audio_*.json` (`ts`, `ms_played`, `master_metadata_album_artist_name`,
 * `master_metadata_track_name`). The format is detected from the keys; podcasts and
 * audiobooks (no track/artist) are skipped.
 */
export function parseSpotify(json: unknown): { plays: Play[]; format: 'account' | 'extended' | 'unknown' } {
  if (!Array.isArray(json)) return { plays: [], format: 'unknown' };
  const sample = json.find((r) => r && typeof r === 'object') as Record<string, unknown> | undefined;
  if (!sample) return { plays: [], format: 'unknown' };
  const plays: Play[] = [];
  if ('ts' in sample && 'ms_played' in sample) {
    for (const r of json as Record<string, any>[]) {
      const artist = r.master_metadata_album_artist_name, track = r.master_metadata_track_name;
      const end = Date.parse(r.ts);
      if (!artist || !track || !isFinite(end)) continue;
      plays.push({ end, artist, track, ms: Number(r.ms_played) || 0 });
    }
    return { plays, format: 'extended' };
  }
  if ('endTime' in sample && 'msPlayed' in sample) {
    for (const r of json as Record<string, any>[]) {
      // "2024-03-14 21:05" in UTC.
      const end = Date.parse(String(r.endTime).replace(' ', 'T') + ':00Z');
      if (!r.artistName || !isFinite(end) || r.artistName === 'Unknown Artist') continue;
      plays.push({ end, artist: r.artistName, track: r.trackName ?? '', ms: Number(r.msPlayed) || 0 });
    }
    return { plays, format: 'account' };
  }
  return { plays: [], format: 'unknown' };
}

// Clearly fictional artists for the demo (made-up compounds, not real acts).
const DEMO_ARTISTS = [
  'Saltwater Bicycle Club', 'The Velvet Cartographers', 'Marigold Static', 'Juniper & the Low Tide', 'Plum Satellite',
  'Ivy Teleprompter', 'The Lantern Accountants', 'Owlbrook Choir', 'Copper Kite Assembly', 'Mildred Avalanche',
  'Quiet Orchard Radio', 'Fennel Parade', 'The Cardigan Comets', 'Nimbus Lullaby', 'Biscuit Observatory',
  'Polaroid Weather', 'Tin Harbour', 'The Moss Telegrams', 'Clementine Engine', 'Lake Hollow Duo',
  'Gravel & Gold Leaf', 'Static Peony', 'The Sleepy Funicular', 'Paper Planetarium',
];
const WORDS_A = ['Paper', 'Silver', 'Northern', 'Quiet', 'Electric', 'Borrowed', 'Late', 'Golden', 'Hollow', 'Little', 'Slow', 'Blue', 'Sunday', 'Glass'];
const WORDS_B = ['Lanterns', 'Harbour', 'Weather', 'Morning', 'Telephone', 'Orchard', 'Kites', 'Radio', 'Summer', 'Ferris Wheel', 'Postcards', 'Tide', 'Comet', 'Avenue'];

/** A plausible, seeded year of listening as `StreamingHistory_music` records, so the demo exercises the parser. */
export function demoHistory(year: number, seed: number): Record<string, unknown>[] {
  const rng = mulberry32(seed);
  const n = DEMO_ARTISTS.length;
  // Zipf-ish popularity, plus a "discovery" season per artist when they're on heavy rotation.
  const pop = DEMO_ARTISTS.map((_, i) => 1 / Math.pow(i + 1.5, 1.05));
  const season = DEMO_ARTISTS.map(() => ({ mid: rng() * 365, width: 12 + rng() * 40, boost: rng() < 0.45 ? 2 + rng() * 6 : 0 }));
  const tracks = DEMO_ARTISTS.map(() => Array.from({ length: 4 + Math.floor(rng() * 9) }, () => `${WORDS_A[Math.floor(rng() * WORDS_A.length)]} ${WORDS_B[Math.floor(rng() * WORDS_B.length)]}`));
  // Holidays: a couple of quiet stretches.
  const away = [Math.floor(rng() * 300), Math.floor(rng() * 300)].map((d) => [d, d + 4 + Math.floor(rng() * 9)]);
  const out: Record<string, unknown>[] = [];
  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  let mood = 1;
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.UTC(year, 0, 1 + d));
    const dow = date.getUTCDay();
    mood = Math.max(0.3, Math.min(2.2, mood + (rng() - 0.5) * 0.35));
    const seasonal = 1 + 0.25 * Math.cos(((d - 20) / days) * 2 * Math.PI); // more in winter
    let minutes = 55 * mood * seasonal * (dow === 0 || dow === 6 ? 1.45 : 1) * (0.6 + rng() * 0.8);
    if (away.some(([a, b]) => d >= a && d <= b)) minutes *= 0.08;
    if (rng() < 0.03) minutes *= 2.5; // the odd marathon
    if (rng() < 0.04) minutes = 0;
    const w = pop.map((p, i) => p * (1 + season[i].boost * Math.exp(-(((d - season[i].mid) / season[i].width) ** 2))));
    const wsum = w.reduce((a, b) => a + b, 0);
    let t = (7 + rng() * 10) * 3600; // start of the day's listening, seconds after midnight UTC
    let left = minutes * 60;
    while (left > 20) {
      let x = rng() * wsum, i = 0;
      while (i < n - 1 && (x -= w[i]) > 0) i++;
      const len = Math.min(left, 140 + rng() * 160) * (rng() < 0.12 ? 0.15 : 1); // some skips
      t += len + (rng() < 0.1 ? rng() * 7200 : 5);
      left -= len;
      const end = new Date(Date.UTC(year, 0, 1 + d) + t * 1000);
      const endTime = end.toISOString().slice(0, 16).replace('T', ' ');
      out.push({ endTime, artistName: DEMO_ARTISTS[i], trackName: tracks[i][Math.floor(rng() * tracks[i].length)], msPlayed: Math.round(len * 1000) });
    }
  }
  return out;
}

export interface YearStats {
  /** Local midnight of each day → minutes. */
  days: Map<number, number>;
  /** Same, for the top artist only. */
  topDays: Map<number, number>;
  artists: { name: string; minutes: number }[];
  years: number[];
  totalMinutes: number;
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function summarise(plays: Play[], year: number | null, minMs = 0): YearStats {
  const sel = plays.filter((p) => p.ms >= minMs && (year === null || new Date(p.end).getFullYear() === year));
  const byArtist = new Map<string, number>();
  for (const p of sel) byArtist.set(p.artist, (byArtist.get(p.artist) ?? 0) + p.ms / 60000);
  const artists = [...byArtist].map(([name, minutes]) => ({ name, minutes })).sort((a, b) => b.minutes - a.minutes);
  const top = artists[0]?.name;
  const days = new Map<number, number>(), topDays = new Map<number, number>();
  for (const p of sel) {
    const k = dayKey(p.end);
    days.set(k, (days.get(k) ?? 0) + p.ms / 60000);
    if (p.artist === top) topDays.set(k, (topDays.get(k) ?? 0) + p.ms / 60000);
  }
  const years = [...new Set(sel.map((p) => new Date(p.end).getFullYear()))].sort();
  return { days, topDays, artists, years, totalMinutes: artists.reduce((a, b) => a + b.minutes, 0) };
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The drawing. */
export function listeningSpiral(s: YearStats, v: Values, W: number, H: number): Layer[] {
  if (!s.days.size) throw new Error('No music plays found for that year');
  let cx = W / 2, cy = H / 2;
  const top = s.artists.slice(0, Math.max(0, Math.round(v.topN)));
  const items = top.map((a, i) => `${i + 1}. ${a.name} ${Math.round(a.minutes / 60)}h`);
  let R = Math.min(W, H) / 2;
  if (v.artistsAt === 'legend' && items.length) {
    // Shrink the circle until the legend fits in the bottom-left corner beside it.
    const lw = Math.max(...items.map((t) => measureText(t, { size: v.labelSize * 0.8, font: v.font }))) + 2;
    const lh = items.length * v.labelSize * 1.6 + 2;
    // Slide the circle up and right, shrinking it, until it clears the legend box.
    for (let d = 0; d < R; d += 0.5) {
      const r = Math.min(W, H) / 2 - d, x = W / 2 + d, y = H / 2 - d;
      const qx = Math.min(x, lw), qy = Math.max(y, H - lh);
      if (Math.hypot(x - qx, y - qy) >= r) {
        (R = r), (cx = x), (cy = y);
        break;
      }
    }
  }
  const years = s.years;
  const y0 = years[0], y1 = years[years.length - 1];
  const perMonth = v.turn === 'month';
  const turns = perMonth ? (y1 - y0 + 1) * 12 : y1 - y0 + 1;
  const fontSize = v.labelSize;
  const ringText = v.artistsAt === 'ring' ? fontSize * 2.4 : 0;
  const monthBand = fontSize * 2.6;
  const Rbars = R - ringText - monthBand;
  const r0 = Rbars * v.inner;
  const barMax = v.barScale;
  const spacing = (Rbars - r0) / (turns + barMax * 1.2);
  // Scale to the 97th-percentile day; the odd marathon may run up to 40% longer.
  const sorted = [...s.days.values()].sort((a, b) => a - b);
  const p97 = sorted[Math.floor(sorted.length * 0.97)] || sorted[sorted.length - 1];
  const f = (m: number) => (v.scale === 'sqrt' ? Math.sqrt(m) : m);
  const lenOf = (m: number) => spacing * barMax * Math.min(1.4, f(m) / f(p97));
  const P = (r: number, a: number): Pt => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  // Position (turn number + fraction) of a local date.
  const posOf = (d: Date) => {
    const y = d.getFullYear(), m = d.getMonth();
    if (perMonth) {
      const dim = new Date(y, m + 1, 0).getDate();
      return (y - y0) * 12 + m + (d.getDate() - 1 + 0.5) / dim;
    }
    const start = new Date(y, 0, 1).getTime(), end = new Date(y + 1, 0, 1).getTime();
    return y - y0 + (d.getTime() + 43200000 - start) / (end - start);
  };
  const angOf = (pos: number) => -Math.PI / 2 + 2 * Math.PI * (pos - Math.floor(pos));
  const baseOf = (pos: number) => r0 + pos * spacing;

  const bars: Polyline[] = [];
  const topBars: Polyline[] = [];
  const guide: Polyline[] = [];
  for (const [k, m] of s.days) {
    const d = new Date(k);
    const pos = posOf(d);
    const a = angOf(pos), b = baseOf(pos);
    const L = lenOf(m);
    if (L < 0.15) continue;
    // Stacked: the top artist's share at the base (pen 2), the rest above it (pen 1).
    const share = v.highlight ? ((s.topDays.get(k) ?? 0) / m) * L : 0;
    if (share > 0.15) topBars.push([P(b, a), P(b + share, a)]);
    if (L - share > 0.15) bars.push([P(b + share, a), P(b + L, a)]);
  }
  // Baseline spiral and month ticks.
  if (v.baseline) {
    const line: Polyline = [];
    const steps = turns * 720;
    for (let k = 0; k <= steps; k++) {
      const pos = (k / steps) * turns;
      line.push(P(baseOf(pos) - 0.6, angOf(pos)));
    }
    guide.push(line);
  }
  const labels: Polyline[] = [];
  const rMonth = Rbars + monthBand * 0.35;
  if (!perMonth) {
    for (let m = 0; m < 12; m++) {
      const a = -Math.PI / 2 + (2 * Math.PI * m) / 12;
      guide.push([P(rMonth - 1, a), P(rMonth + 1.2, a)]);
      if (v.months) {
        const mid = a + Math.PI / 12;
        // Lettered along an arc so the names follow the circle.
        const arc: Polyline = [];
        const flip = Math.sin(mid) > 0.2; // bottom half: run anticlockwise so text reads upright
        for (let k = 0; k <= 20; k++) {
          const t = (flip ? 1 - k / 20 : k / 20) * (Math.PI / 6) + a;
          arc.push(P(flip ? rMonth + fontSize * 0.9 : rMonth, t));
        }
        labels.push(...textAlong(MONTHS[m], arc, { size: fontSize * 0.8, align: 'center', font: v.font }));
      }
    }
  } else {
    // One turn per month: day-of-month ticks around the rim (1, 8, 15, 22, 29).
    for (const day of [1, 8, 15, 22, 29]) {
      const a = -Math.PI / 2 + (2 * Math.PI * (day - 1)) / 30.44;
      guide.push([P(rMonth - 1, a), P(rMonth + 1.2, a)]);
      if (v.months) {
        const [x, y] = P(rMonth + fontSize * 1.4, a);
        labels.push(...text(String(day), { x, y: y + fontSize * 0.4, size: fontSize * 0.8, align: 'center', font: v.font }));
      }
    }
  }
  // Year (and hours) in the middle.
  if (v.centre && r0 > fontSize * 3) {
    const yr = y0 === y1 ? String(y0) : `${y0}–${y1}`;
    const big = Math.min(r0 * 0.42, fontSize * 2.4, (fontSize * r0 * 1.5) / Math.max(1, measureText(yr, { size: fontSize, font: v.font })));
    labels.push(...text(yr, { x: cx, y: cy + big * 0.3, size: big, align: 'center', font: v.font }));
    labels.push(...text(`${Math.round(s.totalMinutes / 60).toLocaleString('en')} hours`, { x: cx, y: cy + big * 0.3 + fontSize * 1.8, size: fontSize * 0.75, align: 'center', font: v.font }));
  }
  // Top artists: around the outside, or as a legend in the bottom corner.
  if (top.length && v.artistsAt !== 'none') {
    if (v.artistsAt === 'ring') {
      const str = items.join('   ·   ');
      const rr = R - ringText * 0.55;
      const circ = 2 * Math.PI * rr;
      const size = Math.min(fontSize * 1.05, (fontSize * circ * 0.97) / Math.max(1, measureText(str + '   ·   ', { size: fontSize, font: v.font })));
      const path: Polyline = [];
      for (let k = 0; k <= 720; k++) path.push(P(rr, -Math.PI / 2 + (2 * Math.PI * k) / 720));
      labels.push(...textAlong(str, path, { size, font: v.font, align: 'start', shift: 0 }));
    } else {
      items.forEach((it, i) => labels.push(...text(it, { x: 0, y: H - (items.length - 1 - i) * fontSize * 1.6, size: fontSize * 0.8, font: v.font })));
    }
  }
  const layers: Layer[] = [{ name: 'Minutes per day', color: PALETTE[0], paths: [...bars, ...labels] }];
  if (topBars.length) layers.push({ name: top[0] ? `Top artist: ${top[0].name}` : 'Top artist', color: PALETTE[1], paths: topBars });
  if (guide.length) layers.push({ name: 'Calendar', color: PALETTE[2], paths: guide });
  return layers;
}

const parsedFiles = new Map<string, Promise<Play[]>>();

export default defineArtwork({
  slug: 'listening-year',
  title: 'Your year in music',
  description: 'A year of Spotify listening as a spiral calendar: one turn a year, a bar for every day as long as the minutes you played, top artists around the rim.',
  order: 85,
  series: 'Music',
  paper: { paper: 'square', margin: 14 },
  params: [
    { type: 'file', key: 'files', label: 'Spotify history (.json)', accept: '.json,application/json', multiple: true, default: [], hint: 'From Spotify › Privacy › Download your data: StreamingHistory_music_*.json or the Extended Streaming_History_Audio_*.json files (select them all). Without files, a made-up demo year.' },
    { type: 'number', key: 'year', label: 'Year', min: 0, max: 2100, step: 1, default: 0, hint: '0 = the year with the most listening; 1 = every year (one turn each)' },
    { type: 'select', key: 'turn', label: 'One turn per', options: [['year', 'Year'], ['month', 'Month']], default: 'year' },
    { type: 'number', key: 'barScale', label: 'Longest bar (× turn spacing)', min: 0.2, max: 4, step: 0.05, default: 1.9 },
    { type: 'select', key: 'scale', label: 'Bar length', options: [['linear', 'Minutes'], ['sqrt', 'Square root of minutes']], default: 'linear' },
    { type: 'number', key: 'inner', label: 'Inner radius', min: 0.05, max: 0.7, step: 0.01, default: 0.32 },
    { type: 'checkbox', key: 'highlight', label: 'Top artist’s share on pen 2', default: true },
    { type: 'checkbox', key: 'baseline', label: 'Baseline spiral (pen 3)', default: false },
    { type: 'number', key: 'skipUnder', label: 'Ignore plays under (s)', min: 0, max: 60, step: 1, default: 5, hint: 'Skips and previews' },
    { type: 'select', key: 'artistsAt', label: 'Top artists', options: [['ring', 'Around the outside'], ['legend', 'Legend'], ['none', 'None']], default: 'ring' },
    { type: 'number', key: 'topN', label: 'How many artists', min: 1, max: 20, step: 1, default: 8, show: (v) => v.artistsAt !== 'none' },
    { type: 'checkbox', key: 'months', label: 'Month labels', default: true },
    { type: 'checkbox', key: 'centre', label: 'Year in the middle', default: true },
    { type: 'number', key: 'labelSize', label: 'Lettering size (mm)', min: 1.5, max: 6, step: 0.1, default: 3 },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
    { type: 'seed', key: 'seed', label: 'Demo seed', default: 2025, show: (v) => !v.files?.length },
  ],
  caption: (v) => (v.files?.length ? 'My year in music' : 'A made-up year in music'),
  async generate(v, ctx) {
    let plays: Play[] = [];
    if (!v.files?.length) plays = parseSpotify(demoHistory(2025, v.seed)).plays;
    else {
      for (const ref of v.files) {
        let p = parsedFiles.get(ref.id);
        if (!p) {
          p = (async () => {
            const [f] = await loadFiles([ref]);
            if (!f) throw new Error(`${ref.name} is missing; upload it again`);
            let json: unknown;
            try {
              json = JSON.parse(await f.blob.text());
            } catch {
              throw new Error(`${ref.name} isn't valid JSON`);
            }
            const r = parseSpotify(json);
            if (r.format === 'unknown') throw new Error(`${ref.name} doesn't look like Spotify streaming history`);
            return r.plays;
          })();
          p.catch(() => parsedFiles.delete(ref.id));
          parsedFiles.set(ref.id, p);
        }
        plays = plays.concat(await p);
      }
      ctx.status(`${plays.length.toLocaleString('en')} plays from ${v.files.length} file${v.files.length > 1 ? 's' : ''}`);
    }
    if (!plays.length) throw new Error('No music plays found in those files');
    let year: number | null = v.year > 1 ? v.year : null;
    if (v.year === 0) {
      const per = new Map<number, number>();
      for (const p of plays) per.set(new Date(p.end).getFullYear(), (per.get(new Date(p.end).getFullYear()) ?? 0) + p.ms);
      year = [...per].sort((a, b) => b[1] - a[1])[0][0];
    }
    const stats = summarise(plays, year, v.skipUnder * 1000);
    return listeningSpiral(stats, v, ctx.width, ctx.height);
  },
});
