import { dumpDatabase, type Connectable } from '../src/backup.js';

/**
 * Worker for backup.test.ts's cross-process publication test: writes `count`
 * dumps into `dir`, ALL stamped with the same `now`, each tagged with
 * `<tag>-<i>` in its single users row. Two of these racing in separate
 * processes is the scheduler-vs-restore-CLI situation; every dump must survive.
 * Not a .test.ts file: spawned by the test.
 */
const [, , dir, tag, countArg, nowArg] = process.argv;
const count = Number(countArg);
const now = new Date(Number(nowArg));
const db = (users: Record<string, unknown>[]): Connectable => ({
  query: async () => ({ rows: [] }),
  connect: async () => ({
    query: async (sql: string) => ({ rows: sql.includes('FROM users') ? users : [] }),
    release: () => {},
  }),
});
const names: string[] = [];
for (let i = 0; i < count; i++) names.push(await dumpDatabase(db([{ username: `${tag}-${i}` }]), dir as string, now));
process.stdout.write(JSON.stringify(names));
