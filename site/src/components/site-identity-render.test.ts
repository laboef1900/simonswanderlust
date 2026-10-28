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

  it.each(['de', 'en'] as const)('renders the saved logo as one named home link with intrinsic dimensions in %s', async (locale) => {
    identity.siteName = 'Our field notes';
    identity.assets.logo = { path: '/_identity/logo-0123456789abcdef.png', width: 960, height: 240 };
    const document = await about(locale);
    const home = document.querySelector('header a');
    const logo = home?.querySelector('img');
    expect(home?.getAttribute('href')).toBe(locale === 'de' ? '/' : '/en/');
    expect(home?.querySelectorAll('img')).toHaveLength(1);
    expect(home?.textContent?.trim()).toBe('');
    expect(home?.hasAttribute('aria-label')).toBe(false);
    expect(logo?.getAttribute('alt')).toBe('Our field notes');
    expect(logo?.getAttribute('src')).toBe('/_identity/logo-0123456789abcdef.png');
    expect(logo?.getAttribute('width')).toBe('960');
    expect(logo?.getAttribute('height')).toBe('240');
    expect(logo?.classList.contains('h-8')).toBe(true);
    expect(logo?.classList.contains('w-auto')).toBe(true);
    expect(logo?.classList.contains('object-contain')).toBe(true);
    expect(home?.classList.contains('min-h-[44px]')).toBe(true);
    expect(home?.hasAttribute('tabindex')).toBe(false);
    expect(home?.className).not.toContain('outline-none');
    home?.focus();
    expect(document.activeElement).toBe(home);
  });

  it.each(['de', 'en'] as const)('uses the localized fallback for an unnamed logo and restores text when removed in %s', async (locale) => {
    identity.assets.logo = { path: '/_identity/logo-0123456789abcdef.png', width: 48, height: 240 };
    const fallback = locale === 'de' ? 'Reisejournal' : 'Travel journal';
    const custom = await about(locale);
    expect(custom.querySelector('header a img')?.getAttribute('alt')).toBe(fallback);
    identity.assets.logo = null;
    const removed = await about(locale);
    expect(removed.querySelector('header a img')).toBeNull();
    expect(removed.querySelector('header a')?.textContent?.trim()).toBe(fallback);
  });

  it('keeps a wide logo shrinkable within the mobile home link without clipping its focus ring', async () => {
    identity.assets.logo = { path: '/_identity/logo-0123456789abcdef.png', width: 960, height: 32 };
    const document = await about('de');
    const home = document.querySelector('header a');
    const logo = home?.querySelector('img');
    // Structural guards for the 320px browser check: no fixed logo width or
    // overflow clipping, and the navigation still gets its own mobile row.
    for (const element of [home, logo]) {
      expect(element?.classList.contains('min-w-0')).toBe(true);
      expect(element?.classList.contains('max-w-full')).toBe(true);
      expect(element?.className).not.toContain('overflow-hidden');
    }
    expect(home?.parentElement?.classList.contains('flex-col')).toBe(true);
    expect(document.querySelector('header nav')?.classList.contains('flex-wrap')).toBe(true);
  });

  it('escapes the configured name in logo alternative text', async () => {
    identity.siteName = '"><img src=x onerror=alert(1)>';
    identity.assets.logo = { path: '/_identity/logo-0123456789abcdef.png', width: 320, height: 80 };
    const document = await about('en');
    expect(document.querySelector('header a img')?.getAttribute('alt')).toBe(identity.siteName);
    expect(document.querySelectorAll('header img')).toHaveLength(1);
    expect(document.querySelectorAll('img[onerror]')).toHaveLength(0);
  });

  it.each(['de', 'en'] as const)('renders all saved favicon variants and restores the default on removal in %s', async (locale) => {
    identity.assets.favicon = {
      png32: '/_identity/favicon-32-0123456789abcdef.png',
      png192: '/_identity/favicon-192-fedcba9876543210.png',
      appleTouch180: '/_identity/apple-touch-180-abcdef0123456789.png',
    };
    const document = await about(locale);
    const icons = [...document.querySelectorAll('link[rel="icon"]')];
    expect(icons.map((icon) => ({
      href: icon.getAttribute('href'), type: icon.getAttribute('type'), sizes: icon.getAttribute('sizes'),
    }))).toEqual([
      { href: identity.assets.favicon.png32, type: 'image/png', sizes: '32x32' },
      { href: identity.assets.favicon.png192, type: 'image/png', sizes: '192x192' },
    ]);
    expect(document.querySelectorAll('link[rel="apple-touch-icon"]')).toHaveLength(1);
    expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe(identity.assets.favicon.appleTouch180);
    expect(document.querySelector('link[href="/favicon.svg"]')).toBeNull();
    identity.assets.favicon = null;
    const removed = await about(locale);
    expect(removed.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
    expect(removed.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/favicon.svg');
    expect(removed.querySelector('link[rel="icon"]')?.getAttribute('type')).toBe('image/svg+xml');
    expect(removed.querySelector('link[rel="apple-touch-icon"]')).toBeNull();
  });
});
