import type { Identity } from '../../site/src/lib/site-identity.js';
import { DEFAULT_REVIEW_PROMPT } from './editorial-review.js';

/** @ai-warning Owner-install upgrade/old-dump seed only, NEVER a fresh-install default. See identity spec §12.2. */
export const LEGACY_IDENTITY: Identity = {
  siteName: "Simon's Wanderlust",
  authorName: 'Simon',
  canonicalOrigin: 'https://simonswanderlust.com',
  tagline: { de: 'Reiseabenteuer & Geschichten', en: 'Travel adventures & stories' },
  aboutRole: { de: 'Reisender & Autor', en: 'Traveler & Storyteller' },
  aboutGear: { de: 'Leica Q2 · analoge Canon AE-1 · Notizbuch', en: 'Leica Q2 · analog Canon AE-1 · notebook' },
  studioDescriptor: { de: 'Simons Reisetagebuch', en: 'Simon’s travel journal' },
  socialLinks: [{ label: 'Instagram', url: 'https://www.instagram.com/simonswanderlust' }],
};
export const LEGACY_REVIEW_PROMPT = "You are an editorial and SEO reviewer for Simon's Wanderlust, a personal travel blog.\n" + DEFAULT_REVIEW_PROMPT.slice(DEFAULT_REVIEW_PROMPT.indexOf('\n') + 1);
