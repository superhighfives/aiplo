import type { Polyline, Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { loadFile } from '../lib/files';
import { defineArtwork } from './types';

const SKIP = 'defs, clipPath, mask, symbol, marker, pattern';
const UNITS: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

function toMm(len: string | null): number | null {
  const m = len?.trim().match(/^([\d.]+)\s*(mm|cm|in|pt|pc|px)?$/);
  return m ? Number(m[1]) * UNITS[m[2] ?? ''] : null;
}

export default defineArtwork({
  slug: 'svg-import',
  title: 'SVG import',
  description: 'Plot any SVG file, one pen per stroke colour or group.',
  kind: 'tool',
  order: 1,
  mainThread: true,
  params: [
    { type: 'file', key: 'file', label: 'SVG file', accept: '.svg,image/svg+xml', default: [] },
    { type: 'select', key: 'fit', label: 'Placement', options: [['fit', 'Fit inside margins'], ['actual', 'Actual size (from paper origin)']], default: 'fit' },
    { type: 'number', key: 'scale', label: 'Scale (%)', min: 5, max: 400, step: 1, default: 100 },
    { type: 'select', key: 'layers', label: 'Pens', options: [['color', 'One per stroke colour'], ['group', 'One per top-level group'], ['single', 'Single pen']], default: 'color' },
    { type: 'number', key: 'tol', label: 'Curve sampling (mm)', min: 0.05, max: 2, step: 0.05, default: 0.2 },
  ],
  async generate(v, ctx) {
    const file = await loadFile(v.file);
    if (!file) {
      ctx.status('Load an SVG file to plot it.');
      return [];
    }
    const doc = new DOMParser().parseFromString(await file.blob.text(), 'image/svg+xml');
    if (doc.querySelector('parsererror') || doc.documentElement.nodeName !== 'svg') throw new Error('Could not parse SVG');

    // Geometry methods need layout, so mount it off-screen.
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none';
    const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
    host.append(svg);
    document.body.append(host);
    try {
      const vb = svg.viewBox.baseVal;
      const hasVB = vb && vb.width > 0 && vb.height > 0;
      const wMm = toMm(svg.getAttribute('width'));
      const hMm = toMm(svg.getAttribute('height'));
      // mm per root user unit
      const unit = hasVB && wMm ? wMm / vb.width : hasVB && hMm ? hMm / vb.height : 25.4 / 96;
      const ox = hasVB ? vb.x : 0;
      const oy = hasVB ? vb.y : 0;
      const rootInv = svg.getScreenCTM()?.inverse();

      const groups = new Map<string, { color: string; paths: Polyline[] }>();
      let skipped = 0;
      for (const el of svg.querySelectorAll<SVGGeometryElement>('path, line, polyline, polygon, rect, circle, ellipse')) {
        if (el.closest(SKIP)) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const stroke = style.stroke && style.stroke !== 'none' ? style.stroke : style.fill !== 'none' ? style.fill : '';
        if (!stroke) continue;
        const screen = el.getScreenCTM();
        if (!screen || !rootInv) {
          skipped++;
          continue;
        }
        const m = rootInv.multiply(screen);
        const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
        const len = el.getTotalLength();
        if (!(len > 0)) continue;
        const spacing = v.tol / unit / scale; // in element units
        const n = Math.min(200000, Math.ceil(len / spacing));
        let cur: Polyline = [];
        const lines: Polyline[] = [cur];
        let prev: DOMPoint | null = null;
        for (let i = 0; i <= n; i++) {
          const p = el.getPointAtLength((i / n) * len);
          // getPointAtLength jumps across subpath moveTos; split there.
          if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > spacing * 2.5) lines.push((cur = []));
          prev = p;
          const q = p.matrixTransform(m);
          cur.push([(q.x - ox) * unit, (q.y - oy) * unit]);
        }

        let key = 'Pen 1';
        if (v.layers === 'color') key = stroke;
        else if (v.layers === 'group') {
          let g: Element | null = el;
          while (g && g.parentElement !== (svg as unknown as Element)) g = g.parentElement;
          key = g?.tagName === 'g' ? g.getAttribute('inkscape:label') || g.id || 'Group' : 'Pen 1';
        }
        const group = groups.get(key) ?? groups.set(key, { color: v.layers === 'color' ? stroke : '', paths: [] }).get(key)!;
        group.paths.push(...lines.filter((l) => l.length > 1));
      }

      // Place: fit the bounding box inside the drawing area, or keep the SVG's own coordinates.
      const all = [...groups.values()].flatMap((g) => g.paths);
      if (!all.length) throw new Error('No drawable shapes found (text and <use> are not supported; convert them to paths first)');
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of all) for (const [x, y] of p) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      const s = v.scale / 100;
      let place: (p: Pt) => Pt;
      if (v.fit === 'fit') {
        const k = Math.min(ctx.width / (maxX - minX || 1), ctx.height / (maxY - minY || 1)) * s;
        const dx = (ctx.width - (maxX - minX) * k) / 2;
        const dy = (ctx.height - (maxY - minY) * k) / 2;
        place = ([x, y]) => [(x - minX) * k + dx, (y - minY) * k + dy];
      } else {
        place = ([x, y]) => [x * s - ctx.margin, y * s - ctx.margin];
      }
      ctx.status(`${file.name}: ${(maxX - minX).toFixed(0)}×${(maxY - minY).toFixed(0)} mm original${skipped ? `, ${skipped} skipped` : ''}`);
      return [...groups.entries()].map(([name, g], i): Layer => ({
        name: v.layers === 'color' ? `Colour ${i + 1}` : name,
        color: g.color || PALETTE[i % PALETTE.length],
        paths: g.paths.map((p) => p.map(place)),
      }));
    } finally {
      host.remove();
    }
  },
});
