import { idleBuildState } from './build-fixture.js';
import { TEST_TRUST } from './trusted-proxy-fixture.js';
import { unallowedBranding } from './branding-allowlist.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbBackup } from '../src/backup.js';
import { buildServer } from '../src/server.js';
import { createImportRunner, memoryImportJobStore } from '../src/import-jobs.js';
import { defaultSettings, validate } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPostStore } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryMediaStore } from '../src/media-store.js';
import { BacklogFullError, type EncodeQueue } from '../src/encode-queue.js';
import { memorySecretsStore } from '../src/secrets.js';

// #272 Done criterion: a fresh install's admin chrome carries no owner
// branding beyond the #291 software notices allow-listed in
// docs/site-identity-branding-allowlist.json. Served, not read from disk, so
// the generated copy scripts (ui.ts + the neutral identity) are included.
// vendor/ and fonts/ are third-party npm copies; legal/ holds the generated
// #291 license/notice texts — all gitignored build products outside this scan.
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const GENERATED = ['/admin/editor-image-copy.js', '/admin/waypoint-copy.js', '/admin/gpx-copy.js'];

async function servedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(publicRoot, path);
    if (entry.isDirectory()) { if (!/^(vendor|fonts|legal)$/.test(rel)) out.push(...await servedFiles(path)); }
    else if (/\.(html|m?js|css)$/.test(entry.name)) out.push('/admin/' + rel.split('\\').join('/'));
  }
  return out;
}

const queue: EncodeQueue = {
  withAdmission: (_key, operation) => operation(), availableCapacity: () => 0, onCapacity: () => () => {},
  enqueue: () => { throw new BacklogFullError(); }, isActive: () => false, recover: async () => 0,
  drain: async () => {}, quiesce: async () => {}, idle: async () => {}, stats: () => ({ pending: 0, running: 0 }),
};
const backup: DbBackup = {
  dir: '/tmp/none', runNow: async () => ({}), running: () => false, sweepTempFiles: () => [], list: () => [],
  listImageArchives: () => [], listRouteArchives: () => [], quiesce: async () => {}, state: () => ({}),
};

describe('fresh-install admin branding scan (#272)', () => {
  it('serves no un-allow-listed owner branding in any admin page, script or stylesheet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'branding-scan-'));
    let settings = defaultSettings();
    const posts = memoryPostStore();
    // No identityStore: the copy scripts project the neutral fresh-install identity.
    const app = buildServer({
      trustProxy: TEST_TRUST, storageDir: dir, baseUrl: 'https://images.example', imgHost: 'images.example',
      users: memoryUserStore(), sessions: memorySessionStore(), secrets: memorySecretsStore(),
      settings: { get: () => settings, update: (patch) => { settings = validate({ ...settings, ...patch }); return settings; } },
      posts, pages: memoryPageStore(), media: memoryMediaStore({ baseUrl: 'https://images.example' }), encodeQueue: queue,
      importJobs: createImportRunner({ store: memoryImportJobStore(), log: () => {} }), siteDir: join(dir, 'site'),
      builder: { ...idleBuildState, build: async () => ({ ok: true, attemptId: 'r', release: 'r' }), hasRelease: () => true, quiesce: async () => {} },
      backupDir: join(dir, 'backup'), dbBackup: backup, dbCheck: async () => {},
    });
    try {
      const paths = [...await servedFiles(publicRoot), ...GENERATED];
      expect(paths.filter((path) => path.endsWith('.html')).length).toBeGreaterThan(5);
      const found = [];
      for (const url of paths) {
        const response = await app.inject({ url });
        expect(response.statusCode, url).toBe(200);
        found.push(...unallowedBranding('admin', url, response.body));
      }
      expect(found).toEqual([]);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
