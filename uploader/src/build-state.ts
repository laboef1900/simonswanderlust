import { constants } from 'node:fs';
import { open, mkdir, readdir, readlink, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ui } from '../../site/src/i18n/ui.js';
import { assertWorkWritable, isWorkWritable, type WorkCancellationOptions } from './work-cancellation.js';

export type BuildTrigger = 'publish' | 'bulk' | 'unpublish' | 'delete' | 'page' | 'rebuild' | 'boot';
export type BuildFailureCode = 'build_timeout' | 'build_failed' | 'build_unavailable' | 'no_space' | 'release_write_failed' | 'build_stopped' | 'internal';
export interface BuildReport {
  ok: boolean;
  attemptId: string | null;
  release?: string;
  liveRelease?: string | null;
  code?: BuildFailureCode;
  error?: string;
}
export interface LastBuildAttempt {
  attemptId: string;
  startedAt: string;
  finishedAt: string | null;
  result: 'succeeded' | 'failed' | 'interrupted';
  release: string | null;
  liveReleaseAfter?: string | null;
  failure: { code: BuildFailureCode; message: string } | null;
  triggers: BuildTrigger[];
  beforeBoot: boolean;
}
export interface BuildStatusResponse {
  live?: { release: string; stampedAt: string } | null;
  running: { attemptId: string; startedAt: string; queued: boolean; owner: 'this_process' | 'unverified' } | null;
  last: LastBuildAttempt | null;
  record: 'ok' | 'missing' | 'unreadable' | 'not_persisted';
}
interface RunningAttempt { attemptId: string; startedAt: string; triggers: BuildTrigger[] }
type StoredAttempt = Omit<LastBuildAttempt, 'beforeBoot'>;
interface BuildState { schema: 1; running: RunningAttempt | null; last: StoredAttempt | null }
const TRIGGERS: readonly BuildTrigger[] = ['boot', 'bulk', 'delete', 'page', 'publish', 'rebuild', 'unpublish'];
const CODES: readonly BuildFailureCode[] = ['build_timeout', 'build_failed', 'build_unavailable', 'no_space', 'release_write_failed', 'build_stopped', 'internal'];
const MAX_RECORD_BYTES = 64 * 1024;

export function buildFailureMessage(code: BuildFailureCode): string {
  return ui.en[`admin.build.failure.${code}`];
}

/** Deliberately project the public shape; internal causes never cross HTTP. */
export function projectBuildReport(outcome: BuildReport): BuildReport {
  return {
    ok: outcome.ok, attemptId: outcome.attemptId,
    ...(outcome.ok ? { release: outcome.release } : { code: outcome.code, error: buildFailureMessage(outcome.code ?? 'internal') }),
    ...(outcome.liveRelease !== undefined ? { liveRelease: outcome.liveRelease } : {}),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function stampedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{1,16}-\d{1,10}-\d{4,10}$/.test(value)) return undefined;
  const ms = Number(value.split('-')[0]);
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 8.64e15) return undefined;
  return new Date(ms).toISOString();
}
function triggers(value: unknown): value is BuildTrigger[] {
  return Array.isArray(value) && value.length > 0 && value.length <= TRIGGERS.length && value.every((item, index) => TRIGGERS.includes(item) && (index === 0 || value[index - 1] < item));
}
function running(value: unknown): value is RunningAttempt {
  return object(value) && keys(value, ['attemptId', 'startedAt', 'triggers']) && iso(value.startedAt) && stampedAt(value.attemptId) === value.startedAt && triggers(value.triggers);
}
function attempt(value: unknown): value is StoredAttempt {
  if (!object(value) || !keys(value, ['attemptId', 'startedAt', 'finishedAt', 'result', 'release', 'failure', 'triggers'], ['liveReleaseAfter'])) return false;
  if (!iso(value.startedAt) || stampedAt(value.attemptId) !== value.startedAt || !triggers(value.triggers)) return false;
  if (Object.hasOwn(value, 'liveReleaseAfter') && value.liveReleaseAfter !== null && !stampedAt(value.liveReleaseAfter)) return false;
  if (value.result === 'interrupted') return value.finishedAt === null && value.release === null && value.failure === null && !Object.hasOwn(value, 'liveReleaseAfter');
  if (!iso(value.finishedAt) || Date.parse(value.finishedAt) < Date.parse(value.startedAt)) return false;
  if (value.result === 'succeeded') return value.release === value.attemptId && value.failure === null;
  return value.result === 'failed' && value.release === null && object(value.failure) && keys(value.failure, ['code', 'message']) && CODES.includes(value.failure.code as BuildFailureCode) && typeof value.failure.message === 'string' && value.failure.message.length <= 1024;
}
function parseState(value: unknown): BuildState {
  if (!object(value) || !keys(value, ['schema', 'running', 'last']) || value.schema !== 1 || (value.running !== null && !running(value.running)) || (value.last !== null && !attempt(value.last))) throw new Error('Invalid build record');
  const state = value as unknown as BuildState;
  if (state.last?.failure) state.last.failure.message = buildFailureMessage(state.last.failure.code);
  return state;
}
function errno(error: unknown): unknown {
  return object(error) ? error.code : undefined;
}
function logRecord(error: unknown): void {
  try {
    const code = errno(error);
    const reason = typeof code === 'string' && ['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EDQUOT', 'EROFS', 'ELOOP', 'ENOENT', 'EEXIST', 'ENOTDIR'].includes(code) ? code : 'invalid_or_unavailable';
    console.error(`site build attempt record unavailable (${reason})`);
  } catch { /* Logging cannot change a promotion. */ }
}

