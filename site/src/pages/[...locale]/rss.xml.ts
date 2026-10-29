import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import { identitySiteName, identityTagline } from '../../lib/build-identity';
import { byLocale, pathOf } from '../../lib/trips';
import { homePath, localePrefix } from '../../lib/paths';
import { siteLanguage } from '../../lib/site-language';

export function getStaticPaths() {
  const language = siteLanguage();
  return language.locales.map((locale) => ({
    params: { locale: localePrefix(locale, language).slice(1) || undefined },
  }));
}

export async function GET(context: Pick<APIContext, 'site' | 'currentLocale'>) {
  const language = siteLanguage();
  // Endpoint props can resolve to the root path in Astro's static prerenderer.
  // currentLocale follows the request URL and the same captured i18n configuration.
  const locale = language.locales.find((locale) => locale === context.currentLocale);
  if (!locale) throw new Error('RSS endpoint has no enabled locale');
  const trips = byLocale(await getCollection('trips'), locale, language);
  return rss({
    title: identitySiteName(locale),
    description: identityTagline(locale),
    site: new URL(homePath(locale, language), context.site).href,
    customData: `<language>${locale}</language>`,
    items: trips.map((trip) => ({
      title: trip.data.title,
      pubDate: trip.data.date,
      description: trip.data.excerpt,
      link: pathOf(trip, language),
    })),
  });
}
