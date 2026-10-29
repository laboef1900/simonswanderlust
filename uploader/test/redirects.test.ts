import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_REDIRECTS, legacyRedirect, legacyRedirectForRelease } from '../src/redirects.js';
import type { LanguageConfig } from '../src/language.js';

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

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('activated release redirect language', () => {
  it.each<LanguageConfig>([
    { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
    { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
  ])('qualifies all eighteen fixed entries for $primary / $locales', async (language) => {
    const dir = await mkdtemp(join(tmpdir(), 'redirect-language-')); dirs.push(dir);
    await writeFile(join(dir, 'index.html'), `<!doctype html><html data-site-primary="${language.primary}" data-site-locales="${language.locales.join(',')}" lang="${language.primary}"><head><link rel="canonical" href="https://changed-identity.example/"></head><body></body></html>`);
    for (const [from, target] of LEGACY_REDIRECTS) {
      const eligible = language.primary === 'de' && (!from.startsWith('/en/') || language.locales.includes('en'));
      expect(legacyRedirect(from, language)).toBe(eligible ? target : undefined);
      expect(await legacyRedirectForRelease(from, dir)).toBe(eligible ? target : undefined);
    }
  });
  it.each([
    '<html lang="de" data-site-primary="de"></html>',
    '<html data-site-primary="de" data-site-locales="en"></html>',
    '<html data-site-primary="de" data-site-locales="de,de"></html>',
    '<html data-site-primary="fr" data-site-locales="fr"></html>',
    '<html data-site-primary="de" data-site-primary="en" data-site-locales="de,en"></html>',
    '<html data-site-primary data-site-locales="de,en"></html>',
    '<html data-site-primary="de" data-site-locales="de,en"',
    '<body><html data-site-primary="de" data-site-locales="de,en"></html></body>',
  ])('refuses malformed or partial root metadata: %s', async (html) => {
    const dir = await mkdtemp(join(tmpdir(), 'redirect-language-')); dirs.push(dir);
    await writeFile(join(dir, 'index.html'), html);
    expect(await legacyRedirectForRelease('/feed', dir)).toBeUndefined();
  });
  it('recognizes an actual historical root, but not missing files or a root beyond the bounded prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redirect-language-')); dirs.push(dir);
    expect(await legacyRedirectForRelease('/feed', dir)).toBeUndefined();
    await writeFile(join(dir, 'index.html'), '<!doctype html><html lang="de"><body>Historical</body></html>');
    expect(await legacyRedirectForRelease('/en/feed', dir)).toBe('/en/rss.xml');
    await writeFile(join(dir, 'index.html'), ' '.repeat(4096) + '<html lang="de"></html>');
    expect(await legacyRedirectForRelease('/feed', dir)).toBeUndefined();
  });
});
