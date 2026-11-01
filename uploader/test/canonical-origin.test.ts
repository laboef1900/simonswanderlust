import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredOriginRoles, validateCanonicalRoles } from '../src/canonical-origin.js';
import { normalizeCanonicalOrigin, neutralIdentity, parseIdentitySnapshot, toIdentitySnapshot } from '../../site/src/lib/site-identity.js';

const roles = { baseUrl: 'https://cdn.example/images/', imgHost: 'images.example:443' };
afterEach(() => vi.unstubAllEnvs());

describe('canonical public origin', () => {
  it.each([
    ['https://EXAMPLE.com:443/', 'https://example.com'],
    ['  https://EXAMPLE.com/  ', 'https://example.com'],
    ['https://bücher.example/', 'https://xn--bcher-kva.example'],
    ['https://blog.example:8443', 'https://blog.example:8443'],
    ['http://localhost:3000/', 'http://localhost:3000'],
    ['http://127.1:3000', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000/', 'http://[::1]:3000'],
  ])('normalizes %s without guessing deployment roles', (input, expected) => {
    expect(normalizeCanonicalOrigin(input)).toBe(expected);
    const snapshot = toIdentitySnapshot({ ...neutralIdentity(), canonicalOrigin: input });
    expect(parseIdentitySnapshot(JSON.stringify(snapshot)).canonicalOrigin).toBe(expected);
  });
  it.each([
    '', 'https://user@example.com', 'https://user:pass@example.com', 'https://@example.com',
    'https://example.com/blog', 'https://example.com/?q=x', 'https://example.com/#part',
    'https://example.com?', 'https://example.com#', 'https://example.com\\@evil.test',
    'https:///example.com', 'https:example.com', '//example.com', 'http://example.com',
    'https://192.168.1.1', 'https://[2001:db8::1]', 'http://evil.localhost',
    'https://example.com\n', '\thttps://example.com', 'https://exa\u200bmple.com',
  ])('refuses invalid canonical %j', (value) => {
    expect(() => normalizeCanonicalOrigin(value)).toThrowError('Invalid site identity.');
  });
  it('allows unset and distinguishes equality from prefixes, suffixes and ports', () => {
    expect(validateCanonicalRoles(null, roles)).toBeNull();
    for (const candidate of ['https://cdn.example.evil.test', 'https://other.images.example', 'https://images.example:8443']) {
      expect(validateCanonicalRoles(candidate, roles)).toBe(candidate);
    }
    expect(() => validateCanonicalRoles('https://cdn.example', roles)).toThrow();
    expect(() => validateCanonicalRoles('https://IMAGES.example:443/', roles)).toThrow();
    // The routing authority is independent of the public image URL and its scheme.
    expect(() => validateCanonicalRoles('https://images.example', { baseUrl: 'http://cdn.example:8080', imgHost: 'IMAGES.example:443' })).toThrow();
  });
  it.each(['images.example/path', 'user@images.example', 'https://images.example', 'images.example?x', 'images.example#x', 'images.example:bad', 'images.example\\evil', ''])('fails closed on invalid IMG_HOST %j', (imgHost) => {
    expect(() => validateCanonicalRoles('https://blog.example', { ...roles, imgHost })).toThrow();
    expect(() => validateCanonicalRoles(null, { ...roles, imgHost })).toThrow();
  });
  it.each(['localhost:3000', '127.0.0.2:3000', '[::1]:3000'])('retains local combined-host exception for %s', (authority) => {
    const baseUrl = `http://${authority}`;
    expect(validateCanonicalRoles(baseUrl, { baseUrl, imgHost: authority })).toBe(baseUrl);
  });
  it('reads only existing image bootstrap settings and never infers an explicit IMG_HOST', () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://cdn.example');
    vi.stubEnv('IMG_HOST', 'serving-images.example:8443');
    expect(configuredOriginRoles()).toEqual({ baseUrl: 'https://cdn.example', imgHost: 'serving-images.example:8443' });
    vi.stubEnv('IMG_HOST', undefined);
    expect(configuredOriginRoles().imgHost).toBe('cdn.example');
    vi.stubEnv('PUBLIC_BASE_URL', undefined);
    expect(configuredOriginRoles()).toEqual({ baseUrl: 'http://localhost:3000', imgHost: 'localhost:3000' });
  });
});
