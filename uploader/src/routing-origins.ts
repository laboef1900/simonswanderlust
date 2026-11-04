// @ai-context docs/superpowers/specs/2026-11-04-osrm-automatic-regions-design.md
// Operator-only exemption from the safeFetch private-address guard for street
// routing. Set in the environment (ROUTING_INTERNAL_ORIGINS), never in Settings:
// an admin session can choose among these origins but can never add one.

/** Anything answering "is this exact origin (`URL.origin`) listed?"; a `Set<string>` qualifies. */
export interface OriginAllowList {
  has(origin: string): boolean;
}

export interface RoutingInternalOrigins extends OriginAllowList {
  /** The normalized entries, for the boot log. */
  readonly entries: readonly string[];
}

interface PortRange { protocol: string; hostname: string; low: number; high: number }

/** `scheme://host:LOW-HIGH`: one host, an inclusive port range (the bundled per-country servers). */
const RANGE_RE = /^(https?):\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*):(\d{1,5})-(\d{1,5})$/;

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * Comma-separated entries; unset or empty means none. Each entry is an exact
 * origin (`http://osrm-car:5000`) or one host with a port range
 * (`http://osrm:5100-5999`). Never a path, query, fragment, credentials or wildcard host.
 */
export function parseRoutingInternalOrigins(raw: string | undefined): RoutingInternalOrigins {
  const exact = new Set<string>();
  const ranges: PortRange[] = [];
  if (raw !== undefined && raw.trim() !== '') {
    raw.split(',').forEach((item, index) => {
      const entry = item.trim();
      const problem = `ROUTING_INTERNAL_ORIGINS entry ${index + 1} must be an http(s) origin such as http://osrm-car:5000 or a host with a port range such as http://osrm:5100-5999 (no path, query, fragment or credentials).`;
      const range = RANGE_RE.exec(entry.toLowerCase());
      if (range) {
        const low = Number(range[3]), high = Number(range[4]);
        if (low < 1 || high > 65535 || low > high) throw new Error(problem);
        ranges.push({ protocol: `${range[1]}:`, hostname: range[2]!, low, high });
        return;
      }
      let url: URL;
      try { url = new URL(entry); } catch { throw new Error(problem); }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash || /[\p{C}\s]/u.test(entry)) throw new Error(problem);
      exact.add(url.origin);
    });
  }
  return {
    entries: [...exact, ...ranges.map((r) => `${r.protocol}//${r.hostname}:${r.low}-${r.high}`)],
    has(origin: string): boolean {
      if (exact.has(origin)) return true;
      const url = parsed(origin);
      if (url === null || url.origin !== origin) return false;
      const port = url.port === '' ? defaultPort(url.protocol) : Number(url.port);
      return ranges.some((r) => r.protocol === url.protocol && r.hostname === url.hostname && port >= r.low && port <= r.high);
    },
  };
}

function parsed(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

/** True when `value` is a URL whose origin the operator listed. */
export function isInternalRoutingOrigin(value: string, internal: OriginAllowList): boolean {
  const url = parsed(value);
  return url !== null && internal.has(url.origin);
}

/**
 * A configured routing URL may be used: HTTPS anywhere (safeFetch still refuses
 * private addresses), or plain HTTP only to an operator-listed origin.
 */
export function routingEndpointUsable(value: string, internal: OriginAllowList): boolean {
  const url = parsed(value);
  if (url === null) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && internal.has(url.origin));
}
