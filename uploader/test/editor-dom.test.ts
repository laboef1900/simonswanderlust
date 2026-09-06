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
  addEventListener(type: string, fn: () => void): void;
  fire(type: string): void;
  querySelector(): null;
  querySelectorAll(): never[];
  appendChild(): void;
  remove(): void;
  focus(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
}
interface EditorApi {
  populateForm(post: unknown): void;
  // No `status`/`scheduledAt`: the store decides status and nothing consumes
  // scheduled_at, so the editor sends neither (#121).
  buildPayload(): Omit<PostPair, 'status'>;
}

function element(): Element {
  const listeners: Record<string, (() => void)[]> = {};
  const attrs: Record<string, string> = {};
  return {
    value: '', checked: false, textContent: '', innerHTML: '', hidden: false, disabled: false,
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of listeners[type] ?? []) fn(); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, remove() {}, focus() {},
    setAttribute(k: string, v: string) { attrs[k] = v; }, getAttribute(k: string) { return attrs[k] ?? null; },
  };
}

function loadEditor(): { api: EditorApi; el: (id: string) => Element; editors: { input: { attrs: Record<string, string> } }[]; created: Element[]; dirtyCalls: () => number } {
  const elements = new Map<string, Element>();
  const created: Element[] = [];
  let dirty = 0;
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
    input = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
    codemirror = { on() {}, refresh() {}, getValue: () => this.text, setValue: (v: string) => { this.text = v; }, getInputField: () => this.input };
    value(v?: string): string { if (v !== undefined) this.text = v; return this.text; }
    toTextArea() {}
  }
  const editors: EasyMDE[] = [];
  const guard = { markDirty() { dirty += 1; }, markClean() {}, snapshot() { return 0; }, stashNow() {}, tryRestore() { return null; }, adopt() {}, dismissRestore() {}, wasDismissed() { return false; }, setKey() {}, redirectToLogin() {} };
  const ctx: Record<string, unknown> = {
    document: {
      getElementById: (id: string): Element | null => (ids.has(id) ? el(id) : null),
      querySelector: () => element(),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => { const e = element(); created.push(e); return e; },
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
    EasyMDE: class extends EasyMDE { constructor() { super(); editors.push(this); } },
    Auth: { ensureAuthed: async () => null, renderHeader() {} },
    DraftGuard: { createDraftGuard: () => guard, tabScopedKey: (p: string) => p + ':test' },
    MediaPicker: { open() {} },
    GalleryFence: {},
    AltSuggest: { wire() {} },
    Tabs: { wire: () => ({ active: () => 'de' }) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const api = vm.runInContext('({ populateForm, buildPayload })', ctx) as EditorApi;
  return { api, el, editors, created, dirtyCalls: () => dirty };
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
      categories: ['City', 'Culture'], tags: ['balkan', 'autumn'],
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
  });

  it('names the CodeMirror inputs EasyMDE swaps in for the labelled body textareas (SC 4.1.2)', () => {
    const { editors } = loadEditor();
    expect(editors.map((e) => e.input.attrs['aria-label'])).toEqual(['Body (Markdown, DE)', 'Body (Markdown, EN)']);
  });

  it('buildPayload round-trips what populateForm wrote', () => {
    const { api } = loadEditor();
    api.populateForm(fullPair());
    const out = api.buildPayload();
    expect(out.de.country).toBe('Rumänien');
    expect(out.en.country).toBe('Romania');
    expect(out.shared.categories).toEqual(['City', 'Culture']);
    expect(out.shared.tags).toEqual(['balkan', 'autumn']);
    expect(out.shared.countryCode).toBe('RO');
    expect(out.shared.region).toBe('europe');
    expect(out.shared.date).toBe('2024-10-03');
  });

  // #121: the "Post Status" select and "Scheduled Publish" field were inert —
  // the server ignores payload status and nothing consumes scheduled_at — so
  // the editor must offer neither control and send neither key, or an author
  // picks "Published", saves, and reasonably believes it worked.
  it('offers no status or schedule control and sends neither key', () => {
    const { api } = loadEditor();
    expect(ids.has('fmStatus')).toBe(false);
    expect(ids.has('fmScheduledAt')).toBe(false);
    api.populateForm({ ...fullPair(), status: 'published', shared: { ...fullPair().shared, scheduledAt: '2024-11-01T09:30:00.000Z' } });
    const out = api.buildPayload();
    expect(Object.keys(out)).not.toContain('status');
    expect(Object.keys(out.shared)).not.toContain('scheduledAt');
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
    for (const id of ['fmDate', 'fmCountryCode', 'fmRegion', 'fmLat', 'fmLng', 'fmRoute', 'fmCategories', 'fmTags',
      'deCountry', 'enCountry', 'deHeroSrc', 'enHeroSrc', 'deHeroAlt', 'enHeroAlt']) {
      expect(el(id).value, id).toBe('');
    }
  });

  // #138: a remove button's click fires neither input nor change, so the
  // delegated listeners never saw a row removal — no leave-page warning, and
  // the stale stash resurrected the removed row on restore.
  it('removing a key-fact or stop row marks the draft dirty', () => {
    const { api, created, dirtyCalls } = loadEditor();
    api.populateForm(fullPair());
    const before = dirtyCalls();
    const removeStop = created.find((e) => e.getAttribute('aria-label') === 'Remove stop');
    const removeFact = created.find((e) => e.getAttribute('aria-label') === 'Remove key fact');
    expect(removeStop && removeFact).toBeTruthy();
    removeStop!.fire('click');
    expect(dirtyCalls()).toBe(before + 1);
    removeFact!.fire('click');
    expect(dirtyCalls()).toBe(before + 2);
  });

  // Issue #122 (Golden Rule 2): the slug follows the title only while it is
  // still automatic. Before, every title keystroke on an unpublished post
  // overwrote the slug — including an imported draft's live WordPress slug.
  describe('slug auto-derivation', () => {
    const type = (el: (id: string) => Element, id: string, value: string) => { el(id).value = value; el(id).fire('input'); };

    it('derives from the title on a new post, stops once the slug is hand-edited, resumes when cleared', () => {
      const { el } = loadEditor();
      type(el, 'deTitle', 'Vier Tage in Bukarest');
      expect(el('slugFieldDe').value).toBe('vier-tage-in-bukarest');
      type(el, 'slugFieldDe', 'bukarest');
      type(el, 'deTitle', 'Vier Tage in Bukarest!');
      expect(el('slugFieldDe').value).toBe('bukarest');
      type(el, 'slugFieldDe', '');
      type(el, 'deTitle', 'Bukarest im Herbst');
      expect(el('slugFieldDe').value).toBe('bukarest-im-herbst');
    });

    it('never re-derives a slug loaded from the server, even when the title is edited', () => {
      const { api, el } = loadEditor();
      const imported = fullPair();
      imported.de.slug = '4-tage-in-bukarest'; imported.de.title = 'Vier Tage in Bukaresd';
      api.populateForm(imported);
      type(el, 'deTitle', 'Vier Tage in Bukarest');
      expect(el('slugFieldDe').value).toBe('4-tage-in-bukarest');
      expect(el('slugFieldEn').value).toBe('bucharest');
    });

    it('still derives the EN slug of a loaded DE-first draft whose EN slug is unset', () => {
      const { api, el } = loadEditor();
      const deFirst = fullPair();
      deFirst.en.slug = ''; deFirst.en.title = '';
      api.populateForm(deFirst);
      type(el, 'enTitle', 'Four days in Bucharest');
      expect(el('slugFieldEn').value).toBe('four-days-in-bucharest');
      expect(el('slugFieldDe').value).toBe('bukarest');
    });
  });
});
