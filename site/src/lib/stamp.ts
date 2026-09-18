export type StampShape = 'rect' | 'circle';
export type StampBorder = 'single' | 'double' | 'dashed';
export interface StampStyle { ink: string; border: StampBorder; rotation: number }

/**
 * Real-world-weighted ink palette: black + navy appear twice → ~57% of codes.
 *
 * @ai-warning Exported so `styles/tokens.test.ts` can assert every ink still
 * reads on the canvas chip the stamp is pressed onto. Adding an ink without
 * checking is how the mark became illegible once already — see the
 * @ai-warning in FeaturedHero.astro.
 */
export const STAMP_INKS = ['#1a1a2e', '#1e3a6e', '#1a1a2e', '#1e3a6e', '#c0311e', '#6b3d9e', '#1e5c30'] as const;
const BORDERS: StampBorder[] = ['single', 'double', 'dashed'];

function hash(code: string): number {
  let h = 2166136261;
  const s = code.toUpperCase();
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Europe gets the Schengen rectangle; every other region gets a circular stamp. */
export function regionShape(region: string): StampShape {
  return region === 'europe' ? 'rect' : 'circle';
}

/** Deterministic per-country stamp style (ink/border/rotation) — same code → same style. */
export function stampStyle(countryCode: string): StampStyle {
  const h = hash(countryCode);
  return {
    ink: STAMP_INKS[h % STAMP_INKS.length] as string,
    border: BORDERS[(h >>> 4) % BORDERS.length] as StampBorder,
    rotation: ((h >>> 8) % 11) - 5, // -5..+5
  };
}
