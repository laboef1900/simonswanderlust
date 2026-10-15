/**
 * The WordPress import as a background job (issue #92).
 *
 * `POST /import` used to await the whole import inside one request — at the
 * default pacing a real export is a ~13-minute request the reverse proxy or
 * the browser abandons, so the author never saw the outcome. Now the route
 * runs the pre-flight synchronously (everything that can REFUSE the export
 * keeps its status code), hands the run to this runner, and answers 202; the
 * page polls `GET /import/status`.
 *
 * @ai-note Deliberately NOT `encode-queue.ts`. The queue models many small
 * identical jobs behind a concurrency cap; an import is one long job with its
 * own pacing, retry and resume, whose per-photo encodes already take the
 * work-lock (issue #95). Running the WHOLE import under `runShared` would hold
 * every Publish off for the duration — the opposite of what #95 established.
 *
 * @ai-warning One job at a time, as before (#85's single flight): two runs
 * would double-fetch, hit the source host at twice the configured rate and race
 * variant writes. `start` is the only place a job is created and it refuses
 * while one is running; the route maps `ImportBusyError` to 409.
 *
 * State is reconstructible per CLAUDE.md: the live process serves progress
 * from memory (exact), the `import_jobs` row is written on every group
 * boundary and at most every `persistEveryMs` for image events, and boot
 * `recover()` marks a row the previous process left `running` as
 * `interrupted`. The XML is never persisted, so an interrupted job is resumed
 * by running the import again — #85's documented recovery path, which costs
 * nothing for photos already on disk.
 *
 * @ai-context docs/superpowers/specs/2026-09-05-async-import-job-design.md
 */
import { randomUUID } from 'node:crypto';
import type { DbPool } from './db.js';
import type { ImportProgress, ImportSummary } from './wp-import.js';

export type ImportJobStatus = 'running' | 'done' | 'failed' | 'interrupted';

export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  startedBy: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  progress: ImportProgress;
  summary: ImportSummary | null;
  error: string | null;
}

export interface ImportJobPatch {
  status?: ImportJobStatus;
  progress?: ImportProgress;
  summary?: ImportSummary | null;
  error?: string | null;
  finishedAt?: string | null;
}

export interface ImportJobStore {
  insert(job: ImportJob): Promise<void>;
  update(id: string, patch: ImportJobPatch): Promise<void>;
  /** The most recently started job, running or not. */
  latest(): Promise<ImportJob | null>;
  /** Boot recovery: every `running` row → `interrupted`. Returns how many. */
  interruptRunning(): Promise<number>;
}

/** Rows kept per store; older jobs are pruned on insert. */
export const IMPORT_JOB_HISTORY = 20;
/** Default cadence for persisting image-level progress. */
export const DEFAULT_PERSIST_EVERY_MS = 2_000;

/** Thrown by `start` while another import is running. The route answers 409. */
export class ImportBusyError extends Error {
  constructor() {
    super('an import is already running; wait for it to finish');
    this.name = 'ImportBusyError';
  }
}

/** Client-safe outcome text; the underlying error goes to stdout only. */
export const IMPORT_FAILED_MESSAGE = 'the import failed unexpectedly; see the server log';

const cloneProgress = (p: ImportProgress): ImportProgress => ({
  groups: { ...p.groups },
  images: { ...p.images },
});

