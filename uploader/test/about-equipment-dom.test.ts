import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID, webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { editorDocument } from './editor-dom-harness.js';
import { browserScript, galleryCodecBindings } from './gallery-browser-module.js';
import { idleBuildState } from './build-fixture.js';
import { TEST_TRUST } from './trusted-proxy-fixture.js';
import { ui } from '../../site/src/i18n/ui.js';
import { buildServer } from '../src/server.js';
import { defaultSettings, validate, type Settings, type SettingsStore } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPostStore } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryMediaStore } from '../src/media-store.js';
import { memorySecretsStore } from '../src/secrets.js';
import { memoryCommentAdminStore } from '../src/comments-admin.js';
import { memorySiteIdentityStore } from '../src/site-identity.js';
import { memoryLanguageStore, type LanguageConfig } from '../src/language.js';
import type { EncodeQueue } from '../src/encode-queue.js';
import type { DbBackup } from '../src/backup.js';
import type { Identity } from '../../site/src/lib/site-identity.js';

const chrome = (locale: 'de' | 'en') => Object.fromEntries(Object.entries(ui[locale])
  .filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value]));
const copy = chrome('en');
const buildCopy = Object.fromEntries((['de', 'en'] as const).map((locale) => [locale, Object.fromEntries(Object.entries(ui[locale])
  .filter(([key]) => key.startsWith('admin.build.')).map(([key, value]) => [key.slice('admin.build.'.length), value]))]));
const stamp = '2026-11-03T00:00:00.000Z';
const owner = '11111111-1111-4111-8111-111111111111';
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));

const identity = (): Identity => ({
  siteName: 'Field notes', authorName: 'Alex', canonicalOrigin: 'https://blog.example',
  tagline: { de: 'Unterwegs', en: 'On the road' }, aboutRole: { de: 'Reisender', en: 'Traveler' },
  aboutGear: { de: 'Leica Q2 · Notizbuch', en: 'Leica Q2 · notebook' }, studioDescriptor: { de: 'Studio', en: 'Studio' },
  socialLinks: [{ label: 'Instagram', url: 'https://instagram.example/alex' }],
});

type Reply = { status: number; body: unknown };
type Route = (url: string, init: RequestInit) => Promise<Reply | undefined> | Reply | undefined;
type Settled = { url: string; init: RequestInit };
async function settle() { for (let i = 0; i < 60; i++) await new Promise((resolve) => setImmediate(resolve)); }

