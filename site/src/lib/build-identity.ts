import { ui } from '../i18n/ui.js';
import { parseIdentitySnapshot, type IdentityLocale } from './site-identity.js';

// Site-only boundary: server imports of the pure validator never read operator env.
export const identity = parseIdentitySnapshot(process.env.SITE_IDENTITY_JSON);
export function identitySiteName(locale: IdentityLocale): string {
  return identity.siteName || ui[locale]['site.titleFallback'];
}
export function identityTagline(locale: IdentityLocale): string {
  return identity.tagline[locale] || ui[locale]['site.taglineFallback'];
}
