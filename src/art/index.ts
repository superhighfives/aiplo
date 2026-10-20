import type { Artwork } from './types';

// Every .ts file in this folder (except index, types and _-prefixed files) is a piece.
const modules = import.meta.glob<{ default: Artwork }>(['./*.ts', '!./index.ts', '!./types.ts', '!./_*.ts'], { eager: true });

export const artworks: Artwork[] = Object.values(modules)
  .map((m) => m.default)
  .filter(Boolean)
  .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));

export const findArtwork = (slug: string) => artworks.find((a) => a.slug === slug);