/** The actual About editor markup and module script, with fetch answered by `route`. */
async function editor(options: { key?: string; prepare?: boolean; locales?: LanguageConfig['locales']; route: Route; language?: 'de' | 'en'; userId?: string }) {
  const key = options.key ?? 'about';
  const locales = options.locales ?? ['de', 'en'];
  const html = readFileSync('public/about.html', 'utf8');
  const dom = editorDocument(html);
  if (options.language) dom.document.documentElement.lang = options.language;
  const el = (id: string) => { const node = dom.document.getElementById(id); if (!node) throw new Error('Missing markup: ' + id); return node; };
  const requests: Settled[] = [];
  const questions: { title: string; body: string }[] = [];
  let confirmed = true;
  const unload: ((event: { defaultPrevented: boolean; returnValue?: string; preventDefault(): void }) => void)[] = [];
  const storage = new Map<string, string>();
  class EasyMDE {
    private body = '';
    codemirror = { getInputField: () => dom.document.createElement('textarea'), on() {}, refresh() {},
      getValue: () => this.body, getLine: (line: number) => this.body.split('\n')[line] ?? '' };
    value(value?: string) { if (value !== undefined) this.body = value; return this.body; }
  }
  const context: Record<string, unknown> = {
    document: dom.document, URLSearchParams, EasyMDE, EditorCopy: { en: copy, de: chrome('de') }, BuildCopy: buildCopy,
    crypto: webcrypto, structuredClone, AbortController,
    location: { search: '?key=' + key + (options.prepare ? '&prepareLocale=en' : ''), pathname: '/admin/about.html', origin: 'https://journal.test', href: '' },
    localStorage: {
      getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value),
      removeItem: (name: string) => storage.delete(name), get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null,
    },
    setTimeout: () => 0, clearTimeout: () => {},
    addEventListener: (type: string, callback: (typeof unload)[number]) => { if (type === 'beforeunload') unload.push(callback); },
    Auth: { ensureAuthed: async () => ({ userId: options.userId ?? owner, isAdmin: true }), renderHeader() {} },
    AdminConfirm: { ask: async (question: { title: string; body: string }) => { questions.push(question); return confirmed; } },
    fetch: async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      const reply = await options.route(url, init);
      if (reply === undefined) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    },
  };
  context.window = context;
  vm.createContext(context);
  Object.assign(context, galleryCodecBindings);
  for (const file of ['build-reporting.js', 'draft-guard.js', 'language.js', 'tabs.js', 'pages-ui.js', 'about-equipment.js', 'gallery-fence.js', 'gallery-metadata-warnings.js', 'write-recovery.js']) {
    vm.runInContext(browserScript(file), context);
  }
  const start = html.lastIndexOf('<script type="module">');
  vm.runInContext(html.slice(html.indexOf("'use strict'", start), html.lastIndexOf('</script>')), context);
  await settle();
  const type = (id: string, value: string) => { el(id).value = value; el(id).fire('input'); };
  const click = async (id: string) => { el(id).click(); await settle(); };
  const puts = () => requests.filter(({ url, init }) => url === '/settings/identity' && init.method === 'PUT')
    .map(({ init }) => JSON.parse(String(init.body)) as { revision: number; identity: Identity });
  const beforeUnload = () => {
    const event = { defaultPrevented: false, returnValue: undefined as string | undefined, preventDefault() { this.defaultPrevented = true; } };
    for (const callback of unload) callback(event);
    return event;
  };
  return { dom, el, type, click, requests, questions, puts, beforeUnload, confirm: (value: boolean) => { confirmed = value; }, locales };
}

/** Page endpoints like the server's, plus a scripted /settings/identity. */
function stubbed(options: { locales?: LanguageConfig['locales']; identity?: Identity; revision?: number; put?: (body: { revision: number; identity: Identity }) => Reply | undefined; get?: () => Reply | undefined } = {}) {
  const locales = options.locales ?? ['de', 'en'];
  let current = { revision: options.revision ?? 7, identity: options.identity ?? identity() };
  const page = { key: 'about', status: 'draft', updatedAt: stamp,
    de: { locale: 'de', title: 'Über mich', bodyMarkdown: 'Hallo', images: {}, slug: '', publishedAt: null },
    en: { locale: 'en', title: 'About me', bodyMarkdown: 'Hello', images: {}, slug: '', publishedAt: null } };
  const route: Route = (url, init) => {
    if (url === '/language') return { status: 200, body: { primary: locales[0], locales, updatedAt: stamp, lockedAt: null } };
    if (url === '/pages') return { status: 200, body: { pages: [{ key: 'about', known: true, defaults: null }, { key: 'contact', known: true, defaults: { de: 'kontakt', en: 'contact' } }] } };
    if (url.endsWith('/revisions')) return { status: 200, body: [] };
    if (url === '/settings/identity' && init.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { revision: number; identity: Identity };
      const reply = options.put ? options.put(body) : { status: 200, body: { revision: body.revision + 1, takesEffect: 'next_build' } };
      if (reply?.status === 200) current = { revision: (reply.body as { revision: number }).revision, identity: body.identity };
      return reply;
    }
    if (url === '/settings/identity') {
      return options.get ? options.get() : { status: 200, body: { revision: current.revision, savedAt: stamp, seedSource: 'neutral', locales, assets: { logo: false, favicon: false }, identity: current.identity } };
    }
    if (url.startsWith('/pages/')) return { status: 200, body: { ...page, key: url.split('/')[2], ownerUserId: owner, lastSaveId: null } };
    return { status: 404, body: {} };
  };
  return { route, set(next: { revision: number; identity: Identity }) { current = next; } };
}

