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

Knob types: `number`, `select`, `checkbox`, `seed` (feeds `ctx.rng`), `location` (place search → lat/lon), `places` (a list, geocoded), `text`, `date` (optionally with time), `file` (stored in IndexedDB; read with `loadFiles`), `sketchpad` (draw in the browser), `code`. Each piece remembers its own knob values, paper and caption.

Pieces should render something with no input (demo image, synthetic audio, a default place) so their gallery thumbnails work, and keep default plots to roughly 3–25 minutes.

### Building blocks in `src/lib/`

| File | What it gives you |
|---|---|
| `elevation.ts`, `terrain.ts` | Any place's heightmap (normalised height, metres, sea mask) from AWS terrain tiles; `ridges`, `contours`, `contourLevels`, `coastline`, `hachures`, `rays`, `rings` |
| `osm.ts` | OpenStreetMap via Overpass (retries, mirror fallback, cache), local projection, circle clipping, parallel strokes |
| `world.ts` | Natural Earth coastlines, world and azimuthal projections with seam handling, great circles, graticules |
| `gpx.ts` | GPX parsing without a DOM |
| `astro.ts` | Sidereal time, sun and moon positions, moon phase geometry, sky projection |
| `weather.ts` | Open-Meteo archive client |
| `audio.ts` | Audio decoding (main thread), FFT, spectrograms, envelopes, a demo tune |
| `image.ts`, `stipple.ts` | Photo knobs, darkness sampling, CMY channels, a demo image; weighted stippling and TSP tours |
| `hatch.ts` | Polygon hatching and tone-by-hatching |
| `hershey.ts` | Single-stroke lettering in 8 Hershey fonts, including text along any path |
| `streamlines.ts` | Evenly spaced streamlines for any vector field |
| `gen-util.ts` | Fitting, clipping to shapes, insetting, stitching segments into long lines |
| `files.ts` | Uploaded files in IndexedDB |
| `song.ts`, `lyrics.ts` | A public-domain demo song with timed notes, chords and lyrics; LRC parsing and LRCLIB lookups for synced lyrics |
| `music.ts`, `music-text.ts` | Pitch tracking, onsets and tempo, chord charts, MIDI read/write; lyric timing and loudness helpers |
| `moments.ts`, `moments-geo.ts` | Poster building blocks: star charts, moon glyphs, sunrise/sunset, a day's weather, real time zones, globes and map frames |
| `routing.ts`, `exif.ts` | OSRM routes (drive, walk, cycle); GPS and dates from JPEG EXIF |
| `words-strokes.ts`, `words-shape.ts` | Recovering pen strokes from photos of handwriting; shape masks and spans for text-filled shapes |

`../geom.ts` has clipping, simplification, resampling, smoothing and path optimisation.

### Gallery

`kind: 'art'` (default), `'study'` or `'tool'`. Artworks are grouped into series by `order`: 1–9 Terrain, 10–19 Streets and water, 20–29 World, 30–39 Sky and time, 40–49 Sound and personal, 50–59 Photographs, 60+ Generative. Set `series` to use another (Moments, Music, Words and hands). The gallery filters by series and by what a piece uses (a place, a date, a photo, audio…), worked out from its knobs.

Music pieces default to the public-domain demo song; never commit real song lyrics.

### Captions and checks

Every piece gets an optional caption in the bottom margin (tokens `{title}`, `{place}`, `{coords}`, `{date}`, `{edition}`), an edition number and your signature (drawn once, shared by all pieces). Post-processing also checks ink density and warns where a pen would saturate the paper; "Show ink density" highlights those areas.

## How it fits together

- Generation and processing run in a Web Worker (`worker.ts` / `engine.ts`); only the latest pending request is kept. Gallery thumbnails render in a second worker and are cached until a piece's knobs change. Pieces that need the DOM (SVG import, audio decoding) set `mainThread: true`.
- **Layers** are pens. They're plotted in order; the carriage returns home and waits for a pen swap between them. Export writes one Inkscape layer per pen (`1-name`, `2-name`…).
- `src/plotter/`: EBB serial driver, trapezoidal motion planner with junction-deviation cornering, and the plot loop (pause lifts the pen, stop returns home).

## Plotting

While you're editing code, plot from `npm run plot` (a built copy on port 5180 that never live-reloads). Plot progress is saved as it goes, so after a crash or reload, reopening the piece puts the timeline back where it stopped.


1. Motors off, push the carriage to the home corner (top-left), place the paper's top-left corner under the pen.
2. Connect, tune pen up/down % with the buttons.
3. Plot the **Calibration** generator first: the arrow should point right (+x) and the square should measure true.
