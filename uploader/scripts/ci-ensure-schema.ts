// CI helper: bootstrap the Postgres schema so `astro check` / `astro build`
// (whose Content Layer loaders query the posts/pages tables) can run against
// a fresh service container. Usage: npx tsx scripts/ci-ensure-schema.ts
import { createPool, ensureSchema } from '../src/db.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = createPool(url);
await ensureSchema(pool);
await pool.end();
console.log('schema ensured');
