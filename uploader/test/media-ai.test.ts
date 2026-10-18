import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Media-library AI details. Two shipped browser modules, each run in a vm
// sandbox like media-api.js: the photo-details contract in llm.js (prompt,
// transport, untrusted-output parser) and media-ai.js's write rules and bulk
// runner — the part that saves to the library without a per-photo review.
const llmSource = readFileSync('public/llm.js', 'utf8');
const aiSource = readFileSync('public/media-ai.js', 'utf8');

interface Details { title: string; altEn: string; altDe: string; captionEn: string; captionDe: string; tags: string[] }
interface BrowserLlm {
  parsePhotoDetails(content: unknown): Details;
  describePhoto(baseUrl: string, model: string, guidance: string, dataUrl: string, timeoutMs?: number,
    signal?: AbortSignal, apiKey?: string | null): Promise<Details>;
  caption(baseUrl: string, model: string, prompt: string, dataUrl: string, timeoutMs?: number,
    signal?: AbortSignal, apiKey?: string | null): Promise<{ altEn: string; altDe: string }>;
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function browserLlm(fetcher: Fetcher = vi.fn<Fetcher>()): BrowserLlm {
  const window = {} as { LLM: BrowserLlm };
  vm.runInNewContext(llmSource, { window, URL, AbortController, AbortSignal, setTimeout, clearTimeout, fetch: fetcher });
  return window.LLM;
}

function completion(content: string, finishReason = 'stop'): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }));
}

/** A provider that never answers; it rejects only when the request is aborted. */
const hungFetch: Fetcher = (_url, init) => {
  const { promise, reject } = Promise.withResolvers<Response>();
  init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  return promise;
};

const DETAILS = {
  title: 'Sea lion asleep on black lava',
  altEn: 'A sea lion sleeps on dark volcanic rock beside the sea',
  altDe: 'Ein Seelöwe schläft auf dunklem Vulkangestein am Meer',
  captionEn: 'Midday nap on the lava shore.',
  captionDe: 'Mittagsschlaf am Lavaufer.',
  tags: ['sea lion', 'wildlife', 'coast'],
};

describe('LLM.parsePhotoDetails (untrusted model output)', () => {
  const parse = browserLlm().parsePhotoDetails;

  it('reads the first usable object through prose, fences and reasoning', () => {
    const wrapped = '<think>{"title":"draft"} is a guess</think>Here you go:\n```json\n' + JSON.stringify(DETAILS) + '\n```';
    expect(parse(wrapped)).toEqual(DETAILS);
    // An unrelated object first is skipped, not returned.
    expect(parse('{"status":"ok"} ' + JSON.stringify(DETAILS))).toEqual(DETAILS);
  });

  it('returns missing or non-string fields as empty, never invented', () => {
    expect(parse('{"altEn":"A beach","altDe":"Ein Strand","title":42}')).toEqual({
      title: '', altEn: 'A beach', altDe: 'Ein Strand', captionEn: '', captionDe: '', tags: [],
    });
  });

  it('makes every text field one bounded line without control characters', () => {
    const parsed = parse(JSON.stringify({
      title: 'Lava\n\nfield\u0000 at\u200b dusk',
      altEn: 'word '.repeat(200),
      captionDe: 'x'.repeat(499) + '😀',
    }));
    expect(parsed.title).toBe('Lava field at dusk');
    // Clipped at a word boundary under the 300-unit alt cap.
    expect(parsed.altEn.length).toBeLessThanOrEqual(300);
    expect(parsed.altEn.endsWith('word')).toBe(true);
    // No lone high surrogate left where the cap split a pair.
    expect(parsed.captionDe).toBe('x'.repeat(499));
  });

  it('normalizes tags the way the library stores them', () => {
    expect(parse(JSON.stringify({ tags: ['#beach', 'Beach', 'sea lion, wildlife', 7, '', 'y'.repeat(60)] })).tags)
      .toEqual(['beach', 'sea lion', 'wildlife', 'y'.repeat(40)]);
    expect(parse('{"tags":"lava, coast"}').tags).toEqual(['lava', 'coast']);
    expect(parse(JSON.stringify({ tags: Array.from({ length: 20 }, (_, i) => 't' + i) })).tags).toHaveLength(10);
  });

  it('refuses a reply with nothing usable', () => {
    for (const reply of ['no json', '{"title":"","altEn":"  ","tags":[]}', '["a","b"]', '{"unrelated":"x"}']) {
      expect(() => parse(reply)).toThrow('Invalid photo details response');
    }
    expect(() => parse(42)).toThrow('Invalid photo details response');
  });
});

