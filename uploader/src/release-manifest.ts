import { mkdir, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { readReleaseManifest, RELEASE_STAMP_RE, type ReleaseManifestV1 } from '../../site/src/lib/publication-manifest.js';
import { assertWorkWritable, type WorkCancellationOptions } from './work-cancellation.js';

export type ReleaseObservation =
  | { release: 'none' | 'unknown' }
  | { release: 'known'; manifest: ReleaseManifestV1 };

function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/** No error/path/content can escape through this optional diagnostic. */
function warnManifest(): void {
  try { console.warn('Release publication manifest unavailable; publication status may be unknown.'); }
  catch { /* A diagnostic cannot fail a build. */ }
}

/** Read current on every request. Cache only one immutable, validated release. */
export function createReleaseManifestReader(siteDir: string): { read(): Promise<ReleaseObservation> } {
  let cached: ReleaseManifestV1 | undefined;
  return {
    async read() {
      for (let attempt = 0; attempt < 2; attempt++) {
        let stamp: string;
        try {
          const target = resolve(siteDir, await readlink(join(siteDir, 'current')));
          stamp = basename(target);
          if (!RELEASE_STAMP_RE.test(stamp) || target !== resolve(siteDir, 'releases', stamp)) {
            cached = undefined;
            return { release: 'unknown' };
          }
        } catch (error) {
          cached = undefined;
          return { release: missing(error) ? 'none' : 'unknown' };
        }
        if (cached?.stamp === stamp) return { release: 'known', manifest: cached };
        cached = undefined;
        try {
          const manifest = await readReleaseManifest(join(siteDir, 'manifests', `${stamp}.json`), stamp);
          cached = manifest;
          return { release: 'known', manifest };
        } catch (error) {
          // Pruning may have removed the just-observed release. One fresh link
          // observation resolves that race; missing/invalid files are never cached.
          if (attempt === 0 && missing(error)) continue;
          return { release: 'unknown' };
        }
      }
      return { release: 'unknown' };
    },
  };
}

/** Called after release rename and before current flip; never gates promotion. */
export async function publishReleaseManifest(source: string, siteDir: string, stamp: string, work: WorkCancellationOptions): Promise<void> {
  const directory = join(siteDir, 'manifests');
  const temporary = join(directory, `.${stamp}.partial`);
  try {
    const manifest = await readReleaseManifest(source, stamp);
    assertWorkWritable(work);
    await mkdir(directory, { recursive: true });
    assertWorkWritable(work);
    await writeFile(temporary, JSON.stringify(manifest));
    assertWorkWritable(work);
    await rename(temporary, join(directory, `${stamp}.json`));
  } catch { warnManifest(); }
  // Temp cleanup is deferred to the guarded sweep, including after lease loss.
}

/** Only call after successful old-release deletion; loss admits no new mutation. */
export async function removeReleaseManifest(siteDir: string, stamp: string, work: WorkCancellationOptions): Promise<void> {
  assertWorkWritable(work);
  try { await rm(join(siteDir, 'manifests', `${stamp}.json`), { force: true }); }
  catch { warnManifest(); }
}

/** Orphans and SIGKILL temporaries are optional cleanup, never build blockers. */
export async function sweepReleaseManifests(siteDir: string, work: WorkCancellationOptions): Promise<void> {
  try {
    const releases = new Set(await readdir(join(siteDir, 'releases')));
    let current: string | undefined;
    try { current = basename(await readlink(join(siteDir, 'current'))); }
    catch (error) { if (!missing(error)) return; }
    for (const name of await readdir(join(siteDir, 'manifests'))) {
      const stamp = name.endsWith('.json') ? name.slice(0, -5) : undefined;
      if (stamp === current || (stamp && releases.has(stamp))) continue;
      if (!/^\.\d{1,16}-\d{1,10}-\d{4,10}\.partial$/.test(name) && !(stamp && RELEASE_STAMP_RE.test(stamp))) continue;
      assertWorkWritable(work);
      await rm(join(siteDir, 'manifests', name), { force: true });
    }
  } catch (error) { if (!missing(error)) warnManifest(); }
}
