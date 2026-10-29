import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { editorDocument } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';

const html = readFileSync('public/settings.html', 'utf8');
const source = readFileSync('public/settings-identity.js', 'utf8');
const copy = Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.'))
  .map(([key, value]) => [key.slice('editor.chrome.'.length), value]));
const initial = (locales: ('de' | 'en')[] = ['de', 'en']) => ({
  revision: 7, savedAt: null, seedSource: 'neutral', locales,
  identity: {
    siteName: 'Field notes', authorName: 'Alex', canonicalOrigin: 'https://blog.example',
    tagline: { de: 'Unterwegs', en: 'On the road' }, aboutRole: {}, aboutGear: {}, studioDescriptor: {},
    socialLinks: [{ label: 'First', url: 'https://one.example/' }, { label: 'Second', url: 'https://two.example/' }],
  },
});
type Request = { url: string; method: string; body: string | undefined };
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

async function page(options: { locales?: ('de' | 'en')[]; route?: (request: Request) => Response | Promise<Response>; confirm?: boolean } = {}) {
  const dom = editorDocument(html.slice(0, html.indexOf('<script')));
  const document = Object.assign(dom.document, { documentElement: { lang: 'en' } });
  function el(id: string) {
    const node = document.getElementById(id);
    if (!node) throw new Error('Missing actual markup element: ' + id);
    return node;
  }
  el('panel-identity').hidden = false;
  Object.assign(el('identityForm'), { reportValidity: () => true });
  const requests: Request[] = [];
  const confirms: unknown[] = [];
  const lifecycle: string[] = [];
  const context: Record<string, unknown> = {
    document, EditorCopy: { en: copy }, location: { href: '' },
    BuildCopy: { en: Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('admin.build.')).map(([key, value]) => [key.slice('admin.build.'.length), value])) },
    AdminConfirm: { ask: async (question: unknown) => { confirms.push(question); return options.confirm ?? true; } },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const request = { url, method: init?.method ?? 'GET', body: init?.body };
      requests.push(request);
      if (request.method !== 'GET') lifecycle.push('request');
      if (url === '/rebuild/status') return Response.json({ running: null, last: null, live: null, record: 'missing' });
      if (request.method === 'GET') return Response.json(initial(options.locales));
      return options.route?.(request) ?? Response.json({ revision: 8, takesEffect: 'next_build' });
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync('public/build-reporting.js', 'utf8'), context);
  vm.runInContext(source, context);
  // The production script's public entry point, invoked after the auth gate.
  const controller = context.SettingsIdentity as { init(publication: { beginAction(): void; endAction(): void }): Promise<void> };
  await controller.init({ beginAction: () => { lifecycle.push('begin'); }, endAction: () => { lifecycle.push('end'); } });
  const submit = async () => { el('identityForm').fire('submit'); await settle(); };
  const edit = (id: string, value: string) => { el(id).value = value; el(id).fire('input'); };
  return { el, edit, submit, requests, confirms, document, lifecycle };
}

