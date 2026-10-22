/**
 * Bundled data: responses recorded by `npm run record-data` for every piece's default knobs,
 * stored gzipped in `public/data/`. Installing the shim makes `fetch` answer those exact
 * requests from the bundle, so defaults and gallery thumbnails work instantly and offline,
 * without touching rate-limited services. Anything else goes to the network as usual.
 */

/** Stable key for a request: method, URL and (string) body. */
export function requestKey(input: RequestInfo | URL, init?: RequestInit): string | null {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
  if (!url || !/^https?:/.test(url)) return null;
  const body = init?.body ?? '';
  if (typeof body !== 'string') return null;
  const text = `${(init?.method ?? 'GET').toUpperCase()} ${url}\n${body}`;
  // Two FNV-1a passes with different seeds → 64 bits as hex.
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

type Manifest = Record<string, string>; // key → content type

let manifest: Promise<Manifest> | null = null;
let installed = false;

export function installBundledData(base: string) {
  if (installed || typeof fetch === 'undefined') return;
  installed = true;
  const net = globalThis.fetch.bind(globalThis);
  const root = new URL(`${base.replace(/\/?$/, '/')}data/`, globalThis.location?.href ?? 'http://localhost/');
  const getManifest = () =>
    (manifest ??= net(new URL('manifest.json', root))
      .then(async (r): Promise<Manifest> => (r.ok ? r.json() : {}))
      .catch((): Manifest => ({})));
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = requestKey(input, init);
    if (key) {
      const type = (await getManifest())[key];
      if (type && typeof DecompressionStream !== 'undefined') {
        try {
          const r = await net(new URL(`${key}.bin`, root));
          if (r.ok && r.body) return new Response(r.body.pipeThrough(new DecompressionStream('gzip')), { status: 200, headers: { 'content-type': type } });
        } catch {
          /* fall through to the network */
        }
      }
    }
    return net(input, init);
  };
}
