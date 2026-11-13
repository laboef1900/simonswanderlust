import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualifiedReferences } from './promote.mjs';
const sha = 'a'.repeat(40);
const records = ['amd64', 'arm64'].map((arch, index) => ({ arch, sha, runId: '123', digest: 'sha256:' + String(index).repeat(64) }));
test('promotes only the two qualified immutable digests from this source and run', () => {
  assert.deepEqual(qualifiedReferences(records, sha, '123'), records.map(row => 'ghcr.io/laboef1900/wanderlust-studio@' + row.digest));
  assert.throws(() => qualifiedReferences(records.slice(0, 1), sha, '123'));
  for (const patch of [{ arch: 'amd64' }, { sha: 'b'.repeat(40) }, { runId: '456' }, { digest: 'latest' }]) assert.throws(() => qualifiedReferences([records[0], { ...records[1], ...patch }], sha, '123'));
});
