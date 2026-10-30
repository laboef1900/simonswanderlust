import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { identitySiteName, identityTagline } from '../../lib/build-identity';
import { byLocale, pathOf } from '../../lib/trips';

export async function GET(context) {
  const trips = byLocale(await getCollection('trips'), 'en');
  return rss({
    title: identitySiteName('en'),
    description: identityTagline('en'),
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
