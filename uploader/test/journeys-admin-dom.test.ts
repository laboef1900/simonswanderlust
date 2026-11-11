import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerJourneyAdmin } from '../src/journeys-admin.js';
import { memoryJourneyStore } from '../src/journeys.js';
import { memoryPostStore } from '../src/posts.js';
import { emptyMediaExif } from '../src/exif.js';
import { memoryMediaStore } from '../src/media-store.js';
import { idleBuildState } from './build-fixture.js';
import { editorDocument, EditorEvent, type EditorElement } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';
const stamp = '2026-10-29T00:00:00.000Z';
const id = '11111111-2222-4333-8444-555555555555';
const copy = Object.fromEntries(Object.entries(ui).map(([locale, values]) => [locale, Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice(14), value]))]));
const owner = '11111111-1111-4111-8111-111111111111';
const otherOwner = '22222222-2222-4222-8222-222222222222';
const release = '1793000000000-1-0001';
const buildCopy = Object.fromEntries(Object.entries(ui).map(([locale, values]) => [locale,
  Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('admin.build.')).map(([key, value]) => [key.slice('admin.build.'.length), value])),
]));
const successfulBuild = { ok: true, attemptId: release, release, liveRelease: release };
const failedBuild = { ok: false, attemptId: '1793000001000-1-0002', code: 'build_failed', liveRelease: release, error: 'PRIVATE /data/secret' };
async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
async function storedEditorFixture() {
  const imageBase = 'https://images.test';
  const posts = memoryPostStore(), media = memoryMediaStore({ baseUrl: imageBase });
  const journeys = memoryJourneyStore(posts, posts.language, media, imageBase);
  const keys: string[] = [];
  for (let i = 0; i < 3; i++) {
    const locale = (locale: 'de' | 'en') => ({ locale, slug: locale + '-story-' + i, title: 'Story ' + i, excerpt: '', country: 'X', bodyMarkdown: '', images: {}, heroImage: { src: imageBase + '/hero', width: 640, height: 480, alt: 'Landscape' } });
    const post = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 1 } }, de: locale('de'), en: locale('en') });
    keys.push(post.translationKey);
  }
  for (const key of ['hero', 'chosen']) await media.upsert({ key, width: 640, height: 480, origBytes: 1, status: 'ready', exif: emptyMediaExif(), uploadedBy: null });
  const locale = { title: 'Journey', slug: 'journey', intro: 'Original intro', heroImage: { src: imageBase + '/hero', width: 640, height: 480, alt: 'Landscape' }, omitted: false };
  const created = await journeys.create({ de: structuredClone(locale), en: structuredClone(locale), members: keys });
  const published = await journeys.publish(created.id, created.updatedAt);
  const app = Fastify();
  disposers.push(() => app.close());
  registerJourneyAdmin(app, { store: journeys, posts, language: posts.language, imageBase,
    builder: { ...idleBuildState, build: async () => ({ ...successfulBuild, ok: true }), hasRelease: () => true, quiesce: async () => {} },
    requireAuth: async () => {}, requireAdmin: async () => {} });
  app.get('/posts', () => posts.list());
  app.get('/language', () => posts.language.get());
  await app.ready();
  const fetch = async (url: string, init: RequestInit = {}) => {
    const result = await app.inject({ url, method: (init.method || 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE',
      ...(init.body ? { payload: String(init.body), headers: { 'content-type': 'application/json' } } : {}) });
    return { status: result.statusCode, ok: result.statusCode >= 200 && result.statusCode < 300, json: async () => result.json() };
  };
  return { journeys, published, fetch };
}
async function editor(options: { admin?: boolean; published?: boolean; single?: boolean; fresh?: boolean;
  storage?: Map<string, string>; userId?: string; updatedAt?: string; journeyId?: string;
  fetch?: (url: string, init: RequestInit) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }> } = {}) {
  const dom = editorDocument(readFileSync('public/journey-editor.html', 'utf8'));
  const el = (id: string) => { const node = dom.document.getElementById(id); if (!node) throw new Error(id); return node; };
  const locale = (name: string) => ({ slug: name + '-journey', title: name + ' journey', intro: name + ' intro', heroImage: { src: 'https://images.test/hero', width: 640, height: 480, alt: name + ' alt', format: 'jpeg', focus: { x: 12, y: 83 } }, omitted: name === 'en' && !!options.single, publishedAt: options.published && name === 'de' ? stamp : null });
  const row = { id, status: options.published ? 'published' : 'draft', updatedAt: options.updatedAt ?? stamp, de: locale('de'), en: locale('en'), members: ['a', 'b', 'c'], hasUnpublishedChanges: false };
  const requests: { url: string; init: RequestInit }[] = [], questions: { title: string; body: string; danger?: boolean }[] = [];
  let failure: { status: number; body: object } | null = null, confirmed = true;
  let picker: { onPick: (item: object) => void } | undefined;
  const storage = options.storage ?? new Map<string, string>();
  const session = new Map<string, string>();
  const events = new EventTarget();
  const response = (body: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });
  const context: Record<string, unknown> = {
    document: Object.assign(dom.document, { documentElement: { lang: 'en' } }), EditorCopy: copy, BuildCopy: buildCopy, URLSearchParams, structuredClone, crypto: { randomUUID },
    location: { search: options.fresh ? '' : '?id=' + (options.journeyId ?? id), pathname: '/admin/journey-editor.html', href: '', origin: 'https://journal.test' },
    history: { replaceState() {} }, setTimeout: () => 1, clearTimeout() {},
    addEventListener: events.addEventListener.bind(events),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), key: (i: number) => [...storage.keys()][i], get length() { return storage.size; } },
    sessionStorage: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) },
    Auth: { ensureAuthed: async () => ({ isAdmin: options.admin !== false, userId: options.userId ?? owner }), renderHeader() {}, setPageTitle() {} },
    AdminConfirm: { ask: async (question: { title: string; body: string }) => { questions.push(question); return confirmed; } },
    MediaPicker: { open: (value: { onPick: (item: object) => void }) => { picker = value; } },
    fetch: async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      if (init.method && failure) return response(failure.body, failure.status);
      if (url === '/language') return response({ primary: 'de', locales: options.single ? ['de'] : ['de', 'en'], updatedAt: stamp, lockedAt: null });
      if (url === '/posts') return response(['a', 'b', 'c', 'd'].map((key, index) => ({ translationKey: key, title: index === 1 ? '<img src=x onerror=alert(1)>' : 'Story ' + key, status: index === 1 ? 'draft' : 'published' })));
      if (init.method === 'PUT' || init.method === 'POST' && url === '/journey-admin') {
        const payload = JSON.parse(String(init.body)); return response({ ...row, ...payload, id, updatedAt: '2026-10-29T00:01:00.000Z', de: { ...payload.de, publishedAt: row.de.publishedAt }, en: { ...payload.en, publishedAt: row.en.publishedAt } });
      }
      if (init.method === 'DELETE') return response({ saved: row, deleted: true, ...(options.published ? { build: successfulBuild } : {}) });
      if (init.method === 'POST') return response({ saved: { ...row, status: url.endsWith('/unpublish') ? 'draft' : 'published', updatedAt: '2026-10-29T00:02:00.000Z' }, build: successfulBuild });
      return response(row);
    },
  };
  context.window = context; vm.createContext(context);
  for (const file of ['admin-ui.js', 'language.js', 'tabs.js', 'draft-guard.js', 'build-reporting.js', 'journeys-ui.js', 'journey-editor.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
  await settle();
  if (options.fetch) await vi.waitFor(() => expect(el('journeyFields').disabled).toBe(false));
  const submit = async () => {
    el('journeyForm').dispatchEvent(new EditorEvent('submit', { cancelable: true })); await settle();
    if (options.fetch) await vi.waitFor(() => expect(el('journeyFields').disabled).toBe(false));
  };
  const edit = (id: string, value: string) => { el(id).value = value; el(id).dispatchEvent(new EditorEvent('input', { bubbles: true })); };
  return { dom, el, context, requests, questions, row, storage, submit, edit,
    /** What the Journeys list would show after this editor navigated away. */
    flash: () => vm.runInContext('AdminFlash.take()', context) as string,
    hide() { events.dispatchEvent(new Event('pagehide')); },
    confirm(value: boolean) { confirmed = value; }, fail(status: number, body: object) { failure = { status, body }; },
    recover() { failure = null; },
    pick(item: object) { if (!picker) throw new Error('picker was not opened'); picker.onPick(item); },
  };
}

describe('journey authoring DOM', () => {
  it('reorders three stories with buttons, keeps focus and announces order without interpreting titles as markup', async () => {
    const h = await editor({ admin: false });
    expect(h.el('journeyPublish').hidden).toBe(true); expect(h.el('journeyDelete').hidden).toBe(true);
    expect(h.el('journeyMembers').querySelector('img')).toBeNull();
    const down = h.el('journeyMembers').querySelectorAll('button').find(button => button.dataset.member === 'a' && button.dataset.action === 'Down')!;
    down.focus(); down.click(); await settle();
    expect(h.el('journeyOrderAnnouncement').textContent).toBe('Story a: position 2 of 3.');
    expect(h.dom.document.activeElement?.dataset.member).toBe('a'); expect(h.dom.document.activeElement?.dataset.action).toBe('Down');
    await h.submit();
    const payload = JSON.parse(String(h.requests.find(request => request.init.method === 'PUT')!.init.body));
    expect(payload.members).toEqual(['b', 'a', 'c']); expect(payload.baseUpdatedAt).toBe(stamp); expect(payload.de.heroImage.focus).toEqual({ x: 12, y: 83 }); expect(payload.de.heroImage.format).toBe('jpeg');
    expect(payload.de.publishedAt).toBeUndefined();
  });
  it('keeps disabled-locale content and explicit omission and updates hero focus through the actual media picker callback', async () => {
    const h = await editor({ single: true }); expect(h.dom.document.getElementById('journey-en-title')).toBeNull();
    h.el('journeyLocales').querySelectorAll('button').find(button => button.textContent === 'Choose from library')!.click();
    h.pick({ src: 'https://images.test/chosen', width: 1280, height: 900, alt: { de: 'Selected alt', en: 'English' }, format: 'jpeg' });
    h.edit('journey-de-x', '23'); h.edit('journey-de-y', '72'); await h.submit();
    const payload = JSON.parse(String(h.requests.find(request => request.init.method === 'PUT')!.init.body));
    expect(payload.en).toEqual({ slug: h.row.en.slug, title: h.row.en.title, intro: h.row.en.intro, heroImage: h.row.en.heroImage, omitted: true });
    expect(payload.de.heroImage).toMatchObject({ src: 'https://images.test/chosen', alt: 'Selected alt', format: 'jpeg', focus: { x: 23, y: 72 } });
  });
  it('retains unsaved edits, dirty protection and old token after a stale save', async () => {
    const h = await editor(); h.edit('journey-de-title', 'Unsaved title'); h.fail(409, { code: 'conflict' }); await h.submit();
    expect(h.el('journey-de-title').value).toBe('Unsaved title');
    expect(h.el('journeyError').hidden).toBe(false);
    await h.submit(); const puts = h.requests.filter(request => request.init.method === 'PUT'); expect(puts).toHaveLength(2); expect(JSON.parse(String(puts[1]!.init.body)).baseUpdatedAt).toBe(stamp);
    h.el('journeyPublish').click(); await settle(); expect(h.requests.some(request => request.url.endsWith('/publish'))).toBe(false);
  });
  it('locks published slugs after unpublish but confirms a never-published rename with both URLs', async () => {
    const h = await editor({ published: true }); expect(h.el('journey-de-slug').readOnly).toBe(true); expect(h.el('journey-en-slug').readOnly).toBe(false);
    h.el('journeyUnpublish').click(); await settle(); expect(h.el('journey-de-slug').readOnly).toBe(true);
    h.edit('journey-en-slug', 'new-journey'); await h.submit();
    expect(h.questions.at(-1)!.body).toContain('https://journal.test/en/journeys/en-journey/'); expect(h.questions.at(-1)!.body).toContain('https://journal.test/en/journeys/new-journey/');
    // A URL change is a loss, so its confirmation is the destructive kind (filled red, focus on Cancel).
    expect(h.questions.at(-1)!.danger).toBe(true);
    expect(JSON.parse(String(h.requests.find(request => request.init.method === 'PUT')!.init.body)).confirmSlugChange).toBe(true);
  });
  it('preserves another tab’s stored intro, heroes and membership after stale Unpublish then Save', async () => {
    const f = await storedEditorFixture();
    const stale = await editor({ journeyId: f.published.id, fetch: f.fetch });
    const other = await editor({ journeyId: f.published.id, fetch: f.fetch });
    other.edit('journey-de-intro', 'Other tab German intro');
    other.edit('journey-en-intro', 'Other tab English intro');
    for (const button of other.el('journeyLocales').querySelectorAll('button').filter(button => button.textContent === 'Choose from library')) {
      button.click(); other.pick({ src: 'https://images.test/chosen', width: 640, height: 480, alt: { de: 'New German hero', en: 'New English hero' } });
    }
    other.el('journeyMembers').querySelectorAll('button').find(button => button.dataset.action === 'Remove')!.click();
    await other.submit();
    expect(other.el('journeyError').hidden).toBe(true);
    const changed = await f.journeys.get(f.published.id);
    expect(changed?.de.intro).toBe('Other tab German intro');
    expect(changed?.members).toHaveLength(2);
    stale.el('journeyUnpublish').click(); await settle();
    await vi.waitFor(() => expect(stale.el('journeyFields').disabled).toBe(false));
    expect(stale.el('journeyError').hidden).toBe(true);
    expect((await f.journeys.get(f.published.id))?.status).toBe('draft');
    await stale.submit();
    const stored = await f.journeys.get(f.published.id);
    expect(stored?.de).toEqual(changed?.de);
    expect(stored?.en).toEqual(changed?.en);
    expect(stored?.members).toEqual(changed?.members);
    expect(stale.el('journeyError').hidden).toBe(true);
  });
  it('acknowledges failed publication with its new token, slug lock and accessible recovery', async () => {
    const h = await editor();
    h.fail(200, { build: failedBuild, saved: { ...h.row, status: 'published', updatedAt: '2026-10-29T00:02:00.000Z', de: { ...h.row.de, publishedAt: stamp } } });
    h.el('journeyPublish').click(); await settle();
    const status = h.el('journeyStatus');
    expect(status.textContent).toContain(ui.en['admin.build.failure.build_failed']);
    expect(status.textContent).not.toContain('PRIVATE');
    const recovery = status.querySelector('a');
    expect(recovery?.href).toBe('/admin/settings.html#site'); expect(recovery?.textContent.trim()).not.toBe('');
    expect(h.el('journeyError').hidden).toBe(true);
    expect(h.el('journey-de-slug').readOnly).toBe(true); expect(h.el('journeyUnpublish').hidden).toBe(false);
    h.hide(); expect(h.storage.size).toBe(0);
    h.el('journeyPublish').click(); await settle(); const calls = h.requests.filter(request => request.url.endsWith('/publish'));
    expect(JSON.parse(String(calls[1]!.init.body)).baseUpdatedAt).toBe('2026-10-29T00:02:00.000Z');
  });
  it('keeps an unacknowledged save dirty without replacing its optimistic base', async () => {
    const h = await editor(); h.edit('journey-de-title', 'Local text survives');
    h.fail(500, { error: 'PRIVATE server detail' }); await h.submit(); h.hide();
    expect(h.el('journey-de-title').value).toBe('Local text survives');
    expect(h.storage.size).toBe(1);
    expect(h.el('journeyError').hidden).toBe(false);
    expect(h.el('journeyError').textContent).not.toContain('PRIVATE');
    expect(h.el('journeyStatus').querySelector('a')).toBeNull();
    h.recover(); await h.submit();
    const puts = h.requests.filter(request => request.init.method === 'PUT');
    expect(JSON.parse(String(puts[1]!.init.body)).baseUpdatedAt).toBe(stamp);
    expect(h.storage.size).toBe(0);
  });
  it.each([true, false])('returns to the Journeys list after a deletion with its outcome, repeating nothing (failed build=%s)', async (failed) => {
    const h = await editor({ published: true });
    h.fail(200, { saved: h.row, deleted: true, build: failed ? failedBuild : successfulBuild });
    h.el('journeyDelete').focus(); h.el('journeyDelete').click(); await settle();
    expect(h.requests.filter(request => request.init.method === 'DELETE')).toHaveLength(1);
    expect(h.context.location).toMatchObject({ href: '/admin/journeys.html' });
    expect(h.el('journeyFields').disabled).toBe(true);
    expect(h.el('journeyError').hidden).toBe(true);
    // The list shows the outcome once; the sentence never carries the server's private detail.
    const outcome = h.flash();
    expect(outcome).toContain(ui.en['admin.build.delete'].replace('{title}', 'de journey'));
    // A failed rebuild names the failure; a successful one says the live site no longer shows the journey (built <date>).
    const liveWithout = ui.en['admin.build.liveWithout'];
    expect(outcome).toContain(failed ? ui.en['admin.build.failure.build_failed'] : liveWithout.slice(0, liveWithout.indexOf('{builtAt}')));
    expect(outcome).not.toContain('PRIVATE');
    expect(h.flash()).toBe('');
    h.el('journeyDelete').click(); await h.submit(); await settle();
    expect(h.requests.filter(request => request.init.method === 'DELETE')).toHaveLength(1);
    expect(h.requests.some(request => request.init.method === 'PUT')).toBe(false);
  });
  it('confirms deletion scope and cancellation restores focus with no request', async () => {
    const h = await editor(); h.confirm(false); h.el('journeyDelete').focus(); h.el('journeyDelete').click(); await settle();
    expect(h.questions[0]!.body).toContain('3 stories'); expect(h.questions[0]!.body).toContain('Every story and its URL stays unchanged'); expect(h.requests.some(request => request.init.method === 'DELETE')).toBe(false); expect(h.dom.document.activeElement).toBe(h.el('journeyDelete'));
  });
  it('derives only automatic slugs and stops rewriting a saved identity', async () => {
    const h = await editor({ fresh: true }); h.edit('journey-de-title', 'A new journey'); expect(h.el('journey-de-slug').value).toBe('a-new-journey');
    await h.submit(); h.edit('journey-de-title', 'A corrected title'); expect(h.el('journey-de-slug').value).toBe('a-new-journey');
  });
  it('preserves a manually selected new journey slug through local recovery and the next title edit', async () => {
    const f = await storedEditorFixture(), storage = new Map<string, string>();
    const first = await editor({ fresh: true, storage, fetch: f.fetch });
    first.edit('journey-de-title', 'My new journey');
    first.edit('journey-de-slug', 'chosen-manually');
    first.hide();
    const restored = await editor({ fresh: true, storage, fetch: f.fetch });
    expect(restored.el('journey-de-slug').value).toBe('chosen-manually');
    restored.edit('journey-de-title', 'Corrected journey title');
    restored.edit('journey-en-title', 'English journey title');
    await restored.submit();
    expect(restored.el('journeyError').hidden).toBe(true);
    const stored = (await f.journeys.list()).find(row => row.id !== f.published.id);
    expect(stored?.de.title).toBe('Corrected journey title');
    expect(stored?.de.slug).toBe('chosen-manually');
    expect(stored?.en.slug).toBe('english-journey-title');
  });
  it('isolates recovery by immutable owner and clears only the adopted context after acknowledgement', async () => {
    const storage = new Map<string, string>();
    const first = await editor({ storage }); const sibling = await editor({ storage });
    first.edit('journey-de-title', 'First context'); first.hide();
    const firstKey = [...storage.keys()][0]!;
    const other = await editor({ storage, userId: otherOwner });
    expect(other.questions).toHaveLength(0); expect(other.el('journey-de-title').value).toBe(other.row.de.title);
    other.edit('journey-de-title', 'Other account'); other.hide();
    const otherKey = [...storage.keys()].find(key => key !== firstKey)!;
    const restored = await editor({ storage });
    expect(restored.el('journey-de-title').value).toBe('First context');
    sibling.edit('journey-de-title', 'Independent context'); sibling.hide();
    const siblingKey = [...storage.keys()].find(key => key !== firstKey && key !== otherKey)!;
    expect(siblingKey).toBeDefined();
    await restored.submit();
    expect(storage.has(firstKey)).toBe(false);
    expect(storage.has(otherKey)).toBe(true); expect(storage.has(siblingKey)).toBe(true);
  });
  it('restores the original stale optimistic base, not the freshly loaded version', async () => {
    const storage = new Map<string, string>(); const first = await editor({ storage });
    first.edit('journey-de-title', 'Recovered local text'); first.hide();
    const restored = await editor({ storage, updatedAt: '2026-10-29T00:05:00.000Z' });
    restored.fail(409, { code: 'conflict' }); await restored.submit();
    const sent = JSON.parse(String(restored.requests.find(request => request.init.method === 'PUT')!.init.body));
    expect(sent.baseUpdatedAt).toBe(stamp);
    expect(restored.el('journey-de-title').value).toBe('Recovered local text');
    expect(restored.el('journeyError').hidden).toBe(false);
    restored.hide(); expect(storage.size).toBeGreaterThan(0);
    restored.el('journeyPublish').click(); await settle();
    expect(restored.requests.some(request => request.url.endsWith('/publish'))).toBe(false);
  });
  it.each([undefined, 'not-a-version'])('retains recovery without borrowing a fresh base when its version is %s', async (baseUpdatedAt) => {
    const storage = new Map<string, string>(); const first = await editor({ storage });
    first.edit('journey-de-title', 'Recovered without a trusted base'); first.hide();
    const [key, raw] = [...storage.entries()][0]!;
    const record = JSON.parse(raw); record.payload.baseUpdatedAt = baseUpdatedAt;
    storage.set(key, JSON.stringify(record));
    const restored = await editor({ storage, updatedAt: '2026-10-29T00:05:00.000Z' });
    await restored.submit();
    expect(restored.requests.some(request => request.init.method === 'PUT')).toBe(false);
    expect(restored.el('journey-de-title').value).toBe('Recovered without a trusted base');
    expect(restored.el('journeyError').hidden).toBe(false);
    expect(storage.has(key)).toBe(true);
    restored.el('journeyPublish').click(); await settle();
    expect(restored.requests.some(request => request.url.endsWith('/publish'))).toBe(false);
  });
  it('moves newly created recovery to its saved journey without erasing another new context', async () => {
    const storage = new Map<string, string>();
    const first = await editor({ storage, fresh: true }); const sibling = await editor({ storage, fresh: true });
    sibling.edit('journey-de-title', 'Another new journey'); sibling.hide();
    const siblingKey = [...storage.keys()][0]!;
    first.edit('journey-de-title', 'Created journey'); first.hide(); await first.submit();
    expect([...storage.keys()]).toEqual([siblingKey]);
    first.edit('journey-de-title', 'After creation'); first.hide();
    const restored = await editor({ storage });
    expect(restored.el('journey-de-title').value).toBe('After creation');
    expect(storage.has(siblingKey)).toBe(true);
  });
  it('names the locale by its code in every per-locale field label', async () => {
    const h = await editor();
    const label = (id: string) => h.dom.document.querySelector(`label[for="${id}"]`)!.textContent;
    expect(label('journey-de-title')).toBe(ui.en['editor.chrome.journeyName'].replace('{code}', 'DE'));
    expect(label('journey-en-title')).toBe(ui.en['editor.chrome.journeyName'].replace('{code}', 'EN'));
    expect(label('journey-en-slug')).toBe(ui.en['editor.chrome.journeySlug'].replace('{code}', 'EN'));
    expect(label('journey-de-intro')).toBe(ui.en['editor.chrome.journeyIntro'].replace('{code}', 'DE'));
  });
  it('asks “Publish this journey in English” and sends the stored omitted flag inverted, through save, reload and a local draft', async () => {
    const h = await editor();
    const box = h.el('journey-en-included');
    expect(box.closest('label')!.textContent).toContain(ui.en['editor.chrome.journeyInclude'].replace('{language}', ui.en['editor.chrome.languageEnglish']));
    expect(box.checked).toBe(true);
    expect(h.el('journey-de-included').checked).toBe(true); expect(h.el('journey-de-included').disabled).toBe(true);
    box.checked = false; box.dispatchEvent(new EditorEvent('change', { bubbles: true }));
    await h.submit();
    const payload = JSON.parse(String(h.requests.find(request => request.init.method === 'PUT')!.init.body));
    expect(payload.en.omitted).toBe(true); expect(payload.de.omitted).toBe(false);
    h.hide(); expect(h.storage.size).toBe(0);
    // Stored as omitted, the translation loads with its box unchecked; a local draft restores the same way.
    const storage = new Map<string, string>();
    const stored = await editor({ storage, fetch: async (url, init) => url === '/journey-admin/' + id && !init.method
      ? { status: 200, ok: true, json: async () => ({ ...h.row, en: { ...h.row.en, omitted: true } }) }
      : { status: 200, ok: true, json: async () => url === '/posts' ? [] : { primary: 'de', locales: ['de', 'en'], updatedAt: stamp, lockedAt: null } } });
    expect(stored.el('journey-en-included').checked).toBe(false);
    stored.el('journey-en-included').checked = true; stored.el('journey-en-included').dispatchEvent(new EditorEvent('change', { bubbles: true })); stored.hide();
    expect(storage.size).toBe(1);
    expect(JSON.parse([...storage.values()][0]!).payload.en.omitted).toBe(false);
    const restored = await editor({ storage, fetch: async (url, init) => url === '/journey-admin/' + id && !init.method
      ? { status: 200, ok: true, json: async () => ({ ...h.row, en: { ...h.row.en, omitted: true } }) }
      : { status: 200, ok: true, json: async () => url === '/posts' ? [] : { primary: 'de', locales: ['de', 'en'], updatedAt: stamp, lockedAt: null } } });
    expect(restored.el('journey-en-included').checked).toBe(true);
  });
  it('refuses to create an untitled journey: no request, the German title field marked and focused', async () => {
    const h = await editor({ fresh: true });
    h.el('journey-tab-en').click();
    expect(h.el('journey-panel-de').hidden).toBe(true);
    await h.submit();
    expect(h.requests.some(request => request.init.method === 'POST' && request.url === '/journey-admin')).toBe(false);
    expect(h.el('journey-panel-de').hidden).toBe(false);
    const field = h.el('journey-de-title');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(h.el('journey-de-titleError').textContent).toBe(ui.en['editor.chrome.journeyTitleRequired'].replace('{language}', ui.en['editor.chrome.languageGerman']));
    expect(field.getAttribute('aria-describedby')).toContain('journey-de-titleError');
    expect(h.dom.document.activeElement).toBe(field);
    expect(h.el('journeyFields').disabled).toBe(false);
    expect(h.el('journeyError').hidden).toBe(true);
    h.edit('journey-de-title', 'Named at last');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(h.el('journey-de-titleError').hidden).toBe(true);
    await h.submit();
    expect(JSON.parse(String(h.requests.find(request => request.init.method === 'POST' && request.url === '/journey-admin')!.init.body)).de.title).toBe('Named at last');
  });
  it('carries each locale’s state in its tab chip: not requested, no title yet, available', async () => {
    const h = await editor({ fresh: true });
    const english = ui.en['editor.chrome.languageEnglish'];
    const noTitle = ui.en['editor.chrome.languageTitleEmpty'].replace('{language}', english);
    const notRequested = ui.en['editor.chrome.languageOmittedLabel'].replace('{language}', english);
    const tab = h.el('journey-tab-en');
    expect(tab.textContent).toContain(noTitle); expect(tab.getAttribute('title')).toBe(noTitle);
    expect(h.el('journey-tab-de').textContent).toContain(ui.en['editor.chrome.languageTitleEmpty'].replace('{language}', ui.en['editor.chrome.languageGerman']));
    h.edit('journey-en-title', 'Coast to coast');
    expect(tab.textContent).not.toContain(noTitle); expect(tab.getAttribute('title')).toBeFalsy();
    h.el('journey-en-included').checked = false; h.el('journey-en-included').dispatchEvent(new EditorEvent('change', { bubbles: true }));
    expect(tab.textContent).toContain(notRequested); expect(tab.getAttribute('title')).toBe(notRequested);
    // A stored journey reports its chips on load too.
    const loaded = await editor({ single: false });
    expect(loaded.el('journey-tab-en').textContent).not.toContain(english + ':');
  });
});

describe('journey catalogue DOM', () => {
  interface ListedJourney { id: string; titles: { de: string; en: string }; omitted: { de: boolean; en: boolean }; status: string; hasUnpublishedChanges: boolean; memberCount: number; live: { de: boolean; en: boolean } }
  async function catalogue(journeys: ListedJourney[], options: { language?: { primary: 'de' | 'en'; locales: ('de' | 'en')[] }; flash?: string } = {}) {
    const html = readFileSync('public/journeys.html', 'utf8'); const dom = editorDocument(html);
    const stored = new Map<string, string>(options.flash ? [['admin.flash', options.flash]] : []);
    const context: Record<string, unknown> = {
      document: dom.document, EditorCopy: copy,
      Auth: { ensureAuthed: async () => ({ isAdmin: false }), renderHeader() {}, setPageTitle() {} },
      sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ journeys }) }),
    };
    context.window = context; vm.createContext(context);
    for (const file of ['language.js', 'admin-ui.js', 'journeys-ui.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
    const language = options.language ?? { primary: 'en', locales: ['en'] };
    vm.runInContext(`SiteLanguage.get = async () => SiteLanguage.accept(${JSON.stringify({ ...language, lockedAt: null, updatedAt: stamp })})`, context);
    vm.runInContext(html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>')), context); await settle();
    return { dom, list: dom.document.getElementById('journeyList')!, notice: dom.document.getElementById('journeyNotice')!, stored };
  }
  const journey = (overrides: Partial<ListedJourney> = {}): ListedJourney => ({
    id, titles: { de: 'Retained German', en: '<img src=x>' }, omitted: { de: false, en: false }, status: 'published', hasUnpublishedChanges: true, memberCount: 3, live: { de: false, en: false }, ...overrides,
  });
  const chipsOf = (root: EditorElement) =>
    root.querySelectorAll('.lang-chip').map((chip) => ({ code: chip.textContent, className: chip.className, name: chip.getAttribute('aria-label') }));

  it.each([true, false])('renders truthful dormant/empty state and escaped titles (populated=%s)', async (populated) => {
    const { dom, list, notice } = await catalogue(populated ? [journey()] : []);
    expect(list.querySelector('img')).toBeNull();
    if (populated) {
      expect(list.textContent).toContain('<img src=x>'); expect(list.textContent).toContain('Unpublished changes'); expect(list.textContent).toContain('Not live in EN');
      expect(list.textContent).not.toContain('Retained German'); expect(list.textContent).not.toContain('Not live in DE');
      expect(list.querySelector('a')?.href).toBe('/admin/journey-editor.html?id=' + id);
      const search = dom.document.getElementById('journeySearch')!;
      search.value = 'Retained German';
      search.fire('input');
      expect(list.querySelector('section')?.hidden).toBe(true);
      expect(notice.textContent).toBe(ui.en['editor.chrome.journeyNoResults']);
      search.value = '  <IMG SRC=X>  ';
      search.fire('input');
      expect(list.querySelector('section')?.hidden).toBe(false);
      expect(notice.textContent).toBe('');
      expect(list.textContent).toContain(ui.en['editor.chrome.journeyStoryCount'].replace('{count}', '3'));
    } else expect(notice.textContent).toBe(ui.en['editor.chrome.journeyEmpty']);
  });

  it('offers Edit named after the journey, not "Edit journey"', async () => {
    const { list } = await catalogue([journey({ titles: { de: 'Balkan', en: 'Balkans' } })], { language: { primary: 'de', locales: ['de', 'en'] } });
    const edit = list.querySelectorAll('a').at(-1)!;
    expect(edit.textContent).toBe('Edit');
    expect(edit.getAttribute('aria-label')).toBe('Edit Balkan');
    expect(edit.href).toBe('/admin/journey-editor.html?id=' + id);
  });

  it('shows one language chip per enabled locale: written, omitted, or still without a title', async () => {
    const rows = [
      journey({ id: '11111111-2222-4333-8444-000000000001', titles: { de: 'Beides', en: 'Both' } }),
      journey({ id: '11111111-2222-4333-8444-000000000002', titles: { de: 'Nur Deutsch', en: 'Kept, not requested' }, omitted: { de: false, en: true }, status: 'draft', live: { de: false, en: false } }),
      journey({ id: '11111111-2222-4333-8444-000000000003', titles: { de: 'Noch ohne Englisch', en: '' }, status: 'draft' }),
    ];
    const { list } = await catalogue(rows, { language: { primary: 'de', locales: ['de', 'en'] } });
    const sections = list.querySelectorAll('section');
    expect(sections.map((section) => chipsOf(section))).toEqual([
      [{ code: 'DE', className: 'lang-chip', name: 'German: title set' }, { code: 'EN', className: 'lang-chip', name: 'English: title set' }],
      [{ code: 'DE', className: 'lang-chip', name: 'German: title set' }, { code: 'EN', className: 'lang-chip is-omitted', name: 'English: not requested for publication' }],
      [{ code: 'DE', className: 'lang-chip', name: 'German: title set' }, { code: 'EN', className: 'lang-chip is-missing', name: 'English: no title yet' }],
    ]);
    // The secondary title still reads beside its chip; a missing one shows nothing but the chip.
    expect(sections[0]!.textContent).toContain('Both');
    expect(sections[1]!.textContent).toContain('Kept, not requested');
    expect(sections[2]!.querySelectorAll('.journey-row__locale')[0]!.textContent).toBe('EN');
  });

  it('shows a message carried over from the journey editor once in its status line, then forgets it', async () => {
    const { notice, stored } = await catalogue([], { flash: 'Deleted “Balkan”. The site was not rebuilt.' });
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toBe('Deleted “Balkan”. The site was not rebuilt. ' + ui.en['editor.chrome.journeyEmpty']);
    expect(stored.has('admin.flash')).toBe(false);
  });
});
