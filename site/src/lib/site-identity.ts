export type IdentityLocale = 'de' | 'en';
export type IdentityLocaleMap = Partial<Record<IdentityLocale, string>>;
export interface Identity {
  siteName: string;
  authorName: string;
  canonicalOrigin: string | null;
  tagline: IdentityLocaleMap;
  aboutRole: IdentityLocaleMap;
  aboutGear: IdentityLocaleMap;
  studioDescriptor: IdentityLocaleMap;
  socialLinks: { label: string; url: string }[];
}
export interface IdentitySnapshot extends Omit<Identity, 'studioDescriptor'> {
  v: 1;
  locales: IdentityLocale[];
  assets: {
    logo: { path: string; width: number; height: number } | null;
    favicon: { png32: string; png192: string; appleTouch180: string } | null;
  };
}
export class IdentityError extends Error {
  readonly code = 'invalid_identity';
  constructor(readonly field: string) { super('Invalid site identity.'); }
}
export const IDENTITY_LOCALIZED_FIELDS = ['tagline', 'aboutRole', 'aboutGear', 'studioDescriptor'] as const;
const caps = { tagline: 160, aboutRole: 80, aboutGear: 200, studioDescriptor: 80 };
export function neutralIdentity(): Identity {
  return { siteName: '', authorName: '', canonicalOrigin: null, tagline: {}, aboutRole: {}, aboutGear: {}, studioDescriptor: {}, socialLinks: [] };
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IdentityError(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max: number, min = 0): string {
  if (typeof value !== 'string') throw new IdentityError(field);
  const normalized = value.normalize('NFC');
  if (/\p{C}/u.test(normalized)) throw new IdentityError(field);
  const result = normalized.trim();
  const length = [...result].length;
  if (length < min || length > max) throw new IdentityError(field);
  return result;
}
function localeMap(value: unknown, field: string, max: number): IdentityLocaleMap {
  const input = object(value, field);
  const result: IdentityLocaleMap = {};
  for (const key of Object.keys(input)) {
    if (key !== 'de' && key !== 'en') throw new IdentityError(field);
    result[key] = text(input[key], `${field}.${key}`, max);
  }
  return result;
}
function loopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}
function ipLiteral(host: string): boolean { return host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host); }
function socialUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\p{C}\s]/u.test(value)) throw new IdentityError(field);
  let url: URL;
  try { url = new URL(value); } catch { throw new IdentityError(field); }
  const hostname = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || ipLiteral(hostname) || loopback(hostname) || hostname.endsWith('.localhost') || url.href.length > 2048) throw new IdentityError(field);
  return url.href;
}
/** Reserved until #276: validate the stored origin shape, not deployment topology. */
function canonicalOrigin(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 300 || /[\p{C}\s]/u.test(value)) throw new IdentityError('canonicalOrigin');
  let url: URL;
  try { url = new URL(value); } catch { throw new IdentityError('canonicalOrigin'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) ||
      (ipLiteral(url.hostname) && !loopback(url.hostname)) || url.origin !== value || url.username || url.password) throw new IdentityError('canonicalOrigin');
  return value;
}
export function normalizeIdentity(input: unknown): Identity {
  const value = object(input, 'identity');
  const keys = Object.keys(neutralIdentity());
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new IdentityError('identity');
  if (!Array.isArray(value.socialLinks) || value.socialLinks.length > 6) throw new IdentityError('socialLinks');
  return {
    siteName: text(value.siteName, 'siteName', 80), authorName: text(value.authorName, 'authorName', 80),
    canonicalOrigin: canonicalOrigin(value.canonicalOrigin),
    tagline: localeMap(value.tagline, 'tagline', caps.tagline),
    aboutRole: localeMap(value.aboutRole, 'aboutRole', caps.aboutRole),
    aboutGear: localeMap(value.aboutGear, 'aboutGear', caps.aboutGear),
    studioDescriptor: localeMap(value.studioDescriptor, 'studioDescriptor', caps.studioDescriptor),
    socialLinks: value.socialLinks.map((entry: unknown, i: number) => {
      const link = object(entry, `socialLinks[${i}]`);
      if (Object.keys(link).some((key) => key !== 'label' && key !== 'url')) throw new IdentityError(`socialLinks[${i}]`);
      return { label: text(link.label, `socialLinks[${i}].label`, 40, 1), url: socialUrl(link.url, `socialLinks[${i}].url`) };
    }),
  };
}
export function toIdentitySnapshot(input: Identity, locales: IdentityLocale[] = ['de', 'en']): IdentitySnapshot {
  const { studioDescriptor: _adminOnly, ...value } = normalizeIdentity(input);
  if (!locales.length || new Set(locales).size !== locales.length || locales.some((locale) => locale !== 'de' && locale !== 'en')) throw new IdentityError('locales');
  for (const field of ['tagline', 'aboutRole', 'aboutGear'] as const) {
    value[field] = Object.fromEntries(locales.filter((locale) => value[field][locale] !== undefined).map((locale) => [locale, value[field][locale]]));
  }
  return { v: 1, locales: [...locales], ...value, assets: { logo: null, favicon: null } };
}
export function parseIdentitySnapshot(json: string | undefined): IdentitySnapshot {
  if (json === undefined) return toIdentitySnapshot(neutralIdentity());
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new IdentityError('snapshot'); }
  const value = object(parsed, 'snapshot');
  if (value.v !== 1 || !Array.isArray(value.locales)) throw new IdentityError('snapshot');
  const { v: _version, locales, assets, ...fields } = value;
  if ('studioDescriptor' in fields) throw new IdentityError('snapshot');
  const snapshot = toIdentitySnapshot(normalizeIdentity({ ...fields, studioDescriptor: {} }), locales as IdentityLocale[]);
  for (const field of ['tagline', 'aboutRole', 'aboutGear'] as const) {
    if (Object.keys(object(fields[field], field)).some((locale) => !locales.includes(locale))) throw new IdentityError(field);
  }
  const assetMap = object(assets, 'assets');
  if (Object.keys(assetMap).some((key) => key !== 'logo' && key !== 'favicon')) throw new IdentityError('assets');
  const assetPath = (path: unknown, role: string): string => {
    if (typeof path !== 'string' || !new RegExp(`^/_identity/${role}-[0-9a-f]{16}\\.png$`).test(path)) throw new IdentityError(`assets.${role}`);
    return path;
  };
  if (assetMap.logo !== null) {
    const logo = object(assetMap.logo, 'assets.logo');
    if (Object.keys(logo).some((key) => !['path', 'width', 'height'].includes(key)) ||
        typeof logo.width !== 'number' || !Number.isInteger(logo.width) || logo.width < 1 || logo.width > 960 ||
        typeof logo.height !== 'number' || !Number.isInteger(logo.height) || logo.height < 1 || logo.height > 240) throw new IdentityError('assets.logo');
    snapshot.assets.logo = { path: assetPath(logo.path, 'logo'), width: logo.width, height: logo.height };
  }
  if (assetMap.favicon !== null) {
    const favicon = object(assetMap.favicon, 'assets.favicon');
    if (Object.keys(favicon).some((key) => !['png32', 'png192', 'appleTouch180'].includes(key))) throw new IdentityError('assets.favicon');
    snapshot.assets.favicon = { png32: assetPath(favicon.png32, 'favicon-32'), png192: assetPath(favicon.png192, 'favicon-192'), appleTouch180: assetPath(favicon.appleTouch180, 'apple-touch-180') };
  }
  return snapshot;
}
