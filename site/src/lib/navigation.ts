import { isPageKind, type PageKind } from './page-kinds.js';
export type NavLocaleText = Partial<Record<'de' | 'en', string>>;
export type NavItem =
  | { kind: 'builtin'; target: 'home' | 'stories' | 'map' | 'regions'; label?: NavLocaleText }
  | { kind: 'page'; target: PageKind; label?: NavLocaleText }
  | { kind: 'path' | 'external'; href: NavLocaleText; label: NavLocaleText };
export const NAV_SLOTS = { header: 5, footer: 8, legal: 4 } as const;
export type NavSlot = keyof typeof NAV_SLOTS;
export interface Navigation { version: 1; header: NavItem[]; footer: NavItem[]; legal: NavItem[] }
export const DEFAULT_NAVIGATION: Navigation = {
  version: 1, header: [{ kind: 'builtin', target: 'stories' }, { kind: 'builtin', target: 'map' }, { kind: 'page', target: 'about' }],
  footer: [{ kind: 'page', target: 'about' }], legal: [],
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid navigation object');
  return value as Record<string, unknown>;
}
function texts(value: unknown, href?: 'path' | 'external'): NavLocaleText {
  const input = record(value); const result: NavLocaleText = {};
  for (const [locale, raw] of Object.entries(input)) {
    if ((locale !== 'de' && locale !== 'en') || typeof raw !== 'string') throw new Error('Invalid navigation translation');
    if (!href) {
      const label = raw.replace(/\p{C}/gu, '').trim();
      if (!label || [...label].length > 40) throw new Error('Navigation labels require 1–40 characters');
      result[locale] = label;
    } else if (href === 'external') {
      if (raw.length > 2048 || /[\s\x00-\x1f\x7f]/u.test(raw)) throw new Error('Invalid external navigation URL');
      const url = new URL(raw);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('External navigation requires HTTPS without credentials');
      result[locale] = url.href;
    } else {
      if (raw.length > 512 || /[\s\x00-\x1f\x7f]/u.test(raw) || !/^\/(?![/\\])[A-Za-z0-9\-._~/%?=&#]*$/.test(raw)
        || new URL(raw, 'https://h.invalid').origin !== 'https://h.invalid') throw new Error('Invalid relative navigation URL');
      result[locale] = raw;
    }
  }
  return result;
}
/** Shared save/restore/build boundary; callers surface errors without returning supplied data. */
export function validateNavigation(value: unknown): Navigation {
  const input = record(value);
  if (input.version !== 1 || Object.keys(input).some((key) => !['version', ...Object.keys(NAV_SLOTS)].includes(key))) throw new Error('Invalid navigation version or fields');
  const result: Navigation = { version: 1, header: [], footer: [], legal: [] };
  for (const slot of Object.keys(NAV_SLOTS) as NavSlot[]) {
    const items = input[slot];
    if (!Array.isArray(items) || items.length > NAV_SLOTS[slot]) throw new Error('Invalid navigation slot');
    result[slot] = items.map((value): NavItem => {
      const item = record(value);
      if (item.kind === 'builtin' || item.kind === 'page') {
        if (Object.keys(item).some((key) => !['kind', 'target', 'label'].includes(key))) throw new Error('Invalid navigation item fields');
        const label = item.label === undefined ? {} : { label: texts(item.label) };
        if (item.kind === 'page' && typeof item.target === 'string' && isPageKind(item.target)) return { kind: 'page', target: item.target, ...label };
        if (item.kind === 'builtin' && (item.target === 'home' || item.target === 'stories' || item.target === 'map' || item.target === 'regions')) return { kind: 'builtin', target: item.target, ...label };
      } else if (item.kind === 'external' || item.kind === 'path') {
        if (Object.keys(item).some((key) => !['kind', 'href', 'label'].includes(key))) throw new Error('Invalid navigation item fields');
        return { kind: item.kind, href: texts(item.href, item.kind), label: texts(item.label) };
      }
      throw new Error('Invalid navigation target');
    });
  }
  return result;
}
export interface PageNavReference { slot: NavSlot; index: number; label?: NavLocaleText }
export function pageNavReferences(config: Navigation, key: string): PageNavReference[] {
  return (Object.keys(NAV_SLOTS) as NavSlot[]).flatMap((slot) => config[slot].flatMap((item, index) =>
    item.kind === 'page' && item.target === key ? [{ slot, index, ...(item.label ? { label: item.label } : {}) }] : []));
}
export function withoutPageNavigation(config: Navigation, key: string): Navigation {
  return { version: 1, header: config.header.filter((item) => item.kind !== 'page' || item.target !== key),
    footer: config.footer.filter((item) => item.kind !== 'page' || item.target !== key), legal: config.legal.filter((item) => item.kind !== 'page' || item.target !== key) };
}
