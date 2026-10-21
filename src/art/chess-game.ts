import { Chess } from 'chess.js';
import { circle, type Polyline, type Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { text } from '../lib/hershey';
import type { Values } from '../params';
import { defineArtwork } from './types';

const IMMORTAL = `[Event "London"]
[Site "London ENG"]
[Date "1851.06.21"]
[White "Adolf Anderssen"]
[Black "Lionel Kieseritzky"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5
8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8
15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6
21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0`;

interface Played {
  from: string;
  to: string;
  white: boolean;
  capture: boolean;
}

function replay(pgn: string): { moves: Played[]; headers: Record<string, string> } {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn.trim());
  } catch (e) {
    throw new Error(`Couldn't read the PGN: ${(e as Error).message}`);
  }
  const moves = chess.history({ verbose: true }).map((m) => ({ from: m.from, to: m.to, white: m.color === 'w', capture: m.isCapture() }));
  if (!moves.length) throw new Error('The PGN has no moves');
  return { moves, headers: chess.getHeaders() };
}

function caption(v: Values): string {
  try {
    const h = replay(v.pgn).headers;
    const year = (h.Date ?? '').slice(0, 4);
    return [h.White && h.Black ? `${h.White} – ${h.Black}` : '', /^\d{4}$/.test(year) ? year : ''].filter(Boolean).join(', ');
  } catch {
    return '';
  }
}

export default defineArtwork({
  slug: 'chess-game',
  title: 'A chess game',
  description: 'Every move of a game as an arc between squares: white on one pen, black on another.',
  order: 45,
  paper: { paper: 'square', margin: 22 },
  params: [
    { type: 'text', key: 'pgn', label: 'PGN', multiline: true, default: IMMORTAL, placeholder: 'Paste a game in PGN…', hint: 'Default: the Immortal Game, Anderssen v Kieseritzky, London 1851' },
    { type: 'number', key: 'bulge', label: 'Arc height', min: -1, max: 1, step: 0.01, default: 0.16, hint: 'Sideways bulge as a fraction of the move length (negative bulges the other way)' },
    { type: 'number', key: 'growth', label: 'Arc growth', min: 0, max: 1, step: 0.01, default: 0.2, hint: 'Later moves bulge further, so repeated moves fan out' },
    { type: 'number', key: 'min', label: 'Minimum arc (squares)', min: 0, max: 1, step: 0.01, default: 0.25, hint: 'Short moves still curve at least this much' },
    { type: 'checkbox', key: 'captures', label: 'Circle captures', default: true },
    { type: 'number', key: 'dot', label: 'Capture circle (squares)', min: 0.05, max: 0.5, step: 0.01, default: 0.16, show: (v) => v.captures },
    { type: 'select', key: 'grid', label: 'Board', options: [['outline', 'Outline only'], ['crosses', 'Outline + corner ticks'], ['lines', 'Outline + grid'], ['none', 'None']], default: 'crosses' },
    { type: 'checkbox', key: 'labels', label: 'Coordinates (a–h, 1–8)', default: true },
    { type: 'checkbox', key: 'flip', label: 'Black at the bottom', default: false },
  ],
  caption,
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const { moves } = replay(v.pgn);
    const pad = v.labels ? 8 : 0;
    const S = Math.min(W, H) - 2 * pad;
    const x0 = (W - S) / 2, y0 = (H - S) / 2;
    const q = S / 8;
    const centre = (sq: string): Pt => {
      let f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1;
      if (v.flip) (f = 7 - f), (r = 7 - r);
      return [x0 + (f + 0.5) * q, y0 + (7 - r + 0.5) * q];
    };

    const white: Polyline[] = [];
    const black: Polyline[] = [];
    const N = moves.length;
    moves.forEach((m, k) => {
      const a = centre(m.from), b = centre(m.to);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      // Perpendicular to the left of the direction of travel: arcs bulge consistently.
      const nx = dy / len, ny = -dx / len;
      const sign = v.bulge < 0 ? -1 : 1;
      const h = sign * Math.max(v.min * q, (Math.abs(v.bulge) + v.growth * (k / Math.max(1, N - 1))) * len);
      const c: Pt = [(a[0] + b[0]) / 2 + nx * h * 2, (a[1] + b[1]) / 2 + ny * h * 2]; // quadratic control: peak = h
      const steps = Math.max(12, Math.ceil(len / 0.8));
      const arc: Polyline = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        arc.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
      }
      const into = m.white ? white : black;
      into.push(arc);
      if (v.captures && m.capture) into.push(circle(b[0], b[1], v.dot * q, 32));
    });

    const board: Polyline[] = [];
    if (v.grid !== 'none') board.push([[x0, y0], [x0 + S, y0], [x0 + S, y0 + S], [x0, y0 + S], [x0, y0]]);
    if (v.grid === 'lines')
      for (let i = 1; i < 8; i++) {
        board.push(i % 2 ? [[x0 + i * q, y0], [x0 + i * q, y0 + S]] : [[x0 + i * q, y0 + S], [x0 + i * q, y0]]);
        board.push(i % 2 ? [[x0, y0 + i * q], [x0 + S, y0 + i * q]] : [[x0 + S, y0 + i * q], [x0, y0 + i * q]]);
      }
    if (v.grid === 'crosses') {
      const t = q * 0.08;
      for (let i = 1; i < 8; i++)
        for (let j = 1; j < 8; j++) {
          const x = x0 + i * q, y = y0 + j * q;
          board.push([[x - t, y], [x + t, y]], [[x, y - t], [x, y + t]]);
        }
    }
    if (v.labels) {
      const size = Math.min(3.2, q * 0.18);
      for (let i = 0; i < 8; i++) {
        const file = String.fromCharCode(97 + (v.flip ? 7 - i : i));
        const rank = String(v.flip ? i + 1 : 8 - i);
        board.push(...text(file, { x: x0 + (i + 0.5) * q, y: y0 + S + size + 3, size, align: 'center' }));
        board.push(...text(rank, { x: x0 - 3, y: y0 + (i + 0.5) * q + size / 2, size, align: 'right' }));
      }
    }

    const layers: Layer[] = [
      { name: 'White', color: PALETTE[0], paths: [...board, ...white] },
      { name: 'Black', color: PALETTE[1], paths: black },
    ];
    return layers;
  },
});
