import type { Locale } from '../i18n/ui.js';

/** Frozen public words; English at root must not shadow the /map/* asset mount. */
export const routeWords = {
  de: { about: 'uber-mich', map: 'karte', regions: 'reiseziele', journeys: 'rundreisen' },
  en: { about: 'about-me', map: 'map', regions: 'destinations', journeys: 'journeys' },
} as const;
const englishRootWords = { ...routeWords.en, map: 'travel-map' } as const;
export function wordsFor(locale: Locale, primary: Locale) {
  return locale === 'en' && primary === 'en'
    ? englishRootWords
    : routeWords[locale];
}
