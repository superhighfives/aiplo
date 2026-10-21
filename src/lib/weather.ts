/**
 * Open-Meteo historical archive (ERA5 reanalysis, 1940 → about a week ago). Free, CORS-enabled,
 * no key. Several points can go in one request (comma-separated lat/lon lists); the response
 * is then an array with one entry per point, in order.
 * Times are local to each point (`timezone=auto`), so date knobs can be passed straight through.
 */

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

export interface ArchivePoint {
  latitude: number;
  longitude: number;
  elevation: number;
  utc_offset_seconds: number;
  timezone: string;
  hourly?: Record<string, (number | null)[]> & { time: string[] };
  daily?: Record<string, (number | null)[]> & { time: string[] };
}

export interface ArchiveQuery {
  lat: number | number[];
  lon: number | number[];
  /** 'YYYY-MM-DD', inclusive. */
  start: string;
  end: string;
  hourly?: string[];
  daily?: string[];
  /** Extra query parameters, e.g. { wind_speed_unit: 'ms' }. */
  extra?: Record<string, string>;
}

const cache = new Map<string, Promise<ArchivePoint[]>>();
const fmt = (n: number) => n.toFixed(4).replace(/\.?0+$/, '');

/** Latest date the archive reliably has (it lags real time by ~5 days). */
export function archiveLatest(): string {
  return new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
}

/** Fetch archive data; always returns one entry per point. Cached per URL; 20 s timeout. */
export function fetchArchive(q: ArchiveQuery): Promise<ArchivePoint[]> {
  const lats = ([] as number[]).concat(q.lat);
  const lons = ([] as number[]).concat(q.lon);
  if (q.start < '1940-01-01') throw new Error('Open-Meteo archive starts in 1940');
  if (q.start > archiveLatest()) throw new Error(`No archive weather yet for ${q.start} (the archive lags about a week; latest ${archiveLatest()})`);
  const end = q.end > archiveLatest() ? archiveLatest() : q.end;
  const p = new URLSearchParams({
    latitude: lats.map(fmt).join(','),
    longitude: lons.map(fmt).join(','),
    start_date: q.start,
    end_date: end,
    timezone: 'auto',
    ...(q.extra ?? {}),
  });
  if (q.hourly?.length) p.set('hourly', q.hourly.join(','));
  if (q.daily?.length) p.set('daily', q.daily.join(','));
  const url = `${ARCHIVE}?${p}`;
  let r = cache.get(url);
  if (!r) {
    r = (async () => {
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      } catch (e) {
        throw new Error(`Open-Meteo didn't answer (${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message})`);
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.error) throw new Error(`Open-Meteo: ${body?.reason ?? `HTTP ${res.status}`}`);
      return Array.isArray(body) ? body : [body];
    })();
    r.catch(() => cache.delete(url));
    cache.set(url, r);
  }
  return r;
}
