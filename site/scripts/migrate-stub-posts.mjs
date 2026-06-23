import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import pg from 'pg';

const CONTENT = join(process.cwd(), 'src/content/trips');

/** Convert MDX body to Markdown: <BodyImage .../> → ![alt](src), collecting {src:{width,height}}. */
export function mdxBodyToMarkdown(body) {
  const images = {};
  const markdown = body.replace(
    /<BodyImage\s+([^>]*?)\/>/g,
    (_m, attrs) => {
      const get = (name) => {
        const s = attrs.match(new RegExp(`${name}="([^"]*)"`));
        if (s) return s[1];
        const n = attrs.match(new RegExp(`${name}=\\{([^}]*)\\}`));
        return n ? n[1].trim() : undefined;
      };
      const src = get('src');
      const alt = get('alt') ?? '';
      const width = Number(get('width'));
      const height = Number(get('height'));
      if (src && Number.isFinite(width) && Number.isFinite(height)) images[src] = { width, height };
      return `![${alt}](${src})`;
    },
  );
  return { markdown, images };
}

/** Parse one MDX file into row fields. `locale` is supplied by the caller (folder). */
export function parseMdxFile(path, locale) {
  const raw = readFileSync(path, 'utf8');
  const { data, content } = matter(raw);
  const slug = path.split('/').pop().replace(/\.mdx$/, '');
  const { markdown, images } = mdxBodyToMarkdown(content.trim());
  return { locale, slug, data, bodyMarkdown: markdown, images };
}

function rowsFromDisk() {
  const rows = [];
  for (const locale of ['de', 'en']) {
    const dir = join(CONTENT, locale);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.mdx'))) {
      rows.push(parseMdxFile(join(dir, file), locale));
    }
  }
  return rows;
}

export async function migrate(connectionString) {
  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS posts (
      id uuid PRIMARY KEY, translation_key text NOT NULL, locale text NOT NULL CHECK (locale IN ('de','en')),
      slug text NOT NULL, title text NOT NULL, date date NOT NULL, country text NOT NULL,
      country_code text NOT NULL CHECK (char_length(country_code)=2),
      region text NOT NULL CHECK (region IN ('europe','north-america','south-america')),
      excerpt text NOT NULL, hero_image jsonb NOT NULL, coordinates jsonb NOT NULL,
      stops jsonb, route text, key_facts jsonb, body_markdown text NOT NULL,
      images jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS posts_locale_slug_idx ON posts (locale, slug)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS posts_translation_key_idx ON posts (translation_key)`);
    const rows = rowsFromDisk();
    for (const r of rows) {
      const d = r.data;
      await pool.query(
        `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
           excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'published')
         ON CONFLICT (locale, slug) DO UPDATE SET
           translation_key=EXCLUDED.translation_key, title=EXCLUDED.title, date=EXCLUDED.date,
           country=EXCLUDED.country, country_code=EXCLUDED.country_code, region=EXCLUDED.region,
           excerpt=EXCLUDED.excerpt, hero_image=EXCLUDED.hero_image, coordinates=EXCLUDED.coordinates,
           stops=EXCLUDED.stops, route=EXCLUDED.route, key_facts=EXCLUDED.key_facts,
           body_markdown=EXCLUDED.body_markdown, images=EXCLUDED.images, status='published', updated_at=now()`,
        [randomUUID(), d.translationKey, r.locale, r.slug, d.title, d.date, d.country, d.countryCode,
         d.region, d.excerpt, JSON.stringify(d.heroImage), JSON.stringify(d.coordinates),
         d.stops ? JSON.stringify(d.stops) : null, d.route ?? null, d.keyFacts ? JSON.stringify(d.keyFacts) : null,
         r.bodyMarkdown, JSON.stringify(r.images)],
      );
    }
    return rows.length;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
  migrate(url).then((n) => console.log(`migrated ${n} post rows`)).catch((e) => { console.error(e); process.exit(1); });
}
