import { circle, type Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { FONT_OPTIONS, measureText, text } from '../lib/hershey';
import {
  caps, coordText, ecgSignal, fitSize, hhmm, joinedText, loadSky, longDate, resolveMoment, shortPlace, skyChart,
  streetCircle, zoneParams,
} from '../lib/moments';
import { seedFromText } from '../random';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'birth-poster',
  title: 'Birth poster',
  description: 'Welcome to the world: a name in script, the stars at the minute of birth, a first heartbeat and the streets around the hospital.',
  order: 92,
  series: 'Moments',
  paper: { paper: 'letter', orientation: 'portrait', margin: 22 },
  caption: (v) => v.name,
  params: [
    { type: 'text', key: 'name', label: 'Name', default: 'Ada Rose' },
    { type: 'location', key: 'loc', label: 'Place (hospital)', default: { name: "St Thomas' Hospital, Westminster Bridge Road, London", lat: 51.4986, lon: -0.1185 } },
    { type: 'date', key: 'date', label: 'Date & time of birth (local)', time: true, default: '2026-03-14T06:42' },
    ...zoneParams(),
    { type: 'text', key: 'weight', label: 'Weight', default: '3.4 kg', placeholder: 'Optional, e.g. 7 lb 8 oz' },
    { type: 'text', key: 'length', label: 'Length', default: '51 cm', placeholder: 'Optional, e.g. 20 in' },
    { type: 'text', key: 'greeting', label: 'Greeting', default: 'Welcome to the world', placeholder: 'Optional' },
    { type: 'text', key: 'placeLabel', label: 'Place as lettered', default: '', placeholder: 'Defaults to the place name' },
    { type: 'number', key: 'bpm', label: 'Heart rate (bpm)', min: 60, max: 180, step: 1, default: 140, hint: 'A newborn heart beats 120 to 160 times a minute. The trace is seeded by the name.' },
    { type: 'number', key: 'radius', label: 'Streets radius (m)', min: 150, max: 1500, step: 25, default: 700 },
    { type: 'number', key: 'magLimit', label: 'Faintest star', min: 3, max: 6, step: 0.1, default: 5 },
    { type: 'checkbox', key: 'lines', label: 'Constellation lines', default: true },
    { type: 'select', key: 'nameFont', label: 'Name font', options: FONT_OPTIONS, default: 'scriptc' },
    { type: 'select', key: 'font', label: 'Detail font', options: FONT_OPTIONS, default: 'futural' },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const loc = v.loc;
    const cx = W / 2;
    const font = v.font;
    const name = String(v.name).trim() || 'Baby';
    ctx.status('Looking up the time zone…');
    const mo = await resolveMoment(v, loc, v.date);
    const ink: Polyline[] = [];
    const accent: Polyline[] = [];

    // ---- Greeting and name.
    let y = 0;
    if (v.greeting.trim()) {
      y += 2.4;
      const g = caps(v.greeting);
      ink.push(...text(g, { x: cx, y, size: 2.4, font, align: 'center', tracking: 0.45 }));
      y += 4;
    }
    const w17 = joinedText(name, { size: 17, font: v.nameFont }).width;
    const nSize = Math.min(17, (17 * (W - 8)) / Math.max(1, w17));
    y += nSize + 1;
    ink.push(...joinedText(name, { x: cx, y, size: nSize, font: v.nameFont, align: 'center' }).paths);
    const nameBottom = y + nSize * 0.35; // script descenders

    // ---- Footer (bottom up): place line, street circle with details either side.
    const place = v.placeLabel.trim() || shortPlace(loc.name);
    const yPlace = H - 1;
    const streetR = 21;
    const streetCy = yPlace - 9 - streetR;
    const footerTop = streetCy - streetR;

    // ---- Heartbeat strip above the footer.
    const ecgH = 15;
    const ecgBase = footerTop - 9 - ecgH * 0.3;
    const ecgTop = ecgBase - ecgH * 0.75;

    // ---- Star chart in the space left between name and heartbeat.
    const room = ecgTop - 6 - (nameBottom + 6);
    const R = Math.min(W / 2 - 12, room / 2 - 3);
    const cy = nameBottom + 6 + room / 2;

    ctx.status('Loading stars and streets…');
    const [sky, streets] = await Promise.all([
      loadSky(),
      streetCircle(loc, v.radius, cx, streetCy, streetR, { gap: 0.45, status: ctx.status }),
    ]);
    const chart = skyChart(sky, { cx, cy, R, lat: loc.lat, lon: loc.lon, ms: mo.ms, magLimit: v.magLimit, frame: 'double', cardinals: false, sunMoon: true });
    ink.push(...chart.ink);
    if (v.lines) accent.push(...chart.figures);

    // Heartbeat: a few seconds of a synthetic trace, unique to the name.
    const seconds = 4.2;
    const sig = ecgSignal(v.bpm, 0.05, seedFromText(name + v.date), seconds + 1);
    const x0 = 0, x1 = W;
    const trace: Polyline = [];
    // Flat lead-in and lead-out so the line starts and ends quietly.
    const fade = (x: number) => {
      const e = Math.min(x - x0, x1 - x) / 14;
      return Math.max(0, Math.min(1, e));
    };
    for (let x = x0; x <= x1 + 1e-9; x += 0.12) {
      const t = 0.4 + ((x - x0) / (x1 - x0)) * seconds;
      trace.push([x, ecgBase - sig(t) * ecgH * fade(x)]);
    }
    accent.push(trace);

    // Streets around the hospital.
    ink.push(...streets.minor, ...streets.paths, circle(cx, streetCy, streetR, 240));
    ink.push(...streets.major);
    accent.push(circle(cx, streetCy, 1.2, 20));

    // Details flanking the street circle.
    const lab = 2, val = 3;
    const sideW = W / 2 - streetR - 6;
    const colX = [(cx - streetR - 8) / 2, W - (cx - streetR - 8) / 2];
    const col = (x: number, rows: [string, string][]) => {
      let yy = streetCy - (rows.length * 11.5 - 4.5) / 2;
      for (const [l, s] of rows) {
        ink.push(...text(caps(l), { x, y: yy + lab, size: lab, font, align: 'center', tracking: 0.3 }));
        ink.push(...text(s, { x, y: yy + lab + 2.4 + val, size: fitSize(s, sideW, val, { font }), font, align: 'center' }));
        yy += 11.5;
      }
    };
    // "Saturday" as the label, the date beneath.
    const [wd, dmy] = longDate(mo.wall, true).split(', ');
    const left: [string, string][] = [[`Born on a ${wd}`, dmy]];
    if (mo.wall.hasTime) left.push(['Time', hhmm(mo.wall.hh * 60 + mo.wall.mm)]);
    const right: [string, string][] = [];
    if (v.weight.trim()) right.push(['Weight', v.weight.trim()]);
    if (v.length.trim()) right.push(['Length', v.length.trim()]);
    if (!right.length) right.push(['Time zone', mo.zoneLabel]);
    col(colX[0], left);
    col(colX[1], right);

    // Place and coordinates.
    const pl = caps(`${place}  ·  ${coordText(loc.lat, loc.lon)}`);
    const ps = fitSize(pl, W - 30, 2.2, { font, tracking: 0.3 });
    const pw = measureText(pl, { size: ps, font, tracking: 0.3 });
    ink.push(...text(pl, { x: cx, y: yPlace, size: ps, font, align: 'center', tracking: 0.3 }));
    ink.push([[cx - pw / 2 - 14, yPlace - ps / 2], [cx - pw / 2 - 4, yPlace - ps / 2]], [[cx + pw / 2 + 4, yPlace - ps / 2], [cx + pw / 2 + 14, yPlace - ps / 2]]);

    ctx.status(`${name} · ${chart.shown} stars · ${streets.ways} ways · ${mo.zoneLabel}${mo.tz ? ` (${mo.tz})` : ' (estimated)'}`);
    const layers: Layer[] = [
      { name: 'Ink', color: PALETTE[0], paths: ink },
      { name: 'Accent', color: PALETTE[1], paths: accent },
    ];
    return layers.filter((l) => l.paths.length);
  },
});
