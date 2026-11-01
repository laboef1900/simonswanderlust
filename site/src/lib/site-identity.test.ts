import { describe, expect, it } from 'vitest';
import { IdentityError, neutralIdentity, normalizeIdentity, parseIdentitySnapshot, toIdentitySnapshot } from './site-identity.js';

describe('stored site identity', () => {
  it('normalizes NFC and trims ordinary whitespace without interpreting markup', () => {
    const value = normalizeIdentity({ ...neutralIdentity(), siteName: ' Cafe\u0301 ', authorName: '<img src=x onerror=alert(1)>', tagline: { en: ' Travel ' } });
    expect(value.siteName).toBe('Café');
    expect(value.authorName).toBe('<img src=x onerror=alert(1)>');
    expect(value.tagline).toEqual({ en: 'Travel' });
    expect(value.aboutGear).toEqual({});
  });
  it.each(['\u0000', '\t', '\n', '\r', '\u202e', '\u200b', '\ud800', '\ue000', '\u0378'])('rejects every Unicode control category before trimming (%j)', (control) => {
    for (const value of [control + 'Name', 'Name' + control, 'Na' + control + 'me']) {
      for (const field of ['siteName', 'authorName'] as const) {
        expect(() => normalizeIdentity({ ...neutralIdentity(), [field]: value })).toThrow(IdentityError);
      }
      for (const field of ['tagline', 'aboutRole', 'aboutGear', 'studioDescriptor'] as const) {
        expect(() => normalizeIdentity({ ...neutralIdentity(), [field]: { en: value } })).toThrow(IdentityError);
      }
      expect(() => normalizeIdentity({ ...neutralIdentity(), socialLinks: [{ label: value, url: 'https://example.com' }] })).toThrow(IdentityError);
    }
  });
  it.each([['siteName', 80], ['authorName', 80]] as const)('enforces the %s codepoint limit', (field, max) => {
    expect(normalizeIdentity({ ...neutralIdentity(), [field]: '🚲'.repeat(max) })[field]).toHaveLength(max * 2);
    expect(() => normalizeIdentity({ ...neutralIdentity(), [field]: '🚲'.repeat(max + 1) })).toThrow(IdentityError);
    expect(() => normalizeIdentity({ ...neutralIdentity(), [field]: 1 })).toThrow(IdentityError);
  });
  it.each([['tagline', 160], ['aboutRole', 80], ['aboutGear', 200], ['studioDescriptor', 80]] as const)('validates every retained locale of %s without manufacturing missing locales', (field, max) => {
    expect(normalizeIdentity({ ...neutralIdentity(), [field]: { en: 'x'.repeat(max) } })[field]).toEqual({ en: 'x'.repeat(max) });
    for (const map of [null, [], 'text', { fr: 'text' }, { de: 9 }, { en: 'x'.repeat(max + 1) }]) {
      expect(() => normalizeIdentity({ ...neutralIdentity(), [field]: map })).toThrow(IdentityError);
    }
  });
  it.each(['javascript:alert(1)', 'data:text/html,hello', 'vbscript:msgbox(1)', '//example.com', 'http://example.com', 'mailto:a@example.com', 'https://u:p@example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost.', 'https://sub.localhost', 'https://example.com/a b', 'https://exam\u0000ple.com', 'https://example.com/' + 'a'.repeat(2048)])('rejects unsafe social destination %s', (url) => {
    expect(() => normalizeIdentity({ ...neutralIdentity(), socialLinks: [{ label: 'Profile', url }] })).toThrow(IdentityError);
  });
  it('normalizes social URLs and keeps ordered labels as plain text', () => {
    const links = normalizeIdentity({ ...neutralIdentity(), socialLinks: [{ label: ' <b>Profile</b> ', url: 'https://BÜCHER.example:443/profile' }, { label: 'Other', url: 'https://example.com' }] }).socialLinks;
    expect(links).toEqual([{ label: '<b>Profile</b>', url: 'https://xn--bcher-kva.example/profile' }, { label: 'Other', url: 'https://example.com/' }]);
    for (const label of ['', 'x'.repeat(41), 42]) expect(() => normalizeIdentity({ ...neutralIdentity(), socialLinks: [{ label, url: 'https://example.com' }] })).toThrow(IdentityError);
    expect(() => normalizeIdentity({ ...neutralIdentity(), socialLinks: Array.from({ length: 7 }, () => links[0]) })).toThrow(IdentityError);
  });
  it('does not echo unknown attacker-controlled field names in validation errors', () => {
    try { normalizeIdentity({ ...neutralIdentity(), '<secret-input>': 'private' }); } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_identity', field: 'identity', message: 'Invalid site identity.' });
    }
  });
});

