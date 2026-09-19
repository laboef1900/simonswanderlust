import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { PostPair } from '../src/posts.js';
import type { EditorialReviewResult } from '../src/editorial-review.js';
import { editorDocument, EditorElement, EditorEvent } from './editor-dom-harness.js';

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

type Element = EditorElement;

interface ReviewStory {
  locale: 'de' | 'en';
  title: string;
  excerpt: string;
  markdown: string;
  heroAlt: string;
  heroSrc: string;
}

type Review = (baseUrl: string, model: string, prompt: string, story: ReviewStory, apiKey: string | null, timeoutMs: number, signal: AbortSignal) => Promise<EditorialReviewResult>;
type Fetch = (url: string, options?: RequestInit) => Promise<Response>;

interface EditorOptions {
  fetch?: Fetch;
  review?: Review;
  isAdmin?: boolean;
}
interface EditorApi {
  populateForm(post: unknown): void;
  loadPost(translationKey: string): Promise<boolean>;
  // No `status`/`scheduledAt`: the store decides status and nothing consumes
  // scheduled_at, so the editor sends neither (#121).
  buildPayload(): Omit<PostPair, 'status'>;
}


function loadEditor(options: EditorOptions = {}) {
  const dom = editorDocument(markup);
  let dirty = 0;
  let redirects = 0;
  const requests: { url: string; options: RequestInit }[] = [];
  const el = (id: string): Element => {
    const element = dom.document.getElementById(id);
    if (!element) throw new Error('no element #' + id + ' in editor.html');
    return element;
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
    private readonly changes: (() => void)[] = [];
    input = dom.document.createElement('textarea');
    cursor: { line: number; ch: number } | null = null;
    focusCalls = 0;
    codemirror = {
      on: (event: string, callback: () => void) => { if (event === 'change') this.changes.push(callback); },
      refresh() {},
      getValue: () => this.text,
      setValue: (value: string) => { this.value(value); },
      getInputField: () => this.input,
      setCursor: (position: { line: number; ch: number }) => { this.cursor = position; },
      focus: () => { this.focusCalls += 1; this.input.focus(); },
    };
    value(value?: string): string {
      if (value !== undefined) {
        this.text = value;
        for (const callback of this.changes) callback();
      }
      return this.text;
    }
    toTextArea() {}
  }
  const editors: EasyMDE[] = [];
  const guard = { markDirty() { dirty += 1; }, markClean() {}, snapshot() { return 0; }, stashNow() {}, tryRestore() { return null; }, adopt() {}, dismissRestore() {}, wasDismissed() { return false; }, setKey() {}, redirectToLogin() { redirects += 1; } };
  const ctx: Record<string, unknown> = {
    document: dom.document,
    location: { search: '', pathname: '/admin/editor.html', href: '' },
    history: { replaceState() {} },
    sessionStorage: storage(),
    localStorage: storage(),
    fetch: (url: string, init: RequestInit = {}) => {
      requests.push({ url: String(url), options: init });
      return options.fetch?.(String(url), init) ?? Promise.reject(new Error('no network in test'));
    },
    setTimeout: () => 0,
    clearTimeout() {},
    URLSearchParams,
    URL,
    AbortController,
    Event: EditorEvent,
    KeyboardEvent: EditorEvent,
    console,
    alert() {},
    confirm: () => false,
    navigator: {},
    EasyMDE: class extends EasyMDE {
      constructor(settings: { element: Element }) {
        super();
        settings.element.parentElement!.appendChild(this.input);
        editors.push(this);
      }
    },
    Auth: { ensureAuthed: async () => options.isAdmin === undefined ? null : { isAdmin: options.isAdmin }, renderHeader() {} },
    AdminConfirm: { ask: async () => false, liveUrls: () => ({ de: '', en: '' }), urlsPlain: () => '' },
    DraftGuard: { createDraftGuard: () => guard, tabScopedKey: (p: string) => p + ':test' },
    MediaPicker: { open() {} },
    // Loaded by editor.html for thumbUrl(), which the hero focal-point
    // control uses to show the frame an author is framing.
    PostsFilter: { thumbUrl: () => null },
    AltSuggest: { wire() {} },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const file of ['gallery-fence.js', 'editor-linter.js', 'llm.js', 'tabs.js', 'editor-review.js']) {
    vm.runInContext(readFileSync('public/' + file, 'utf8'), ctx, { filename: file });
  }
  if (options.review) (ctx.LLM as { reviewStory: Review }).reviewStory = options.review;
  vm.runInContext(script, ctx);
  const api = vm.runInContext('({ populateForm, buildPayload, loadPost })', ctx) as EditorApi;
  return {
    api, el, editors, created: dom.created, document: dom.document, requests,
    flushDialogEvents: dom.flushDialogEvents,
    dirtyCalls: () => dirty, redirects: () => redirects,
  };
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

  /**
   * The cover flag is declared in four places across two tsconfigs —
   * `PostShared` here, the `posts.featured` column, the loader's `PostRow` and
   * the Zod schema — and it is optional everywhere, so a checkbox the script
   * never reads (or a payload key the markup has no control for) type-checks
   * perfectly while the author's choice is dropped on save. Only a round-trip
   * through the real markup catches that.
   */
  it('round-trips the homepage-cover checkbox, and sends false when unticked', () => {
    const { api, el } = loadEditor();
    api.populateForm({ ...fullPair(), shared: { ...fullPair().shared, featured: true } });
    expect(el('fmFeatured').checked).toBe(true);
    expect(api.buildPayload().shared.featured).toBe(true);

    // A payload without the key means "not the cover": the box must clear
    // rather than keep the previously loaded post's choice.
    api.populateForm(fullPair());
    expect(el('fmFeatured').checked).toBe(false);
    expect(api.buildPayload().shared.featured).toBe(false);
  });

  // #87's rule: a cover choice is not translatable, so the control belongs in
  // the shared sidebar. Inside a locale tab it would read as a per-locale
  // choice while the server writes one value to both rows. (Its accessible
  // name is covered generically by admin-a11y.test.ts.)
  it('keeps the cover checkbox outside both locale tabs', () => {
    const { el } = loadEditor();
    expect(el('expeditionDetails').contains(el('fmFeatured'))).toBe(true);
    expect(el('tab-de').contains(el('fmFeatured'))).toBe(false);
    expect(el('tab-en').contains(el('fmFeatured'))).toBe(false);
  });

  /**
   * The focal point is declared in THREE places across two tsconfigs —
   * `HeroImage` here, `RemoteHeroImage` in site/src/lib/images.ts, and the Zod
   * schema in site/src/content.config.ts — and it is optional, so a one-sided
   * change type-checks clean while the author's framing is silently dropped on
   * save. Only a round-trip through the real markup catches that.
   */
  it('round-trips a hero focal point, and omits it when centred', () => {
    const { api, el } = loadEditor();
    const pair = fullPair();
    pair.de.heroImage = { ...pair.de.heroImage, focus: { x: 22, y: 18 } };
    api.populateForm(pair);
    expect(Number(el('deHeroFocusX').value)).toBe(22);
    expect(Number(el('deHeroFocusY').value)).toBe(18);
    // The EN hero carries none, so its sliders must read centred rather than
    // inherit the DE values off screen.
    expect(Number(el('enHeroFocusX').value)).toBe(50);

    const out = api.buildPayload();
    expect(out.de.heroImage.focus).toEqual({ x: 22, y: 18 });
    // 50/50 is the unset value: a centred point must not be stored, or every
    // post gains a field and "reset to centre" becomes a no-op.
    expect(out.en.heroImage.focus).toBeUndefined();
  });

  it('clears a loaded focal point when the next payload carries none (no resurrection)', () => {
    const { api, el } = loadEditor();
    const framed = fullPair();
    framed.de.heroImage = { ...framed.de.heroImage, focus: { x: 5, y: 95 } };
    api.populateForm(framed);
    expect(Number(el('deHeroFocusX').value)).toBe(5);
    api.populateForm(fullPair());
    expect(Number(el('deHeroFocusX').value)).toBe(50);
    expect(api.buildPayload().de.heroImage.focus).toBeUndefined();
  });

  // #121: the "Post Status" select and "Scheduled Publish" field were inert —
  // the server ignores payload status and nothing consumes scheduled_at — so
  // the editor must offer neither control and send neither key, or an author
  // picks "Published", saves, and reasonably believes it worked.
  it('offers no status or schedule control and sends neither key', () => {
    const { api, document } = loadEditor();
    expect(document.getElementById('fmStatus')).toBeNull();
    expect(document.getElementById('fmScheduledAt')).toBeNull();
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

const reviewConfig = {
  aiProvider: 'custom', aiBaseUrl: 'https://review.invalid/v1', aiModel: 'fixture-model',
  reviewPrompt: 'Review this fictional travel draft.', reviewTimeoutMs: 60000, aiApiKey: null,
};
const providerUrl = reviewConfig.aiBaseUrl + '/chat/completions';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function reviewResult(title = 'Four days exploring Bucharest'): EditorialReviewResult {
  return {
    title: { status: 'warn', critique: 'Name the place and the length of the stay.', suggestions: [title] },
    excerpt: { status: 'warn', critique: 'Summarise the route.', suggestedExcerpt: 'A four-day walk through Bucharest, with a tram ride, old streets and practical notes from the trip.' },
    headings: { status: 'pass', critique: 'The route has a clear reading order.' },
    practicalDetails: { status: 'warn', critique: 'Explain the tram ticket.', missingAspects: ['Where the ticket was purchased'] },
    internalLinks: { status: 'info', linkOpportunities: ['An existing story about a nearby trip, if relevant'] },
  };
}

function completion(result: EditorialReviewResult) {
  return response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
}

function reviewNetwork(provider: () => Promise<Response>, config = reviewConfig): Fetch {
  return async (url) => {
    if (url === '/ai-config') return response(config);
    if (url === providerUrl) return provider();
    throw new Error('Unexpected request in editor integration: ' + url);
  };
}

// For ownership races only, model a provider/client that ignores cancellation.
// Ordinary success and malformed-output tests exercise the real browser LLM.
function deferredReviews() {
  const calls: { story: ReviewStory; signal: AbortSignal; result: PromiseWithResolvers<EditorialReviewResult> }[] = [];
  const review: Review = (_url, _model, _prompt, story, _key, _timeout, signal) => {
    const result = Promise.withResolvers<EditorialReviewResult>();
    calls.push({ story, signal, result });
    return result.promise;
  };
  return { calls, review };
}

function required(root: Element, selector: string): Element {
  const node = root.querySelector(selector);
  if (!node) throw new Error('Missing editor control: ' + selector);
  return node;
}

describe('Story review in the real editor', () => {
  it('opens an accessible dialog and renders all quick checks before configuration resolves', () => {
    const config = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: () => config.promise });
    h.api.populateForm(fullPair());
    h.el('deTitle').value = 'A long enough fictional trip title';
    h.el('deExcerpt').value = 'Short';
    h.editors[0]!.value('## Walking route\n\nOrdinary draft prose.');
    const dirtyBefore = h.dirtyCalls();
    const before = h.api.buildPayload();
    h.el('reviewStory').focus();
    h.el('reviewStory').click();

    const dialog = h.el('storyReviewDialog');
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe(h.el('storyReviewHeading').id);
    expect(h.el('reviewStatus').getAttribute('role')).toBe('status');
    expect(h.el('reviewStatus').getAttribute('aria-live')).toBe('polite');
    expect(h.document.activeElement).toBe(h.el('closeReview'));
    expect(h.el('reviewInstant').querySelectorAll('[data-review-criterion]').map((node) => node.dataset.reviewCriterion))
      .toEqual(['title', 'excerpt', 'headings', 'altText', 'internalLinks']);
    expect(required(h.el('reviewInstant'), '[data-review-criterion="title"]').textContent).toContain('Pass');
    expect(required(h.el('reviewInstant'), '[data-review-criterion="excerpt"]').textContent).toContain('Warning');
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('true');
    expect(h.el('reviewSemantic').children).toHaveLength(0);
    expect(h.dirtyCalls()).toBe(dirtyBefore);
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.el('saveDraft').disabled).toBe(false);
    expect(h.el('publishBtn').disabled).toBe(false);
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it.each(['de', 'en'] as const)('reviews the unsaved %s fields and CodeMirror body, then renders semantic suggestions without applying them', async (locale) => {
    const provider = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: reviewNetwork(() => provider.promise) });
    h.api.populateForm(fullPair());
    h.el('tabbtn-' + locale).click();
    const snapshot: ReviewStory = {
      locale, title: locale === 'de' ? 'Ungespeicherter Stadtrundgang' : 'Unsaved city walking route',
      excerpt: 'A freshly edited summary, not the stored excerpt.',
      markdown: '## Unsaved route\n\n[Earlier trip](/earlier-trip/)',
      heroAlt: 'Tram passing an old building', heroSrc: 'https://img.invalid/new-hero',
    };
    for (const [suffix, value] of [['Title', snapshot.title], ['Excerpt', snapshot.excerpt], ['HeroAlt', snapshot.heroAlt], ['HeroSrc', snapshot.heroSrc]]) {
      h.el(locale + suffix).value = value!;
      h.el(locale + suffix).fire('input');
    }
    h.el(locale + 'Body').value = 'Stale hidden textarea';
    h.editors[locale === 'de' ? 0 : 1]!.value(snapshot.markdown);
    const before = h.api.buildPayload();
    h.el('reviewStory').click();
    await settle();

    const request = h.requests.find((request) => request.url === providerUrl)!;
    const payload = JSON.parse(String(request.options.body)) as { messages: { role: string; content: string }[] };
    expect(JSON.parse(payload.messages.find((message) => message.role === 'user')!.content)).toEqual(snapshot);
    expect(h.el('reviewLocale').textContent).toContain(locale.toUpperCase());
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('true');
    provider.resolve(completion(reviewResult()));
    await settle();

    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(required(h.el('reviewSemantic'), '[data-review-criterion="practicalDetails"]').textContent)
      .toContain(reviewResult().practicalDetails.missingAspects[0]);
    expect(required(h.el('reviewSemantic'), '[data-review-criterion="internalLinks"]').textContent).toContain('Suggestion');
    expect(required(h.el('reviewSemantic'), '[data-review-action="title"]').disabled).toBe(false);
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.requests.map((request) => request.url)).toEqual(['/ai-config', providerUrl]);
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it.each([
    { name: 'offline provider', provider: async () => { throw new Error('private-provider-detail'); } },
    { name: 'provider authentication failure', provider: async () => response({ error: 'private-provider-detail' }, 401) },
    { name: 'malformed semantic response', provider: async () => response({ choices: [{ message: { content: '{"title":"private-provider-detail"}' } }] }) },
  ])('preserves instant checks and offers recovery after $name', async ({ provider }) => {
    const h = loadEditor({ fetch: reviewNetwork(provider) });
    h.el('reviewStory').click();
    const quickChecks = h.el('reviewInstant').textContent;
    await settle();

    expect(h.el('storyReviewDialog').open).toBe(true);
    expect(h.el('reviewInstant').textContent).toBe(quickChecks);
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(h.el('reviewStatus').textContent).toMatch(/check|configure|again/i);
    expect(h.el('reviewStatus').textContent).toContain('Warning');
    expect(h.el('reviewStatus').textContent).not.toContain('private-provider-detail');
    expect(h.el('reviewSemantic').querySelector('[data-review-action]')).toBeNull();
    expect(h.el('runReview').disabled).toBe(false);
    expect(h.el('saveDraft').disabled).toBe(false);
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it.each(['openrouter', 'deepseek'])('does not contact a fallback provider when %s has no key', async (aiProvider) => {
    const h = loadEditor({ isAdmin: false, fetch: reviewNetwork(async () => completion(reviewResult()), { ...reviewConfig, aiProvider }) });
    await settle();
    h.el('reviewStory').click();
    const instant = h.el('reviewInstant').textContent;
    await settle();

    expect(h.requests.map((request) => request.url)).toEqual(['/ai-config']);
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(h.el('reviewInstant').textContent).toBe(instant);
    expect(h.el('reviewStatus').textContent).toMatch(/API key/i);
    expect(h.el('reviewStatus').textContent).toMatch(/administrator/i);
    expect(h.el('reviewStatus').querySelector('a[href]')).toBeNull();
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it('keeps quick checks usable when configuration fails, with a settings link only for administrators', async () => {
    const h = loadEditor({ isAdmin: true, fetch: async () => response({ error: 'private-config-detail' }, 503) });
    await settle();
    h.el('reviewStory').click();
    const instant = h.el('reviewInstant').textContent;
    await settle();

    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(h.el('reviewInstant').textContent).toBe(instant);
    expect(required(h.el('reviewStatus'), 'a[href]').getAttribute('href')).toBe('/admin/settings.html');
    expect(h.el('reviewStatus').textContent).not.toContain('private-config-detail');
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it('uses the draft-preserving login redirect when the editor session expires', async () => {
    const h = loadEditor({ fetch: async () => response({}, 401) });
    h.el('deTitle').value = 'Still unsaved';
    h.el('deTitle').fire('input');
    h.el('reviewStory').click();
    await settle();
    expect(h.redirects()).toBe(1);
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
    expect(h.el('deTitle').value).toBe('Still unsaved');
    expect(h.requests.map((request) => request.url)).toEqual(['/ai-config']);
    h.flushDialogEvents();
  });

  it.each([
    { name: 'new automatic slug', loaded: false, manual: false, locale: 'de' as const, expected: 'four-days-exploring-bucharest' },
    { name: 'loaded WordPress slug', loaded: true, manual: false, locale: 'de' as const, expected: 'bukarest' },
    { name: 'manually entered EN slug', loaded: false, manual: true, locale: 'en' as const, expected: 'keep-this-live-url' },
  ])('applies only on explicit clicks and respects the $name', async ({ loaded, manual, locale, expected }) => {
    const h = loadEditor({ fetch: reviewNetwork(async () => completion(reviewResult())) });
    if (loaded) h.api.populateForm(fullPair());
    else {
      h.el('deTitle').value = 'Original German title';
      h.el('enTitle').value = 'Original English title';
      h.editors[0]!.value('## German prose\n\nDo not rewrite this.');
      h.editors[1]!.value('## English prose\n\nLeave the other locale alone.');
    }
    h.el('tabbtn-' + locale).click();
    if (manual) {
      h.el('slugFieldEn').value = 'keep-this-live-url';
      h.el('slugFieldEn').fire('input');
    }
    const before = h.api.buildPayload();
    const dirtyBefore = h.dirtyCalls();
    h.el('reviewStory').click();
    await settle();
    expect(h.api.buildPayload()).toEqual(before);
    expect(h.dirtyCalls()).toBe(dirtyBefore);

    const title = required(h.el('reviewSemantic'), '[data-review-action="title"]');
    title.click();
    expect(h.el(locale + 'Title').value).toBe(reviewResult().title.suggestions![0]);
    expect(h.el(locale === 'de' ? 'slugFieldDe' : 'slugFieldEn').value).toBe(expected);
    expect(h.dirtyCalls()).toBe(dirtyBefore + 1);
    expect(title.disabled).toBe(true);
    expect(h.el('storyReviewDialog').open).toBe(true);
    const excerpt = required(h.el('reviewSemantic'), '[data-review-action="excerpt"]');
    expect(excerpt.disabled).toBe(false);
    excerpt.click();
    expect(h.el(locale + 'Excerpt').value).toBe(reviewResult().excerpt.suggestedExcerpt);
    expect(h.dirtyCalls()).toBe(dirtyBefore + 2);
    expect(excerpt.disabled).toBe(true);
    const after = h.api.buildPayload();
    expect(after[locale === 'de' ? 'en' : 'de']).toEqual(before[locale === 'de' ? 'en' : 'de']);
    expect(after.de.bodyMarkdown).toBe(before.de.bodyMarkdown);
    expect(after.en.bodyMarkdown).toBe(before.en.bodyMarkdown);
    expect(after.shared).toEqual(before.shared);
    expect(h.requests.map((request) => request.url)).toEqual(['/ai-config', providerUrl]);
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it('jumps to real inline and gallery lines, then hero alt, without a queued close stealing focus', () => {
    const config = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: () => config.promise });
    h.el('tabbtn-en').click();
    h.el('enHeroSrc').value = 'https://img.invalid/hero';
    h.el('enHeroAlt').value = '';
    h.editors[1]!.value([
      '## Route', '', '![](https://img.invalid/inline)', '',
      '```gallery', '#layout: column', '', 'https://img.invalid/gallery | 640x480', '```',
    ].join('\n'));

    for (const [line, cursor] of [[3, 2], [8, 7]]) {
      h.el('reviewStory').click();
      required(h.el('reviewInstant'), `[data-review-action="jump"][data-line="${line}"]`).click();
      expect(h.el('storyReviewDialog').open).toBe(false);
      expect(h.editors[1]!.cursor).toEqual({ line: cursor, ch: 0 });
      expect(h.document.activeElement).toBe(h.editors[1]!.input);
      h.flushDialogEvents();
      expect(h.document.activeElement).toBe(h.editors[1]!.input);
    }
    h.el('reviewStory').click();
    required(h.el('reviewInstant'), '[data-review-action="jump"][data-target="hero"]').click();
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.document.activeElement).toBe(h.el('enHeroAlt'));
    h.flushDialogEvents();
    expect(h.document.activeElement).toBe(h.el('enHeroAlt'));
    expect(h.editors[0]!.focusCalls).toBe(0);
  });

  it('wraps keyboard focus including asynchronous actions and restores the trigger on Escape or Close', async () => {
    const h = loadEditor({ fetch: reviewNetwork(async () => completion(reviewResult())) });
    h.el('reviewStory').focus();
    h.el('reviewStory').click();
    await settle();
    const dialog = h.el('storyReviewDialog');
    const controls = dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')
      .filter((control) => !control.disabled && control.tabIndex >= 0 && !control.closest('[hidden]'));
    const first = controls[0]!;
    const last = controls.at(-1)!;
    const dynamic = required(h.el('reviewSemantic'), '[data-review-action="excerpt"]');
    expect(controls).toContain(dynamic);
    dynamic.focus();
    expect(dynamic.fire('keydown', { key: 'Tab' }).defaultPrevented).toBe(false);
    first.focus();
    expect(first.fire('keydown', { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
    expect(h.document.activeElement).toBe(last);
    expect(last.fire('keydown', { key: 'Tab' }).defaultPrevented).toBe(true);
    expect(h.document.activeElement).toBe(first);
    first.fire('keydown', { key: 'Escape' });
    expect(dialog.open).toBe(false);
    h.flushDialogEvents();
    expect(h.document.activeElement).toBe(h.el('reviewStory'));
    h.el('reviewStory').click();
    h.el('closeReview').click();
    h.flushDialogEvents();
    expect(dialog.open).toBe(false);
    expect(h.document.activeElement).toBe(h.el('reviewStory'));
    h.el('reviewStory').click();
    dialog.dispatchEvent(new EditorEvent('cancel', { cancelable: true }));
    h.flushDialogEvents();
    expect(dialog.open).toBe(false);
    expect(h.document.activeElement).toBe(h.el('reviewStory'));
    await settle();
  });

  it('renders model markup as literal text, including every list and suggested value', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const result = reviewResult(hostile);
    result.title.critique = hostile;
    result.excerpt.critique = hostile;
    result.excerpt.suggestedExcerpt = hostile;
    result.headings.critique = hostile;
    result.practicalDetails.critique = hostile;
    result.practicalDetails.missingAspects = [hostile];
    result.internalLinks.linkOpportunities = [hostile];
    const h = loadEditor({ fetch: reviewNetwork(async () => completion(result)) });
    h.el('reviewStory').click();
    await settle();
    for (const card of h.el('reviewSemantic').querySelectorAll('[data-review-criterion]')) {
      expect(card.textContent).toContain(hostile);
    }
    expect(h.el('reviewSemantic').querySelectorAll('img, script, [onerror]')).toEqual([]);
    required(h.el('reviewSemantic'), '[data-review-action="excerpt"]').click();
    expect(h.el('deExcerpt').value).toBe(hostile);
    expect(h.el('deTitle').value).toBe('');
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  describe.each(['configuration', 'provider'] as const)('late %s results', (stage) => {
    it.each(['close and reopen', 'new run', 'locale change', 'same-post restore', 'field edit', 'body edit'])('cannot overwrite the current review after %s', async (transition) => {
      const configs: PromiseWithResolvers<Response>[] = [];
      const provider = deferredReviews();
      const h = loadEditor({
        review: provider.review,
        fetch: async () => {
          if (stage === 'provider') return response(reviewConfig);
          const config = Promise.withResolvers<Response>();
          configs.push(config);
          return config.promise;
        },
      });
      h.api.populateForm(fullPair());
      h.el('reviewStory').click();
      await settle();
      const oldSignal = h.requests[0]!.options.signal!;
      if (stage === 'provider') expect(provider.calls).toHaveLength(1);
      else expect(provider.calls).toHaveLength(0);

      if (transition === 'close and reopen') h.el('closeReview').click();
      else if (transition === 'new run') h.el('runReview').click();
      else if (transition === 'locale change') h.el('tabbtn-en').click();
      else if (transition === 'same-post restore') {
        const revision = fullPair();
        revision.de.title = 'A revised snapshot of the same post';
        h.api.populateForm(revision);
      } else if (transition === 'field edit') {
        h.el('deTitle').value = 'The author changed this title';
        h.el('deTitle').fire('input');
      } else {
        h.editors[0]!.value('## New author prose\n\nA newer body than the reviewed snapshot.');
      }
      expect(oldSignal.aborted).toBe(true);
      if (transition !== 'new run') h.el('reviewStory').click();
      await settle();
      if (stage === 'configuration') {
        expect(configs).toHaveLength(2);
        configs[1]!.resolve(response(reviewConfig));
        await settle();
      }
      const currentCall = provider.calls.at(-1)!;
      expect(currentCall.story.locale).toBe(transition === 'locale change' ? 'en' : 'de');
      currentCall.result.resolve(reviewResult('Current review suggestion'));
      await settle();
      const currentCards = h.el('reviewSemantic').textContent;
      const currentStatus = h.el('reviewStatus').textContent;
      const expectedProviderCalls = stage === 'provider' ? 2 : 1;
      if (stage === 'configuration') configs[0]!.resolve(response(reviewConfig));
      else provider.calls[0]!.result.resolve(reviewResult('Obsolete review suggestion'));
      await settle();
      // Deliver close events only AFTER a new dialog has rendered its results.
      h.flushDialogEvents();

      expect(provider.calls).toHaveLength(expectedProviderCalls);
      expect(h.el('storyReviewDialog').open).toBe(true);
      expect(h.el('reviewSemantic').textContent).toBe(currentCards);
      expect(h.el('reviewStatus').textContent).toBe(currentStatus);
      expect(h.el('reviewSemantic').textContent).not.toContain('Obsolete review suggestion');
      expect(h.document.activeElement).toBe(h.el('closeReview'));
      required(h.el('reviewSemantic'), '[data-review-action="title"]').click();
      expect(h.el(currentCall.story.locale + 'Title').value).toBe('Current review suggestion');
      h.el('closeReview').click();
      h.flushDialogEvents();
    });
  });

  it('ignores a late rejected review and expired-session response after closing', async () => {
    const config = Promise.withResolvers<Response>();
    const h = loadEditor({ fetch: () => config.promise });
    h.el('reviewStory').click();
    h.el('closeReview').click();
    config.resolve(response({}, 401));
    await settle();
    h.flushDialogEvents();
    expect(h.redirects()).toBe(0);
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.el('reviewStatus').textContent).toBe('');

    const provider = deferredReviews();
    const other = loadEditor({ review: provider.review, fetch: async () => response(reviewConfig) });
    other.el('reviewStory').click();
    await settle();
    other.el('closeReview').click();
    provider.calls[0]!.result.reject(new Error('private-obsolete-failure'));
    await settle();
    other.flushDialogEvents();
    expect(other.el('storyReviewDialog').open).toBe(false);
    expect(other.el('reviewStatus').textContent).toBe('');
    expect(other.el('reviewSemantic').getAttribute('aria-busy')).toBe('false');
  });

  it('makes already-rendered apply actions inert after a same-post restore', async () => {
    const h = loadEditor({ fetch: reviewNetwork(async () => completion(reviewResult())) });
    h.api.populateForm(fullPair());
    h.el('reviewStory').click();
    await settle();
    const oldTitle = required(h.el('reviewSemantic'), '[data-review-action="title"]');
    const oldExcerpt = required(h.el('reviewSemantic'), '[data-review-action="excerpt"]');
    const revision = fullPair();
    revision.de.title = 'Restored revision title';
    revision.de.excerpt = 'Restored revision excerpt';
    h.api.populateForm(revision);
    const dirtyBefore = h.dirtyCalls();
    oldTitle.click();
    oldExcerpt.click();
    h.flushDialogEvents();
    expect(h.el('deTitle').value).toBe(revision.de.title);
    expect(h.el('deExcerpt').value).toBe(revision.de.excerpt);
    expect(h.dirtyCalls()).toBe(dirtyBefore);
    expect(h.el('storyReviewDialog').open).toBe(false);
  });

  it('reviews the locale selected by an existing missing-field shortcut, not the formerly active tab', async () => {
    const provider = deferredReviews();
    const h = loadEditor({ review: provider.review, fetch: async () => response(reviewConfig) });
    const pair = fullPair();
    pair.en.excerpt = '';
    h.api.populateForm(pair);
    const englishGap = h.el('localeChip').querySelectorAll('button').find((button) => button.textContent.startsWith('EN '))!;
    englishGap.click();
    expect(h.el('tab-en').hidden).toBe(false);
    expect(h.document.activeElement).toBe(h.el('enExcerpt'));
    h.el('reviewStory').click();
    await settle();
    expect(provider.calls[0]!.story).toMatchObject({ locale: 'en', title: pair.en.title, excerpt: '' });
    h.el('closeReview').click();
    h.flushDialogEvents();
  });

  it('ignores configuration whose body resolves after the drawer closes', async () => {
    const body = Promise.withResolvers<unknown>();
    const config = response({});
    config.json = () => body.promise;
    const provider = deferredReviews();
    const h = loadEditor({ review: provider.review, fetch: async () => config });
    h.el('reviewStory').click();
    await settle();
    h.el('closeReview').click();
    body.resolve({ ...reviewConfig });
    await settle();
    h.flushDialogEvents();
    expect(provider.calls).toEqual([]);
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.el('reviewSemantic').children).toHaveLength(0);
  });

  it('cannot apply a former post’s in-flight review after loading another post', async () => {
    const provider = deferredReviews();
    const next = fullPair();
    next.translationKey = 'different-post';
    next.de.title = 'A completely different post';
    const h = loadEditor({
      review: provider.review,
      fetch: async (url) => {
        if (url === '/ai-config') return response(reviewConfig);
        if (url === '/posts/different-post') return response(next);
        return response({}, 404);
      },
    });
    h.api.populateForm(fullPair());
    h.el('reviewStory').click();
    await settle();
    await h.api.loadPost('different-post');
    expect(provider.calls[0]!.signal.aborted).toBe(true);
    const nextPayload = h.api.buildPayload();
    expect(nextPayload.translationKey).toBe('different-post');
    provider.calls[0]!.result.resolve(reviewResult('Suggestion for the wrong post'));
    await settle();
    h.flushDialogEvents();
    expect(h.el('storyReviewDialog').open).toBe(false);
    expect(h.el('reviewSemantic').querySelector('[data-review-action]')).toBeNull();
    expect(h.api.buildPayload()).toEqual(nextPayload);
  });
});
