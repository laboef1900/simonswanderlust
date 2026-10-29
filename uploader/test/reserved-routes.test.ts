import { TEST_TRUST } from './trusted-proxy-fixture.js';
import { idleBuildState } from './build-fixture.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_SEGMENTS, RESERVED, namespaceOf, reservation } from '../../site/src/lib/reserved-routes.js';
import { buildServer } from '../src/server.js';
import { memoryPostStore } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryMediaStore } from '../src/media-store.js';
import { memorySecretsStore } from '../src/secrets.js';
import { defaultSettings, validate } from '../src/settings.js';
import { createGpxFiles } from '../src/gpx-files.js';
import type { GpxService } from '../src/gpx-service.js';
import type { LanguageConfig } from '../src/language.js';
import { LEGACY_REDIRECTS } from '../src/redirects.js';
import { isSafeSlug } from '../src/posts.js';

const modes: LanguageConfig[] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];

describe('reserved public namespaces', () => {
  it('reserves exactly the legacy source namespaces and excludes format-only asset routes', () => {
    for (const namespace of ['root', 'de', 'en'] as const) {
      const segments = new Set(LEGACY_REDIRECTS.flatMap(([path]) => {
        const parts = path.split('/').filter(Boolean);
        const prefix = parts[0] === 'en' || parts[0] === 'de' ? parts.shift() : 'root';
        return prefix === namespace ? [parts[0]!] : [];
      }));
      expect([...segments].sort()).toEqual(RESERVED[namespace].filter((entry) => entry.owner === 'legacy').map((entry) => entry.segment).sort());
    }
    for (const asset of ['_astro', 'rss.xml', 'robots.txt', 'favicon.svg', 'sitemap-index.xml', 'sitemap-0.xml', '404.html']) expect(isSafeSlug(asset)).toBe(false);
  });
  it('reserves exactly the actual registered Fastify top-level app segments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reserved-routes-'));
    const posts = memoryPostStore();
    const seen = new Set<string>();
    const unexpectedServiceCall = async (): Promise<never> => { throw new Error('Route registration must not call GPX services'); };
    const gpx: GpxService = {
      files: createGpxFiles({ storageDir: join(root, 'images') }),
      get: unexpectedServiceCall, original: unexpectedServiceCall, importBytes: unexpectedServiceCall,
      importUpload: unexpectedServiceCall, reimport: unexpectedServiceCall, cancel: unexpectedServiceCall,
      attach: unexpectedServiceCall, detach: unexpectedServiceCall, reconcile: unexpectedServiceCall,
      orphanCleanup: () => { throw new Error('Route registration must not query GPX cleanup'); },
      close: unexpectedServiceCall,
    };
    let settings = defaultSettings();
    await Promise.all(['images', 'map', 'site/current'].map(path => mkdir(join(root, path), { recursive: true })));
    const app = buildServer({
      trustProxy: TEST_TRUST,
      storageDir: join(root, 'images'), siteDir: join(root, 'site'), mapDir: join(root, 'map'),
      baseUrl: 'https://images.example', imgHost: 'images.example', backupDir: join(root, 'backup'),
      users: memoryUserStore(), sessions: memorySessionStore(), posts, pages: memoryPageStore(posts.language),
      media: memoryMediaStore({ baseUrl: 'https://images.example' }), secrets: memorySecretsStore(), gpx,
      settings: { get: () => settings, update: patch => { settings = validate({ ...settings, ...patch }); return settings; } },
      builder: { ...idleBuildState, build: async () => ({ ok: true, attemptId: 'unused', release: 'unused' }), hasRelease: () => false, quiesce: async () => {} },
      dbCheck: async () => {},
      dbBackup: {
        dir: join(root, 'backup'), runNow: async () => ({}), running: () => false, state: () => ({}),
        sweepTempFiles: () => [], list: () => [], listImageArchives: () => [], listRouteArchives: () => [], quiesce: async () => {},
      },
      encodeQueue: {
        withAdmission: unexpectedServiceCall, availableCapacity: () => 0, onCapacity: () => () => {},
        enqueue: () => {}, isActive: () => false, recover: async () => 0, drain: async () => {},
        quiesce: async () => {}, idle: async () => {}, stats: () => ({ pending: 0, running: 0 }),
      },
      onRoute(route) {
        // Root wildcard static mounts serve content, not a fixed app namespace.
        const segment = route.url.split('/')[1];
        if (segment && segment !== '*' && !segment.startsWith(':')) seen.add(segment);
      },
    });
    try {
      await app.ready();
      expect([...seen].sort()).toEqual([...APP_SEGMENTS].sort());
      expect(seen.has('gpx')).toBe(true);
      expect(seen.has('map')).toBe(true);
      expect(seen.has('onboarding')).toBe(true);
      expect(seen.has('journey-admin')).toBe(true);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const mode of modes) {
    it(`${mode.primary}-primary ${mode.locales.join('+')} protects root without over-reserving prefixed stories`, () => {
      expect(namespaceOf(mode.primary, mode)).toBe('root');
      const secondary = mode.primary === 'de' ? 'en' : 'de';
      expect(namespaceOf(secondary, mode)).toBe(secondary);
      for (const segment of APP_SEGMENTS) {
        expect(reservation('root', segment, mode)).toMatchObject({ segment, owner: 'app' });
        for (const namespace of ['de', 'en'] as const) {
          const fixed = RESERVED[namespace].find(entry => entry.segment === segment);
          expect(reservation(namespace, segment, mode)).toEqual(fixed ?? null);
        }
      }
      for (const segment of ['de', 'en']) {
        expect(reservation('root', segment, mode)).toEqual({ segment, owner: 'locale' });
        expect(reservation(secondary, segment, mode)).toBeNull();
      }
      const fixed = mode.primary === 'de' ? ['uber-mich', 'karte', 'reiseziele'] : ['about-me', 'travel-map', 'destinations'];
      for (const segment of fixed) expect(reservation('root', segment, mode)).toMatchObject({ segment, owner: 'site' });
      const other = mode.primary === 'de' ? ['about-me', 'travel-map', 'destinations'] : ['uber-mich', 'karte', 'reiseziele'];
      for (const segment of other) expect(reservation('root', segment, mode)).toBeNull();
      expect(reservation('root', '404', mode)).toMatchObject({ owner: 'site' });
      expect(reservation('root', 'ordinary-story', mode)).toBeNull();
      expect(reservation('en', 'map', mode)).toMatchObject({ owner: 'site' });
      expect(reservation('en', 'travel-map', mode)).toBeNull();
      expect(reservation('de', 'map', mode)).toBeNull();
      expect(reservation('de', 'uber-mich', mode)).toMatchObject({ pageKind: 'about' });
      expect(reservation('en', 'about-me', mode)).toMatchObject({ pageKind: 'about' });
    });
  }
});