describe('About editor equipment line (#514)', () => {
  it('shows each enabled locale’s saved line and saves one locale through the full loaded identity', async () => {
    const h = await editor({ route: stubbed().route });
    expect(h.el('deGearSection').hidden).toBe(false);
    expect(h.el('deGear').value).toBe('Leica Q2 · Notizbuch');
    expect(h.el('enGear').value).toBe('Leica Q2 · notebook');
    expect(h.el('deGearLabel').textContent).toBe(fill(copy.aboutGearLabel!, { language: copy.identityGerman! }));
    expect(h.el('deGear').getAttribute('aria-describedby')).toBe('deGearHelp deGearCount deGearError');
    expect(h.el('deGearCount').textContent).toBe(fill(copy.aboutGearCount!, { count: 20, max: 200 }));
    h.type('enGear', 'Unsaved English line');
    await h.click('tabbtn-en');
    await h.click('tabbtn-de');
    h.type('deGear', '  Leica M6 · Kodak Portra  ');
    expect(h.el('deGearStatus').textContent).toBe(copy.aboutGearUnsaved);
    await h.click('deGearSave');
    const [sent] = h.puts();
    expect(sent).toEqual({ revision: 7, identity: { ...identity(), aboutGear: { de: '  Leica M6 · Kodak Portra  ', en: 'Leica Q2 · notebook' } } });
    expect(h.el('deGear').value).toBe('Leica M6 · Kodak Portra');
    expect(h.el('deGearStatus').textContent).toBe(copy.aboutGearSaved);
    // The other locale's unsaved input stays put and stays unsaved.
    expect(h.el('enGear').value).toBe('Unsaved English line');
    expect(h.el('enGearStatus').textContent).toBe(copy.aboutGearUnsaved);
    expect(h.beforeUnload().defaultPrevented).toBe(true);
    // Equipment edits are not page edits: the page is never written and Publish is not blocked by "save first".
    expect(h.requests.some(({ url, init }) => url.startsWith('/pages/') && init.method === 'PUT')).toBe(false);
    h.confirm(false);
    await h.click('publishBtn');
    expect(h.el('actionError').hidden).toBe(true);
    expect(h.questions.at(-1)?.title).toBe(copy.pagesPublish);
    h.confirm(true);
    // A second save from the same tab uses the advanced revision.
    h.type('enGear', 'Leica M6');
    await h.click('enGearSave');
    expect(h.puts()[1]).toMatchObject({ revision: 8, identity: { aboutGear: { de: 'Leica M6 · Kodak Portra', en: 'Leica M6' } } });
    expect(h.beforeUnload().defaultPrevented).toBe(false);
  });

  it('clears a locale with an empty line and returns keyboard focus to Save', async () => {
    let dropFocus = () => {};
    const h = await editor({ route: stubbed({ put: (body) => { dropFocus(); return { status: 200, body: { revision: body.revision + 1 } }; } }).route });
    // A browser drops focus from the Save button it disables while the request runs.
    dropFocus = () => h.dom.document.body!.focus();
    await h.click('tabbtn-en');
    h.type('enGear', '   ');
    h.el('enGearSave').focus();
    expect(h.dom.document.activeElement).toBe(h.el('enGearSave'));
    await h.click('enGearSave');
    expect(h.puts()[0]!.identity.aboutGear).toEqual({ de: 'Leica Q2 · Notizbuch', en: '   ' });
    expect(h.el('enGear').value).toBe('');
    expect(h.el('enGearStatus').textContent).toBe(copy.aboutGearCleared);
    expect(h.dom.document.activeElement).toBe(h.el('enGearSave'));
  });

  it('refuses over-limit and non-plain text locally, keeping and focusing the input', async () => {
    const h = await editor({ route: stubbed().route });
    // 200 NFC code points: combining pairs compose, astral symbols count once.
    const boundary = 'e\u0301'.repeat(199) + '\u{1D11E}';
    h.type('deGear', boundary);
    expect(h.el('deGearCount').textContent).toBe(fill(copy.aboutGearCount!, { count: 200, max: 200 }));
    await h.click('deGearSave');
    expect(h.puts()).toHaveLength(1);
    const excess = h.el('deGear').value + 'xy';
    h.type('deGear', excess);
    expect(h.el('deGearCount').textContent).toBe(fill(copy.aboutGearOver!, { count: 202, max: 200, over: 2 }));
    await h.click('deGearSave');
    expect(h.puts()).toHaveLength(1);
    expect(h.el('deGear').value).toBe(excess);
    expect(h.el('deGearError').textContent).toBe(fill(copy.aboutGearTooLong!, { count: 202, max: 200, over: 2 }));
    expect(h.el('deGearError').hidden).toBe(false);
    expect(h.el('deGear').getAttribute('aria-invalid')).toBe('true');
    expect(h.dom.document.activeElement).toBe(h.el('deGear'));
    for (const hostile of ['Leica\tQ2', 'Leica\u200bQ2', 'Leica\u202eQ2']) {
      h.type('deGear', hostile);
      expect(h.el('deGearError').hidden).toBe(true);
      await h.click('deGearSave');
      expect(h.el('deGearError').textContent).toBe(copy.aboutGearPlain);
      expect(h.el('deGear').value).toBe(hostile);
    }
    expect(h.puts()).toHaveLength(1);
  });

  it('shows a stale-revision conflict, keeps every input and writes nothing until a confirmed reload', async () => {
    const server = stubbed({ put: (body) => body.revision === 7 ? { status: 409, body: { code: 'identity_conflict' } } : { status: 200, body: { revision: body.revision + 1 } } });
    const h = await editor({ route: server.route });
    h.type('deGear', 'Mine, DE');
    h.type('enGear', 'Mine, EN');
    server.set({ revision: 8, identity: { ...identity(), aboutGear: { de: 'Theirs, DE', en: 'Theirs, EN' } } });
    await h.click('deGearSave');
    for (const locale of ['de', 'en']) {
      expect(h.el(locale + 'GearError').textContent).toBe(copy.aboutGearConflict);
      expect(h.el(locale + 'GearSave').disabled).toBe(true);
      expect(h.el(locale + 'GearReload').hidden).toBe(false);
      // The request is stale, not the text: the field is not marked invalid.
      expect(h.el(locale + 'Gear').getAttribute('aria-invalid')).toBeNull();
    }
    expect(h.el('deGear').value).toBe('Mine, DE');
    expect(h.el('enGear').value).toBe('Mine, EN');
    expect(h.dom.document.activeElement).toBe(h.el('deGearReload'));
    await h.click('deGearSave');
    expect(h.puts()).toHaveLength(1);
    h.confirm(false);
    await h.click('deGearReload');
    expect(h.questions.at(-1)).toMatchObject({ title: copy.aboutGearReload, body: copy.aboutGearReloadConfirm });
    expect(h.el('deGear').value).toBe('Mine, DE');
    h.confirm(true);
    await h.click('deGearReload');
    expect(h.el('deGear').value).toBe('Theirs, DE');
    expect(h.el('enGear').value).toBe('Theirs, EN');
    expect(h.el('deGearError').hidden).toBe(true);
    expect(h.el('deGearReload').hidden).toBe(true);
    h.type('deGear', 'Mine again');
    await h.click('deGearSave');
    expect(h.puts()[1]).toMatchObject({ revision: 8, identity: { aboutGear: { de: 'Mine again', en: 'Theirs, EN' } } });
  });

  it('keeps the input after a network failure or an unconfirmed answer and lets the author retry', async () => {
    const replies: (Reply | undefined)[] = [undefined, { status: 500, body: { error: 'x' } }, { status: 200, body: {} }];
    const h = await editor({ route: stubbed({ put: () => replies.length ? replies.shift() : { status: 200, body: { revision: 8 } } }).route });
    h.type('deGear', 'Retry me');
    for (let attempt = 0; attempt < 3; attempt++) {
      await h.click('deGearSave');
      expect(h.el('deGearError').textContent).toBe(copy.aboutGearFailed);
      expect(h.el('deGear').value).toBe('Retry me');
      expect(h.el('deGearSave').disabled).toBe(false);
      expect(h.dom.document.activeElement).toBe(h.el('deGearSave'));
    }
    await h.click('deGearSave');
    expect(h.el('deGearError').hidden).toBe(true);
    expect(h.el('deGearStatus').textContent).toBe(copy.aboutGearSaved);
    expect(h.puts().map((body) => body.revision)).toEqual([7, 7, 7, 7]);
  });

  it('shows server validation errors inline without echoing input', async () => {
    const fields = ['aboutGear.de', 'canonicalOrigin'];
    const h = await editor({ route: stubbed({ put: () => ({ status: 400, body: { code: 'invalid_identity', field: fields.shift() } }) }).route });
    h.type('deGear', 'Valid here');
    await h.click('deGearSave');
    expect(h.el('deGearError').textContent).toBe(copy.aboutGearPlain);
    expect(h.dom.document.activeElement).toBe(h.el('deGear'));
    expect(h.el('deGear').getAttribute('aria-invalid')).toBe('true');
    await h.click('deGearSave');
    expect(h.el('deGearError').textContent).toBe(fill(copy.aboutGearOtherInvalid!, { field: 'canonicalOrigin' }));
    expect(h.el('deGear').getAttribute('aria-invalid')).toBeNull();
    expect(h.el('deGear').value).toBe('Valid here');
  });

  it.each(['de', 'en'] as const)('in %s-only mode shows that locale and never sends retained disabled-locale text', async (active) => {
    const inactive = active === 'de' ? 'en' : 'de';
    const h = await editor({ locales: [active], route: stubbed({ locales: [active] }).route });
    expect(h.el(inactive + 'GearSection').hidden).toBe(true);
    expect(h.el(active + 'GearSection').hidden).toBe(false);
    h.type(active + 'Gear', 'Only this one');
    await h.click(active + 'GearSave');
    const sent = h.puts()[0]!.identity;
    for (const field of ['tagline', 'aboutRole', 'aboutGear', 'studioDescriptor'] as const) expect(Object.keys(sent[field])).toEqual([active]);
    expect(sent.aboutGear[active]).toBe('Only this one');
  });

  it('renders German admin copy when the admin language is German', async () => {
    const h = await editor({ language: 'de', route: stubbed().route });
    const german = chrome('de');
    expect(h.el('deGearHeading').textContent).toBe(german.identityAboutGear);
    expect(h.el('enGearLabel').textContent).toBe(fill(german.aboutGearLabel!, { language: german.identityEnglish! }));
    expect(h.el('deGearSave').textContent).toBe(german.aboutGearSave);
    expect(h.el('deGearTiming').textContent).toBe(german.aboutGearTiming);
  });

  it('makes an unavailable identity explicit and retryable, never an editable blank', async () => {
    let fail = true;
    const server = stubbed({ get: () => fail ? { status: 503, body: { error: 'Site identity unavailable.' } } : undefined });
    const h = await editor({ route: (url, init) => (url === '/settings/identity' && !fail ? stubbed().route(url, init) : server.route(url, init)) });
    expect(h.el('deGearSection').hidden).toBe(false);
    expect(h.el('deGear').disabled).toBe(true);
    expect(h.el('deGearSave').disabled).toBe(true);
    expect(h.el('deGearError').textContent).toBe(copy.aboutGearLoadFailed);
    expect(h.el('deGearReload').textContent).toBe(copy.aboutGearRetry);
    fail = false;
    await h.click('deGearReload');
    expect(h.el('deGear').disabled).toBe(false);
    expect(h.el('deGear').value).toBe('Leica Q2 · Notizbuch');
    expect(h.el('deGearError').hidden).toBe(true);
  });

  it.each([['another page kind', { key: 'contact' }], ['translation preparation', { prepare: true, locales: ['de'] as LanguageConfig['locales'] }]])('stays out of %s', async (_name, extra) => {
    const h = await editor({ ...extra, route: stubbed(extra && 'locales' in extra ? { locales: extra.locales } : {}).route });
    expect(h.el('deGearSection').hidden).toBe(true);
    expect(h.el('enGearSection').hidden).toBe(true);
    expect(h.requests.some(({ url }) => url === '/settings/identity')).toBe(false);
  });
});