describe('Site identity settings form', () => {
  it.each(['de', 'en'] as const)('renders and submits only enabled locale: %s', async (active) => {
    const h = await page({ locales: [active] });
    const inactive = active === 'de' ? 'en' : 'de';
    expect(h.document.getElementById('identity-tagline-' + active)).not.toBeNull();
    expect(h.document.getElementById('identity-tagline-' + inactive)).toBeNull();
    h.edit('identity-tagline-' + active, '');
    await h.submit();
    const sent = JSON.parse(h.requests[1]!.body!);
    expect(sent.revision).toBe(7);
    expect(sent.identity.tagline).toEqual({ [active]: '' });
    expect(sent.identity).not.toHaveProperty('canonicalOrigin');
    expect(sent.identity).not.toHaveProperty('assets');
    expect(h.requests.map((request) => request.url)).toEqual(['/settings/identity', '/settings/identity']);
    expect(h.el('identityStatus').textContent).toBe(copy.identitySaved);
  });

  it.each([
    ['identitySiteName', 80],
    ['identityAuthorName', 80],
    ['identity-tagline-de', 160],
    ['identity-aboutRole-en', 80],
    ['identity-aboutGear-de', 200],
    ['identity-studioDescriptor-en', 80],
    ['identity-link-label-0', 40],
  ] as const)('preserves Unicode at the normalized boundary and refuses excess: %s', async (id, limit) => {
    const h = await page();
    const valid = '  ' + 'e\u0301'.repeat(limit - 1) + '\u{1D11E}' + '  ';
    h.edit(id, valid);
    await h.submit();
    expect(h.el('identityStatus').textContent).toBe(copy.identitySaved);
    expect(h.requests).toHaveLength(2);
    const excess = valid.trim() + 'x';
    h.edit(id, excess);
    await h.submit();
    expect(h.requests).toHaveLength(2);
    expect(h.el(id).value).toBe(excess);
    expect(h.el('identityStatus').textContent).toContain(copy.identityInvalid);
    expect(h.document.activeElement).toBe(h.el(id));
  });

  it('keeps hostile identity text as input values and social order through move/save', async () => {
    const h = await page();
    const hostile = '\"><img src=x onerror=alert(1)>';
    h.edit('identitySiteName', hostile);
    h.edit('identity-link-label-1', hostile);
    h.el('identity-link-up-1').click();
    await settle();
    expect(h.el('identity-link-label-0').value).toBe(hostile);
    expect(h.el('identitySocialLinks').querySelector('img')).toBeNull();
    await h.submit();
    const sent = JSON.parse(h.requests[1]!.body!);
    expect(sent.identity.siteName).toBe(hostile);
    expect(sent.identity.socialLinks).toEqual([
      { label: hostile, url: 'https://two.example/' }, { label: 'First', url: 'https://one.example/' },
    ]);
    expect(h.el('identitySave').disabled).toBe(false);
  });

  it('retains edits on conflict and requires explicit reload before another save', async () => {
    const h = await page({ route: () => Response.json({ code: 'identity_conflict' }, { status: 409 }) });
    h.edit('identitySiteName', 'Unsaved name');
    await h.submit();
    expect(h.el('identitySiteName').value).toBe('Unsaved name');
    expect(h.el('identityStatus').textContent).toBe(copy.identityConflict);
    expect(h.el('identitySave').disabled).toBe(true);
    await h.submit();
    expect(h.requests).toHaveLength(2);
    h.el('identityReload').click();
    await settle();
    expect(h.confirms).toHaveLength(1);
    expect(h.el('identitySiteName').value).toBe('Field notes');
    expect(h.el('identitySave').disabled).toBe(false);
  });

  it('does not discard unsaved input when reload confirmation is cancelled', async () => {
    const h = await page({ confirm: false });
    h.edit('identityAuthorName', 'My change');
    h.el('identityReload').click();
    await settle();
    expect(h.requests).toHaveLength(1);
    expect(h.el('identityAuthorName').value).toBe('My change');
  });

  it('advances the revision after save without silently rebuilding', async () => {
    const h = await page();
    await h.submit();
    h.edit('identityAuthorName', 'Another name');
    await h.submit();
    expect(JSON.parse(h.requests[2]!.body!).revision).toBe(8);
    expect(h.requests.every((request) => request.url === '/settings/identity')).toBe(true);
  });

  it('retains form state and re-enables controls after a network failure', async () => {
    const h = await page({ route: () => Promise.reject(new TypeError('network down')) });
    h.edit('identitySiteName', 'Retained');
    await h.submit();
    expect(h.el('identitySiteName').value).toBe('Retained');
    expect(h.el('identityFields').disabled).toBe(false);
    expect(h.el('identityStatus').textContent).toBe(ui.en['admin.build.unknown']);
  });

  it('caps ordered social links at six and confirms removal', async () => {
    const h = await page();
    for (let count = 0; count < 4; count++) h.el('identityAddLink').click();
    expect(h.el('identitySocialLinks').children).toHaveLength(6);
    expect(h.el('identityAddLink').disabled).toBe(true);
    h.el('identity-link-remove-5').click();
    await settle();
    expect(h.confirms).toHaveLength(1);
    expect(h.el('identitySocialLinks').children).toHaveLength(5);
    expect(h.el('identityAddLink').disabled).toBe(false);
  });

  it('rebuilds only on explicit confirmation and preserves unsaved inputs', async () => {
    const h = await page({ route: () => Response.json({ ok: true, release: '1793000000000-1-0001', liveRelease: null }) });
    h.edit('identitySiteName', 'Not saved');
    h.el('identityRebuild').click();
    await vi.waitFor(() => {
      expect(h.lifecycle).toEqual(['begin', 'request', 'end']);
    });
    expect(h.requests[1]).toEqual({ url: '/rebuild', method: 'POST', body: undefined });
    expect(h.confirms).toHaveLength(1);
    expect(h.el('identitySiteName').value).toBe('Not saved');
    expect(h.el('identityStatus').textContent).toContain('Release 1793000000000-1-0001 was promoted');
    expect(h.el('identityStatus').textContent).toContain('No live release yet');
    expect(h.requests).toHaveLength(2); // the shared Settings refresh owns status reads
  });

  it('reports a stopped rebuild without exposing diagnostics or urging an unsafe retry', async () => {
    const h = await page({ route: () => Response.json({ ok: false, code: 'build_stopped', error: 'SECRET', liveRelease: null }) });
    h.edit('identitySiteName', 'Unsaved local name');
    h.el('identityRebuild').click();
    await settle();
    expect(h.el('identityStatus').textContent).toContain('storage ownership/shutdown recovery');
    expect(h.el('identityStatus').textContent).not.toContain('SECRET');
    expect(h.el('identityStatus').textContent).not.toContain('Retry with Rebuild');
    expect(h.el('identitySiteName').value).toBe('Unsaved local name');
  });

  it('invalidates before a pending write and releases refresh after a failed outcome without erasing input', async () => {
    const pending = Promise.withResolvers<Response>();
    const h = await page({ route: () => pending.promise });
    h.edit('identitySiteName', 'Kept local');
    h.el('identityForm').fire('submit');
    await settle();
    expect(h.lifecycle).toEqual(['begin', 'request']);
    expect(h.el('identityFields').disabled).toBe(true);
    pending.resolve(Response.json({ error: 'failed' }, { status: 500 }));
    await settle();
    expect(h.lifecycle).toEqual(['begin', 'request', 'end']);
    expect(h.el('identitySiteName').value).toBe('Kept local');
  });

  it('does not invalidate publication reads for cancelled rebuilds or client-side validation refusal', async () => {
    const h = await page({ confirm: false });
    h.el('identityRebuild').click();
    await settle();
    expect(h.lifecycle).toEqual([]);
    h.edit('identitySiteName', 'x'.repeat(81));
    await h.submit();
    expect(h.lifecycle).toEqual([]);
  });
});
