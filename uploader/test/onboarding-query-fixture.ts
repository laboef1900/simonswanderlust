import type { DbPool } from '../src/db.js';

/** Execute real SQL, then inject an acknowledgement failure or a concurrent external write. */
export function interceptOnboardingTransactions(pool: DbPool, afterQuery: (sql: string) => Promise<void>): DbPool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, key) {
            if (key === 'query') return async (sql: string, values?: unknown[]) => {
              const result = await connection.query(sql, values);
              await afterQuery(sql);
              return result;
            };
            const value = Reflect.get(connection, key, connection);
            return typeof value === 'function' ? value.bind(connection) : value;
          },
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
