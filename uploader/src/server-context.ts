import type { FastifyInstance, FastifyReply, RouteOptions } from 'fastify';
import type { DbClient } from './db.js';
import type { AuthGuard } from './authn.js';
import type { SiteBuilder } from './build.js';
import type { DbBackup } from './backup.js';
import type { CommentStore } from './comments.js';
import type { CommentAdminStore } from './comments-admin.js';
import type { EncodeQueue } from './encode-queue.js';
import type { GpxService } from './gpx-service.js';
import type { ImportRunner } from './import-jobs.js';
import type { PreparedImport, ImportDeps } from './wp-import.js';
import type { JourneyStore, StoredJourney } from './journeys.js';
import type { LanguageConfig, LanguageLocale, LanguageStore } from './language.js';
import type { ReconcileReport } from './media-sync.js';
import type { MediaStore } from './media-store.js';
import type { NavigationStore } from './navigation.js';
import type { OnboardingStore } from './onboarding.js';
import type { ImageDims, PagePair, PageStore, StoredPagePair } from './pages.js';
import { PageError } from './pages.js';
import type { PostStore, PostUsageRow, StoredPostPair } from './posts.js';
import { PostError } from './posts.js';
import type { PublicationProjection } from './publication.js';
import { analyzeBodyContent, bodyImageKey } from './publish-gate.js';
import { publicPath } from './public-paths.js';
import type { AccountLimiter, RateLimiter } from './rate-limit.js';
import type { BundledRouting } from './routing-regions.js';
import type { OriginAllowList } from './routing-origins.js';
import type { SecretsStore } from './secrets.js';
import type { SessionStore } from './sessions.js';
import type { SettingsStore } from './settings.js';
import type { SiteIdentityStore } from './site-identity.js';
import type { StopRouter } from './stop-routing.js';
import type { TrustPolicy } from './trusted-proxy.js';
import type { UploadService } from './upload-service.js';
import type { UserStore } from './users.js';
import type { WorkLock } from './work-lock.js';

export interface ServerConfig {
  trustProxy: TrustPolicy['trust'];
  storageDir: string;
  baseUrl: string;
  users: UserStore;
  sessions: SessionStore;
  settings: SettingsStore;
  secrets: SecretsStore;
  identityStore?: SiteIdentityStore;
  onboarding?: OnboardingStore;
  language?: LanguageStore;
  /** Observe the real registered table for reserved-root namespace parity. */
  onRoute?: (route: RouteOptions) => void;
  posts: PostStore;
  pages: PageStore;
  journeys?: JourneyStore;
  navigation?: NavigationStore;
  imgHost: string;   // Host header that serves image variants (img subdomain)
  siteDir: string;   // release root; the blog is served from `${siteDir}/current`
  mapDir?: string;   // PMTiles/glyph assets; omit to disable /map/
  builder: SiteBuilder;
  backupDir: string;
  dbBackup: DbBackup;
  dbCheck: () => Promise<void>; // resolves iff the DB answers — probed by GET /health
  gpx?: GpxService;
  isWritable?: () => boolean;
  storageSignal?: AbortSignal;
  loginLimiter?: RateLimiter;
  accountLimiter?: AccountLimiter;
  /** Per-account failure limiter for POST /users/me/password, keyed on the session's user id. */
  passwordLimiter?: AccountLimiter;
  /** #513: injectable like `loginLimiter`; defaults to the OSRM router over `settings`. */
  stopRouter?: StopRouter;
  /** ROUTING_INTERNAL_ORIGINS (operator env): the only plain-HTTP / private routing origins. Default none. */
  routingInternalOrigins?: OriginAllowList;
  /** Bundled per-country OSRM (compose `osrm` + `osrm-fetch`); absent = Settings URLs only. */
  bundledRouting?: BundledRouting;
  /** Per-user Calculate limiter (default 20 per 10 minutes). */
  stopRouteLimiter?: RateLimiter;
  media: MediaStore;
  encodeQueue: EncodeQueue;
  uploads?: UploadService;
  /**
   * Disk↔database reconciliation + encode re-seed (`createReconciler`),
   * triggered by POST /media/rescan. The route MUST NOT call the sync alone —
   * see the @ai-warning on `createReconciler` (#117).
   */
  reconciler?: { run: () => Promise<ReconcileReport> };
  /**
   * The ONE process-wide build/encode mutex (issue #95), so the WordPress
   * importer's encodes never overlap `astro build`. The same instance the
   * builder and the encode queue were constructed with — a second lock would
   * silently remove the protection. Optional only so route tests that never
   * encode need not build one.
   */
  workLock?: WorkLock;
  prepareImport?: (xml: string, deps: ImportDeps) => Promise<PreparedImport>;
  importJobs?: ImportRunner;
  commentsAdmin?: CommentAdminStore;
  comments?: CommentStore;
  commentsEnabled?: () => boolean;
  commentsOrigin?: string;
  commentIpLimiter?: RateLimiter;
  commentGlobalLimiter?: RateLimiter;
}

