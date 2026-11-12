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
  function controller(details: () => Details) {
    const dom = editorDocument(markup);
    const el = (id: string): EditorElement => {
      const node = dom.document.getElementById(id);
      if (!node) throw new Error('no #' + id);
      return node;
    };
    const { context, draft } = browser(dom.document, async (url) => new Response(JSON.stringify(url === '/ai-config?purpose=drafting' ? draftConfig : [])));
    const requests: DraftRequest[] = [];
    Reflect.set(context.LLM as object, 'draftArticle', async (request: DraftRequest) => {
      requests.push(request);
      return { title: 'Titel', excerpt: 'Kurz.', bodyMarkdown: 'Text.' };
    });
    const snapshot = { identity: null, formVersion: 1, base: null, generation: 1, locale: 'de', locales: ['de', 'en'], blocked: false,
      title: '', excerpt: '', body: '', slug: '', neverPublished: true, slugAuto: true };
    const read = vi.fn(details);
    const api = draft.create({
      copy: editorCopy, snapshot: () => ({ ...snapshot }), details: read, heroCaption: async () => '', pickPhotos() {},
      commit: () => ({ chooseSlug: false }), didCommit: () => true, notice() {}, on401() {}, isAdmin: () => false,
    });
    api.refresh();
    return { el, api, read, requests, snapshot };
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

  it('lists an over-long detail with its reason and without a checkbox, never truncated', async () => {
    const long = 'P'.repeat(201);
    const h = controller(() => ({ date: null, country: long, region: '', route: { start: 'Lisbon', end: 'Sintra', straightLineKm: 100001 } }));
    h.el('deDraftAction').click();
    await flush();
    const [country, route] = rows(h.el);
    expect(country!.querySelector('input')).toBeNull();
    expect(country!.textContent).toBe('Country: ' + long + ui.en['editor.chrome.draftContextTooLong'].replace('{max}', '200'));
    expect(route!.querySelector('input')).toBeNull();
    expect(route!.textContent).toContain(ui.en['editor.chrome.draftContextTooLong'].replace('{max}', '100000'));
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
});
