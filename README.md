# aiplo

A browser sketchbook for the AxiDraw: generate plotter-native line art, preview it on paper, export SVG, or plot directly over WebSerial (Chrome/Edge). No server, no Inkscape.

```sh
npm install
npm run dev
```

## Making a piece

Each artwork is a script in `src/art/`. Copy `src/art/_template.ts` to `src/art/my-piece.ts` and it shows up in the gallery. Open it to get its knobs, paper settings, preview, export and plotting.

```ts
export default defineArtwork({
  slug: 'my-piece',
  title: 'My piece',
  paper: { paper: 'a4', orientation: 'landscape', margin: 15 },
  params: [{ type: 'number', key: 'count', label: 'Count', min: 1, max: 200, default: 40 }],
  generate(v, ctx) {
    // ctx.width / ctx.height: drawing area in mm. Return polylines, or
    // [{ name, color, paths }] layers for several pens. Can be async.
  },
});
```

Param types: `number`, `select`, `checkbox`, `seed` (feeds `ctx.rng`), `location` (place search → lat/lon), `code`, `file`. Each piece remembers its own knob values and paper.

Building blocks in `src/lib/`:
- `elevation.ts`: `terrainParams()` + `loadTerrainFor()` give you any place's heightmap (normalised height, real metres, sea mask); `ridges`, `contours`, `contourLevels`, `coastline`, `hachures` (with oblique lighting), `rays`, `rings` draw it.
- `streamlines.ts`: evenly spaced streamlines for any vector field.
- `../geom.ts`: clipping, simplification, resampling, path optimisation.

Gallery sections: `kind: 'art'` (default), `'study'` and `'tool'`.

## How it fits together

- Generation and processing run in a Web Worker (`worker.ts` / `engine.ts`); only the latest pending request is kept. Gallery thumbnails render in a second worker and are cached until a piece's knobs change. SVG import needs the DOM, so it runs on the main thread.
- **Layers** are pens. They're plotted in order; the carriage returns home and waits for a pen swap between them. Export writes one Inkscape layer per pen (`1-name`, `2-name`…).
- `src/plotter/`: EBB serial driver, trapezoidal motion planner with junction-deviation cornering, and the plot loop (pause lifts the pen, stop returns home).

## Plotting

1. Motors off, push the carriage to the home corner (top-left), place the paper's top-left corner under the pen.
2. Connect, tune pen up/down % with the buttons.
3. Plot the **Calibration** generator first: the arrow should point right (+x) and the square should measure true.
