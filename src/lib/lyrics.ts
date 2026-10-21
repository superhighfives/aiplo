/**
 * Synced lyrics: LRC parsing, the LRCLIB lookup (lrclib.net, free and keyless; we identify
 * ourselves with the Lrclib-Client header it allows from browsers), and standard knobs.
 * Lyrics fetched here stay in the browser for personal prints; defaults use the
 * public-domain demo song so nothing copyrighted ships with the app.
 */
import { loadFile, type FileRef } from './files';
import type { ParamDef, Values } from '../params';
import { demoSong } from './song';

export interface LyricLine {
  /** Start time in seconds. */
  time: number;
  text: string;
  /** End time in seconds (start of the next line, or the song's end). */
  end?: number;
}

/** Parses LRC text ("[mm:ss.xx] line"); multiple timestamps per line are supported. */
export function parseLRC(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) offset = Number(off[1]) / 1000;
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const line = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
    for (const s of stamps) out.push({ time: Number(s[1]) * 60 + Number(s[2]) - offset, text: line });
  }
  out.sort((a, b) => a.time - b.time);
  for (let i = 0; i < out.length; i++) out[i].end = out[i + 1]?.time;
  return out;
}

/** Plain lyrics (no timestamps) spread evenly across `duration` seconds. */
export function spreadPlain(text: string, duration: number): LyricLine[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((t, i) => ({ text: t, time: (i / lines.length) * duration, end: ((i + 1) / lines.length) * duration }));
}

export interface LrclibTrack {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

const CLIENT = 'aiplo 0.1 (pen plotter sketchbook, personal use)';
const cache = new Map<string, Promise<LrclibTrack | null>>();

/** Finds the best LRCLIB match for a track (preferring synced lyrics and a close duration). */
export function findLyrics(track: string, artist: string, duration?: number): Promise<LrclibTrack | null> {
  const key = [track, artist, duration ? Math.round(duration) : ''].join('|').toLowerCase();
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(url, { headers: { 'Lrclib-Client': CLIENT }, signal: AbortSignal.timeout(20000) });
        if (res.status === 503 || res.status === 429) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(`LRCLIB: HTTP ${res.status}`);
        const list = (await res.json()) as LrclibTrack[];
        if (!list.length) return null;
        const score = (t: LrclibTrack) => (t.syncedLyrics ? 0 : 100) + (duration ? Math.abs(t.duration - duration) : 0);
        return list.sort((a, b) => score(a) - score(b))[0];
      }
      throw new Error('LRCLIB is busy right now; try again in a moment');
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Standard lyrics knobs. Spread into a piece's params and read with `loadLyrics`. */
export function lyricsParams(): ParamDef[] {
  const src = (...s: string[]) => (v: Values) => s.includes(v.lyricsSource);
  return [
    {
      type: 'select', key: 'lyricsSource', label: 'Lyrics', default: 'demo',
      options: [['demo', 'Demo song (public domain)'], ['lrclib', 'Find online (LRCLIB)'], ['paste', 'Paste'], ['file', 'Upload .lrc file'], ['none', 'None']],
      hint: 'Synced (.lrc) lyrics place each line at the moment it is sung',
    },
    { type: 'text', key: 'track', label: 'Song title', default: '', placeholder: 'e.g. Here Comes the Sun', show: src('lrclib') },
    { type: 'text', key: 'artist', label: 'Artist', default: '', placeholder: 'e.g. The Beatles', show: src('lrclib') },
    { type: 'text', key: 'lyricsText', label: 'Lyrics (LRC or plain)', multiline: true, default: '', placeholder: '[00:12.30] First line…', show: src('paste') },
    { type: 'file', key: 'lyricsFile', label: 'Lyrics file', accept: '.lrc,.txt,text/plain', default: [] as FileRef[], show: src('file') },
  ];
}

/**
 * The lyrics for `lyricsParams` values, timed against a song of `duration` seconds.
 * Plain (untimed) lyrics are spread evenly.
 */
export async function loadLyrics(v: Values, duration: number, status?: (m: string) => void): Promise<LyricLine[]> {
  let text = '';
  switch (v.lyricsSource) {
    case 'none':
      return [];
    case 'demo':
      // The demo lyrics belong to the demo song; don't letter them over someone's own track.
      if (Array.isArray(v.audio) && v.audio.length) {
        status?.('Your track is loaded: choose Find online, Paste or Upload under Lyrics to add its words');
        return [];
      }
      return demoSong().lyrics.map((l, i, a) => ({ ...l, end: a[i + 1]?.time ?? demoSong().duration }));
    case 'paste':
      text = v.lyricsText ?? '';
      break;
    case 'file': {
      const f = await loadFile(v.lyricsFile);
      if (!f) throw new Error('Upload an .lrc or text file of lyrics');
      text = await f.blob.text();
      break;
    }
    case 'lrclib': {
      if (!v.track) throw new Error('Enter a song title (and artist) to find lyrics');
      status?.(`Finding lyrics for “${v.track}”…`);
      const t = await findLyrics(v.track, v.artist ?? '', duration);
      if (!t) throw new Error(`No lyrics found on LRCLIB for “${v.track}”${v.artist ? ` by ${v.artist}` : ''}`);
      if (t.instrumental) throw new Error(`LRCLIB lists “${t.trackName}” as instrumental`);
      status?.(`Lyrics: ${t.trackName} · ${t.artistName}${t.syncedLyrics ? ' (synced)' : ' (unsynced)'}`);
      text = t.syncedLyrics ?? t.plainLyrics ?? '';
      break;
    }
  }
  const timed = parseLRC(text);
  const lines = timed.length ? timed : spreadPlain(text, duration);
  if (lines.length && lines[lines.length - 1].end === undefined) lines[lines.length - 1].end = duration;
  return lines.filter((l) => l.text);
}
