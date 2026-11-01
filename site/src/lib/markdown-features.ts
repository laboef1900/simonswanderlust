import type { Features } from 'satteri';

/** Astro's current defaults, explicit so source analysis and rendering cannot drift. */
export const MARKDOWN_FEATURES = { gfm: true, smartPunctuation: true } satisfies Features;
