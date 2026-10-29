import type { DbPool } from './db.js';
import { restoreDatabase, type RestoreCounts } from './backup.js';
import type { GpxFiles } from './gpx-files.js';
import { publishRestoreFence, readRestoreFence } from './onboarding-fence.js';
import { assertBootstrapOnlyTarget, initializeApplicationSchema, retireOnboarding } from './onboarding-bootstrap.js';

/** Supported native replacement boundary. Caller has confirmed scope and verified its real undo set. */
export async function restoreWithOnboarding(pool: DbPool, file: string, options: {
  storageDir: string; routeFiles: GpxFiles; assertOwner: () => Promise<void>;
}): Promise<RestoreCounts> {
  await options.assertOwner();
  await publishRestoreFence(options.storageDir, options.assertOwner);
  await retireOnboarding(pool, options.assertOwner);
  await options.assertOwner();
  return restoreDatabase(pool, file, { routeFiles: options.routeFiles, assertOwner: options.assertOwner });
}
/** Offline preparation never starts the app or its maintenance/recovery workers. */
export async function prepareNativeRestore(pool: DbPool, options: {
  storageDir: string; assertOwner: () => Promise<void>; confirm: () => Promise<boolean>;
}): Promise<boolean> {
  await options.assertOwner();
  await readRestoreFence(options.storageDir); // validate malformed existing metadata before admission
  await assertBootstrapOnlyTarget(pool, options.assertOwner);
  if (!await options.confirm()) return false;
  await publishRestoreFence(options.storageDir, options.assertOwner);
  await initializeApplicationSchema(pool, options.assertOwner);
  await retireOnboarding(pool, options.assertOwner);
  await options.assertOwner();
  return true;
}
