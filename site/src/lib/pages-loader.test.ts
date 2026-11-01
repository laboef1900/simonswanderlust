import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { postgresPagesLoader, rowToPageEntry } from './pages-loader';
import { renderMarkdown } from './render-markdown';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { visit } from 'unist-util-visit';
import { ABOUT_BODY_SIZES } from './body-images.js';

const BILINGUAL = { primary_locale: 'de', enabled_locales: ['de', 'en'] };
const db = vi.hoisted(() => ({
  language: { primary_locale: 'de', enabled_locales: ['de', 'en'] },
  rows: null as Record<string, unknown>[] | null,
  sql: [] as string[],
  released: false,
}));
vi.mock('pg', () => ({ default: { Pool: class {
  async connect() {
    return {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
        db.sql.push(sql);
        if (sql.includes('FROM site_language')) return { rows: [db.language] };
        if (sql.includes('FROM pages')) return { rows: db.rows ?? ['de', 'en'].map((locale) => ({
          key: 'about', slug: '', status: 'published', locale, title: locale, body_markdown: `${locale} private draft if inactive`, images: {},
        })) };
        return { rows: [] };
      },
      release(): void { db.released = true; },
    };
  }
  async end(): Promise<void> {}
} } }));

afterEach(() => {
  vi.unstubAllEnvs();
  db.sql = []; db.rows = null; db.released = false;
  db.language = { ...BILINGUAL };
});

describe('rowToPageEntry', () => {
  it('maps a page row to a content entry input', () => {
    const out = rowToPageEntry({
      key: 'about', slug: '', locale: 'de', title: 'Über mich',
      body_markdown: 'Hallo', images: { 'https://img/x': { width: 800, height: 600 } },
    }, 'https://img');
    expect(out).toEqual({
      id: 'about/de',
      body: 'Hallo',
      images: { 'https://img/x': { width: 800, height: 600 } },
      data: { key: 'about', slug: '', locale: 'de', title: 'Über mich' },
    });
  });

  it('defaults images to {} when null', () => {
    const out = rowToPageEntry({ key: 'about', slug: '', locale: 'en', title: 'About me', body_markdown: 'Hi', images: null }, 'https://img');
    expect(out.images).toEqual({});
    expect(out.id).toBe('about/en');
  });
  it('re-points the page\'s image URLs at the configured host, so one row renders anywhere', () => {
    const out = rowToPageEntry(
      {
        key: 'about', slug: '', locale: 'de', title: 'Über mich',
        body_markdown: '```gallery\nhttp://localhost:3000/pages/about/a\n```',
        images: { 'http://localhost:3000/pages/about/a': { width: 8, height: 6, format: 'jpeg' as const } },
      },
      'https://img.example.com',
    );
    expect(Object.keys(out.images)).toEqual(['https://img.example.com/pages/about/a']);
    expect(out.body).toContain('https://img.example.com/pages/about/a');
    expect(out.images['https://img.example.com/pages/about/a']?.format).toBe('jpeg');
  });
});

describe('enabled About projection', () => {
  it.each(['de', 'en'] as const)('does not parse or render retained inactive About content in %s-only mode', async (locale) => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('SITE_LANGUAGE_JSON', JSON.stringify({ primary: locale, locales: [locale] }));
    vi.stubEnv('SITE_DATABASE_SNAPSHOT', '00000003-0000000A-1');
    db.language = { primary_locale: locale, enabled_locales: [locale] };
    const set = vi.fn();
    const parseData = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const renderMarkdown = vi.fn(async (body: string) => ({ html: `<p>${body}</p>` }));
    await postgresPagesLoader().load({
      store: { clear: vi.fn(), set }, parseData, renderMarkdown, logger: { info: vi.fn() },
    } as unknown as Parameters<Loader['load']>[0]);
    expect(parseData).toHaveBeenCalledOnce();
    expect(parseData.mock.calls[0]![0].data.title).toBe(locale);
    expect(renderMarkdown).toHaveBeenCalledExactlyOnceWith(`${locale} private draft if inactive`);
    expect(set.mock.calls[0]![0].id).toBe(`about/${locale}`);
    expect(db.sql[1]).toBe("SET TRANSACTION SNAPSHOT '00000003-0000000A-1'");
  });
  it('refuses a standalone mode/content race before reading private page fields', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('SITE_LANGUAGE_JSON', '{"primary":"de","locales":["de","en"]}');
    db.language = { primary_locale: 'de', enabled_locales: ['de'] };
    await expect(postgresPagesLoader().load({
      store: { clear: vi.fn() },
    } as unknown as Parameters<Loader['load']>[0])).rejects.toThrow('Site language changed');
    expect(db.sql.some((sql) => sql.includes('FROM pages'))).toBe(false);
    expect(db.sql.at(-1)).toBe('ROLLBACK');
  });
});