const queue: EncodeQueue = {
  withAdmission: (_key, operation) => operation(), availableCapacity: () => 100, onCapacity: () => () => {},
  enqueue: () => {}, isActive: () => false, recover: async () => 0, drain: async () => {}, idle: async () => {},
  quiesce: async () => {}, stats: () => ({ pending: 0, running: 0 }),
};
const backup: DbBackup = {
  dir: '/tmp/none', runNow: async () => ({}), running: () => false, sweepTempFiles: () => [],
  list: () => [], listImageArchives: () => [], state: () => ({}), listRouteArchives: () => [], quiesce: async () => {},
};
function settingsStore(): SettingsStore {
  let current: Settings = { ...defaultSettings() };
  return { get: () => ({ ...current }), update: (partial) => { current = validate({ ...current, ...partial }); return { ...current }; } };
}

describe('About editor equipment against the real identity route', () => {
  it('round-trips without touching other identity fields, retained locales or the About page, and refuses a stale tab', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'about-gear-'));
    const language = memoryLanguageStore({ primary: 'de', locales: ['de'] });
    const identityStore = memorySiteIdentityStore(identity(), language);
    const pages = memoryPageStore(language);
    let builds = 0;
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    const app = buildServer({
      trustProxy: TEST_TRUST, storageDir: dir, baseUrl: 'https://img.example', users, sessions, settings: settingsStore(),
      secrets: memorySecretsStore(), posts: memoryPostStore(), pages, language, identityStore,
      media: memoryMediaStore({ baseUrl: 'https://img.example' }), encodeQueue: queue, imgHost: 'img.example', siteDir: join(dir, 'site'),
      builder: { ...idleBuildState, build: async () => { builds++; return { ok: true, attemptId: 'r', release: 'r' }; }, hasRelease: () => true, quiesce: async () => {} },
      backupDir: join(dir, 'backup'), dbBackup: backup, dbCheck: async () => {}, commentsAdmin: memoryCommentAdminStore([], language),
    });
    try {
      const admin = await users.create({ username: 'admin', password: 'password123456', isAdmin: true });
      const cookies = { sid: await sessions.create(admin.id, 60_000) };
      const route: Route = async (url, init) => {
        const response = await app.inject({ method: (init.method ?? 'GET') as 'GET', url, cookies,
          ...(init.body ? { payload: String(init.body), headers: { 'content-type': 'application/json' } } : {}) });
        return { status: response.statusCode, body: response.body ? response.json() : null };
      };
      const seeded = await route('/pages/about', { method: 'PUT', body: JSON.stringify({ updatedAt: null, saveId: randomUUID(), expectedOwnerId: admin.id,
        de: { title: 'Über mich', bodyMarkdown: 'Hallo **Welt**', images: {} } }) });
      expect(seeded, JSON.stringify(seeded)).toMatchObject({ status: 200 });
      const pageBefore = (await route('/pages/about', {}))!.body as Record<string, unknown>;
      const before = identityStore.get();
      const buildsBefore = builds;

      const first = await editor({ locales: ['de'], route, userId: admin.id });
      const stale = await editor({ locales: ['de'], route, userId: admin.id });
      expect(first.el('deGear').value).toBe('Leica Q2 · Notizbuch');
      expect(first.el('enGearSection').hidden).toBe(true);
      first.type('deGear', 'Leica M6 · Kodak Portra 400');
      await first.click('deGearSave');
      expect(first.el('deGearStatus').textContent).toBe(copy.aboutGearSaved);

      const after = identityStore.get();
      expect(after.revision).toBe(before.revision + 1);
      // Retained English text survives the German-only edit; nothing else moves.
      expect(after.identity).toEqual({ ...before.identity, aboutGear: { en: 'Leica Q2 · notebook', de: 'Leica M6 · Kodak Portra 400' } });
      const pageAfter = (await route('/pages/about', {}))!.body as Record<string, unknown>;
      expect(pageAfter).toEqual(pageBefore);
      expect(builds).toBe(buildsBefore);

      const reloaded = await editor({ locales: ['de'], route, userId: admin.id });
      expect(reloaded.el('deGear').value).toBe('Leica M6 · Kodak Portra 400');

      stale.type('deGear', 'Stale tab text');
      await stale.click('deGearSave');
      expect(stale.el('deGearError').textContent).toBe(copy.aboutGearConflict);
      expect(stale.el('deGear').value).toBe('Stale tab text');
      expect(identityStore.get()).toEqual(after);

      first.type('deGear', '');
      await first.click('deGearSave');
      expect(identityStore.get().identity.aboutGear).toEqual({ en: 'Leica Q2 · notebook', de: '' });
    } finally { await app.close(); }
  });
});
