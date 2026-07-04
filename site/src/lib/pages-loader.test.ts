import { describe, expect, it } from 'vitest';
import { rowToPageEntry } from './pages-loader';

describe('rowToPageEntry', () => {
  it('maps a page row to a content entry input', () => {
    const out = rowToPageEntry({
      key: 'about', locale: 'de', title: 'Über mich',
      body_markdown: 'Hallo', images: { 'https://img/x': { width: 800, height: 600 } },
    });
    expect(out).toEqual({
      id: 'about/de',
      body: 'Hallo',
      images: { 'https://img/x': { width: 800, height: 600 } },
      data: { title: 'Über mich' },
    });
  });

  it('defaults images to {} when null', () => {
    const out = rowToPageEntry({ key: 'about', locale: 'en', title: 'About me', body_markdown: 'Hi', images: null });
    expect(out.images).toEqual({});
    expect(out.id).toBe('about/en');
  });
});
