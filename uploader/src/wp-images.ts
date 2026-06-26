import { processImage } from './pipeline.js';
import { storeVariants } from './storage.js';
import { safeFetch } from './safe-fetch.js';

export interface RehostResult { src: string; width: number; height: number }

export async function rehostImage(
  url: string, key: string, alt: string,
  opts: { storageDir: string; baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number },
): Promise<RehostResult> {
  // @ai-warning: `url` is taken from an uploaded WordPress export, so it is
  // attacker-influenced. safeFetch applies the SSRF guard + timeout + byte cap.
  const { buffer } = await safeFetch(url, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
  const result = await processImage(buffer);
  const stored = await storeVariants(key, alt, result, { storageDir: opts.storageDir, baseUrl: opts.baseUrl });
  return { src: stored.src, width: stored.width, height: stored.height };
}
