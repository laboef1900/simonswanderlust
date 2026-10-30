import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import AboutPage from './pages/AboutPage.astro';
import HomePage from './pages/HomePage.astro';
import RegionPage from './pages/RegionPage.astro';
import FeaturedHero from './FeaturedHero.astro';
import { identity } from '../lib/build-identity';
import { parseIdentitySnapshot } from '../lib/site-identity';
import { blogPostingJsonLd } from '../lib/seo';
import { GET as germanFeed } from '../pages/rss.xml.js';
import { GET as englishFeed } from '../pages/en/rss.xml.js';
import type { Locale } from '../i18n/ui';
import type { Trip } from '../lib/trips';

vi.mock('astro:content', () => ({
  getCollection: async () => [], getEntry: async () => undefined,
}));

const legacy = {
  siteName: "Simon's Wanderlust", authorName: 'Simon',
  tagline: { de: 'Reiseabenteuer & Geschichten', en: 'Travel adventures & stories' },
  aboutRole: { de: 'Reisender & Autor', en: 'Traveler & Storyteller' },
  aboutGear: { de: 'Leica Q2 · analoge Canon AE-1 · Notizbuch', en: 'Leica Q2 · analog Canon AE-1 · notebook' },
  socialLinks: [{ label: 'Instagram', url: 'https://www.instagram.com/simonswanderlust' }],
};
const windows: Window[] = [];
beforeEach(() => { Object.assign(identity, parseIdentitySnapshot(undefined)); });
afterEach(async () => { await Promise.all(windows.splice(0).map((window) => window.happyDOM.close())); });

function documentOf(html: string) {
  const window = new Window();
  windows.push(window);
  return new window.DOMParser().parseFromString(html, 'text/html');
}
function feedDocument(xml: string) {
  const window = new Window();
  windows.push(window);
  return new window.DOMParser().parseFromString(xml, 'application/xml');
}
async function about(locale: Locale) {
  const container = await AstroContainer.create();
  return documentOf(await container.renderToString(AboutPage, {
    props: { locale }, request: new Request('https://example.com/about/'),
  }));
}

const story = {
  title: 'A journey', date: new Date(2024, 9, 3), excerpt: 'A story.', locale: 'en' as const,
  image: { src: 'https://img.example.com/hero', width: 1600, height: 900, alt: 'Landscape' },
  url: 'https://example.com/a-journey/',
};

