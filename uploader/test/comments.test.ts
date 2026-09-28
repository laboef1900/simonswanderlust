import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTHOR_NAME, BODY_MAX, COMMENT_STATUSES, CommentError, NAME_MAX, isCommentStatus, memoryCommentStore,
} from '../src/comments.js';
import { memoryPostStore } from '../src/posts.js';
import { DUMP_VERSION, SUPPORTED_DUMP_VERSIONS, readDump } from '../src/backup.js';

const base = { translationKey: 'tk-1', locale: 'de' as const, name: 'Reader', body: 'Hello there' };

describe('comment store (#204, memory)', () => {
  it('create always yields a pending, non-author row and never stores the email', async () => {
    const s = memoryCommentStore();
    const c = await s.create({ ...base, email: 'r@example.com', ...({ status: 'approved', isAuthor: true } as object) });
    expect(c).toMatchObject({ status: 'pending', isAuthor: false, email: null, name: 'Reader', locale: 'de' });
    expect(s.all()[0]?.email).toBeNull();
    expect(await s.listApproved('tk-1')).toEqual([]);
  });

  it('validates the email shape even though it is discarded', async () => {
    const s = memoryCommentStore();
    await expect(s.create({ ...base, email: 'nope' })).rejects.toThrow(CommentError);
    await expect(s.create({ ...base, email: '' })).resolves.toMatchObject({ email: null });
  });

  it('rejects an unknown locale and an empty translation key', async () => {
    const s = memoryCommentStore();
    await expect(s.create({ ...base, locale: 'fr' as never })).rejects.toThrow(/locale/);
    await expect(s.create({ ...base, translationKey: '' })).rejects.toThrow(/translationKey/);
  });

  it('strips control characters before the length check and enforces 80/2000 caps', async () => {
    const s = memoryCommentStore();
    const c = await s.create({ ...base, name: '\u200b Ada \u0000', body: ' a\r\nb \u0007 ' });
    expect(c.name).toBe('Ada');
    expect(c.body).toBe('a\nb');
    await expect(s.create({ ...base, name: 'x'.repeat(NAME_MAX + 1) })).rejects.toThrow(CommentError);
    await expect(s.create({ ...base, body: 'x'.repeat(BODY_MAX + 1) })).rejects.toThrow(CommentError);
    await expect(s.create({ ...base, body: '\u0000\u0001' })).rejects.toThrow(CommentError);
    await expect(s.create({ ...base, name: 42 as never })).rejects.toThrow(CommentError);
  });

  it('listApproved returns only approved rows, oldest first, optionally per posted locale', async () => {
    const s = memoryCommentStore();
    const a = await s.create({ ...base, body: 'one' });
    const b = await s.create({ ...base, locale: 'en', body: 'two' });
    await s.create({ ...base, body: 'never approved' });
    await s.create({ ...base, translationKey: 'other', body: 'other thread' });
    expect(await s.approve(a.id)).toBe(true);
    expect(await s.approve(b.id)).toBe(true);
    expect((await s.listApproved('tk-1')).map((c) => c.body)).toEqual(['one', 'two']);
    expect((await s.listApproved('tk-1', 'en')).map((c) => c.body)).toEqual(['two']);
    expect((await s.listApproved('tk-1'))[0]).toEqual({ id: a.id, name: 'Reader', body: 'one', isAuthor: false, createdAt: a.createdAt });
    expect(Object.keys((await s.listApproved('tk-1'))[0]!)).not.toContain('senderHash');
  });

  it('listForAdmin defaults to the pending queue, newest first, with status filter and paging', async () => {
    const s = memoryCommentStore();
    const a = await s.create({ ...base, body: 'a' });
    const b = await s.create({ ...base, body: 'b' });
    const c = await s.create({ ...base, translationKey: 'other', body: 'c' });
    await s.setStatus(b.id, 'spam');
    expect((await s.listForAdmin()).map((x) => x.id)).toEqual([c.id, a.id]);
    expect((await s.listForAdmin({ status: 'spam' })).map((x) => x.id)).toEqual([b.id]);
    expect((await s.listForAdmin({ translationKey: 'other' })).map((x) => x.id)).toEqual([c.id]);
    expect((await s.listForAdmin({ limit: 1, offset: 1 })).map((x) => x.id)).toEqual([a.id]);
    await expect(s.listForAdmin({ status: 'published' as never })).rejects.toThrow(/invalid status/);
    await expect(s.listForAdmin({ limit: 0 })).rejects.toThrow(/limit/);
    await expect(s.listForAdmin({ limit: 201 })).rejects.toThrow(/limit/);
    await expect(s.listForAdmin({ offset: -1 })).rejects.toThrow(/offset/);
  });

  it('setStatus accepts exactly the four moderation states', async () => {
    const s = memoryCommentStore();
    const c = await s.create(base);
    expect(COMMENT_STATUSES).toEqual(['pending', 'approved', 'rejected', 'spam']);
    for (const st of COMMENT_STATUSES) {
      expect(await s.setStatus(c.id, st)).toBe(true);
      expect(s.all()[0]?.status).toBe(st);
    }
    await expect(s.setStatus(c.id, 'deleted' as never)).rejects.toThrow(/invalid status/);
    expect(await s.setStatus('missing', 'approved')).toBe(false);
    expect(isCommentStatus('spam')).toBe(true);
    expect(isCommentStatus('published')).toBe(false);
  });

  it('replyAsAuthor inserts an approved author sibling in the thread', async () => {
    const s = memoryCommentStore();
    const r = await s.replyAsAuthor({ translationKey: 'tk-1', body: 'Thanks!' });
    expect(r).toMatchObject({ status: 'approved', isAuthor: true, name: AUTHOR_NAME, locale: 'de', email: null });
    const en = await s.replyAsAuthor({ translationKey: 'tk-1', body: 'Cheers', postedLocale: 'en' });
    expect(en.locale).toBe('en');
    expect((await s.listApproved('tk-1')).map((c) => c.isAuthor)).toEqual([true, true]);
    await expect(s.replyAsAuthor({ translationKey: 'tk-1', body: '' })).rejects.toThrow(CommentError);
  });

  it('remove and removeByTranslationKey', async () => {
    const s = memoryCommentStore();
    const a = await s.create(base);
    await s.create(base);
    await s.create({ ...base, translationKey: 'other' });
    expect(await s.remove(a.id)).toBe(true);
    expect(await s.remove(a.id)).toBe(false);
    expect(await s.removeByTranslationKey('tk-1')).toBe(1);
    expect(await s.removeByTranslationKey('tk-1')).toBe(0);
    expect(s.all().map((c) => c.translationKey)).toEqual(['other']);
  });
});

