import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DUMP_VERSION, JOURNEYS_DUMP_VERSION, SUPPORTED_DUMP_VERSIONS, readDump, type Dump } from '../src/backup.js';
import { identityDumpRow } from './site-identity-fixture.js';
import { DEFAULT_NAVIGATION } from '../../site/src/lib/navigation.js';
import type { JourneySnapshot } from '../../site/src/lib/journey-snapshot.js';
import type { LanguageConfig } from '../src/language.js';

const stamp = '2026-10-29T12:00:00.000Z';
const id = '12345678-1234-1234-1234-123456789012';
const other = '22345678-1234-1234-1234-123456789012';
const hero = { src: 'https://images.example/photos/hero', width: 1000, height: 600, alt: 'Mountain', focus: { x: 20, y: 40 } };
const modes: LanguageConfig[] = [
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
];
function fixture(mode = modes[2]!): Dump {
  const snapshot: JourneySnapshot = { version: 1, members: ['story'], locales: {
    [mode.primary]: { slug: 'journey', title: 'Journey', intro: 'A real introduction.', heroImage: hero },
  } };
  return { version: DUMP_VERSION, createdAt: stamp, tables: {
    users: [], posts: (['de', 'en'] as const).map(locale => ({ translation_key: 'story', locale, status: 'draft',
      omitted: locale !== mode.primary, published_at: null, published_snapshot: null })),
    pages: [], post_routes: [], site_identity: [identityDumpRow()], site_identity_assets: [],
    site_nav: [{ id: 1, config: DEFAULT_NAVIGATION, updated_at: stamp }],
    site_language: [{ id: true, primary_locale: mode.primary, enabled_locales: mode.locales, locked_at: stamp, updated_at: stamp }],
    journeys: [{ id, status: 'published', published_snapshot: snapshot, published_at: stamp, created_at: stamp, updated_at: stamp }],
    journey_locales: (['de', 'en'] as const).map(locale => ({ journey_id: id, locale, slug: 'journey', title: '', intro: '', hero_image: hero,
      omitted: locale !== mode.primary, published_at: locale === mode.primary ? stamp : null })),
    journey_members: [{ journey_id: id, translation_key: 'story', position: 0 }],
  } };
}
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'journeys-backup-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function file(dump: Dump) { const path = join(dir, 'dump.json.gz'); await writeFile(path, gzipSync(JSON.stringify(dump))); return path; }
const snapshotOf = (dump: Dump) => dump.tables.journeys![0]!.published_snapshot as JourneySnapshot;

