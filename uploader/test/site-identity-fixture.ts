import { neutralIdentity, type Identity } from '../../site/src/lib/site-identity.js';

/** A complete stored row, including metadata absent from the public projection. */
export function identityDumpRow(identity: Identity = neutralIdentity()): Record<string, unknown> {
  return {
    id: true, revision: 1, seed_source: 'neutral', saved_at: null,
    updated_at: '2026-10-27T12:00:00.000Z', site_name: identity.siteName,
    author_name: identity.authorName, canonical_origin: identity.canonicalOrigin,
    localized: { tagline: identity.tagline, aboutRole: identity.aboutRole,
      aboutGear: identity.aboutGear, studioDescriptor: identity.studioDescriptor },
    social_links: identity.socialLinks,
  };
}
