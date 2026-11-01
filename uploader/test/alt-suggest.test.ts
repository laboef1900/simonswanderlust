import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ui } from '../../site/src/i18n/ui.js';

const script = readFileSync('public/alt-suggest.js', 'utf8');

describe('local alt text remains separate from remote review credentials', () => {
  function setup(status = 200) {
    const config = { captionProvider: 'lm-studio', captionBaseUrl: 'http://localhost:1234/v1', captionApiKey: null, lmModel: 'local-vision', captionPrompt: 'describe', captionTimeoutMs: 60000, captionMaxTokens: 8000, captionMaxEdge: 768 };
    const fetch = vi.fn(async () => ({ status, ok: status === 200, json: async () => config }));
    const caption = vi.fn(async () => ({ altDe: 'Ein Berg', altEn: 'A mountain' }));
    const prepImage = vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,fixture' }));
    const ctx = { window: {}, fetch, location: { href: '', protocol: 'http:' }, Event, AbortController, LLM: { caption, prepImage } };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    const listeners: (() => Promise<void>)[] = [];
    const altInput = { value: '', dispatchEvent: vi.fn(), addEventListener: vi.fn() };
    const statusEl = { textContent: '' };
    const on401 = vi.fn();
    const api = ctx.window as { AltSuggest: { wire(options: unknown): void } };
    api.AltSuggest.wire({
      button: { addEventListener: (_name: string, listener: () => Promise<void>) => listeners.push(listener) },
      fileInput: { files: [{}], addEventListener: vi.fn() }, altInput, statusEl, on401, lang: 'de',
    });
    return { config, fetch, caption, prepImage, altInput, on401, statusEl, click: () => listeners[0]!() };
  }

  it('requests only caption config and fills the selected locale with a normal input event', async () => {
    const page = setup();
    await page.click();
    expect(page.altInput.value).toBe('Ein Berg');
    expect(page.altInput.dispatchEvent.mock.calls[0]![0].type).toBe('input');
  });

  it('preserves the caller session-expiry callback without preparing an image or contacting a model', async () => {
    const page = setup(401);
    await page.click();
    expect(page.on401).toHaveBeenCalledOnce();
    expect(page.prepImage).not.toHaveBeenCalled();
    expect(page.caption).not.toHaveBeenCalled();
    expect(page.altInput.value).toBe('');
  });
});

