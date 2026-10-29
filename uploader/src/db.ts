import pg from 'pg';

const { Pool } = pg;
export type DbPool = pg.Pool;
/** A checked-out connection (`pool.connect()`), for multi-statement transactions. */
export type DbClient = pg.PoolClient;

export const ABOUT_SEED = {
  de: {
    title: 'Über mich',
    body: 'Hier teile ich meine Leidenschaft fürs Reisen — Geschichten und Erinnerungen von den belebten Straßen Europas bis zu den geheimnisvollen Pfaden Südamerikas. Der vollständige Über-mich-Text wird in Phase 2 von der bestehenden Seite migriert.',
  },
  en: {
    title: 'About me',
    body: 'Here I share my passion for travelling — stories and memories from the bustling streets of Europe to the mysterious trails of South America. The full about text will be migrated from the existing site in Phase 2.',
  },
};

export function createPool(connectionString: string, applicationName?: string): DbPool {
  if (applicationName !== undefined) {
    let url: URL;
    try { url = new URL(connectionString); }
    catch { throw new Error('DATABASE_URL must be a PostgreSQL URL.'); }
    // pg gives URL parameters precedence over Pool options.
    url.searchParams.set('application_name', applicationName);
    connectionString = url.toString();
  }
  return new Pool({ connectionString });
}

/**
 * The closed region set a post may carry, in display order. The `posts`
 * CHECK constraint below is built from it, and posts.ts validates against it.
 * @ai-warning Mirrored by hand where this module cannot be imported:
 * site/src/lib/paths.ts `regions` (separate tsconfig), public/posts-filter.js
 * `REGIONS` and the editor's region `<select>` in public/editor.html — the
 * uploader tests pin the two browser copies to this constant. Widening it also
 * needs the site's Zod enum (derived from `regions`), labels and slugs.
 * @ai-context docs/superpowers/specs/2026-10-19-new-regions-design.md
 */
export const REGIONS = [
  'europe',
  'asia',
  'africa',
  'north-america',
  'south-america',
  'oceania',
  'antarctica',
] as const;
export type Region = (typeof REGIONS)[number];

/** `'europe','asia',…` — the IN list of the region CHECK. Constants only, never input. */
const REGION_SQL_LIST = REGIONS.map((r) => `'${r}'`).join(',');

/**
 * SQL fragment building the published-snapshot jsonb from a posts row's own
 * working columns. Shared by the ensureSchema backfill and pgPostStore.publish.
 * (Post revisions — issue #28 — snapshot the whole pair in the editor's
 * camelCase PUT-payload shape instead, so a restore round-trips unchanged.)
 * @ai-note `date` is serialized as 'YYYY-MM-DD' text so the site loader can
 * `new Date(...)` it after the jsonb round-trip (a bare date column would
 * otherwise be locale/timezone-sensitive — see the dump comment in backup.ts).
 */
export const POST_SNAPSHOT_SQL = `jsonb_build_object(
  'translation_key', translation_key, 'locale', locale, 'slug', slug, 'title', title,
  'date', to_char(date, 'YYYY-MM-DD'), 'country', country, 'country_code', country_code,
  'region', region, 'excerpt', excerpt, 'hero_image', hero_image, 'coordinates', coordinates,
  'title_image', title_image,
  'stops', stops, 'route', route, 'key_facts', key_facts,
  'body_markdown', body_markdown, 'images', images,
  'categories', categories, 'tags', tags, 'scheduled_at', scheduled_at,
  'featured', featured
)`;

