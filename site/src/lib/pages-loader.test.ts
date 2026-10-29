import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { postgresPagesLoader, rowToPageEntry } from './pages-loader';
import { renderMarkdown } from './render-markdown.js';

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      async query(): Promise<{ rows: Record<string, unknown>[] }> {
        return { rows: db.rows };
      }
      async end(): Promise<void> { /* released by the loader */ }
    },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  db.rows = [];
});

describe('postgresPagesLoader load()', () => {
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
