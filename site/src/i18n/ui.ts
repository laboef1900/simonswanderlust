export const locales = ['de', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'de';

const de = {
  'site.title': "Simon's Wanderlust",
  'site.tagline': 'Reiseabenteuer & Geschichten',
  'nav.stories': 'Reiseberichte',
  'nav.about': 'Über mich',
  'nav.ariaLabel': 'Hauptnavigation',
  'footer.latest': 'Neueste Beiträge',
  'footer.about': 'Über mich',
  'home.title': 'Reiseabenteuer',
  'home.heroLabel': 'Neueste Geschichte',
  'home.mapTeaser.title': 'Wo ich gewesen bin',
  'home.mapTeaser.cta': 'Zur Karte',
  'home.mapTeaser.soon': 'bald verfügbar',
  'home.allStories': 'Alle Reiseberichte',
  'home.filter.all': 'Alle',
  'home.readStory': 'Geschichte lesen',
  'home.aboutTeaser.text': 'Ich bin Simon — ich sammle Geschichten von den belebten Straßen Europas bis zu den geheimnisvollen Pfaden Südamerikas.',
  'home.aboutTeaser.cta': 'Mehr über mich',
  'story.toc': 'Inhalt',
  'story.keyFactsAbout': 'Fakten über',
  'story.prev': 'Vorherige Geschichte',
  'story.next': 'Nächste Geschichte',
  'story.otherLang': 'Read this story in English',
  'region.europe': 'Europa',
  'region.north-america': 'Nordamerika',
  'region.south-america': 'Südamerika',
  'regions.title': 'Reiseziele',
  'about.title': 'Über mich',
  'notFound.title': 'Seite nicht gefunden',
  'notFound.home': 'Zur Startseite',
} as const;

export type UIKey = keyof typeof de;

const en: Record<UIKey, string> = {
  'site.title': "Simon's Wanderlust",
  'site.tagline': 'Travel adventures & stories',
  'nav.stories': 'Stories',
  'nav.about': 'About me',
  'nav.ariaLabel': 'Main navigation',
  'footer.latest': 'Latest stories',
  'footer.about': 'About me',
  'home.title': 'Travel adventures',
  'home.heroLabel': 'Latest story',
  'home.mapTeaser.title': "Where I've been",
  'home.mapTeaser.cta': 'View the map',
  'home.mapTeaser.soon': 'coming soon',
  'home.allStories': 'All travel stories',
  'home.filter.all': 'All',
  'home.readStory': 'Read the story',
  'home.aboutTeaser.text': "I'm Simon — collecting stories from the bustling streets of Europe to the mysterious trails of South America.",
  'home.aboutTeaser.cta': 'More about me',
  'story.toc': 'Contents',
  'story.keyFactsAbout': 'Key facts about',
  'story.prev': 'Previous story',
  'story.next': 'Next story',
  'story.otherLang': 'Diese Geschichte auf Deutsch lesen',
  'region.europe': 'Europe',
  'region.north-america': 'North America',
  'region.south-america': 'South America',
  'regions.title': 'Destinations',
  'about.title': 'About me',
  'notFound.title': 'Page not found',
  'notFound.home': 'Back to home',
};

export const ui: Record<Locale, Record<UIKey, string>> = { de, en };

export function useTranslations(locale: Locale) {
  return (key: UIKey): string => ui[locale][key];
}
