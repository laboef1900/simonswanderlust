import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { publicPath, publicUrlSet, type PublicPathKind, type PublicUrlRow } from '../src/public-paths.js';
import type { LanguageConfig, LanguageLocale } from '../src/language.js';
import { aboutPath, homePath, mapPath, regionPath, regions, regionsIndexPath, regionSlugs, rssPath, storyPath } from '../../site/src/lib/paths.js';

interface BrowserLanguage {
  publicPath(language: LanguageConfig, locale: LanguageLocale, kind: PublicPathKind, slug?: string): string | null;
}
const window: { SiteLanguage?: BrowserLanguage } = {};
vm.runInNewContext(readFileSync('public/language.js', 'utf8'), { window });
if (!window.SiteLanguage) throw new Error('language.js did not expose SiteLanguage');
const browser = window.SiteLanguage;
const modes: LanguageConfig[] = [
  { primary: 'de', locales: ['de', 'en'] },
  { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] },
  { primary: 'en', locales: ['en'] },
];
const kinds: PublicPathKind[] = ['home', 'story', 'about', 'map', 'regions', 'region', 'rss'];
// Literal route tables pin the approved contract independently of both mirrors.
const rootDe = ['/', '/reise/', '/uber-mich/', '/karte/', '/reiseziele/', '/reiseziele/europa/', '/rss.xml'];
const rootEn = ['/', '/journey/', '/about-me/', '/travel-map/', '/destinations/', '/destinations/europe/', '/rss.xml'];
const prefixedDe = ['/de/', '/de/reise/', '/de/uber-mich/', '/de/karte/', '/de/reiseziele/', '/de/reiseziele/europa/', '/de/rss.xml'];
const prefixedEn = ['/en/', '/en/journey/', '/en/about-me/', '/en/map/', '/en/destinations/', '/en/destinations/europe/', '/en/rss.xml'];
function slugFor(kind: PublicPathKind, locale: LanguageLocale): string | undefined {
  if (kind === 'story') return locale === 'de' ? 'reise' : 'journey';
  if (kind === 'region') return locale === 'de' ? 'europa' : 'europe';
  return undefined;
}

describe('public URL mirrors', () => {
  for (const language of modes) {
    describe(`${language.primary}-primary ${language.locales.join('+')}`, () => {
      for (const locale of ['de', 'en'] as const) {
        it(`${locale} has exactly its enabled route table`, () => {
          if (!language.locales.includes(locale)) {
            for (const kind of kinds) {
              expect(() => publicPath(language, locale, kind, slugFor(kind, locale))).toThrow('Locale is not enabled');
              expect(browser.publicPath(language, locale, kind, slugFor(kind, locale))).toBeNull();
            }
            return;
          }
          const expected = locale === language.primary ? (locale === 'de' ? rootDe : rootEn) : (locale === 'de' ? prefixedDe : prefixedEn);
          expect(kinds.map(kind => publicPath(language, locale, kind, slugFor(kind, locale)))).toEqual(expected);
          expect(kinds.map(kind => browser.publicPath(language, locale, kind, slugFor(kind, locale)))).toEqual(expected);
          expect([
            homePath(locale, language),
            storyPath(slugFor('story', locale)!, locale, language),
            aboutPath(locale, language), mapPath(locale, language),
            regionsIndexPath(locale, language), regionPath('europe', locale, language), rssPath(locale, language),
          ]).toEqual(expected);
          for (const region of regions) {
            const slug = regionSlugs[region][locale];
            expect(browser.publicPath(language, locale, 'region', slug)).toBe(publicPath(language, locale, 'region', slug));
            expect(regionPath(region, locale, language)).toBe(publicPath(language, locale, 'region', slug));
          }
        });
      }
      it('projects only enabled committed stories, with sorted unique fixed URLs', () => {
        const rows: PublicUrlRow[] = [
          { locale: 'de', slug: 'reise', status: 'published', published_snapshot: {} },
          { locale: 'en', slug: 'journey', status: 'published', published_snapshot: {} },
          { locale: 'de', slug: 'private-draft', status: 'draft', published_snapshot: {} },
          { locale: 'en', slug: 'missing-snapshot', status: 'published', published_snapshot: null },
        ];
        const expected = ['/404.html', '/sitemap-index.xml', '/sitemap-0.xml'];
        for (const locale of language.locales) {
          const table = locale === language.primary ? (locale === 'de' ? rootDe : rootEn) : (locale === 'de' ? prefixedDe : prefixedEn);
          expected.push(...table.filter((_path, index) => kinds[index] !== 'region'));
        }
        expect(publicUrlSet(language, [...rows, rows[0]!])).toEqual([...new Set(expected)].sort());
      });
    });
  }

  it('keeps the DE-primary site path baseline byte-identical', () => {
    const language = modes[0]!;
    for (const locale of language.locales) {
      expect(publicPath(language, locale, 'home')).toBe(homePath(locale));
      expect(publicPath(language, locale, 'about')).toBe(aboutPath(locale));
      expect(publicPath(language, locale, 'map')).toBe(mapPath(locale));
      expect(publicPath(language, locale, 'regions')).toBe(regionsIndexPath(locale));
      for (const region of regions) {
        expect(publicPath(language, locale, 'region', regionSlugs[region][locale])).toBe(regionPath(region, locale));
      }
    }
  });

  it.each(['', '../admin', 'a/b', 'a?query', 'a#fragment', 'UPPER'])('refuses unsafe public slug %j', slug => {
    for (const kind of ['story', 'region'] as const) {
      expect(() => publicPath(modes[0]!, 'de', kind, slug)).toThrow();
    }
  });
});
