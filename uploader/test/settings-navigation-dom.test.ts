import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { editorDocument, type EditorElement } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';
import { DEFAULT_NAVIGATION } from '../../site/src/lib/navigation.js';
const html = readFileSync('public/settings.html', 'utf8');
const source = readFileSync('public/settings-navigation.js', 'utf8');
const copy = Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value]));
const buildCopy = Object.fromEntries(Object.entries(ui).map(([locale, values]) => [locale,
  Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('admin.build.')).map(([key, value]) => [key.slice('admin.build.'.length), value])),
]));
const release = '1793000000000-1-0001';
const successfulBuild = { ok: true, attemptId: release, release, liveRelease: release };
const failedBuild = { ok: false, attemptId: '1793000001000-1-0002', code: 'build_failed', liveRelease: null, error: 'PRIVATE /data/secret' };
type Request = { url: string; method: string; body?: string };
async function settle() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
async function page(options: { primary?: 'de' | 'en'; locales?: ('de' | 'en')[]; save?: (request: Request) => Response | Promise<Response>; confirm?: boolean } = {}) {
  const dom = editorDocument(html.slice(0, html.indexOf('<script')));
  const document = Object.assign(dom.document, { documentElement: { lang: 'en' } });
  const initial = { config: structuredClone(DEFAULT_NAVIGATION), updatedAt: '2026-01-01T00:00:00.000Z',
    language: { primary: options.primary ?? 'de', locales: options.locales ?? ['de', 'en'] }, socialLinks: [{ label: '<img onerror=x>', url: 'https://social.example/' }] };
  const requests: Request[] = []; const confirms: unknown[] = []; const lifecycle: string[] = [];
  const events = new EventTarget();
  const context: Record<string, unknown> = { document, EditorCopy: { en: copy }, BuildCopy: buildCopy, location: { href: '' },
    AbortController, setTimeout: () => 1, clearTimeout() {},
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    AdminConfirm: { ask: async (question: unknown) => { confirms.push(question); return options.confirm ?? true; } },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const request = { url, method: init?.method ?? 'GET', body: init?.body }; requests.push(request);
      if (request.method !== 'GET') lifecycle.push('request');
      if (url === '/rebuild/status') return Response.json({ live: null, running: null, last: null, record: 'missing' });
      if (url === '/pages') return Response.json({ pages: [{ key: 'about', status: 'published', locales: { de: { slug: '' }, en: { slug: '' } } }] });
      if (request.method === 'GET') return Response.json(initial);
      if (url === '/rebuild') return Response.json(successfulBuild);
      return options.save?.(request) ?? Response.json({ saved: { ...initial, config: JSON.parse(request.body!).config, updatedAt: '2026-01-02T00:00:00.000Z' }, build: successfulBuild });
    },
  };
  context.window = context; vm.createContext(context);
  vm.runInContext(readFileSync('public/build-reporting.js', 'utf8'), context);
  vm.runInContext(readFileSync('public/publication-refresh.js', 'utf8'), context);
  vm.runInContext(source, context);
  const el = (id: string) => { const node = document.getElementById(id); if (!node) throw new Error('Missing real element ' + id); return node; };
  el('panel-navigation').hidden = false;
  // The real browser script installs this controller in the VM's window.
  const reporting = context.BuildReporting as { renderStatus(root: EditorElement, value: unknown): void };
  const refresh = context.PublicationRefresh as {
    json(url: string, signal: AbortSignal): Promise<unknown>;
    create(options: { read(signal: AbortSignal): Promise<unknown>; apply(value: unknown): void; unavailable(): void }): {
      start(initial?: boolean): void; beginAction(): void; endAction(): void;
    };
  };
  const publication = refresh.create({
    read: signal => refresh.json('/rebuild/status', signal),
    apply: value => reporting.renderStatus(el('buildStatus'), value),
    unavailable() { el('buildStatus').textContent = ''; },
  });
  const controller = context.SettingsNavigation as { init(publication: { beginAction(): void; endAction(): void }): Promise<void> };
  // Record the controller's begin/end around each mutation while keeping the real refresh behaviour.
  await controller.init({
    beginAction: () => { lifecycle.push('begin'); publication.beginAction(); },
    endAction: () => { lifecycle.push('end'); publication.endAction(); },
  });
  publication.start(false);
  const edit = (id: string, value: string, event = 'input') => { el(id).value = value; el(id).fire(event); };
  const submit = async () => { el('navigationForm').fire('submit'); await settle(); };
  return { el, edit, submit, requests, confirms, document, initial, lifecycle };
}
describe('owner-usable navigation settings', () => {
  it.each(['de', 'en'] as const)('shows only enabled %s fields and preserves ordered edits through save', async (primary) => {
    const h = await page({ primary, locales: [primary] });
    const secondary = primary === 'de' ? 'en' : 'de';
    expect(h.document.getElementById('nav-header-0-label-' + secondary)).toBeNull();
    h.edit('nav-header-0-label-' + primary, '<img src=x onerror=alert(1)>');
    h.el('nav-header-0-down').click(); await settle();
    expect(h.el('nav-header-1-label-' + primary).value).toBe('<img src=x onerror=alert(1)>');
    expect(h.el('navigationSocial').querySelector('img')).toBeNull();
    await h.submit();
    const sent = JSON.parse(h.requests.find((request) => request.method === 'PUT')!.body!);
    expect(sent.config.header[1].label).toEqual({ [primary]: '<img src=x onerror=alert(1)>' });
    expect(h.el('navigationStatus').textContent).toContain(release);
    expect(h.el('navigationStatus').querySelector('a')).toBeNull();
  });
  it('authors legal page links, marks unpublished targets and enforces slot capacity', async () => {
    const h = await page();
    h.el('nav-add-legal').click();
    h.edit('nav-legal-0-kind', 'page', 'change'); h.edit('nav-legal-0-target', 'privacy', 'change');
    expect(h.el('nav-legal-0-notice-de').textContent).toContain(copy.navigationUnavailable);
    for (let i = 0; i < 3; i++) h.el('nav-add-legal').click();
    expect(h.el('nav-add-legal').disabled).toBe(true);
    await h.submit();
    const sent = JSON.parse(h.requests.find((request) => request.method === 'PUT')!.body!);
    expect(sent.config.legal).toHaveLength(4); expect(sent.config.legal[0].target).toBe('privacy');
  });
  it('retains input and disables stale resubmission until confirmed reload', async () => {
    const h = await page({ save: () => Response.json({ code: 'conflict' }, { status: 409 }) });
    h.edit('nav-header-0-label-de', 'Retained'); await h.submit();
    expect(h.el('nav-header-0-label-de').value).toBe('Retained');
    expect(h.el('navigationSave').disabled).toBe(true);
    await h.submit(); expect(h.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    h.el('navigationReload').click(); await settle();
    expect(h.confirms).toHaveLength(1); expect(h.el('navigationSave').disabled).toBe(false);
  });
  it('adopts the acknowledged token after failed rebuild and retries rebuild without resaving', async () => {
    const h = await page({ save: (request) => Response.json({ build: failedBuild,
      saved: { config: JSON.parse(request.body!).config, updatedAt: '2026-01-03T00:00:00.000Z', language: { primary: 'de', locales: ['de', 'en'] } } }) });
    h.edit('nav-header-0-label-de', 'Saved despite failed rebuild');
    await h.submit();
    const status = h.el('navigationStatus');
    expect(status.textContent).toContain(ui.en['admin.build.failure.build_failed']);
    expect(status.textContent).toContain(ui.en['admin.build.noLive']);
    expect(status.textContent).not.toContain('PRIVATE');
    expect(h.el('nav-header-0-label-de').value).toBe('Saved despite failed rebuild');
    expect(h.el('navigationSave').disabled).toBe(false);
    expect(status.querySelector('a')?.href).toBe('/admin/settings.html#site');
    expect(status.querySelector('a')?.textContent.trim()).not.toBe('');
    expect(h.document.activeElement).toBe(status);
    h.el('navigationRebuild').click(); await settle();
    expect(h.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(h.requests.filter((request) => request.url === '/rebuild')).toHaveLength(1);
    expect(h.el('navigationStatus').textContent).toContain(release);
    h.edit('nav-header-0-label-de', 'Next'); await h.submit();
    expect(JSON.parse(h.requests.filter((request) => request.method === 'PUT')[1]!.body!).updatedAt).toBe('2026-01-03T00:00:00.000Z');
    // Every build-triggering mutation suspends the shared publication refresh (#317), like identity/language.
    expect(h.lifecycle).toEqual(['begin', 'request', 'end', 'begin', 'request', 'end', 'begin', 'request', 'end']);
  });
  it('retains input on unacknowledged network failure and cancelled reload/removal', async () => {
    const h = await page({ confirm: false, save: () => Promise.reject(new Error('network lost')) });
    h.edit('nav-header-0-label-de', 'Retained'); await h.submit();
    expect(h.el('navigationStatus').textContent).not.toBe('');
    expect(h.el('navigationStatus').textContent).not.toContain(release);
    expect(h.el('navigationStatus').querySelector('a')).toBeNull();
    expect(h.el('navigationSave').disabled).toBe(true);
    await h.submit(); expect(h.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    h.el('navigationReload').click(); await settle();
    expect(h.el('nav-header-0-label-de').value).toBe('Retained');
    h.el('nav-header-0-remove').click(); await settle();
    expect(h.el('nav-header-0-label-de').value).toBe('Retained');
  });
});
