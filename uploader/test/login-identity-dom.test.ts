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

function login(siteName: string, descriptor?: string) {
  const dom = editorDocument(html.slice(0, html.indexOf('<script')));
  const document = Object.assign(dom.document, { title: dom.document.querySelector('title')!.textContent, documentElement: { lang: 'en' } });
  const context: Record<string, unknown> = {
    document, EditorCopy: { en: copy },
    SiteIdentity: { siteName, studioDescriptor: descriptor ? { en: descriptor } : {}, canonicalOrigin: null },
    location: { href: '', pathname: '/login', search: '' },
    URLSearchParams, matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async () => ({ json: async () => ({ authenticated: false, needsSetup: false }) }),
    DraftGuard: { safeNextPath: () => '/admin/' },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(auth, context);
  vm.runInContext(script, context);
  return document;
}

describe('login identity chrome', () => {
  it('renders configured title and descriptor as text on the unauthenticated page', () => {
    const hostile = '</title><img src=x onerror=alert(1)>';
    const document = login(hostile, '<script>profile()</script>');
    expect(document.title).toBe('Sign in · ' + hostile);
    expect(document.getElementById('studioDescriptor')!.textContent).toBe('<script>profile()</script>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.getElementById('studioDescriptor')!.children).toHaveLength(0);
    expect(document.getElementById('studioName')!.textContent).toBe(ui.en['editor.chrome.studioName']);
  });

  it('uses the neutral localized name when identity is unset', () => {
    const document = login('');
    expect(document.title).toBe('Sign in · ' + ui.en['site.titleFallback']);
    expect(document.getElementById('studioDescriptor')!.textContent).toBe(ui.en['site.titleFallback']);
  });
});
