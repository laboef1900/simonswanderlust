import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db.js';
import { pgLanguageStore, type LanguageConfig } from '../src/language.js';
import { pgPostStore, type PostLocale } from '../src/posts.js';
import { importWxr } from '../src/wp-import.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const modes: LanguageConfig[] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];

maybe('WXR reserved slug grandfathering (PostgreSQL)', () => {
  it.each(modes)('reimports the exact existing identity without renaming its reserved slug in %j', async (language) => {
    const schema = `import_language_${randomUUID().replaceAll('-', '')}`;
    const owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    try {
      await ensureSchema(pool);
      await pgLanguageStore(pool).update(language);
      const posts = pgPostStore(pool);
      const locale = (locale: 'de' | 'en'): PostLocale => ({
        locale, slug: language.locales.includes(locale) ? `original-${locale}` : '',
        title: locale === language.primary ? 'Author title' : 'Translation', country: '', excerpt: '',
        heroImage: { src: '', width: 0, height: 0, alt: '' },
        bodyMarkdown: 'Author body', images: {}, omitted: !language.locales.includes(locale),
      });
      const saved = await posts.upsertDraft({ translationKey: '', status: 'draft',
        shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
        de: locale('de'), en: locale('en'),
      });
      // Represent an unchanged pre-reservation row in this test's isolated schema.
      await pool.query('UPDATE posts SET slug=$1 WHERE translation_key=$2 AND locale=$3', ['posts', saved.translationKey, language.primary]);
      const xml = `<rss><channel>${language.locales.map((loc) => `<item>
        <title>Export title</title><wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
        <wp:post_name>${loc === language.primary ? 'posts' : `original-${loc}`}</wp:post_name>
        <wp:post_date>2026-01-01 00:00:00</wp:post_date>
        <content:encoded><![CDATA[<p>Export body</p><img src="https://wp.example/photo.jpg" alt="Photo">]]></content:encoded>
        <category domain="language" nicename="${loc}">${loc}</category>
        <category domain="post_translations" nicename="existing">existing</category>
        </item>`).join('')}</channel></rss>`;
      for (const overwriteDrafts of [false, true]) {
        let fetches = 0;
        const summary = await importWxr(xml, { language, postStore: posts, storageDir: '/tmp', baseUrl: 'https://images.test',
          overwriteDrafts, log: () => {}, rehost: async () => {
            fetches++;
            return { src: 'https://images.test/photo', width: 640, height: 480 };
          },
        });
        expect(summary).toMatchObject({ imported: 0, updated: 1, rejected: 0, failed: 0 });
        expect(fetches).toBe(1);
        const current = (await posts.get(saved.translationKey))!;
        expect(current[language.primary].slug).toBe('posts');
        expect(current[language.primary].title).toBe(overwriteDrafts ? 'Export title' : 'Author title');
        expect(await posts.list()).toHaveLength(1);
      }
    } finally {
      await pool.end();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      await owner.end();
    }
  });
});
