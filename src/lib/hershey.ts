// Single-stroke Hershey fonts (public domain, by Dr. A. V. Hershey), JSON data from the
// hersheytext project (MIT, © 2014 James T, github.com/techninja/hersheytext).
import type { Polyline } from '../geom';
import fontData from './fonts/hershey.json';

type Glyph = { d: string; o: number };
const fonts = fontData as Record<string, { name: string; chars: Glyph[] }>;

export const FONT_OPTIONS: [string, string][] = Object.entries(fonts).map(([k, f]) => [k, f.name]);

const CAP = 21; // glyph units from cap line (y=1) to baseline (y=22)
const BASELINE = 22;
const SPACE = 16;

// Characters the fonts lack, mapped to close ASCII equivalents ('°' is drawn specially).
const SUBSTITUTE: Record<string, string> = { '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '×': 'x' };
const normalise = (t: string) => [...t].map((c) => SUBSTITUTE[c] ?? c).join('');
const ring = (cx: number, cy: number, r: number) => Array.from({ length: 13 }, (_, i) => [cx + r * Math.cos((i / 12) * 2 * Math.PI), cy + r * Math.sin((i / 12) * 2 * Math.PI)] as [number, number]);
const MIDDOT = { strokes: [ring(5, 13, 1)], advance: 10 };
const DEGREE = { strokes: [Array.from({ length: 13 }, (_, i) => [4 + 3 * Math.cos((i / 12) * 2 * Math.PI), 4 + 3 * Math.sin((i / 12) * 2 * Math.PI)] as [number, number])], advance: 10 };

const parsed = new Map<string, { strokes: [number, number][][]; advance: number }>();
function glyph(font: string, ch: string) {
  const key = font + ch;
  if (ch === '°') return DEGREE;
  if (ch === '·') return MIDDOT;
  let g = parsed.get(key);
  if (!g) {
    const data = (fonts[font] ?? fonts.futural).chars[ch.charCodeAt(0) - 33];
    if (!data) return { strokes: [], advance: SPACE };
    const strokes: [number, number][][] = [];
    for (const part of data.d.split('M').slice(1)) {
      const pts = [...part.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
      if (pts.length > 1) strokes.push(pts);
    }
    g = { strokes, advance: data.o * 2 };
    parsed.set(key, g);
  }
  return g;
}

export interface TextOptions {
  font?: string;
  /** Cap height in mm. */
  size?: number;
  /** Baseline origin in mm. */
  x?: number;
  y?: number;
  align?: 'left' | 'center' | 'right';
  /** Extra space between letters, as a fraction of the size. */
  tracking?: number;
  /** Line spacing as a multiple of the size. */
  leading?: number;
}

/** Width in mm of a single line of text. */
export function measureText(text: string, o: TextOptions = {}): number {
  text = normalise(text);
  const k = (o.size ?? 5) / CAP;
  let w = 0;
  for (const ch of text) w += (ch === ' ' ? SPACE : glyph(o.font ?? 'futural', ch).advance) * k + (o.tracking ?? 0) * (o.size ?? 5);
  return Math.max(0, w - (o.tracking ?? 0) * (o.size ?? 5));
}

/** Text as single-stroke polylines. Newlines start new lines below. */
export function text(str: string, o: TextOptions = {}): Polyline[] {
  const size = o.size ?? 5;
  const k = size / CAP;
  const font = o.font ?? 'futural';
  const out: Polyline[] = [];
  normalise(str).split('\n').forEach((line, li) => {
    const w = measureText(line, o);
    let x = (o.x ?? 0) - (o.align === 'center' ? w / 2 : o.align === 'right' ? w : 0);
    const y = (o.y ?? 0) + li * size * (o.leading ?? 1.6);
    for (const ch of line) {
      if (ch === ' ') {
        x += SPACE * k + (o.tracking ?? 0) * size;
        continue;
      }
      const g = glyph(font, ch);
      for (const s of g.strokes) out.push(s.map(([gx, gy]) => [x + gx * k, y + (gy - BASELINE) * k]));
      x += g.advance * k + (o.tracking ?? 0) * size;
    }
  });
  return out;
}
