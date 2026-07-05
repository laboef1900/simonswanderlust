import { describe, expect, it } from 'vitest';
import { LEGACY_REDIRECTS, legacyRedirect } from '../src/redirects.js';

describe('legacyRedirect', () => {
  it('maps the WordPress feed family to /rss.xml, with and without trailing slash', () => {
    expect(legacyRedirect('/feed')).toBe('/rss.xml');
    expect(legacyRedirect('/feed/')).toBe('/rss.xml');
    expect(legacyRedirect('/feed/atom/')).toBe('/rss.xml');
    expect(legacyRedirect('/comments/feed/')).toBe('/rss.xml');
  });

  it('maps the built-in WP feed aliases (rss2, rss, rdf) to /rss.xml', () => {
    expect(legacyRedirect('/feed/rss2/')).toBe('/rss.xml');
    expect(legacyRedirect('/feed/rss/')).toBe('/rss.xml');
    expect(legacyRedirect('/feed/rdf/')).toBe('/rss.xml');
  });

  it('maps the Polylang EN feed family to /en/rss.xml', () => {
    expect(legacyRedirect('/en/feed/')).toBe('/en/rss.xml');
    expect(legacyRedirect('/en/feed/atom/')).toBe('/en/rss.xml');
    expect(legacyRedirect('/en/feed/rss2/')).toBe('/en/rss.xml');
    expect(legacyRedirect('/en/feed/rss/')).toBe('/en/rss.xml');
    expect(legacyRedirect('/en/feed/rdf/')).toBe('/en/rss.xml');
    expect(legacyRedirect('/en/comments/feed/')).toBe('/en/rss.xml');
  });

  it('strips the query string before matching', () => {
    expect(legacyRedirect('/feed/?withoutcomments=1')).toBe('/rss.xml');
    expect(legacyRedirect('/feed?withoutcomments=1')).toBe('/rss.xml');
  });

  it('maps DE category archives to /reiseziele/ region pages', () => {
    expect(legacyRedirect('/category/europa/')).toBe('/reiseziele/europa/');
    expect(legacyRedirect('/category/nordamerika/')).toBe('/reiseziele/nordamerika/');
    expect(legacyRedirect('/category/suedamerika/')).toBe('/reiseziele/suedamerika/');
  });

  it('maps EN category archives to /en/destinations/ region pages', () => {
    expect(legacyRedirect('/en/category/europe/')).toBe('/en/destinations/europe/');
    expect(legacyRedirect('/en/category/north-america/')).toBe('/en/destinations/north-america/');
    expect(legacyRedirect('/en/category/south-america/')).toBe('/en/destinations/south-america/');
  });

  it('returns undefined for everything else', () => {
    expect(legacyRedirect('/')).toBeUndefined();
    expect(legacyRedirect('')).toBeUndefined();
    expect(legacyRedirect('/category/asien/')).toBeUndefined();
    expect(legacyRedirect('/wp-content/uploads/2021/07/x.jpg')).toBeUndefined();
    expect(legacyRedirect('/feed/extra/')).toBeUndefined();
    expect(legacyRedirect('/rumaenien/')).toBeUndefined();
  });

  it('uses only contract-frozen targets with trailing slashes on page URLs', () => {
    for (const [from, to] of LEGACY_REDIRECTS) {
      expect(from.startsWith('/')).toBe(true);
      expect(from.endsWith('/')).toBe(false); // keys are normalized (no trailing slash)
      // Targets are either the RSS feeds or trailing-slash page URLs
      // (trailingSlash: 'always' contract on the Astro side).
      expect(to === '/rss.xml' || to === '/en/rss.xml' || to.endsWith('/')).toBe(true);
    }
  });
});
