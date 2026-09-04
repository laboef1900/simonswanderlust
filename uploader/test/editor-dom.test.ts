import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { PostPair } from '../src/posts.js';

// editor.html's inline script is plain top-level browser code. Run it in a vm
// context whose `document.getElementById` answers from the REAL markup's ids —
// null for anything the page does not contain — so populateForm()/buildPayload()
// are exercised against the elements that actually exist. Source-text substring
// checks let #105 through (an input was removed while the JS still read it);
// this is the only kind of test that catches a script/markup drift.
const html = readFileSync('public/editor.html', 'utf8');
const scriptStart = html.lastIndexOf('<script>');
const script = html.slice(html.indexOf("'use strict'", scriptStart), html.lastIndexOf('</script>'));
const markup = html.slice(0, scriptStart);
const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

interface Element {
  value: string;
  checked: boolean;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  disabled: boolean;
  dataset: Record<string, string>;
  style: Record<string, string>;
  classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
  addEventListener(): void;
  querySelector(): null;
  querySelectorAll(): never[];
  appendChild(): void;
  remove(): void;
  focus(): void;
  setAttribute(): void;
  getAttribute(): null;
}
interface EditorApi {
  populateForm(post: unknown): void;
  buildPayload(): PostPair;
}

function element(): Element {
  return {
    value: '', checked: false, textContent: '', innerHTML: '', hidden: false, disabled: false,
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, remove() {}, focus() {}, setAttribute() {}, getAttribute() { return null; },
  };
}

function loadEditor(): { api: EditorApi; el: (id: string) => Element } {
  const elements = new Map<string, Element>();
  const el = (id: string): Element => {
    if (!ids.has(id)) throw new Error('no element #' + id + ' in editor.html');
    let e = elements.get(id);
    if (!e) { e = element(); elements.set(id, e); }
    return e;
  };
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string): string | null => m.get(k) ?? null,
      setItem: (k: string, v: string): void => { m.set(k, String(v)); },
      removeItem: (k: string): void => { m.delete(k); },
    };
  };
  class EasyMDE {
    private text = '';
    codemirror = { on() {}, refresh() {}, getValue: () => this.text, setValue: (v: string) => { this.text = v; } };
    value(v?: string): string { if (v !== undefined) this.text = v; return this.text; }
    toTextArea() {}
  }
  const guard = { markDirty() {}, markClean() {}, snapshot() { return 0; }, stashNow() {}, tryRestore() { return null; }, dismissRestore() {}, wasDismissed() { return false; }, setKey() {}, redirectToLogin() {} };
  const ctx: Record<string, unknown> = {
    document: {
      getElementById: (id: string): Element | null => (ids.has(id) ? el(id) : null),
      querySelector: () => element(),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => element(),
    },
    location: { search: '', pathname: '/admin/editor.html', href: '' },
    history: { replaceState() {} },
    sessionStorage: storage(),
    localStorage: storage(),
    fetch: () => Promise.reject(new Error('no network in test')),
    setTimeout: () => 0,
    clearTimeout() {},
    URLSearchParams,
    console,
    alert() {},
    confirm: () => false,
    navigator: {},
    EasyMDE,
    Auth: { ensureAuthed: async () => null, renderHeader() {} },
    DraftGuard: { createDraftGuard: () => guard },
    MediaPicker: { open() {} },
    GalleryFence: {},
    AltSuggest: { wire() {} },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const api = vm.runInContext('({ populateForm, buildPayload })', ctx) as EditorApi;
  return { api, el };
}

function fullPair(): PostPair {
  const loc = (locale: 'de' | 'en', slug: string, title: string, country: string) => ({
    locale, slug, title, excerpt: 'x', country,
    heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
    bodyMarkdown: '## Hi', images: {}, keyFacts: { Dauer: '4 Tage' },
  });
  return {
    translationKey: 'tk1', status: 'draft',
    shared: {
      date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 },
      stops: [{ name: 'Bukarest', lat: 44.4, lng: 26.1 }], route: 'Bukarest – Brașov',
      categories: ['City', 'Culture'], tags: ['balkan', 'autumn'], scheduledAt: '2024-11-01T09:30:00.000Z',
    },
    de: loc('de', 'bukarest', 'Bukarest', 'Rumänien'),
    en: loc('en', 'bucharest', 'Bucharest', 'Romania'),
  };
}

// What DraftGuard actually stashes: buildPayload() deletes every empty/undefined
// key, so a restore payload for a blank form carries no shared fields at all.
type StashPayload = Omit<PostPair, 'shared' | 'de' | 'en'> & {
  shared: Partial<PostPair['shared']>;
  de: Omit<PostPair['de'], 'heroImage'>;
  en: Omit<PostPair['en'], 'heroImage'>;
};

function minimalPair(): StashPayload {
  const loc = (locale: 'de' | 'en') => ({ locale, slug: 'x', title: 'X', excerpt: '', country: '', bodyMarkdown: '', images: {} });
  return { translationKey: 'tk1', status: 'draft', shared: {}, de: loc('de'), en: loc('en') };
}

describe('editor.html inline script against its own markup', () => {
  it('populateForm fills every shared and per-locale field from a full PostPair', () => {
    const { api, el } = loadEditor();
    expect(() => api.populateForm(fullPair())).not.toThrow();
    expect(el('deCountry').value).toBe('Rumänien');
    expect(el('enCountry').value).toBe('Romania');
    expect(el('fmCountryCode').value).toBe('RO');
    expect(el('fmDate').value).toBe('2024-10-03');
    expect(el('fmRegion').value).toBe('europe');
    expect(el('fmCategories').value).toBe('City, Culture');
    expect(el('fmTags').value).toBe('balkan, autumn');
    expect(el('fmScheduledAt').value).toBe('2024-11-01T09:30');
  });

  it('buildPayload round-trips what populateForm wrote', () => {
    const { api } = loadEditor();
    api.populateForm(fullPair());
    const out = api.buildPayload();
    expect(out.de.country).toBe('Rumänien');
    expect(out.en.country).toBe('Romania');
    expect(out.shared.categories).toEqual(['City', 'Culture']);
    expect(out.shared.tags).toEqual(['balkan', 'autumn']);
    expect(out.shared.scheduledAt).toBe('2024-11-01T09:30');
    expect(out.shared.countryCode).toBe('RO');
    expect(out.shared.region).toBe('europe');
    expect(out.shared.date).toBe('2024-10-03');
  });

  it('buildPayload does not throw on a pristine form (new post → Save draft)', () => {
    const { api } = loadEditor();
    expect(() => api.buildPayload()).not.toThrow();
    expect(api.buildPayload().de.country).toBe('');
  });

  it('a minimal restore payload clears every field the previous post filled (no resurrection)', () => {
    const { api, el } = loadEditor();
    api.populateForm(fullPair());
    api.populateForm(minimalPair());
    for (const id of ['fmDate', 'fmCountryCode', 'fmRegion', 'fmLat', 'fmLng', 'fmRoute', 'fmCategories', 'fmTags', 'fmScheduledAt',
      'deCountry', 'enCountry', 'deHeroSrc', 'enHeroSrc', 'deHeroAlt', 'enHeroAlt']) {
      expect(el(id).value, id).toBe('');
    }
  });
});
