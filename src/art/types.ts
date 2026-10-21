import type { GenOutput } from '../layers';
import type { ParamDef, Values } from '../params';
import type { Rng } from '../random';

export interface GenContext {
  /** Drawing area in mm; origin is the top-left of the area (inside the margins). */
  width: number;
  height: number;
  /** Margin in mm: the drawing area's offset from the paper's top-left. */
  margin: number;
  /** Seeded from the piece's `seed` param if it has one. */
  rng: Rng;
  seed: number;
  /** Show a short message in the status bar. */
  status: (msg: string) => void;
}

/** Paper settings a piece starts with (users can change them per piece). */
export interface PaperDefaults {
  paper?: 'a4' | 'a5' | 'a3' | 'letter' | '9x12' | 'postcard' | 'square' | 'custom';
  orientation?: 'landscape' | 'portrait';
  margin?: number;
  w?: number;
  h?: number;
}

export interface Artwork {
  /** URL id: #/art/<slug> */
  slug: string;
  title: string;
  description?: string;
  /** Gallery section. Defaults to 'art'. */
  kind?: 'art' | 'study' | 'tool';
  /** Sort order within its section (lower first). Artworks are grouped into series by order range (see gallery.ts). */
  order?: number;
  /** Gallery series heading, overriding the one implied by `order`. */
  series?: string;
  paper?: PaperDefaults;
  /** The knobs. Each becomes a control in the editor and a key on `values`. */
  params: ParamDef[];
  /** Needs the DOM (e.g. SVG layout), so runs on the main thread instead of the worker. */
  mainThread?: boolean;
  /** Text for the {place} caption token. Defaults to the `loc` knob's place name, if any. */
  caption?: (values: Values) => string;
  /** Return polylines in mm, or layers (one per pen). */
  generate(values: Values, ctx: GenContext): GenOutput | Promise<GenOutput>;
}

export const defineArtwork = (a: Artwork): Artwork => a;
