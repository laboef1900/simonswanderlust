import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUploadService, type UploadInput } from '../src/upload-service.js';
import { memoryUploadReceiptStore, type UploadReceiptStore } from '../src/upload-receipts.js';
import { memoryMediaStore } from '../src/media-store.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { createWorkLock } from '../src/work-lock.js';
import { defaultSettings, validate, type SettingsStore } from '../src/settings.js';
import { formatsFor, variantWidths } from '../src/variants.js';
import * as storage from '../src/storage.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const clean of cleanups.splice(0).reverse()) await clean(); });
function deferred() { const { promise, resolve } = Promise.withResolvers<void>(); return { promise, release: resolve }; }
async function fixture(options: { blocked?: boolean; receipts?: UploadReceiptStore; maxBacklog?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-upload-'));
  const media = memoryMediaStore({ baseUrl: 'https://images.test' });
  const receipts = options.receipts ?? memoryUploadReceiptStore();
  let settings = defaultSettings();
  const store: SettingsStore = { get: () => ({ ...settings }), update: patch => (settings = validate({ ...settings, ...patch })) };
  const gate = deferred(); if (!options.blocked) gate.release();
  const encoded: string[] = [];
  const queue = createEncodeQueue({ store: media, storageDir: dir, lock: createWorkLock(), concurrency: 1,
    maxBacklog: options.maxBacklog ?? 1, canRecover: async key => !await receipts.hasPendingMedia(key),
    encodeOne: async key => {
      await gate.promise; encoded.push(key);
      const item = (await media.get(key))!;
      await mkdir(dirname(join(dir, key)), { recursive: true });
      for (const width of variantWidths(item.width)) for (const format of formatsFor(item.format)) await writeFile(join(dir, `${key}-${width}.${format}`), 'encoded-test-variant');
      return { bytes: 20 };
    } });
  const service = createUploadService({ receipts, media, queue, storageDir: dir, baseUrl: 'https://images.test', settings: store, isWritable: () => true });
  cleanups.push(async () => { gate.release(); await service.quiesce(); await queue.quiesce(); await rm(dir, { recursive: true, force: true }); });
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  const userId = randomUUID();
  const input = (key = 'trips/test/photo'): UploadInput => ({ userId, uploadId: randomUUID(), retryGeneration: 0, bytes, key, filename: 'photo.jpg', title: 'Title', alt: 'View', folder: '' });
  return { service, receipts, media, queue, encoded, dir, gate, input, store };
}

describe('durable upload receipts', () => {
  it('answers a lost accepted response without re-enqueue, metadata mutation or re-deriving profile/year', async () => {
    const f = await fixture(); const input = f.input();
    const first = await f.service.upload(input); await f.queue.idle();
    expect(first.body.state).toBe('accepted');
    const key = String(first.body.key);
    await f.media.patch(key, { title: 'Author changed title', folder: 'Curated' });
    f.store.update({ webpQuality: 67 });
    const repeated = await f.service.upload(input);
    expect(repeated.body).toEqual(first.body); expect(f.encoded).toEqual([key]);
    expect(await f.media.get(key)).toMatchObject({ title: 'Author changed title', folder: 'Curated' });
    expect(await f.service.get(input.userId, input.uploadId)).toMatchObject({ state: 'accepted', result: { key } });
    expect(await f.service.get(randomUUID(), input.uploadId)).toBeNull();
  });
  it('serializes distinct receipt identities for the same active media key and refuses identity reuse', async () => {
    const f = await fixture({ blocked: true }); const input = f.input();
    const [a, b] = await Promise.all([f.service.upload(input), f.service.upload({ ...input, uploadId: randomUUID() })]);
    expect(a.body.key).toBe(b.body.key); expect(a.body.state).toBe('accepted'); expect(b.body.state).toBe('accepted');
    expect(f.queue.stats()).toEqual({ running: 1, pending: 0 });
    expect((await f.service.upload({ ...input, title: 'Different request' })).body).toMatchObject({ code: 'upload_id_reused' });
    expect((await f.service.upload({ ...input, bytes: Buffer.from('different bytes') })).body).toMatchObject({ code: 'upload_id_reused' });
    f.gate.release(); await f.queue.idle(); expect(f.encoded).toHaveLength(1);
  });
  it('retains queue-full originals and finalizes them after capacity drains without retransmission', async () => {
    const f = await fixture({ blocked: true }); await f.service.start();
    await f.service.upload(f.input('trips/test/first'));
    await f.service.upload(f.input('trips/test/second'));
    const third = f.input('trips/test/third');
    const result = await f.service.upload(third);
    expect(result.statusCode).toBe(429); expect(result.body).toMatchObject({ state: 'pending', reason: 'queue_full', originalRetained: true });
    const receipt = (await f.receipts.get(third.userId, third.uploadId))!;
    expect(await f.media.get(receipt.mediaKey)).toMatchObject({ status: 'failed', error: 'queue_full' });
    expect(await readFile(join(f.dir, `${receipt.mediaKey}-orig.${receipt.frozen.ext}`))).toEqual(third.bytes);
    for (let i = 0; i < 3; i++) await f.service.get(third.userId, third.uploadId);
    expect(f.queue.stats()).toEqual({ running: 1, pending: 1 });
    const recovered = deferred(); const accept = f.receipts.accept.bind(f.receipts);
    vi.spyOn(f.receipts, 'accept').mockImplementation(async (...args) => {
      const accepted = await accept(...args);
      if (accepted && args[0].uploadId === third.uploadId) recovered.release();
      return accepted;
    });
    f.gate.release();
    await recovered.promise;
    expect(await f.service.get(third.userId, third.uploadId)).toMatchObject({ state: 'accepted' });
    await f.queue.idle(); expect(f.encoded.filter(k => k === receipt.mediaKey)).toHaveLength(1);
  });
  it('makes deletion terminal for all receipts and never resurrects the media row', async () => {
    const f = await fixture(); const input = f.input(); const result = await f.service.upload(input); await f.queue.idle();
    const key = String(result.body.key);
    await f.queue.withAdmission(key, () => f.service.removeMedia(key, client => f.media.remove(key, client)));
    expect(await f.service.get(input.userId, input.uploadId)).toMatchObject({ state: 'gone' });
    expect((await f.service.upload(input)).statusCode).toBe(410);
    expect(await f.media.get(key)).toBeNull();
  });
  it('keeps an issued write owned while receipt finalization is delayed and GET remains inert', async () => {
    const receipts = memoryUploadReceiptStore(); const finalize = receipts.accept.bind(receipts); const gate = deferred(); const finalizing = deferred();
    receipts.accept = async (...args) => { finalizing.release(); await gate.promise; return finalize(...args); };
    const f = await fixture({ receipts }); const input = f.input(); const pending = f.service.upload(input);
    cleanups.push(async () => { gate.release(); await pending.catch(() => {}); });
    await finalizing.promise;
    expect((await f.service.get(input.userId, input.uploadId))?.state).toBe('pending');
    const recovery = await f.service.recover(); expect(recovery.accepted).toBe(0);
    expect((await f.service.get(input.userId, input.uploadId))?.state).toBe('pending');
    gate.release(); expect((await pending).body.state).toBe('accepted');
  });
  it('recovers a finalization failure through explicit Rescan without reapplying request metadata', async () => {
    const receipts = memoryUploadReceiptStore(); const accept = receipts.accept.bind(receipts); let unavailable = true;
    receipts.accept = async (...args) => { if (unavailable) throw new Error('database unavailable'); return accept(...args); };
    const f = await fixture({ receipts }); const input = f.input();
    await expect(f.service.upload(input)).rejects.toThrow('database unavailable'); await f.queue.idle();
    const receipt = (await receipts.get(input.userId, input.uploadId))!;
    await f.media.patch(receipt.mediaKey, { title: 'Later author title' });
    unavailable = false; await f.service.recover();
    expect((await f.service.get(input.userId, input.uploadId))?.state).toBe('accepted');
    expect(await f.media.get(receipt.mediaKey)).toMatchObject({ title: 'Later author title' }); expect(f.encoded).toHaveLength(1);
  });
  it('authorizes a new retry generation only after positive absence and rejects a late initial request', async () => {
    const f = await fixture(); const input = f.input();
    const originalUpsert = f.media.upsert.bind(f.media);
    f.media.upsert = async () => { throw new Error('crashed before media creation'); };
    await expect(f.service.upload(input)).rejects.toThrow('crashed before media creation');
    f.media.upsert = originalUpsert;
    await f.service.recover();
    expect(await f.service.get(input.userId, input.uploadId)).toMatchObject({ state: 'retryable', retryGeneration: 1 });
    expect((await f.service.upload(input)).body).toMatchObject({ code: 'upload_generation_changed' });
    expect((await f.service.upload({ ...input, retryGeneration: 1 })).body.state).toBe('accepted');
    expect((await f.service.upload(input)).body).toMatchObject({ code: 'upload_generation_changed' });
  });
  it('settles a failed original write as retryable only after proving no complete original or job exists', async () => {
    const f = await fixture(); const input = f.input();
    vi.spyOn(storage, 'storeOriginal').mockRejectedValueOnce(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
    const outcome = await f.service.upload(input);
    expect(outcome.body).toMatchObject({ state: 'retryable', retryGeneration: 1 });
    expect(f.queue.stats()).toEqual({ running: 0, pending: 0 });
    expect((await f.service.upload(input)).body).toMatchObject({ code: 'upload_generation_changed' });
  });
  it('keeps a corrupt retained original pending, never authorizing blind retransmission', async () => {
    const f = await fixture({ blocked: true }); await f.service.upload(f.input('trips/test/first'));
    await f.service.upload(f.input('trips/test/second'));
    const input = f.input('trips/test/corrupt'); await f.service.upload(input);
    const receipt = (await f.receipts.get(input.userId, input.uploadId))!;
    await writeFile(join(f.dir, `${receipt.mediaKey}-orig.${receipt.frozen.ext}`), 'incomplete');
    await f.service.recover();
    expect(await f.service.get(input.userId, input.uploadId)).toMatchObject({ state: 'pending', reason: 'recovery_required' });
    expect((await f.service.upload(input)).statusCode).toBe(202);
    expect(f.queue.stats()).toEqual({ running: 1, pending: 1 });
  });
  it('recognizes a matching complete ready image without requiring its removed original', async () => {
    const f = await fixture(); const input = f.input(); await f.service.upload(input); await f.queue.idle();
    const receipt = (await f.receipts.get(input.userId, input.uploadId))!;
    await rm(join(f.dir, `${receipt.mediaKey}-orig.${receipt.frozen.ext}`));
    const pending = { ...receipt, uploadId: randomUUID(), state: 'pending' as const, result: null, claim: randomUUID() };
    await f.receipts.insert(pending);
    expect(await f.service.recover()).toMatchObject({ accepted: 1, retryable: 0 });
    expect((await f.service.get(pending.userId, pending.uploadId))?.state).toBe('accepted');
    expect(f.encoded).toEqual([receipt.mediaKey]);
  });
  it('continues beyond a bounded startup page instead of stranding the 101st retained receipt', async () => {
    const f = await fixture({ maxBacklog: 200 }); const input = f.input(); const result = await f.service.upload(input); await f.queue.idle();
    const receipt = (await f.receipts.get(input.userId, input.uploadId))!;
    for (let i = 0; i < 105; i++) await f.receipts.insert({ ...receipt, uploadId: randomUUID(), state: 'pending', result: null, claim: randomUUID() });
    const get = vi.spyOn(f.receipts, 'pending');
    // Observe completed receipt writes: event-loop turns do not bound the real
    // filesystem reads performed by each recovery pass.
    const recovered = deferred(); const accept = f.receipts.accept.bind(f.receipts);
    vi.spyOn(f.receipts, 'accept').mockImplementation(async (...args) => {
      const accepted = await accept(...args);
      if ((await f.receipts.counts()).pending === 0) recovered.release();
      return accepted;
    });
    const first = await f.service.start(); expect(first.examined).toBeLessThanOrEqual(100);
    await recovered.promise;
    expect(await f.receipts.counts()).toEqual({ pending: 0, blocked: 0 });
    expect(get.mock.calls.every(([, limit]) => limit === 100)).toBe(true);
    expect(f.encoded).toEqual([String(result.body.key)]);
  });
  it('advances explicit Rescan past a blocked receipt instead of starving later identities', async () => {
    const f = await fixture(); const input = f.input(); await f.service.upload(input); await f.queue.idle();
    const receipt = (await f.receipts.get(input.userId, input.uploadId))!;
    const blocked = { ...receipt, uploadId: '00000000-0000-4000-8000-000000000001', state: 'pending' as const,
      result: null, claim: randomUUID(), frozen: { ...receipt.frozen, width: receipt.frozen.width + 1 } };
    const later = { ...receipt, uploadId: '00000000-0000-4000-8000-000000000002', state: 'pending' as const, result: null, claim: randomUUID() };
    await f.receipts.insert(blocked); await f.receipts.insert(later);
    expect(await f.service.start()).toMatchObject({ examined: 1, accepted: 0, blocked: 1, continuationAvailable: true });
    expect((await f.service.get(later.userId, later.uploadId))?.state).toBe('pending');
    expect(await f.service.recover()).toMatchObject({ accepted: 1 });
    expect((await f.service.get(later.userId, later.uploadId))?.state).toBe('accepted');
    expect(await f.service.get(blocked.userId, blocked.uploadId)).toMatchObject({ state: 'pending', reason: 'recovery_required' });
    expect(f.encoded).toEqual([receipt.mediaKey]);
  });
});
