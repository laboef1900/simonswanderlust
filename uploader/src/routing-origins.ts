// @ai-context docs/superpowers/specs/2026-11-03-osrm-compose-routing-design.md
// Operator-only exemption from the safeFetch private-address guard for street
// routing. Set in the environment (ROUTING_INTERNAL_ORIGINS), never in Settings:
// an admin session can choose among these origins but can never add one.

/** Exact origins (`scheme://host[:port]`) from a comma-separated list; unset or empty means none. */
export function parseRoutingInternalOrigins(raw: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  if (raw === undefined || raw.trim() === '') return origins;
  raw.split(',').forEach((item, index) => {
    const entry = item.trim();
    const problem = `ROUTING_INTERNAL_ORIGINS entry ${index + 1} must be an http(s) origin such as http://osrm-car:5000 (no path, query, fragment or credentials).`;
    let url: URL;
    try { url = new URL(entry); } catch { throw new Error(problem); }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || /[\p{C}\s]/u.test(entry)) throw new Error(problem);
    origins.add(url.origin);
  });
  return origins;
}

function parsed(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

/** True when `value` is a URL whose exact origin the operator listed. */
export function isInternalRoutingOrigin(value: string, internal: ReadonlySet<string>): boolean {
  const url = parsed(value);
  return url !== null && internal.has(url.origin);
}

/**
 * A configured routing URL may be used: HTTPS anywhere (safeFetch still refuses
 * private addresses), or plain HTTP only to an operator-listed origin.
 */
export function routingEndpointUsable(value: string, internal: ReadonlySet<string>): boolean {
  const url = parsed(value);
  if (url === null) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && internal.has(url.origin));
}
