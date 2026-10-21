/**
 * OSRM routing client.
 *
 * - Driving: the OSRM demo server (router.project-osrm.org), falling back to the FOSSGIS car
 *   server (routing.openstreetmap.de/routed-car) if it fails.
 * - Walking / cycling: routing.openstreetmap.de (routed-foot / routed-bike).
 *
 * Every request has a timeout; results are cached in memory by (mode, waypoints), so knob tweaks
 * that don't move the route don't refetch. Failures throw a readable Error.
 */

export type RouteMode = 'driving' | 'walking' | 'cycling';

export interface RoutePoint {
  lat: number;
  lon: number;
}

export interface Route {
  /** [lon, lat] along the route. */
  coords: [number, number][];
  /** Metres. */
  distance: number;
  /** Seconds (the router's estimate). */
  duration: number;
  /** Per-leg distance (m) and duration (s), one leg between each pair of waypoints. */
  legs: { distance: number; duration: number }[];
}

export const MODE_OPTIONS: [RouteMode, string][] = [['driving', 'Driving'], ['cycling', 'Cycling'], ['walking', 'Walking']];

const ENDPOINTS: Record<RouteMode, string[]> = {
  driving: ['https://router.project-osrm.org/route/v1/driving/', 'https://routing.openstreetmap.de/routed-car/route/v1/driving/'],
  walking: ['https://routing.openstreetmap.de/routed-foot/route/v1/foot/'],
  cycling: ['https://routing.openstreetmap.de/routed-bike/route/v1/bike/'],
};

const cache = new Map<string, Promise<Route>>();

async function request(base: string, coords: string, timeoutMs: number): Promise<Route> {
  const url = `${base}${coords}?overview=full&geometries=geojson&steps=false`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    throw new Error(err.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000} s` : err.message);
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok && !json?.code) throw new Error(`HTTP ${res.status}`);
  if (json?.code !== 'Ok' || !json.routes?.length) {
    const msg = json?.code === 'NoRoute' ? 'no route between those places' : json?.code === 'NoSegment' ? 'a place is too far from any road' : json?.message || json?.code || `HTTP ${res.status}`;
    const e = new Error(msg);
    (e as any).final = json?.code === 'NoRoute' || json?.code === 'NoSegment';
    throw e;
  }
  const r = json.routes[0];
  return {
    coords: r.geometry.coordinates as [number, number][],
    distance: r.distance,
    duration: r.duration,
    legs: (r.legs ?? []).map((l: any) => ({ distance: l.distance, duration: l.duration })),
  };
}

/** Route through `points` (at least two) by `mode`. Cached; throws a readable Error on failure. */
export function route(points: RoutePoint[], mode: RouteMode = 'driving', o: { timeout?: number; status?: (m: string) => void } = {}): Promise<Route> {
  if (points.length < 2) return Promise.reject(new Error('A route needs at least two places'));
  const coords = points.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const key = `${mode}|${coords}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const errors: string[] = [];
      for (const base of ENDPOINTS[mode]) {
        try {
          o.status?.(`Routing (${mode}) via ${new URL(base).host}…`);
          return await request(base, coords, o.timeout ?? 20000);
        } catch (e) {
          errors.push(`${new URL(base).host}: ${(e as Error).message}`);
          if ((e as any).final) break;
        }
      }
      throw new Error(`Couldn't route (${mode}): ${errors.join('; ')}`);
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** "1 h 23 min", "45 min", "2 d 3 h". */
export function formatDuration(s: number): string {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 48) return mm ? `${h} h ${mm} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
