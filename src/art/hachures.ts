import { PALETTE } from '../layers';
import { coastline, hachures, loadTerrainFor, terrainParams } from '../lib/elevation';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'hachures',
  title: 'Hachures',
  description: 'Relief engraved in short downhill strokes, densest on steep slopes turned away from the light.',
  order: 3,
  paper: { paper: 'a5', orientation: 'landscape', margin: 12 },
  params: [
    ...terrainParams({ name: 'Matterhorn, Switzerland', lat: 45.9763, lon: 7.6586 }, 12),
    { type: 'number', key: 'spacing', label: 'Spacing, steep (mm)', min: 0.5, max: 5, step: 0.1, default: 0.9 },
    { type: 'number', key: 'spacingGentle', label: 'Spacing, gentle (mm)', min: 0.5, max: 15, step: 0.1, default: 4 },
    { type: 'number', key: 'length', label: 'Stroke length (mm)', min: 1, max: 60, step: 0.5, default: 6 },
    { type: 'number', key: 'light', label: 'Light', min: 0, max: 1, step: 0.05, default: 0.6, hint: 'Slopes facing the light get fewer strokes' },
    { type: 'number', key: 'azimuth', label: 'Light from (°)', min: 0, max: 355, step: 5, default: 315, hint: 'Clockwise from north; 315 = north-west, the cartographic convention' },
    { type: 'number', key: 'minSlope', label: 'Flat below', min: 0, max: 0.5, step: 0.01, default: 0.04, hint: 'Slopes gentler than this fraction of the steepest are left blank' },
    { type: 'checkbox', key: 'coast', label: 'Coastline', default: true, hint: 'On its own pen; empty if the area has no sea' },
    { type: 'seed', key: 'seed', label: 'Seed', default: 1 },
  ],
  async generate(v, ctx) {
    const map = await loadTerrainFor(v, ctx);
    const { width: W, height: H } = ctx;
    const strokes = hachures(
      map.height,
      W,
      H,
      {
        spacing: v.spacing,
        spacingGentle: Math.max(v.spacing, v.spacingGentle),
        minSlope: v.minSlope,
        maxLength: v.length,
        light: { strength: v.light, azimuth: v.azimuth },
      },
      ctx.rng,
    );
    const layers = [{ name: 'Hachures', color: PALETTE[0], paths: strokes }];
    const coast = v.coast ? coastline(map, W, H) : [];
    if (coast.length) layers.push({ name: 'Coastline', color: PALETTE[2], paths: coast });
    return layers;
  },
});