export function memoryImportJobStore(): ImportJobStore {
  const jobs: ImportJob[] = [];
  const copy = (j: ImportJob): ImportJob => ({ ...j, progress: cloneProgress(j.progress), summary: j.summary ? structuredClone(j.summary) : null });
  return {
    async insert(job) {
      jobs.unshift(copy(job));
      jobs.splice(IMPORT_JOB_HISTORY);
    },
    async update(id, patch) {
      const j = jobs.find((x) => x.id === id);
      if (!j) return;
      if (patch.status !== undefined) j.status = patch.status;
      if (patch.progress !== undefined) j.progress = cloneProgress(patch.progress);
      if (patch.summary !== undefined) j.summary = patch.summary ? structuredClone(patch.summary) : null;
      if (patch.error !== undefined) j.error = patch.error;
      if (patch.finishedAt !== undefined) j.finishedAt = patch.finishedAt;
      j.updatedAt = new Date().toISOString();
    },
    async latest() {
      const j = jobs[0];
      return j ? copy(j) : null;
    },
    async interruptRunning() {
      let n = 0;
      for (const j of jobs) if (j.status === 'running') { j.status = 'interrupted'; j.finishedAt = new Date().toISOString(); n++; }
      return n;
    },
  };
}

interface Row {
  id: string;
  status: ImportJobStatus;
  started_by: string;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  progress: ImportProgress;
  summary: ImportSummary | null;
  error: string | null;
}

const fromRow = (r: Row): ImportJob => ({
  id: r.id,
  status: r.status,
  startedBy: r.started_by,
  startedAt: r.started_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  progress: r.progress,
  summary: r.summary,
  error: r.error,
});

export function pgImportJobStore(pool: DbPool): ImportJobStore {
  return {
    async insert(job) {
      await pool.query(
        `INSERT INTO import_jobs (id, status, started_by, started_at, updated_at, finished_at, progress, summary, error)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)`,
        [job.id, job.status, job.startedBy, job.startedAt, job.finishedAt, JSON.stringify(job.progress),
          job.summary ? JSON.stringify(job.summary) : null, job.error],
      );
      // Bounded history: operational state must not grow with every run.
      await pool.query(
        `DELETE FROM import_jobs WHERE id IN (
           SELECT id FROM import_jobs ORDER BY started_at DESC OFFSET $1
         )`,
        [IMPORT_JOB_HISTORY],
      );
    },
    async update(id, patch) {
      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [id];
      const add = (col: string, value: unknown): void => { params.push(value); sets.push(`${col} = $${params.length}`); };
      if (patch.status !== undefined) add('status', patch.status);
      if (patch.progress !== undefined) add('progress', JSON.stringify(patch.progress));
      if (patch.summary !== undefined) add('summary', patch.summary ? JSON.stringify(patch.summary) : null);
      if (patch.error !== undefined) add('error', patch.error);
      if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt);
      await pool.query(`UPDATE import_jobs SET ${sets.join(', ')} WHERE id = $1`, params);
    },
    async latest() {
      const { rows } = await pool.query<Row>(
        `SELECT id, status, started_by, started_at, updated_at, finished_at, progress, summary, error
         FROM import_jobs ORDER BY started_at DESC LIMIT 1`,
      );
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async interruptRunning() {
      const { rowCount } = await pool.query(
        `UPDATE import_jobs SET status = 'interrupted', finished_at = now(), updated_at = now() WHERE status = 'running'`,
      );
      return rowCount ?? 0;
    },
  };
}

export interface ImportRunnerOptions {
  store: ImportJobStore;
  log?: (msg: string) => void;
  now?: () => number;
  persistEveryMs?: number;
}

export interface StartImport {
  startedBy: string;
  planned: ImportProgress;
  run(onProgress: (p: ImportProgress) => void): Promise<ImportSummary>;
}

export interface ImportRunner {
  /** Create the job row and run `run` in the background. Throws `ImportBusyError` while one runs. */
  start(job: StartImport): Promise<ImportJob>;
  /** The running job (live counters), or null. */
  current(): ImportJob | null;
  /** The running job, else the most recent one from the store. */
  latest(): Promise<ImportJob | null>;
  /** Boot: rows the previous process left `running` become `interrupted`. */
  recover(): Promise<number>;
  /** Resolves when the running job (if any) has finished. Tests and shutdown. */
  settle(): Promise<void>;
}

