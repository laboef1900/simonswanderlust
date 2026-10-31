import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { postgresPagesLoader, rowToPageEntry } from './pages-loader';
import { renderMarkdown } from './render-markdown';

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], statements: [] as string[], released: false }));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      async connect() {
        return {
          async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
            db.statements.push(sql);
            return { rows: sql.startsWith('SELECT ') ? db.rows : [] };
          },
          release(): void { db.released = true; },
        };
      }
      async end(): Promise<void> {}
    },
  },
}));

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

describe('page prose metadata', () => {
  afterEach(() => { vi.unstubAllEnvs(); db.rows = []; db.statements = []; db.released = false; });

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
    db.rows = [{
      key: 'about', locale: 'de', title: 'About',
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
    expect(db.statements).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SELECT key, locale, title, body_markdown, images FROM pages',
      'COMMIT',
    ]);
    expect(db.released).toBe(true);
  });
});

describe('postgresPagesLoader load()', () => {
  afterEach(() => { vi.unstubAllEnvs(); db.rows = []; db.statements = []; db.released = false; });

  it('builds localized decorative gallery names for both About locales before any script runs', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://img');
    const src = 'http://localhost:3000/pages/about/photo';
    db.rows = ['de', 'en'].map((locale) => ({
      key: 'about', locale, title: 'About',
      body_markdown: `\`\`\`gallery\n${src}\n${src}\n\`\`\``,
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
    }
  });
});
