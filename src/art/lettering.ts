import { FONT_OPTIONS, measureText, text } from '../lib/hershey';
import { defineArtwork } from './types';

export default defineArtwork({
  slug: 'lettering',
  title: 'Lettering',
  description: 'Set text in single-stroke Hershey fonts, for titles, labels and test sheets.',
  kind: 'tool',
  order: 4,
  paper: { paper: 'a5', orientation: 'landscape', margin: 15 },
  params: [
    { type: 'text', key: 'text', label: 'Text', multiline: true, default: 'The quick brown fox\njumps over the lazy dog\n0123456789 · 45°N' },
    { type: 'select', key: 'font', label: 'Font', options: FONT_OPTIONS, default: 'futural' },
    { type: 'number', key: 'size', label: 'Cap height (mm)', min: 1, max: 60, step: 0.5, default: 8 },
    { type: 'select', key: 'align', label: 'Align', options: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], default: 'center' },
    { type: 'number', key: 'tracking', label: 'Letter spacing', min: -0.2, max: 1, step: 0.01, default: 0 },
    { type: 'number', key: 'leading', label: 'Line spacing', min: 1, max: 3, step: 0.05, default: 1.6 },
    { type: 'checkbox', key: 'fit', label: 'Shrink to fit width', default: true },
    { type: 'checkbox', key: 'specimen', label: 'Specimen: show every font', default: false },
  ],
  generate(v, ctx) {
    const { width: W, height: H } = ctx;
    if (v.specimen) {
      const rows = FONT_OPTIONS.length;
      const size = Math.min(v.size, (H / rows) * 0.45);
      return FONT_OPTIONS.flatMap(([font, name], i) =>
        text(`${name}: Aiplo 123`, { font, size, x: 0, y: ((i + 0.75) / rows) * H }),
      );
    }
    const lines = String(v.text).split('\n');
    const opts = { font: v.font, tracking: v.tracking, leading: v.leading };
    let size = v.size;
    if (v.fit) {
      const widest = Math.max(...lines.map((l) => measureText(l, { ...opts, size: 1 })));
      if (widest > 0) size = Math.min(size, W / widest);
    }
    // Centre the block vertically.
    const blockH = size + (lines.length - 1) * size * v.leading;
    const x = v.align === 'center' ? W / 2 : v.align === 'right' ? W : 0;
    ctx.status(`${size.toFixed(1)} mm cap height`);
    return text(lines.join('\n'), { ...opts, size, x, y: (H - blockH) / 2 + size, align: v.align });
  },
});
