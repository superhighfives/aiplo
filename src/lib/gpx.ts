// GPX parsing without DOMParser (Web Workers have none): a small scanner over the tags we need.

export interface GpxPoint {
  lat: number;
  lon: number;
  ele?: number;
  /** Milliseconds since the epoch, if the point has a <time>. */
  time?: number;
}

export interface GpxTrack {
  name?: string;
  /** Each <trkseg> (or <rte>) is one continuous segment. */
  segments: GpxPoint[][];
}

const attr = (attrs: string, name: string): number => {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`));
  return m ? Number(m[1]) : NaN;
};

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();

/**
 * Parses tracks (<trk>/<trkseg>/<trkpt>) and routes (<rte>/<rtept>) from GPX text.
 * Namespace prefixes (e.g. <gpx:trkpt>) are accepted. Points without a valid lat/lon are skipped.
 */
export function parseGpx(xml: string): GpxTrack[] {
  // Drop comments so commented-out points aren't read.
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const tracks: GpxTrack[] = [];
  const tag = /<(\/?)(?:[\w-]+:)?(trk|trkseg|rte|trkpt|rtept|name|ele|time)\b([^>]*?)(\/?)>/g;
  let track: GpxTrack | null = null;
  let seg: GpxPoint[] | null = null;
  let pt: GpxPoint | null = null;
  const endSeg = () => {
    if (seg && seg.length && track) track.segments.push(seg);
    seg = null;
  };
  const endTrack = () => {
    endSeg();
    if (track && track.segments.length) tracks.push(track);
    track = null;
  };
  const textAfter = (from: number, name: string) => {
    const end = xml.slice(from).search(new RegExp(`</(?:[\\w-]+:)?${name}\\s*>`));
    return end < 0 ? '' : decode(xml.slice(from, from + end));
  };
  for (let m; (m = tag.exec(xml)); ) {
    const [, close, name, attrs, selfClose] = m;
    const after = m.index + m[0].length;
    if (!close) {
      switch (name) {
        case 'trk': case 'rte':
          endTrack();
          track = { segments: [] };
          if (name === 'rte') seg = [];
          break;
        case 'trkseg':
          endSeg();
          if (!track) track = { segments: [] };
          seg = [];
          break;
        case 'trkpt': case 'rtept': {
          const lat = attr(attrs, 'lat'), lon = attr(attrs, 'lon');
          pt = null;
          if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) break;
          if (!track) track = { segments: [] };
          if (!seg) seg = [];
          pt = { lat, lon };
          seg.push(pt);
          if (selfClose) pt = null;
          break;
        }
        case 'name':
          if (!selfClose && track && !pt && !track.name) track.name = textAfter(after, 'name') || undefined;
          break;
        case 'ele':
          if (pt && !selfClose) {
            const e = Number(textAfter(after, 'ele'));
            if (isFinite(e)) pt.ele = e;
          }
          break;
        case 'time':
          if (pt && !selfClose) {
            const t = Date.parse(textAfter(after, 'time'));
            if (isFinite(t)) pt.time = t;
          }
          break;
      }
    } else {
      switch (name) {
        case 'trkpt': case 'rtept': pt = null; break;
        case 'trkseg': endSeg(); break;
        case 'trk': case 'rte': endTrack(); break;
      }
    }
  }
  endTrack();
  return tracks;
}

/** All segments of all tracks, flattened. */
export const gpxSegments = (tracks: GpxTrack[]): GpxPoint[][] => tracks.flatMap((t) => t.segments);
