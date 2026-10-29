import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DUMP_VERSION, pageRecoverySummary, readDump, type Dump } from '../src/backup.js';
import { DEFAULT_NAVIGATION, type Navigation } from '../../site/src/lib/navigation.js';
import { identityDumpRow } from './site-identity-fixture.js';
const stamp = '2026-10-29T12:00:00.000Z';
function fixture(): Dump {
  return { version: DUMP_VERSION, createdAt: stamp, tables: { users: [], posts: [], post_routes: [],
    site_identity: [identityDumpRow()], site_identity_assets: [],
    site_language: [{ id: true, primary_locale: 'de', enabled_locales: ['de', 'en'], locked_at: null, updated_at: stamp }],
    pages: (['de', 'en'] as const).map((locale) => ({ key: 'contact', locale, title: 'Contact', body_markdown: 'Details', images: {}, slug: locale + '-contact', status: 'published', published_at: stamp, updated_at: stamp })),
    site_nav: [{ id: 1, config: { ...structuredClone(DEFAULT_NAVIGATION), footer: [{ kind: 'page', target: 'contact' }] }, updated_at: stamp }],
  } };
}
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pages-backup-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function file(dump: Dump) { const path = join(dir, 'db.json.gz'); await writeFile(path, gzipSync(JSON.stringify(dump))); return path; }

describe('page/navigation recovery contract', () => {
  it('retains a complete new-format page/nav document and flags unresolved locale targets', async () => {
    const dump = fixture(); expect(readDump(await file(dump))).toEqual(dump);
    expect(pageRecoverySummary(dump)).toEqual({ unresolvedNavigation: 0, collisions: [] });
    dump.tables.pages![1]!.body_markdown = '';
    expect(pageRecoverySummary(dump).unresolvedNavigation).toBe(1);
  });
  it.each(['missing-nav', 'bad-nav-url', 'missing-slug', 'missing-status', 'missing-history', 'lost-active-history', 'duplicate-slug', 'unequal-status', 'unknown-locale'])('rejects corrupt %s rather than resetting it to defaults', async (fault) => {
    const dump = fixture(); const row = dump.tables.pages![0]!;
    if (fault === 'missing-nav') delete dump.tables.site_nav;
    if (fault === 'bad-nav-url') dump.tables.site_nav![0]!.config = { version: 1, header: [], footer: [], legal: [{ kind: 'external', href: { de: 'javascript:alert(1)' }, label: { de: 'Visit' } }] };
    if (fault === 'missing-slug') delete row.slug;
    if (fault === 'missing-status') delete row.status;
    if (fault === 'missing-history') delete row.published_at;
    if (fault === 'lost-active-history') row.published_at = null;
    if (fault === 'duplicate-slug') dump.tables.pages!.push({ ...row, key: 'privacy' });
    if (fault === 'unequal-status') row.status = 'draft';
    if (fault === 'unknown-locale') row.locale = 'fr';
    const path = await file(dump); expect(() => readDump(path)).toThrow();
  });
  it('warns about reserved and retained story claims without mutating restored data', () => {
    const dump = fixture(); dump.tables.pages![0]!.slug = 'settings';
    dump.tables.posts.push({ locale: 'en', slug: 'working', published_snapshot: { slug: 'en-contact' } });
    const before = structuredClone(dump); const summary = pageRecoverySummary(dump);
    expect(summary.collisions).toEqual(['de/settings (page contact and app:settings)', 'en/en-contact (page contact and story)']);
    expect(dump).toEqual(before);
  });
  it('counts live navigation retained by legacy restores against the actual surviving pages', () => {
    const dump = fixture(); const navigation: Navigation = { version: 1, header: [], footer: [{ kind: 'page', target: 'contact' }], legal: [] };
    const retained = { navigation, pages: structuredClone(dump.tables.pages!) };
    dump.version = 1; delete dump.tables.pages; delete dump.tables.site_nav;
    expect(pageRecoverySummary(dump, retained).unresolvedNavigation).toBe(0);
    dump.version = 12; dump.tables.pages = [];
    expect(pageRecoverySummary(dump, retained).unresolvedNavigation).toBe(1);
    expect(navigation.footer).toHaveLength(1);
  });
});
