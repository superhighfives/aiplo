/**
 * Records the network data every piece fetches with its default knobs into public/data/,
 * gzipped, so the app can answer those requests from the bundle (see src/lib/netcache.ts).
 *
 *   npm run record-data                  # all pieces
 *   npm run record-data street-grid      # just some
 *   DEBUG=1 npm run record-data rivers   # show each piece's status messages
 *
 * Re-run after changing a piece's defaults. Only successful responses are recorded and existing
 * recordings are kept, so if a service is flaky, just run it again for the pieces that failed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { requestKey } from '../src/lib/netcache';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = `${ROOT}public/data/`;
mkdirSync(OUT, { recursive: true });
const manifestPath = `${OUT}manifest.json`;
const manifest: Record<string, string> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

// Node stand-ins for the browser image APIs (PNG terrain tiles).
type Bmp = { width: number; height: number; data: Uint8Array };
(globalThis as any).createImageBitmap = async (blob: Blob): Promise<Bmp> => {
  const png = PNG.sync.read(Buffer.from(await blob.arrayBuffer()));
  return { width: png.width, height: png.height, data: png.data };
};
(globalThis as any).OffscreenCanvas = class {
  data: Uint8ClampedArray;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4).fill(255);
  }
  getContext() {
    const c = this;
    return {
      fillStyle: '#fff',
      fillRect() {},
      drawImage(b: Bmp, x = 0, y = 0, w = b.width, h = b.height) {
        for (let j = 0; j < h; j++)
          for (let i = 0; i < w; i++) {
            const sx = Math.min(b.width - 1, Math.floor((i * b.width) / w));
            const sy = Math.min(b.height - 1, Math.floor((j * b.height) / h));
            const di = ((y + j) * c.width + (x + i)) * 4;
            const si = (sy * b.width + sx) * 4;
            if (x + i < c.width && y + j < c.height) for (let k = 0; k < 4; k++) c.data[di + k] = b.data[si + k];
          }
      },
      getImageData(_x: number, _y: number, w: number, h: number) {
        return { data: c.data, width: w, height: h };
      },
    };
  }
};

// Record every successful response.
const net = globalThis.fetch.bind(globalThis);
let recorded = 0;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await net(input, init);
  const key = requestKey(input, init);
  if (key && res.ok) {
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    writeFileSync(`${OUT}${key}.bin`, gzipSync(bytes, { level: 9 }));
    manifest[key] = res.headers.get('content-type') ?? 'application/octet-stream';
    recorded++;
  }
  return res;
};

const { defaultsOf, withDefaults } = await import('../src/params');
const { paperDefs, paperSize } = await import('../src/state');
const { mulberry32 } = await import('../src/random');

const only = process.argv.slice(2);
const files = readdirSync(`${ROOT}src/art`).filter((f) => f.endsWith('.ts') && !['index.ts', 'types.ts'].includes(f) && !f.startsWith('_'));
for (const f of files) {
  const piece = (await import(`../src/art/${f}`)).default;
  if (only.length && !only.includes(piece.slug) && !only.includes(f.replace(/\.ts$/, ''))) continue;
  const values = defaultsOf(piece.params);
  const paper = withDefaults(paperDefs, { ...piece.paper });
  const [pw, ph] = paperSize(paper);
  const m = paper.margin;
  const seed = Number(values.seed ?? 1);
  const before = recorded;
  const t0 = performance.now();
  try {
    await piece.generate(values, { width: pw - 2 * m, height: ph - 2 * m, margin: m, seed, rng: mulberry32(seed), status: (msg: string) => process.env.DEBUG && console.log(`  ${msg}`) });
    console.log(`${piece.slug}: ${recorded - before} responses (${Math.round(performance.now() - t0)} ms)`);
  } catch (e) {
    console.log(`${piece.slug}: FAILED, ${(e as Error).message}`);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
}
console.log(`manifest: ${Object.keys(manifest).length} entries`);
process.exit(0);
