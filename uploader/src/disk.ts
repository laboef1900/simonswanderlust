/**
 * Free-space accounting for the `/data` volume (issue #73).
 *
 * `/data` is a single bind mount holding image originals, variants, site
 * releases AND backups — all competing for the same space, and the media
 * library's bulk upload is the workflow that consumes it fastest (a measured
 * ~17.5 MB per photo: 6.9 MB of variants plus the 10.7 MB retained original,
 * so ~1.75 GB per 100 photos, roughly doubled again by the incremental image
 * archive under /data/backup).
 *
 * @ai-warning A full `/data` does not fail cleanly in one place: variant
 * writes fail mid-pipeline and can leave a partial variant set with no
 * complete record, `astro build` cannot write a release so the site cannot be
 * updated at all, and backups — the thing you most want working when
 * everything else is broken — stop too. Hence a precondition on the way in
 * rather than monitoring after the fact.
 */
import { statfs } from 'node:fs/promises';

export interface DiskSpace {
  /** Bytes available to this (non-root) process. */
  free: number;
  /** Total filesystem size in bytes. */
  total: number;
}

/**
 * How much room a single upload must leave behind. Sized for the whole cost of
 * one photo — the retained original plus its full variant set — plus a floor
 * that keeps the site build and a backup able to run at all. Deliberately not
 * "the incoming bytes": accepting a 10 MB upload that then needs 7 MB of
 * variants and leaves no room for a release directory is exactly the failure
 * this guards.
 */
export const UPLOAD_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Per-photo multiple applied to the incoming size (original + AVIF/WebP set). */
export const UPLOAD_SIZE_FACTOR = 3;

/** Read free/total bytes for the filesystem holding `path`. */
export async function diskSpace(path: string): Promise<DiskSpace> {
  const st = await statfs(path);
  // bavail = blocks available to an unprivileged process, which is what the
  // non-root runtime user actually gets — bfree includes root's reserve.
  return { free: Number(st.bsize) * Number(st.bavail), total: Number(st.bsize) * Number(st.blocks) };
}

/**
 * Would accepting an upload of `incomingBytes` leave the volume too tight?
 * Returns null when there is room, or a sanitized, client-safe message.
 *
 * @ai-note The message is deliberately vague about absolute paths and exact
 * capacity — it goes to an authenticated author, but the convention here is
 * that clients never receive internal detail; the caller logs the numbers.
 */
export function insufficientSpace(space: DiskSpace, incomingBytes: number): string | null {
  const needed = UPLOAD_HEADROOM_BYTES + Math.max(0, incomingBytes) * UPLOAD_SIZE_FACTOR;
  if (space.free >= needed) return null;
  return `not enough free disk space to accept this upload (${formatBytes(space.free)} available, ${formatBytes(needed)} required)`;
}

/** Human-readable byte size for logs and the settings page. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
