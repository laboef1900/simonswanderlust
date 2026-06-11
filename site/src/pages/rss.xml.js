import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { ui } from '../i18n/ui';
import { byLocale, pathOf } from '../lib/trips';

export async function GET(context) {
  const trips = byLocale(await getCollection('trips'), 'de');
  return rss({
    title: ui.de['site.title'],
    description: ui.de['site.tagline'],
    site: context.site,
    items: trips.map((trip) => ({
      title: trip.data.title,
      pubDate: trip.data.date,
      description: trip.data.excerpt,
      link: pathOf(trip),
    })),
  });
}
