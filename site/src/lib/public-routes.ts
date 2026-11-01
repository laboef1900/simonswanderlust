import type { Locale } from '../i18n/ui.js';
import { aboutPath, homePath, mapPath, regionPath, regionsIndexPath, rssPath, type Region } from './paths.js';
import { byLocale, liveRegions, pathOf, type Trip } from './trips.js';
import { siteLanguage, type SiteLanguage } from './site-language.js';
import { namespaceOf, reservation } from './reserved-routes.js';
import { pageDataSchema, type PublicPage } from './page-content.js';
import type { PageKind } from './page-kinds.js';

export type PublicRoute =
  | { path: string; kind: 'home' | 'about' | 'map' | 'regions'; locale: Locale }
  | { path: string; kind: 'region'; locale: Locale; region: Region }
  | { path: string; kind: 'story'; locale: Locale; trip: Trip }
  | { path: string; kind: 'page'; locale: Locale; page: PublicPage };

/** One inventory for static HTML generation; absent translations never receive routes. */
export function publicRoutes(trips: Trip[], language: SiteLanguage = siteLanguage(), pages: PublicPage[] = [], warn: (message: string) => void = console.warn): PublicRoute[] {
  const routes: PublicRoute[] = [];
  for (const locale of language.locales) {
    routes.push(
      { path: homePath(locale, language), kind: 'home', locale },
      { path: aboutPath(locale, language), kind: 'about', locale },
      { path: mapPath(locale, language), kind: 'map', locale },
      { path: regionsIndexPath(locale, language), kind: 'regions', locale },
    );
    for (const region of liveRegions(trips, locale, undefined, language)) {
      routes.push({ path: regionPath(region, locale, language), kind: 'region', locale, region });
    }
    for (const trip of byLocale(trips, locale, language)) {
      routes.push({ path: pathOf(trip, language), kind: 'story', locale, trip });
    }
  }
  for (const page of pages) {
    if (!language.locales.includes(page.data.locale)) continue;
    const data = pageDataSchema.parse(page.data);
    // About's database content belongs to the fixed resource already registered above.
    if (data.key === 'about') continue;
    routes.push({ path: `${homePath(data.locale, language)}${data.slug}/`, kind: 'page', locale: data.locale, page });
  }
  assertPublicRoutes(routes, language, warn);
  return routes;
}

export function routeOwner(route: PublicRoute): string {
  if (route.kind === 'about') return `page:about:${route.locale}`;
  if (route.kind === 'page') return `page:${route.page.data.key}:${route.locale}`;
  if (route.kind === 'story') return `story:${route.trip.data.translationKey}:${route.locale}`;
  if (route.kind === 'region') return `region:${route.region}:${route.locale}`;
  return `site:${route.kind}:${route.locale}`;
}

/** Deterministic regardless of query/creation order. Never let Astro choose a losing resource. */
export function assertPublicRoutes(routes: PublicRoute[], language: SiteLanguage, warn: (message: string) => void = console.warn): void {
  const owners = new Map<string, string>();
  const sorted = [...routes].sort((a, b) => a.path.localeCompare(b.path) || routeOwner(a).localeCompare(routeOwner(b)));
  for (const route of sorted) {
    const path = normalizePublicPath(route.path);
    const owner = routeOwner(route);
    const previous = owners.get(path);
    if (previous && previous !== owner) throw new Error(`Conflicting public routes at ${path}: ${previous} and ${owner}`);
    owners.set(path, owner);
  }
  for (const route of sorted) {
    if (route.kind !== 'page' && route.kind !== 'story') continue;
    const slug = route.kind === 'page' ? route.page.data.slug : route.trip.id.slice(route.locale.length + 1);
    const reserved = reservation(namespaceOf(route.locale, language), slug, language);
    if (!reserved) continue;
    const message = `Conflicting public routes at ${route.path}: ${routeOwner(route)} and ${reserved.owner}:${reserved.segment}`;
    if (route.kind === 'page' || reserved.owner === 'site' || reserved.owner === 'locale') throw new Error(message);
    warn(message); // Unchanged grandfathered app/legacy stories must not block unrelated publication.
  }
}

export function normalizePublicPath(path: string): string {
  const pathname = new URL(path, 'https://h.invalid').pathname;
  return pathname === '/' || pathname.endsWith('/') || /\.[^/]+$/.test(pathname) ? pathname : `${pathname}/`;
}

/** Paths emitted outside the HTML dispatcher still qualify as manual navigation targets. */
export function emittedPaths(routes: PublicRoute[], language: SiteLanguage): Set<string> {
  return new Set([...routes.map((route) => normalizePublicPath(route.path)),
    ...language.locales.map((locale) => rssPath(locale, language)), '/404.html', '/sitemap-index.xml', '/sitemap-0.xml']);
}

export function pageAlternates(routes: PublicRoute[], key: PageKind): Record<Locale, string> | undefined {
  const de = routes.find((route) => route.locale === 'de' && (route.kind === 'about' ? key === 'about' : route.kind === 'page' && route.page.data.key === key));
  const en = routes.find((route) => route.locale === 'en' && (route.kind === 'about' ? key === 'about' : route.kind === 'page' && route.page.data.key === key));
  return de && en ? { de: de.path, en: en.path } : undefined;
}
