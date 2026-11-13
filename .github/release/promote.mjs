import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateRelease } from './eligibility.mjs';

export function qualifiedReferences(records, sha, runId) {
  assert.equal(records.length, 2, 'Both native architectures must qualify');
  const seen = new Set();
  return records.map(row => {
    assert(['amd64', 'arm64'].includes(row.arch) && !seen.has(row.arch), 'Missing or duplicated architecture');
    seen.add(row.arch);
    assert.equal(row.sha, sha, 'Candidate source mismatch');
    assert.equal(row.runId, runId, 'Candidate workflow run mismatch');
    assert(/^sha256:[a-f0-9]{64}$/.test(row.digest), 'Invalid candidate digest');
    return `ghcr.io/laboef1900/wanderlust-studio@${row.digest}`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_SHA: sha, GITHUB_RUN_ID: runId, GITHUB_REPOSITORY: repo, GITHUB_REF: ref, GITHUB_OUTPUT: output } = process.env;
  const version = validateRelease({ repo, ref, sha, mainSha: sha });
  const image = 'ghcr.io/laboef1900/wanderlust-studio';
  const references = qualifiedReferences(['amd64', 'arm64'].map(arch => JSON.parse(readFileSync(`qualified-digests/${arch}.json`, 'utf8'))), sha, runId);
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  const staging = `${image}:candidate-${sha}-${runId}-index`;
  docker(['buildx', 'imagetools', 'create', '--tag', staging, ...references]);
  const digest = docker(['buildx', 'imagetools', 'inspect', staging, '--format', '{{.Manifest.Digest}}']).trim();
  assert(/^sha256:[a-f0-9]{64}$/.test(digest));
  // Never overwrite an already published immutable version with a different image.
  const existing = spawnSync('docker', ['buildx', 'imagetools', 'inspect', `${image}:${version}`, '--format', '{{.Manifest.Digest}}'], { encoding: 'utf8', timeout: 60_000 });
  if (existing.status === 0) assert.equal(existing.stdout.trim(), digest, 'Version tag already names another image');
  else assert(!existing.error && /manifest unknown|not found/i.test(existing.stderr), 'Cannot establish whether the version tag already exists');
  const minor = version.split('.').slice(0, 2).join('.');
  docker(['buildx', 'imagetools', 'create', '--tag', `${image}:${version}`, '--tag', `${image}:${minor}`, '--tag', `${image}:latest`, `${image}@${digest}`]);
  appendFileSync(output, `digest=${digest}\n`);
}
