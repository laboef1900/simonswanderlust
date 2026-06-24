import { processImage } from './pipeline.js';
import { storeVariants } from './storage.js';

export interface RehostResult { src: string; width: number; height: number }

export async function rehostImage(
  url: string, key: string, alt: string,
  opts: { storageDir: string; baseUrl: string; fetchImpl?: typeof fetch },
): Promise<RehostResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const result = await processImage(buf);
  const stored = await storeVariants(key, alt, result, { storageDir: opts.storageDir, baseUrl: opts.baseUrl });
  return { src: stored.src, width: stored.width, height: stored.height };
}