describe('local-file caption request ownership', () => {
  type Caption = { altDe: string; altEn: string };
  type CaptionConfig = { captionProvider: string; captionBaseUrl: string; captionApiKey: string | null;
    lmModel: string; captionPrompt: string; captionTimeoutMs: number; captionMaxTokens: number; captionMaxEdge: number };
  type ConfigResponse = { status: number; ok: boolean; json(): Promise<CaptionConfig> };
  const oldReply = { altDe: 'Eine Tram', altEn: 'A tram' };
  const newReply = { altDe: 'Ein Wal', altEn: 'A whale' };
  const dataUrl = 'data:image/jpeg;base64,fixture';

  function setup(lang: 'de' | 'en' = 'en') {
    const configs: CaptionConfig[] = [];
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => {
      const config: CaptionConfig = { captionProvider: 'openrouter', captionBaseUrl: 'https://provider.example/v1',
        captionApiKey: 'fixture-key-' + configs.length, lmModel: 'vision', captionPrompt: 'describe',
        captionTimeoutMs: 5000, captionMaxTokens: 256, captionMaxEdge: 768 };
      configs.push(config);
      return { status: 200, ok: true, json: async () => config };
    });
    const replies: PromiseWithResolvers<Caption>[] = [];
    const caption = vi.fn((_url: string, _model: string, _prompt: string, _data: string,
      _timeout: number, _tokens: number, _signal: AbortSignal, _key: string) => {
      // Intentionally ignores abort: ownership must also reject already-settled
      // replies and providers that complete despite cancellation.
      const reply = Promise.withResolvers<Caption>();
      replies.push(reply);
      return reply.promise;
    });
    const prepImage = vi.fn(async (_file: File, _edge: number, _signal: AbortSignal) => ({ dataUrl }));
    const ctx = { window: {}, fetch, location: { href: '', protocol: 'http:' }, Event, AbortController,
      LLM: { caption, prepImage, mixedContentWarning: () => '' } };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    const fileInput = Object.assign(new EventTarget(), { files: [new File(['tram'], 'photo.jpg')] });
    const altInput = Object.assign(new EventTarget(), { value: 'author text' });
    const inputEvents = vi.fn();
    altInput.addEventListener('input', inputEvents);
    const statusEl = { textContent: '' };
    const hintEl = { textContent: '' };
    const on401 = vi.fn();
    let click: () => Promise<void> = async () => {};
    const button = { disabled: false,
      addEventListener: (_name: string, listener: () => Promise<void>) => { click = listener; } };
    const api = ctx.window as { AltSuggest: { wire(options: unknown): void } };
    api.AltSuggest.wire({ button, fileInput, altInput, statusEl, hintEl, lang, on401,
      truncatedText: ui[lang]['editor.chrome.altSuggestTruncated'] });
    return { click: () => click(), button, fileInput, altInput, inputEvents, statusEl, hintEl,
      configs, fetch, caption, prepImage, replies, on401,
      signal: (index = 0) => caption.mock.calls[index]![6] };
  }

  it.each(['de', 'en'] as const)('applies an ordinary %s reply once and releases only its request-local key', async (lang) => {
    const page = setup(lang);
    const pending = page.click();
    await vi.waitFor(() => expect(page.caption).toHaveBeenCalledOnce());
    expect(page.fetch.mock.calls[0]![1]).toEqual({ signal: page.signal(), cache: 'no-store' });
    expect(page.prepImage).toHaveBeenCalledWith(page.fileInput.files[0], 768, page.signal());
    expect(page.caption.mock.calls[0]![7]).toBe('fixture-key-0');
    page.replies[0]!.resolve(oldReply);
    await pending;
    expect(page.altInput.value).toBe(lang === 'de' ? oldReply.altDe : oldReply.altEn);
    expect(page.hintEl.textContent).toBe(lang === 'de' ? 'EN: A tram' : 'DE: Eine Tram');
    expect(page.inputEvents).toHaveBeenCalledOnce();
    expect(page.inputEvents.mock.calls[0]![0]).toMatchObject({ type: 'input', bubbles: true });
    expect(page.statusEl.textContent).toBe('Suggested — review and edit as needed.');
    expect(page.configs[0]!.captionApiKey).toBeNull();
    expect(page.signal().aborted).toBe(false);
  });

  it.each(['photo', 'manual alt'] as const)('aborts on a %s change and drops the eventual reply', async (change) => {
    const page = setup();
    const pending = page.click();
    await vi.waitFor(() => expect(page.caption).toHaveBeenCalledOnce());
    if (change === 'photo') {
      // Same filename is not identity.
      page.fileInput.files = [new File(['whale'], 'photo.jpg')];
      page.fileInput.dispatchEvent(new Event('change'));
    } else {
      page.altInput.value = 'My description';
      page.altInput.dispatchEvent(new Event('input'));
      page.inputEvents.mockClear();
    }
    expect(page.signal().aborted).toBe(true);
    expect(page.configs[0]!.captionApiKey).toBeNull();
    page.replies[0]!.resolve(oldReply);
    await pending;
    expect(page.altInput.value).toBe(change === 'photo' ? 'author text' : 'My description');
    expect(page.inputEvents).not.toHaveBeenCalled();
    expect(page.hintEl.textContent).toBe('');
    expect(page.statusEl.textContent).toBe('');
  });

  it.each(['insert-clear', 'next-photo', 'programmatic-alt'] as const)('guards %s even without input/change events', async (change) => {
    const page = setup();
    const pending = page.click();
    await vi.waitFor(() => expect(page.caption).toHaveBeenCalledOnce());
    if (change === 'programmatic-alt') {
      page.altInput.value = 'My description';
    } else {
      page.fileInput.files = change === 'insert-clear' ? [] : [new File(['whale'], 'photo.jpg')];
      page.altInput.value = change === 'insert-clear' ? '' : 'author text';
    }
    const expected = page.altInput.value;
    page.statusEl.textContent = 'Inserted: photo';
    page.replies[0]!.resolve(oldReply);
    await pending;
    expect(page.altInput.value).toBe(expected);
    expect(page.inputEvents).not.toHaveBeenCalled();
    expect(page.statusEl.textContent).toBe('Inserted: photo');
    expect(page.hintEl.textContent).toBe('');
    expect(page.configs[0]!.captionApiKey).toBeNull();
  });

  it('replaces a pending request on another click and accepts only the newest reverse-order completion', async () => {
    const page = setup();
    const first = page.click();
    await vi.waitFor(() => expect(page.caption).toHaveBeenCalledTimes(1));
    expect(page.button.disabled).toBe(false);
    const second = page.click();
    expect(page.signal().aborted).toBe(true);
    await vi.waitFor(() => expect(page.caption).toHaveBeenCalledTimes(2));
    expect(page.signal(1).aborted).toBe(false);
    page.replies[1]!.resolve(newReply);
    await second;
    page.replies[0]!.resolve(oldReply);
    await first;
    expect(page.altInput.value).toBe('A whale');
    expect(page.hintEl.textContent).toBe('DE: Ein Wal');
    expect(page.inputEvents).toHaveBeenCalledOnce();
    expect(page.statusEl.textContent).toBe('Suggested — review and edit as needed.');
    expect(page.configs.map(config => config.captionApiKey)).toEqual([null, null]);
  });

  it.each(['success', 'failure', 'truncation'] as const)('keeps the newer status, key and cancellation owner after stale %s/finally', async (outcome) => {
    const page = setup();
    const first = page.click();
    await vi.waitFor(() => expect(page.caption).toHaveBeenCalledTimes(1));
    const second = page.click();
    await vi.waitFor(() => expect(page.caption).toHaveBeenCalledTimes(2));
    if (outcome === 'success') page.replies[0]!.resolve(oldReply);
    else page.replies[0]!.reject(new Error(outcome === 'truncation' ? 'Caption response was truncated' : 'Provider failed'));
    await first;
    expect(page.statusEl.textContent).toBe('Asking the selected alt-text model…');
    expect(page.configs[1]!.captionApiKey).toBe('fixture-key-1');
    expect(page.inputEvents).not.toHaveBeenCalled();
    page.altInput.value = 'Manual whale';
    page.altInput.dispatchEvent(new Event('input'));
    page.inputEvents.mockClear();
    expect(page.signal(1).aborted).toBe(true);
    expect(page.configs[1]!.captionApiKey).toBeNull();
    page.replies[1]!.resolve(newReply);
    await second;
    expect(page.altInput.value).toBe('Manual whale');
    expect(page.inputEvents).not.toHaveBeenCalled();
    expect(page.statusEl.textContent).toBe('');
  });

  it('cancels during image preparation and never sends the superseded image to a model', async () => {
    const page = setup();
    const preparation = Promise.withResolvers<{ dataUrl: string }>();
    page.prepImage.mockReturnValueOnce(preparation.promise);
    const first = page.click();
    await vi.waitFor(() => expect(page.prepImage).toHaveBeenCalledOnce());
    const signal = page.prepImage.mock.calls[0]![2];
    const second = page.click();
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(page.caption).toHaveBeenCalledOnce());
    preparation.resolve({ dataUrl: 'superseded' });
    await first;
    expect(page.caption).toHaveBeenCalledOnce();
    expect(page.configs[1]!.captionApiKey).toBe('fixture-key-1');
    page.replies[0]!.resolve(newReply);
    await second;
    expect(page.altInput.value).toBe('A whale');
  });

  it.each(['success', 'failure', 'unauthorized'] as const)('ignores stale config %s and keeps the replacement request alive', async (outcome) => {
    const page = setup();
    const configResponse = Promise.withResolvers<ConfigResponse>();
    page.fetch.mockReturnValueOnce(configResponse.promise);
    const first = page.click();
    const signal = page.fetch.mock.calls[0]![1].signal;
    const second = page.click();
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(page.caption).toHaveBeenCalledOnce());
    const staleConfig = { ...page.configs[0]!, captionApiKey: 'old-config-key' };
    if (outcome === 'failure') configResponse.reject(new Error('Config unavailable'));
    else configResponse.resolve({ status: outcome === 'unauthorized' ? 401 : 200,
      ok: outcome !== 'unauthorized', json: async () => staleConfig });
    await first;
    expect(page.on401).not.toHaveBeenCalled();
    expect(page.caption).toHaveBeenCalledOnce();
    expect(page.statusEl.textContent).toBe('Asking the selected alt-text model…');
    expect(page.configs[0]!.captionApiKey).toBe('fixture-key-0');
    if (outcome === 'success') expect(staleConfig.captionApiKey).toBeNull();
    page.replies[0]!.resolve(newReply);
    await second;
    expect(page.altInput.value).toBe('A whale');
    expect(page.inputEvents).toHaveBeenCalledOnce();
  });
});

