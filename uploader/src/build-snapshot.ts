import type pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertDatabaseSnapshot } from '../../site/src/lib/database-snapshot.js';
import { toIdentitySnapshot, type IdentitySnapshot } from '../../site/src/lib/site-identity.js';
import { identityFromRow, type IdentityRow } from './site-identity.js';
import { validateIdentityAsset } from './site-identity-assets.js';
import { readLanguage, type LanguageConfig } from './language.js';

export interface BuildAsset {
  role: string;
  path: string;
  bytes: Buffer;
  width: number;
  height: number;
}
export interface BuildSnapshot {
  databaseSnapshot: string;
  identity: IdentitySnapshot;
  language: LanguageConfig;
  assets: readonly BuildAsset[];
  signal: AbortSignal;
}
interface AssetRow { role: string; sha256: string; width: number; height: number; bytes: Buffer }

export class BuildSnapshotTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super('Build snapshot deadline exceeded');
    this.name = 'BuildSnapshotTimeoutError';
  }
}

/** One immutable view for configuration AND every child content loader. Future
 * configuration reads belong on this exporter client, never on another pool query.
 * The read transaction holds no writer lock; saves and live lease checks remain current.
 */
export async function withBuildSnapshot<T>(
  pool: pg.Pool,
  options: { timeoutMs: number; signal?: AbortSignal },
  consume: (snapshot: BuildSnapshot) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new BuildSnapshotTimeoutError(options.timeoutMs)), options.timeoutMs);
  let client: pg.PoolClient | undefined;
  let released = false;
  let consuming: Promise<T> | undefined;
  const connectionLost = () => {
    if (!released) deadline.abort(new Error('Build snapshot connection lost'));
  };
  const connectionEnded = () => {
    connectionLost();
    // Retain the error listener until final socket close, including intentional
    // release, so a late transport error cannot become an unhandled event.
    client?.removeListener('error', connectionLost);
    client?.removeListener('end', connectionEnded);
  };
  const release = () => {
    if (client && !released) { released = true; client.release(true); }
  };
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    // Before spawning, terminate a stalled capture query. Once the child/deploy
    // begins, its effective signal kills it and finally waits for settlement.
    if (!consuming) release();
    aborted.reject(signal.reason ?? new Error('Build cancelled'));
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const run = async () => {
    signal.throwIfAborted();
    client = await pool.connect();
    client.on('error', connectionLost);
    client.once('end', connectionEnded);
    if (signal.aborted) { release(); signal.throwIfAborted(); }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: exported } = await client.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot');
    const databaseSnapshot = exported[0]?.snapshot;
    if (!databaseSnapshot) throw new Error('Database snapshot export failed');
    assertDatabaseSnapshot(databaseSnapshot);
    const { rows } = await client.query<IdentityRow>('SELECT * FROM site_identity WHERE id = true');
    if (rows.length !== 1) throw new Error('Site identity singleton missing');
    const languageState = await readLanguage(client);
    const language: LanguageConfig = { primary: languageState.primary, locales: languageState.locales };
    const identity = toIdentitySnapshot(identityFromRow(rows[0]!), language.locales);
    const { rows: assetRows } = await client.query<AssetRow>('SELECT role, sha256, width, height, bytes FROM site_identity_assets ORDER BY role');
    const assets: BuildAsset[] = [];
    for (const row of assetRows) {
      await validateIdentityAsset(row);
      signal.throwIfAborted();
      assets.push({ role: row.role, path: `/_identity/${row.role}-${row.sha256.slice(0, 16)}.png`, bytes: row.bytes, width: row.width, height: row.height });
    }
    const logo = assets.find((asset) => asset.role === 'logo');
    if (logo) identity.assets.logo = { path: logo.path, width: logo.width, height: logo.height };
    const png32 = assets.find((asset) => asset.role === 'favicon-32');
    const png192 = assets.find((asset) => asset.role === 'favicon-192');
    const apple = assets.find((asset) => asset.role === 'apple-touch-180');
    if (png32 || png192 || apple) {
      if (!png32 || !png192 || !apple) throw new Error('Incomplete site identity favicon');
      identity.assets.favicon = { png32: png32.path, png192: png192.path, appleTouch180: apple.path };
    }
    signal.throwIfAborted();
    consuming = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return consume({ databaseSnapshot, identity, language, assets, signal });
    });
    return consuming;
  };
  try {
    return await Promise.race([run(), aborted.promise]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    // Settle the child/deployment before releasing its exported snapshot or lock.
    if (signal.aborted && consuming) await consuming.catch(() => {});
    // Destroying this dedicated connection rolls back even on network loss;
    // cleanup itself cannot hang behind a lost Postgres connection.
    release();
  }
}

export async function writeBuildAssets(outDir: string, snapshot: BuildSnapshot): Promise<void> {
  snapshot.signal.throwIfAborted();
  if (!snapshot.assets.length) return;
  const directory = join(outDir, '_identity');
  await mkdir(directory, { recursive: true });
  for (const asset of snapshot.assets) {
    snapshot.signal.throwIfAborted();
    await writeFile(join(outDir, asset.path.slice('/'.length)), asset.bytes);
  }
}
