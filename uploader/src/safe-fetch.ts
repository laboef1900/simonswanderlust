export class FetchError extends Error {}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  buffer: Buffer;
  contentType: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Block obvious internal targets given as literal IPs — loopback and
 * link-local (169.254/16, which includes the cloud metadata endpoint
 * 169.254.169.254). This is a cheap, synchronous guard that does NOT resolve
 * DNS, so a hostname that resolves to a private address is not caught here;
 * full SSRF protection (DNS-rebind-proof) is out of scope for the trusted,
 * single-tenant deployment. @ai-warning: keep this in sync with any future
 * private-range blocking.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase(); // unwrap IPv6 brackets
  if (host === '::1') return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true; // link-local / unique-local IPv6
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127) return true;            // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  return false;
}

/** Validate a URL is safe to fetch from a server-side request. Throws FetchError. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(`unsupported URL scheme "${url.protocol}" (only http/https)`);
  }
  if (url.username || url.password) {
    throw new FetchError('URL must not contain credentials');
  }
  if (isBlockedHost(url.hostname)) {
    throw new FetchError(`refusing to fetch internal address: ${url.hostname}`);
  }
  return url;
}

/**
 * Fetch a remote resource with an SSRF guard, a hard timeout, and a streamed
 * byte cap (so a malicious/huge response can never be buffered fully into
 * memory). Used by the WordPress re-host path, where the URL is attacker-influenced.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const doFetch = opts.fetchImpl ?? fetch;
  const url = assertFetchableUrl(raw);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new FetchError(`download failed (HTTP ${res.status}) for ${raw}`);

    const contentType = res.headers.get('content-type') ?? '';
    const reader = res.body?.getReader();
    if (!reader) return { buffer: Buffer.alloc(0), contentType };

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new FetchError(`response exceeds the ${maxBytes}-byte limit for ${raw}`);
        }
        chunks.push(value);
      }
    }
    return { buffer: Buffer.concat(chunks), contentType };
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if ((e as Error).name === 'AbortError' || controller.signal.aborted) {
      throw new FetchError(`request timed out after ${timeoutMs}ms for ${raw}`);
    }
    throw new FetchError(`request failed for ${raw}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
