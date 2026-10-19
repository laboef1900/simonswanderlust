import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync('public/alt-suggest.js', 'utf8');

describe('local alt text remains separate from remote review credentials', () => {
  function setup(status = 200) {
    const config = { captionProvider: 'lm-studio', captionBaseUrl: 'http://localhost:1234/v1', captionApiKey: null, lmModel: 'local-vision', captionPrompt: 'describe', captionTimeoutMs: 60000, captionMaxEdge: 768 };
    const fetch = vi.fn(async () => ({ status, ok: status === 200, json: async () => config }));
    const caption = vi.fn(async () => ({ altDe: 'Ein Berg', altEn: 'A mountain' }));
    const prepImage = vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,fixture' }));
    const ctx = { window: {}, fetch, location: { href: '', protocol: 'http:' }, Event, LLM: { caption, prepImage } };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    const listeners: (() => Promise<void>)[] = [];
    const altInput = { value: '', dispatchEvent: vi.fn() };
    const statusEl = { textContent: '' };
    const on401 = vi.fn();
    const api = ctx.window as { AltSuggest: { wire(options: unknown): void } };
    api.AltSuggest.wire({
      button: { addEventListener: (_name: string, listener: () => Promise<void>) => listeners.push(listener) },
      fileInput: { files: [{}] }, altInput, statusEl, on401, lang: 'de',
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

describe('hosted gallery captions', () => {
  function hosted(pendingModel = false, remote = false) {
    const requested: string[] = [];
    let modelSignal: AbortSignal | undefined;
    const config = {
      captionProvider: remote ? 'openrouter' : 'lm-studio',
      captionBaseUrl: remote ? 'https://openrouter.ai/api/v1' : 'http://localhost:1234/v1',
      captionApiKey: remote ? 'fixture-shared-key' : null,
      lmModel: 'vision', captionPrompt: 'Describe', captionMaxEdge: 768, captionTimeoutMs: 5000,
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