// #351: the shipped llm.js behind the editor button and the gallery's hosted
// suggestion, with only the network and the canvas stubbed — the model reply
// decides what reaches the field.
describe('alt suggestion with a reasoning model', () => {
  const llmScript = readFileSync('public/llm.js', 'utf8');
  const IMAGE_URL = 'https://images.example/photo-640.webp';
  function load(content: string, finishReason: string) {
    const config = { captionProvider: 'lm-studio', captionBaseUrl: 'http://localhost:1234/v1', captionApiKey: null, lmModel: 'local-vision', captionPrompt: 'describe', captionTimeoutMs: 5000, captionMaxTokens: 256, captionMaxEdge: 768 };
    const fetch = vi.fn(async (url: string) => url === '/ai-config?purpose=caption' ? Response.json(config)
      : url === IMAGE_URL ? new Response('image')
      : Response.json({ choices: [{ finish_reason: finishReason, message: { content } }] }));
    // The scripts assign window.LLM and window.AltSuggest; window is the context.
    const ctx: {
      window?: unknown; LLM?: { prepImage: unknown };
      AltSuggest?: { wire(options: unknown): void; suggestHosted(options: { url: string; lang: string; signal: AbortSignal }): Promise<string> };
      [name: string]: unknown;
    } = { fetch, URL, AbortController, AbortSignal, setTimeout, clearTimeout, Event, location: { href: '', protocol: 'http:' } };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(llmScript, ctx);
    ctx.LLM!.prepImage = async () => ({ dataUrl: 'data:image/jpeg;base64,fixture' });
    vm.runInContext(script, ctx);
    return { altSuggest: ctx.AltSuggest!, fetch };
  }
  async function suggest(content: string, finishReason: string) {
    const { altSuggest, fetch } = load(content, finishReason);
    let click: () => Promise<void> = async () => {};
    const altInput = { value: 'author text', dispatchEvent: vi.fn(), addEventListener: vi.fn() };
    const statusEl = { textContent: '' };
    // editor.html passes the same dictionary entry.
    altSuggest.wire({
      button: { addEventListener: (_name: string, listener: () => Promise<void>) => { click = listener; } },
      fileInput: { files: [{}], addEventListener: vi.fn() }, altInput, statusEl, lang: 'en', truncatedText: ui.en['editor.chrome.altSuggestTruncated'],
    });
    await click();
    return { altInput, status: statusEl.textContent, modelCalls: fetch.mock.calls.length - 1 };
  }
  const draft = '<think>Draft: {"altEn":"draft guess","altDe":"Entwurf"} but wait, the sign actually';
  const complete = '{"altEn":"A complete-looking answer","altDe":"Eine Antwort"}';

  it('fills the final answer, not the draft written while thinking', async () => {
    const page = await suggest(draft + ' reads Quito</think>{"altEn":"A sign reading Quito","altDe":"Ein Schild mit Quito"}', 'stop');
    expect(page.altInput.value).toBe('A sign reading Quito');
    expect(page.altInput.dispatchEvent).toHaveBeenCalledOnce();
  });

  it('leaves the field untouched and shows the token-limit hint for a truncated reply, even a complete-looking one', async () => {
    for (const content of [draft, complete]) {
      const page = await suggest(content, 'length');
      expect(page.modelCalls).toBe(1);
      expect(page.altInput.value).toBe('author text');
      expect(page.altInput.dispatchEvent).not.toHaveBeenCalled();
      expect(page.status).toBe(ui.en['editor.chrome.altSuggestTruncated']);
    }
  });

  it('leaves the field untouched and keeps the general failure for an unclosed thought that finished normally', async () => {
    const page = await suggest(draft, 'stop');
    expect(page.altInput.value).toBe('author text');
    expect(page.altInput.dispatchEvent).not.toHaveBeenCalled();
    expect(page.status).not.toBe(ui.en['editor.chrome.altSuggestTruncated']);
  });

  it('carries the truncated category to the gallery caller instead of a suggestion', async () => {
    for (const content of [draft, complete]) {
      await expect(load(content, 'length').altSuggest.suggestHosted({ url: IMAGE_URL, lang: 'en', signal: new AbortController().signal }))
        .rejects.toThrow(/^Caption response was truncated$/);
    }
    await expect(load(draft, 'stop').altSuggest.suggestHosted({ url: IMAGE_URL, lang: 'en', signal: new AbortController().signal }))
      .rejects.toThrow(/^Caption request failed/);
  });
});

