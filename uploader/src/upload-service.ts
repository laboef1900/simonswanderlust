import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { BacklogFullError, type EncodeQueue } from './encode-queue.js';
import { assertSafeFolder, libraryKey, type MediaItem, type MediaStore } from './media-store.js';
import { normalizeProcessOptions, outputFormatForExtension, probeImage, type ImageProbe } from './pipeline.js';
import { parseExif, type MediaExif } from './exif.js';
import { assertSafeKey, contentHashKey, heroSnippet, storeOriginal } from './storage.js';
import { formatsFor, variantWidths } from './variants.js';
import type { SettingsStore } from './settings.js';
import { StorageReadOnlyError } from './storage-owner.js';
import { UPLOAD_UUID_RE, type ReceiptCursor, type UploadIdentity, type UploadReceipt, type UploadReceiptStore, type UploadResult } from './upload-receipts.js';

export interface UploadInput extends UploadIdentity {
  userId: string; uploadId: string; retryGeneration: number; bytes: Buffer;
}
export interface UploadRecoveryReport { pending: number; blocked: number; examined: number; accepted: number; retryable: number; continuationAvailable: boolean }
export interface UploadService {
  upload(input: UploadInput): Promise<{ statusCode: number; body: Record<string, unknown> }>;
  get(userId: string, uploadId: string): Promise<Record<string, unknown> | null>;
  start(): Promise<UploadRecoveryReport>;
  recover(): Promise<UploadRecoveryReport>;
  quiesce(): Promise<void>;
  removeMedia(key: string, remove: Parameters<UploadReceiptStore['removeMedia']>[1]): Promise<void>;
}
interface Options {
  receipts: UploadReceiptStore; media: MediaStore; queue: EncodeQueue;
  storageDir: string; baseUrl: string; settings: SettingsStore;
  isWritable(): boolean; signal?: AbortSignal;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identityOf = (i: UploadInput): UploadIdentity => ({ key: i.key.trim(), filename: i.filename, title: i.title.trim(), alt: i.alt.trim(), folder: i.folder.trim() });
const sameIdentity = (a: UploadIdentity, b: UploadIdentity) => a.key === b.key && a.filename === b.filename && a.title === b.title && a.alt === b.alt && a.folder === b.folder;
const envelope = (r: UploadReceipt): Record<string, unknown> => ({ ownerUserId: r.userId, uploadId: r.uploadId, state: r.state,
  ...(r.state === 'accepted' ? { result: r.result } : {}),
  ...(r.state === 'pending' ? { reason: r.reason ?? 'recovery_required', originalRetained: r.originalRetained } : {}),
  ...(r.state === 'retryable' ? { retryGeneration: r.generation } : {}),
});

/** Owns admitted upload execution until settlement, independently of the HTTP connection. */
export function createUploadService(opts: Options): UploadService {
  const incarnation = randomUUID();
  const active = new Map<string, Promise<unknown>>();
  let stopped = false;
  let cursor: ReceiptCursor | null = null;
  let running: Promise<UploadRecoveryReport> | undefined;
  let wakeup = false;
  let unsubscribe: (() => void) | undefined;
  const assertWritable = () => { if (stopped || !opts.isWritable()) throw new StorageReadOnlyError(); };
  let blockedPass = false;
  const token = (userId: string, uploadId: string) => `${userId}:${uploadId}`;
  async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = active.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => { assertWritable(); return action(); });
    active.set(key, result);
    const release = () => { if (active.get(key) === result) active.delete(key); };
    void result.then(release, release);
    return result;
  }
  const resultOf = (r: UploadReceipt, item: MediaItem, duplicate = false): UploadResult => {
    const src = `${opts.baseUrl.replace(/\/+$/, '')}/${r.mediaKey}`;
    return { key: r.mediaKey, src, width: item.width, height: item.height, status: item.status,
      folder: item.folder, ...(duplicate ? { duplicate: true } : {}), ...(item.format ? { format: item.format } : {}),
      snippet: heroSnippet(src, item.width, item.height, item.alt.de || r.identity.alt, item.format) };
  };
  function rowMatches(r: UploadReceipt, item: MediaItem): boolean {
    const profile = normalizeProcessOptions(item.encoding);
    return item.key === r.mediaKey && item.width === r.frozen.width && item.height === r.frozen.height
      && item.format === r.frozen.format && profile.convertJpeg === r.frozen.encoding.convertJpeg
      && profile.webpQuality === r.frozen.encoding.webpQuality && profile.avifQuality === r.frozen.encoding.avifQuality;
  }
  async function original(r: UploadReceipt): Promise<'matching' | 'absent' | 'uncertain'> {
    assertSafeKey(r.mediaKey);
    if (!/^[a-z0-9]+$/.test(r.frozen.ext)) return 'uncertain';
    let file;
    try { file = await open(join(opts.storageDir, `${r.mediaKey}-orig.${r.frozen.ext}`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'uncertain'; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== r.frozen.bytes) return 'uncertain';
      const bytes = await file.readFile();
      return digest(bytes) === r.sha256 && contentHashKey(r.frozen.baseKey, bytes, r.frozen.encoding) === r.mediaKey ? 'matching' : 'uncertain';
    } catch { return 'uncertain'; }
    finally { await file.close(); }
  }
  async function ready(r: UploadReceipt, item: MediaItem): Promise<boolean> {
    assertSafeKey(r.mediaKey);
    if (!rowMatches(r, item) || item.status !== 'ready') return false;
    try {
      for (const width of variantWidths(item.width)) for (const format of formatsFor(item.format)) {
        const stat = await lstat(join(opts.storageDir, `${item.key}-${width}.${format}`));
        if (!stat.isFile() || stat.size <= 0) return false;
      }
      return true;
    } catch { return false; }
  }
  async function replace(r: UploadReceipt, patch: Partial<UploadReceipt>): Promise<UploadReceipt> {
    assertWritable();
    const next = { ...r, ...patch };
    if (!await opts.receipts.replace(r, next)) throw new Error('Upload receipt ownership changed.');
    return next;
  }
  async function pending(r: UploadReceipt, retained: boolean, reason: UploadReceipt['reason']): Promise<void> {
    await replace(r, { reason, originalRetained: retained });
  }
  async function accept(r: UploadReceipt, item: MediaItem, applyMetadata: boolean, duplicate = applyMetadata): Promise<void> {
    assertWritable();
    const committed = await opts.receipts.accept(r, async (client) => {
      let stored = item;
      if (applyMetadata) {
        const fillFolder = r.identity.folder !== '' && item.folder === '';
        if (r.identity.title || r.identity.alt || fillFolder) stored = await opts.media.patch(item.key, {
          ...(r.identity.title ? { title: r.identity.title } : {}),
          ...(fillFolder ? { folder: r.identity.folder } : {}),
          ...(r.identity.alt ? { alt: { de: item.alt.de || r.identity.alt, en: item.alt.en || r.identity.alt } } : {}),
        }, client);
      }
      return resultOf(r, stored, duplicate);
    });
    if (!committed) throw new Error('Upload receipt finalization was not confirmed.');
  }
  async function enqueue(r: UploadReceipt, item: MediaItem, prior?: MediaItem | null): Promise<boolean> {
    assertWritable();
    await opts.media.setStatus(r.mediaKey, 'processing');
    try { opts.queue.enqueue(r.mediaKey); }
    catch (error) {
      if (!(error instanceof BacklogFullError)) throw error;
      // Preserve #348: a new key keeps original + failed/queue_full; general
      // prior failures retain their own state, inactive processing settles failed.
      const restorePrior = prior && prior.status !== 'processing' && !(prior.status === 'failed' && prior.error === 'queue_full');
      await opts.media.setStatusIfProcessing(r.mediaKey, restorePrior ? prior.status : 'failed', restorePrior ? prior.error ?? undefined : 'queue_full');
      await pending(r, true, 'queue_full');
      return false;
    }
    await accept(r, { ...item, status: 'processing' }, false,
      prior?.status === 'processing' || prior?.status === 'failed' && prior.error === 'queue_full');
    return true;
  }
  async function execute(r: UploadReceipt, input: UploadInput, exif: MediaExif): Promise<void> {
    await opts.queue.withAdmission(r.mediaKey, async () => {
      const currentReceipt = await opts.receipts.get(r.userId, r.uploadId);
      if (!currentReceipt || currentReceipt.state !== 'pending' || currentReceipt.claim !== r.claim) return;
      const existing = await opts.media.get(r.mediaKey);
      if (existing && !rowMatches(r, existing)) { await pending(r, false, 'recovery_required'); return; }
      if (existing?.status === 'ready') {
        if (await ready(r, existing)) await accept(r, existing, true);
        else await pending(r, false, 'recovery_required');
        return;
      }
      const before = await original(r);
      if (before === 'uncertain') { await pending(r, false, 'recovery_required'); return; }
      let item = existing;
      // A recovered (failed/missing) photo keeps its curated folder, or takes this
      // drop's folder while it is still in the root — the duplicate rule (#135, #348).
      if (item && item.folder === '' && r.identity.folder !== '') item = await opts.media.patch(r.mediaKey, { folder: r.identity.folder });
      if (!item) item = await opts.media.upsert({ key: r.mediaKey, title: r.identity.title, folder: r.identity.folder,
        alt: { de: r.identity.alt, en: r.identity.alt }, width: r.frozen.width, height: r.frozen.height,
        origBytes: r.frozen.bytes, status: 'processing', exif, uploadedBy: r.userId,
        encoding: r.frozen.encoding, ...(r.frozen.format ? { format: r.frozen.format } : {}) });
      if (before !== 'matching') {
        try { await storeOriginal(r.mediaKey, input.bytes, r.frozen.ext, { storageDir: opts.storageDir, isWritable: opts.isWritable, signal: opts.signal }); }
        catch {
          const after = await original(r);
          if (after === 'absent' && !opts.queue.isActive(r.mediaKey)) {
            await opts.media.setStatusIfProcessing(r.mediaKey, 'failed', 'write_failed');
            await replace(r, { state: 'retryable', generation: r.generation + 1, originalRetained: false });
          } else await pending(r, after === 'matching', 'recovery_required');
          return;
        }
      }
      if (opts.queue.isActive(r.mediaKey)) { await accept(r, { ...item, status: 'processing' }, false, true); return; }
      await enqueue(r, item, existing);
    });
  }
  async function recoverOne(candidate: UploadReceipt): Promise<'accepted' | 'retryable' | null> {
    const key = token(candidate.userId, candidate.uploadId);
    if (active.has(key)) return null;
    return exclusive(key, () => opts.queue.withAdmission(candidate.mediaKey, async (): Promise<'accepted' | 'retryable' | null> => {
      let r = await opts.receipts.get(candidate.userId, candidate.uploadId);
      if (!r || r.state !== 'pending') return null;
      // The lifetime filesystem owner positively excludes previous incarnations.
      r = await replace(r, { incarnation, claim: randomUUID() });
      const item = await opts.media.get(r.mediaKey);
      if (item && !rowMatches(r, item)) { await pending(r, false, 'recovery_required'); return null; }
      if (item && await ready(r, item)) { await accept(r, item, false); return 'accepted'; }
      const evidence = await original(r);
      if (evidence === 'absent' && !opts.queue.isActive(r.mediaKey)) {
        await opts.media.setStatusIfProcessing(r.mediaKey, 'failed', 'write_failed');
        await replace(r, { state: 'retryable', generation: r.generation + 1, originalRetained: false });
        return 'retryable';
      }
      if (evidence !== 'matching' || !item) { await pending(r, evidence === 'matching', 'recovery_required'); return null; }
      if (opts.queue.isActive(r.mediaKey)) { await accept(r, { ...item, status: 'processing' }, false); return 'accepted'; }
      return await enqueue(r, item, item) ? 'accepted' : null;
    }));
  }
  async function page(): Promise<UploadRecoveryReport> {
    assertWritable();
    blockedPass = false;
    const rows = await opts.receipts.pending(cursor, 100);
    let accepted = 0;
    let retryable = 0;
    let examined = 0;
    for (const r of rows) {
      cursor = { userId: r.userId, uploadId: r.uploadId };
      examined++;
      try {
        const outcome = await recoverOne(r);
        if (outcome === 'accepted') accepted++;
        else if (outcome === 'retryable') retryable++;
        else if ((await opts.receipts.get(r.userId, r.uploadId))?.reason === 'recovery_required') { blockedPass = true; break; }
      } catch { blockedPass = true; break; } // Explicit Rescan owns unavailable DB/disk/finalization recovery.
      if (opts.queue.availableCapacity() === 0) break;
    }
    if (rows.length === 0 || examined === rows.length && rows.length < 100) cursor = null;
    const counts = await opts.receipts.counts();
    return { ...counts, examined, accepted, retryable, continuationAvailable: counts.pending > 0 };
  }
  function trigger(): void {
    if (stopped || !opts.isWritable()) return;
    if (running) { wakeup = true; return; }
    void recover().catch(() => {});
  }
  function recover(): Promise<UploadRecoveryReport> {
    if (running) { wakeup = true; return running; }
    const pass = page();
    running = pass;
    void pass.then(async (report) => {
      running = undefined;
      const next = !blockedPass && (wakeup || report.continuationAvailable && (report.accepted + report.retryable > 0 || cursor !== null));
      wakeup = false;
      if (next && !stopped && opts.isWritable() && opts.queue.availableCapacity() > 0) { await yieldTurn(); trigger(); }
    }, () => { running = undefined; wakeup = false; });
    return pass;
  }
  const stop = () => { stopped = true; wakeup = false; unsubscribe?.(); };
  opts.signal?.addEventListener('abort', stop, { once: true });
  return {
    async upload(input) {
      assertWritable();
      if (!UPLOAD_UUID_RE.test(input.uploadId) || !UPLOAD_UUID_RE.test(input.userId) || !Number.isSafeInteger(input.retryGeneration) || input.retryGeneration < 0) return { statusCode: 400, body: { code: 'invalid_upload_identity' } };
      const identity = identityOf(input);
      try { assertSafeFolder(identity.folder); } catch { return { statusCode: 400, body: { error: 'invalid folder' } }; }
      const hash = digest(input.bytes);
      const key = token(input.userId, input.uploadId);
      if (active.has(key)) {
        const current = await opts.receipts.get(input.userId, input.uploadId);
        if (current && (current.sha256 !== hash || !sameIdentity(current.identity, identity))) return { statusCode: 409, body: { code: 'upload_id_reused' } };
        if (current && current.state !== 'gone' && current.generation !== input.retryGeneration) return { statusCode: 409, body: { code: 'upload_generation_changed', ...envelope(current) } };
        if (current?.state === 'accepted') return { statusCode: 200, body: { ...current.result, ...envelope(current) } };
        if (current?.state === 'gone') return { statusCode: 410, body: envelope(current) };
        return { statusCode: 202, body: { ownerUserId: input.userId, uploadId: input.uploadId,
          state: 'pending', originalRetained: current?.originalRetained ?? false } };
      }
      return exclusive(key, async () => {
        let probe: ImageProbe | undefined;
        let r = await opts.receipts.get(input.userId, input.uploadId);
        if (r) {
          if (r.sha256 !== hash || !sameIdentity(r.identity, identity)) return { statusCode: 409, body: { code: 'upload_id_reused' } };
          if (r.state === 'gone') return { statusCode: 410, body: envelope(r) };
          if (r.generation !== input.retryGeneration) return { statusCode: 409, body: { code: 'upload_generation_changed', ...envelope(r) } };
          if (r.state === 'accepted') return { statusCode: 200, body: { ...r.result, ...envelope(r) } };
          if (r.state === 'pending') return { statusCode: 202, body: envelope(r) };
          r = await replace(r, { state: 'pending', incarnation, claim: randomUUID(), reason: null });
        } else {
          if (input.retryGeneration !== 0) return { statusCode: 409, body: { code: 'upload_generation_changed' } };
          const { avifQuality, webpQuality, convertJpeg } = opts.settings.get();
          const encoding = normalizeProcessOptions({ avifQuality, webpQuality, convertJpeg });
          const baseKey = identity.key || libraryKey(identity.filename, new Date());
          const mediaKey = contentHashKey(baseKey, input.bytes, encoding);
          try {
            assertSafeKey(mediaKey);
            probe = await probeImage(input.bytes);
          } catch { return { statusCode: 400, body: { error: 'invalid key or image' } }; }
          if (!probe.width || !probe.height) return { statusCode: 400, body: { error: 'could not read that image' } };
          r = await opts.receipts.insert({ userId: input.userId, uploadId: input.uploadId, mediaKey, sha256: hash, identity,
            frozen: { baseKey, encoding, ext: probe.ext, width: probe.width, height: probe.height, bytes: input.bytes.length, format: outputFormatForExtension(probe.ext, encoding) },
            state: 'pending', incarnation, claim: randomUUID(), generation: 0, reason: null, originalRetained: false, result: null });
        }
        probe ??= await probeImage(input.bytes);
        await execute(r, input, parseExif(probe.exif));
        const saved = await opts.receipts.get(input.userId, input.uploadId);
        if (!saved) throw new Error('Upload receipt unavailable.');
        if (saved.state === 'accepted') return { statusCode: 200, body: { ...saved.result, ...envelope(saved) } };
        return { statusCode: saved.reason === 'queue_full' ? 429 : 202, body: envelope(saved) };
      });
    },
    async get(userId, uploadId) { const r = await opts.receipts.get(userId, uploadId); return r ? envelope(r) : null; },
    async start() {
      assertWritable();
      // Exactly one startup page. Follow-on events are coalesced, not a boot loop.
      unsubscribe = opts.queue.onCapacity(trigger);
      const first = page();
      running = first;
      let report: UploadRecoveryReport | undefined;
      try { report = await first; return report; }
      finally {
        running = undefined;
        const next = !blockedPass && (wakeup || report?.continuationAvailable && (report.accepted + report.retryable > 0 || cursor !== null));
        wakeup = false;
        if (next && opts.queue.availableCapacity() > 0) { await yieldTurn(); trigger(); }
      }
    },
    recover,
    async quiesce() {
      stop();
      await Promise.allSettled([...active.values(), ...(running ? [running] : [])]);
    },
    removeMedia: (key, remove) => opts.receipts.removeMedia(key, remove),
  };
}