export function createImportRunner(opts: ImportRunnerOptions): ImportRunner {
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? (() => Date.now());
  const persistEveryMs = opts.persistEveryMs ?? DEFAULT_PERSIST_EVERY_MS;
  let current: ImportJob | null = null;
  /** The most recently finished job, kept so a failed terminal write cannot strand the page. */
  let last: ImportJob | null = null;
  let running: Promise<void> = Promise.resolve();

  const snapshot = (j: ImportJob): ImportJob => ({ ...j, progress: cloneProgress(j.progress) });

  return {
    async start(spec) {
      if (current) throw new ImportBusyError();
      const startedAt = new Date(now()).toISOString();
      const job: ImportJob = {
        id: randomUUID(),
        status: 'running',
        startedBy: spec.startedBy,
        startedAt,
        updatedAt: startedAt,
        finishedAt: null,
        progress: cloneProgress(spec.planned),
        summary: null,
        error: null,
      };
      // Take the slot BEFORE the first await, or two concurrent starts would
      // both pass the check; and insert the row before the run starts, so a
      // status poll can never see a running import with no row behind it.
      current = job;
      try {
        await opts.store.insert(job);
      } catch (e) {
        current = null;
        throw e;
      }

      let lastPersist = now();
      let lastGroups = job.progress.groups.done;
      // Persist failures must not fail the import: the row is a mirror of the
      // live counters, not the source of truth for the run. Writes are
      // SERIALISED through one chain — unawaited pooled UPDATEs can commit out
      // of order when connection acquisition is delayed, and an older snapshot
      // landing after a newer one (or after the terminal write) would make the
      // durable counters go backwards.
      let chain: Promise<void> = Promise.resolve();
      const persist = (patch: ImportJobPatch): Promise<boolean> => {
        const next = chain.then(() => opts.store.update(job.id, patch)).then(() => true, (e: unknown) => {
          log(`import job ${job.id}: progress write failed: ${(e as Error).message}`);
          return false;
        });
        chain = next.then(() => {});
        return next;
      };

      running = (async () => {
        try {
          const summary = await spec.run((p) => {
            job.progress = cloneProgress(p);
            job.updatedAt = new Date(now()).toISOString();
            // Every group boundary, else at most every persistEveryMs.
            const groupDone = p.groups.done !== lastGroups;
            if (groupDone || now() - lastPersist >= persistEveryMs) {
              lastGroups = p.groups.done;
              lastPersist = now();
              void persist({ progress: job.progress });
            }
          });
          job.status = 'done';
          job.summary = summary;
        } catch (e) {
          // Per-group and per-image failures are already caught INTO the
          // summary by the importer, so reaching here is unexpected (database
          // down, a bug). Fixed message out, detail to stdout only.
          log(`import job ${job.id} failed: ${(e as Error).stack ?? String(e)}`);
          job.status = 'failed';
          job.error = IMPORT_FAILED_MESSAGE;
        }
        job.finishedAt = new Date(now()).toISOString();
        job.updatedAt = job.finishedAt;
        const stored = await persist({ status: job.status, progress: job.progress, summary: job.summary, error: job.error, finishedAt: job.finishedAt });
        if (!stored) {
          // The outcome is kept in memory (see latest()) so the page does not
          // poll a stale `running` row forever; a restart turns it into
          // `interrupted` via recover(), which is honest about what was lost.
          log(`import job ${job.id}: outcome ${job.status} could not be persisted; serving it from memory until restart`);
        }
        last = job;
        current = null;
      })();
      return snapshot(job);
    },
    current: () => (current ? snapshot(current) : null),
    async latest() {
      if (current) return snapshot(current);
      const stored = await opts.store.latest();
      // Memory wins for the SAME job: its terminal write may have failed. A
      // newer row (a later import) wins over a stale memory copy.
      if (last && (!stored || stored.id === last.id)) return snapshot(last);
      return stored;
    },
    async recover() {
      const n = await opts.store.interruptRunning();
      if (n > 0) log(`import jobs: marked ${n} job(s) left running by the previous process as interrupted`);
      return n;
    },
    settle: () => running,
  };
}
