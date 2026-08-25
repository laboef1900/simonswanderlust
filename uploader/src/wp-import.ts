import { parseWxr, type ParsedPost } from './wxr-parse.js';
import { htmlToMarkdown } from './wp-content.js';
import { rehostImage, type RehostResult, type RehostResume } from './wp-images.js';
import { isSafeSlug, type ImageDims, type PostLocale, type PostPair, type PostStore } from './posts.js';
import { rewriteFences } from './body-content.js';
import { FetchError } from './safe-fetch.js';

/** Per-image accounting, so a partial import cannot masquerade as a clean one. */
export interface ImportImageCounts {
  /** Distinct (pair, url) re-host operations a clean run would perform. */
  total: number;
  /** Re-hosted now, or already present on disk from an earlier run. */
  hosted: number;
  /** Left pointing at the original WordPress URL. */
  failed: number;
}

export interface ImportSummary {
  imported: number;
  updated: number;
  /** Already published before this run; deliberately not overwritten. A success, not a problem. */
  skippedPublished: number;
  /** Rejected at the import boundary: a missing translation, or a slug the importer refuses (path-traversal defence). Nothing was fetched or written for it. */
  rejected: number;
  /** `upsertDraft` threw a genuine failure. */
  failed: number;
  images: ImportImageCounts;
  warnings: string[];
}

export interface ImportDeps {
  postStore: PostStore; storageDir: string; baseUrl: string;
  rehost?: (url: string, key: string, alt: string) => Promise<RehostResult>;
  /** Minimum spacing between remote fetches, in ms. 0 restores pre-#85 behaviour. */
  delayMs?: number;
  /** Retries per image, on top of the first attempt. */
  retries?: number;
  /** Injected so backoff is testable — a real 5+15+45 s wait cannot be. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Disk-derived "already re-hosted?" index. Omit to disable resumability. */
  resume?: RehostResume;
  /** Cap on RETRY attempts across the whole import (never on first attempts). */
  retryBudget?: number;
  /** Consecutive failures after which a host is abandoned for the rest of the run. */
  hostFailureLimit?: number;
  log?: (msg: string) => void;
}

const PLACEHOLDER_HERO = { src: '', width: 0, height: 0, alt: '' };

/** Backoff before retry 1, 2, 3+ — the spacing the 2026-07-29 migration used. */
export const BACKOFF_MS = [5_000, 15_000, 45_000] as const;
export const DEFAULT_RETRY_BUDGET = 200;
export const DEFAULT_HOST_FAILURE_LIMIT = 20;
/** Warnings returned to the client; the remainder is summarised and logged. */
export const WARNING_CAP = 200;

/** A short, slug-safe key segment from an image URL's filename. */
function nameFromUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  const segment = withoutQuery.split('/').pop() ?? 'image';
  const base = segment.replace(/\.[a-z0-9]+$/i, '');
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
}

/**
 * Re-host `url` once per translation pair.
 *
 * @ai-warning A DE/EN pair is two rows describing the SAME trip, so its two
 * bodies reference the same photos — 650 distinct images arrived as 1,338
 * fetch+encode calls in the 2026-06-24 export, each pair byte-identical. The
 * cache is scoped to one pair (created per group in importWxr), never global:
 * two different trips that happen to reuse a photo still get their own copy
 * under their own slug, so deleting one trip cannot strip another's images.
 * Within a pair that risk does not exist — `upsertDraft` writes both rows
 * under one translation_key and they are created and deleted together.
 *
 * Consequence: the stored key comes from whichever locale is built first (de),
 * so an EN post's photos live under the DE slug. That is deliberate.
 *
 * @ai-warning It memoises the PROMISE before awaiting it and never deletes it on
 * rejection, so a rejection is handed to every later caller in the pair.
 * Everything that retries or paces MUST therefore sit BELOW it (issue #85) —
 * above it, the second locale would get the settled rejection instantly while
 * the first burned the full backoff, and the same failure would be counted twice.
 */
type RehostFn = (url: string, key: string, alt: string) => Promise<RehostResult>;