describe('delete-with-post (memory post store)', () => {
  const pair = {
    translationKey: '', status: 'draft' as const,
    shared: { date: '2026-03-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 45, lng: 25 } },
    de: { locale: 'de' as const, slug: 'a-de', title: 'A', excerpt: 'x', country: 'X', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'b', images: {} },
    en: { locale: 'en' as const, slug: 'a-en', title: 'A', excerpt: 'x', country: 'X', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'b', images: {} },
  };

  it('removing a post drops its whole thread and nothing else', async () => {
    const comments = memoryCommentStore();
    const posts = memoryPostStore({ comments });
    const p = await posts.upsertDraft(pair);
    await comments.create({ ...base, translationKey: p.translationKey });
    await comments.replyAsAuthor({ translationKey: p.translationKey, body: 'r' });
    await comments.create({ ...base, translationKey: 'someone-else' });
    await posts.remove(p.translationKey);
    expect(comments.all().map((c) => c.translationKey)).toEqual(['someone-else']);
    expect(await posts.get(p.translationKey)).toBeNull();
  });

  it('works without a comment store (backward compatible signature)', async () => {
    const posts = memoryPostStore();
    const p = await posts.upsertDraft(pair);
    await expect(posts.remove(p.translationKey)).resolves.toBeUndefined();
  });

  it('commentsEnabled: omitted reads back true, an explicit false survives get()', async () => {
    const posts = memoryPostStore();
    const on = await posts.upsertDraft(pair);
    expect((await posts.get(on.translationKey))?.shared.commentsEnabled).toBe(true);
    const off = await posts.upsertDraft({ ...pair, de: { ...pair.de, slug: 'b-de' }, en: { ...pair.en, slug: 'b-en' }, shared: { ...pair.shared, commentsEnabled: false } });
    expect((await posts.get(off.translationKey))?.shared.commentsEnabled).toBe(false);
  });
});

describe('dump version allow-list (#204 → v8)', () => {
  it('DUMP_VERSION is 8 and every version up to it is accepted; the next one is not', async () => {
    expect(DUMP_VERSION).toBe(8);
    expect(SUPPORTED_DUMP_VERSIONS).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const dir = await mkdtemp(join(tmpdir(), 'dumpv-'));
    const file = async (version: number) => {
      const f = join(dir, `db-2026010${version}-000000.json.gz`);
      await writeFile(f, gzipSync(JSON.stringify({ version, createdAt: new Date().toISOString(), tables: { users: [], posts: [] } })));
      return f;
    };
    for (const v of SUPPORTED_DUMP_VERSIONS) expect(readDump(await file(v)).version).toBe(v);
    expect(() => readDump(join(dir, 'x'))).toThrow();
    const next = await file(DUMP_VERSION + 1);
    expect(() => readDump(next)).toThrow(/unsupported dump version 9/);
  });
});
