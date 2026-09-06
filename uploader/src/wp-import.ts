import { parseWxr, type ParsedPost } from './wxr-parse.js';
import { htmlToMarkdown, markdownImages } from './wp-content.js';
import { rehostImage, type RehostResult, type RehostResume } from './wp-images.js';
import { isSafeSlug, PostError, type ImageDims, type PostLocale, type PostPair, type PostStatus, type PostStore, type PostSummary, type StoredPostPair } from './posts.js';
import { rewriteFences } from './body-content.js';
import { FetchError } from './safe-fetch.js';
import { insufficientSpaceForImport, type DiskSpace } from './disk.js';
import type { WorkLock } from './work-lock.js';

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
  /**
   * Rejected at the import boundary: a missing translation, a slug the importer refuses
   * (path-traversal defence), or a slug conflict with an existing post whose (DE, EN) slug
   * pair does not match as a unit (issue #99). Nothing was fetched or written for it.
   */
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
  /**
   * Cap on the TOTAL number of distinct (pair, url) re-host operations the import
   * may perform, enforced BEFORE any fetch (issue #96). `retryBudget` bounds
   * retries and `hostFailureLimit` bounds a FAILING host, but neither bounds
   * first attempts against a host that keeps answering — this is the bound that does.
   */
  maxImages?: number;
  /**
   * Free/total bytes of the volume the images land on (issue #94). Omit to
   * skip the free-space precondition; a throwing probe is logged and skipped
   * too, mirroring `/upload` — an unreadable statfs must not block an import.
   */
  diskSpace?: () => Promise<DiskSpace>;
  /**
   * The shared build/encode mutex (issue #95). Passed through to the default
   * `rehostImage`, whose encode then runs under `runShared`; ignored when a
   * custom `rehost` is injected (that seam decides for itself).
   */
  lock?: WorkLock;
  /**
   * Rebuild an existing DRAFT pair wholesale from the export (issue #126). Default
   * false: a re-run keeps the stored pair — the author's work — and only swaps in
   * the photos it re-hosted this time. Published pairs are skipped either way.
   */
  overwriteDrafts?: boolean;
  log?: (msg: string) => void;
}

const PLACEHOLDER_HERO = { src: '', width: 0, height: 0, alt: '' };

/** Backoff before retry 1, 2, 3+ — the spacing the 2026-07-29 migration used. */
export const BACKOFF_MS = [5_000, 15_000, 45_000] as const;
export const DEFAULT_RETRY_BUDGET = 200;
export const DEFAULT_HOST_FAILURE_LIMIT = 20;
/** Warnings returned to the client; the remainder is summarised and logged. */
export const WARNING_CAP = 200;
/**
 * The most distinct (pair, url) re-host operations one import may perform
 * (issue #96).
 *
 * @ai-warning The re-host cache is scoped to one translation pair, so an
 * attachment URL declared once and referenced from N distinct groups is
 * fetched N times; a 25 MiB upload of minimal DE/EN groups reaches ~40,400
 * fetches of one third-party URL. `retryBudget` bounds retries and
 * `hostFailureLimit` bounds a FAILING host, but neither bounds first attempts
 * against a host that keeps answering — this is that bound. Set well above a
 * legitimate export (the real one was 665 photos; a big blog is several
 * thousand) and well below the ~40,400 attack.
 */
export const DEFAULT_MAX_IMAGES = 20_000;

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

/**
 * The import would re-host more distinct images than `maxImages` allows
 * (issue #96). Thrown BEFORE any fetch, so a rejected import performs no work
 * and leaves no partial state. The `/import` route maps it to a 400 that names
 * the count, so the author knows exactly why and how far over the cap they are.
 */
export class ImportTooLargeError extends Error {
  constructor(readonly count: number, readonly cap: number) {
    super(`import rejected: would re-host ${count} distinct images, which exceeds the cap of ${cap}`);
    this.name = 'ImportTooLargeError';
  }
}

/**
 * The volume cannot hold the photos this run would fetch (issue #94). Thrown
 * BEFORE any fetch, from the same pre-flight as `ImportTooLargeError`, so no
 * work is performed and no partial state is left. The `/import` route maps it
 * to a 507, the status `/upload` already uses for the same condition.
 */
export class ImportInsufficientSpaceError extends Error {
  constructor(message: string, readonly photos: number, readonly freeBytes: number) {
    super(message);
    this.name = 'ImportInsufficientSpaceError';
  }
}

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

