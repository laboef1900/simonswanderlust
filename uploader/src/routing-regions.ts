// @ai-context docs/superpowers/specs/2026-11-04-osrm-automatic-regions-design.md
// Bundled street routing picks its map regions from the stories themselves:
// every country with a story that has two or more stops is resolved to one
// Geofabrik extract and written to `<dir>/control/wanted`. The compose
// `osrm-fetch` service downloads those extracts; the `osrm` service builds and
// serves one graph per country and mode and reports `<dir>/control/status`.
// Everything read back from the volume is validated: it is the routing
// containers' output, not trusted configuration.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeFetch } from './safe-fetch.js';
import { ROUTED_PROFILES, type RoutedProfile } from '../public/stop-route.js';

export const GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1-nogeom.json';
/** The bundled per-country servers listen here; ROUTING_INTERNAL_ORIGINS must cover it. */
export const BUNDLED_PORT_MIN = 5100;
export const BUNDLED_PORT_MAX = 5999;
const INDEX_MAX_BYTES = 4 * 1024 * 1024;
const INDEX_TIMEOUT_MS = 20_000;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const INDEX_RETRY_MS = 10 * 60 * 1000;

const EXTRACT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EXTRACT_URL_RE = /^https:\/\/download\.geofabrik\.de\/[a-z0-9/_-]+-latest\.osm\.pbf$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const STATUS_STATES = ['downloading', 'building', 'ready', 'failed'] as const;
type StatusState = typeof STATUS_STATES[number];

export interface Extract { id: string; url: string }
export interface RegionStatus { state: StatusState; ports: Partial<Record<RoutedProfile, number>> }
/** What an author sees for one story's country. */
export type RegionState = 'ready' | 'preparing' | 'failed' | 'unsupported';
export interface RegionView { state: RegionState; region: string | null }

/**
 * ISO 3166-1 alpha-2 → Geofabrik extract. A code listed by several different
 * extracts is ambiguous and left out (unsupported), never guessed. A combined
 * extract (one id carrying several codes) serves each of its codes.
 */
export function resolveExtracts(index: unknown): Map<string, Extract> {
  const candidates = new Map<string, Map<string, Extract>>();
  const features = typeof index === 'object' && index !== null && 'features' in index && Array.isArray(index.features) ? index.features : [];
  for (const feature of features as unknown[]) {
    if (typeof feature !== 'object' || feature === null || !('properties' in feature)) continue;
    const p = feature.properties;
    if (typeof p !== 'object' || p === null) continue;
    const props = p as Record<string, unknown>;
    const id = props.id;
    const urls = props.urls;
    const url = typeof urls === 'object' && urls !== null && 'pbf' in urls ? urls.pbf : undefined;
    const codes = props['iso3166-1:alpha2'];
    if (typeof id !== 'string' || !EXTRACT_ID_RE.test(id) || typeof url !== 'string' || !EXTRACT_URL_RE.test(url) || !Array.isArray(codes)) continue;
    for (const code of codes) {
      if (typeof code !== 'string' || !COUNTRY_RE.test(code)) continue;
      let byId = candidates.get(code);
      if (!byId) { byId = new Map(); candidates.set(code, byId); }
      byId.set(id, { id, url });
    }
  }
  const resolved = new Map<string, Extract>();
  for (const [code, byId] of candidates) {
    if (byId.size === 1) resolved.set(code, [...byId.values()][0]!);
  }
  return resolved;
}

/** The `wanted` file body: one `<id> <url>` line per distinct extract, sorted. */
export function wantedBody(countries: readonly string[], extracts: ReadonlyMap<string, Extract>): string {
  const lines = new Set<string>();
  for (const country of countries) {
    const extract = extracts.get(country.toUpperCase());
    if (extract) lines.add(`${extract.id} ${extract.url}`);
  }
  return [...lines].sort().map((line) => `${line}\n`).join('');
}

/**
 * `<id> <state> <car> <bike> <foot>` per line; a port is `-` or an integer in
 * the bundled range. Malformed lines are dropped, never partially trusted.
 */
