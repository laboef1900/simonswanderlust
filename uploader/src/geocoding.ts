import { safeFetch } from './safe-fetch.js';
import { readFileSync } from 'node:fs';
import { normalizeCanonicalOrigin } from '../../site/src/lib/site-identity.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export interface LocationResult { label: string; lat: number; lng: number }
export class GeocodingError extends Error {
  constructor(readonly code: 'invalid_query' | 'lookup_busy' | 'lookup_disabled' | 'lookup_failed', readonly status: number) {
    super(code);
  }
}

/** One instance per app: the provider's limit is shared by all users and tabs. */
export function createGeocoder({
  endpoint,
  canonicalOrigin = () => null,
  now = Date.now,
  request = safeFetch,
}: {
  endpoint: () => string;
  canonicalOrigin?: () => string | null;
  now?: () => number;
  request?: typeof safeFetch;
}) {
  let nextStart = now() + 1100;
  let busy = false;
  const cache = new Map<string, { expires: number; results: LocationResult[] }>();
  return async (input: unknown): Promise<LocationResult[]> => {
    if (typeof input !== 'string' || /[\p{C}]/u.test(input)) throw new GeocodingError('invalid_query', 400);
    const query = input.trim();
    if (query.length < 2 || query.length > 200) throw new GeocodingError('invalid_query', 400);
    const base = endpoint();
    if (!base) throw new GeocodingError('lookup_disabled', 503);
    const key = JSON.stringify([base, query.toLocaleLowerCase('en')]);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.results;
    cache.delete(key);
    if (busy || now() < nextStart) throw new GeocodingError('lookup_busy', 429);
    busy = true;
    nextStart = now() + 1100;
    try {
      const url = new URL(base);
      url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', 'accept-language': 'en' }).toString();
      const origin = normalizeCanonicalOrigin(canonicalOrigin());
      const response = await request(url.href, {
        timeoutMs: 10_000,
        maxBytes: 256 * 1024,
        maxRedirects: 0,
        fetchImpl: (target, init) => fetch(target, {
          ...init,
          headers: { ...init?.headers, 'User-Agent': `SimonsWanderlust/${version} (${origin ? `+${origin}; ` : ''}editor location lookup)` },
        }),
      });
      const data: unknown = JSON.parse(response.buffer.toString('utf8'));
      if (!Array.isArray(data)) throw new Error('Invalid result');
      const results: LocationResult[] = [];
      for (const item of data.slice(0, 5)) {
        if (!item || typeof item !== 'object') throw new Error('Invalid result');
        const { display_name: label, lat: rawLat, lon: rawLng } = item as Record<string, unknown>;
        const coordinate = (value: unknown): number => typeof value === 'number' ? value
          : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
        const lat = coordinate(rawLat), lng = coordinate(rawLng);
        if (typeof label !== 'string' || !label.trim() || label.length > 1000
          || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
          throw new Error('Invalid result');
        }
        results.push({ label, lat, lng });
      }
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, { expires: now() + 24 * 60 * 60 * 1000, results });
      return results;
    } catch {
      throw new GeocodingError('lookup_failed', 502);
    } finally {
      busy = false;
    }
  };
}
