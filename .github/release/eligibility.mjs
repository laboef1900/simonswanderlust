import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const repository = 'laboef1900/wanderlust-studio';
export function validateRelease({ repo, ref, sha, mainSha }) {
  if (repo !== repository) throw new Error('Release repository is not approved');
  if (typeof ref !== 'string' || ref !== ref.trim() || !/^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(ref)) throw new Error('A stable vMAJOR.MINOR.PATCH tag is required');
  if (sha?.length !== 40 || !/^[a-f0-9]{40}$/.test(sha) || sha !== mainSha) throw new Error('Release must point to the current protected main revision');
  return ref.slice('refs/tags/v'.length);
}

export function ciVerdict(runs, sha) {
  const matching = runs.filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' && run.path === '.github/workflows/ci.yml')
    .sort((a, b) => b.id - a.id);
  const latest = matching[0];
  if (!latest || latest.status !== 'completed') return 'pending';
  return latest.conclusion === 'success' ? 'success' : 'failure';
}

export async function awaitEligibility({ repo, ref, sha, api, sleep = delay, now = Date.now, timeoutMs = 900_000 }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    validateRelease({ repo, ref, sha, mainSha: (await api(`repos/${repo}/git/ref/heads/main`)).object.sha });
    const { workflow_runs: runs } = await api(`repos/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`);
    const verdict = ciVerdict(runs, sha);
    if (verdict === 'success') return;
    if (verdict === 'failure') throw new Error('Latest main-push CI for the release revision did not pass');
    if (now() >= deadline) throw new Error('Timed out waiting for main-push CI');
    await sleep(15_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_REPOSITORY: repo, GITHUB_REF: ref, GITHUB_SHA: sha } = process.env;
  // Reject an untrusted repository/ref before making API requests.
  validateRelease({ repo, ref, sha, mainSha: sha });
  await awaitEligibility({ repo, ref, sha, api: async path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 30_000 })) });
  console.log('Release revision is the current main tip with successful main-push CI.');
}