function sharedRehost(rehost: RehostFn): RehostFn {
  const byUrl = new Map<string, Promise<RehostResult>>();
  return (url, key, alt) => {
    const hit = byUrl.get(url);
    if (hit) return hit;
    const p = rehost(url, key, alt);
    byUrl.set(url, p);
    return p;
  };
}

/** A host abandoned after too many consecutive failures. Never retried. */
class HostStoppedError extends Error {}

/** `host` for rate-limiting purposes, or null when the URL will not parse. */
function hostOf(url: string): string | null {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

/**
 * Should this failure be attempted again?
 *
 * @ai-warning Only a TRANSIENT FETCH failure. Anything that is not a
 * `FetchError` came from `processImage`/`storeVariants` — a sharp decode of a
 * corrupt body, or an ENOSPC — and re-downloading the same bytes to feed sharp
 * three more times is memory-pressure amplification inside a 4608 MiB
 * container, not recovery. `ENOTFOUND` is excluded because a source host that
 * no longer resolves would otherwise cost 665 x 65 s of pure backoff to report
 * a failure that was knowable in seconds.
 *
 * @ai-context docs/superpowers/specs/2026-07-30-wxr-import-hardening-design.md
 *   §Retry classification — issue #85.
 */
export function isRetryableFetchError(e: unknown): boolean {
  if (!(e instanceof FetchError)) return false;
  switch (e.kind) {
    case 'timeout': return true;
    case 'network': return e.code !== 'ENOTFOUND';
    case 'http': return e.status === 429 || (e.status ?? 0) >= 500;
    default: return false; // invalid-url, blocked, too-large
  }
}

/**
 * A client-safe reason for a failed image.
 *
 * @ai-warning Never widen this to carry the underlying message, `status` or
 * `code`. `isBlockedHost` does not block RFC1918 and `POST /import` is only
 * `requireAuth`, so raw undici text ("connect ECONNREFUSED 10.0.0.5:8080") is a
 * working internal-network mapping oracle for a non-admin author. The detail
 * belongs in the log. CLAUDE.md: never return raw infrastructure errors.
 */
export function failureReason(e: unknown): string {
  if (e instanceof HostStoppedError) return 'skipped after repeated consecutive failures from this host';
  if (e instanceof FetchError) {
    switch (e.kind) {
      case 'invalid-url': return 'unusable image URL';
      case 'blocked': return 'blocked address';
      case 'http': return 'download failed';
      case 'timeout': return 'download timed out';
      case 'too-large': return 'image too large';
      case 'network': return 'network error';
    }
  }
  return 'could not be processed';
}

/**
 * Bounded warning list: the first `cap`, then one line saying how many were
 * dropped. With a dead CDN this would otherwise be >1,300 strings, each
 * embedding a full URL, in one JSON body on a route with no response-size limit.
 */
function warningSink(cap = WARNING_CAP) {
  const priority: string[] = [];
  const kept: string[] = [];
  let dropped = 0;
  return {
    push(msg: string): void {
      if (kept.length < cap) kept.push(msg);
      else dropped++;
    },
    /**
     * A notice that work was TRUNCATED (a bound tripped). Never dropped, and
     * listed first.
     *
     * @ai-warning These must not go through `push`. They are appended after the
     * per-image warnings, so in exactly the high-failure runs they exist to
     * report, the cap would swallow them — leaving a truncated import looking
     * merely partial. "No silent caps" is the whole point of issue #85.
     */
    pushPriority(msg: string): void {
      priority.push(msg);
    },
    finish(): string[] {
      const tail = dropped > 0 ? [`…and ${dropped} more (see server logs)`] : [];
      return [...priority, ...kept, ...tail];
    },
  };
}

/**
 * Pace, retry, and give up on a host that is plainly refusing us.
 *
 * @ai-note The delay is an ELAPSED GATE, not a flat pre-fetch sleep. A
 * fetch+encode that already took longer than `delayMs` has satisfied it, so the
 * throttle costs nothing — which is what keeps a 665-photo import from growing
 * by ~13 minutes, and keeps the backoff from being double-charged (a 45 s wait
 * already means "at least 1.2 s since the last request").
 *
 * @ai-warning `retryBudget` caps RETRIES only, never first attempts: first
 * attempts are the legitimate work (one per distinct photo) and capping them
 * would break a genuinely large export, whereas retries are the amplification
 * this change introduces. The per-host breaker is what bounds first attempts.
 */
function resilientRehost(rehost: RehostFn, cfg: {
  delayMs: number; retries: number; retryBudget: number; hostFailureLimit: number;
  sleep: (ms: number) => Promise<void>; now: () => number; log: (msg: string) => void;
}): RehostFn & { notices: string[] } {
  let nextAt = -Infinity;
  let retriesLeft = cfg.retryBudget;
  let budgetReported = false;
  const consecutiveFailures = new Map<string, number>();
  const abandoned = new Set<string>();
  const notices: string[] = [];

  const paced: RehostFn = async (url, key, alt) => {
    const wait = nextAt - cfg.now();
    if (wait > 0) await cfg.sleep(wait);
    nextAt = cfg.now() + cfg.delayMs;
    return rehost(url, key, alt);
  };

  const fn: RehostFn = async (url, key, alt) => {
    const host = hostOf(url);
    if (host !== null && abandoned.has(host)) {
      throw new HostStoppedError(`host ${host} abandoned after ${cfg.hostFailureLimit} consecutive failures`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await paced(url, key, alt);
        if (host !== null) consecutiveFailures.set(host, 0);
        return r;
      } catch (e) {
        // @ai-warning ONLY a host-shaped failure counts toward the breaker, which
        // is why this reuses the retry classifier. A 404, an oversized response,
        // an unusable URL, a sharp decode failure or an ENOSPC on our own /data
        // are facts about one resource (or about us) — not evidence the host is
        // refusing us. Counting them means a trip whose photos were deleted from
        // the WordPress media library is a contiguous run of 404s that abandons a
        // healthy host and strands every later trip's photos; and since that run
        // repeats identically next time, the breaker trips at the same point on
        // every re-run, so the import can never converge. Re-running is the
        // documented recovery path, so "never converges" is a broken feature.
        if (host !== null && isRetryableFetchError(e)) {
          const n = (consecutiveFailures.get(host) ?? 0) + 1;
          consecutiveFailures.set(host, n);
          if (n >= cfg.hostFailureLimit && !abandoned.has(host)) {
            abandoned.add(host);
            const notice = `stopped fetching ${host} after ${n} consecutive failures`;
            notices.push(notice);
            cfg.log(`import: ${notice}`);
          }
        }
        const hostGone = host !== null && abandoned.has(host);
        if (attempt >= cfg.retries || hostGone || !isRetryableFetchError(e)) throw e;
        if (retriesLeft <= 0) {
          if (!budgetReported) {
            budgetReported = true;
            const notice = `retry budget of ${cfg.retryBudget} exhausted; later failures were not retried`;
            notices.push(notice);
            cfg.log(`import: ${notice}`);
          }
          throw e;
        }
        retriesLeft--;
        await cfg.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
      }
    }
  };
  return Object.assign(fn, { notices });
}

async function buildLocale(
  p: ParsedPost, attachments: Map<string, string>,
  rehost: (url: string, key: string, alt: string) => Promise<RehostResult>,
): Promise<PostLocale> {
  // hero from the featured image
  //
  // @ai-note These three catches are SILENT on purpose (issue #85). The tally
  // wrapper in importWxr is the single emitter of per-image warnings, because it
  // sits below `sharedRehost` and therefore sees one call per distinct (pair,
  // url) — reporting here instead would log the same memoised failure twice for
  // a photo both locales reference. They still catch, so the loop continues and
  // the original URL is left in place rather than lost.
  let heroImage = { ...PLACEHOLDER_HERO };
  const heroUrl = p.thumbnailId ? attachments.get(p.thumbnailId) : undefined;
  if (heroUrl) {
    try { const r = await rehost(heroUrl, `trips/${p.slug}/hero`, p.title); heroImage = { src: r.src, width: r.width, height: r.height, alt: p.title }; }
    catch { /* reported by the tally wrapper; hero stays a placeholder */ }
  }
  // body: convert, then re-host each markdown image and rewrite the ref
  let body = htmlToMarkdown(p.contentHtml);
  const images: Record<string, ImageDims> = {};
  for (const m of [...body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)]) {
    const full = m[0]; const alt = m[1] ?? ''; const url = m[2];
    if (!url || !/^https?:\/\//.test(url)) continue;
    try {
      const r = await rehost(url, `trips/${p.slug}/${nameFromUrl(url)}`, alt);
      body = body.replaceAll(full, `![${alt}](${r.src})`);
      images[r.src] = { width: r.width, height: r.height };
    } catch { /* reported by the tally wrapper; the WordPress URL is left in place */ }
  }

  // Gallery fences (from Elementor slideshows). Two passes over the SAME
  // scanner `normalizeGalleryFences` uses, because re-hosting is async and
  // rewriteFences is not: pass 1 collects the URLs, pass 2 substitutes.
  // @ai-warning: reuse `rewriteFences` rather than matching fences here. #75
  // already had to pin a second scanner (public/gallery-fence.js) against it
  // with gallery-fence-parity.test.ts; a third copy would silently disagree
  // about where a fence ends and drop or corrupt an author's photos.
  const galleryUrls: string[] = [];
  rewriteFences(body, (line) => {
    const url = (line.split('|')[0] ?? '').trim();
    if (/^https?:\/\//.test(url) && !galleryUrls.includes(url)) galleryUrls.push(url);
    return line;
  });
  const rehosted = new Map<string, RehostResult>();
  for (const url of galleryUrls) {
    try {
      rehosted.set(url, await rehost(url, `trips/${p.slug}/${nameFromUrl(url)}`, ''));
    } catch { /* reported by the tally wrapper */ }
  }
  body = rewriteFences(body, (line) => {
    const fields = line.split('|').map((f) => f.trim());
    const url = fields[0] ?? '';
    const r = rehosted.get(url);
    if (!r) return line; // fetch failed — keep the original so nothing is lost
    images[r.src] = { width: r.width, height: r.height };
    return [r.src, `${r.width}x${r.height}`, ...fields.slice(1)].join(' | ');
  });
  return { locale: p.locale, slug: p.slug, title: p.title, excerpt: p.excerpt, country: '', heroImage, bodyMarkdown: body, images };
}

export async function importWxr(xml: string, deps: ImportDeps): Promise<ImportSummary> {
  const { attachments, posts } = parseWxr(xml);
  const baseRehost = deps.rehost ?? ((url, key, alt) => rehostImage(url, key, alt, { storageDir: deps.storageDir, baseUrl: deps.baseUrl }));
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const images: ImportImageCounts = { total: 0, hosted: 0, failed: 0 };
  const warnings = warningSink();

  // @ai-note The defaults here are the INERT ones (no delay, no retry) and the
  // ROUTE passes the configured values, mirroring `cfg.loginLimiter ??
  // fixedWindowLimiter({…})`. That keeps every pre-#85 test instant instead of
  // paying (N-1) x delay against Vitest's never-raised 5 s timeout.
  const resilient = resilientRehost(baseRehost, {
    delayMs: deps.delayMs ?? 0,
    retries: deps.retries ?? 0,
    retryBudget: deps.retryBudget ?? DEFAULT_RETRY_BUDGET,
    hostFailureLimit: deps.hostFailureLimit ?? DEFAULT_HOST_FAILURE_LIMIT,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms); })),
    now: deps.now ?? (() => Date.now()),
    log,
  });

  /**
   * Resume from disk, count, and report — the one place that sees exactly one
   * call per distinct (pair, url), because `sharedRehost` sits above it.
   *
   * @ai-warning The resume lookup must stay ABOVE the pacing gate: a photo
   * already on disk must cost neither a fetch nor a delay, or resuming a
   * 665-photo import would sleep ~13 minutes fetching nothing.
   */
  const runRehost: RehostFn = async (url, key, alt) => {
    images.total++;
    // @ai-note Resumability is an OPTIMISATION, so a broken index must degrade to
    // "fetch it" rather than fail the image. Without this guard a throwing lookup
    // would propagate into buildLocale's silent catch: no warning, and
    // hosted + failed !== total.
    let already: RehostResult | null = null;
    try {
      already = (await deps.resume?.lookup(key)) ?? null;
    } catch (e) {
      log(`import: resume lookup failed for ${key}, re-fetching: ${(e as Error).message}`);
    }
    if (already) { images.hosted++; return already; }
    try {
      const r = await resilient(url, key, alt);
      images.hosted++;
      return r;
    } catch (e) {
      images.failed++;
      warnings.push(`image ${url} (${key}): ${failureReason(e)}`);
      log(`import: ${key} <- ${url} failed: ${(e as Error).message}`);
      throw e;
    }
  };

  // One bucket per outcome (issue #100): every group lands in exactly one, so
  // imported + updated + skippedPublished + rejected + failed === group count.
  const summary = { imported: 0, updated: 0, skippedPublished: 0, rejected: 0, failed: 0 };

  // existing posts by slug → status/key (for idempotency + published-skip)
  const existing = await deps.postStore.list();
  const bySlug = new Map<string, { translationKey: string; status: import('./posts.js').PostStatus }>();
  for (const s of existing) { bySlug.set(s.slugDe, s); bySlug.set(s.slugEn, s); }

  const groups = new Map<string, ParsedPost[]>();
  for (const p of posts) { const g = groups.get(p.group) ?? []; g.push(p); groups.set(p.group, g); }

  for (const [group, members] of groups) {
    const de = members.find((m) => m.locale === 'de');
    const en = members.find((m) => m.locale === 'en');
    if (!de || !en) { summary.rejected++; warnings.push(`group ${group}: missing ${de ? 'en' : 'de'} translation (${members.map((m) => m.slug).join(', ')})`); continue; }
    // @ai-warning: validate slugs at the import boundary BEFORE re-hosting images
    // or writing to the DB — an unsafe slug would otherwise become a storage path
    // segment (traversal) and a live URL.
    if (!isSafeSlug(de.slug) || !isSafeSlug(en.slug)) {
      summary.rejected++; warnings.push(`group ${group}: unsafe slug (${de.slug} / ${en.slug}) — rejected`); continue;
    }
    const prior = bySlug.get(de.slug) ?? bySlug.get(en.slug);
    if (prior?.status === 'published') { summary.skippedPublished++; warnings.push(`${de.slug}/${en.slug}: already published — not overwritten`); continue; }
    try {
      // One cache per pair: de and en describe the same trip and share photos.
      const pairRehost = sharedRehost(runRehost);
      const pair: PostPair = {
        translationKey: prior?.translationKey ?? '',
        status: 'draft',
        shared: { date: de.date, countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } },
        de: await buildLocale(de, attachments, pairRehost),
        en: await buildLocale(en, attachments, pairRehost),
      };
      await deps.postStore.upsertDraft(pair);
      if (prior) summary.updated++; else summary.imported++;
    } catch (e) { summary.failed++; warnings.push(`${de.slug}/${en.slug}: ${(e as Error).message}`); }
  }

  for (const notice of resilient.notices) warnings.pushPriority(notice);

  // @ai-note stdout, not only the response. A real export is a multi-minute
  // single request that the reverse proxy or the browser usually abandons
  // (issue #72), so the response is the one channel the author will not see.
  log(`import finished: imported=${summary.imported} updated=${summary.updated} `
    + `skippedPublished=${summary.skippedPublished} rejected=${summary.rejected} failed=${summary.failed} `
    + `images=${images.hosted}/${images.total} hosted, ${images.failed} failed`);

  return { ...summary, images, warnings: warnings.finish() };
}
