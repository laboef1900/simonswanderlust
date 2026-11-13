import assert from 'node:assert/strict';
import { test } from 'node:test';
import { awaitEligibility, ciVerdict, validateRelease } from './eligibility.mjs';
const sha = 'a'.repeat(40);
const input = { repo: 'laboef1900/wanderlust-studio', ref: 'refs/tags/v1.2.3', sha, mainSha: sha };
const run = { id: 1, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
test('accepts a stable release only at the approved repository main tip', () => {
  assert.equal(validateRelease(input), '1.2.3');
  for (const patch of [{ repo: 'attacker/fork' }, { ref: 'refs/heads/main' }, { ref: 'refs/tags/v1.2.3-rc.1' }, { ref: 'refs/tags/v01.2.3' }, { ref: 'refs/tags/v1.2.3\n' }, { sha: 'short' }, { mainSha: 'b'.repeat(40) }]) assert.throws(() => validateRelease({ ...input, ...patch }));
});
test('requires the newest eligible run, not an unrelated or stale green result', () => {
  assert.equal(ciVerdict([run], sha), 'success');
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'dev' }, { event: 'pull_request' }, { path: '.github/workflows/other.yml' }]) assert.equal(ciVerdict([{ ...run, ...patch }], sha), 'pending');
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', null]) assert.equal(ciVerdict([run, { ...run, id: 2, conclusion }], sha), 'failure');
  assert.equal(ciVerdict([run, { ...run, id: 2, status: 'in_progress', conclusion: null }], sha), 'pending');
});
test('waits for concurrent main CI and rechecks main on every attempt', async () => {
  let calls = 0;
  await awaitEligibility({ ...input, sleep: async () => {}, api: async path => path.includes('/git/ref/') ? { object: { sha } } : { workflow_runs: ++calls === 1 ? [] : [run] } });
  assert.equal(calls, 2);
  let moved = false;
  await assert.rejects(awaitEligibility({ ...input, sleep: async () => { moved = true; }, api: async path => path.includes('/git/ref/') ? { object: { sha: moved ? 'b'.repeat(40) : sha } } : { workflow_runs: [] } }), /current protected main/);
});
test('missing CI expires and failed CI refuses immediately', async () => {
  const api = async path => path.includes('/git/ref/') ? { object: { sha } } : { workflow_runs: [] };
  await assert.rejects(awaitEligibility({ ...input, api, timeoutMs: 0 }), /Timed out/);
  await assert.rejects(awaitEligibility({ ...input, api: async path => path.includes('/git/ref/') ? { object: { sha } } : { workflow_runs: [{ ...run, conclusion: 'failure' }] } }), /did not pass/);
});
