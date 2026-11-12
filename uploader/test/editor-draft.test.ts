import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { editorDocument, type EditorElement } from './editor-dom-harness.js';
import { geometryStats } from '../public/gpx-geometry.js';
import { ui } from '../../site/src/i18n/ui.js';

// The pure helpers of the Draft with AI controller (#579) and its consent
// rule, run against the real editor markup. The full editor flow (snapshot,
// Apply, slug, save shortcut) is exercised in editor-dom.test.ts.
type Stop = { name: string; lat: number; lng: number };
interface Candidate { key: string; value: unknown; checked?: boolean; sendable?: boolean }
interface DraftContext {
  date?: string; country?: string; region?: string; heroCaption?: string; photoCaptions?: string[];
  route?: { start: string; end: string; straightLineKm: number };
}
interface DraftRequest { locale: string; events: string[]; context: DraftContext; apiKey: string | null; signal: AbortSignal }
interface DraftApi {
  parseEvents(text: string): { events: string[]; problem: null | 'empty' | 'tooMany' | { tooLong: number } };
  routeSummary(stops: unknown): { start: string; end: string; straightLineKm: number } | null;
  buildContext(items: Candidate[]): DraftContext;
  create(options: Record<string, unknown>): { refresh(): void; changed(): void };
}
interface Details {
  date: { value: string; label: string } | null; country: string; region: string;
  route: { start: string; end: string; straightLineKm: number } | null;
}

const html = readFileSync('public/editor.html', 'utf8');
const markup = html.slice(0, html.lastIndexOf('<script type="module">'));
const editorCopy = Object.fromEntries(Object.entries(ui.en)
  .filter(([key]) => key.startsWith('editor.chrome.'))
  .map(([key, value]) => [key.slice('editor.chrome.'.length), value]));
const draftConfig = { providerId: 'local', providerName: 'Local text', providerKind: 'lm-studio',
  baseUrl: 'http://localhost:1234/v1', model: 'draft-model', timeoutMs: 120000, prompt: 'Write warmly.', apiKey: null };
