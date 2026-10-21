import type { Location } from '../params';

// AWS Terrain Tiles (Mapzen terrarium encoding), public & CORS-enabled.
const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export async function geocode(q: string): Promise<Location[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  return json.map((r) => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }));
}

const tileCache = new Map<string, Promise<Float32Array>>();

function loadTile(z: number, x: number, y: number): Promise<Float32Array> {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  const key = `${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = (async () => {
      if (y < 0 || y >= n) return new Float32Array(256 * 256);
      const res = await fetch(TILE_URL(z, x, y), { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`tile ${key}: HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(256, 256);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, 256, 256);
      const out = new Float32Array(256 * 256);
      for (let i = 0; i < out.length; i++) out[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
      return out;
    })();
    p.catch(() => tileCache.delete(key));
    tileCache.set(key, p);
  }
  return p;
}

export interface Terrain {
  w: number;
  h: number;
  data: Float32Array;
  /** Ground metres per pixel at the centre latitude. */
  metersPerPx: number;
}

/** Square heightmap of `size` px centred on lat/lon at the given zoom. */
export async function loadTerrain(lat: number, lon: number, zoom: number, size: number): Promise<Terrain> {
  const world = 256 * 2 ** zoom;
  const latR = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  const cx = ((lon + 180) / 360) * world;
  const cy = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * world;
  const ox = Math.round(cx - size / 2);
  const oy = Math.round(cy - size / 2);
  const tx0 = Math.floor(ox / 256), tx1 = Math.floor((ox + size - 1) / 256);
  const ty0 = Math.floor(oy / 256), ty1 = Math.floor((oy + size - 1) / 256);
  const jobs: Promise<void>[] = [];
  const data = new Float32Array(size * size);
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      jobs.push(
        loadTile(zoom, tx, ty).then((tile) => {
          for (let py = 0; py < 256; py++) {
            const y = ty * 256 + py - oy;
            if (y < 0 || y >= size) continue;
            for (let pxl = 0; pxl < 256; pxl++) {
              const x = tx * 256 + pxl - ox;
              if (x < 0 || x >= size) continue;
              data[y * size + x] = tile[py * 256 + pxl];
            }
          }
        }),
      );
  await Promise.all(jobs);
  const metersPerPx = (40075016.686 * Math.cos(latR)) / world;
  return { w: size, h: size, data, metersPerPx };
}

export function boxBlur(t: Terrain, r: number): Terrain {
  if (r <= 0) return t;
  const { w, h } = t;
  const a = Float32Array.from(t.data);
  const b = new Float32Array(a.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < w) { s += a[y * w + xx]; n++; }
        }
        b[y * w + x] = s / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < h) { s += b[yy * w + x]; n++; }
        }
        a[y * w + x] = s / n;
      }
    }
  }
  return { ...t, data: a };
}

/**
 * Sampler over the largest centred crop matching `aspect` (w/h).
 * Returns normalised height in [0, 1] for u, v in [0, 1].
 */
/** Elevation (m) treated as sea level. Tiles often store the sea as slightly above 0 m. */
export const SEA_LEVEL = 0.5;

export function makeSampler(t: Terrain, aspect: number, clampSea: boolean) {
  const cw = aspect >= 1 ? t.w : t.h * aspect;
  const ch = aspect >= 1 ? t.w / aspect : t.h;
  const ox = (t.w - cw) / 2;
  const oy = (t.h - ch) / 2;
  const metres = (u: number, v: number) => {
    const x = Math.max(0, Math.min(t.w - 1.001, ox + u * (cw - 1)));
    const y = Math.max(0, Math.min(t.h - 1.001, oy + v * (ch - 1)));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const i = y0 * t.w + x0;
    const d = t.data;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + t.w] * (1 - fx) + d[i + t.w + 1] * fx) * fy;
  };
  const raw = (u: number, v: number) => (clampSea ? Math.max(0, metres(u, v)) : metres(u, v));
  let min = Infinity, max = -Infinity;
  for (let j = 0; j <= 128; j++)
    for (let i = 0; i <= 128; i++) {
      const h = raw(i / 128, j / 128);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  const range = max - min || 1;
  return {
    height: (u: number, v: number) => (raw(u, v) - min) / range,
    /** True at or below sea level (with a little slack: many tiles store open sea as ~0 m). */
    isSea: (u: number, v: number) => metres(u, v) <= SEA_LEVEL,
    /** Unflattened elevation in metres. */
    metres,
    min,
    max,
    /** Ground width of the crop in metres. */
    groundWidth: cw * t.metersPerPx,
  };
}
