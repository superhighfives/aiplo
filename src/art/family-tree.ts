import type { Polyline, Pt } from '../geom';
import { PALETTE, type Layer } from '../layers';
import { FONT_OPTIONS, measureText, text, textAlong } from '../lib/hershey';
import { defineArtwork } from './types';

// A fictional family over four generations.
const FAMILY = `Arthur Penhallow (1898–1971) & Edith Marlowe (1901–1987)
  Walter Penhallow (1924–1999) & June Okafor (1927–2015)
    Margaret Penhallow (1950–) & Tomas Varga (1948–2019)
      Lena Varga (1976–)
      Pip Varga (1979–)
    Robert Penhallow (1953–) & Clare Doyle (1955–)
      Iris Penhallow (1984–)
      Theo Penhallow (1987–)
      Ada Penhallow (1990–)
  Florence Penhallow (1927–2010) & Ivor Quill (1925–1990)
    Ruth Quill (1955–)
      Sam Quill-Hart (1981–)
    Hugh Quill (1958–2001)
  Clement Penhallow (1931–1944)
  Dora Penhallow (1935–) & Felix Amari (1932–2008)
    Nadia Amari (1961–) & Leo Brandt (1960–)
      Kit Brandt (1992–)
      Mae Brandt (1995–)
    Omar Amari (1964–)`;

interface Person {
  name: string;
  dates: string;
}

export interface FamilyNode {
  people: Person[];
  children: FamilyNode[];
  depth: number;
}

/** Parses an indented outline (two spaces or a tab per level) into a tree. Several roots get a shared invisible parent. */
export function parseFamily(src: string): FamilyNode {
  const root: FamilyNode = { people: [], children: [], depth: -1 };
  const stack: { indent: number; node: FamilyNode }[] = [{ indent: -1, node: root }];
  for (const raw of src.split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^[\t ]*/)![0].replace(/\t/g, '  ').length;
    const people = raw
      .trim()
      .split(/\s*&\s*/)
      .filter(Boolean)
      .map((p) => {
        const m = p.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
        return m ? { name: m[1].trim(), dates: m[2].trim() } : { name: p.trim(), dates: '' };
      });
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const node: FamilyNode = { people, children: [], depth: parent.depth + 1 };
    parent.children.push(node);
    stack.push({ indent, node });
  }
  if (root.children.length === 1) return root.children[0];
  // Several top-level lines: hang them off an unnamed root.
  const fix = (n: FamilyNode, d: number) => {
    n.depth = d;
    n.children.forEach((c) => fix(c, d + 1));
  };
  fix(root, 0);
  return root;
}

const firstName = (n: string) => n.split(/\s+/)[0];

interface Line {
  str: string;
  size: number;
}

/** Label lines for a node, in units of the name size (1). */
function labelLines(n: FamilyNode, style: 'stacked' | 'single', names: 'full' | 'first', withDates: boolean): Line[] {
  const nm = (p: Person) => (names === 'first' ? firstName(p.name) : p.name);
  const D = 0.7;
  if (!n.people.length) return [];
  if (style === 'single') {
    const lines: Line[] = [{ str: n.people.map(nm).join(' & '), size: 1 }];
    const dates = n.people.map((p) => p.dates).filter(Boolean);
    if (withDates && dates.length) lines.push({ str: dates.join(' · '), size: D });
    return lines;
  }
  const lines: Line[] = [];
  n.people.forEach((p, i) => {
    lines.push({ str: (i ? '& ' : '') + nm(p), size: 1 });
    if (withDates && p.dates) lines.push({ str: p.dates, size: D });
  });
  return lines;
}

/** Baselines (from the block's top) and total height of stacked lines, at name size s. */
function block(lines: Line[], s: number, font: string) {
  let y = 0;
  const base: number[] = [];
  lines.forEach((l, i) => {
    y += (i ? 0.45 * l.size * s : 0) + l.size * s;
    base.push(y);
  });
  const width = Math.max(0, ...lines.map((l) => measureText(l.str, { size: l.size * s, font })));
  return { base, height: y + (lines.length ? 0.15 * s : 0), width };
}

/* ------------------------------------------------------------------------------------------ */
/* Radial                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const polar = (cx: number, cy: number, a: number, r: number): Pt => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

function arc(cx: number, cy: number, r: number, a0: number, a1: number): Polyline {
  const n = Math.max(8, Math.ceil((Math.abs(a1 - a0) * r) / 0.5));
  return Array.from({ length: n + 1 }, (_, i) => polar(cx, cy, a0 + ((a1 - a0) * i) / n, r));
}

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n = 40): Polyline {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]] as Pt;
  });
}

interface RadialOpts {
  font: string;
  names: 'full' | 'first';
  dates: boolean;
  orient: 'auto' | 'radial' | 'tangential';
  /** Fraction of the circle used (1 = full). */
  sweep: number;
}