describe('configured identity rendered at public escaping boundaries', () => {
  it.each(['de', 'en'] as const)('keeps legal links independent of configured social profiles in %s', async (locale) => {
    for (const socialLinks of [[], legacy.socialLinks, [...legacy.socialLinks, { label: 'Notes', url: 'https://notes.example/' }]]) {
      Object.assign(identity, { socialLinks });
      const document = await about(locale);
      expect(document.querySelectorAll(`footer a[href="/legal/${locale}.html"]`)).toHaveLength(1);
      expect(document.querySelectorAll('footer a[href="/legal/THIRD-PARTY-NOTICES.txt"]')).toHaveLength(1);
      expect(document.querySelectorAll('footer a[target="_blank"]')).toHaveLength(socialLinks.length);
    }
  });

  it.each(['de', 'en'] as const)('preserves the legacy title, metadata, About profile, footer and RSS in %s', async (locale) => {
    Object.assign(identity, legacy);
    const document = await about(locale);
    expect(document.title).toBe((locale === 'de' ? 'Über mich' : 'About me') + " – Simon's Wanderlust");
    expect(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')).toBe("Simon's Wanderlust");
    expect(document.querySelector('link[type="application/rss+xml"]')?.getAttribute('title')).toBe("Simon's Wanderlust");
    expect(document.querySelector('header a')?.textContent?.trim()).toBe("Simon's Wanderlust");
    expect(document.querySelector('main h2')?.textContent).toBe('Simon');
    expect(document.querySelector('main')?.textContent).toContain(legacy.aboutRole[locale]);
    expect(document.querySelector('main')?.textContent).toContain(legacy.aboutGear[locale]);
    expect(document.querySelector('footer')?.textContent).toContain(legacy.tagline[locale]);
    expect(document.querySelector('footer')?.textContent).toContain(legacy.aboutGear[locale]);
    const social = document.querySelector('footer a[target="_blank"]');
    expect(social?.textContent).toBe('Instagram ↗');
    expect(social?.getAttribute('href')).toBe(legacy.socialLinks[0]!.url);
    expect(social?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(blogPostingJsonLd(story).author).toEqual({ '@type': 'Person', name: 'Simon' });
    const response = await (locale === 'de' ? germanFeed : englishFeed)({ site: new URL('https://example.com') });
    const xml = feedDocument(await response.text());
    expect(xml.querySelector('channel > title')?.textContent).toBe("Simon's Wanderlust");
    expect(xml.querySelector('channel > description')?.textContent).toBe(legacy.tagline[locale]);
  });

  it.each(['de', 'en'] as const)('uses neutral fallbacks and omits empty optional profile details in %s', async (locale) => {
    const document = await about(locale);
    const fallback = locale === 'de' ? 'Reisejournal' : 'Travel journal';
    expect(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')).toBe(fallback);
    expect(document.querySelector('main h2')).toBeNull();
    expect(document.querySelector('main')?.textContent).not.toContain(locale === 'de' ? 'Ausrüstung' : 'Equipment');
    expect(document.querySelectorAll('footer a[target="_blank"]')).toHaveLength(0);
    expect(blogPostingJsonLd(story)).not.toHaveProperty('author');
  });

  it('escapes hostile names, profile text, social labels and RSS while preserving link order', async () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    Object.assign(identity, {
      siteName: hostile, authorName: hostile, tagline: { en: hostile },
      aboutRole: { en: hostile }, aboutGear: { en: hostile },
      socialLinks: [{ label: hostile, url: 'https://one.example/?q=%22%3E' }, { label: 'Second', url: 'https://two.example/' }],
    });
    const document = await about('en');
    expect(document.title).toBe('About me – ' + hostile);
    expect(document.querySelector('main h2')?.textContent).toBe(hostile);
    expect(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')).toBe(hostile);
    expect(document.querySelectorAll('img[onerror]')).toHaveLength(0);
    expect([...document.querySelectorAll('script')].some((script) => script.textContent?.includes('alert(1)'))).toBe(false);
    const links = [...document.querySelectorAll('footer a[target="_blank"]')];
    expect(links.map((link) => link.textContent)).toEqual([hostile + ' ↗', 'Second ↗']);
    expect(links.every((link) => link.getAttribute('rel') === 'noopener noreferrer')).toBe(true);
    const rss = await englishFeed({ site: new URL('https://example.com') });
    const xml = await rss.text();
    expect(xml).not.toContain('<img');
    expect(xml).not.toContain('</script>');
    expect(xml).toContain('&lt;');
  });

  it('does not fall back to another locale’s private profile text', async () => {
    Object.assign(identity, {
      tagline: { de: 'German only' }, aboutRole: { de: 'Private role' }, aboutGear: { de: 'Private equipment' },
    });
    const document = await about('en');
    expect(document.querySelector('footer')?.textContent).toContain('Travel stories');
    expect(document.body.textContent).not.toContain('Private');
    expect(document.body.textContent).not.toContain('German only');
  });

  it('carries the configured tagline into home, regional descriptions and the featured heading', async () => {
    identity.tagline.en = 'From the road';
    const container = await AstroContainer.create();
    const home = documentOf(await container.renderToString(HomePage, { props: { locale: 'en' }, request: new Request('https://example.com/en/') }));
    expect(home.querySelector('h1')?.textContent).toBe('From the road');
    expect(home.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('From the road');
    const region = documentOf(await container.renderToString(RegionPage, { props: { locale: 'en' }, request: new Request('https://example.com/en/destinations/') }));
    expect(region.querySelector('meta[name="description"]')?.getAttribute('content')).toContain('From the road');
    const trip: Trip = {
      id: 'en/a-journey', collection: 'trips',
      data: {
        title: story.title, date: story.date, excerpt: story.excerpt, heroImage: story.image,
        country: 'Country', countryCode: 'DE', region: 'europe', translationKey: 'identity-fixture',
        coordinates: { lat: 1, lng: 2 },
      },
    };
    const hero = documentOf(await container.renderToString(FeaturedHero, { props: { trip } }));
    expect(hero.querySelector('h1')?.textContent).toBe('From the road');
  });
});
