import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { editorDocument, EditorEvent } from './editor-dom-harness.js';
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
async function editor(options: { admin?: boolean; published?: boolean; single?: boolean; fresh?: boolean;
  storage?: Map<string, string>; userId?: string; updatedAt?: string } = {}) {
  const dom = editorDocument(readFileSync('public/journey-editor.html', 'utf8'));
  const el = (id: string) => { const node = dom.document.getElementById(id); if (!node) throw new Error(id); return node; };
  const locale = (name: string) => ({ slug: name + '-journey', title: name + ' journey', intro: name + ' intro', heroImage: { src: 'https://images.test/hero', width: 640, height: 480, alt: name + ' alt', format: 'jpeg', focus: { x: 12, y: 83 } }, omitted: name === 'en' && !!options.single, publishedAt: options.published && name === 'de' ? stamp : null });
  const row = { id, status: options.published ? 'published' : 'draft', updatedAt: options.updatedAt ?? stamp, de: locale('de'), en: locale('en'), members: ['a', 'b', 'c'], hasUnpublishedChanges: false };
  const requests: { url: string; init: RequestInit }[] = [], questions: { title: string; body: string }[] = [];
  let failure: { status: number; body: object } | null = null, confirmed = true;
  let picker: { onPick: (item: object) => void } | undefined;
  const storage = options.storage ?? new Map<string, string>();
  const events = new EventTarget();
  const response = (body: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });
  const context: Record<string, unknown> = {
    document: Object.assign(dom.document, { documentElement: { lang: 'en' } }), EditorCopy: copy, BuildCopy: buildCopy, URLSearchParams, structuredClone, crypto: { randomUUID },
    location: { search: options.fresh ? '' : '?id=' + id, pathname: '/admin/journey-editor.html', href: '', origin: 'https://journal.test' },
    history: { replaceState() {} }, setTimeout: () => 1, clearTimeout() {},
    addEventListener: events.addEventListener.bind(events),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), key: (i: number) => [...storage.keys()][i], get length() { return storage.size; } },
    sessionStorage: { getItem: () => null, setItem() {} },
    Auth: { ensureAuthed: async () => ({ isAdmin: options.admin !== false, userId: options.userId ?? owner }), renderHeader() {}, setPageTitle() {} },
    AdminConfirm: { ask: async (question: { title: string; body: string }) => { questions.push(question); return confirmed; } },
    MediaPicker: { open: (value: { onPick: (item: object) => void }) => { picker = value; } },
    fetch: async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
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
  for (const file of ['language.js', 'draft-guard.js', 'build-reporting.js', 'journeys-ui.js', 'journey-editor.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
  await settle();
  const submit = async () => { el('journeyForm').dispatchEvent(new EditorEvent('submit', { cancelable: true })); await settle(); };
  const edit = (id: string, value: string) => { el(id).value = value; el(id).dispatchEvent(new EditorEvent('input', { bubbles: true })); };
  return { dom, el, context, requests, questions, row, storage, submit, edit,
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
    expect(JSON.parse(String(h.requests.find(request => request.init.method === 'PUT')!.init.body)).confirmSlugChange).toBe(true);
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
  it.each([true, false])('keeps acknowledged deletion visible and non-repeatable (failed build=%s)', async (failed) => {
    const h = await editor({ published: true });
    h.fail(200, { saved: h.row, deleted: true, build: failed ? failedBuild : successfulBuild });
    h.el('journeyDelete').focus(); h.el('journeyDelete').click(); await settle();
    const outcome = h.el('journeyStatus').textContent;
    expect(outcome).not.toBe(''); expect(outcome).not.toContain('PRIVATE');
    expect(h.el('journeyFields').disabled).toBe(true);
    expect(h.dom.document.activeElement).toBe(h.el('journeyStatus'));
    expect(h.context.location).toMatchObject({ href: '' });
    if (failed) expect(h.el('journeyStatus').querySelector('a')?.href).toBe('/admin/settings.html#site');
    h.el('journeyDelete').click(); await h.submit(); await settle();
    expect(h.requests.filter(request => request.init.method === 'DELETE')).toHaveLength(1);
    expect(h.requests.some(request => request.init.method === 'PUT')).toBe(false);
    expect(h.el('journeyStatus').textContent).toBe(outcome);
  });
  it('confirms deletion scope and cancellation restores focus with no request', async () => {
    const h = await editor(); h.confirm(false); h.el('journeyDelete').focus(); h.el('journeyDelete').click(); await settle();
    expect(h.questions[0]!.body).toContain('3 stories'); expect(h.questions[0]!.body).toContain('Every story and its URL stays unchanged'); expect(h.requests.some(request => request.init.method === 'DELETE')).toBe(false); expect(h.dom.document.activeElement).toBe(h.el('journeyDelete'));
  });
  it('derives only automatic slugs and stops rewriting a saved identity', async () => {
    const h = await editor({ fresh: true }); h.edit('journey-de-title', 'A new journey'); expect(h.el('journey-de-slug').value).toBe('a-new-journey');
    await h.submit(); h.edit('journey-de-title', 'A corrected title'); expect(h.el('journey-de-slug').value).toBe('a-new-journey');
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
});

describe('journey catalogue DOM', () => {
  it.each([true, false])('renders truthful dormant/empty state and escaped titles (populated=%s)', async (populated) => {
    const html = readFileSync('public/journeys.html', 'utf8'); const dom = editorDocument(html);
    const context: Record<string, unknown> = {
      document: dom.document, EditorCopy: copy,
      Auth: { ensureAuthed: async () => ({ isAdmin: false }), renderHeader() {}, setPageTitle() {} },
      SiteLanguage: { get: async () => ({ primary: 'en', locales: ['en'] }) },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ journeys: populated ? [{ id, titles: { de: 'Retained German', en: '<img src=x>' }, status: 'published', hasUnpublishedChanges: true, memberCount: 3, live: { de: false, en: false } }] : [] }) }),
    };
    context.window = context; vm.createContext(context);
    vm.runInContext(readFileSync('public/journeys-ui.js', 'utf8'), context);
    vm.runInContext(html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>')), context); await settle();
    const list = dom.document.getElementById('journeyList')!;
    expect(list.querySelector('img')).toBeNull();
    if (populated) {
      expect(list.textContent).toContain('<img src=x>'); expect(list.textContent).toContain('Unpublished changes'); expect(list.textContent).toContain('Not live in EN');
      expect(list.textContent).not.toContain('Retained German'); expect(list.textContent).not.toContain('Not live in DE');
      expect(list.querySelector('a')?.href).toBe('/admin/journey-editor.html?id=' + id);
    } else expect(dom.document.getElementById('journeyNotice')?.textContent).toBe(ui.en['editor.chrome.journeyEmpty']);
  });
});
