import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { postgresPagesLoader, rowToPageEntry } from './pages-loader';

const db = vi.hoisted(() => ({
  language: { primary_locale: 'de', enabled_locales: ['de', 'en'] },
  sql: [] as string[],
}));
vi.mock('pg', () => ({ default: { Pool: class {
  async connect() { return this; }
  release() {}
  async end() {}
  async query(sql: string) {
    db.sql.push(sql);
    if (sql.includes('FROM site_language')) return { rows: [db.language] };
    if (sql.includes('FROM pages')) return { rows: ['de', 'en'].map((locale) => ({
      key: 'about', locale, title: locale, body_markdown: `${locale} private draft if inactive`, images: {},
    })) };
    return { rows: [] };
  }
} } }));

afterEach(() => {
  vi.unstubAllEnvs(); db.sql = [];
  db.language = { primary_locale: 'de', enabled_locales: ['de', 'en'] };
});

describe('rowToPageEntry', () => {
  it('maps a page row to a content entry input', () => {
    const out = rowToPageEntry({
      key: 'about', locale: 'de', title: 'Über mich',
      body_markdown: 'Hallo', images: { 'https://img/x': { width: 800, height: 600 } },
    }, 'https://img');
    expect(out).toEqual({
      id: 'about/de',
      body: 'Hallo',
      images: { 'https://img/x': { width: 800, height: 600 } },
      data: { title: 'Über mich' },
    });
  });

  it('defaults images to {} when null', () => {
    const out = rowToPageEntry({ key: 'about', locale: 'en', title: 'About me', body_markdown: 'Hi', images: null }, 'https://img');
    expect(out.images).toEqual({});
    expect(out.id).toBe('about/en');
  });
  it('re-points the page\'s image URLs at the configured host, so one row renders anywhere', () => {
    const out = rowToPageEntry(
      {
        key: 'about', locale: 'de', title: 'Über mich',
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
