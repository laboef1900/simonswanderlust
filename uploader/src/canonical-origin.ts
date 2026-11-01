import { IdentityError, normalizeCanonicalOrigin } from '../../site/src/lib/site-identity.js';
import { commentAuthorityOrigin } from './comments-public.js';

export interface OriginRoles { baseUrl: string; imgHost: string }

/** Existing bootstrap settings only. IMG_HOST is independent of the public image URL. */
export function configuredOriginRoles(): OriginRoles {
  const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  let imgHost = process.env.IMG_HOST;
  if (imgHost === undefined) {
    try { imgHost = new URL(baseUrl).host; }
    catch { throw new IdentityError('canonicalOrigin'); }
  }
  return { baseUrl, imgHost };
}

function isLoopbackAuthority(authority: string): boolean {
  const host = new URL(`http://${authority}`).hostname;
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Save, capture and restore compare real deployment roles, never inferred blog topology. */
export function validateCanonicalRoles(value: unknown, roles: OriginRoles): string | null {
  const origin = normalizeCanonicalOrigin(value);
  let image: URL;
  try { image = new URL(roles.baseUrl); }
  catch { throw new IdentityError('canonicalOrigin'); }
  if (!['http:', 'https:'].includes(image.protocol) || image.username || image.password) throw new IdentityError('canonicalOrigin');
  const candidate = origin === null ? null : new URL(origin);
  const authorityOrigin = commentAuthorityOrigin(candidate?.protocol.slice(0, -1) ?? 'https', roles.imgHost);
  if (authorityOrigin === null) throw new IdentityError('canonicalOrigin');
  if (candidate === null) return null;
  if (origin === image.origin && !(isLoopbackAuthority(candidate.host) && isLoopbackAuthority(image.host))) throw new IdentityError('canonicalOrigin');
  const routing = new URL(authorityOrigin);
  if (!isLoopbackAuthority(routing.host) && candidate.host === routing.host) throw new IdentityError('canonicalOrigin');
  return origin;
}
