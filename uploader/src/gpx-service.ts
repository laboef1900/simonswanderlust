import { randomBytes, randomUUID } from 'node:crypto';
import type { DbPool } from './db.js';
import { GPX_LIMITS, validateGeometry, type PrivateGeometry, type TrimSelection } from '../public/gpx-geometry.js';
import type { GpxPreview } from './gpx-parser.js';
import { GpxError } from './gpx-errors.js';
import type { GpxWorker } from './gpx-worker.js';
import { sourceDigest, type GpxFiles, type OriginalSource } from './gpx-files.js';
import { GpxCommitUnknownError, pgGpxStore, type PrivateRouteRecord, type RouteTokens } from './gpx-store.js';

const HOUR = 60 * 60 * 1000;
export interface RouteState { version: string | null; geometry: PrivateGeometry | null; originalAvailable: boolean; sourceBytes: number | null }
export interface RouteMutation extends RouteState { updatedAt: string; cleanupPending: boolean }
export interface ImportPreview extends GpxPreview { importId: string; expiresAt: string }
export interface AttachRouteInput extends RouteTokens { importId: string; selection: TrimSelection; confirmReplace: boolean }
export interface OrphanCleanupState { status: 'ready' | 'blocked'; reason: null | 'manifest_unreadable'; deferredOriginals: number | null }
export interface ReconcileResult { skipped: boolean; cleanupPending: boolean }
export interface GpxService {
  readonly files: GpxFiles;
  get(tk: string): Promise<RouteState>;
  original(tk: string): Promise<Buffer>;
  importBytes(author: string, bytes: Uint8Array, signal?: AbortSignal): Promise<ImportPreview>;
  importUpload(author: string, load: (signal: AbortSignal) => Promise<Uint8Array>, signal?: AbortSignal): Promise<ImportPreview>;
  reimport(author: string, tk: string, signal?: AbortSignal): Promise<ImportPreview>;
  cancel(author: string, id: string): Promise<void>;
  attach(author: string, tk: string, input: AttachRouteInput, signal?: AbortSignal): Promise<RouteMutation>;
  detach(tk: string, input: RouteTokens): Promise<RouteMutation>;
  reconcile(): Promise<ReconcileResult>;
  orphanCleanup(): OrphanCleanupState;
  close(): Promise<void>;
}
interface PendingImport { author: string; expires: number; bytes: number; digest: string; cancelled: boolean; busy: boolean; timer: NodeJS.Timeout; abort?: () => void }