describe('published page renderer trust boundary', () => {
  async function load(body: string, images: unknown = {}) {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://img.example');
    vi.stubEnv('SITE_LANGUAGE_JSON', '{"primary":"de","locales":["de"]}');
    db.language = { primary_locale: 'de', enabled_locales: ['de'] };
    db.rows = [{ key: 'contact', locale: 'de', status: 'published', slug: 'kontakt', title: 'Contact', body_markdown: body, images }];
    const set = vi.fn();
    await postgresPagesLoader().load({
      store: { clear: vi.fn(), set }, parseData: async ({ data }: { data: unknown }) => data,
      renderMarkdown: async (markdown: string) => ({ html: await renderMarkdown(markdown) }), logger: { info: vi.fn() },
    } as unknown as Parameters<Loader['load']>[0]);
    return set.mock.calls[0]![0];
  }
  it.each(['![x](https://foreign.example/x)', '```gallery\nhttps://foreign.example/x\n```',
    '<picture><source srcset="https://foreign.example/a 1x"><img src="https://img.example/photo"></picture>',
    '![x](//foreign.example/x)'])('refuses restored foreign image markup %s', async (body) => {
    await expect(load(body)).rejects.toThrow('Unsafe published page images: contact/de');
  });
  it('re-points a registered image at this host instead of loading its stored origin', async () => {
    // The stored origin is advisory (retargetImageOrigins): portability can only move a
    // registered image onto this host, never introduce a foreign load.
    const entry = await load('![x](https://foreign.example/x)', { 'https://foreign.example/x': { width: 640, height: 480 } });
    expect(entry.rendered.html).not.toContain('foreign.example');
    expect(entry.rendered.html).toContain('https://img.example/x-640.webp');
  });
  it('renders through sanitizer and guarded responsive pictures, not untrusted HTML', async () => {
    const entry = await load('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![Photo](https://img.example/photo)',
      { 'https://img.example/photo': { width: 640, height: 480 } });
    expect(entry.rendered.html).not.toContain('<script');
    expect(entry.rendered.html).not.toContain('javascript:');
    expect(entry.rendered.html).toContain('<picture data-body-image');
    expect(entry.rendered.html).toContain('https://img.example/photo-640.webp');
  });
});

describe('page prose metadata', () => {
  it.each([
    {
      body: '![Portrait](https://img.example/portrait)\nIch bin **Simon** und reise seit 2015.',
      expected: 'Ich bin Simon und reise seit 2015.',
    },
    {
      body: 'I travel ![Portrait](https://img.example/portrait) with **curiosity**.',
      expected: 'I travel with curiosity.',
    },
    { body: '![Portrait](https://img.example/portrait)', expected: '' },
  ])('retains prose beside a responsive image: $expected', async ({ body, expected }) => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://img.example');
    vi.stubEnv('SITE_LANGUAGE_JSON', '{"primary":"de","locales":["de","en"]}');
    db.rows = [{
      key: 'about', slug: '', status: 'published', locale: 'de', title: 'About',
      body_markdown: body,
      images: { 'https://img.example/portrait': { width: 1600, height: 1000 } },
    }];
    type StoredEntry = { id: string; data: Record<string, unknown>; rendered: { html: string } };
    const entries = new Map<string, StoredEntry>();
    const ctx = {
      store: {
        clear: () => entries.clear(),
        set: (entry: StoredEntry) => { entries.set(entry.id, entry); return true; },
      },
      parseData: async ({ data }: { data: Record<string, unknown> }) => data,
      renderMarkdown: async (markdown: string) => ({ html: await renderMarkdown(markdown) }),
      logger: { info() {} },
    };
    await postgresPagesLoader().load(ctx as unknown as Parameters<Loader['load']>[0]);
    expect(entries.get('about/de')?.data.description).toBe(expected);
    expect(db.sql).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SELECT primary_locale, enabled_locales FROM site_language WHERE id = true',
      'SELECT key, locale, slug, status, title, body_markdown, images FROM pages WHERE status = $1 AND key = ANY($2::text[]) AND locale = ANY($3::text[])',
      'COMMIT',
    ]);
    expect(db.released).toBe(true);
  });
});

describe('postgresPagesLoader load()', () => {
  it('builds localized decorative gallery names for both About locales before any script runs', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://img');
    vi.stubEnv('SITE_LANGUAGE_JSON', '{"primary":"de","locales":["de","en"]}');
    const src = 'http://localhost:3000/pages/about/photo';
    db.rows = ['de', 'en'].map((locale) => ({
      key: 'about', slug: '', status: 'published', locale, title: 'About',
      body_markdown: `![About photo](${src})\n\n\`\`\`gallery\n${src}\n${src}\n\`\`\``,
      images: { [src]: { width: 1600, height: 1000, alt: '', caption: '' } },
    }));
    const entries = new Map<string, string>();
    const context = {
      store: {
        clear: () => entries.clear(),
        set: (entry: { id: string; rendered: { html: string } }) => {
          entries.set(entry.id, entry.rendered.html);
          return true;
        },
      },
      parseData: async ({ data }: { data: Record<string, unknown> }) => data,
      renderMarkdown: async (body: string) => ({ html: await renderMarkdown(body) }),
      logger: { info: () => { /* quiet */ } },
    } as unknown as Parameters<Loader['load']>[0];
    await postgresPagesLoader().load(context);
    for (const locale of ['de', 'en']) {
      const html = entries.get(`about/${locale}`) ?? '';
      expect(html).toContain(`aria-label="${locale === 'de' ? 'Foto 1 von 2 öffnen' : 'Open photo 1 of 2'}"`);
      expect(html).toContain(`aria-label="${locale === 'de' ? 'Foto 2 von 2 öffnen' : 'Open photo 2 of 2'}"`);
      expect(html).toContain('alt=""');
      expect(html).toContain('href="https://img/pages/about/photo-1600.webp"');
      let inlineSources = 0;
      visit(unified().use(rehypeParse, { fragment: true }).parse(html), 'element', node => {
        if (node.tagName !== 'picture' || !Object.hasOwn(node.properties, 'dataBodyImage')) return;
        for (const child of node.children) {
          if (child.type !== 'element' || child.tagName !== 'source') continue;
          expect(child.properties.sizes).toBe(ABOUT_BODY_SIZES);
          inlineSources++;
        }
      });
      expect(inlineSources).toBe(2);
    }
  });
});
