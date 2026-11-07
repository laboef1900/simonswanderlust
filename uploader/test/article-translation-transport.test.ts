import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

interface TranslationRequest {
  baseUrl: string; model: string; apiKey?: string; timeoutMs: number;
  sourceLocale: string; targetLocale: string; slots: { id: string; text: string }[]; signal?: AbortSignal;
}
interface TranslationOutput { translations: { id: string; text: string }[] }
const source = readFileSync(new URL('../public/llm.js', import.meta.url), 'utf8');
function client(fetcher: typeof fetch) {
  const window: { LLM?: { translateArticle(input: TranslationRequest): Promise<TranslationOutput> } } = {};
  new Function('window', 'fetch', source)(window, fetcher);
  return window.LLM!;
}
const request: TranslationRequest = {
  baseUrl: 'https://translate.example/v1', model: 'translator', apiKey: 'fixture-key', timeoutMs: 2000,
  sourceLocale: 'de', targetLocale: 'en', slots: [{ id: 's0', text: 'Eine Reise' }, { id: 's1', text: 'Am Berg' }],
};
const translated = { translations: [{ id: 's0', text: 'A journey' }, { id: 's1', text: 'On the mountain' }] };
function reply(value: unknown = translated, finish: unknown = 'stop') {
  return Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }] });
}

describe('browser-direct article translation', () => {
  it('sends only text slots in either direction and binds each request key to its selected endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const llm = client(fetcher);
    expect(await llm.translateArticle(request)).toEqual(translated);
    await llm.translateArticle({ ...request, baseUrl: 'http://localhost:1234/v1', apiKey: undefined, sourceLocale: 'en', targetLocale: 'de' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://translate.example/v1/chat/completions', 'http://localhost:1234/v1/chat/completions',
    ]);
    expect(fetcher.mock.calls.map(([, options]) => new Headers(options?.headers).get('authorization'))).toEqual(['Bearer fixture-key', null]);
    for (const [index, [, options]] of fetcher.mock.calls.entries()) {
      expect(options).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
      const body = JSON.parse(String(options?.body));
      expect(body.max_tokens).toBe(32768);
      expect(JSON.parse(body.messages[1].content)).toEqual({
        sourceLocale: index === 0 ? 'de' : 'en', targetLocale: index === 0 ? 'en' : 'de', slots: request.slots,
      });
      expect(JSON.stringify(body)).not.toContain('fixture-key');
    }
  });

  it('never retries even the legacy unsupported response_format error', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: {
      param: 'response_format', code: 'unsupported_parameter', message: 'fixture-key private article',
    } }, { status: 400 }));
    await expect(client(fetcher).translateArticle(request)).rejects.toThrow('Article translation HTTP 400');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['length', 'content_filter', 'tool_calls', null, undefined])('rejects completion reason %s despite valid-looking JSON', async (reason) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: reason, message: { content: JSON.stringify(translated) } }] }));
    await expect(client(fetcher).translateArticle(request)).rejects.toThrow(/Article translation response was (truncated|incomplete)/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { translations: [] },
    { translations: [{ id: 's0', text: 'A' }, { id: 's0', text: 'B' }] },
    { translations: [{ id: 's0', text: 'A' }, { id: 'extra', text: 'B' }] },
    { translations: [{ id: 's0', text: '' }, { id: 's1', text: 'B' }] },
    { translations: [{ id: 's0', text: ' \n\t' }, { id: 's1', text: 'B' }] },
    { translations: [{ id: 's0', text: 'A\u0000B' }, { id: 's1', text: 'B' }] },
    { translations: [{ id: 's0', text: 'x'.repeat(12001) }, { id: 's1', text: 'B' }] },
    { ...translated, bodyMarkdown: 'model must not write source' },
  ])('rejects incomplete or expanded slot schemas without repairing output', async (output) => {
    await expect(client(async () => reply(output)).translateArticle(request)).rejects.toThrow('Invalid article translation response');
  });

  it('rejects malformed JSON and does not salvage JSON from commentary or thinking', async () => {
    for (const content of ['{', '<think>private draft</think>' + JSON.stringify(translated), '```json\n' + JSON.stringify(translated) + '\n```']) {
      await expect(client(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })).translateArticle(request))
        .rejects.toThrow('Invalid article translation response');
    }
  });

  it('bounds streamed envelope bytes before accumulating an oversized response', async () => {
    const cancelled = vi.fn();
    let pulls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel: cancelled,
    })));
    await expect(client(fetcher).translateArticle(request)).rejects.toThrow('Article translation response exceeded limit');
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(pulls).toBeLessThanOrEqual(4);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled body read without waiting for provider completion', async () => {
    const controller = new AbortController();
    const reading = Promise.withResolvers<void>();
    const cancelled = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start() { reading.resolve(); }, cancel: cancelled,
    })));
    const pending = client(fetcher).translateArticle({ ...request, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Article translation cancelled' });
    await reading.promise;
    controller.abort();
    await rejection;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('times out a stalled body, with no retry', async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel: cancelled })));
      const pending = client(fetcher).translateArticle({ ...request, timeoutMs: 50 });
      const rejection = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('rejects invalid input and unsafe endpoints before inference, and sanitizes network failures', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('fixture-key provider body'); });
    const llm = client(fetcher);
    await expect(llm.translateArticle({ ...request, baseUrl: 'https://key@example.com/v1' })).rejects.toThrow('Invalid translation endpoint');
    await expect(llm.translateArticle({ ...request, slots: [{ id: 's0', text: 'x'.repeat(100001) }] })).rejects.toThrow('Invalid article translation request');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(llm.translateArticle(request)).rejects.toThrow('Article translation connection failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