export interface AppServer extends FastifyInstance {
  /** Refuse new mutating handlers and wait for those already admitted. */
  quiesceMutations(): Promise<void>;
}

/** Cap on any `keys[]` batch: an unbounded array is an authenticated
 *  N-round-trip amplifier against the process that also serves the blog. */
export const MAX_BULK_KEYS = 100;
export const FOREIGN_EXAMPLES = 5;

export interface ServerContext {
  app: FastifyInstance;
  cfg: ServerConfig;
  storageDir: string;
  imageBase: string;
  previewPolicy: string;
  language: LanguageStore;
  journeys: JourneyStore;
  routingInternalOrigins: OriginAllowList;
  publication: PublicationProjection;
  requireAuth: AuthGuard;
  requireAdmin: AuthGuard;
  optionalAuth: AuthGuard;
  limitAuth: AuthGuard;
  accountLimiter: AccountLimiter;
  passwordLimiter: AccountLimiter;
  importJobs: ImportRunner;
  isWritable: () => boolean;
  readOnly: (reply: FastifyReply) => FastifyReply;
  cleanupDeletedRoutes: () => Promise<boolean>;
  usageCorpus: () => Promise<{ posts: PostUsageRow[]; pages: PagePair[]; journeys: StoredJourney[] }>;
  validatePageImages: (pair: StoredPagePair, mode: LanguageConfig, client?: DbClient) => Promise<void>;
  foreignImagesMessage: (n: number) => string;
  foreignImagesReply: (reply: FastifyReply, foreign: string[]) => FastifyReply;
  publicationBody: (pair: StoredPostPair, mode: LanguageConfig) => Promise<{ foreign: string[]; keys: string[] }>;
  publicationReadiness: (keys: string[]) => (pair: StoredPostPair, mode: LanguageConfig, client?: DbClient) => Promise<void>;
}

export function foreignImagesMessage(n: number): string {
  return `${n} image(s) in the body or title banner are not hosted here — replace them with library photos or re-host imported body images, then publish again`;
}

/**
 * Turn an image URL from a post back into its storage key, or null when the
 * URL is not one of ours. Strips the image base and any hand-pasted variant
 * suffix (`-1280.webp` from the browser's "Copy image address").
 */
export function srcToKey(src: string, baseUrl: string): string | null {
  if (typeof src !== 'string' || src === '') return null;
  const prefix = `${baseUrl}/`;
  let u: URL;
  let base: URL;
  try { u = new URL(src); base = new URL(baseUrl); } catch { return null; }
  // Origin equality, never a prefix match — same rule as the gallery
  // allow-list (see site/src/lib/body-images.ts).
  if (u.origin !== base.origin || !src.startsWith(prefix)) return null;
  return src.slice(prefix.length).replace(/-\d+\.(?:avif|webp|jpeg)$/, '');
}

export class PublicationImageError extends PostError {
  constructor(readonly foreign: string[], readonly notReady: string[]) {
    super(foreign.length ? foreignImagesMessage(foreign.length)
      : `${notReady.length} photo(s) are still processing or failed to encode — wait for them to finish, then publish again`,
    foreign.length ? 'foreign_images' : 'images_not_ready');
  }
}