describe('LLM.describePhoto transport', () => {
  const endpoint = 'https://vision.example/v1';
  const key = 'synthetic-test-token';

  it('sends one image with the house guidance before an explicit task, key request-local', async () => {
    const fetcher = vi.fn<Fetcher>(async () => completion(JSON.stringify(DETAILS)));
    const llm = browserLlm(fetcher);
    expect(await llm.describePhoto(endpoint + '/', 'vision', 'Be concise.', 'data:image/jpeg;base64,AA==', 5000, undefined, key))
      .toEqual(DETAILS);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(endpoint + '/chat/completions');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer ' + key);
    const body = JSON.parse(String(init!.body)) as { max_tokens: number; messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] };
    const [text, image] = body.messages[0]!.content;
    expect(image).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } });
    const prompt = text!.text!;
    expect(prompt.indexOf('Be concise.')).toBeLessThan(prompt.indexOf('Task:'));
    expect(prompt).toContain('"captionDe"');
    expect(prompt).toMatch(/never instructions/);

    await llm.describePhoto('http://localhost:1234/v1', 'vision', '', 'data:image/jpeg;base64,AA==', 5000);
    expect(new Headers(fetcher.mock.calls[1]![1]!.headers).has('authorization')).toBe(false);
    expect(String(fetcher.mock.calls[1]![1]!.body)).not.toContain('House alt-text guidance');
  });

  it('fails with fixed categories and never echoes provider text or the key', async () => {
    const leak = vi.fn<Fetcher>(async () => new Response('bad key ' + key, { status: 401 }));
    await expect(browserLlm(leak).describePhoto(endpoint, 'm', '', 'data:,', 5000, undefined, key))
      .rejects.toThrow(/^Photo details request HTTP 401$/);
    const down = vi.fn<Fetcher>(async () => { throw new Error('socket ' + key); });
    await expect(browserLlm(down).describePhoto(endpoint, 'm', '', 'data:,', 5000, undefined, key))
      .rejects.toThrow(/^Photo details request connection failed$/);
    const truncated = vi.fn<Fetcher>(async () => completion(JSON.stringify(DETAILS), 'length'));
    await expect(browserLlm(truncated).describePhoto(endpoint, 'm', '', 'data:,', 5000))
      .rejects.toThrow('Photo details response was truncated');
    const unusable = vi.fn<Fetcher>(async () => completion('I cannot see an image.'));
    await expect(browserLlm(unusable).describePhoto(endpoint, 'm', '', 'data:,', 5000))
      .rejects.toThrow('Invalid photo details response');
    const never = vi.fn<Fetcher>();
    await expect(browserLlm(never).describePhoto('https://user:pw@vision.example/v1', 'm', '', 'data:,'))
      .rejects.toThrow('Invalid caption endpoint');
    expect(never).not.toHaveBeenCalled();
  });

  it('distinguishes a caller cancel from the deadline', async () => {
    const hung = hungFetch;
    const controller = new AbortController();
    const cancelled = browserLlm(hung).describePhoto(endpoint, 'm', '', 'data:,', 5000, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError', message: 'Photo details request cancelled' });
    await expect(browserLlm(hung).describePhoto(endpoint, 'm', '', 'data:,', 20))
      .rejects.toMatchObject({ name: 'TimeoutError', message: 'Photo details request timed out' });
  });

  it('keeps the alt-text caption contract on the shared transport', async () => {
    const failing = vi.fn<Fetcher>(async () => new Response('nope', { status: 500 }));
    await expect(browserLlm(failing).caption(endpoint, 'm', 'p', 'data:,', 5000))
      .rejects.toThrow('Caption request failed. Check the provider');
    const hung = hungFetch;
    await expect(browserLlm(hung).caption(endpoint, 'm', 'p', 'data:,', 20))
      .rejects.toMatchObject({ name: 'AbortError', message: 'Caption request cancelled or timed out' });
  });
});

