import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { postgresTripsLoader, rowToEntryInput } from './postgres-loader';
import { renderMarkdown } from './render-markdown.js';
import { publicTrackSchema, type PublicTrack } from './public-track';

const publicTrack: PublicTrack = {
  version: 1, type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[10, 20], [11, 21]]],
};

// Shared fake-DB state for the mocked `pg` module (hoisted with the mock).
const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  media: [] as Record<string, unknown>[],
  sql: [] as string[],
}));

// The loader creates its own pool (`loaderPool`, over `pg`), so mock `pg` and act
// like Postgres for exactly the predicates under test: the loader only receives
// rows its own WHERE clause actually selects. Reverting the loader to build
// from the working columns would return the draft-edited/unbackfilled rows
// below and fail the assertions.
vi.mock('pg', () => ({
  default: {
    Pool: class {
      async connect() { return this; }
      release() {}
      async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
        db.sql.push(sql);
        if (!/^\s*SELECT\b/.test(sql)) return { rows: [] };
        if (/\bFROM media\b/.test(sql)) return { rows: db.media };
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
  translation_key: 'bucharest-2024', locale: 'de' as const, slug: 'reisebericht-4-tage-bukarest',
  title: 'T', date: new Date(2024, 9, 3), country: 'Rumänien', country_code: 'RO', region: 'europe',
  excerpt: 'E', hero_image: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
  coordinates: { lat: 44.4, lng: 26.1 }, stops: null, route: null, key_facts: { K: 'V' },
  body_markdown: '## Hi', images: {},
};

describe('rowToEntryInput', () => {
  it('retargets the optional title image independently and retains its metadata', () => {
    const title = { src: 'http://localhost:3000/trips/x/title', width: 2400, height: 800,
      alt: 'Panorama', format: 'jpeg' as const, focus: { x: 30, y: 60 } };
    const result = rowToEntryInput({ ...row, title_image: title }, 'https://img');
    expect(result.data.titleImage).toEqual({ ...title, src: 'https://img/trips/x/title' });
    expect(result.data.heroImage).toEqual(row.hero_image);
    expect(rowToEntryInput(row, 'https://img').data.titleImage).toBeUndefined();
    expect(rowToEntryInput({ ...row, title_image: null }, 'https://img').data.titleImage).toBeUndefined();
  });

  it('builds id as `${locale}/${slug}` and camelCase data matching the schema', () => {
    const e = rowToEntryInput(row as never, 'https://img');
    expect(e.id).toBe('de/reisebericht-4-tage-bukarest');
    expect(e.data.translationKey).toBe('bucharest-2024');
    expect(e.data.countryCode).toBe('RO');
    expect(e.data.heroImage).toEqual({ src: 'https://img/h', width: 768, height: 512, alt: 'a' });
    expect(e.data.keyFacts).toEqual({ K: 'V' });
    expect(e.body).toBe('## Hi');
  });

  it('preserves JPEG-only markers on hero and body metadata', () => {
    const jpegRow = {
      ...row,
      hero_image: { ...row.hero_image, format: 'jpeg' as const },
      images: { 'http://localhost:3000/trips/x/body': { width: 1600, height: 1067, format: 'jpeg' as const } },
    };
    const entry = rowToEntryInput(jpegRow, 'https://img.example.com');
    expect(entry.data.heroImage).toMatchObject({ src: 'https://img.example.com/h', format: 'jpeg' });
    expect(entry.images['https://img.example.com/trips/x/body']).toMatchObject({ format: 'jpeg' });
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

  // `featured` is `z.boolean().optional()` in content.config.ts with NO
  // default, so a false/absent flag must produce no key at all — that is what
  // keeps every pre-flag snapshot valid and every unflagged entry unchanged.
  // A snapshot written before the column existed carries no key either.
  it('emits featured only when the snapshot says true', () => {
    expect('featured' in rowToEntryInput(row as never, 'https://img').data).toBe(false);
    expect('featured' in rowToEntryInput({ ...row, featured: false } as never, 'https://img').data).toBe(false);
    expect(rowToEntryInput({ ...row, featured: true } as never, 'https://img').data.featured).toBe(true);
  });
  it('passes only the snapshot track to schema validation, without a route default', () => {
    expect(rowToEntryInput({ ...row, track: publicTrack }, 'https://img').data.track).toEqual(publicTrack);
    expect(rowToEntryInput(row, 'https://img').data).not.toHaveProperty('track');
    // Invalid present data must reach the strict schema, not disappear as if absent.
    expect(rowToEntryInput({ ...row, track: null }, 'https://img').data).toHaveProperty('track', null);
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
    parseData: async ({ data }: { id: string; data: Record<string, unknown> }) => {
      if ('track' in data) publicTrackSchema.parse(data.track);
      return data;
    },
    renderMarkdown: async (md: string) => ({ html: await renderMarkdown(md) }),
    logger: { info: () => { /* quiet */ } },
  };
  return { entries, ctx: ctx as unknown as LoaderContext };
}

describe('postgresTripsLoader load()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    db.rows = [];
    db.media = [];
    db.sql = [];
  });

  it('builds localized decorative gallery names from each published story locale', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://img');
    const src = 'https://img/trips/names/photo';
    db.rows = ['de', 'en'].map((locale) => ({
      status: 'published',
      published_snapshot: {
        ...row, locale,
        body_markdown: `\`\`\`gallery\n${src}\n${src}\n\`\`\``,
        images: { [src]: { width: 1600, height: 1000, alt: 'Old description' } },
      },
    }));
    db.media = [{ key: 'trips/names/photo', alt_de: '', alt_en: '', caption_de: '', caption_en: '' }];
    const { entries, ctx } = fakeLoadContext();
    await postgresTripsLoader().load(ctx);
    for (const locale of ['de', 'en']) {
      const html = entries.get(`${locale}/${row.slug}`)?.rendered?.html ?? '';
      expect(html).toContain(`aria-label="${locale === 'de' ? 'Foto 1 von 2 öffnen' : 'Open photo 1 of 2'}"`);
      expect(html).toContain(`aria-label="${locale === 'de' ? 'Foto 2 von 2 öffnen' : 'Open photo 2 of 2'}"`);
      expect(html).toContain('alt=""');
      expect(html).toContain(`href="${src}-1600.webp"`);
      expect(html).not.toContain('Old description');
    }
  });

  // The load-bearing guarantee of issue #20: a draft save over a published
  // post must NEVER reach the store — only the published_snapshot content may.
  it('builds only from published snapshots; diverged working copies and snapshot-less rows stay dark', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('SITE_DATABASE_SNAPSHOT', '00000003-0000000A-1');
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
    expect(db.sql.slice(0, 2)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      "SET TRANSACTION SNAPSHOT '00000003-0000000A-1'",
    ]);
    expect(db.sql.at(-1)).toBe('COMMIT');
  });
  it('keeps the published track through draft replacement and detachment, and never fills a legacy snapshot', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    const snapshot = { ...row, track: publicTrack };
    const draftTrack = { ...publicTrack, coordinates: [[[50, 60], [51, 61]]] };
    db.rows = [
      { ...row, track: draftTrack, status: 'published', published_snapshot: snapshot },
      { ...row, track: draftTrack, status: 'published', published_snapshot: { ...row, locale: 'en' } },
    ];
    const { entries, ctx } = fakeLoadContext();
    await postgresTripsLoader().load(ctx);
    expect(entries.get(`de/${row.slug}`)?.data?.track).toEqual(publicTrack);
    expect(entries.get(`en/${row.slug}`)?.data).not.toHaveProperty('track');
    db.rows[0]!.track = null;
    await postgresTripsLoader().load(ctx);
    expect(entries.get(`de/${row.slug}`)?.data?.track).toEqual(publicTrack);
    expect(db.sql.every((sql) => !/post_routes/i.test(sql))).toBe(true);
  });

  it('fails the build path for corrupt or private snapshot geometry instead of silently discarding it', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    db.rows = [{
      ...row, status: 'published',
      published_snapshot: { ...row, track: { ...publicTrack, time: 'private' } },
    }];
    const { entries, ctx } = fakeLoadContext();
    await expect(postgresTripsLoader().load(ctx)).rejects.toThrow();
    expect(entries.size).toBe(0);
  });

  it('refreshes localized library descriptions on rebuild without publishing working edits', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://img');
    const src = 'http://localhost:3000/trips/lima/photo';
    const snapshot = {
      ...row, date: '2024-10-03',
      body_markdown: `Published opening\n\n\`\`\`gallery\n${src}\n\`\`\``,
      images: { [src]: { width: 1600, height: 1000, alt: 'Old alt', caption: 'Old caption', format: 'jpeg' } },
    };
    db.rows = ['de', 'en'].map((locale) => ({
      ...snapshot, locale, body_markdown: 'Unpublished working edit',
      status: 'published', published_snapshot: { ...snapshot, locale },
    }));
    db.media = [{
      key: 'trips/lima/photo', alt_de: 'Lima am Abend', alt_en: 'Lima at dusk',
      caption_de: 'Blick über Lima', caption_en: 'View over Lima',
    }];
    const { entries, ctx } = fakeLoadContext();
    const loader = postgresTripsLoader();
    await loader.load(ctx);
    const html = (locale: string) => entries.get(`${locale}/${row.slug}`)?.rendered?.html ?? '';
    expect(html('de')).toContain('alt="Lima am Abend"');
    expect(html('de')).toContain('Blick über Lima</figcaption>');
    expect(html('en')).toContain('alt="Lima at dusk"');
    expect(html('en')).toContain('View over Lima</figcaption>');
    expect(html('en')).not.toContain('Lima am Abend');
    expect(html('de')).toContain('Published opening');
    expect(html('de')).not.toContain('Unpublished working edit');
    expect(html('de')).toContain('https://img/trips/lima/photo-1280.jpeg');

    db.media[0]!.alt_de = '';
    db.media[0]!.caption_de = '';
    db.media[0]!.alt_en = 'Updated English description';
    await loader.load(ctx);
    expect(html('de')).toContain('alt=""');
    expect(html('de')).not.toContain('<figcaption');
    expect(html('en')).toContain('alt="Updated English description"');
    expect(snapshot.images[src].alt).toBe('Old alt');

    db.media = [];
    await loader.load(ctx);
    expect(html('de')).toContain('alt="Old alt"');
    expect(html('de')).toContain('Old caption</figcaption>');
  });
});
