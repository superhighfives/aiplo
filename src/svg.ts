import type { Polyline } from './geom';
import type { Layer } from './layers';

const f = (n: number) => +n.toFixed(3);

export function pathData(paths: Polyline[]): string {
  let d = '';
  for (const p of paths) {
    d += `M${f(p[0][0])} ${f(p[0][1])}`;
    for (let i = 1; i < p.length; i++) d += `L${f(p[i][0])} ${f(p[i][1])}`;
  }
  return d;
}

/** Plotter-ready SVG in mm: one Inkscape layer per pen ("1-name", AxiDraw layer convention), strokes in plot order. */
export function toSVG(layers: Layer[], w: number, h: number, strokeWidth = 0.3): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const groups = layers
    .map((l, i) => {
      const body = l.paths.map((p) => `    <path d="${pathData([p])}"/>`).join('\n');
      return `  <g inkscape:groupmode="layer" inkscape:label="${i + 1}-${esc(l.name)}" fill="none" stroke="${esc(l.color)}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
${body}
  </g>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
  width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}">
${groups}
</svg>
`;
}