describe('strict journey recovery format', () => {
  it.each(modes)('preserves edited working copies and retained publication coverage in $primary/$locales', async mode => {
    const dump = fixture(mode);
    expect(readDump(await file(dump))).toEqual(dump);
    dump.tables.journeys![0]!.status = 'draft';
    if (mode.locales.length === 2) dump.tables.journey_locales!.find(row => row.locale !== mode.primary)!.omitted = false;
    expect(readDump(await file(dump))).toEqual(dump); // un-omit + Save never creates a snapshot
    snapshotOf(dump).members = [];
    dump.tables.journey_members = [];
    expect(readDump(await file(dump))).toEqual(dump); // deletion may leave dormant retained snapshots
  });

  it.each(['journeys', 'journey_locales', 'journey_members'] as const)('requires the %s array at v14', async table => {
    const dump = fixture(); delete dump.tables[table];
    const path = await file(dump); expect(() => readDump(path)).toThrow('Invalid journeys in backup.');
  });
  it.each(SUPPORTED_DUMP_VERSIONS.filter(version => version < JOURNEYS_DUMP_VERSION))('rejects every journey key in pre-journey v%i, even null or empty', async version => {
    for (const table of ['journeys', 'journey_locales', 'journey_members'] as const) {
      for (const value of [null, []]) {
        const dump = fixture(); dump.version = version; dump.tables.posts = [];
        delete dump.tables.journeys; delete dump.tables.journey_locales; delete dump.tables.journey_members;
        if (version < 11) { delete dump.tables.site_identity; delete dump.tables.site_identity_assets; }
        if (version < 10) delete dump.tables.post_routes;
        Object.assign(dump.tables, { [table]: value });
        const path = await file(dump); expect(() => readDump(path)).toThrow('Journeys require a version 14 recovery set.');
      }
    }
  });

  const malformed: Record<string, (dump: Dump) => void> = {
    'unknown parent column': d => { d.tables.journeys![0]!.private = 'secret'; },
    'invalid UUID': d => { d.tables.journeys![0]!.id = 'not-uuid'; },
    'duplicate parent': d => { d.tables.journeys!.push({ ...d.tables.journeys![0]! }); },
    'unknown status': d => { d.tables.journeys![0]!.status = 'live'; },
    'missing snapshot': d => { d.tables.journeys![0]!.published_snapshot = null; },
    'missing parent history': d => { d.tables.journeys![0]!.published_at = null; },
    'invalid timestamp': d => { d.tables.journeys![0]!.updated_at = '2026-02-30T00:00:00Z'; },
    'missing locale': d => { d.tables.journey_locales!.pop(); },
    'duplicate locale': d => { d.tables.journey_locales!.push({ ...d.tables.journey_locales![0]! }); },
    'unknown locale': d => { d.tables.journey_locales![1]!.locale = 'fr'; },
    'unknown locale column': d => { d.tables.journey_locales![0]!.unexpected = 1; },
    'dangling locale': d => { d.tables.journey_locales![0]!.journey_id = other; },
    'unsafe slug': d => { d.tables.journey_locales![1]!.slug = '../secret'; },
    'long title': d => { d.tables.journey_locales![1]!.title = 'x'.repeat(201); },
    'long intro': d => { d.tables.journey_locales![1]!.intro = 'x'.repeat(2001); },
    'control title': d => { d.tables.journey_locales![1]!.title = '\u0000'; },
    'nonboolean omission': d => { d.tables.journey_locales![1]!.omitted = 'true'; },
    'omitted primary': d => { d.tables.journey_locales![0]!.omitted = true; },
    'lost locale history': d => { d.tables.journey_locales![0]!.published_at = null; },
    'invented locale history': d => { d.tables.journey_locales![1]!.published_at = stamp; },
    'changed locked slug': d => { d.tables.journey_locales![0]!.slug = 'renamed'; },
    'missing publication latch': d => { d.tables.site_language![0]!.locked_at = null; },
    'unknown member column': d => { d.tables.journey_members![0]!.content = 'private'; },
    'dangling member journey': d => { d.tables.journey_members![0]!.journey_id = other; },
    'dangling member story': d => { d.tables.journey_members![0]!.translation_key = 'absent'; },
    'position gap': d => { d.tables.journey_members![0]!.position = 1; },
    'negative position': d => { d.tables.journey_members![0]!.position = -1; },
    'fractional position': d => { d.tables.journey_members![0]!.position = 0.5; },
    'duplicate position': d => { d.tables.journey_members!.push({ ...d.tables.journey_members![0]! }); },
    'duplicate member': d => { d.tables.journey_members!.push({ ...d.tables.journey_members![0]!, position: 1 }); },
    'duplicate slug': d => {
      d.tables.journeys!.push({ ...d.tables.journeys![0]!, id: other });
      d.tables.journey_locales!.push(...d.tables.journey_locales!.map(row => ({ ...row, journey_id: other })));
    },
    'working NUL intro': d => { d.tables.journey_locales![0]!.intro = '\0'; },
    'snapshot NUL intro': d => { snapshotOf(d).locales.de!.intro = '\0'; },
    'snapshot unknown field': d => { Object.assign(snapshotOf(d), { private: 'secret' }); },
    'snapshot unknown version': d => { Object.assign(snapshotOf(d), { version: 2 }); },
    'snapshot dangling story': d => { snapshotOf(d).members = ['absent']; d.tables.journeys![0]!.status = 'draft'; },
    'snapshot duplicate story': d => { snapshotOf(d).members = ['story', 'story']; },
    'snapshot empty intro': d => { snapshotOf(d).locales.de!.intro = ' \n '; },
    'snapshot variant source': d => { snapshotOf(d).locales.de!.heroImage = { ...hero, src: hero.src + '-640.webp' }; },
    'working variant source': d => { d.tables.journey_locales![0]!.hero_image = { ...hero, src: hero.src + '-640.webp' }; },
    'snapshot invalid dimensions': d => { snapshotOf(d).locales.de!.heroImage = { ...hero, width: 0 }; },
    'snapshot invalid focus': d => { snapshotOf(d).locales.de!.heroImage = { ...hero, focus: { x: 101, y: 40 } }; },
    'snapshot disabled locale': d => {
      d.tables.site_language![0]!.enabled_locales = ['en']; d.tables.site_language![0]!.primary_locale = 'en';
      for (const row of d.tables.posts) row.omitted = row.locale !== 'en';
    },
  };
  it.each(Object.entries(malformed))('rejects %s with a fixed content-free error', async (_name, corrupt) => {
    const dump = fixture(); corrupt(dump);
    const path = await file(dump); expect(() => readDump(path)).toThrow('Invalid journeys in backup.');
  });

  it('rejects duplicate live/working claims but permits retained draft snapshot references', async () => {
    const dump = fixture();
    dump.tables.journeys!.push({ ...dump.tables.journeys![0]!, id: other, status: 'draft', published_at: null, published_snapshot: null });
    dump.tables.journey_locales!.push(...dump.tables.journey_locales!.map(row => ({ ...row, journey_id: other, slug: 'second', published_at: null })));
    dump.tables.journey_members = [{ journey_id: other, translation_key: 'story', position: 0 }];
    let path = await file(dump); expect(() => readDump(path)).toThrow('Invalid journeys in backup.');
    dump.tables.journeys![0]!.status = 'draft';
    expect(readDump(await file(dump))).toEqual(dump);
    dump.tables.journey_members.push({ journey_id: id, translation_key: 'story', position: 0 });
    path = await file(dump); expect(() => readDump(path)).toThrow('Invalid journeys in backup.');
  });
});
