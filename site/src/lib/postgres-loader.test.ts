import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { postgresTripsLoader, rowToEntryInput } from './postgres-loader';

// Shared fake-DB state for the mocked `pg` module (hoisted with the mock).
const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], sql: [] as string[] }));

// The loader creates its own `new pg.Pool(DATABASE_URL)`, so mock `pg` and act
// like Postgres for exactly the predicates under test: the loader only receives
// rows its own WHERE clause actually selects. Reverting the loader to build
// from the working columns would return the draft-edited/unbackfilled rows
// below and fail the assertions.
vi.mock('pg', () => ({
  default: {
    Pool: class {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
        db.sql.push(sql);
        let rows = db.rows;
        if (/status\s*=\s*'published'/.test(sql)) rows = rows.filter((r) => r.status === 'published');
        if (/published_snapshot\s+IS\s+NOT\s+NULL/.test(sql)) {
          rows = rows.filter((r) => r.published_snapshot != null);
        }
        return { rows };
      }
      async end(): Promise<void> {
        /* released by the loader's finally */
      }
    },
  },
}));

// pg parses the `date` column to LOCAL midnight — mirror that in the fixture.
const row = {
  translation_key: 'bucharest-2024', locale: 'de', slug: 'reisebericht-4-tage-bukarest',
  title: 'T', date: new Date(2024, 9, 3), country: 'Rumänien', country_code: 'RO', region: 'europe',
  excerpt: 'E', hero_image: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
  coordinates: { lat: 44.4, lng: 26.1 }, stops: null, route: null, key_facts: { K: 'V' },
  body_markdown: '## Hi', images: {},
};

describe('rowToEntryInput', () => {
  it('builds id as `${locale}/${slug}` and camelCase data matching the schema', () => {
    const e = rowToEntryInput(row as never, 'https://img');
    expect(e.id).toBe('de/reisebericht-4-tage-bukarest');
    expect(e.data.translationKey).toBe('bucharest-2024');
    expect(e.data.countryCode).toBe('RO');
    expect(e.data.heroImage).toEqual({ src: 'https://img/h', width: 768, height: 512, alt: 'a' });
    expect(e.data.keyFacts).toEqual({ K: 'V' });
    expect(e.body).toBe('## Hi');
  });

  // The loader now builds from the `published_snapshot` jsonb (issue #20),
  // where `date` arrives as a 'YYYY-MM-DD' string and every value is a plain
  // JSON round-tripped object — the mapping must be identical to a live row.
  it('maps a jsonb published-snapshot shape identically to a live-row shape', () => {
    const snapshot = { ...row, date: '2024-10-03' };
    const live = rowToEntryInput(row as never, 'https://img');
    const snap = rowToEntryInput(snapshot as never, 'https://img');
    expect(snap.id).toBe(live.id);
    expect(snap.data).toEqual(live.data);
    expect(snap.body).toBe(live.body);
    expect(snap.images).toEqual(live.images);
    // jsonb_build_object emits JSON null for absent optionals — they must stay omitted
    expect('stops' in snap.data).toBe(false);
    expect('route' in snap.data).toBe(false);
    // The snapshot's 'YYYY-MM-DD' text parses to LOCAL midnight — the same
    // instant pg produces for a `date` column — so dateLabel (toLocaleDateString
    // without a timeZone) renders the same month in every build timezone.
    expect(snap.data.date).toEqual(new Date(2024, 9, 3));
  });
});

type LoaderContext = Parameters<Loader['load']>[0];
interface StoredEntry {
  id: string;
  data?: Record<string, unknown>;
  body?: string;
  rendered?: { html: string };
}

function fakeLoadContext(): { entries: Map<string, StoredEntry>; ctx: LoaderContext } {
  const entries = new Map<string, StoredEntry>();
  const ctx = {
    store: {
      clear: () => entries.clear(),
      set: (entry: StoredEntry) => { entries.set(entry.id, entry); return true; },
    },
    parseData: async ({ data }: { id: string; data: Record<string, unknown> }) => data,
    renderMarkdown: async (md: string) => ({ html: `<p>${md}</p>` }),
    logger: { info: () => { /* quiet */ } },
  };
  return { entries, ctx: ctx as unknown as LoaderContext };
}

describe('postgresTripsLoader load()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    db.rows = [];
    db.sql = [];
  });

  // The load-bearing guarantee of issue #20: a draft save over a published
  // post must NEVER reach the store — only the published_snapshot content may.
  it('builds only from published snapshots; diverged working copies and snapshot-less rows stay dark', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    const snapshot = {
      translation_key: 'lima-2025', locale: 'de', slug: 'lima-reise', title: 'Lima (live)',
      date: '2025-05-01', country: 'Peru', country_code: 'PE', region: 'south-america',
      excerpt: 'live excerpt', hero_image: { src: 'https://img/l', width: 768, height: 512, alt: 'l' },
      coordinates: { lat: -12, lng: -77 }, stops: null, route: null, key_facts: null,
      body_markdown: 'LIVE body', images: {},
    };
    db.rows = [
      // Published post whose working copy was edited after the last Publish.
      { ...snapshot, title: 'Lima (draft edit)', body_markdown: 'WORKING-EDIT body', status: 'published', published_snapshot: snapshot },
      // Published pre-#20 and never backfilled: no snapshot → must not load.
      { ...snapshot, locale: 'en', slug: 'lima-trip', status: 'published', published_snapshot: null },
      // Plain draft: must not load.
      { ...snapshot, locale: 'en', slug: 'cusco-draft', status: 'draft', published_snapshot: null },
    ];

    const { entries, ctx } = fakeLoadContext();
    await postgresTripsLoader().load(ctx);

    expect([...entries.keys()]).toEqual(['de/lima-reise']);
    const entry = entries.get('de/lima-reise');
    expect(entry?.data?.title).toBe('Lima (live)');
    expect(entry?.body).toBe('LIVE body');
    expect(entry?.rendered?.html).toContain('LIVE body');
    expect(entry?.rendered?.html).not.toContain('WORKING-EDIT');
  });
});