describe('hosted gallery captions', () => {
  function hosted(pendingModel = false, remote = false) {
    const requested: string[] = [];
    let modelSignal: AbortSignal | undefined;
    const config = {
      captionProvider: remote ? 'openrouter' : 'lm-studio',
      captionBaseUrl: remote ? 'https://openrouter.ai/api/v1' : 'http://localhost:1234/v1',
      captionApiKey: remote ? 'fixture-shared-key' : null,
      lmModel: 'vision', captionPrompt: 'Describe', captionMaxEdge: 768, captionTimeoutMs: 5000,
      captionMaxTokens: 8000,
    };
    const ctx: Record<string, unknown> = {
      URL, AbortController, AbortSignal, setTimeout, clearTimeout,
      fetch: async (url: string, options: RequestInit = {}) => {
        requested.push(url);
        if (url === '/ai-config?purpose=caption') return Response.json(config);
        if (url === 'https://images.example/photo-640.webp') {
          expect(options.credentials).toBe('omit');
          expect(options.redirect).toBe('error');
          // A cached pre-CORS copy of an immutable variant must not be reused.
          expect(options.cache).toBe('reload');
          return new Response(new Blob(['display variant']));
        }
        if (url === config.captionBaseUrl + '/chat/completions') {
          expect(new Headers(options.headers).get('authorization')).toBe(remote ? 'Bearer fixture-shared-key' : null);
          expect(options.credentials).toBe('omit');
          expect(options.redirect).toBe('error');
          expect(options.referrerPolicy).toBe('no-referrer');
          expect(JSON.parse(String(options.body)).messages[0].content[1]).toEqual({
            type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' },
          });
          modelSignal = options.signal ?? undefined;
          if (pendingModel) return new Promise<Response>((_resolve, reject) => {
            modelSignal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
          });
          return Response.json({ choices: [{ message: { content: '{"altDe":"Ein Berg","altEn":"A mountain"}' } }] });
        }
        throw new Error('Unexpected destination or full AI configuration request');
      },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync('public/llm.js', 'utf8'), ctx);
    // Both exports were installed by the actual browser script in this VM.
    const llm = ctx.LLM as { prepImage: (blob: Blob) => Promise<{ dataUrl: string }> };
    llm.prepImage = async (blob) => {
      expect(await blob.text()).toBe('display variant');
      return { dataUrl: 'data:image/jpeg;base64,AA==' };
    };
    vm.runInContext(script, ctx);
    const api = ctx.AltSuggest as { suggestHosted(options: { url: string; lang: string; signal: AbortSignal }): Promise<string> };
    return { api, requested, modelSignal: () => modelSignal };
  }

  it.each([['de', 'Ein Berg'], ['en', 'A mountain']] as const)('returns the %s caption without requesting review configuration', async (lang, expected) => {
    const h = hosted();
    expect(await h.api.suggestHosted({ url: 'https://images.example/photo-640.webp', lang, signal: new AbortController().signal }))
      .toBe(expected);
    expect(h.requested).not.toContain('/ai-config');
  });

  it('generates a hosted caption using the selected remote vision provider and shared key', async () => {
    const h = hosted(false, true);
    expect(await h.api.suggestHosted({ url: 'https://images.example/photo-640.webp', lang: 'en', signal: new AbortController().signal }))
      .toBe('A mountain');
    expect(h.requested).toEqual([
      '/ai-config?purpose=caption', 'https://images.example/photo-640.webp',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
  });

  it('aborts an in-flight model request when its photo is no longer current', async () => {
    const h = hosted(true);
    const ctrl = new AbortController();
    const result = h.api.suggestHosted({ url: 'https://images.example/photo-640.webp', lang: 'de', signal: ctrl.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(h.modelSignal()).toBeDefined());
    ctrl.abort();
    await rejected;
    expect(h.modelSignal()?.aborted).toBe(true);
  });
});
