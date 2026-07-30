/**
 * Why a fetch failed, as a stable tag rather than message text.
 *
 * `invalid-url` covers every way the URL itself is unusable (unparseable,
 * non-http scheme, embedded credentials) — nothing branches on those
 * separately. `blocked` is deliberately distinct: it is the SSRF guard
 * refusing, which is a policy decision rather than a malformed input.
 *
 * @ai-context docs/superpowers/specs/2026-07-30-wxr-import-hardening-design.md
 *   §Retry classification — issue #85.
 */
export type FetchErrorKind =
  | 'invalid-url'
  | 'blocked'
  | 'http'
  | 'timeout'
  | 'too-large'
  | 'network';

/**
 * @ai-warning The retry policy for the WordPress importer branches on `kind`,
 * `status` and `code` — NOT on `message`. Keep the tags accurate when adding a
 * throw site, and keep the messages byte-identical when refactoring: a wrong
 * tag silently converts a permanent failure into four attempts with 65 s of
 * backoff, per image. The policy itself lives in wp-import.ts on purpose —
 * this module reports facts, it does not decide what to do about them.
 */
export class FetchError extends Error {
  readonly kind: FetchErrorKind;
  /** HTTP status, for `kind === 'http'`. */
  readonly status?: number;
  /** Transport error code from `err.cause.code` (e.g. `ENOTFOUND`), for `kind === 'network'`. */
  readonly code?: string;

  constructor(message: string, kind: FetchErrorKind, extra?: { status?: number; code?: string }) {
    super(message);
    this.kind = kind;
    if (extra?.status !== undefined) this.status = extra.status;
    if (extra?.code !== undefined) this.code = extra.code;
  }
}

/** `err.cause.code` when the runtime supplied one — undici nests transport codes there. */
function causeCode(e: unknown): string | undefined {
  const cause = (e as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

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
    throw new FetchError(`invalid URL: ${raw}`, 'invalid-url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(`unsupported URL scheme "${url.protocol}" (only http/https)`, 'invalid-url');
  }
  if (url.username || url.password) {
    throw new FetchError('URL must not contain credentials', 'invalid-url');
  }
  if (isBlockedHost(url.hostname)) {
    throw new FetchError(`refusing to fetch internal address: ${url.hostname}`, 'blocked');
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
    if (!res.ok) throw new FetchError(`download failed (HTTP ${res.status}) for ${raw}`, 'http', { status: res.status });

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
          throw new FetchError(`response exceeds the ${maxBytes}-byte limit for ${raw}`, 'too-large');
        }
        chunks.push(value);
      }
    }
    return { buffer: Buffer.concat(chunks), contentType };
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if ((e as Error).name === 'AbortError' || controller.signal.aborted) {
      throw new FetchError(`request timed out after ${timeoutMs}ms for ${raw}`, 'timeout');
    }
    throw new FetchError(`request failed for ${raw}: ${(e as Error).message}`, 'network', { code: causeCode(e) });
  } finally {
    clearTimeout(timer);
  }
}