export function createGpxService({ pool, files, worker, backupDir: _backupDir, isWritable = () => true, readManifestPins }: {
  pool: DbPool; files: GpxFiles; worker: GpxWorker; backupDir: string; isWritable?: () => boolean;
  readManifestPins: () => Promise<ReadonlySet<string>>;
}): GpxService {
  const store = pgGpxStore(pool);
  const pending = new Map<string, PendingImport>();
  const admissions = new Map<symbol, { author: string; controller: AbortController }>();
  const active = new Set<AbortController>();
  const completions = new Set<Promise<void>>();
  let admissionHeld = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let cleanupState: OrphanCleanupState = { status: 'ready', reason: null, deferredOriginals: 0 };
  const writable = () => { if (closed || !isWritable()) throw new GpxError('storage_read_only', 503); };
  const allowed = () => !closed && isWritable();
  const sweepTimer = setInterval(() => { void reconcile().catch(() => {}); }, 60_000);
  sweepTimer.unref();

  function operation(signal?: AbortSignal) {
    writable();
    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    completions.add(completion.promise);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    return { signal: controller.signal, abort, finish() {
      signal?.removeEventListener('abort', abort); active.delete(controller);
      completions.delete(completion.promise); completion.resolve();
    } };
  }
  function staged(author: string, id: string): PendingImport {
    const entry = pending.get(id);
    if (!entry || entry.author !== author || entry.cancelled || Date.now() >= entry.expires) throw new GpxError('gpx_import_unavailable', 404);
    return entry;
  }
  async function state(row: PrivateRouteRecord | null): Promise<RouteState> {
    if (!row) return { version: null, geometry: null, originalAvailable: false, sourceBytes: null };
    const inspected = await files.inspectOriginal(row.source);
    return { version: row.version, geometry: row.geometry, originalAvailable: inspected.state === 'present', sourceBytes: row.source.bytes };
  }
  async function original(tk: string): Promise<Buffer> {
    const row = await store.get(tk);
    if (!row) throw new GpxError('gpx_original_unavailable', 404);
    const inspected = await files.inspectOriginal(row.source);
    if (inspected.state !== 'present' || !inspected.bytes) throw new GpxError('gpx_original_unavailable', 409);
    return inspected.bytes;
  }
  async function importUpload(author: string, load: (signal: AbortSignal) => Promise<Uint8Array>, signal?: AbortSignal): Promise<ImportPreview> {
    writable();
    // Admission is deliberately not the file gate: backup capture must not queue uploads.
    if (admissionHeld) throw new GpxError('gpx_busy', 429);
    admissionHeld = true;
    const key = Symbol();
    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    completions.add(completion.promise);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 15_000); timeout.unref();
    admissions.set(key, { author, controller });
    let writtenId: string | undefined;
    try {
      await reconcile();
      const inventory = await files.listPending();
      const own = inventory.filter((item) => pending.get(item.id)?.author === author).length;
      if (own >= 2 || inventory.length >= 10 || inventory.reduce((sum, item) => sum + item.bytes, 0) + GPX_LIMITS.fileBytes > 50 * 1024 * 1024) throw new GpxError('gpx_quota', 429);
      const bytes = await load(controller.signal);
      if (controller.signal.aborted) throw new GpxError('gpx_aborted', 499);
      if (bytes.byteLength < 1 || bytes.byteLength > GPX_LIMITS.fileBytes) throw new GpxError('gpx_too_large', 413);
      clearTimeout(timeout);
      const preview = await worker.parse(bytes, { signal: controller.signal });
      writable();
      if (controller.signal.aborted) throw new GpxError('gpx_aborted', 499);
      const importId = randomBytes(32).toString('hex');
      const expires = Date.now() + HOUR;
      // Worker owns a transferred copy; original request bytes remain available for staging.
      await files.writePending(importId, bytes);
      writtenId = importId;
      if (controller.signal.aborted || !allowed()) throw new GpxError('gpx_aborted', 499);
      const timer = setTimeout(() => { void reconcile().catch(() => {}); }, HOUR); timer.unref();
      pending.set(importId, { author, expires, bytes: bytes.byteLength, digest: sourceDigest(bytes), cancelled: false, busy: false, timer });
      return { ...preview, importId, expiresAt: new Date(expires).toISOString() };
    } catch (error) {
      if (writtenId && allowed()) await files.removePending(writtenId).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      admissions.delete(key); admissionHeld = false;
      completions.delete(completion.promise); completion.resolve();
    }
  }
  async function cleanupIntents(): Promise<boolean> {
    let failed = false;
    for (const intent of await store.cleanupIntents()) {
      writable();
      if (await store.isReferenced(intent.sourceId)) continue;
      try { await files.removeStoredOriginal(intent); await store.removeCleanupIntent(intent.sourceId); }
      catch { failed = true; }
    }
    return failed;
  }
  async function reconcile(): Promise<ReconcileResult> {
    if (!allowed()) return { skipped: true, cleanupPending: true };
    const result = await files.gate.tryRunExclusive(async () => {
      let cleanupPending = false;
      // Pending previews are not backups and do not depend on trustworthy manifests.
      try {
        await files.cleanupTemporaryFiles('pending');
        for (const item of await files.listPending()) {
          if (item.temporary) continue;
          const entry = pending.get(item.id);
          if (entry?.busy) continue;
          if (entry ? !entry.cancelled && Date.now() < entry.expires : Date.now() - item.mtimeMs < HOUR) continue;
          try {
            await files.removePending(item.id);
            if (entry) clearTimeout(entry.timer);
            pending.delete(item.id);
          } catch { cleanupPending = true; }
        }
      } catch { cleanupPending = true; }
      // Any DB failure stops all original deletion, including independently authorized intents.
      await store.removeOrphanRows(allowed);
      try { await files.cleanupTemporaryFiles('originals'); } catch { cleanupPending = true; }
      cleanupPending = await cleanupIntents() || cleanupPending;
      let pins: ReadonlySet<string>;
      try {
        pins = await readManifestPins();
      } catch {
        cleanupState = { status: 'blocked', reason: 'manifest_unreadable', deferredOriginals: null };
        return { skipped: false, cleanupPending: true };
      }
      let deferredOriginals = 0;
      try {
        for (const source of await files.listOriginals()) {
          if (Date.now() - source.mtimeMs < HOUR || await store.isReferenced(source.sourceId)) continue;
          if (pins.has(source.sourceId)) { deferredOriginals++; continue; }
          writable();
          try { await files.removeStoredOriginal(source); } catch { cleanupPending = true; }
        }
        cleanupState = { status: 'ready', reason: null, deferredOriginals };
      } catch {
        cleanupState = { status: 'blocked', reason: 'manifest_unreadable', deferredOriginals: null };
        cleanupPending = true;
      }
      return { skipped: false, cleanupPending };
    });
    return result.acquired ? result.value : { skipped: true, cleanupPending: true };
  }
  return {
    files,
    get: async (tk) => state(await store.get(tk)),
    original: (tk) => files.gate.runExclusive(() => original(tk)),
    importUpload,
    importBytes: (author, bytes, signal) => importUpload(author, async () => bytes, signal),
    reimport: (author, tk, signal) => importUpload(author, async () => files.gate.runExclusive(() => original(tk)), signal),
    async cancel(author, id) {
      writable();
      const entry = pending.get(id);
      if (!entry || entry.author !== author) return;
      entry.cancelled = true;
      entry.abort?.();
      clearTimeout(entry.timer);
      const result = await files.gate.tryRunExclusive(async () => {
        if (entry.busy) return false;
        try { await files.removePending(id); pending.delete(id); return true; }
        catch { throw new GpxError('gpx_cleanup_pending', 503); }
      });
      if (!result.acquired || !result.value) throw new GpxError('gpx_cleanup_pending', 503);
    },
    async attach(author, tk, input, signal) {
      const entry = staged(author, input.importId);
      const op = operation(signal);
      if (entry.busy) { op.finish(); throw new GpxError('gpx_busy', 429); }
      entry.busy = true;
      entry.abort = op.abort;
      try {
        const bytes = await files.readPending(input.importId);
        if (bytes.length !== entry.bytes || sourceDigest(bytes) !== entry.digest) throw new GpxError('gpx_import_unavailable', 409);
        const preview = await worker.parse(bytes, { signal: op.signal, selection: input.selection });
        validateGeometry(preview.geometry);
        return await files.gate.runExclusive(async () => {
          writable(); staged(author, input.importId);
          if (op.signal.aborted) throw new GpxError('gpx_aborted', 499);
          const source: OriginalSource = { translationKey: tk, sourceId: randomUUID(), sha256: entry.digest, bytes: entry.bytes };
          await files.writeOriginal(source, bytes);
          let saved: PrivateRouteRecord;
          try {
            saved = await store.attach(tk, input, preview.geometry, source, input.confirmReplace, () => {
              writable(); staged(author, input.importId);
              if (op.signal.aborted) throw new GpxError('gpx_aborted', 499);
              return true;
            });
          }
          catch (error) {
            if (!(error instanceof GpxCommitUnknownError) && allowed()) {
              // A fresh check is mandatory even after a definite rollback.
              try { if (!await store.isReferenced(source.sourceId)) await files.removeOriginal(source); } catch { /* Reconcile after grace. */ }
            }
            throw error;
          }
          let cleanupPending = false;
          entry.cancelled = true; clearTimeout(entry.timer);
          try { await files.removePending(input.importId); pending.delete(input.importId); } catch { cleanupPending = true; }
          try { cleanupPending = await cleanupIntents() || cleanupPending; } catch { cleanupPending = true; }
          return { ...await state(saved), updatedAt: saved.updatedAt.toISOString(), cleanupPending };
        });
      } finally { entry.busy = false; delete entry.abort; op.finish(); }
    },
    async detach(tk, input) {
      writable();
      return files.gate.runExclusive(async () => {
        const saved = await store.detach(tk, input, allowed);
        return { ...await state(saved), updatedAt: saved.updatedAt.toISOString(), cleanupPending: false };
      });
    },
    reconcile,
    orphanCleanup: () => ({ ...cleanupState }),
    close() {
      if (closing) return closing;
      closed = true; clearInterval(sweepTimer);
      for (const entry of pending.values()) clearTimeout(entry.timer);
      for (const { controller } of admissions.values()) controller.abort();
      for (const controller of active) controller.abort();
      closing = (async () => {
        await worker.close();
        await Promise.all(completions);
        // Wait for file-gated operations to observe the latched state before pool drain.
        await files.gate.runExclusive(async () => {});
      })();
      return closing;
    },
  };
}
