import { circle, type Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { julianDay, moonPhase } from '../lib/astro';
import { FONT_OPTIONS, measureText, text, textAlong } from '../lib/hershey';
import {
  arcPath, caps, coordText, dayWeather, fitSize, hhmm, loadSky, longDate, ornamentRule, phaseName, resolveMoment,
  shortPlace, skyChart, streetCircle, sunTimes, temp, zoneParams,
} from '../lib/moments';
import { defineArtwork } from './types';

const NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const DEFAULT_SETLIST = NUMBERS.map((n) => `Song ${n}`).join('\n');

export default defineArtwork({
  slug: 'concert-night',
  title: 'Concert night',
  description: "A night to remember: the venue's streets in a circle, the setlist around them, and the sky overhead that evening.",
  order: 91,
  series: 'Moments',
  paper: { paper: 'letter', orientation: 'portrait', margin: 22 },
  caption: (v) => `${v.artist} · ${v.title}`,
  params: [
    { type: 'location', key: 'loc', label: 'Venue', default: { name: 'Royal Albert Hall, Kensington Gore, London', lat: 51.50095, lon: -0.17748 } },
    { type: 'date', key: 'date', label: 'Date & time (local)', time: true, default: '1968-11-26T21:00' },
    ...zoneParams(),
    { type: 'text', key: 'artist', label: 'Artist', default: 'Cream' },
    { type: 'text', key: 'title', label: 'Title', default: 'The farewell concert', placeholder: 'Tour or occasion' },
    { type: 'text', key: 'venue', label: 'Venue as lettered', default: '', placeholder: 'Defaults to the place name' },
    { type: 'text', key: 'setlist', label: 'Setlist', multiline: true, default: DEFAULT_SETLIST, hint: 'One song per line' },
    { type: 'select', key: 'layout', label: 'Layout', default: 'ring', options: [['ring', 'Setlist around the map'], ['list', 'Numbered list']] },
    { type: 'number', key: 'radius', label: 'Map radius (m)', min: 200, max: 2500, step: 50, default: 1000 },
    { type: 'checkbox', key: 'paths', label: 'Footpaths', default: false },
    { type: 'number', key: 'magLimit', label: 'Faintest star', min: 3, max: 6, step: 0.1, default: 4.6 },
    { type: 'checkbox', key: 'weather', label: 'Weather that night', default: true },
    { type: 'select', key: 'units', label: 'Units', default: 'c', options: [['c', '°C'], ['f', '°F']] },
    { type: 'select', key: 'titleFont', label: 'Title font', options: FONT_OPTIONS, default: 'timesr' },
    { type: 'select', key: 'font', label: 'Detail font', options: FONT_OPTIONS, default: 'futural' },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const loc = v.loc;
    const cx = W / 2;
    const font = v.font, tf = v.titleFont;
    const songs = String(v.setlist).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const venue = v.venue.trim() || shortPlace(loc.name);

    ctx.status('Looking up the time zone…');
    const mo = await resolveMoment(v, loc, v.date);
    const ink: Polyline[] = [];
    const accent: Polyline[] = [];

    // ---- Title block (top).
    let y = 0;
    const artist = caps(v.artist);
    const aSize = fitSize(artist, W - 10, 11, { font: tf, tracking: 0.2 });
    y += aSize;
    ink.push(...text(artist, { x: cx, y, size: aSize, font: tf, align: 'center', tracking: 0.2 }));
    if (v.title.trim()) {
      y += 8.5;
      ink.push(...text(v.title, { x: cx, y, size: fitSize(v.title, W - 20, 4.4, { font: 'timesi' }), font: 'timesi', align: 'center' }));
    }
    y += 6;
    ink.push(...ornamentRule(cx, y, 20));
    y += 7.5;
    const when = caps(`${venue}  ·  ${longDate(mo.wall)}`);
    ink.push(...text(when, { x: cx, y, size: fitSize(when, W - 4, 2.6, { font, tracking: 0.2 }), font, align: 'center', tracking: 0.2 }));
    const titleBottom = y;

    // ---- Footer: small sky + details either side.
    const skyR = 25;
    const footerTop = H - 2 * skyR - 4;
    const skyCy = footerTop + skyR;

    // ---- Map (and setlist) between title and footer.
    const ringText = v.layout === 'ring';
    const avail = footerTop - titleBottom - 12;
    let mapR: number, mapCy: number;
    const ts = 2.9;
    if (ringText) {
      // The ring (map + 3 mm + text band) fits between the title and the footer with ~7 mm to spare.
      const top = titleBottom + 9, bottom = footerTop - 7;
      mapR = Math.min(W / 2 - 12, (bottom - top) / 2 - (3 + ts + 4.2));
      mapCy = (top + bottom) / 2;
    } else {
      // Map on the left, numbered list on the right.
      mapR = Math.min(W * 0.3, avail / 2 - 2);
      mapCy = titleBottom + 6 + avail / 2 + 6;
    }
    // List metrics (list layout): the map and the list are centred as one group.
    const lead = Math.min(8, (2 * mapR * 0.92) / Math.max(1, songs.length - 1));
    let listSize = Math.min(3.4, lead * 0.5);
    const widest = Math.max(1, ...songs.map((s) => measureText(s, { size: listSize, font })));
    const maxListW = W - 2 * mapR - 14 - 8;
    if (widest > maxListW) listSize *= maxListW / widest;
    const listW = 7.5 + Math.min(widest, maxListW);
    const mapCx = ringText ? cx : (W - (2 * mapR + 14 + listW)) / 2 + mapR;

    ctx.status(`Loading streets around ${venue}…`);
    const [sky, streets, wx] = await Promise.all([
      loadSky(),
      streetCircle(loc, v.radius, mapCx, mapCy, mapR, { paths: v.paths, gap: Math.max(0.5, mapR / 80), status: ctx.status }),
      v.weather ? dayWeather(loc, mo.wall.day) : Promise.resolve(null),
    ]);
    ink.push(...streets.minor, ...streets.paths);
    accent.push(...streets.major);
    ink.push(circle(mapCx, mapCy, mapR, 360));
    // Venue marker: a small ring at the centre.
    accent.push(circle(mapCx, mapCy, 1.6, 24), circle(mapCx, mapCy, 0.6, 12));

    if (ringText) {
      // Setlist on a ring: the first half across the top, the rest across the bottom, both reading left to right.
      const rIn = mapR + 3;
      const band = ts + 4.2;
      const rOut = rIn + band;
      const mid = (rIn + rOut) / 2;
      ink.push(circle(mapCx, mapCy, rIn, 360), circle(mapCx, mapCy, rOut, 360));
      const half = Math.ceil(songs.length / 2);
      const sep = '  ·  ';
      const topStr = songs.slice(0, half).map((s, i) => `${i + 1} ${s}`).join(sep);
      const botStr = songs.slice(half).map((s, i) => `${half + i + 1} ${s}`).join(sep);
      // Each half gets a little less than half the lap; the ends leave room for the 3 and 9 o'clock marks.
      const arcLen = (r: number) => Math.PI * r - 16;
      const setArc = (str: string, r: number, top: boolean) => {
        if (!str) return;
        const L = arcLen(r);
        let size = ts;
        const w0 = measureText(str, { size, font, tracking: 0.08 });
        if (w0 > L) size = (size * L) / w0;
        const w = measureText(str, { size, font });
        const n = [...str].length;
        const tracking = Math.min(0.5, Math.max(0.08, (L * 0.92 - w) / Math.max(1, n - 1) / size));
        const path = top ? arcPath(mapCx, mapCy, r, Math.PI, 2 * Math.PI, 360) : arcPath(mapCx, mapCy, r, Math.PI, 0, 360);
        ink.push(...textAlong(str, path, { size, font, align: 'center', tracking }));
      };
      setArc(topStr, mid - ts / 2, true);
      setArc(botStr, mid + ts / 2, false);
      for (const sx of [-1, 1]) {
        const x = mapCx + sx * mid;
        accent.push([[x - 1, mapCy - 1], [x + 1, mapCy + 1]], [[x - 1, mapCy + 1], [x + 1, mapCy - 1]], [[x - 1.3, mapCy], [x + 1.3, mapCy]]);
      }
    } else {
      // Numbered list to the right of the map, vertically centred on it.
      const x0 = mapCx + mapR + 14;
      const sz = listSize;
      let ly = mapCy - (lead * (songs.length - 1)) / 2 + sz / 2;
      songs.forEach((s, i) => {
        ink.push(...text(String(i + 1), { x: x0 + 4, y: ly, size: sz * 0.8, font, align: 'right' }));
        ink.push(...text(s, { x: x0 + 7.5, y: ly, size: sz, font }));
        ly += lead;
      });
      ink.push([[x0 - 3, mapCy - mapR * 0.85], [x0 - 3, mapCy + mapR * 0.85]]);
    }

    // ---- Footer.
    const sc = skyChart(sky, { cx, cy: skyCy, R: skyR, lat: loc.lat, lon: loc.lon, ms: mo.ms, magLimit: v.magLimit, starScale: 0.9, frame: 'single', sunMoon: true, gap: 0.5 });
    ink.push(...sc.ink);
    accent.push(...sc.figures);
    const phase = moonPhase(julianDay(mo.ms));
    const sun = sunTimes(mo.wall, mo.offset, loc.lat, loc.lon);
    const colX = [cx - skyR - (W / 2 - skyR) / 2, cx + skyR + (W / 2 - skyR) / 2];
    const lab = 2, val = 2.7;
    const block = (x: number, rows: [string, string][]) => {
      let yy = skyCy - (rows.length * 11 - 4) / 2;
      for (const [l, s] of rows) {
        ink.push(...text(caps(l), { x, y: yy + lab, size: lab, font, align: 'center', tracking: 0.25 }));
        ink.push(...text(s, { x, y: yy + lab + 2 + val, size: fitSize(s, W / 2 - skyR - 8, val, { font }), font, align: 'center' }));
        yy += 11;
      }
    };
    block(colX[0], [
      ['Showtime', mo.wall.hasTime ? `${hhmm(mo.wall.hh * 60 + mo.wall.mm)}  ${mo.zoneLabel}` : longDate(mo.wall)],
      ['Sunset', sun.set !== null ? hhmm(sun.set) : sun.polar === 'day' ? 'Midnight sun' : '-'],
      ['Moon', `${phaseName(phase)}`],
    ]);
    const right: [string, string][] = [];
    if (wx?.ok) right.push(['Weather', wx.words], ['High / low', `${temp(wx.tmax, v.units)} / ${temp(wx.tmin, v.units)}`]);
    else if (wx) right.push(['Weather', wx.reason]);
    right.push(['Under the sky at', coordText(loc.lat, loc.lon)]);
    block(colX[1], right);

    ctx.status(`${venue} · ${streets.ways} ways · ${songs.length} songs · ${sc.shown} stars · ${mo.zoneLabel}${mo.tz ? ` (${mo.tz})` : ''}`);
    const layers: Layer[] = [
      { name: 'Ink', color: PALETTE[0], paths: ink },
      { name: 'Accent', color: PALETTE[1], paths: accent },
    ];
    return layers.filter((l) => l.paths.length);
  },
});
