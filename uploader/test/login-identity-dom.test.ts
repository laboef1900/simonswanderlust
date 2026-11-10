import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { editorDocument } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';

const html = readFileSync('public/login.html', 'utf8');
const auth = readFileSync('public/auth.js', 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
const copy = Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.'))
  .map(([key, value]) => [key.slice('editor.chrome.'.length), value]));
copy.siteTitleFallback = ui.en['site.titleFallback'];
type Reply = { ok: boolean; status: number; json(): Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => body });
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function login(siteName: string, descriptor?: string, options: { needsSetup?: boolean; post?: () => Reply } = {}) {
  const dom = editorDocument(html.slice(0, html.indexOf('<script')));
  const document = Object.assign(dom.document, { title: dom.document.querySelector('title')!.textContent, documentElement: { lang: 'en' } });
  const posts: { url: string; body: string }[] = [];
  const context: Record<string, unknown> = {
    document, EditorCopy: { en: copy },
    SiteIdentity: { siteName, studioDescriptor: descriptor ? { en: descriptor } : {}, canonicalOrigin: null },
    location: { href: '', pathname: '/login', search: '' },
    URLSearchParams, matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') { posts.push({ url, body: init.body ?? '' }); return options.post?.() ?? reply(200, {}); }
      return reply(200, { authenticated: false, needsSetup: options.needsSetup ?? false });
    },
    DraftGuard: { safeNextPath: () => '/admin/' },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(auth, context);
  vm.runInContext(script, context);
  const el = (id: string) => { const node = document.getElementById(id); if (!node) throw new Error('Missing #' + id); return node; };
  const submit = async (username: string, password: string) => {
    await settle();
    el('username').value = username;
    el('password').value = password;
    el('login-form').fire('submit');
    await settle();
  };
  return { document, el, submit, posts, location: context.location as { href: string } };
}

describe('login identity chrome', () => {
  it('renders configured title and descriptor as text on the unauthenticated page', () => {
    const hostile = '</title><img src=x onerror=alert(1)>';
    const { document } = login(hostile, '<script>profile()</script>');
    expect(document.title).toBe('Sign in · ' + hostile);
    expect(document.getElementById('studioDescriptor')!.textContent).toBe('<script>profile()</script>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.getElementById('studioDescriptor')!.children).toHaveLength(0);
    expect(document.getElementById('studioName')!.textContent).toBe(ui.en['editor.chrome.studioName']);
  });

  it('uses the neutral localized name when identity is unset', () => {
    const { document } = login('');
    expect(document.title).toBe('Sign in · ' + ui.en['site.titleFallback']);
    expect(document.getElementById('studioDescriptor')!.textContent).toBe(ui.en['site.titleFallback']);
  });
});

describe('login refusals', () => {
  it('tells the author the username or password is incorrect instead of echoing the server code', async () => {
    const h = login('Field notes', undefined, { post: () => reply(401, { error: 'invalid username or password' }) });
    await h.submit('simon', 'wrong-password');
    expect(h.posts).toEqual([{ url: '/login', body: JSON.stringify({ username: 'simon', password: 'wrong-password' }) }]);
    expect(h.el('err').hidden).toBe(false);
    expect(h.el('err').textContent).toBe('The username or password is incorrect.');
    expect(h.el('out').textContent).toBe('');
    expect(h.location.href).toBe('');
  });

  it('explains a locked account as a sentence', async () => {
    const h = login('Field notes', undefined, { post: () => reply(429, { error: 'account is temporarily locked due to excessive failed login attempts' }) });
    await h.submit('simon', 'another-try');
    expect(h.el('err').textContent).toMatch(/^Too many failed attempts\. .*[.]$/);
    expect(h.el('err').textContent).not.toContain('excessive');
  });

  it('turns a first-admin setup refusal into the rule the author can act on', async () => {
    const h = login('', undefined, { needsSetup: true, post: () => reply(400, { error: 'password must be between 12 and 1024 characters' }) });
    await h.submit('simon', 'short');
    expect(h.posts[0]!.url).toBe('/setup');
    expect(h.el('err').textContent).toBe('Use a password of 12 to 1024 characters.');
  });

  it('asks for both fields before sending anything', async () => {
    const h = login('Field notes');
    await h.submit('simon', '');
    expect(h.posts).toEqual([]);
    expect(h.el('err').textContent).toBe('Enter a username and password.');
  });
});
