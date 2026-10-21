import { circle, type Polyline } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { julianDay, moonPhase } from '../lib/astro';
import { FONT_OPTIONS, measureText, text, textAlong } from '../lib/hershey';
import {
  arcPath, caps, coordText, dayWeather, fitSize, hhmm, loadSky, longDate, moonGlyph, ornamentRule, phaseName,
  precipText, resolveMoment, shortPlace, skyChart, sunTimes, temp, zoneParams, type DayWeather,
} from '../lib/moments';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'the-moment',
  title: 'The moment',
  description: 'A keepsake poster for one minute in one place: the sky overhead, the moon, sunrise and sunset, and the weather that day.',
  order: 90,
  series: 'Moments',
  paper: { paper: 'letter', orientation: 'portrait', margin: 22 },
  caption: (v) => v.title,
  params: [
    { type: 'location', key: 'loc', label: 'Place', default: { name: 'Mission Control, Houston, Texas', lat: 29.5593, lon: -95.0907 } },
    { type: 'date', key: 'date', label: 'Date & time (local)', time: true, default: '1969-07-20T15:17', hint: 'Wall-clock time at the place' },
    ...zoneParams(),
    { type: 'text', key: 'title', label: 'Title', default: 'The Eagle has landed', placeholder: 'Names, or what happened' },
    { type: 'text', key: 'subtitle', label: 'Subtitle', default: 'Apollo 11 touches down on the Moon', placeholder: 'Optional' },
    { type: 'text', key: 'placeLabel', label: 'Place as lettered', default: '', placeholder: 'Defaults to the place name', hint: 'Leave empty to use the first part of the place name' },
    { type: 'select', key: 'layout', label: 'Layout', default: 'classic', options: [['classic', 'Sky above, details below'], ['ring', 'Sky in a ring of text']] },
    { type: 'checkbox', key: 'weather', label: 'Weather that day', default: true, hint: 'From the Open-Meteo archive (1940 to about a week ago)' },
    { type: 'select', key: 'units', label: 'Units', default: 'c', options: [['c', '°C, mm'], ['f', '°F, inches']] },
    { type: 'number', key: 'magLimit', label: 'Faintest star', min: 3, max: 6, step: 0.1, default: 5 },
    { type: 'number', key: 'starScale', label: 'Star size', min: 0.4, max: 2.5, step: 0.05, default: 1 },
    { type: 'checkbox', key: 'lines', label: 'Constellation lines', default: true, hint: 'On a second pen' },
    { type: 'checkbox', key: 'sunMoon', label: 'Sun and Moon on the chart', default: true },
    { type: 'select', key: 'titleFont', label: 'Title font', options: FONT_OPTIONS, default: 'timesr' },
    { type: 'select', key: 'font', label: 'Detail font', options: FONT_OPTIONS, default: 'futural' },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const loc = v.loc;
    ctx.status('Looking up the time zone…');
    const mo = await resolveMoment(v, loc, v.date);
    ctx.status('Loading stars and weather…');
    const [sky, wx] = await Promise.all([loadSky(), v.weather ? dayWeather(loc, mo.wall.day) : Promise.resolve(null as DayWeather | null)]);
    const jd = julianDay(mo.ms);
    const phase = moonPhase(jd);
    const sun = sunTimes(mo.wall, mo.offset, loc.lat, loc.lon);
    const south = loc.lat < 0;
    const font = v.font, tf = v.titleFont;
    const cx = W / 2;

    const ink: Polyline[] = [];
    const accent: Polyline[] = [];
    const place = v.placeLabel.trim() || shortPlace(loc.name, 2);
    const dateStr = longDate(mo.wall);
    const timeStr = mo.wall.hasTime ? `${hhmm(mo.wall.hh * 60 + mo.wall.mm)}  ${mo.zoneLabel}` : '';
    const sunStr = sun.polar ? (sun.polar === 'day' ? 'Midnight sun' : 'Polar night') : '';
    const wxLines: string[] = [];
    if (wx?.ok) {
      wxLines.push(`${temp(wx.tmax, v.units)} / ${temp(wx.tmin, v.units)}`);
      wxLines.push(wx.words);
      wxLines.push(wx.precip > 0.05 ? precipText(wx.precip, v.units) : 'Dry');
    } else if (wx) {
      wxLines.push('Weather', wx.reason);
    }

    // Detail band: three centred columns (moon · sun · weather).
    const detailBand = (y0: number, colW: number): number => {
      const xs = [cx - colW, cx, cx + colW];
      const lab = 2.1, val = 2.7;
      const label = (s: string, x: number, y: number) => ink.push(...text(caps(s), { x, y, size: lab, font, align: 'center', tracking: 0.25 }));
      const value = (s: string, x: number, y: number, size = val) => ink.push(...text(s, { x, y, size, font, align: 'center', tracking: 0.03 }));
      // Moon
      const mr = 5.2;
      ink.push(...moonGlyph(xs[0], y0 + mr, mr, phase, { south, spacing: 0.42 }));
      label(phaseName(phase), xs[0], y0 + 15);
      value(`${Math.round(phase.fraction * 100)}% lit`, xs[0], y0 + 21, 2.4);
      // Sun
      if (sunStr) {
        label('Daylight', xs[1], y0 + 3);
        value(sunStr, xs[1], y0 + 9);
      } else {
        label('Sunrise', xs[1], y0 + 2.5);
        value(sun.rise !== null ? hhmm(sun.rise) : '-', xs[1], y0 + 8.5, 3.4);
        label('Sunset', xs[1], y0 + 15);
        value(sun.set !== null ? hhmm(sun.set) : '-', xs[1], y0 + 21, 3.4);
      }
      // Weather
      if (wxLines.length) {
        if (wx?.ok) {
          label('High / low', xs[2], y0 + 2.5);
          value(wxLines[0], xs[2], y0 + 8.5, 3.4);
          label(wxLines[1], xs[2], y0 + 15);
          value(wxLines[2], xs[2], y0 + 21, 2.4);
        } else {
          label('Weather', xs[2], y0 + 2.5);
          value(wxLines[1], xs[2], y0 + 8.5, 2.4);
        }
      }
      return y0 + 23;
    };

    const accentFigures = (s: ReturnType<typeof skyChart>) => {
      ink.push(...s.ink);
      if (v.lines) accent.push(...s.figures);
      return s;
    };

    let chart: ReturnType<typeof skyChart>;
    if (v.layout === 'ring') {
      // Circle centred in the upper part, lettering on a ring around it.
      const ts = 3.5; // ring text size
      const R = Math.min(W / 2 - 14, H * 0.3);
      const cy = R + 14;
      chart = accentFigures(skyChart(sky, { cx, cy, R, lat: loc.lat, lon: loc.lon, ms: mo.ms, magLimit: v.magLimit, starScale: v.starScale, frame: 'single', sunMoon: v.sunMoon, font }));
      const rIn = R + 3, rOut = R + 5 + ts + 2;
      ink.push(circle(cx, cy, rIn, 360), circle(cx, cy, rOut, 360));
      const mid = (rIn + rOut) / 2;
      const topStr = caps(`${dateStr}${timeStr ? '  ·  ' + timeStr : ''}`);
      const botStr = caps(coordText(loc.lat, loc.lon));
      // Top: clockwise arc across the top, baseline below the band centre.
      ink.push(...textAlong(topStr, arcPath(cx, cy, mid - ts / 2, Math.PI, 2 * Math.PI), { size: ts, font, align: 'center', tracking: 0.22 }));
      // Bottom: anticlockwise so it reads upright; baseline at the outer side.
      ink.push(...textAlong(botStr, arcPath(cx, cy, mid + ts / 2, Math.PI, 0), { size: ts, font, align: 'center', tracking: 0.22 }));
      // Small stars at left and right of the band.
      for (const sx of [-1, 1]) {
        const x = cx + sx * mid, y = cy;
        ink.push([[x - 1.1, y], [x + 1.1, y]], [[x, y - 1.1], [x, y + 1.1]]);
      }
      let y = cy + rOut + 18;
      const tSize = fitSize(v.title, W - 10, 9.5, { font: tf, tracking: 0.04 });
      ink.push(...text(v.title, { x: cx, y, size: tSize, font: tf, align: 'center', tracking: 0.04 }));
      if (v.subtitle.trim()) {
        y += 8.5;
        ink.push(...text(v.subtitle, { x: cx, y, size: fitSize(v.subtitle, W - 20, 3.8, { font: 'timesi' }), font: 'timesi', align: 'center' }));
      }
      y += 6;
      ink.push(...ornamentRule(cx, y, 24));
      y += 6;
      ink.push(...text(caps(place), { x: cx, y: y + 2.4, size: fitSize(caps(place), W - 20, 2.4, { font, tracking: 0.3 }), font, align: 'center', tracking: 0.3 }));
      y += 9;
      detailBand(y, Math.min(56, W / 3.1));
    } else {
      // Classic: the chart on top, then title, subtitle and the details.
      const R = Math.min(W / 2 - 10, H * 0.295);
      const cy = R + 7.5;
      chart = accentFigures(skyChart(sky, { cx, cy, R, lat: loc.lat, lon: loc.lon, ms: mo.ms, magLimit: v.magLimit, starScale: v.starScale, frame: 'double', cardinals: true, sunMoon: v.sunMoon, font }));
      // Bottom block, laid out upward from the page bottom so the chart keeps its space.
      const coords = caps(coordText(loc.lat, loc.lon));
      const yCoords = H - 1;
      const bandTop = yCoords - 9 - 23;
      detailBand(bandTop, Math.min(56, W / 3.1));
      // Title block centred between chart and details.
      const tSize = fitSize(v.title, W - 26, 9, { font: tf, tracking: 0.04 });
      const hasSub = !!v.subtitle.trim();
      const blockH = tSize + (hasSub ? 9 : 0) + 8 + 9.5;
      const chartBottom = cy + chart.outer;
      let y = chartBottom + (bandTop - chartBottom - blockH) / 2 + tSize;
      ink.push(...text(v.title, { x: cx, y, size: tSize, font: tf, align: 'center', tracking: 0.04 }));
      if (hasSub) {
        y += 9;
        ink.push(...text(v.subtitle, { x: cx, y, size: fitSize(v.subtitle, W - 16, 3.9, { font: 'timesi' }), font: 'timesi', align: 'center' }));
      }
      y += 6.5;
      ink.push(...ornamentRule(cx, y, 22));
      y += 9;
      const sub = caps(`${place}  ·  ${dateStr}${timeStr ? '  ·  ' + timeStr : ''}`);
      ink.push(...text(sub, { x: cx, y, size: fitSize(sub, W - 4, 2.6, { font, tracking: 0.18 }), font, align: 'center', tracking: 0.18 }));
      const cs = 2.1;
      const cw = measureText(coords, { size: cs, font, tracking: 0.35 });
      ink.push(...text(coords, { x: cx, y: yCoords, size: cs, font, align: 'center', tracking: 0.35 }));
      ink.push([[cx - cw / 2 - 16, yCoords - cs / 2], [cx - cw / 2 - 4, yCoords - cs / 2]], [[cx + cw / 2 + 4, yCoords - cs / 2], [cx + cw / 2 + 16, yCoords - cs / 2]]);
    }

    const wxNote = wx ? (wx.ok ? `${wx.words}, ${Math.round(wx.tmax)}°/${Math.round(wx.tmin)}°` : `weather ${wx.reason}`) : 'no weather';
    ctx.status(`${chart.shown} stars · ${mo.zoneLabel}${mo.tz ? ` (${mo.tz})` : ' (estimated)'} · ${phaseName(phase).toLowerCase()} · ${wxNote}`);
    const layers: Layer[] = [{ name: 'Ink', color: PALETTE[0], paths: ink }];
    if (accent.length) layers.push({ name: 'Constellations', color: PALETTE[1], paths: accent });
    return layers;
  },
});