export function createPublishHelpers(cfg: ServerConfig, imageBase: string) {
  async function publicationBody(pair: StoredPostPair, mode: LanguageConfig): Promise<{ foreign: string[]; keys: string[] }> {
    const foreign = new Set<string>();
    const keys = new Set<string>();
    for (const locale of mode.locales.filter((locale) => !pair[locale].omitted)) {
      const l = pair[locale];
      const body = await analyzeBodyContent(l.bodyMarkdown, l.images, imageBase, locale);
      if (body.hasH1) {
        throw new PostError(`${locale}: body must not contain an H1; the story hero provides the page H1`);
      }
      for (const src of body.foreign) foreign.add(src);
      const storyUrl = new URL(publicPath(mode, locale, 'story', l.slug), imageBase).href;
      for (const src of body.sources) {
        const key = bodyImageKey(src, imageBase, storyUrl);
        if (key !== null) keys.add(key);
      }
      for (const image of [l.heroImage, l.titleImage]) {
        if (!image) continue;
        const key = srcToKey(image.src, imageBase);
        if (key !== null) keys.add(key);
      }
      if (l.titleImage && srcToKey(l.titleImage.src, imageBase) === null) foreign.add(l.titleImage.src);
    }
    return { foreign: [...foreign], keys: [...keys] };
  }

  async function notReadyPhotos(pair: StoredPostPair, keys: string[], mode: LanguageConfig, client?: DbClient): Promise<string[]> {
    if (keys.length === 0) return [];
    const notReady = await cfg.media.notReadyKeys(keys, client);
    // Title images are new library selections, not pre-library legacy heroes.
    // Unknown keys must not slip through notReadyKeys' legacy exception.
    for (const locale of mode.locales.filter((locale) => !pair[locale].omitted)) {
      const image = pair[locale].titleImage;
      if (!image) continue;
      const key = srcToKey(image.src, imageBase);
      if (key !== null && !(await cfg.media.get(key, client))) notReady.add(key);
    }
    return [...notReady];
  }

  async function pageImageFailure(body: string, images: Record<string, ImageDims>, mode: LanguageConfig, locale: LanguageLocale, client?: DbClient): Promise<string | null> {
    const analyzed = await analyzeBodyContent(body, images, imageBase, locale);
    if (analyzed.foreign.length) return foreignImagesMessage(analyzed.foreign.length);
    const url = new URL(publicPath(mode, locale, 'about'), imageBase).href;
    const keys = analyzed.sources.map((src) => bodyImageKey(src, imageBase, url)).filter((key): key is string => key !== null);
    const notReady = await cfg.media.notReadyKeys(keys, client);
    return notReady.size ? `${notReady.size} photo(s) are not ready to publish.` : null;
  }

  async function validatePageImages(pair: StoredPagePair, mode: LanguageConfig, client?: DbClient): Promise<void> {
    if (pair.key !== 'about') return;
    for (const locale of mode.locales) {
      const reason = await pageImageFailure(pair[locale].bodyMarkdown, pair[locale].images, mode, locale, client);
      if (reason) throw new PageError(reason, 'images_not_ready', undefined, locale);
    }
  }

  function publicationReadiness(keys: string[]) {
    return async (pair: StoredPostPair, mode: LanguageConfig, client?: DbClient): Promise<void> => {
      const notReady = await notReadyPhotos(pair, keys, mode, client);
      if (notReady.length) throw new PublicationImageError([], notReady);
    };
  }

  function foreignImagesReply(reply: FastifyReply, foreign: string[]) {
    return reply.code(409).send({
      error: foreignImagesMessage(foreign.length), code: 'foreign_images',
      foreignImages: foreign.slice(0, FOREIGN_EXAMPLES), foreignImageCount: foreign.length,
    });
  }

  return { publicationBody, validatePageImages, publicationReadiness, foreignImagesMessage, foreignImagesReply };
}