/**
 * The distinct https?:// image URLs a single post would re-host: its hero
 * (featured image) plus every body-image and gallery-fence URL.
 *
 * @ai-warning This mirrors `buildLocale`'s extraction EXACTLY — the same
 * `htmlToMarkdown` (with the same attachment map, so classic shortcodes expand
 * identically), the same `markdownImages` parser, the same `rewriteFences`
 * scan, the same scheme filter. The pre-flight count in `importWxr` (issue
 * #96) is only as good as this agreement: if `buildLocale` ever changes which
 * URLs it fetches, this must change with it, or the cap would count a different
 * set than the import performs. `test/wp-import.test.ts` pins them to agree.
 */
function rehostUrlSet(p: ParsedPost, attachments: Map<string, string>, includeHero: boolean): Set<string> {
  const urls = new Set<string>();
  const heroUrl = includeHero && p.thumbnailId ? attachments.get(p.thumbnailId) : undefined;
  if (heroUrl) urls.add(heroUrl);
  const body = htmlToMarkdown(p.contentHtml, attachments);
  for (const { url } of markdownImages(body)) {
    if (/^https?:\/\//.test(url)) urls.add(url);
  }
  rewriteFences(body, (line) => {
    const url = (line.split('|')[0] ?? '').trim();
    if (/^https?:\/\//.test(url)) urls.add(url);
    return line;
  });
  return urls;
}

/** Storage key for a post's featured image. Never resumed from disk (see `HERO_KEY_RE`). */
const heroKey = (p: ParsedPost): string => `trips/${p.slug}/hero`;
/** Storage key for a body or gallery image. Deterministic and un-hashed — `/data/images` is the resume record. */
const imageKey = (p: ParsedPost, url: string): string => `trips/${p.slug}/${nameFromUrl(url)}`;

/**
 * The distinct (pair, url) re-host operations one pair performs, each with the
 * storage key it will be written under — url → key, in call order.
 *
 * @ai-warning Mirrors `sharedRehost` + `buildLocale`: the pair's cache is keyed
 * by URL and memoises the FIRST caller's key, and `buildLocale` runs de before
 * en and the hero before the body, so a URL both locales reference lands under
 * the DE slug and a hero URL that also appears in the body lands in the hero
 * slot. `rehostUrlSet` preserves that order (hero, body, gallery), and
 * `includeHero` is the same per-pair flag `buildLocale` gets (issue #126), so
 * a skipped hero neither counts nor claims the hero key. The size of
 * this map is the #96 cap's quantity; its keys feed the #94 resume-aware
 * free-space estimate. `test/wp-import.test.ts` pins both against the run.
 */
function rehostPlan(de: ParsedPost, en: ParsedPost, attachments: Map<string, string>, includeHero: boolean): Map<string, string> {
  const plan = new Map<string, string>();
  for (const p of [de, en]) {
    const hero = includeHero && p.thumbnailId ? attachments.get(p.thumbnailId) : undefined;
    for (const url of rehostUrlSet(p, attachments, includeHero)) {
      if (!plan.has(url)) plan.set(url, url === hero ? heroKey(p) : imageKey(p, url));
    }
  }
  return plan;
}

/**
 * Substitute every re-hosted WordPress URL in `body` — Markdown image references
 * and gallery-fence lines — recording the dimensions of each substituted photo
 * in `images`. URLs absent from `rehosted` (a failed fetch, or a photo that is
 * already ours) are left exactly as they are, so nothing is lost.
 *
 * One pass for two callers: `buildLocale` runs it over the export's fresh
 * Markdown, and `mergeLocale` over the AUTHOR's stored body on a re-run (issue
 * #126) — which is what makes a re-run a URL substitution rather than a body
 * replacement.
 *
 * @ai-note `markdownImages` decodes Turndown's destination encoding (escaped
 * parens, `<…>` around a space, a trailing " title") — issue #125. The rewrite
 * drops the title: Elementor fills it with the attachment filename, which is
 * noise, and the re-hosted URL needs no escaping.
 * @ai-warning: reuse `rewriteFences` rather than matching fences here. #75
 * already had to pin a second scanner (public/gallery-fence.js) against it
 * with gallery-fence-parity.test.ts; a third copy would silently disagree
 * about where a fence ends and drop or corrupt an author's photos.
 */
function applyRehosts(body: string, rehosted: ReadonlyMap<string, RehostResult>, images: Record<string, ImageDims>): string {
  // The store lifts a gallery line's `| alt= | caption=` into `images[url]` on
  // save — for a hot-link that failed last run, under the WordPress URL. Healing
  // the URL must carry that entry over, or the author's alt/caption is stranded
  // under a key nothing references (review finding on PR #164).
  // Merge, never replace: the same WordPress URL can occur twice (two gallery
  // lines, or a body image AND a gallery line), and the first substitution
  // already moved the metadata to the hosted key.
  const record = (from: string, r: RehostResult): void => {
    images[r.src] = { ...images[r.src], ...images[from], width: r.width, height: r.height };
    if (from !== r.src) delete images[from];
  };
  for (const { full, alt, url } of markdownImages(body)) {
    const r = rehosted.get(url);
    if (!r) continue;
    body = body.replaceAll(full, `![${alt}](${r.src})`);
    record(url, r);
  }
  return rewriteFences(body, (line) => {
    const fields = line.split('|').map((f) => f.trim());
    const url = fields[0] ?? '';
    const r = rehosted.get(url);
    if (!r) return line; // fetch failed — keep the original so nothing is lost
    record(url, r);
    return [r.src, `${r.width}x${r.height}`, ...fields.slice(1)].join(' | ');
  });
}

/** The export's view of one locale, plus the URL → hosted-photo map the run produced for it. */
interface BuiltLocale { locale: PostLocale; rehosted: Map<string, RehostResult> }
async function buildLocale(
  p: ParsedPost, attachments: Map<string, string>,
  rehost: (url: string, key: string, alt: string) => Promise<RehostResult>,
  includeHero: boolean,
): Promise<BuiltLocale> {
  // hero from the featured image
  //
  // @ai-note These three catches are SILENT on purpose (issue #85). The tally
  // wrapper in importWxr is the single emitter of per-image warnings, because it
  // sits below `sharedRehost` and therefore sees one call per distinct (pair,
  // url) — reporting here instead would log the same memoised failure twice for
  // a photo both locales reference. They still catch, so the loop continues and
  // the original URL is left in place rather than lost.
  //
  // @ai-warning The hero key `trips/<slug>/hero` encodes no URL identity, so the
  // resume index never skips it: every run REWRITES those bytes. On a merge run
  // whose stored hero has a `src` (issue #126) the caller passes
  // `includeHero: false`, so the author's photo is neither refetched nor
  // overwritten under the same key with stale dimensions (review finding on PR
  // #164). `rehostUrlSet` takes the same flag so the #96 count stays exact.
  let heroImage = { ...PLACEHOLDER_HERO };
  const heroUrl = includeHero && p.thumbnailId ? attachments.get(p.thumbnailId) : undefined;
  if (heroUrl) {
    try { const r = await rehost(heroUrl, heroKey(p), p.title); heroImage = { src: r.src, width: r.width, height: r.height, alt: p.title }; }
    catch { /* reported by the tally wrapper; hero stays a placeholder */ }
  }
  // body: convert, re-host each distinct photo (body images first, then gallery
  // lines — the order the pre-#126 loops used), then substitute in one pass.
  const body = htmlToMarkdown(p.contentHtml, attachments);
  const rehosted = new Map<string, RehostResult>();
  const rehostOnce = async (url: string, alt: string): Promise<void> => {
    if (!/^https?:\/\//.test(url) || rehosted.has(url)) return;
    try { rehosted.set(url, await rehost(url, imageKey(p, url), alt)); }
    catch { /* reported by the tally wrapper; the WordPress URL is left in place */ }
  };
  for (const { alt, url } of markdownImages(body)) await rehostOnce(url, alt);
  const galleryUrls: string[] = [];
  rewriteFences(body, (line) => { galleryUrls.push((line.split('|')[0] ?? '').trim()); return line; });
  for (const url of galleryUrls) await rehostOnce(url, '');
  const images: Record<string, ImageDims> = {};
  const bodyMarkdown = applyRehosts(body, rehosted, images);
  return {
    locale: { locale: p.locale, slug: p.slug, title: p.title, excerpt: p.excerpt, country: '', heroImage, bodyMarkdown, images },
    rehosted,
  };
}

/**
 * Fetch the export's featured image for this pair? Only when the pair has NO
 * stored hero at all. The decision is per PAIR, not per locale: both locales
 * usually share one featured URL, `sharedRehost` memoises by URL, so both
 * stored heroes point at ONE key (`trips/<de slug>/hero`) — refetching for an
 * emptied DE slot would overwrite the bytes the kept EN hero still references
 * (review finding on PR #164). An author who cleared one locale's hero sets it
 * again in the editor; `overwriteDrafts` refetches regardless.
 */
function includeHero(stored: StoredPostPair | null): boolean {
  return !stored || (!stored.de.heroImage.src && !stored.en.heroImage.src);
}

/**
 * A re-run over an existing draft (issue #126): keep the author's locale fields
 * and body, and change only what a re-run exists to change — swap in the photos
 * this run re-hosted, and fill an empty hero slot.
 *
 * @ai-note Hero: the author's pick wins whenever it has a `src` (they may have
 * chosen a different photo in the editor); an EMPTY slot — the featured image
 * failed last time — takes the export's now-recovered hero (fetched only under
 * `includeHero`), keeping the author's alt if they wrote one. Body: URL
 * substitution over the STORED text,
 * so prose edits, alt edits, removed photos and reordered galleries survive.
 */
function mergeLocale(stored: PostLocale, fresh: BuiltLocale): PostLocale {
  const images: Record<string, ImageDims> = { ...stored.images };
  const bodyMarkdown = applyRehosts(stored.bodyMarkdown, fresh.rehosted, images);
  const heroImage = stored.heroImage.src
    ? { ...stored.heroImage }
    : { ...fresh.locale.heroImage, alt: stored.heroImage.alt || fresh.locale.heroImage.alt };
  return { ...stored, heroImage, bodyMarkdown, images };
}

/** Live counters for a running import (issue #92). `planned` is fixed at pre-flight. */
export interface ImportProgress {
  groups: { total: number; done: number };
  images: { planned: number; hosted: number; failed: number };
}

/**
 * A parsed, validated, pre-flighted import that has not fetched anything yet.
 * `groups` counts EVERY group in the export (including those already rejected
 * or skipped as published), so the route can 400 an export with nothing in it
 * before starting a job; `planned` is what `run()` will do.
 */
export interface PreparedImport {
  groups: number;
  planned: ImportProgress;
  /**
   * Perform the import. `onProgress` fires after every image outcome and every
   * group outcome with the same object, mutated in place — copy it if you keep it.
   */
  run(onProgress?: (p: ImportProgress) => void): Promise<ImportSummary>;
}

/** The whole import in one call — the pre-#92 shape, kept for the CLI and tests. */
export async function importWxr(xml: string, deps: ImportDeps): Promise<ImportSummary> {
  return (await prepareImport(xml, deps)).run();
}

/**
 * Everything that can REFUSE the export happens here, synchronously from the
 * route's point of view, and keeps its status code: no groups (400), over the
 * distinct-image cap (400, #96), not enough free space (507, #94). What comes
 * back is a `run()` that performs the multi-minute part off the request path
 * (issue #92).
 */
export async function prepareImport(xml: string, deps: ImportDeps): Promise<PreparedImport> {
  const { attachments, posts } = parseWxr(xml);
  const baseRehost = deps.rehost ?? ((url, key, alt) => rehostImage(url, key, alt, { storageDir: deps.storageDir, baseUrl: deps.baseUrl, lock: deps.lock }));
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
   * Resume lookups, memoised per key. The #94 pre-flight probes every key the
   * run will touch, and the run then asks again — without this a resumed
   * 665-photo import would read every original's metadata twice.
   *
   * @ai-note Resumability is an OPTIMISATION, so a broken index must degrade to
   * "fetch it" rather than fail the image. Without this guard a throwing lookup
   * would propagate into buildLocale's silent catch: no warning, and
   * hosted + failed !== total.
   */
  const resumed = new Map<string, Promise<RehostResult | null>>();
  const lookupResume = (key: string): Promise<RehostResult | null> => {
    if (!deps.resume) return Promise.resolve(null);
    let hit = resumed.get(key);
    if (!hit) {
      hit = deps.resume.lookup(key).then((r) => r ?? null, (e: unknown) => {
        log(`import: resume lookup failed for ${key}, re-fetching: ${(e as Error).message}`);
        return null;
      });
      resumed.set(key, hit);
    }
    return hit;
  };

  /** Progress emitter, bound by `run()`; a no-op until then. */
  let tick = (): void => {};

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
    const already = await lookupResume(key);
    if (already) { images.hosted++; tick(); return already; }
    try {
      const r = await resilient(url, key, alt);
      images.hosted++;
      tick();
      return r;
    } catch (e) {
      images.failed++;
      tick();
      warnings.push(`image ${url} (${key}): ${failureReason(e)}`);
      log(`import: ${key} <- ${url} failed: ${(e as Error).message}`);
      throw e;
    }
  };

  // One bucket per outcome (issue #100): every group lands in exactly one, so
  // imported + updated + skippedPublished + rejected + failed === group count.
  const summary = { imported: 0, updated: 0, skippedPublished: 0, rejected: 0, failed: 0 };

  // Existing posts by slug, ANY locale → the posts using it (idempotency + published-skip).
  //
  // @ai-warning A slug is a shared namespace across locales here even though the
  // database keys uniqueness per (locale, slug): the importer's storage keys are
  // `trips/<slug>/…` with NO locale segment, so a group whose EN slug equals an
  // unrelated post's DE slug would write its photos over that post's variant
  // files. The old flat lookup went further and bound the group to that post's
  // `translationKey`, so `upsertDraft` overwrote the post itself (issue #99,
  // Golden Rule 2). Pair identity is therefore the (DE slug, EN slug) tuple as a
  // unit, and ANY other overlap is a conflict — never a binding.
  const existing = await deps.postStore.list();
  const owners = new Map<string, PostSummary[]>();
  for (const s of existing) {
    for (const slug of new Set([s.slugDe, s.slugEn])) {
      if (slug) owners.set(slug, [...(owners.get(slug) ?? []), s]);
    }
  }
  /** Slugs claimed by groups accepted earlier in THIS export — same namespace, same rule. */
  const claimed = new Map<string, string>();

  const groups = new Map<string, ParsedPost[]>();
  for (const p of posts) { const g = groups.get(p.group) ?? []; g.push(p); groups.set(p.group, g); }

  // Validate every group up front, so the pre-flight image count (issue #96)
  // counts EXACTLY the groups that will be imported — no more, no less.
  // `stored` is the pair a MERGE run will write into (issue #126): resolved here,
  // before the count, because whether the hero is fetched depends on it.
  const pending: { de: ParsedPost; en: ParsedPost; prior: { translationKey: string; status: PostStatus } | undefined; stored: StoredPostPair | null }[] = [];
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
    // Pair identity is the (DE slug, EN slug) tuple as a UNIT: exactly one existing
    // post touches either slug AND it owns both. Binding on a single matching slug
    // would rename the other locale's live slug (SEO contract) or write into a post
    // the author never meant to touch; a cross-locale namesake shares the image
    // storage namespace. Every such overlap is for the author to resolve in the
    // editor, not here.
    const touching = [...new Set([...(owners.get(de.slug) ?? []), ...(owners.get(en.slug) ?? [])])];
    const prior = touching.length === 1 && touching[0]!.slugDe === de.slug && touching[0]!.slugEn === en.slug ? touching[0] : undefined;
    if (!prior && touching.length > 0) {
      summary.rejected++;
      warnings.push(`${de.slug}/${en.slug}: slug conflict with an existing post (${touching.map((t) => `${t.slugDe}/${t.slugEn}`).join(', ')}) — rejected, nothing overwritten`);
      continue;
    }
    const earlier = claimed.get(de.slug) ?? claimed.get(en.slug);
    if (earlier) {
      summary.rejected++;
      warnings.push(`${de.slug}/${en.slug}: slug conflict within this export (also used by ${earlier}) — rejected, nothing written`);
      continue;
    }
    claimed.set(de.slug, `${de.slug}/${en.slug}`);
    claimed.set(en.slug, `${de.slug}/${en.slug}`);
    if (prior?.status === 'published') { summary.skippedPublished++; warnings.push(`${de.slug}/${en.slug}: already published — not overwritten`); continue; }
    // A re-run over an existing draft MERGES by default: the stored pair is the
    // author's work, and the export only contributes the photos it re-hosts.
    // `overwriteDrafts` restores the wholesale rebuild for "I changed it in
    // WordPress and re-exported". A prior whose pair cannot be read (a stranded
    // single-locale row) has nothing to merge with and is rebuilt.
    const stored = prior && !deps.overwriteDrafts ? await deps.postStore.get(prior.translationKey) : null;
    pending.push({ de, en, prior, stored });
  }

  // issue #96: bound the TOTAL number of first attempts BEFORE fetching anything.
  // Count distinct (pair, url) — the same quantity `images.total` tallies per
  // fetch — and reject before any of it happens.
  const cap = deps.maxImages ?? DEFAULT_MAX_IMAGES;
  const plans = pending.map((g) => rehostPlan(g.de, g.en, attachments, includeHero(g.stored)));
  let distinct = 0;
  for (const plan of plans) distinct += plan.size;
  if (distinct > cap) {
    log(`import: ${distinct} distinct images exceeds the cap of ${cap}; rejecting without fetching`);
    throw new ImportTooLargeError(distinct, cap);
  }

  // issue #94: the /data free-space precondition `/upload` has, sized from the
  // photos this run will actually FETCH — the ones the resume index does not
  // already hold — so the post-ENOSPC re-run (the documented recovery path)
  // is judged on the remainder, not on the whole export again.
  if (deps.diskSpace) {
    let toFetch = 0;
    for (const plan of plans) for (const key of plan.values()) if (!(await lookupResume(key))) toFetch++;
    let space: DiskSpace | null = null;
    try {
      space = await deps.diskSpace();
    } catch (e) {
      log(`import: free-space check skipped (statfs failed): ${(e as Error).message}`);
    }
    const problem = space && insufficientSpaceForImport(space, toFetch);
    if (space && problem) {
      log(`import refused: ${space.free} bytes free, ${toFetch} of ${distinct} photos still to fetch`);
      throw new ImportInsufficientSpaceError(problem, toFetch, space.free);
    }
  }

  const progress: ImportProgress = {
    groups: { total: pending.length, done: 0 },
    images: { planned: distinct, hosted: 0, failed: 0 },
  };

  let started = false;
  const run = async (onProgress?: (p: ImportProgress) => void): Promise<ImportSummary> => {
    if (started) throw new Error('a prepared import can only run once');
    started = true;
    tick = () => {
      progress.images.hosted = images.hosted;
      progress.images.failed = images.failed;
      onProgress?.(progress);
    };
    for (const { de, en, prior, stored } of pending) {
      try {
        // One cache per pair: de and en describe the same trip and share photos.
        const pairRehost = sharedRehost(runRehost);
        const freshDe = await buildLocale(de, attachments, pairRehost, includeHero(stored));
        const freshEn = await buildLocale(en, attachments, pairRehost, includeHero(stored));
        const pair: PostPair = stored
          ? { translationKey: stored.translationKey, status: 'draft', shared: stored.shared, de: mergeLocale(stored.de, freshDe), en: mergeLocale(stored.en, freshEn) }
          : {
            translationKey: prior?.translationKey ?? '',
            status: 'draft',
            shared: { date: de.date, countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } },
            de: freshDe.locale,
            en: freshEn.locale,
          };
        await deps.postStore.upsertDraft(pair);
        if (prior) summary.updated++; else summary.imported++;
      } catch (e) {
        summary.failed++;
        // The client sees a PostError as-is (a validation verdict, worded for
        // the author) but never a pg/infrastructure message — `invalid byte
        // sequence`, `ECONNREFUSED db:5432` — which goes to stdout instead, the
        // same split `failureReason` makes for photos (issue #143).
        const reason = e instanceof PostError ? e.message : 'could not be saved (see server logs)';
        warnings.push(`${de.slug}/${en.slug}: ${reason}`);
        log(`import: ${de.slug}/${en.slug} failed: ${(e as Error).message}`);
      }
      progress.groups.done++;
      tick();
    }

    for (const notice of resilient.notices) warnings.pushPriority(notice);

    // @ai-note stdout, not only the response. Before #92 a real export was a
    // multi-minute single request that the reverse proxy or the browser usually
    // abandoned (issue #72); the job row and GET /import/status now carry the
    // summary too, but the log line stays the channel that survives everything.
    log(`import finished: imported=${summary.imported} updated=${summary.updated} `
      + `skippedPublished=${summary.skippedPublished} rejected=${summary.rejected} failed=${summary.failed} `
      + `images=${images.hosted}/${images.total} hosted, ${images.failed} failed`);

    return { ...summary, images, warnings: warnings.finish() };
  };

  return { groups: groups.size, planned: progress, run };
}
