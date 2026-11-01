import type { DbClient } from './db.js';

/** Every pair mutation takes this before reading, then locks locales in de/en order.
 * The bigint advisory-lock namespace is distinct from the app/restore two-int lock.
 * A hash collision only serializes unrelated pairs; keys never become SQL or paths. */
export async function lockPostPair(client: DbClient, translationKey: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [translationKey]);
}

/** One millisecond-safe token for BOTH locale rows, even for writes in the same ms.
 * MATERIALIZED evaluates the volatile clock once, not once per locale row. */
export async function touchPostPair(client: DbClient, translationKey: string): Promise<Date> {
  const result = await client.query<{ updated_at: Date }>(`
    WITH next_time AS MATERIALIZED (
      SELECT GREATEST(
        date_trunc('milliseconds', clock_timestamp()),
        date_trunc('milliseconds', MAX(updated_at)) + interval '1 millisecond'
      ) AS value FROM posts WHERE translation_key = $1
    )
    UPDATE posts SET updated_at = next_time.value, last_save_id = NULL, last_save_by = NULL FROM next_time
      WHERE translation_key = $1 RETURNING updated_at
  `, [translationKey]);
  if (result.rows.length !== 2) throw new Error('A complete post pair is required.');
  return result.rows[0]!.updated_at;
}
