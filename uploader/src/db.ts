import pg from 'pg';

const { Pool } = pg;
export type DbPool = pg.Pool;

const ABOUT_SEED = {
  de: {
    title: 'Über mich',
    body: 'Hier teile ich meine Leidenschaft fürs Reisen — Geschichten und Erinnerungen von den belebten Straßen Europas bis zu den geheimnisvollen Pfaden Südamerikas. Der vollständige Über-mich-Text wird in Phase 2 von der bestehenden Seite migriert.',
  },
  en: {
    title: 'About me',
    body: 'Here I share my passion for travelling — stories and memories from the bustling streets of Europe to the mysterious trails of South America. The full about text will be migrated from the existing site in Phase 2.',
  },
};

export function createPool(connectionString: string): DbPool {
  return new Pool({ connectionString });
}

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
  'stops', stops, 'route', route, 'key_facts', key_facts,
  'body_markdown', body_markdown, 'images', images
)`;

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
      region text NOT NULL CHECK (region IN ('europe','north-america','south-america')),
      excerpt text NOT NULL, hero_image jsonb NOT NULL, coordinates jsonb NOT NULL,
      stops jsonb, route text, key_facts jsonb, body_markdown text NOT NULL,
      images jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS posts_locale_slug_idx ON posts (locale, slug)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_translation_key_idx ON posts (translation_key)`);
  // @ai-note published_snapshot separates the LIVE content from the working
  // copy: publish() copies the row's working columns into it, and the site
  // loader (site/src/lib/postgres-loader.ts) builds ONLY from snapshots — so a
  // draft save over a published post can never leak onto the public site via
  // an unrelated rebuild (issue #20). Additive, idempotent migration.
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS published_snapshot jsonb`);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS published_at timestamptz`);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pages (
      key           text NOT NULL,
      locale        text NOT NULL CHECK (locale IN ('de','en')),
      title         text NOT NULL DEFAULT '',
      body_markdown text NOT NULL DEFAULT '',
      images        jsonb NOT NULL DEFAULT '{}',
      updated_at    timestamptz NOT NULL DEFAULT now(),
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
}
