import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importWxr } from '../src/wp-import.js';
import { memoryPostStore } from '../src/posts.js';

const xml = readFileSync(join(process.cwd(), 'test/fixtures/wxr-sample.xml'), 'utf8');
const stubRehost = async (_url: string, _key: string, _alt: string) => ({ src: 'https://img/x', width: 100, height: 80 });

describe('importWxr', () => {
  it('creates a draft pair with preserved slugs, placeholders, and re-hosted images', async () => {
    const store = memoryPostStore();
    const s = await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    expect(s).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    const list = await store.list();
    const first = list[0]!;
    expect(first).toMatchObject({ slugDe: 'rhodos-abenteuer', slugEn: 'rhodes-adventure', status: 'draft' });
    const pair = await store.get(first.translationKey);
    expect(pair!.shared).toMatchObject({ date: '2021-07-25', country: '', countryCode: 'XX', region: 'europe' });
    expect(pair!.de.heroImage.src).toBe('https://img/x');
    expect(pair!.de.bodyMarkdown).toContain('## Überschrift');
    expect(pair!.de.bodyMarkdown).toContain('![Strand](https://img/x)'); // body image rewritten
    expect(pair!.de.images['https://img/x']).toEqual({ width: 100, height: 80 });
  });

  it('is idempotent (re-run updates, no duplicate) and skips published posts', async () => {
    const store = memoryPostStore();
    await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    const again = await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    expect(again).toMatchObject({ imported: 0, updated: 1 });
    expect(await store.list()).toHaveLength(1);
    // publish it, then re-import → skipped, content untouched
    const tk = (await store.list())[0]!.translationKey;
    await store.publish(tk);
    const third = await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    expect(third.skipped).toBe(1);
    expect(third.warnings.join(' ')).toMatch(/published/);
  });
});