async function flush() {
  for (let i = 0; i < 10; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

/** Real llm.js, admin-ui.js, gallery-library.js and editor-draft.js in one browser-like context. */
function browser(document: unknown = editorDocument(markup).document, fetch: (url: string) => Promise<Response> = async () => new Response('[]')) {
  const context: Record<string, unknown> = {
    document, URL, AbortController, AbortSignal, TextDecoder, structuredClone, console, fetch,
    setTimeout: () => 0, clearTimeout: () => {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['admin-ui.js', 'llm.js', 'gallery-library.js', 'editor-draft.js']) {
    vm.runInContext(readFileSync('public/' + file, 'utf8'), context, { filename: file });
  }
  return { context, draft: context.EditorDraft as DraftApi };
}
const { draft: api } = browser();

describe('parseEvents', () => {
  it('takes one trimmed event per line across CR, LF and CRLF and ignores empty lines', () => {
    expect(api.parseEvents('  Arrived in Lisbon \r\n\r\nTram 28\rCastle at dusk\n\t\n')).toEqual({
      events: ['Arrived in Lisbon', 'Tram 28', 'Castle at dusk'], problem: null,
    });
  });

  it('refuses an empty list, more than 50 events and an event over 500 UTF-16 units after trimming, never truncating', () => {
    expect(api.parseEvents(' \n\r\n\t')).toEqual({ events: [], problem: 'empty' });
    const fifty = Array.from({ length: 50 }, (_, index) => 'Event ' + index);
    expect(api.parseEvents(fifty.join('\n')).problem).toBeNull();
    const many = api.parseEvents([...fifty, 'One more'].join('\n'));
    expect([many.events.length, many.problem]).toEqual([51, 'tooMany']);
    expect(api.parseEvents('  ' + 'x'.repeat(500) + '  ').problem).toBeNull();
    // An emoji is two UTF-16 units: 250 fit, 251 do not.
    expect(api.parseEvents('😀'.repeat(250)).problem).toBeNull();
    const long = api.parseEvents('First\n\n\nSecond\n' + '😀'.repeat(251) + '\nFourth');
    expect(long.problem).toEqual({ tooLong: 3 });
    expect(long.events[2]).toHaveLength(502);
  });
});

describe('routeSummary', () => {
  const along = (lngs: number[], lat = 0): Stop[] => lngs.map((lng, index) => ({ name: 'Stop ' + index, lat, lng }));

  it('needs two complete stops and ignores incomplete ones', () => {
    expect(api.routeSummary(undefined)).toBeNull();
    expect(api.routeSummary([])).toBeNull();
    expect(api.routeSummary([{ name: 'Lisbon', lat: 38.72, lng: -9.14 }])).toBeNull();
    expect(api.routeSummary([{ name: 'Lisbon', lat: 38.72, lng: -9.14 }, { name: ' ', lat: 38.8, lng: -9.38 },
      { name: 'Sintra', lat: Number.NaN, lng: -9.38 }])).toBeNull();
  });

  it('rounds the straight-line sum between consecutive stops to whole kilometres', () => {
    // One degree of longitude on the equator is 111.195 km at R = 6371.0088 km.
    expect(api.routeSummary(along([0, 1]))!.straightLineKm).toBe(111);
    expect(api.routeSummary(along([0, 0.00449]))!.straightLineKm).toBe(0);
    expect(api.routeSummary(along([0, 0.0045]))!.straightLineKm).toBe(1);
    // A detour counts every leg, not first-to-last.
    expect(api.routeSummary(along([0, 1, 0]))!.straightLineKm).toBe(222);
  });

  it('matches gpx-geometry.js on the same points and returns only names and kilometres', () => {
    const stops = [
      { name: ' Lisbon ', lat: 38.7223, lng: -9.1393 }, { name: 'Sintra', lat: 38.8029, lng: -9.3817 },
      { name: 'incomplete', lat: Number.NaN, lng: 0 }, { name: 'Cascais', lat: 38.6979, lng: -9.4215 },
    ];
    const complete = stops.filter((stop) => Number.isFinite(stop.lat));
    const metres = geometryStats({ version: 1, segments: [{ points: complete.map(({ lat, lng }) => ({ lat, lng })) }] }).distanceMetres;
    const summary = api.routeSummary(stops)!;
    expect(summary).toEqual({ start: 'Lisbon', end: 'Cascais', straightLineKm: Math.round(metres / 1000) });
    expect(Object.keys(summary)).toEqual(['start', 'end', 'straightLineKm']);
    expect(JSON.stringify(summary)).not.toMatch(/38\.|9\.1|9\.3|9\.4/);
  });
});

describe('buildContext', () => {
  it('sends checked, sendable items only, as plain copies of the allow-listed fields', () => {
    const route = { start: 'Lisbon', end: 'Sintra', straightLineKm: 23, lat: 38.7, extra: 'never' };
    expect(api.buildContext([
      { key: 'date', value: '2024-10-03', checked: true },
      { key: 'country', value: 'Portugal', checked: false },
      { key: 'region', value: 'Europe', checked: true },
      { key: 'heroCaption', value: 'x'.repeat(1001), checked: true, sendable: false },
      { key: 'photoCaption', value: 'Abend am Tejo', checked: true },
      { key: 'photoCaption', value: 'Unticked', checked: false },
      { key: 'photoCaption', value: null, checked: true, sendable: false },
      { key: 'route', value: route, checked: true },
      { key: 'coordinates', value: '38.7, -9.1', checked: true },
      { key: 'country', value: 42, checked: true },
    ])).toEqual({ date: '2024-10-03', region: 'Europe', photoCaptions: ['Abend am Tejo'], route: { start: 'Lisbon', end: 'Sintra', straightLineKm: 23 } });
  });

  it('is empty when nothing is ticked, so a fresh opening sends no details', () => {
    expect(api.buildContext([{ key: 'country', value: 'Portugal' }, { key: 'photoCaption', value: 'Abend am Tejo', checked: false }])).toEqual({});
    expect(api.buildContext([])).toEqual({});
  });
});

describe('Draft with AI controller against the real dialog markup', () => {
  interface PickRequest { preselect: { src: string }[]; onPick(items: unknown[]): void }
  interface ControllerOverrides {
    heroCaption?: () => Promise<string>;
    config?: Record<string, unknown>;
    blocked?: () => boolean;
    /** Replaces LLM.readAiConfig, so a test can hold the very response object the controller reads. */
    readAiConfig?: (path: string, signal: AbortSignal) => Promise<{ status: number; config: unknown }>;
    /** Replaces the provider call; the default answers with a fixed draft. */
    draftArticle?: (request: DraftRequest) => Promise<unknown>;
  }
  function controller(details: () => Details, overrides: ControllerOverrides = {}) {
    const dom = editorDocument(markup);
    const el = (id: string): EditorElement => {
      const node = dom.document.getElementById(id);
      if (!node) throw new Error('no #' + id);
      return node;
    };
    const config = overrides.config ?? draftConfig;
    const { context, draft } = browser(dom.document, async (url) => new Response(JSON.stringify(url === '/ai-config?purpose=drafting' ? config : [])));
    const requests: DraftRequest[] = [];
    Reflect.set(context.LLM as object, 'draftArticle', async (request: DraftRequest) => {
      requests.push(request);
      return overrides.draftArticle ? overrides.draftArticle(request) : { title: 'Titel', excerpt: 'Kurz.', bodyMarkdown: 'Text.' };
    });
    if (overrides.readAiConfig) Reflect.set(context.LLM as object, 'readAiConfig', overrides.readAiConfig);
    const snapshot: Record<string, unknown> = { identity: null, formVersion: 1, base: null, generation: 1, locale: 'de', locales: ['de', 'en'], blocked: false,
      title: '', excerpt: '', body: '', slug: '', neverPublished: true, slugAuto: true };
    const read = vi.fn(details);
    const picks: PickRequest[] = [];
    const on401 = vi.fn();
    const api = draft.create({
      copy: editorCopy, snapshot: () => ({ ...snapshot, blocked: overrides.blocked ? overrides.blocked() : false }), details: read,
      heroCaption: overrides.heroCaption ?? (async () => ''), pickPhotos: (request: PickRequest) => { picks.push(request); },
      commit: () => ({ chooseSlug: false }), didCommit: () => true, notice() {}, on401, isAdmin: () => false,
    });
    api.refresh();
    return { el, api, read, requests, snapshot, picks, on401, document: dom.document };
  }
  const rows = (el: (id: string) => EditorElement) => el('draftContextItems').children;

  it('sends the values derived at opening, not a later reading of the form, and re-derives them unchecked on changed()', async () => {
    let country = 'Portugal';
    const h = controller(() => ({ date: { value: '2024-10-03', label: '3 Oct 2024' }, country, region: '', route: null }));
    h.el('deDraftAction').click();
    await flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(rows(h.el).map((row) => row.textContent)).toEqual(['Date: 3 Oct 2024', 'Country: Portugal']);
    const box = rows(h.el)[1]!.querySelector('input')!;
    box.checked = true;
    box.fire('change');
    country = 'Spain';
    const events = h.el('draftEvents');
    events.value = 'Arrived in Lisbon';
    events.fire('input');
    h.el('draftGenerate').click();
    await flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.requests.map((request) => request.context)).toEqual([{ country: 'Portugal' }]);
    h.api.changed();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(rows(h.el).map((row) => [row.textContent, row.querySelector('input')!.checked]))
      .toEqual([['Date: 3 Oct 2024', false], ['Country: Spain', false]]);
    expect(h.el('draftStatus').textContent).toBe(editorCopy.draftStale);
  });

  it('lists an over-long detail with its reason and without a checkbox, never truncated, and offers no route beyond the cap', async () => {
    const long = 'P'.repeat(201);
    const h = controller(() => ({ date: null, country: long, region: '', route: { start: 'Lisbon', end: 'Sintra', straightLineKm: 100001 } }));
    h.el('deDraftAction').click();
    await flush();
    const [country, ...rest] = rows(h.el);
    expect(country!.querySelector('input')).toBeNull();
    expect(country!.textContent).toBe('Country: ' + long + ui.en['editor.chrome.draftContextTooLong'].replace('{max}', '200'));
    expect(rest).toEqual([]);
  });

  it('keeps keyboard focus on the same detail checkbox when the hero caption arrives and re-renders the list', async () => {
    const hero = Promise.withResolvers<string>();
    const h = controller(() => ({ date: null, country: 'Portugal', region: '',
      route: { start: 'Lisbon', end: 'Sintra', straightLineKm: 22 } }), { heroCaption: () => hero.promise });
    h.el('deDraftAction').click();
    await flush();
    const route = rows(h.el)[1]!.querySelector('input')!;
    route.focus();
    expect(h.document.activeElement).toBe(route);
    hero.resolve('Rooftops at dusk');
    await flush();
    expect(rows(h.el).map((row) => row.textContent)).toEqual([
      'Country: Portugal', 'Hero photo caption: Rooftops at dusk', 'Route: Lisbon → Sintra, about 22 km in a straight line between stops',
    ]);
    const focused = h.document.activeElement as EditorElement | null;
    expect(focused).not.toBeNull();
    expect(focused).toBe(rows(h.el)[2]!.querySelector('input'));
  });

  it('drops a hero caption lookup that resolves after changed() or a reopening, and never lists two hero rows', async () => {
    const lookups: PromiseWithResolvers<string>[] = [];
    const h = controller(() => ({ date: null, country: 'Portugal', region: '', route: null }), {
      heroCaption: () => { const lookup = Promise.withResolvers<string>(); lookups.push(lookup); return lookup.promise; },
    });
    const heroRows = () => rows(h.el).filter((row) => row.textContent.startsWith('Hero photo caption:')).map((row) => row.textContent);
    h.el('deDraftAction').click();
    await flush();
    h.api.changed();
    await flush();
    expect(lookups).toHaveLength(2);
    lookups[0]!.resolve('Old hero');
    await flush();
    expect(heroRows()).toEqual([]);
    lookups[1]!.resolve('New hero');
    await flush();
    expect(heroRows()).toEqual(['Hero photo caption: New hero']);
    h.el('draftClose').click();
    h.el('deDraftAction').click();
    await flush();
    expect(lookups).toHaveLength(3);
    h.el('draftClose').click();
    h.el('deDraftAction').click();
    await flush();
    lookups[2]!.resolve('Closed opening');
    lookups[3]!.resolve('Current opening');
    await flush();
    expect(heroRows()).toEqual(['Hero photo caption: Current opening']);
  });

  it('shows a provider name or model containing a placeholder verbatim in the destination line', async () => {
    const h = controller(() => ({ date: null, country: '', region: '', route: null }),
      { config: { ...draftConfig, providerName: 'Lab {endpoint}', model: 'm-{timeout}' } });
    h.el('deDraftAction').click();
    await flush();
    expect(h.el('draftDestination').textContent)
      .toBe('Provider: Lab {endpoint} (lm-studio) · Endpoint: http://localhost:1234/v1 · Model: m-{timeout} · Timeout: 120 s');
  });

  it('does not announce ready or offer Generate when the editor became unavailable before the settings arrived', async () => {
    let blocked = false;
    const h = controller(() => ({ date: null, country: '', region: '', route: null }), { blocked: () => blocked });
    // The configuration read is still pending when the editor starts saving.
    h.el('deDraftAction').click();
    blocked = true;
    h.api.changed();
    await flush();
    expect(h.el('draftStatus').textContent).toBe(editorCopy.draftUnavailable);
    expect(h.el('draftGenerate').hidden).toBe(true);
  });

  it('Escape on a shown result discards it and the next opening starts unchecked', async () => {
    const h = controller(() => ({ date: null, country: 'Portugal', region: '', route: null }));
    h.el('deDraftAction').click();
    await flush();
    const box = rows(h.el)[0]!.querySelector('input')!;
    box.checked = true;
    box.fire('change');
    h.el('draftEvents').value = 'Arrived in Lisbon';
    h.el('draftGenerate').click();
    await flush();
    expect(h.el('draftResult').hidden).toBe(false);
    h.el('draftResultTitle').fire('keydown', { key: 'Escape' });
    expect(h.el('storyDraftDialog').open).toBe(false);
    expect(h.el('draftResultTitle').value).toBe('');
    h.el('deDraftAction').click();
    await flush();
    expect(h.el('draftResult').hidden).toBe(true);
    expect(h.el('draftEvents').value).toBe('Arrived in Lisbon');
    expect(rows(h.el)[0]!.querySelector('input')!.checked).toBe(false);
  });

  it('clears an earlier provider failure from the status when the next Generate is refused for its input', async () => {
    const h = controller(() => ({ date: null, country: '', region: '', route: null }), {
      draftArticle: async () => { throw new Error('Story draft HTTP 500'); },
    });
    h.el('deDraftAction').click();
    await flush();
    h.el('draftEvents').value = 'Arrived in Lisbon';
    h.el('draftGenerate').click();
    await flush();
    expect(h.el('draftStatus').textContent).toBe(editorCopy.draftProviderFailed);
    h.el('draftEvents').value = '   \n';
    h.el('draftGenerate').click();
    await flush();
    expect(h.el('draftStatus').textContent).toBe('');
    expect(h.el('draftEvents').getAttribute('aria-invalid')).toBe('true');
    expect(h.requests).toHaveLength(1);
  });

  it('returns focus to the title when Close follows the language gaining text, because the trigger row is hidden', async () => {
    const h = controller(() => ({ date: null, country: '', region: '', route: null }));
    h.el('deDraftAction').click();
    await flush();
    h.snapshot.title = 'Typed meanwhile';
    h.api.changed();
    expect(h.el('deDraftStart').hidden).toBe(true);
    h.el('draftClose').click();
    expect(h.document.activeElement).toBe(h.el('deTitle'));
  });

  const keyedConfig = () => ({ ...draftConfig, providerKind: 'custom', baseUrl: 'https://drafts.example/v1', apiKey: 'fixture-drafting-key' });
  const noDetails = (): Details => ({ date: null, country: '', region: '', route: null });

  it('drops the key from every configuration response: at opening, at Generate, and when a response arrives after Close', async () => {
    const responses: Record<string, unknown>[] = [];
    const late = Promise.withResolvers<void>();
    const h = controller(noDetails, {
      readAiConfig: async () => {
        const config = keyedConfig();
        responses.push(config);
        if (responses.length === 3) await late.promise;
        return { status: 200, config };
      },
    });
    h.el('deDraftAction').click();
    await flush();
    expect(responses.map((config) => config.apiKey)).toEqual([null]);
    h.el('draftEvents').value = 'Arrived in Lisbon';
    h.el('draftGenerate').click();
    await flush();
    // The one request carried the key; the response object it came from no longer does.
    expect(h.requests.map((request) => request.apiKey)).toEqual(['fixture-drafting-key']);
    expect(responses.map((config) => config.apiKey)).toEqual([null, null]);
    h.el('draftClose').click();
    h.el('deDraftAction').click();
    h.el('draftClose').click();
    late.resolve();
    await flush();
    expect(responses).toHaveLength(3);
    expect(responses[2]!.apiKey).toBeNull();
    expect(h.requests).toHaveLength(1);
  });

  it('sends nobody to the provider and redirects to login when the Generate-time configuration read answers 401', async () => {
    let reads = 0;
    const h = controller(noDetails, {
      readAiConfig: async () => (++reads === 1 ? { status: 200, config: keyedConfig() } : { status: 401, config: null }),
    });
    h.el('deDraftAction').click();
    await flush();
    h.el('draftEvents').value = 'Arrived in Lisbon';
    h.el('draftGenerate').click();
    await flush();
    expect(reads).toBe(2);
    expect(h.on401).toHaveBeenCalledTimes(1);
    expect(h.requests).toEqual([]);
    expect(h.el('storyDraftDialog').open).toBe(false);
  });

  const mediaRow = (src: string, caption: { de: string; en: string }) => ({
    src, key: src.split('/').pop(), width: 1600, height: 1067, title: 'Tram 28', caption, alt: { de: 'Alt', en: 'Alt' },
    exif: { lat: 38.71153, lng: -9.13008, takenAt: '2024-10-03T10:00:00Z' }, tags: ['lisbon'],
  });

  it('clears the picked photos with the events after Apply and when another story is loaded, but not on a first save', async () => {
    const h = controller(noDetails);
    const pickTram = async () => {
      h.el('draftPickPhotos').click();
      h.picks.at(-1)!.onPick([mediaRow('https://img.example/library/tram', { de: 'Die Tram 28', en: 'Tram 28' })]);
      await flush();
    };
    const reopenAndPick = async () => {
      h.el('draftClose').click();
      h.el('deDraftAction').click();
      await flush();
      h.el('draftPickPhotos').click();
      return h.picks.at(-1)!.preselect.map((photo) => photo.src);
    };
    h.el('deDraftAction').click();
    await flush();
    await pickTram();
    // A first save of this new story (no key → its key) keeps the selection.
    h.snapshot.identity = 'tk1';
    h.api.changed();
    expect(await reopenAndPick()).toEqual(['https://img.example/library/tram']);
    // Another story loaded: the selection goes with the events.
    h.snapshot.identity = 'tk2';
    h.api.changed();
    expect(await reopenAndPick()).toEqual([]);
    await pickTram();
    h.el('draftEvents').value = 'Arrived in Lisbon';
    h.el('draftGenerate').click();
    await flush();
    h.el('draftApply').click();
    expect(h.el('draftEvents').value).toBe('');
    h.el('deDraftAction').click();
    await flush();
    h.el('draftPickPhotos').click();
    expect(h.picks.at(-1)!.preselect).toEqual([]);
  });

  it('keeps the copied caption when the picker returns an unresolved placeholder for a persisted photo', async () => {
    const h = controller(noDetails);
    h.el('deDraftAction').click();
    await flush();
    const src = 'https://img.example/library/tram';
    h.el('draftPickPhotos').click();
    h.picks.at(-1)!.onPick([mediaRow(src, { de: 'Die Tram 28', en: 'Tram 28' })]);
    await flush();
    h.el('draftPickPhotos').click();
    // Unresolved preselected photos come back as bare { src, width, height } placeholders.
    h.picks.at(-1)!.onPick([{ src, width: 1600, height: 1067 }]);
    await flush();
    expect(h.el('draftPhotoItems').children.map((row) => row.textContent)).toEqual(['Caption of Tram 28: Die Tram 28']);
    h.el('draftEvents').value = 'Arrived in Lisbon';
    h.el('draftGenerate').click();
    await flush();
    expect(h.requests.map((request) => request.context)).toEqual([{ photoCaptions: ['Die Tram 28'] }]);
    // Only the caption left the browser: no coordinates, URL, key or tags.
    expect(JSON.stringify(h.requests[0]!.context)).not.toMatch(/38\.7|-9\.1|img\.example|library|lisbon/);
  });
});
