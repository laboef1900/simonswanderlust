/** Closed page identities shared by authoring and public routing. About's stored slug is always empty. */
export const PAGE_KINDS = {
  about: { slugs: { de: 'uber-mich', en: 'about-me' }, deletable: false, unpublishable: false, slots: ['header', 'footer'] },
  contact: { slugs: { de: 'kontakt', en: 'contact' }, deletable: true, unpublishable: true, slots: ['footer'] },
  privacy: { slugs: { de: 'datenschutz', en: 'privacy' }, deletable: true, unpublishable: true, slots: ['legal'] },
  legal: { slugs: { de: 'impressum', en: 'legal-notice' }, deletable: true, unpublishable: true, slots: ['legal'] },
} as const;
export type PageKind = keyof typeof PAGE_KINDS;
export function isPageKind(value: string): value is PageKind { return Object.hasOwn(PAGE_KINDS, value); }