/** Narrow operational migration, also safe before an offline content restore. */
export async function ensureOnboardingSchema(db: Pick<DbClient, 'query'>): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS onboarding_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    state text NOT NULL CHECK (state IN ('eligible', 'retired')),
    reason text NOT NULL,
    evaluated_at timestamptz NOT NULL,
    dismissed_at timestamptz,
    retired_at timestamptz,
    CHECK (
      (state = 'eligible' AND reason = 'fresh' AND retired_at IS NULL)
      OR (state = 'retired' AND reason IN ('existing-schema','existing-accounts','existing-content',
        'existing-data','restored-content','finished') AND retired_at IS NOT NULL AND dismissed_at IS NULL)
    )
  )`);
}

export async function ensureSchema(pool: DbPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            uuid PRIMARY KEY,
      username      text NOT NULL,
      password_hash text NOT NULL,
      is_admin      boolean NOT NULL DEFAULT false,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));`);
  // Operational, account-lifetime identities. Never included in content dumps.
  // Account deletion atomically invalidates receipts through the FK; restore
  // explicitly clears them while all filesystem writers are stopped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS upload_receipts (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      upload_id uuid NOT NULL,
      media_key text NOT NULL,
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      identity jsonb NOT NULL,
      frozen jsonb NOT NULL,
      state text NOT NULL CHECK (state IN ('pending','accepted','retryable','gone')),
      incarnation uuid NOT NULL,
      claim uuid NOT NULL,
      generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
      reason text CHECK (reason IN ('queue_full','recovery_required')),
      original_retained boolean NOT NULL DEFAULT false,
      result jsonb,
      PRIMARY KEY (user_id, upload_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS upload_receipts_pending_idx
    ON upload_receipts (user_id, upload_id) WHERE state = 'pending'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS upload_receipts_media_idx ON upload_receipts (media_key)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         text PRIMARY KEY,
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id uuid PRIMARY KEY, translation_key text NOT NULL, locale text NOT NULL CHECK (locale IN ('de','en')),
      slug text NOT NULL, title text NOT NULL, date date NOT NULL, country text NOT NULL,
      country_code text NOT NULL CHECK (char_length(country_code)=2),
      region text NOT NULL CONSTRAINT posts_region_check CHECK (region IN (${REGION_SQL_LIST})),
      excerpt text NOT NULL, hero_image jsonb NOT NULL, coordinates jsonb NOT NULL,
      title_image jsonb,
      stops jsonb, route text, key_facts jsonb, body_markdown text NOT NULL,
      images jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      featured boolean NOT NULL DEFAULT false,
      comments_enabled boolean NOT NULL DEFAULT true,
      last_save_id uuid, last_save_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())
  `);
  // @ai-note Partial: '' means "no slug yet" (a DE-first draft without an EN
  // title), and any number of such drafts may coexist (issue #119). Existing
  // databases carry the older non-partial form and are migrated below.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS posts_locale_slug_idx ON posts (locale, slug) WHERE slug <> ''`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_translation_key_idx ON posts (translation_key)`);
  // @ai-note published_snapshot separates the LIVE content from the working
  // copy: publish() copies the row's working columns into it, and the site
  // loader (site/src/lib/postgres-loader.ts) builds ONLY from snapshots — so a
  // draft save over a published post can never leak onto the public site via
  // an unrelated rebuild (issue #20). Additive, idempotent migration.
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS published_snapshot jsonb`);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS title_image jsonb`);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS published_at timestamptz`);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS categories text[] NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS scheduled_at timestamptz`);
  // @ai-note "Use as homepage cover" (the homepage picks the NEWEST flagged
  // published entry and falls back to the newest entry overall). Deliberately
  // NOT unique: several posts may carry the flag, so setting it on one post
  // never mutates another — no cross-post write, no race. false is the
  // fail-safe default, so every pre-existing row stays "not the cover".
  // @ai-warning This ALTER must stay ABOVE the published_snapshot backfill
  // below: that UPDATE expands POST_SNAPSHOT_SQL, which names `featured`, and
  // Postgres rejects the statement at analysis time on a database that does
  // not have the column yet — even when no row matches its WHERE. Same reason
  // categories/tags/scheduled_at are migrated here rather than in the column
  // migrations section at the bottom of this function.
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_categories_idx ON posts USING gin (categories)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_tags_idx ON posts USING gin (tags)`);
  // One-time backfill for rows published before the column existed. The
  // `published_snapshot IS NULL` guard makes re-runs no-ops, so a working copy
  // edited after the first backfill is never promoted into the snapshot.
  await pool.query(`
    UPDATE posts SET published_snapshot = ${POST_SNAPSHOT_SQL},
                     published_at = COALESCE(published_at, updated_at)
     WHERE status = 'published' AND published_snapshot IS NULL
  `);
  // @ai-note post_revisions holds whole-pair snapshots of the WORKING copy,
  // taken just before a save overwrites it (issue #28) — the recovery net for
  // bad pastes and stale-tab overwrites. Snapshots use the editor's PUT-payload
  // shape ({status, shared, de, en}, camelCase) so a restore round-trips
  // through the editor unchanged. Capped at REVISION_CAP (posts.ts) per
  // translation_key by upsertDraft; deliberately excluded from the scheduled
  // DB dumps (backup.ts keeps its fixed table list — revisions are a
  // convenience net, not content of record). Additive, idempotent migration.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_revisions (
      id              uuid PRIMARY KEY,
      translation_key text NOT NULL,
      snapshot        jsonb NOT NULL,
      saved_at        timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS post_revisions_tk_saved_idx ON post_revisions (translation_key, saved_at DESC)`);
  // #137: revisions must not outlive their post. pgPostStore.remove now deletes
  // them with the post, but rows deleted before that change (and a dump restored
  // over a database that still holds revisions — dumps carry none) left
  // full-body snapshots readable forever. Sweep orphans once per boot; a no-op
  // on a consistent database, indexed on translation_key.
  await pool.query(`DELETE FROM post_revisions r WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.translation_key = r.translation_key)`);
  // One private route per pair; posts has no single-column parent key.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_routes (
      translation_key text PRIMARY KEY,
      version uuid NOT NULL,
      geometry jsonb,
      source_id uuid NOT NULL,
      source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
      source_bytes integer NOT NULL CHECK (source_bytes BETWEEN 1 AND 5242880),
      updated_at timestamptz NOT NULL
    )
  `);
  // Operational intents survive failed unlink and restore, but are not dumped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS route_cleanup (
      source_id uuid PRIMARY KEY,
      pair_hash text NOT NULL CHECK (pair_hash ~ '^[0-9a-f]{64}$'),
      requested_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pages (
      key           text NOT NULL,
      locale        text NOT NULL CHECK (locale IN ('de','en')),
      title         text NOT NULL DEFAULT '',
      body_markdown text NOT NULL DEFAULT '',
      images        jsonb NOT NULL DEFAULT '{}',
      updated_at    timestamptz NOT NULL DEFAULT now(),
      last_save_id   uuid,
      last_save_by   uuid,
      PRIMARY KEY (key, locale)
    )
  `);
  // Seed the About page with the previous hardcoded placeholder so the page
  // never goes blank; the author then edits it in /admin/about.html.
  await pool.query(
    `INSERT INTO pages (key, locale, title, body_markdown) VALUES
       ('about','de',$1,$2), ('about','en',$3,$4)
     ON CONFLICT (key, locale) DO NOTHING`,
    [ABOUT_SEED.de.title, ABOUT_SEED.de.body, ABOUT_SEED.en.title, ABOUT_SEED.en.body],
  );
  // @ai-note page_revisions mirrors post_revisions for pages (issue #141):
  // whole-pair {de, en} snapshots taken just before a save overwrites the
  // stored page, capped at REVISION_CAP per key by pgPageStore.save, and
  // likewise excluded from the scheduled dumps (backup.ts keeps its fixed table
  // list). Pages are never deleted, so no orphan sweep is needed. Additive,
  // idempotent migration.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_revisions (
      id       uuid PRIMARY KEY,
      key      text NOT NULL,
      snapshot jsonb NOT NULL,
      saved_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS page_revisions_key_saved_idx ON page_revisions (key, saved_at DESC)`);

  // @ai-note The media library (issue #64). A `media` row is metadata ABOUT a
  // file under STORAGE_DIR — the filesystem stays the source of truth for a
  // file's existence, so photos survive a database loss (media-sync.ts
  // reconciles the two).
  // @ai-warning `status` defaults to 'processing', NOT 'ready' — fail closed.
  // Every insert sets it explicitly, so the default only fires when an insert
  // forgets the column; defaulting to 'ready' would declare a photo with no
  // variants publishable, which is exactly what the publish gate exists to
  // prevent. `width`/`height` default to 0 meaning "unknown" (the backfill can
  // genuinely produce that from an unreadable probe), because db.ts's
  // convention makes a DEFAULT mandatory on NOT NULL columns.
  // @ai-warning The CHECK constraint below is WRITE-ONCE: `CREATE TABLE IF NOT
  // EXISTS` will not alter it on an already-deployed database, so adding a new
  // MediaStatus later silently fails in production while passing on a fresh CI
  // database. Widening it needs an explicit `ALTER TABLE ... DROP CONSTRAINT /
  // ADD CONSTRAINT` appended to the column-migrations section below.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media (
      key           text PRIMARY KEY,
      folder        text NOT NULL DEFAULT '',
      title         text NOT NULL DEFAULT '',
      alt_de        text NOT NULL DEFAULT '',
      alt_en        text NOT NULL DEFAULT '',
      caption_de    text NOT NULL DEFAULT '',
      caption_en    text NOT NULL DEFAULT '',
      tags          text[] NOT NULL DEFAULT '{}',
      width         integer NOT NULL DEFAULT 0,
      height        integer NOT NULL DEFAULT 0,
      orig_bytes    bigint  NOT NULL DEFAULT 0,
      variant_bytes bigint  NOT NULL DEFAULT 0,
      status        text NOT NULL DEFAULT 'processing'
                    CHECK (status IN ('processing','ready','failed','missing')),
      error         text,
      taken_at      timestamptz,
      camera        text,
      lens          text,
      lat           double precision,
      lng           double precision,
      format        text CHECK (format IS NULL OR format = 'jpeg'),
      encoding      jsonb,
      CONSTRAINT media_encoding_check
        CHECK (format IS NULL OR COALESCE(encoding ->> 'convertJpeg' = 'false', false)),
      uploaded_at   timestamptz NOT NULL DEFAULT now(),
      uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_folder_idx   ON media (folder)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_taken_at_idx ON media (taken_at DESC NULLS LAST)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_uploaded_idx ON media (uploaded_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_tags_idx     ON media USING gin (tags)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_status_idx   ON media (status) WHERE status <> 'ready'`);
  // @ai-note media_folders is the SINGLE source of truth for the folder tree.
  // Every write that sets a `folder` also upserts the folder row and its
  // ancestors — deliberately avoiding a "folder exists if a row OR any
  // media.folder starts with it" union rule, which is two sources of truth and
  // a bug farm.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_folders (
      path       text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // @ai-note import_jobs (issue #92) is OPERATIONAL state, not content: the
  // progress and outcome of WordPress imports, so GET /import/status can tell
  // the truth across a restart. Deliberately excluded from the DB backup and
  // untouched by restore; pruned to the newest rows on insert (import-jobs.ts).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_jobs (
      id          uuid PRIMARY KEY,
      status      text NOT NULL CHECK (status IN ('running','done','failed','interrupted')),
      started_by  text NOT NULL,
      started_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      progress    jsonb NOT NULL,
      summary     jsonb,
      error       text
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS import_jobs_started_idx ON import_jobs (started_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      key TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_identity (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
      seed_source text NOT NULL CHECK (seed_source IN ('neutral','legacy','restored-legacy')),
      saved_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      site_name text NOT NULL DEFAULT '' CHECK (char_length(site_name) <= 80),
      author_name text NOT NULL DEFAULT '' CHECK (char_length(author_name) <= 80),
      canonical_origin text CHECK (canonical_origin IS NULL OR char_length(canonical_origin) <= 300),
      localized jsonb NOT NULL DEFAULT '{}',
      social_links jsonb NOT NULL DEFAULT '[]'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_identity_assets (
      role text PRIMARY KEY CHECK (role IN ('logo','favicon-32','favicon-192','apple-touch-180')),
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      width integer NOT NULL CHECK (width BETWEEN 1 AND 1024),
      height integer NOT NULL CHECK (height BETWEEN 1 AND 1024),
      bytes bytea NOT NULL CHECK (octet_length(bytes) <= 262144),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // --- column migrations -----------------------------------------------------
  // @ai-note Schema evolution convention (issue #32): `CREATE TABLE IF NOT
  // EXISTS` silently no-ops on a database that already has the table, so a
  // column added only to a CREATE TABLE above never reaches existing
  // deployments — every query naming it then fails at runtime. Every new
  // column MUST therefore land in BOTH places:
  //   1. the table's CREATE TABLE statement above (fresh installs), and
  //   2. a matching statement appended in this section (existing databases),
  //      e.g. (illustrative only — not a real column):
  //        await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS example_col text`);
  // Rules: statements must stay idempotent — ensureSchema runs on every boot
  // (uploader/src/main.ts) — and NOT NULL columns MUST carry a DEFAULT, or
  // the ALTER fails on populated tables. Never edit or reorder past
  // migrations; only append. No migration framework / schema_version table
  // by design — see ARCHITECTURE.md "Data model (Postgres)".

  // @ai-note Identity invariant (issue #106): a post pair is exactly one row
  // per (translation_key, locale). pgPostStore.upsertDraft writes by that key
  // (UPDATE ... WHERE translation_key AND locale), so a slug rename can no
  // longer leave the old-slug row behind; this unique index makes the
  // invariant hold at the schema level too. Databases written before #106 may
  // already carry duplicate rows — CREATE UNIQUE INDEX would fail the whole
  // boot on them, and deleting rows here is out of the question (Golden Rule
  // 3: never wipe data automatically). So: report and skip, never delete.
  const dupes = await pool.query<{ translation_key: string; locale: string; n: number }>(
    `SELECT translation_key, locale, count(*)::int AS n FROM posts GROUP BY translation_key, locale HAVING count(*) > 1`,
  );
  if (dupes.rows.length > 0) {
    for (const d of dupes.rows) {
      console.error(`[db] posts has ${d.n} rows for (translation_key=${d.translation_key}, locale=${d.locale})`);
    }
    console.error(
      '[db] posts_tk_locale_idx was NOT created: duplicate (translation_key, locale) rows exist. ' +
      'Resolve them first — DELETE /posts/:tk drops every row for a key, or by hand keep the row with the newest updated_at per pair — then restart.',
    );
  } else {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS posts_tk_locale_idx ON posts (translation_key, locale)`);
  }

  // @ai-note Empty slug = unset (issue #119). posts_locale_slug_idx predates
  // the WHERE clause on databases created before #119; the non-partial form
  // treats '' as a real slug and rejects the second DE-first draft. Swap it in
  // one transaction so a crash between DROP and CREATE cannot leave the slug
  // backstop missing. Idempotent: a partial index is left alone. Nothing to
  // reconcile — the old index already guaranteed at most one '' row per locale.
  const slugIdx = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'posts' AND indexname = 'posts_locale_slug_idx'`,
  );
  if (slugIdx.rows[0] && !/\bWHERE\b/i.test(slugIdx.rows[0].indexdef)) {
    await pool.query(
      `BEGIN;
       DROP INDEX posts_locale_slug_idx;
       CREATE UNIQUE INDEX posts_locale_slug_idx ON posts (locale, slug) WHERE slug <> '';
       COMMIT`,
    );
  }

  // Image conversion profiles are snapped per media row. NULL is the legacy
  // AVIF+WebP/default-quality state, so existing rows need no rewrite.
  await pool.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS format text`);
  await pool.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS encoding jsonb`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'media'::regclass AND conname = 'media_format_check'
      ) THEN
        ALTER TABLE media ADD CONSTRAINT media_format_check CHECK (format IS NULL OR format = 'jpeg');
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'media'::regclass AND conname = 'media_encoding_check'
      ) THEN
        ALTER TABLE media ADD CONSTRAINT media_encoding_check
          CHECK (format IS NULL OR COALESCE(encoding ->> 'convertJpeg' = 'false', false));
      END IF;
    END $$;
  `);

  // @ai-note Reader comments (spec 2026-09-14-comments-design.md, phase 1).
  // Per-post toggle is SHARED across the pair (written to both locale rows by
  // upsertDraft); NOT NULL DEFAULT true so existing rows need no rewrite. The
  // site-wide gate is settings.commentsEnabled (default false).
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS comments_enabled boolean NOT NULL DEFAULT true`);
  // Keyed by (translation_key, locale) like posts; no FK because posts has no
  // single-column key for a pair. pgPostStore.remove deletes a post's comments
  // in the same transaction, and the sweep below removes orphans at boot.
  // Columns map onto the spec's names: `locale` = posted_locale, `name` =
  // author_name (kept under the names the public/admin routes already bind).
  // `email` is legacy and always NULL — the store never writes it; `sender_hash`
  // is a keyed HMAC of the IP (never the raw IP) for rate limiting only.
  // @ai-warning The status CHECK is WRITE-ONCE (see the media note): the first
  // deployment of this table carried IN ('pending','approved'), so the
  // 4-value constraint is installed by the named-constraint swap below, and
  // any later widening must go through the same swap, not this CREATE TABLE.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id              uuid PRIMARY KEY,
      translation_key text NOT NULL,
      locale          text NOT NULL CHECK (locale IN ('de','en')),
      name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      email           text,
      body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
      status          text NOT NULL DEFAULT 'pending',
      is_author       boolean NOT NULL DEFAULT false,
      sender_hash     text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT comments_status_check CHECK (status IN ('pending','approved','rejected','spam'))
    )
  `);
  // Legacy table shape (first cut of #204): no is_author, a two-value inline
  // status CHECK (auto-named comments_status_check by Postgres). Both are
  // brought up to date idempotently; the swap runs in one transaction so a
  // crash can never leave the table without a status constraint.
  await pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_author boolean NOT NULL DEFAULT false`);
  await pool.query(`
    DO $$
    DECLARE def text;
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
       WHERE conrelid = 'comments'::regclass AND conname = 'comments_status_check';
      IF def IS NULL OR def NOT LIKE '%rejected%' OR def NOT LIKE '%spam%' THEN
        IF def IS NOT NULL THEN
          ALTER TABLE comments DROP CONSTRAINT comments_status_check;
        END IF;
        ALTER TABLE comments ADD CONSTRAINT comments_status_check
          CHECK (status IN ('pending','approved','rejected','spam'));
      END IF;
    END $$;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS comments_post_idx ON comments (translation_key, locale, status, created_at)`);
  // Moderation queue: "all pending, newest first" across every post.
  await pool.query(`CREATE INDEX IF NOT EXISTS comments_status_idx ON comments (status, created_at)`);
  // Orphan sweep (M13): comments whose post is gone — e.g. a dump restored
  // over a database whose posts it no longer contains. No-op when consistent.
  await pool.query(`DELETE FROM comments c WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.translation_key = c.translation_key)`);

  // @ai-note Region set widening (spec 2026-10-19-new-regions-design.md §4).
  // The region CHECK is WRITE-ONCE like the media/comments ones: databases
  // created before 2026-10-19 carry the three-value IN list (auto-named
  // posts_region_check). The lookup is by table and definition, not by name,
  // so a differently named check is replaced too rather than left in place
  // beside the new one. One DO block = one transaction: the table is never
  // without a region check, and a failure aborts boot loudly. Idempotent: a
  // single posts_region_check that already admits every region is left alone,
  // so repeated boots do not churn. Only widens — no row is rewritten.
  const allowsEveryRegion = REGIONS.map((r) => `pg_get_constraintdef(oid) LIKE '%''${r}''%'`).join(' AND ');
  await pool.query(`
    DO $$
    DECLARE
      con record;
      n integer;
      up_to_date boolean;
    BEGIN
      SELECT count(*), coalesce(bool_and(conname = 'posts_region_check' AND ${allowsEveryRegion}), false)
        INTO n, up_to_date
        FROM pg_constraint
       WHERE conrelid = 'posts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%region%';
      IF n = 1 AND up_to_date THEN
        RETURN;
      END IF;
      FOR con IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'posts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%region%'
      LOOP
        EXECUTE format('ALTER TABLE posts DROP CONSTRAINT %I', con.conname);
      END LOOP;
      ALTER TABLE posts ADD CONSTRAINT posts_region_check CHECK (region IN (${REGION_SQL_LIST}));
    END $$;
  `);

  // Language metadata is content identity: never replace this singleton on boot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_language (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      primary_locale text NOT NULL CHECK (primary_locale IN ('de','en')),
      enabled_locales text[] NOT NULL CHECK (
        cardinality(enabled_locales) BETWEEN 1 AND 2
        AND enabled_locales <@ ARRAY['de','en']::text[]
        AND (cardinality(enabled_locales) = 1 OR enabled_locales[1] <> enabled_locales[2])
        AND array_position(enabled_locales, NULL) IS NULL),
      locked_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (primary_locale = ANY(enabled_locales))
    )
  `);
  await pool.query(`INSERT INTO site_language (primary_locale, enabled_locales, locked_at)
    VALUES ('de', ARRAY['de','en'], (SELECT min(published_at) FROM posts)) ON CONFLICT DO NOTHING`);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS omitted boolean NOT NULL DEFAULT false`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='posts'::regclass AND conname='posts_omitted_unpublished') THEN
      ALTER TABLE posts ADD CONSTRAINT posts_omitted_unpublished
        CHECK (NOT omitted OR (status='draft' AND published_snapshot IS NULL AND published_at IS NULL));
    END IF;
  END $$`);
  // Operational write evidence is deliberately excluded from snapshots and dumps.
  await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS last_save_id uuid');
  await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS last_save_by uuid');
  await pool.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS last_save_id uuid');
  await pool.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS last_save_by uuid');
  await ensureOnboardingSchema(pool);
}