/**
 * Radial layout at name size s: the root at the centre, generations as rings. Each node gets an
 * angular sector proportional to its number of leaves. Returns null if labels collide.
 */
function radialLayout(root: FamilyNode, s: number, o: RadialOpts) {
  // Sectors.
  const leaves = (n: FamilyNode): number => (n.children.length ? n.children.reduce((a, c) => a + leaves(c), 0) : 1);
  const total = leaves(root);
  const sweep = o.sweep * 2 * Math.PI;
  const info = new Map<FamilyNode, { a: number; span: number; r: number; outer: number; tangential: boolean }>();
  const gens: FamilyNode[][] = [];
  const assign = (n: FamilyNode, a0: number) => {
    const span = (leaves(n) / total) * sweep;
    info.set(n, { a: a0 + span / 2, span, r: 0, outer: 0, tangential: false });
    (gens[n.depth] ??= []).push(n);
    let a = a0;
    for (const c of n.children) {
      assign(c, a);
      a += (leaves(c) / total) * sweep;
    }
  };
  assign(root, -Math.PI / 2 - sweep / 2);
  const minStep = sweep / total; // the narrowest a leaf gets

  // Root: a horizontal block at the centre.
  const rootLines = labelLines(root, 'stacked', 'full', o.dates);
  const rb = block(rootLines, s * 1.25, o.font);
  const rootR = rootLines.length ? Math.hypot(rb.width / 2, rb.height / 2) + s * 0.8 : 0;
  info.get(root)!.outer = rootR;
  const conn = s * 3;
  const gap = s * 0.6;
  let prevOuter = rootR;
  for (let g = 1; g < gens.length; g++) {
    const nodes = gens[g];
    const r = prevOuter + conn;
    // Tangential if every label in this ring fits its sector's arc.
    // Auto: whichever way reads closer to horizontal. Near the top and bottom, labels curve
    // round their ring (if they fit their sector); towards the sides they run along the branch.
    const fitsArc = (n: FamilyNode, slack: number) => {
      const b = block(labelLines(n, 'stacked', o.names, o.dates), s, o.font);
      return b.width + s <= (r + b.height / 2) * info.get(n)!.span * slack;
    };
    let outer = r;
    let thick = 0;
    for (const n of nodes) {
      const it = info.get(n)!;
      const tangential = o.orient === 'tangential' || (o.orient === 'auto' && Math.abs(Math.sin(it.a)) > 0.6 && fitsArc(n, 0.92));
      if (o.orient === 'tangential' && !fitsArc(n, 0.98)) return null;
      const b = block(labelLines(n, tangential ? 'stacked' : 'single', o.names, o.dates), s, o.font);
      it.r = r;
      it.tangential = tangential;
      it.outer = r + (tangential ? b.height : b.width);
      outer = Math.max(outer, it.outer);
      if (!tangential) thick = Math.max(thick, b.height);
    }
    // Radial labels need the narrowest slot to be at least a label's thickness.
    if (thick && r * minStep < thick * 1.1) return null;
    prevOuter = outer + gap;
  }
  return { info, gens, root, rootLines, rootR, outer: prevOuter - gap, gap };
}

function drawRadial(L: NonNullable<ReturnType<typeof radialLayout>>, s: number, cx: number, cy: number, o: RadialOpts) {
  const names: Polyline[] = [];
  const branches: Polyline[] = [];
  // Root block.
  if (L.rootLines.length) {
    const b = block(L.rootLines, s * 1.25, o.font);
    L.rootLines.forEach((l, i) => names.push(...text(l.str, { x: cx, y: cy - b.height / 2 + b.base[i], size: l.size * s * 1.25, font: o.font, align: 'center' })));
  }
  for (const [n, it] of L.info) {
    if (n === L.root) continue;
    const lines = labelLines(n, it.tangential ? 'stacked' : 'single', o.names, o.dates);
    const b = block(lines, s, o.font);
    const a = it.a;
    if (it.tangential) {
      // Upper half reads clockwise (tops outward), lower half anticlockwise (tops inward).
      const upper = Math.sin(a) <= 0.05;
      const half = Math.PI * 0.45; // generous: the text is centred on the node anyway
      lines.forEach((l, i) => {
        const rr = upper ? it.r + b.height - b.base[i] : it.r + b.base[i] - l.size * s;
        const path = upper ? arc(cx, cy, rr, a - half, a + half) : arc(cx, cy, rr, a + half, a - half);
        names.push(...textAlong(l.str, path, { size: l.size * s, font: o.font, align: 'center' }));
      });
    } else {
      // Along the radius, reading outward on the right, inward on the left.
      const right = Math.cos(a) >= -1e-9;
      const p0 = polar(cx, cy, a, it.r), p1 = polar(cx, cy, a, it.r + b.width + s);
      lines.forEach((l, i) => {
        const off = b.height / 2 - b.base[i];
        names.push(...textAlong(l.str, right ? [p0, p1] : [p1, polar(cx, cy, a, it.r)], { size: l.size * s, font: o.font, align: right ? 'start' : 'end', offset: off }));
      });
    }
  }
  // Branches: a curve from each parent's label to each child's, bending between the rings.
  const parentOf = new Map<FamilyNode, FamilyNode>();
  for (const [n] of L.info) for (const c of n.children) parentOf.set(c, n);
  for (const [n, it] of L.info) {
    const p = parentOf.get(n);
    if (!p) continue;
    const pi = L.info.get(p)!;
    const r0 = (p === L.root ? L.rootR : pi.outer) + L.gap * 0.6;
    const r1 = it.r - L.gap;
    if (r1 <= r0) continue;
    const mid = (r0 + r1) / 2;
    // From the root, branches radiate straight out of its ring; elsewhere they leave the
    // parent's label along its angle and bend round to the child's.
    const a0 = p === L.root ? it.a : pi.a;
    branches.push(cubic(polar(cx, cy, a0, r0), polar(cx, cy, a0, mid), polar(cx, cy, it.a, mid), polar(cx, cy, it.a, r1)));
  }
  return { names, branches };
}

