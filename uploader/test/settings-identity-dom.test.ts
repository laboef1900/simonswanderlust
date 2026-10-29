import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
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

async function page(options: { locales?: ('de' | 'en')[]; canonicalOrigin?: string | null; route?: (request: Request) => Response | Promise<Response>; confirm?: boolean } = {}) {
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
  const context: Record<string, unknown> = {
    document, EditorCopy: { en: copy }, URL, location: { href: '', origin: 'https://admin.example:8443' },
    AdminConfirm: { ask: async (question: unknown) => { confirms.push(question); return options.confirm ?? true; } },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const request = { url, method: init?.method ?? 'GET', body: init?.body };
      requests.push(request);
      if (request.method === 'GET') {
        const data = initial(options.locales);
        return Response.json({ ...data, identity: { ...data.identity,
          canonicalOrigin: options.canonicalOrigin === undefined ? data.identity.canonicalOrigin : options.canonicalOrigin } });
      }
      return options.route?.(request) ?? Response.json({ revision: 8, takesEffect: 'next_build' });
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  // The production script's public entry point, invoked after the auth gate.
  const controller = context.SettingsIdentity as { init(): Promise<void> };
  await controller.init();
  const submit = async () => { el('identityForm').fire('submit'); await settle(); };
  const edit = (id: string, value: string) => { el(id).value = value; el(id).fire('input'); };
  return { el, edit, submit, requests, confirms, document };
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
    expect(sent.identity.canonicalOrigin).toBe('https://blog.example');
    expect(sent.identity).not.toHaveProperty('assets');
    expect(h.requests.map((request) => request.url)).toEqual(['/settings/identity', '/settings/identity']);
    expect(h.el('identityStatus').textContent).toBe(copy.identitySaved);
    expect(h.confirms).toHaveLength(0);
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
    h.edit('identityCanonicalOrigin', 'https://BÜCHER.example/');
    await h.submit();
    expect(h.el('identitySiteName').value).toBe('Retained');
    expect(h.el('identityCanonicalOrigin').value).toBe('https://BÜCHER.example/');
    expect(h.el('identityFields').disabled).toBe(false);
    expect(h.el('identityStatus').textContent).toBe(copy.identityFailed);
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
    const h = await page({ route: () => Response.json({ ok: true }) });
    h.edit('identitySiteName', 'Not saved');
    h.el('identityRebuild').click();
    await settle();
    expect(h.requests[1]).toEqual({ url: '/rebuild', method: 'POST', body: undefined });
    expect(h.confirms).toHaveLength(1);
    expect(h.el('identitySiteName').value).toBe('Not saved');
    expect(h.el('identityStatus').textContent).toBe(copy.identityRebuilt);
  });

  it('warns about stored Punycode on load and preserves the exact saved bytes', async () => {
    const h = await page({ canonicalOrigin: 'https://xn--bcher-kva.example:8443' });
    expect(h.el('identityCanonicalOrigin').value).toBe('https://xn--bcher-kva.example:8443');
    expect(h.el('identityCanonicalAscii').hidden).toBe(false);
    expect(h.el('identityCanonicalAscii').textContent).toBe(copy.identityCanonicalAscii);
    expect(h.el('identityDomainNotice').hidden).toBe(true);
  });

  it('confirms the domain scope, submits full input and displays accepted ASCII serialization', async () => {
    const h = await page();
    h.edit('identityCanonicalOrigin', 'https://BÜCHER.example:443/');
    await h.submit();
    expect(JSON.parse(h.requests[1]!.body!).identity.canonicalOrigin).toBe('https://BÜCHER.example:443/');
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toHaveProperty('body', expect.stringContaining('https://blog.example'));
    expect(h.confirms[0]).toHaveProperty('body', expect.stringContaining('https://xn--bcher-kva.example'));
    expect(h.el('identityCanonicalOrigin').value).toBe('https://xn--bcher-kva.example');
    expect(h.el('identityCanonicalAscii').hidden).toBe(false);
    expect(h.el('identityDomainNotice').hidden).toBe(true);
    await h.submit();
    expect(h.confirms).toHaveLength(1);
  });

  it('does not confirm an unchanged serialized origin or a text-only change', async () => {
    const h = await page();
    h.edit('identityCanonicalOrigin', 'https://BLOG.example:443/');
    h.edit('identitySiteName', 'New title');
    await h.submit();
    expect(h.confirms).toHaveLength(0);
    expect(h.el('identityCanonicalOrigin').value).toBe('https://blog.example');
  });

  it('retains all inputs when the domain confirmation is cancelled', async () => {
    const h = await page({ confirm: false });
    h.edit('identityCanonicalOrigin', 'https://new.example');
    h.edit('identityAuthorName', 'New author');
    await h.submit();
    expect(h.requests).toHaveLength(1);
    expect(h.el('identityCanonicalOrigin').value).toBe('https://new.example');
    expect(h.el('identityAuthorName').value).toBe('New author');
    expect(h.el('identityFields').disabled).toBe(false);
  });

  it('clears the domain to null and shows the neutral linked notice', async () => {
    const h = await page();
    h.edit('identityCanonicalOrigin', '  ');
    await h.submit();
    expect(JSON.parse(h.requests[1]!.body!).identity.canonicalOrigin).toBeNull();
    expect(h.el('identityCanonicalOrigin').value).toBe('');
    expect(h.el('identityDomainNotice').hidden).toBe(false);
    expect(h.el('identityDomainNoticeText').textContent).toBe(copy.identityDomainUnset);
    expect(h.el('identityDomainNoticeLink').getAttribute('href')).toBe('/admin/settings.html#identity');
    expect(h.el('identityCanonicalAscii').hidden).toBe(true);
  });

  it('prefills the browser origin without saving or changing the saved-domain notice', async () => {
    const h = await page({ canonicalOrigin: null });
    expect(h.el('identityDomainNotice').hidden).toBe(false);
    h.el('identityUseBrowserOrigin').click();
    expect(h.el('identityCanonicalOrigin').value).toBe('https://admin.example:8443');
    expect(h.el('identityDomainNotice').hidden).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(h.document.activeElement).toBe(h.el('identityCanonicalOrigin'));
  });

  it('rejects unparseable input without turning it into an unset domain', async () => {
    const h = await page();
    h.edit('identityCanonicalOrigin', 'not a domain');
    await h.submit();
    expect(h.requests).toHaveLength(1);
    expect(h.el('identityCanonicalOrigin').value).toBe('not a domain');
    expect(h.el('identityStatus').textContent).toContain(copy.identityInvalid);
    expect(h.document.activeElement).toBe(h.el('identityCanonicalOrigin'));
  });

  it.each([400, 409, 500])('preserves domain and other edits after HTTP %s', async (status) => {
    const h = await page({ route: () => Response.json({
      code: status === 409 ? 'identity_conflict' : 'invalid_identity', field: 'canonicalOrigin',
    }, { status }) });
    h.edit('identityCanonicalOrigin', 'https://new.example/blog');
    h.edit('identitySiteName', 'Keep this name');
    await h.submit();
    expect(JSON.parse(h.requests[1]!.body!).identity.canonicalOrigin).toBe('https://new.example/blog');
    expect(h.el('identityCanonicalOrigin').value).toBe('https://new.example/blog');
    expect(h.el('identitySiteName').value).toBe('Keep this name');
    expect(h.el('identityDomainNotice').hidden).toBe(true);
    expect(h.el('identityFields').disabled).toBe(false);
  });
});
