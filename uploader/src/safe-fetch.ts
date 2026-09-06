import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

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

/** `err.code` as `dns.lookup` sets it (`ENOTFOUND`, `EAI_AGAIN`, …) — nothing nested. */
function ownCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null || !('code' in e)) return undefined;
  return typeof e.code === 'string' ? e.code : undefined;
}

/** `err.cause.code` when the runtime supplied one — undici nests transport codes there. */
function causeCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null || !('cause' in e)) return undefined;
  return ownCode(e.cause);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolve a hostname to every address it has — the `dns.lookup(host, { all: true })` shape. */
export type LookupFn = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Redirect hops followed before giving up. Every hop is re-validated. */
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
}

export interface SafeFetchResult {
  buffer: Buffer;
  contentType: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Address ranges a server-side fetch must never reach: loopback, RFC1918 (the
 * compose network `db` lives on is 172.16/12), CGNAT, link-local (which holds
 * the cloud-metadata endpoint 169.254.169.254), multicast and reserved space,
 * and their IPv6 counterparts. `BlockList` checks IPv4-mapped IPv6 addresses
 * (`::ffff:127.0.0.1`) against the IPv4 rules itself; the NAT64 well-known
 * prefix is blocked wholesale because the embedded IPv4 is not unpacked.
 *
 * @ai-warning This is the single source of truth for "internal address" —
 * both the literal-host check in `assertFetchableUrl` and the post-resolution
 * check in `safeFetch` consult it. Extend the list here, nowhere else.
 */
const BLOCKED = new BlockList();
BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');       // "this" network
BLOCKED.addSubnet('10.0.0.0', 8, 'ipv4');      // RFC1918
BLOCKED.addSubnet('100.64.0.0', 10, 'ipv4');   // CGNAT (RFC6598)
BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4');     // loopback
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');  // link-local / cloud metadata
BLOCKED.addSubnet('172.16.0.0', 12, 'ipv4');   // RFC1918 (docker compose networks)
BLOCKED.addSubnet('192.0.0.0', 24, 'ipv4');    // IETF protocol assignments
BLOCKED.addSubnet('192.168.0.0', 16, 'ipv4');  // RFC1918
BLOCKED.addSubnet('198.18.0.0', 15, 'ipv4');   // benchmarking
BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4');     // multicast
BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4');     // reserved, incl. broadcast
BLOCKED.addAddress('::', 'ipv6');              // unspecified
BLOCKED.addAddress('::1', 'ipv6');             // loopback
BLOCKED.addSubnet('fe80::', 10, 'ipv6');       // link-local
BLOCKED.addSubnet('fc00::', 7, 'ipv6');        // unique-local
BLOCKED.addSubnet('ff00::', 8, 'ipv6');        // multicast
BLOCKED.addSubnet('64:ff9b::', 96, 'ipv6');    // NAT64 well-known prefix
BLOCKED.addSubnet('64:ff9b:1::', 48, 'ipv6');  // NAT64 local-use (RFC8215)

/** True for anything that is not a routable public IP literal — fails closed on garbage. */
function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return BLOCKED.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** `URL.hostname` keeps IPv6 literals in brackets; the net helpers want them bare. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/**
 * Validate a URL is safe to fetch from a server-side request. Throws FetchError.
 *
 * Synchronous, so it can only judge what the string says: scheme, credentials,
 * and a literal IP host (the WHATWG parser already canonicalises `2130706433`
 * and `0x7f.1` to `127.0.0.1`). A hostname is judged after resolution, inside
 * `safeFetch` — see `assertResolvesPublic`.
 */
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
  const host = bareHost(url);
  if (isIP(host) && isBlockedAddress(host)) {
    throw new FetchError(`refusing to fetch internal address: ${url.hostname}`, 'blocked');
  }
  return url;
}

/** Settle with `p`, or reject with the signal's reason the moment it aborts. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Resolve the host and refuse if ANY of its addresses is internal — an
 * attacker who publishes one public and one private record does not get to
 * pick which one the connect uses. A literal IP was already judged by
 * `assertFetchableUrl`, and `lookup` would only echo it back.
 *
 * @ai-note This narrows, but does not close, DNS rebinding: undici resolves
 * the name again when it connects, so a zero-TTL flip between this check and
 * that connect still lands. Closing it needs the resolved address pinned into
 * the connection, which the platform `fetch` does not expose without adding
 * `undici` as a dependency. Recorded in SECURITY.md as an accepted residual.
 */
async function assertResolvesPublic(url: URL, lookup: LookupFn, signal: AbortSignal): Promise<void> {
  const host = bareHost(url);
  if (isIP(host)) return;
  let addresses: ReadonlyArray<{ address: string; family: number }>;
  try {
    addresses = await abortable(lookup(host), signal);
  } catch (e) {
    if (signal.aborted) throw e;
    throw new FetchError(`request failed for ${url.href}: ${messageOf(e)}`, 'network', { code: ownCode(e) });
  }
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new FetchError(`refusing to fetch internal address: ${url.hostname} resolves to an internal address`, 'blocked');
  }
}

/** The next hop of a redirect, resolved against the current URL and judged like the first. */
function redirectTarget(location: string, from: URL, raw: string, hop: number): URL {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new FetchError(`invalid redirect target "${location}" (redirect hop ${hop} for ${raw})`, 'invalid-url');
  }
  try {
    return assertFetchableUrl(next.href);
  } catch (e) {
    if (e instanceof FetchError) throw new FetchError(`${e.message} (redirect hop ${hop} for ${raw})`, e.kind);
    throw e;
  }
}

/**
 * Fetch a remote resource with an SSRF guard, a hard timeout, and a streamed
 * byte cap (so a malicious/huge response can never be buffered fully into
 * memory). Used by the WordPress re-host path, where the URL is attacker-influenced.
 *
 * Redirects are followed by hand (`redirect: 'manual'`, issue #93): every hop
 * is re-validated — scheme, credentials, literal host, and the addresses the
 * hostname resolves to — under one timeout that spans the whole chain, with a
 * hop cap. Only the final body is read, so the byte cap applies where the
 * bytes are. WordPress media URLs legitimately redirect (CDN, HTTPS upgrade,
 * resized-variant handlers), which is why the hops are followed at all.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const doFetch = opts.fetchImpl ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = assertFetchableUrl(raw);
    let res: Response;
    for (let hop = 0; ; hop++) {
      await assertResolvesPublic(url, lookup, controller.signal);
      res = await doFetch(url, { signal: controller.signal, redirect: 'manual' });
      const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
      if (location === null) break;
      await res.body?.cancel();
      if (hop === maxRedirects) {
        throw new FetchError(`too many redirects (more than ${maxRedirects}) for ${raw}`, 'http', { status: res.status });
      }
      url = redirectTarget(location, url, raw, hop + 1);
    }
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
    if ((e instanceof Error && e.name === 'AbortError') || controller.signal.aborted) {
      throw new FetchError(`request timed out after ${timeoutMs}ms for ${raw}`, 'timeout');
    }
    throw new FetchError(`request failed for ${raw}: ${messageOf(e)}`, 'network', { code: causeCode(e) });
  } finally {
    clearTimeout(timer);
  }
}
