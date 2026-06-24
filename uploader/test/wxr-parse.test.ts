import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWxr } from '../src/wxr-parse.js';

const xml = readFileSync(join(process.cwd(), 'test/fixtures/wxr-sample.xml'), 'utf8');

describe('parseWxr', () => {
  it('extracts only published posts, paired DE/EN, with fields', () => {
    const { posts, attachments } = parseWxr(xml);
    expect(posts).toHaveLength(2); // the draft is excluded
    const de = posts.find((p) => p.locale === 'de')!;
    expect(de).toMatchObject({ group: 'pll_grp1', slug: 'rhodos-abenteuer', title: 'Rhodos Abenteuer', date: '2021-07-25', excerpt: 'Kurzfassung DE', thumbnailId: '100' });
    expect(de.contentHtml).toContain('<h2>Überschrift</h2>');
    expect(posts.find((p) => p.locale === 'en')!.slug).toBe('rhodes-adventure');
    expect(attachments.get('100')).toBe('https://wp.example/uploads/hero.jpg');
  });
});
