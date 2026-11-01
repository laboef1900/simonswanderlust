import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChildBuild } from '../src/build.js';
import { neutralIdentity, toIdentitySnapshot } from '../../site/src/lib/site-identity.js';

afterEach(() => vi.unstubAllEnvs());
describe('builder-owned configuration environment', () => {
  it('overrides inherited identity, language and database snapshot with captured values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'identity-child-'));
    try {
      vi.stubEnv('SITE_IDENTITY_JSON', 'operator-invalid-json');
      vi.stubEnv('SITE_DATABASE_SNAPSHOT', 'operator-invalid-snapshot');
      vi.stubEnv('SITE_LANGUAGE_JSON', 'operator-invalid-language');
      const identity = toIdentitySnapshot({ ...neutralIdentity(), siteName: 'Captured journal' });
      const language = { primary: 'en', locales: ['en', 'de'] } as const;
      const databaseSnapshot = '00000003-0000000A-1';
      await runChildBuild(process.execPath, ['-e', "require('node:fs').writeFileSync('env.json',JSON.stringify({identity:JSON.parse(process.env.SITE_IDENTITY_JSON),language:JSON.parse(process.env.SITE_LANGUAGE_JSON),database:process.env.SITE_DATABASE_SNAPSHOT}))"], root, 5000, undefined, {
        snapshot: { identity, language: { ...language, locales: [...language.locales] }, databaseSnapshot, assets: [], signal: new AbortController().signal },
      });
      expect(JSON.parse(await readFile(join(root, 'env.json'), 'utf8'))).toEqual({ identity, language, database: databaseSnapshot });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('never inherits an operator snapshot even for a standalone child test', async () => {
    const root = await mkdtemp(join(tmpdir(), 'identity-child-'));
    try {
      vi.stubEnv('SITE_IDENTITY_JSON', 'invalid');
      vi.stubEnv('SITE_DATABASE_SNAPSHOT', '');
      vi.stubEnv('SITE_LANGUAGE_JSON', '{"primary":"en","locales":["en"]}');
      await runChildBuild(process.execPath, ['-e', "require('node:fs').writeFileSync('env.json',JSON.stringify({identity:JSON.parse(process.env.SITE_IDENTITY_JSON),language:JSON.parse(process.env.SITE_LANGUAGE_JSON),database:process.env.SITE_DATABASE_SNAPSHOT}))"], root, 5000);
      const result = JSON.parse(await readFile(join(root, 'env.json'), 'utf8'));
      expect(result.identity.siteName).toBe('');
      expect(result.language).toEqual({ primary: 'de', locales: ['de', 'en'] });
      expect(result).not.toHaveProperty('database');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
