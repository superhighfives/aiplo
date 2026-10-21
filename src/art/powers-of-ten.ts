import { circle, polylineLength, resample, smooth, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { hatchPolygon } from '../lib/hatch';
import { FONT_OPTIONS, measureText, text } from '../lib/hershey';
import { caps, coordText, shortPlace } from '../lib/moments';
import {
  calloutLines, clipToFrame, cutFrames, EARTH_R, frameOutline, naturalEarth, nearLines, orthographic, patchContours,
  terrainPatch, type Frame,
} from '../lib/moments-geo';
import { offsetPolyline, overpass, projection, stitchRings, type OsmRelation, type OsmWay } from '../lib/osm';
import { azimuthalEquidistant, boxOf, cutAround, graticule, type Box, type LonLat } from '../lib/world';
import { defineArtwork } from './types';

type Kind = 'globe' | 'region' | 'land' | 'city' | 'street' | 'house';

const KIND_NAMES: Record<Kind, string> = { globe: 'Earth', region: 'Region', land: 'Land', city: 'City', street: 'Streets', house: 'Buildings' };

const ROADS_ALL = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|pedestrian|road';
const ROADS_CITY_NEAR = 'motorway|trunk|primary|secondary|tertiary';
const ROADS_CITY_FAR = 'motorway|trunk|primary';
const MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/;

function kindFor(r: number): Kind {
  if (r < 250) return 'house';
  if (r < 1500) return 'street';
  if (r < 15000) return 'city';
  if (r < 150000) return 'land';
  if (r < 3000000) return 'region';
  return 'globe';
}

const widthLabel = (r: number) => {
  const w = 2 * r;
  if (w < 1000) return `${Math.round(w)} m`;
  if (w < 10000) return `${(w / 1000).toFixed(1).replace(/\.0$/, '')} km`;
  return `${Math.round(w / 1000).toLocaleString('en-US')} km`;
};

/** A nice contour interval giving roughly `n` lines up to `max` metres. */
function niceStep(max: number, n: number): number {
  const raw = Math.max(1, max / n);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** Frame centres and sizes for each layout. Returns frames plus the region left for the title. */
function layoutFrames(n: number, layout: string, W: number, H: number, shape: 'square' | 'circle', titleH: number, labelH: number): { frames: Frame[]; labelsInside: boolean; lift: number } {
  const g = 7;
  const frames: Frame[] = [];
  const areaH = H - titleH;
  if (layout === 'spiral') {
    // Golden-rectangle subdivision: squares peel off left, top, right, bottom, left…
    const phi = (1 + Math.sqrt(5)) / 2;
    let gh = Math.min(areaH, W / phi);
    let gw = gh * phi;
    let x = (W - gw) / 2, y = (areaH - gh) / 2;
    let w = gw, h = gh;
    for (let i = 0; i < n; i++) {
      const dir = i % 4;
      let s: number, sx: number, sy: number;
      if (dir === 0) { s = h; sx = x; sy = y; x += s; w -= s; }
      else if (dir === 1) { s = w; sx = x; sy = y; y += s; h -= s; }
      else if (dir === 2) { s = h; sx = x + w - s; sy = y; w -= s; }
      else { s = w; sx = x; sy = y + h - s; h -= s; }
      const gap = Math.min(g * 0.6, s * 0.12);
      frames.push({ cx: sx + s / 2, cy: sy + s / 2, h: s / 2 - gap / 2, shape });
    }
    void gw; void gh;
    return { frames, labelsInside: true, lift: 0 };
  }
  const rows = layout === 'strip' || n <= 3 ? 1 : 2;
  const cols = Math.ceil(n / rows);
  const s = Math.min((W - (cols - 1) * g) / cols, (areaH - rows * labelH - (rows - 1) * g) / rows);
  const totalW = cols * s + (cols - 1) * g;
  const totalH = rows * (s + labelH) + (rows - 1) * g;
  // Sit the frames just above the title, then centre frames + title together on the page.
  const slack = Math.max(0, areaH - totalH - 4);
  const x0 = (W - totalW) / 2, y0 = slack / 2;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    let col = i % cols;
    if (row % 2 === 1) col = cols - 1 - col; // snake
    // Centre a short last row.
    const inRow = Math.min(cols, n - row * cols);
    const shift = row % 2 === 1 ? -(cols - inRow) * (s + g) / 2 : (cols - inRow) * (s + g) / 2;
    frames.push({ cx: x0 + col * (s + g) + s / 2 + (inRow < cols ? shift : 0), cy: y0 + row * (s + labelH + g) + s / 2, h: s / 2, shape });
  }
  return { frames, labelsInside: false, lift: slack / 2 };
}

export default defineArtwork({
  slug: 'powers-of-ten',
  title: 'Powers of ten',
  description: 'One address in nested zooms, from the whole Earth down to the building, each frame magnifying the middle of the last.',
  order: 93,
  series: 'Moments',
  paper: { paper: 'letter', orientation: 'landscape', margin: 18 },
  caption: (v) => v.loc.name,
  params: [
    { type: 'location', key: 'loc', label: 'Location', default: { name: 'Sydney Opera House, Bennelong Point, Sydney', lat: -33.85725, lon: 151.21510 } },
    { type: 'number', key: 'levels', label: 'Levels', min: 2, max: 8, step: 1, default: 6 },
    { type: 'number', key: 'factor', label: 'Zoom between levels (×)', min: 2, max: 20, step: 0.5, default: 10 },
    { type: 'number', key: 'inner', label: 'Closest frame half-width (m)', min: 20, max: 1000, step: 5, default: 120, hint: 'Ground distance from the centre to the edge of the last frame' },
    { type: 'checkbox', key: 'world', label: 'Always start with the globe', default: true, hint: 'The first frame shows the whole Earth even if the zoom would stop short of it' },
    { type: 'select', key: 'layout', label: 'Layout', default: 'grid', options: [['grid', 'Two rows'], ['strip', 'One strip'], ['spiral', 'Golden spiral']] },
    { type: 'select', key: 'shape', label: 'Frames', default: 'square', options: [['square', 'Squares'], ['circle', 'Circles']] },
    { type: 'checkbox', key: 'labels', label: 'Scale labels', default: true },
    { type: 'text', key: 'title', label: 'Title', default: 'Powers of ten' },
    { type: 'text', key: 'placeLabel', label: 'Place as lettered', default: '', placeholder: 'Defaults to the place name' },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
  ],
  async generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const loc = v.loc;
    const N = Math.round(v.levels);
    const font = v.font;
    const shape = v.shape as 'square' | 'circle';
    const radii = Array.from({ length: N }, (_, i) => v.inner * v.factor ** (N - 1 - i));
    const kinds: Kind[] = radii.map((r, i) => (i === 0 && v.world ? 'globe' : kindFor(r)));

    const titleH = 20;
    const labelH = v.labels ? 7 : 0;
    const { frames, labelsInside, lift } = layoutFrames(N, v.layout, W, H, shape, titleH, labelH);
    // Ground half-width covered by the frame content (corners included for squares).
    const reach = (r: number) => r * (shape === 'square' ? Math.SQRT2 * 1.02 : 1.03);

    // ---- One Overpass request for all the OSM levels.
    const osmNeed = { house: 0, street: 0, city: 0, cityNear: true };
    kinds.forEach((k, i) => {
      if (k === 'house') osmNeed.house = Math.max(osmNeed.house, reach(radii[i]));
      if (k === 'house' || k === 'street') osmNeed.street = Math.max(osmNeed.street, reach(radii[i]));
      if (k === 'city') {
        osmNeed.city = Math.max(osmNeed.city, reach(radii[i]));
        if (radii[i] >= 5000) osmNeed.cityNear = false;
      }
    });
    const ll = `${loc.lat.toFixed(6)},${loc.lon.toFixed(6)}`;
    const parts: string[] = [];
    if (osmNeed.house) parts.push(`way["building"](around:${Math.round(osmNeed.house)},${ll});`, `relation["building"](around:${Math.round(osmNeed.house)},${ll});`, `way["highway"](around:${Math.round(osmNeed.house)},${ll});`);
    if (osmNeed.street) parts.push(`way["highway"~"^(${ROADS_ALL})$"](around:${Math.round(osmNeed.street)},${ll});`);
    if (osmNeed.city) parts.push(`way["highway"~"^(${osmNeed.cityNear ? ROADS_CITY_NEAR : ROADS_CITY_FAR})$"](around:${Math.round(osmNeed.city)},${ll});`);

    ctx.status('Loading maps…');
    const needNE = kinds.includes('region') || kinds.includes('globe');
    const [osmEls, coast110, coast50, borders50, lakes50, rivers50, states50] = await Promise.all([
      parts.length ? overpass(`(${parts.join('')});out geom;`, { timeout: 120, status: ctx.status }) : Promise.resolve([]),
      kinds.includes('globe') ? naturalEarth('ne_110m_coastline') : Promise.resolve([] as LonLat[][]),
      kinds.includes('region') ? naturalEarth('ne_50m_coastline') : Promise.resolve([] as LonLat[][]),
      kinds.includes('region') ? naturalEarth('ne_50m_admin_0_boundary_lines_land') : Promise.resolve([] as LonLat[][]),
      kinds.includes('region') ? naturalEarth('ne_50m_lakes') : Promise.resolve([] as LonLat[][]),
      kinds.includes('region') ? naturalEarth('ne_50m_rivers_lake_centerlines') : Promise.resolve([] as LonLat[][]),
      kinds.includes('region') ? naturalEarth('ne_50m_admin_1_states_provinces_lines') : Promise.resolve([] as LonLat[][]),
    ]);
    void needNE;
    const ways = osmEls.filter((e): e is OsmWay => e.type === 'way' && Array.isArray((e as OsmWay).geometry));
    const rels = osmEls.filter((e): e is OsmRelation => e.type === 'relation');

    const ink: Polyline[] = [];
    const fine: Polyline[] = [];
    const accent: Polyline[] = [];
    const labelBoxes: Box[][] = frames.map(() => []);
    const scales: number[] = []; // mm per ground metre near the centre of each frame

    for (let i = 0; i < N; i++) {
      const f = frames[i];
      const r = radii[i];
      const kind = kinds[i];
      const out: Polyline[] = [];
      const light: Polyline[] = [];
      const toFrame = (p: Polyline) => p.map(([x, y]) => [x + f.cx - f.h, y + f.cy - f.h] as Pt);
      ctx.status(`Drawing ${KIND_NAMES[kind].toLowerCase()} (${widthLabel(r)} across)…`);

      if (kind === 'globe') {
        const G = f.h * 0.9;
        scales.push(G / EARTH_R);
        const orth = orthographic(loc.lon, loc.lat, f.cx, f.cy, G);
        out.push(circle(f.cx, f.cy, G, 240));
        for (const l of coast110) out.push(...orth.project(l));
        for (const l of graticule(30, { maxLat: 90, parallelStep: 30 })) light.push(...orth.project(l));
      } else if (kind === 'region') {
        const scale = f.h / r;
        scales.push(scale);
        const k = EARTH_R * scale; // mm per radian of arc
        const clipDeg = ((reach(r) / EARTH_R) * 180) / Math.PI;
        const proj = azimuthalEquidistant([loc.lon, loc.lat], Math.min(170, clipDeg * 1.05));
        const map = (ls: LonLat[][]) => ls.flatMap((l) => proj.project(l)).map((p) => p.map(([x, y]) => [f.cx + x * k, f.cy - y * k] as Pt));
        const near = (ls: LonLat[][]) => nearLines(ls, loc.lon, loc.lat, clipDeg * 1.3 + 2);
        out.push(...map(near(coast50)), ...map(near(lakes50)));
        light.push(...map(near(rivers50)));
        // State / province lines: fine dots.
        for (const b of map(near(states50))) for (const [x, y] of resample(b, 1.4)) light.push([[x - 0.15, y], [x + 0.15, y]]);
        // Borders dashed.
        for (const b of map(near(borders50))) {
          let acc = 0, on = true, cur: Polyline = [b[0]];
          for (let j = 1; j < b.length; j++) {
            acc += Math.hypot(b[j][0] - b[j - 1][0], b[j][1] - b[j - 1][1]);
            cur.push(b[j]);
            if (acc > (on ? 1.6 : 0.9)) {
              if (on) out.push(cur);
              on = !on;
              acc = 0;
              cur = [b[j]];
            }
          }
          if (on && cur.length > 1) out.push(cur);
        }
      } else if (kind === 'land' || kind === 'city') {
        const scale = f.h / r;
        scales.push(scale);
        const t = await terrainPatch(loc.lat, loc.lon, reach(r));
        const thresholds = [0.5];
        if (kind === 'land' && t.max > 20) {
          const step = niceStep(t.max, 4);
          for (let z = step; z < t.max; z += step) thresholds.push(z);
        }
        const cs = patchContours(t, f, r, thresholds, Math.max(0.3, f.h / 120)).map((ls, k) => ls.filter((l) => polylineLength(l) > (k ? 5 : 2.5)).map((l) => smooth(l, 0.4)));
        out.push(...cs[0]);
        for (const ls of cs.slice(1)) light.push(...ls);
        if (kind === 'city') {
          const proj = projection(loc, r, 2 * f.h, 2 * f.h);
          for (const w of ways) {
            const h = w.tags.highway;
            if (!h || w.tags.area === 'yes') continue;
            if (!(osmNeed.cityNear ? /^(motorway|trunk|primary|secondary|tertiary)$/ : /^(motorway|trunk|primary)$/).test(h)) continue;
            out.push(toFrame(w.geometry.map((g) => proj(g.lon, g.lat))));
          }
        }
      } else {
        // street / house: OSM, plus the shoreline traced from elevation tiles.
        const proj = projection(loc, r, 2 * f.h, 2 * f.h);
        const scale = proj.scale;
        scales.push(scale);
        try {
          const t = await terrainPatch(loc.lat, loc.lon, reach(r));
          if (t.min < 0.5) out.push(...patchContours(t, f, r, [0.5], Math.max(0.3, f.h / 120))[0].filter((l) => polylineLength(l) > 3).map((l) => smooth(l, Math.max(0.35, f.h / 50))));
        } catch {
          /* no shoreline: fine */
        }
        const gap = Math.max(0.35, Math.min(0.9, f.h / 70));
        for (const w of ways) {
          const line = toFrame(w.geometry.map((g) => proj(g.lon, g.lat)));
          const h = w.tags.highway;
          if (h && w.tags.area !== 'yes') {
            if (kind === 'street') {
              if (!new RegExp(`^(${ROADS_ALL})$`).test(h)) continue;
              if (MAJOR.test(h)) out.push(offsetPolyline(line, gap / 2), offsetPolyline(line, -gap / 2));
              else out.push(line);
            } else {
              if (/^(footway|path|steps|cycleway|service|track|bridleway|corridor)$/.test(h)) light.push(line);
              else out.push(line);
            }
          }
        }
        if (kind === 'house') {
          const shapes: Pt[][][] = [];
          for (const w of ways) if (w.tags.building && w.geometry.length > 3) shapes.push([toFrame(w.geometry.map((g) => proj(g.lon, g.lat)))]);
          for (const rel of rels) {
            if (!rel.tags.building || rel.tags.type !== 'multipolygon') continue;
            const geom = (role: string) => rel.members.filter((m) => m.type === 'way' && m.role === role && m.geometry).map((m) => toFrame(m.geometry!.map((g) => proj(g.lon, g.lat))));
            const inner = stitchRings(geom('inner'), 1e-4).closed;
            for (const o of stitchRings(geom('outer'), 1e-4).closed) shapes.push([o, ...inner]);
          }
          for (const rings of shapes) {
            out.push(...rings);
            light.push(...hatchPolygon(rings, 45, Math.max(0.7, f.h / 28)));
          }
        }
      }

      // Scale label.
      if (v.labels && (!labelsInside || f.h >= 10)) {
        const lab = caps(kind === 'globe' ? 'Earth' : widthLabel(r));
        const ls = Math.max(1.7, Math.min(2.4, f.h / 14));
        if (labelsInside) {
          const sz = Math.max(1.3, Math.min(ls, f.h / 9));
          const circ = shape === 'circle';
          const lx = circ ? f.cx : f.cx - f.h + 1.6 + sz * 0.4, ly = circ ? f.cy + f.h * 0.8 : f.cy + f.h - 1.6 - sz * 0.4;
          const t = text(lab, { x: lx, y: ly, size: sz, font, tracking: 0.2, align: circ ? 'center' : 'left' });
          ink.push(...t);
          labelBoxes[i].push(boxOf(t, 1.2));
        } else {
          ink.push(...text(lab, { x: f.cx, y: f.cy + f.h + 3 + ls, size: ls, font, align: 'center', tracking: 0.25 }));
        }
      }

      const clipped = cutAround(clipToFrame(out, f), labelBoxes[i]);
      const clippedLight = cutAround(clipToFrame(light, f), labelBoxes[i]);
      ink.push(...clipped, frameOutline(f));
      fine.push(...clippedLight);
    }

    // ---- Magnified regions and callout lines.
    for (let i = 0; i < N - 1; i++) {
      const f = frames[i];
      const half = Math.max(0.5, radii[i + 1] * scales[i]);
      const box: Frame = { cx: f.cx, cy: f.cy, h: Math.min(half, f.h), shape };
      accent.push(frameOutline(box));
      if (half < 1.2) accent.push(circle(f.cx, f.cy, 0.35, 10));
      const others = frames.filter((_, j) => j !== i);
      accent.push(...cutFrames(calloutLines(box, frames[i + 1]), others));
    }
    // The address itself in the last frame.
    const last = frames[N - 1];
    accent.push(circle(last.cx, last.cy, Math.max(0.6, last.h / 40), 20));

    // ---- Title band.
    const place = v.placeLabel.trim() || shortPlace(loc.name, 2);
    const yT = H - 3.5 - lift;
    const tSize = 7;
    const title = v.title.trim();
    if (title) ink.push(...text(title, { x: 0, y: yT - 5, size: tSize, font: 'timesr', tracking: 0.04 }));
    const tw = title ? measureText(title, { size: tSize, font: 'timesr', tracking: 0.04 }) : -6;
    ink.push(...text(caps(place), { x: tw + 6, y: yT - 5, size: 2.6, font, tracking: 0.25 }));
    ink.push(...text(caps(coordText(loc.lat, loc.lon)), { x: tw + 6, y: yT, size: 2.1, font, tracking: 0.3 }));
    const note = caps(`${N} frames  ·  each ${v.factor}× closer`);
    ink.push(...text(note, { x: W, y: yT, size: 2.1, font, align: 'right', tracking: 0.3 }));
    ink.push([[0, yT - 5 - tSize - 4], [W, yT - 5 - tSize - 4]].map(([x, y]) => [x, y] as Pt));

    ctx.status(`${place} · ${kinds.map((k, i) => `${KIND_NAMES[k]} ${widthLabel(radii[i])}`).join(' → ')} · ${ways.length} OSM ways`);
    const layers: Layer[] = [
      { name: 'Maps', color: PALETTE[0], paths: ink },
      { name: 'Detail', color: PALETTE[2], paths: fine },
      { name: 'Callouts', color: PALETTE[1], paths: accent },
    ];
    return layers.filter((l) => l.paths.length);
  },
});