/** Only a missing link means absent. Malformed/unreadable links stay unknown. */
export async function observeLiveRelease(root: string): Promise<BuildStatusResponse['live']> {
  try {
    const target = await readlink(join(root, 'current'));
    const absolute = resolve(root, target);
    const release = absolute.slice(absolute.lastIndexOf('/') + 1);
    const time = stampedAt(release);
    if (!time || absolute !== resolve(root, 'releases', release)) return undefined;
    return { release, stampedAt: time };
  } catch (error) {
    return errno(error) === 'ENOENT' ? null : undefined;
  }
}

/** Operational history, independent of both current and future release manifests. */
export function createBuildState(root: string, work: WorkCancellationOptions) {
  const path = join(root, 'build-state.json');
  const temp = `${path}.${process.pid}.tmp`;
  let state: BuildState = { schema: 1, running: null, last: null };
  let record: BuildStatusResponse['record'] = 'missing';
  let beforeBoot = false;
  let owner: 'this_process' | 'unverified' = 'this_process';
  let initialized: Promise<void> | undefined;
  const initialize = (): Promise<void> => initialized ??= (async () => {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error('Invalid build record size or type');
        const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = await file.read(bytes, count, bytes.length - count, null);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        if (count > MAX_RECORD_BYTES) throw new Error('Build record exceeds limit');
        state = parseState(JSON.parse(bytes.toString('utf8', 0, count)));
      } finally { await file.close(); }
      record = 'ok';
      beforeBoot = true;
      if (state.running) {
        if (isWorkWritable(work)) {
          state.last = { ...state.running, finishedAt: null, result: 'interrupted', release: null, failure: null };
          state.running = null;
        } else owner = 'unverified';
      }
    } catch (error) {
      state = { schema: 1, running: null, last: null };
      record = errno(error) === 'ENOENT' ? 'missing' : 'unreadable';
      if (record === 'unreadable') logRecord(error);
    }
  })();
  const persist = async (start: boolean): Promise<void> => {
    try {
      assertWorkWritable(work);
      await mkdir(root, { recursive: true });
      if (start) {
        for (const name of await readdir(root)) {
          if (/^build-state\.json\.\d+\.tmp$/.test(name)) {
            assertWorkWritable(work);
            await unlink(join(root, name));
          }
        }
      }
      assertWorkWritable(work);
      const file = await open(temp, 'wx', 0o600);
      try {
        assertWorkWritable(work);
        await file.writeFile(JSON.stringify(state));
        assertWorkWritable(work);
        await file.sync();
      } finally { await file.close(); }
      assertWorkWritable(work);
      await rename(temp, path);
      const directory = await open(root, constants.O_RDONLY);
      try { assertWorkWritable(work); await directory.sync(); }
      finally { await directory.close(); }
      record = 'ok';
    } catch (error) {
      record = 'not_persisted';
      logRecord(error);
      // Never admit even a cleanup write after ownership loss/shutdown.
      if (isWorkWritable(work)) {
        try { assertWorkWritable(work); await unlink(temp); } catch { /* next start sweeps it */ }
      }
      if (start && isWorkWritable(work)) {
        try { assertWorkWritable(work); await unlink(path); } catch { /* accepted stale-record residual */ }
      }
    }
  };
  return {
    initialize,
    async start(value: RunningAttempt) {
      await initialize();
      state.running = { ...value, triggers: [...value.triggers] };
      owner = 'this_process';
      await persist(true);
    },
    async finish(value: StoredAttempt) {
      state.running = null;
      state.last = value;
      beforeBoot = false;
      await persist(false);
    },
    async status(queued: boolean): Promise<BuildStatusResponse> {
      await initialize();
      const live = await observeLiveRelease(root);
      return {
        ...(live !== undefined ? { live } : {}),
        running: state.running ? { attemptId: state.running.attemptId, startedAt: state.running.startedAt, queued, owner } : null,
        last: state.last ? { ...structuredClone(state.last), beforeBoot } : null,
        record,
      };
    },
  };
}