/* ------------------------------------------------------------------------------------------ */
/* Top-down tidy tree                                                                          */
/* ------------------------------------------------------------------------------------------ */

interface Placed {
  node: FamilyNode;
  x: number; // centre
  w: number;
  children: Placed[];
}

/**
 * Contour-based tidy layout (Reingold–Tilford in spirit): each subtree keeps its left and right
 * outline per depth; siblings are pushed apart until their outlines clear by `sep`, and parents
 * sit centred over their children. Units: label widths at name size 1.
 */
function tidy(root: FamilyNode, width: (n: FamilyNode) => number, sep: number): Placed {
  type Sub = { p: Placed; left: number[]; right: number[] };
  const shift = (p: Placed, dx: number) => {
    p.x += dx;
    p.children.forEach((c) => shift(c, dx));
  };
  const build = (n: FamilyNode): Sub => {
    const w = width(n);
    if (!n.children.length) return { p: { node: n, x: 0, w, children: [] }, left: [-w / 2], right: [w / 2] };
    const subs = n.children.map(build);
    let left = subs[0].left.slice(), right = subs[0].right.slice();
    for (let k = 1; k < subs.length; k++) {
      const s = subs[k];
      let dx = -Infinity;
      for (let d = 0; d < Math.min(right.length, s.left.length); d++) dx = Math.max(dx, right[d] - s.left[d] + sep);
      shift(s.p, dx);
      // The forest's outline: the new subtree only extends the right side, and both sides below
      // the depths seen so far.
      for (let d = 0; d < s.left.length; d++) {
        if (d < left.length) right[d] = Math.max(right[d], s.right[d] + dx);
        else {
          left.push(s.left[d] + dx);
          right.push(s.right[d] + dx);
        }
      }
    }
    const x = (subs[0].p.x + subs[subs.length - 1].p.x) / 2;
    return { p: { node: n, x, w, children: subs.map((s) => s.p) }, left: [x - w / 2, ...left], right: [x + w / 2, ...right] };
  };
  return build(root).p;
}

