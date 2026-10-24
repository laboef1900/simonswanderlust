import { setTimeout as sleep } from 'node:timers/promises';
import { StorageReadOnlyError } from './storage-owner.js';

/** Optional for standalone tools; production always supplies the storage lease. */
export interface WorkCancellationOptions {
  signal?: AbortSignal;
  isWritable?: () => boolean;
}

export function isWorkWritable(opts: WorkCancellationOptions): boolean {
  return !opts.signal?.aborted && (opts.isWritable?.() ?? true);
}

export function assertWorkWritable(opts: WorkCancellationOptions): void {
  if (!isWorkWritable(opts)) throw new StorageReadOnlyError();
}

/** A local, one-way stop combined with the process-wide lease loss. */
export function createWorkCancellation(opts: WorkCancellationOptions) {
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const boundary = { signal, isWritable: opts.isWritable };
  return {
    signal,
    isWritable: () => isWorkWritable(boundary),
    assertWritable: () => assertWorkWritable(boundary),
    stop: () => controller.abort(),
  };
}

/** Cancel only a wait, never detach mutating work from its quiescence promise. */
export async function cancellableSleep(ms: number, opts: WorkCancellationOptions, custom?: (ms: number) => Promise<void>): Promise<void> {
  assertWorkWritable(opts);
  if (!custom) {
    await sleep(ms, undefined, { signal: opts.signal, ref: false });
  } else if (!opts.signal) {
    await custom(ms);
  } else {
    const signal = opts.signal;
    const { promise: cancelled, reject } = Promise.withResolvers<never>();
    const abort = () => reject(new StorageReadOnlyError());
    signal.addEventListener('abort', abort, { once: true });
    try { await Promise.race([custom(ms), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  assertWorkWritable(opts);
}
