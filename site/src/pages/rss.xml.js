import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { identitySiteName, identityTagline } from '../lib/build-identity';
import { byLocale, pathOf } from '../lib/trips';

export async function GET(context) {
  const trips = byLocale(await getCollection('trips'), 'de');
  return rss({
    title: identitySiteName('de'),
    description: identityTagline('de'),
    site: context.site,
    customData: '<language>de</language>',
    items: trips.map((trip) => ({
      title: trip.data.title,
      pubDate: trip.data.date,
      description: trip.data.excerpt,
      link: pathOf(trip),
    })),
  });
}