describe('build identity snapshot', () => {
  it('defaults only an absent environment value; malformed and unknown-version values fail closed', () => {
    expect(parseIdentitySnapshot(undefined)).toEqual(toIdentitySnapshot(neutralIdentity()));
    for (const value of ['', 'null', '{', '{}', JSON.stringify({ ...toIdentitySnapshot(neutralIdentity()), v: 2 })]) expect(() => parseIdentitySnapshot(value)).toThrow(IdentityError);
  });
  it.each(['de', 'en'] as const)('projects %s without leaking inactive text or admin descriptors', (locale) => {
    const source = { ...neutralIdentity(), tagline: { de: 'DE private', en: 'EN private' }, studioDescriptor: { de: 'Admin private' } };
    const snapshot = toIdentitySnapshot(source, [locale]);
    expect(snapshot.tagline).toEqual({ [locale]: source.tagline[locale] });
    expect(snapshot).not.toHaveProperty('studioDescriptor');
    expect(parseIdentitySnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(toIdentitySnapshot({ ...source, tagline: {} }, [locale]).tagline).toEqual({});
    expect(() => parseIdentitySnapshot(JSON.stringify({ ...snapshot, tagline: source.tagline }))).toThrow(IdentityError);
    expect(() => parseIdentitySnapshot(JSON.stringify({ ...snapshot, studioDescriptor: source.studioDescriptor }))).toThrow(IdentityError);
  });
  it('validates locale membership and canonical-origin shape', () => {
    for (const locales of [[], ['fr'], ['de', 'de']]) expect(() => parseIdentitySnapshot(JSON.stringify({ ...toIdentitySnapshot(neutralIdentity()), locales }))).toThrow(IdentityError);
    for (const canonicalOrigin of ['http://public.example', 'https://1.2.3.4', 'https://example.com/path', 'https://u:p@example.com']) expect(() => normalizeIdentity({ ...neutralIdentity(), canonicalOrigin })).toThrow(IdentityError);
    expect(normalizeIdentity({ ...neutralIdentity(), canonicalOrigin: 'http://localhost:3000' }).canonicalOrigin).toBe('http://localhost:3000');
  });
  it.each([
    ['https://EXAMPLE.com:443/', 'https://example.com'],
    ['https://BÜCHER.example/', 'https://xn--bcher-kva.example'],
    ['https://example.com:8443/', 'https://example.com:8443'],
  ])('normalizes %s consistently through stored identity and build snapshots', (input, expected) => {
    const stored = normalizeIdentity({ ...neutralIdentity(), canonicalOrigin: input });
    expect(stored.canonicalOrigin).toBe(expected);
    const snapshot = { ...toIdentitySnapshot(neutralIdentity()), canonicalOrigin: input };
    expect(parseIdentitySnapshot(JSON.stringify(snapshot)).canonicalOrigin).toBe(expected);
  });
  it('accepts captured hash-named asset paths and rejects incomplete or traversing assets', () => {
    const snapshot = toIdentitySnapshot(neutralIdentity());
    const logo = { path: '/_identity/logo-0123456789abcdef.png', width: 960, height: 240 };
    expect(parseIdentitySnapshot(JSON.stringify({ ...snapshot, assets: { logo, favicon: null } })).assets.logo).toEqual(logo);
    for (const assets of [{ logo: { ...logo, path: '/_identity/../x.png' }, favicon: null }, { logo: { ...logo, width: 961 }, favicon: null }, { logo: null, favicon: { png32: '/_identity/favicon-32-0123456789abcdef.png' } }, {}]) expect(() => parseIdentitySnapshot(JSON.stringify({ ...snapshot, assets }))).toThrow(IdentityError);
  });
});
