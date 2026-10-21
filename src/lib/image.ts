import { loadFile, type FileRef } from './files';
import type { ParamDef, Values } from '../params';

/** Greyscale image, 0 = black, 1 = white. */
export interface Gray {
  w: number;
  h: number;
  data: Float32Array;
}

/** Decodes an uploaded image (works in the page and in the worker). */
export async function loadGray(refs: FileRef[] | undefined, maxSize = 600): Promise<Gray | null> {
  const file = await loadFile(refs);
  if (!file) return null;
  const bmp = await createImageBitmap(file.blob);
  const k = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  return { w, h, data: out };
}

/** Per-channel ink amounts (cyan, magenta, yellow; 0 = none, 1 = full) for multi-pen pieces. */
export async function loadCMY(refs: FileRef[] | undefined, maxSize = 400): Promise<[Gray, Gray, Gray] | null> {
  const file = await loadFile(refs);
  if (!file) return null;
  const bmp = await createImageBitmap(file.blob);
  const k = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const ch = [0, 1, 2].map(() => new Float32Array(w * h));
  for (let i = 0; i < w * h; i++) for (let j = 0; j < 3; j++) ch[j][i] = 1 - data[i * 4 + j] / 255;
  return ch.map((d) => ({ w, h, data: d })) as [Gray, Gray, Gray];
}

/** A procedural stand-in so photo pieces draw something before a photo is loaded. */
export function demoGray(w = 400, h = 500): Gray {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      let b = 0.92 - 0.35 * v; // backdrop gradient
      // Lit sphere
      const sx = (u - 0.5) / 0.32, sy = (v - 0.42) / 0.26;
      const r2 = sx * sx + sy * sy;
      if (r2 < 1) {
        const z = Math.sqrt(1 - r2);
        const lit = Math.max(0, -0.5 * sx - 0.6 * sy + 0.62 * z);
        b = 0.08 + 0.9 * Math.pow(lit, 1.3);
      } else {
        // Soft cast shadow on the floor
        const fx = (u - 0.6) / 0.3, fy = (v - 0.82) / 0.07;
        b *= 1 - 0.55 * Math.exp(-(fx * fx + fy * fy));
      }
      // Small second sphere
      const tx = (u - 0.2) / 0.1, ty = (v - 0.78) / 0.08;
      const t2 = tx * tx + ty * ty;
      if (t2 < 1) b = 0.1 + 0.8 * Math.max(0, -0.5 * tx - 0.6 * ty + 0.62 * Math.sqrt(1 - t2));
      data[y * w + x] = Math.max(0, Math.min(1, b));
    }
  }
  return { w, h, data };
}

/**
 * Maps the drawing area onto an image: 'cover' crops to fill, 'contain' fits inside
 * (outside counts as white). Returns brightness 0..1 at (x, y) in mm.
 */
export function imageSampler(g: Gray, W: number, H: number, fit: 'cover' | 'contain' = 'cover') {
  // Image pixels per mm: cover fills the area (crops), contain shows the whole image.
  const k = fit === 'cover' ? Math.min(g.w / W, g.h / H) : Math.max(g.w / W, g.h / H);
  const ox = (g.w - W * k) / 2;
  const oy = (g.h - H * k) / 2;
  return (x: number, y: number) => {
    const px = ox + x * k - 0.5;
    const py = oy + y * k - 0.5;
    if (px < -0.5 || py < -0.5 || px > g.w - 0.5 || py > g.h - 0.5) return 1;
    const cx = Math.max(0, Math.min(g.w - 1.001, px));
    const cy = Math.max(0, Math.min(g.h - 1.001, py));
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    const fx = cx - x0, fy = cy - y0;
    const i = y0 * g.w + x0;
    const d = g.data;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + g.w] * (1 - fx) + d[i + g.w + 1] * fx) * fy;
  };
}

/** Standard photo knobs. Spread into a piece's params and read with `loadDarkness`. */
export function imageParams(): ParamDef[] {
  return [
    { type: 'file', key: 'photo', label: 'Photo', accept: 'image/*', default: [], hint: 'Without a photo, a demo image is used' },
    { type: 'select', key: 'fit', label: 'Fit', options: [['cover', 'Fill (crop)'], ['contain', 'Fit inside']], default: 'cover' },
    { type: 'number', key: 'exposure', label: 'Brightness', min: -1, max: 1, step: 0.05, default: 0 },
    { type: 'number', key: 'contrast', label: 'Contrast', min: 0.2, max: 3, step: 0.05, default: 1 },
    { type: 'checkbox', key: 'invert', label: 'Invert', default: false },
  ];
}

/** Darkness (0 = paper, 1 = full ink) at (x, y) mm, from the `imageParams` values. */
export async function loadDarkness(v: Values, W: number, H: number, status?: (m: string) => void) {
  const g = (await loadGray(v.photo)) ?? demoGray();
  if (!v.photo?.length) status?.('No photo loaded: using the demo image');
  const sample = imageSampler(g, W, H, v.fit ?? 'cover');
  const exposure = v.exposure ?? 0, contrast = v.contrast ?? 1;
  return (x: number, y: number) => {
    let b = sample(x, y);
    b = (b - 0.5) * contrast + 0.5 + exposure * 0.5;
    b = Math.max(0, Math.min(1, b));
    return v.invert ? b : 1 - b;
  };
}
