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

  // --- column migrations -----------------------------------------------------
  // @ai-note Schema evolution convention (issue #32): `CREATE TABLE IF NOT
  // EXISTS` silently no-ops on a database that already has the table, so a
  // column added only to a CREATE TABLE above never reaches existing
  // deployments — every query naming it then fails at runtime. Every new
  // column MUST therefore land in BOTH places:
  //   1. the table's CREATE TABLE statement above (fresh installs), and
  //   2. a matching statement appended in this section (existing databases),
  //      e.g.:
  //        await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS publish_at timestamptz`);
  // Rules: statements must stay idempotent — ensureSchema runs on every boot
  // (uploader/src/main.ts) — and NOT NULL columns MUST carry a DEFAULT, or
  // the ALTER fails on populated tables. Never edit or reorder past
  // migrations; only append. No migration framework / schema_version table
  // by design — see ARCHITECTURE.md "Data model (Postgres)".
}