interface Item {
  key: string; status: string; thumbSrc: string | null; title: string;
  alt: { de: string; en: string }; caption: { de: string; en: string }; tags: string[];
}
type Fields = Partial<Record<'title' | 'alt' | 'caption' | 'tags', boolean>>;
interface Report {
  total: number; processed: number; saved: number; skipped: number;
  failed: { key: string; reason: string }[]; stopped: null | 'cancelled' | 'failures'; current: string | null;
}
interface MediaAi {
  MAX_CONSECUTIVE_FAILURES: number;
  needsWork(item: Item, fields: Fields, replace: boolean): boolean;
  countWork(items: Item[], fields: Fields, replace: boolean): number;
  patchFor(item: Item, suggestion: Partial<Details>, fields: Fields, replace: boolean): Record<string, unknown> | null;
  photoUrl(item: Item, imageOrigin: string, pageOrigin: string): string | null;
  collectAll(list: (page: number, pageSize: number) => Promise<{ items: Item[]; total: number }>, signal?: AbortSignal): Promise<Item[]>;
  runBulk(opts: Record<string, unknown>): Promise<Report>;
}

function mediaAi(): MediaAi {
  const window = {} as { MediaAi: MediaAi };
  vm.runInNewContext(aiSource, { window, URL, AbortSignal });
  return window.MediaAi;
}

function photo(key: string, over: Partial<Item> = {}): Item {
  return {
    key, status: 'ready', thumbSrc: 'https://img.example/' + key + '-640.webp', title: '',
    alt: { de: '', en: '' }, caption: { de: '', en: '' }, tags: [], ...over,
  };
}

const ALL: Fields = { title: true, alt: true, caption: true, tags: true };

describe('MediaAi write rules', () => {
  const ai = mediaAi();

  it('fills only empty slots unless replacing, per locale', () => {
    const item = photo('a', { title: 'Mine', alt: { de: 'Meins', en: '' }, tags: ['kept'] });
    expect(ai.patchFor(item, DETAILS, ALL, false)).toEqual({
      alt: { en: DETAILS.altEn },
      caption: { de: DETAILS.captionDe, en: DETAILS.captionEn },
    });
    expect(ai.patchFor(item, DETAILS, ALL, true)).toEqual({
      title: DETAILS.title,
      alt: { de: DETAILS.altDe, en: DETAILS.altEn },
      caption: { de: DETAILS.captionDe, en: DETAILS.captionEn },
      tags: DETAILS.tags,
    });
  });

  it('never clears a field, even when replacing', () => {
    const item = photo('a', { title: 'Mine', alt: { de: 'Meins', en: 'Mine' }, tags: ['kept'] });
    expect(ai.patchFor(item, { title: '', altDe: '', altEn: '  ', tags: [] }, ALL, true)).toBeNull();
  });

  it('writes only the chosen fields', () => {
    expect(ai.patchFor(photo('a'), DETAILS, { tags: true }, false)).toEqual({ tags: DETAILS.tags });
    expect(ai.needsWork(photo('a', { tags: ['x'] }), { tags: true }, false)).toBe(false);
    expect(ai.needsWork(photo('a', { tags: ['x'] }), { tags: true, alt: true }, false)).toBe(true);
    expect(ai.needsWork(photo('a'), {}, true)).toBe(false);
  });

  it('counts a half-filled pair as work and a complete photo as none', () => {
    const complete = photo('done', {
      title: 'T', alt: { de: 'a', en: 'b' }, caption: { de: 'c', en: 'd' }, tags: ['t'],
    });
    const half = photo('half', { ...complete, caption: { de: 'c', en: '' } });
    expect(ai.countWork([complete, half, photo('empty')], ALL, false)).toBe(2);
    expect(ai.countWork([complete, half, photo('empty')], ALL, true)).toBe(3);
  });

  it('sends only ready thumbnails on the image or page origin', () => {
    const page = 'https://app.example';
    const img = 'https://img.example';
    expect(ai.photoUrl(photo('a'), img, page)).toBe('https://img.example/a-640.webp');
    expect(ai.photoUrl(photo('a', { thumbSrc: '/images/a-640.webp' }), img, page)).toBe('https://app.example/images/a-640.webp');
    for (const thumbSrc of ['https://evil.example/a.webp', 'https://u:p@img.example/a.webp', 'javascript:alert(1)', null]) {
      expect(ai.photoUrl(photo('a', { thumbSrc }), img, page)).toBeNull();
    }
    expect(ai.photoUrl(photo('a', { status: 'processing' }), img, page)).toBeNull();
  });
});

