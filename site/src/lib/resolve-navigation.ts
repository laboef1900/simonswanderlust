import { useTranslations, type Locale } from '../i18n/ui.js';
import { validateNavigation, NAV_SLOTS, type NavSlot } from './navigation.js';
import { emittedPaths, normalizePublicPath, type PublicRoute } from './public-routes.js';
import type { SiteLanguage } from './site-language.js';

export interface ResolvedNavItem { href: string; label: string; external: boolean; current: boolean }
export type ResolvedNavigation = Record<NavSlot, ResolvedNavItem[]>;

/** Resolve against emitted resources, never database existence or a pair's status. */
export function resolveNavigation(value: unknown, routes: PublicRoute[], language: SiteLanguage, locale: Locale, pathname: string,
  warn: (message: string) => void = console.warn): ResolvedNavigation {
  const config = validateNavigation(value);
  const result: ResolvedNavigation = { header: [], footer: [], legal: [] };
  if (!language.locales.includes(locale)) return result;
  const t = useTranslations(locale);
  const paths = emittedPaths(routes, language);
  for (const slot of Object.keys(NAV_SLOTS) as NavSlot[]) {
    for (const item of config[slot]) {
      let href: string | undefined;
      let label = item.label?.[locale];
      if (item.kind === 'builtin') {
        const kind = item.target === 'stories' ? 'home' : item.target;
        const route = routes.find((route) => route.locale === locale && route.kind === kind);
        href = route ? route.path + (item.target === 'stories' ? '#stories' : '') : undefined;
        label ??= t(`nav.${item.target}`);
      } else if (item.kind === 'page') {
        const route = routes.find((route) => route.locale === locale && (route.kind === 'about' ? item.target === 'about'
          : route.kind === 'page' && route.page.data.key === item.target));
        href = route?.path;
        label ??= t(`nav.${item.target}`);
      } else {
        href = item.href[locale];
        if (href && item.kind === 'path' && !paths.has(normalizePublicPath(href))) {
          warn(`Navigation ${slot}/${locale}: relative target is not emitted`);
          continue;
        }
      }
      if (!href || !label) continue;
      result[slot].push({ href, label, external: item.kind === 'external',
        current: (item.kind === 'builtin' || item.kind === 'page') && normalizePublicPath(href) === normalizePublicPath(pathname) });
    }
  }
  return result;
}
