import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_FILE_RE, IMAGES_ARCHIVE_RE } from './backup.js';
import { projectBuildReport } from './build-state.js';
import { diskSpace } from './disk.js';
import { exportAll } from './export.js';
import { ROUTE_ARCHIVE_RE } from './gpx-backup.js';
import { ImportBusyError, type ImportJob } from './import-jobs.js';
import type { StoredPostPair } from './posts.js';
import type { ServerContext } from './server-context.js';
import { ImportInsufficientSpaceError, ImportTooLargeError, prepareImport, type PreparedImport } from './wp-import.js';
import { createRehostResume } from './wp-images.js';
import { WxrParseError } from './wxr-parse.js';

export function registerBackupAndImportRoutes(ctx: ServerContext): void {
  const { app, cfg, language, publication, importJobs, requireAuth, requireAdmin, isWritable } = ctx;
  const runtime = { signal: cfg.storageSignal, isWritable };

  app.post('/rebuild', { preHandler: requireAdmin }, async () => projectBuildReport(await cfg.builder.build('rebuild')));

  app.get('/rebuild/status', { preHandler: requireAdmin }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send(await cfg.builder.status());
  });

  app.get('/publication/summary', { preHandler: requireAdmin }, async (_req, reply) =>
    reply.header('Cache-Control', 'no-store').send(await publication.summary()));

  app.get('/backups', { preHandler: requireAdmin }, async () => ({
    state: cfg.dbBackup.state(),
    running: cfg.dbBackup.running(),
    files: cfg.dbBackup.list(),
    imageArchives: cfg.dbBackup.listImageArchives(),
    routeArchives: cfg.dbBackup.listRouteArchives(),
    routeCleanup: cfg.gpx?.orphanCleanup(),
  }));

  app.post('/backups', { preHandler: requireAdmin }, async (_req, reply) => {
    if (cfg.dbBackup.running()) return reply.code(409).send({ error: 'a backup is already running' });
    return cfg.dbBackup.runNow();
  });

  app.get<{ Params: { name: string } }>('/backups/:name', { preHandler: requireAdmin }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const name = req.params.name;
    const isDump = BACKUP_FILE_RE.test(name);
    if (!isDump && !IMAGES_ARCHIVE_RE.test(name) && !ROUTE_ARCHIVE_RE.test(name)) {
      return reply.code(400).send({ error: 'invalid backup filename' });
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(join(cfg.dbBackup.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) {
        await handle.close();
        return reply.code(404).send({ error: 'backup not found' });
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ELOOP')) {
        return reply.code(404).send({ error: 'backup not found' });
      }
      throw error;
    }
    reply.header('content-type', isDump ? 'application/gzip' : 'application/x-tar');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(handle.createReadStream());
  });

  let exportRunning = false;
  app.post('/export', { preHandler: requireAuth }, async (_req, reply) => {
    if (exportRunning) return reply.code(409).send({ error: 'an export is already running' });
    exportRunning = true;
    try {
      const list = await cfg.posts.list();
      const pairs: StoredPostPair[] = [];
      for (const s of list) {
        const pair = await cfg.posts.get(s.translationKey);
        if (pair) pairs.push(pair);
      }
      const files = await exportAll(pairs, cfg.backupDir, (tk) => cfg.posts.getPublishedTrack(tk));
      return reply.send({ ok: true, count: files.length });
    } finally {
      exportRunning = false;
    }
  });

  app.post('/import', { preHandler: requireAdmin }, async (req, reply) => {
    if (importJobs.current()) {
      return reply.code(409).send({ error: 'an import is already running; wait for it to finish' });
    }
    let xml = '';
    let overwriteDrafts = false;
    for await (const part of req.parts()) {
      if (part.type === 'file') xml = (await part.toBuffer()).toString('utf8');
      else if (part.fieldname === 'overwriteDrafts') overwriteDrafts = String(part.value) === 'true';
    }
    if (!xml.includes('<rss') || !xml.includes('wordpress.org/export')) {
      return reply.code(400).send({ error: 'not a WordPress export (.xml) file' });
    }
    const {
      importDelayMs, importRetries, convertJpeg, webpQuality, avifQuality,
    } = cfg.settings.get();
    let prepared: PreparedImport;
    try {
      prepared = await (cfg.prepareImport ?? prepareImport)(xml, {
        postStore: cfg.posts, storageDir: cfg.storageDir, baseUrl: cfg.baseUrl,
        language: await language.get(),
        delayMs: importDelayMs,
        retries: importRetries,
        encoding: { convertJpeg, webpQuality, avifQuality },
        resume: await createRehostResume({ storageDir: cfg.storageDir, baseUrl: cfg.baseUrl }),
        diskSpace: () => diskSpace(cfg.storageDir),
        lock: cfg.workLock,
        log: (msg) => console.log(msg),
        overwriteDrafts,
        ...runtime,
      });
    } catch (e) {
      if (e instanceof WxrParseError) {
        console.log(`import: ${e.message}: ${e.detail}`);
        return reply.code(400).send({ error: e.message });
      }
      if (e instanceof ImportTooLargeError) return reply.code(400).send({ error: e.message });
      if (e instanceof ImportInsufficientSpaceError) return reply.code(507).send({ error: e.message });
      throw e;
    }
    if (prepared.groups === 0) {
      return reply.code(400).send({ error: 'no importable posts found in export' });
    }
    let job: ImportJob;
    try {
      job = await importJobs.start({ startedBy: req.authUser?.username ?? '', planned: prepared.planned, run: prepared.run });
    } catch (e) {
      if (e instanceof ImportBusyError) return reply.code(409).send({ error: e.message });
      throw e;
    }
    return reply.code(202).send({ id: job.id, status: job.status, planned: job.progress });
  });

  app.get('/import/status', { preHandler: requireAdmin }, async () => ({ job: await importJobs.latest() }));
}