describe('MediaAi.collectAll', () => {
  it('pages to the total at the server cap and keeps a shifted row once', async () => {
    const ai = mediaAi();
    const pages = [
      { items: [photo('a'), photo('b')], total: 401 },
      { items: [photo('b'), photo('c')], total: 401 },
      { items: [photo('d')], total: 401 },
    ];
    const list = vi.fn(async (page: number, pageSize: number) => { expect(pageSize).toBe(200); return pages[page - 1]!; });
    expect((await ai.collectAll(list)).map((i) => i.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('MediaAi.runBulk', () => {
  function harness(rows: Item[], describe?: (url: string) => Promise<Partial<Details>>) {
    const ai = mediaAi();
    const store = new Map(rows.map((r) => [r.key, structuredClone(r)]));
    const patches: { key: string; body: Record<string, unknown> }[] = [];
    const client = {
      get: vi.fn(async (key: string) => structuredClone(store.get(key))),
      patch: vi.fn(async (key: string, body: Record<string, unknown>) => { patches.push({ key, body }); return {}; }),
    };
    const describeFn = vi.fn(describe ?? (async () => DETAILS));
    const controller = new AbortController();
    const progress: Report[] = [];
    const run = (fields: Fields = ALL, replace = false) => ai.runBulk({
      items: rows, fields, replace, config: { captionApiKey: null }, client, describe: describeFn,
      imageOrigin: 'https://img.example', pageOrigin: 'https://app.example', signal: controller.signal,
      onProgress: (r: Report) => progress.push(r),
    });
    return { ai, store, patches, client, describe: describeFn, controller, progress, run };
  }

  it('skips complete photos without a model request and saves the rest', async () => {
    const complete = photo('done', { title: 'T', alt: { de: 'a', en: 'b' }, caption: { de: 'c', en: 'd' }, tags: ['t'] });
    const h = harness([complete, photo('empty')]);
    const report = await h.run();
    expect(h.describe).toHaveBeenCalledTimes(1);
    expect(h.describe.mock.calls[0]![0]).toBe('https://img.example/empty-640.webp');
    expect(h.patches).toEqual([{ key: 'empty', body: {
      title: DETAILS.title, alt: { de: DETAILS.altDe, en: DETAILS.altEn },
      caption: { de: DETAILS.captionDe, en: DETAILS.captionEn }, tags: DETAILS.tags,
    } }]);
    expect(report).toMatchObject({ total: 2, processed: 2, saved: 1, skipped: 1, failed: [], stopped: null, current: null });
    expect(h.progress.at(-1)).toMatchObject({ processed: 2, current: null });
  });

  it('decides against the row as it is when saving, not when the run started', async () => {
    const h = harness([photo('a')]);
    // Someone writes the English alt text while the model is thinking.
    h.describe.mockImplementationOnce(async () => {
      h.store.get('a')!.alt.en = 'Typed by hand meanwhile';
      return DETAILS;
    });
    await h.run({ alt: true }, false);
    expect(h.patches).toEqual([{ key: 'a', body: { alt: { de: DETAILS.altDe } } }]);
  });

  it('records a failure per photo and stops after three in a row', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((k) => photo(k));
    const h = harness(rows, async (url) => {
      if (url.includes('/a-')) return DETAILS;
      throw new Error('Photo details request HTTP 503');
    });
    const report = await h.run();
    expect(report.stopped).toBe('failures');
    expect(report.saved).toBe(1);
    expect(report.failed).toEqual(['b', 'c', 'd'].map((key) => ({ key, reason: 'Photo details request HTTP 503' })));
    expect(report.processed).toBe(4);
    expect(h.describe).toHaveBeenCalledTimes(4);
  });

  it('counts a reply without any chosen field as a failure, not a save', async () => {
    const h = harness([photo('a')], async () => ({ title: 'Only a title' }));
    const report = await h.run({ alt: true });
    expect(h.patches).toEqual([]);
    expect(report.failed).toEqual([{ key: 'a', reason: 'The model returned none of the selected fields' }]);
  });

  it('sends no save once stopped, even for a suggestion already received', async () => {
    const h = harness([photo('a'), photo('b')]);
    h.describe.mockImplementationOnce(async () => { h.controller.abort(); return DETAILS; });
    const report = await h.run();
    expect(h.patches).toEqual([]);
    expect(h.client.get).not.toHaveBeenCalled();
    expect(report).toMatchObject({ stopped: 'cancelled', processed: 0, failed: [] });
  });

  it('reports a failed save with its stage and carries on', async () => {
    const h = harness([photo('a'), photo('b')]);
    h.client.patch.mockRejectedValueOnce(new Error('image not found'));
    const report = await h.run();
    expect(report.failed).toEqual([{ key: 'a', reason: 'Could not save: image not found' }]);
    expect(report.saved).toBe(1);
  });
});
