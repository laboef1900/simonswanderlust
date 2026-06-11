import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { ui } from '../../i18n/ui';
import { byLocale, pathOf } from '../../lib/trips';

export async function GET(context) {
  const trips = byLocale(await getCollection('trips'), 'en');
  return rss({
    title: ui.en['site.title'],
    description: ui.en['site.tagline'],
    site: new URL('/en/', context.site).href,
    customData: '<language>en</language>',
    items: trips.map((trip) => ({
      title: trip.data.title,
      pubDate: trip.data.date,
      description: trip.data.excerpt,
      link: pathOf(trip),
    })),
  });
}
