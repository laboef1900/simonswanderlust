/** PostgreSQL-generated snapshot IDs only; never an HTTP or operator setting. */
export function assertDatabaseSnapshot(value: string): void {
  if (!/^[0-9A-Fa-f]{1,16}-[0-9A-Fa-f]{1,16}-[0-9A-Fa-f]{1,16}$/.test(value)) {
    throw new Error('Invalid SITE_DATABASE_SNAPSHOT');
  }
}
