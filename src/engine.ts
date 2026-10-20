import type { Layer, LayerStats, ProcessOptions } from './layers';
import type { GenRequest, WorkerRequest, WorkerResponse } from './worker';

type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface EngineHooks {
  /** Latest generate request, read when it is actually sent. */
  genRequest: () => GenRequest;
  isMainThread: (slug: string) => boolean;
  mainGenerate: () => Promise<{ layers: Layer[]; info: string; ms: number }>;
  processOptions: () => ProcessOptions;
  onStatus: (msg: string, error?: boolean) => void;
  onProcessed: (layers: Layer[], stats: LayerStats[]) => void;
}

export const createWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

/**
 * Runs generation and processing in a worker. Requests are coalesced: while one job runs,
 * only the latest pending request is kept, and it reads current state when it is sent.
 */
export class Engine {
  private worker!: Worker;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (r: WorkerResponse) => void }>();
  private busySince = 0;
  private needGen = false;
  private needProc = false;
  private genInfo = '';

  constructor(private hooks: EngineHooks) {
    this.spawn();
  }

  private spawn() {
    this.worker = createWorker();
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const r = e.data;
      if (r.type === 'status') return this.hooks.onStatus(r.msg);
      this.waiting.get(r.id)?.resolve(r);
      this.waiting.delete(r.id);
    };
  }

  private send(req: Unsent<WorkerRequest>): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve });
      this.worker.postMessage({ ...req, id });
    });
  }

  generate() {
    // A job stuck for a while (e.g. an infinite loop in a code sketch) gets the worker replaced.
    if (this.busySince && performance.now() - this.busySince > 5000) this.restart();
    this.needGen = true;
    this.pump();
  }

  process() {
    this.needProc = true;
    this.pump();
  }

  restart() {
    this.worker.terminate();
    for (const w of this.waiting.values()) w.resolve({ type: 'error', id: 0, message: 'Cancelled: generation took too long' });
    this.waiting.clear();
    this.busySince = 0;
    this.spawn();
  }

  private async pump() {
    if (this.busySince) return;
    if (!this.needGen && !this.needProc) return;
    this.busySince = performance.now();
    try {
      if (this.needGen) {
        this.needGen = false;
        this.needProc = true;
        const req = this.hooks.genRequest();
        this.hooks.onStatus('Generating…');
        let r: WorkerResponse;
        if (this.hooks.isMainThread(req.slug)) {
          try {
            const { layers, info, ms } = await this.hooks.mainGenerate();
            r = await this.send({ type: 'setRaw', layers });
            if (r.type === 'done') r = { ...r, info, ms };
          } catch (e) {
            r = { type: 'error', id: 0, message: String((e as Error)?.message ?? e) };
          }
        } else r = await this.send({ type: 'generate', ...req });
        if (r.type === 'error') {
          this.needProc = false;
          this.hooks.onStatus(r.message, true);
        } else if (r.type === 'done') {
          this.genInfo = `${r.info ? r.info + ' · ' : ''}generated in ${Math.round(r.ms ?? 0)} ms`;
        }
      } else {
        this.needProc = false;
        const r = await this.send({ type: 'process', opts: this.hooks.processOptions() });
        if (r.type === 'processed') {
          this.hooks.onProcessed(r.result.layers, r.result.stats);
          if (!this.needGen) this.hooks.onStatus(this.genInfo);
        } else if (r.type === 'error') this.hooks.onStatus(r.message, true);
      }
    } finally {
      this.busySince = 0;
      this.pump();
    }
  }
}
