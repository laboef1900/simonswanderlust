import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { editorDocument, EditorEvent } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';
const stamp = '2026-10-29T00:00:00.000Z';
const id = '11111111-2222-4333-8444-555555555555';
const copy = Object.fromEntries(Object.entries(ui).map(([locale, values]) => [locale, Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice(14), value]))]));
async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
async function editor(options: { admin?: boolean; published?: boolean; single?: boolean; fresh?: boolean } = {}) {
  const dom = editorDocument(readFileSync('public/journey-editor.html', 'utf8'));
  const el = (id: string) => { const node = dom.document.getElementById(id); if (!node) throw new Error(id); return node; };
  const locale = (name: string) => ({ slug: name + '-journey', title: name + ' journey', intro: name + ' intro', heroImage: { src: 'https://images.test/hero', width: 640, height: 480, alt: name + ' alt', format: 'jpeg', focus: { x: 12, y: 83 } }, omitted: name === 'en' && !!options.single, publishedAt: options.published && name === 'de' ? stamp : null });
  const row = { id, status: options.published ? 'published' : 'draft', updatedAt: stamp, de: locale('de'), en: locale('en'), members: ['a', 'b', 'c'], hasUnpublishedChanges: false };
  const requests: { url: string; init: RequestInit }[] = [], questions: { title: string; body: string }[] = [];
  let failure: { status: number; body: object } | null = null, confirmed = true;
  let picker: { onPick: (item: object) => void } | undefined;
  const storage = new Map<string, string>();
  const response = (body: unknown, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });
  const context: Record<string, unknown> = {
    document: Object.assign(dom.document, { documentElement: { lang: 'en' } }), EditorCopy: copy, URLSearchParams, structuredClone,
    location: { search: options.fresh ? '' : '?id=' + id, pathname: '/admin/journey-editor.html', href: '', origin: 'https://journal.test' },
    history: { replaceState() {} }, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), key: (i: number) => [...storage.keys()][i], get length() { return storage.size; } },
    sessionStorage: { getItem: () => null, setItem() {} },
    Auth: { ensureAuthed: async () => ({ isAdmin: options.admin !== false }), renderHeader() {}, setPageTitle() {} },
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
      if (init.method === 'DELETE') return response({ persisted: true, deleted: true });
      if (init.method === 'POST') return response({ persisted: true, saved: { ...row, status: url.endsWith('/unpublish') ? 'draft' : 'published', updatedAt: '2026-10-29T00:02:00.000Z' }, build: { ok: true } });
      return response(row);
    },
  };
  context.window = context; vm.createContext(context);
  for (const file of ['language.js', 'draft-guard.js', 'journeys-ui.js', 'journey-editor.js']) vm.runInContext(readFileSync('public/' + file, 'utf8'), context);
  await settle();
  const submit = async () => { el('journeyForm').dispatchEvent(new EditorEvent('submit', { cancelable: true })); await settle(); };
  const edit = (id: string, value: string) => { el(id).value = value; el(id).dispatchEvent(new EditorEvent('input', { bubbles: true })); };
  return { dom, el, context, requests, questions, row, storage, submit, edit,
    confirm(value: boolean) { confirmed = value; }, fail(status: number, body: object) { failure = { status, body }; },
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
    expect(h.el('journey-de-title').value).toBe('Unsaved title'); expect(h.el('journeyStatus').textContent).toBe('Unsaved changes'); expect(h.el('journeyError').textContent).toBe(ui.en['editor.chrome.journeyConflict']);
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
  it('keeps the persisted publication token and locks after a failed rebuild, without saying live', async () => {
    const h = await editor();
    h.fail(502, { persisted: true, code: 'journey_build_failed', build: { ok: false }, saved: { ...h.row, status: 'published', updatedAt: '2026-10-29T00:02:00.000Z', de: { ...h.row.de, publishedAt: stamp } } });
    h.el('journeyPublish').click(); await settle(); expect(h.el('journeyError').textContent).toBe(ui.en['editor.chrome.journeyBuildFailed']); expect(h.el('journey-de-slug').readOnly).toBe(true); expect(h.el('journeyUnpublish').hidden).toBe(false);
    h.el('journeyPublish').click(); await settle(); const calls = h.requests.filter(request => request.url.endsWith('/publish'));
    expect(JSON.parse(String(calls[1]!.init.body)).baseUpdatedAt).toBe('2026-10-29T00:02:00.000Z');
  });
  it('confirms deletion scope and cancellation restores focus with no request', async () => {
    const h = await editor(); h.confirm(false); h.el('journeyDelete').focus(); h.el('journeyDelete').click(); await settle();
    expect(h.questions[0]!.body).toContain('3 stories'); expect(h.questions[0]!.body).toContain('Every story and its URL stays unchanged'); expect(h.requests.some(request => request.init.method === 'DELETE')).toBe(false); expect(h.dom.document.activeElement).toBe(h.el('journeyDelete'));
  });
  it('derives only automatic slugs and stops rewriting a saved identity', async () => {
    const h = await editor({ fresh: true }); h.edit('journey-de-title', 'A new journey'); expect(h.el('journey-de-slug').value).toBe('a-new-journey');
    await h.submit(); h.edit('journey-de-title', 'A corrected title'); expect(h.el('journey-de-slug').value).toBe('a-new-journey');
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
