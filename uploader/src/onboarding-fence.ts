import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export const RESTORE_FENCE_PAYLOAD = 'swl-onboarding-restore-retired-v1\n';
export function restoreFencePath(storageDir: string): string {
  return join(dirname(resolve(storageDir)), 'onboarding.restore-retired');
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
/** Reject symlink ancestors as well as the final entry. Never follow a copied data-root link. */
export async function validateDataRoot(storageDir: string, create = false, durable = create): Promise<string> {
  const root = dirname(resolve(storageDir));
  if (root === sep) throw new Error('Refusing filesystem root as the recovery data root.');
  let path: string = sep;
  for (const piece of root.split(sep).filter(Boolean)) {
    path = join(path, piece);
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if (!create || !missing(error)) throw error;
      await mkdir(path, { mode: 0o700 });
      stat = await lstat(path);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe recovery data root.');
    if (durable) {
      // A previous mkdir may have succeeded before its parent fsync failed.
      // Re-establish every ancestor entry on retry, even if it already exists.
      const parent = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  return root;
}
/** A missing root/fence is fresh evidence; malformed/unreadable metadata is never absence. */
export async function readRestoreFence(storageDir: string, durable = false): Promise<boolean> {
  try { await validateDataRoot(storageDir, false, durable); }
  catch (error) { if (missing(error)) return false; throw error; }
  let handle;
  try { handle = await open(restoreFencePath(storageDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return false; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(RESTORE_FENCE_PAYLOAD)) throw new Error('Invalid onboarding retirement fence.');
    const bytes = Buffer.alloc(Buffer.byteLength(RESTORE_FENCE_PAYLOAD) + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (bytes.subarray(0, result.bytesRead).toString('utf8') !== RESTORE_FENCE_PAYLOAD) throw new Error('Invalid onboarding retirement fence.');
    if (durable) await handle.sync();
  } finally { await handle.close(); }
  if (durable) {
    const parent = await open(dirname(restoreFencePath(storageDir)), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  }
  return true;
}
export async function publishRestoreFence(storageDir: string, assertOwner: () => Promise<void>): Promise<void> {
  await assertOwner();
  await validateDataRoot(storageDir, true);
  if (await readRestoreFence(storageDir, true)) { await assertOwner(); return; }
  const final = restoreFencePath(storageDir);
  const temp = final + '.part-' + randomBytes(16).toString('hex');
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(RESTORE_FENCE_PAYLOAD);
    await handle.sync();
    await handle.close();
    await assertOwner();
    try { await link(temp, final); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    await unlink(temp);
    if (!await readRestoreFence(storageDir, true)) throw new Error('Retirement fence publication was not acknowledged.');
    await assertOwner();
  } catch (error) {
    await handle.close().catch(() => {});
    // Preserve uncertain publication/temporary evidence; no restore may continue.
    throw error;
  }
}
