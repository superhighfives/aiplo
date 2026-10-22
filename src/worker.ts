/// <reference lib="webworker" />
import { installBundledData } from './lib/netcache';
import { findArtwork } from './art';
import type { GenContext } from './art/types';
import { processLayers, toLayers, translateLayers, type Layer, type ProcessOptions } from './layers';
import type { Values } from './params';
import { mulberry32 } from './random';

// Answer recorded requests for default knobs from public/data/ (see scripts/record-data.ts).
installBundledData(import.meta.env.BASE_URL);

export interface GenRequest {
  slug: string;
  values: Values;
  width: number;
  height: number;
  margin: number;
}

export type WorkerRequest =
  | ({ type: 'generate'; id: number } & GenRequest)
  | { type: 'setRaw'; id: number; layers: Layer[] }
  | { type: 'process'; id: number; opts: ProcessOptions }
  /** Generate + process in one go without touching the editor's state (gallery thumbnails). */
  | ({ type: 'render'; id: number; opts: ProcessOptions } & GenRequest)
  /** Process already-generated layers (thumbnails of main-thread pieces). */
  | { type: 'processRaw'; id: number; layers: Layer[]; opts: ProcessOptions };

export type WorkerResponse =
  | { type: 'status'; id: number; msg: string }
  | { type: 'done'; id: number; info?: string; ms?: number }
  | { type: 'processed'; id: number; result: ReturnType<typeof processLayers> }
  | { type: 'error'; id: number; message: string };

let raw: Layer[] = [];
const post = (m: WorkerResponse) => postMessage(m);

export async function runGenerate(r: GenRequest, status: GenContext['status']): Promise<Layer[]> {
  const piece = findArtwork(r.slug);
  if (!piece) throw new Error(`Unknown piece "${r.slug}"`);
  const seed = Number(r.values.seed ?? 1);
  const out = await piece.generate(r.values, { width: r.width, height: r.height, margin: r.margin, seed, rng: mulberry32(seed), status });
  return translateLayers(toLayers(out), r.margin, r.margin);
}

onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'generate') {
      let info = '';
      const t0 = performance.now();
      raw = await runGenerate(m, (msg) => {
        info = msg;
        post({ type: 'status', id: m.id, msg });
      });
      post({ type: 'done', id: m.id, info, ms: performance.now() - t0 });
    } else if (m.type === 'setRaw') {
      raw = m.layers;
      post({ type: 'done', id: m.id });
    } else if (m.type === 'process') {
      post({ type: 'processed', id: m.id, result: processLayers(raw, m.opts) });
    } else if (m.type === 'processRaw') {
      post({ type: 'processed', id: m.id, result: processLayers(m.layers, m.opts) });
    } else {
      const layers = await runGenerate(m, () => {});
      post({ type: 'processed', id: m.id, result: processLayers(layers, m.opts) });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String((err as Error)?.message ?? err) });
  }
};
