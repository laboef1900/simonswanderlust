import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import type { Locale } from '../../i18n/ui';
import { identitySiteName, identityTagline } from '../../lib/build-identity';
import { byLocale, pathOf } from '../../lib/trips';
import { homePath, localePrefix } from '../../lib/paths';
import { siteLanguage } from '../../lib/site-language';

export function getStaticPaths() {
  const language = siteLanguage();
  return language.locales.map((locale) => ({
    params: { locale: localePrefix(locale, language).slice(1) || undefined },
    props: { locale },
  }));
}

export async function GET(context: Pick<APIContext<{ locale: Locale }>, 'site' | 'props'>) {
  const { locale } = context.props;
  const language = siteLanguage();
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