export default defineArtwork({
  slug: 'family-tree',
  title: 'Family tree',
  description: 'A family tree from an indented outline: a radial fan with generations as rings, or a classic top-down tree.',
  order: 112,
  series: 'Words and hands',
  paper: { paper: 'a4', orientation: 'landscape', margin: 12 },
  params: [
    { type: 'text', key: 'text', label: 'Family', multiline: true, default: FAMILY, hint: 'One person or couple per line, indented two spaces (or a tab) under their parents. "Name (1901–1980)", couples as "Name & Name"' },
    { type: 'select', key: 'layout', label: 'Layout', options: [['radial', 'Radial'], ['tree', 'Top-down tree']], default: 'radial' },
    { type: 'select', key: 'orient', label: 'Names', options: [['auto', 'Around rings where they fit, else along branches'], ['radial', 'Along the branches'], ['tangential', 'Around the rings']], default: 'auto', show: (v) => v.layout === 'radial' },
    { type: 'number', key: 'sweep', label: 'Fan (°)', min: 120, max: 360, step: 5, default: 360, show: (v) => v.layout === 'radial' },
    { type: 'select', key: 'names', label: 'Show', options: [['full', 'Full names'], ['first', 'First names (root in full)']], default: 'first' },
    { type: 'checkbox', key: 'dates', label: 'Dates', default: true },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
    { type: 'number', key: 'maxSize', label: 'Max letter size (mm)', min: 1, max: 12, step: 0.1, default: 4.5 },
    { type: 'checkbox', key: 'pen2', label: 'Branches on pen 2', default: true },
  ],
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    const root = parseFamily(String(v.text ?? ''));
    if (!root.children.length && !root.people.length) throw new Error('No family: add one person per line');
    const font = v.font;
    let names: Polyline[] = [], branches: Polyline[] = [];

    if (v.layout === 'radial') {
      const o: RadialOpts = { font, names: v.names, dates: v.dates, orient: v.orient, sweep: v.sweep / 360 };
      // A fan narrower than the full circle opens upward: fit its bounds to the page.
      const sw = (v.sweep * Math.PI) / 180, a0 = -Math.PI / 2 - sw / 2;
      const below = Math.max(0.15, Math.sin(a0), Math.sin(a0 + sw));
      const half = sw >= Math.PI ? 1 : Math.sin(sw / 2);
      const R = Math.min(H / (1 + below), W / (2 * half));
      const cx = W / 2, cy = (H - R * (1 + below)) / 2 + R;
      let lo = 0.3, hi = v.maxSize, best: ReturnType<typeof radialLayout> = null, size = lo;
      const fits = (s: number) => {
        const L = radialLayout(root, s, o);
        return L && L.outer <= R ? L : null;
      };
      if ((best = fits(hi))) size = hi;
      else
        for (let it = 0; it < 24; it++) {
          const mid = (lo + hi) / 2;
          const L = fits(mid);
          if (L) [lo, best, size] = [mid, L, mid];
          else hi = mid;
        }
      if (!best) throw new Error('Too many people to fit: try the top-down tree or bigger paper');
      ({ names, branches } = drawRadial(best, size, cx, cy, o));
      ctx.status(`${size.toFixed(2)} mm names`);
    } else {
      const lines = (n: FamilyNode) => labelLines(n, 'stacked', n.depth === 0 ? 'full' : v.names, v.dates);
      const placed = tidy(root, (n) => block(lines(n), 1, font).width, 1.6);
      // Depth rows: each as tall as its tallest label, plus room for the elbows.
      const rowH: number[] = [];
      const walk = (p: Placed, f: (p: Placed) => void) => {
        f(p);
        p.children.forEach((c) => walk(c, f));
      };
      walk(placed, (p) => (rowH[p.node.depth] = Math.max(rowH[p.node.depth] ?? 0, block(lines(p.node), 1, font).height)));
      let x0 = Infinity, x1 = -Infinity;
      walk(placed, (p) => ((x0 = Math.min(x0, p.x - p.w / 2)), (x1 = Math.max(x1, p.x + p.w / 2))));
      const sumH = rowH.reduce((a, h) => a + h, 0), gaps = Math.max(1, rowH.length - 1);
      // Size from the width (or height at the tightest gaps), then open the gaps to fill the height.
      const s = Math.min(v.maxSize, W / (x1 - x0), H / (sumH + gaps * 3.2));
      const vgap = Math.min(14, Math.max(3.2, (H / s - sumH) / gaps));
      const rowY: number[] = [];
      rowH.reduce((y, h, d) => ((rowY[d] = y), y + h + vgap), 0);
      const totalH = rowY[rowY.length - 1] + rowH[rowH.length - 1];
      const ox = (W - (x1 - x0) * s) / 2 - x0 * s, oy = (H - totalH * s) / 2;
      walk(placed, (p) => {
        const ls = lines(p.node);
        const b = block(ls, s, font);
        const top = oy + rowY[p.node.depth] * s;
        ls.forEach((l, i) => names.push(...text(l.str, { x: ox + p.x * s, y: top + b.base[i], size: l.size * s, font, align: 'center' })));
        if (!p.children.length) return;
        // Elbows: a stem down from the parent, a bus across, a drop to each child.
        const px = ox + p.x * s;
        const yb = top + b.height + 0.5 * s;
        const childTop = oy + rowY[p.node.depth + 1] * s - 0.5 * s;
        const busY = (top + rowH[p.node.depth] * s + childTop) / 2 + 0.25 * s;
        const xs = p.children.map((c) => ox + c.x * s);
        branches.push([[px, yb], [px, busY]]);
        if (xs.length > 1 || Math.abs(xs[0] - px) > 0.01) branches.push([[Math.min(px, ...xs), busY], [Math.max(px, ...xs), busY]]);
        for (const x of xs) branches.push([[x, busY], [x, childTop]]);
      });
      ctx.status(`${s.toFixed(2)} mm names`);
    }
    const layers: Layer[] = [{ name: 'Names', color: PALETTE[0], paths: names }];
    if (v.pen2) layers.push({ name: 'Branches', color: PALETTE[2], paths: branches });
    else layers[0].paths.push(...branches);
    return layers;
  },
});
