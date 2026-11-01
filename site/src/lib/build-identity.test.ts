import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIdentitySnapshot } from './site-identity';

// Dynamic imports deliberately exercise module-load parsing after each env change;
// a static import would parse once before the test can supply its snapshot.
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('site build identity boundary', () => {
  it('uses the reserved non-resolving origin only when canonical origin is unset', async () => {
    vi.stubEnv('SITE_IDENTITY_JSON', undefined);
    vi.resetModules();
    const { identity, buildSiteOrigin } = await import('./build-identity');
    expect(identity.canonicalOrigin).toBeNull();
    expect(buildSiteOrigin()).toBe('https://unconfigured.invalid');
  });

  it('uses the captured canonical origin, not the image host or process request host', async () => {
    vi.stubEnv('SITE_IDENTITY_JSON', JSON.stringify({
      ...parseIdentitySnapshot(undefined), canonicalOrigin: 'https://journal.example:8443',
    }));
    vi.stubEnv('PUBLIC_BASE_URL', 'https://images.example');
    vi.resetModules();
    const { buildSiteOrigin } = await import('./build-identity');
    expect(buildSiteOrigin()).toBe('https://journal.example:8443');
  });

  it.each(['', '{', '{}', 'null'])('fails closed for a supplied malformed snapshot %j', async (snapshot) => {
    vi.stubEnv('SITE_IDENTITY_JSON', snapshot);
    vi.resetModules();
    await expect(import('./build-identity')).rejects.toThrow();
  });
});