export function parseStatus(body: string): Map<string, RegionStatus> {
  const statuses = new Map<string, RegionStatus>();
  for (const line of body.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5) continue;
    const [id, state, ...ports] = fields as [string, string, string, string, string];
    if (!EXTRACT_ID_RE.test(id) || !(STATUS_STATES as readonly string[]).includes(state)) continue;
    const parsed: Partial<Record<RoutedProfile, number>> = {};
    let valid = true;
    ROUTED_PROFILES.forEach((profile, index) => {
      const raw = ports[index]!;
      if (raw === '-') return;
      const port = /^\d{4}$/.test(raw) ? Number(raw) : NaN;
      if (!(port >= BUNDLED_PORT_MIN && port <= BUNDLED_PORT_MAX)) valid = false;
      else parsed[profile] = port;
    });
    if (valid) statuses.set(id, { state: state as StatusState, ports: parsed });
  }
  return statuses;
}

export interface BundledRouting {
  /** Endpoints the bundled servers serve right now for a story's country; absent modes are not ready. */
  endpoints(countryCode: string): Partial<Record<RoutedProfile, string>>;
  view(countryCode: string): RegionView;
  /** Recompute `wanted` from the stories and write it when it changed. Never throws. */
  sync(): Promise<void>;
}

export function createBundledRouting({
  dir, host, countries, request = safeFetch, now = Date.now, log = console.error,
}: {
  dir: string;
  host: string;
  countries: () => Promise<string[]>;
  request?: typeof safeFetch;
  now?: () => number;
  log?: (message: string) => void;
}): BundledRouting {
  const controlDir = join(dir, 'control');
  const wantedPath = join(controlDir, 'wanted');
  const statusPath = join(controlDir, 'status');
  let extracts: Map<string, Extract> | null = null;
  let indexAt = -Infinity;
  let indexTriedAt = -Infinity;
  let lastWritten: string | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let warned = '';

  const warnOnce = (message: string) => { if (warned !== message) { warned = message; log(message); } };

  async function loadIndex(): Promise<void> {
    const at = now();
    if (extracts && at - indexAt < INDEX_TTL_MS) return;
    if (at - indexTriedAt < INDEX_RETRY_MS) return;
    indexTriedAt = at;
    try {
      const { buffer } = await request(GEOFABRIK_INDEX_URL, { timeoutMs: INDEX_TIMEOUT_MS, maxBytes: INDEX_MAX_BYTES, maxRedirects: 0 });
      const resolved = resolveExtracts(JSON.parse(buffer.toString('utf8')));
      if (resolved.size === 0) throw new Error('no usable extract');
      extracts = resolved;
      indexAt = at;
    } catch {
      // Keep the previous index; an unreachable Geofabrik must not drop regions.
      warnOnce('routing regions: the Geofabrik index could not be loaded; retrying later.');
    }
  }

  async function syncOnce(): Promise<void> {
    await loadIndex();
    if (!extracts) return;
    let wanted: string;
    try {
      wanted = wantedBody(await countries(), extracts);
    } catch {
      warnOnce('routing regions: the story countries could not be read; retrying later.');
      return;
    }
    if (wanted === lastWritten) return;
    try {
      mkdirSync(controlDir, { recursive: true });
      const tmp = `${wantedPath}.${process.pid}.tmp`;
      writeFileSync(tmp, wanted);
      renameSync(tmp, wantedPath);
      lastWritten = wanted;
    } catch {
      warnOnce(`routing regions: cannot write ${wantedPath} yet (osrm-fetch prepares the volume); retrying later.`);
    }
  }

  function statuses(): Map<string, RegionStatus> {
    try { return parseStatus(readFileSync(statusPath, 'utf8')); }
    catch { return new Map(); }
  }

  return {
    endpoints(countryCode) {
      const extract = extracts?.get(countryCode.toUpperCase());
      const status = extract ? statuses().get(extract.id) : undefined;
      const result: Partial<Record<RoutedProfile, string>> = {};
      for (const profile of ROUTED_PROFILES) {
        const port = status?.ports[profile];
        if (port !== undefined) result[profile] = `http://${host}:${port}`;
      }
      return result;
    },
    view(countryCode) {
      if (!extracts) return { state: 'preparing', region: null };
      const extract = extracts.get(countryCode.toUpperCase());
      if (!extract) return { state: 'unsupported', region: null };
      const status = statuses().get(extract.id);
      const state: RegionState = status?.state === 'ready' ? 'ready' : status?.state === 'failed' ? 'failed' : 'preparing';
      return { state, region: extract.id };
    },
    async sync() {
      if (running) { again = true; return running; }
      running = (async () => {
        try {
          do { again = false; await syncOnce(); } while (again);
        } finally { running = null; }
      })();
      return running;
    },
  };
}
