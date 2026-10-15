import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync('public/alt-suggest.js', 'utf8');

describe('local alt text remains separate from remote review credentials', () => {
  function setup(status = 200) {
    const config = { lmBaseUrl: 'http://localhost:1234/v1', lmModel: 'local-vision', captionPrompt: 'describe', captionTimeoutMs: 60000, captionMaxEdge: 768 };
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
    expect(page.fetch).toHaveBeenCalledWith('/ai-config?purpose=caption');
    expect(page.caption).toHaveBeenCalledWith(page.config.lmBaseUrl, page.config.lmModel, page.config.captionPrompt, 'data:image/jpeg;base64,fixture', page.config.captionTimeoutMs);
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
