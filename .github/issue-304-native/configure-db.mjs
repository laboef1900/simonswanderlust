// Pipe an already-authorized owned fixture JSON through stdin, never argv/env.
// This script does not connect, create a database, or read any inherited .env.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureRoot } from './proof-common.mjs';
try {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk.toString('utf8');
    assert(text.length <= 16384);
  }
  const c = JSON.parse(text);
  assert.equal(c.host, '127.0.0.1'); assert.equal(c.port, 55427);
  assert(/^swl_[a-z0-9_]+$/.test(c.database));
  assert.equal(c.database, process.env.PROOF_EXPECT_DATABASE);
  assert.equal(c.ownedFixture, true);
  assert(typeof c.user === 'string' && c.user.length > 0);
  assert(typeof c.password === 'string' && c.password.length > 0);
  writeFileSync(join(fixtureRoot, 'db.json'), JSON.stringify({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, ownedFixture: true }), { flag: 'wx', mode: 0o600 });
  console.log('Private owned-loopback fixture configuration retained; no connection attempted.');
} catch {
  console.error('Fixture configuration refused; no credential detail emitted.');
  process.exitCode = 1;
}
