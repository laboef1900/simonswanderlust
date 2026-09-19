export const locales = ['de', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'de';

const de = {
  'site.title': "Simon's Wanderlust",
  'site.tagline': 'Reiseabenteuer & Geschichten',
  'nav.stories': 'Reiseberichte',
  'nav.about': 'Über mich',
  'nav.map': 'Karte',
  'nav.ariaLabel': 'Hauptnavigation',
  'nav.skipToContent': 'Zum Hauptinhalt springen',
  'nav.viewInGerman': 'Auf Deutsch ansehen',
  'nav.viewInEnglish': 'Auf Englisch ansehen',
  'footer.latest': 'Neueste Beiträge',
  'footer.about': 'Über mich',
  'footer.logline': 'REISEJOURNAL & LOGBUCH',
  'home.title': 'Reiseabenteuer',
  'home.mapTeaser.title': 'Wo ich gewesen bin',
  'home.mapTeaser.cta': 'Zur Karte',
  // Accessible name for the plotted chart in the map band. The chart shows
  // WHERE, which the stats line beside it does not; it names the kind of
  // drawing rather than listing nine places, because the real, navigable map
  // is one link away and already carries a text fallback. Says "coastlines"
  // now that it draws measured ones (Natural Earth 1:110m) — a screen-reader
  // user should know the pins sit on land, not on a bare grid.
  'home.mapTeaser.chartLabel':
    'Reiseziele, eingezeichnet auf einer Karte mit Küstenlinien und einem Gradnetz aus Längen- und Breitengraden',
  'home.allStories': 'Alle Reiseberichte',
  'home.filter.all': 'Alle',
  'home.readStory': 'Geschichte lesen',
  'map.title': 'Reisekarte',
  'map.intro': 'Alle Reisen auf einen Blick.',
  'map.fallbackHeading': 'Reiseziele',
  'map.miniLabel': 'Auf der Karte',
  'map.viewOnMap': 'Auf der Karte ansehen',
  'map.readStory': 'Reisebericht lesen',
  'map.pinCount': 'Pin-Standorte',
  'stories.emptyTitle': 'Keine Beiträge gefunden',
  // Generic ("hier", not "in dieser Region"): StoryGrid also renders this on the
  // home page and the regions index, where a region-specific wording would lie.
  'stories.emptyBody': 'Hier stehen aktuell noch keine Reiseberichte bereit.',
  // Kicker on the one grid card the home page also shows as its hero.
  'stories.coverStory': 'Titelgeschichte',
  'story.toc': 'Inhalt',
  'story.keyFactsAbout': 'Fakten über',
  'story.prev': 'Vorherige Geschichte',
  'story.next': 'Nächste Geschichte',
  'story.pagination': 'Weitere Geschichten',
  'story.otherLang': 'Read this story in English',
  // Gallery island (site/src/scripts/gallery-lightbox.ts). The strings reach the
  // script through data attributes on GalleryIsland.astro — the gallery markup
  // itself is injected by body-images.ts, which has no locale.
  'gallery.slider': 'Fotogalerie, horizontal scrollbar',
  'gallery.viewer': 'Fotoansicht',
  'gallery.close': 'Schließen',
  'gallery.prev': 'Vorheriges Foto',
  'gallery.next': 'Nächstes Foto',
  'gallery.position': 'Foto {current} von {total}',
  'region.europe': 'Europa',
  'region.north-america': 'Nordamerika',
  'region.south-america': 'Südamerika',
  'regions.title': 'Reiseziele',
  'about.title': 'Über mich',
  'about.role': 'Reisender & Autor',
  'about.equipment': 'Ausrüstung',
  'about.gear': 'Leica Q2 · analoge Canon AE-1 · Notizbuch',
  'notFound.title': 'Seite nicht gefunden',
  'notFound.home': 'Zur Startseite',
  'regions.navLabel': 'Reiseziele nach Region',
  'story.stamp': 'EINREISE',
  'stats.trips': 'REISEN',
  'stats.countries': 'LÄNDER',
  'stats.continents': 'KONTINENTE',
} as const;

export type UIKey = keyof typeof de;

const en: Record<UIKey, string> = {
  'site.title': "Simon's Wanderlust",
  'site.tagline': 'Travel adventures & stories',
  'nav.stories': 'Stories',
  'nav.about': 'About me',
  'nav.map': 'Map',
  'nav.ariaLabel': 'Main navigation',
  'nav.skipToContent': 'Skip to main content',
  'nav.viewInGerman': 'View in German',
  'nav.viewInEnglish': 'View in English',
  'footer.latest': 'Latest stories',
  'footer.about': 'About me',
  'footer.logline': 'TRAVEL JOURNAL & LOGBOOK',
  'home.title': 'Travel adventures',
  'home.mapTeaser.title': "Where I've been",
  'home.mapTeaser.cta': 'View the map',
  'home.mapTeaser.chartLabel':
    'Destinations plotted on a map of coastlines with a grid of latitude and longitude',
  'home.allStories': 'All travel stories',
  'home.filter.all': 'All',
  'home.readStory': 'Read the story',
  'map.title': 'Travel map',
  'map.intro': 'Every trip at a glance.',
  'map.fallbackHeading': 'Destinations',
  'map.miniLabel': 'On the map',
  'map.viewOnMap': 'View on the map',
  'map.readStory': 'Read the story',
  'map.pinCount': 'pin locations',
  'stories.emptyTitle': 'No stories found',
  'stories.emptyBody': 'There are no travel stories here yet.',
  'stories.coverStory': 'Cover story',
  'story.toc': 'Contents',
  'story.keyFactsAbout': 'Key facts about',
  'story.prev': 'Previous story',
  'story.next': 'Next story',
  'story.pagination': 'More stories',
  'story.otherLang': 'Diese Geschichte auf Deutsch lesen',
  'gallery.slider': 'Photo gallery, scrolls horizontally',
  'gallery.viewer': 'Photo viewer',
  'gallery.close': 'Close',
  'gallery.prev': 'Previous photo',
  'gallery.next': 'Next photo',
  'gallery.position': 'Photo {current} of {total}',
  'region.europe': 'Europe',
  'region.north-america': 'North America',
  'region.south-america': 'South America',
  'regions.title': 'Destinations',
  'about.title': 'About me',
  'about.role': 'Traveler & Storyteller',
  'about.equipment': 'Equipment',
  'about.gear': 'Leica Q2 · analog Canon AE-1 · notebook',
  'notFound.title': 'Page not found',
  'notFound.home': 'Back to home',
  'regions.navLabel': 'Destinations by region',
  'story.stamp': 'ARRIVED',
  'stats.trips': 'TRIPS',
  'stats.countries': 'COUNTRIES',
  'stats.continents': 'CONTINENTS',
};

export const ui: Record<Locale, Record<UIKey, string>> = { de, en };

export function useTranslations(locale: Locale) {
  return (key: UIKey): string => ui[locale][key];
}
