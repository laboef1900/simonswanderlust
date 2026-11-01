// Offline inventory, not a legal clearance or a distribution/SBOM audit.
// From the repository root: node uploader/scripts/generate-third-party-inventory.mjs
// Review docs/third-party-evidence.json when dependency versions or asset inputs change.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const evidencePath = 'docs/third-party-evidence.json';
const evidenceBytes = await readFile(new URL(evidencePath, root));
const evidence = JSON.parse(evidenceBytes);
const imageEvidencePath = 'docs/third-party-image-evidence.json';
const imageEvidenceBytes = await readFile(new URL(imageEvidencePath, root));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inventory = {
  schemaVersion: 2,
  method: 'All packages entries in both npm lockfileVersion 3 files, including roots and dev/optional entries. license is verbatim lock metadata; reviewedLicense only supplements exact name/version/integrity matches from dated evidence. This is not an installed-image SBOM or notice bundle.',
  generator: 'uploader/scripts/generate-third-party-inventory.mjs',
  evidence: { path: evidencePath, sha256: sha256(evidenceBytes), reviewedAt: evidence.reviewedAt },
  imageEvidence: { path: imageEvidencePath, sha256: sha256(imageEvidenceBytes) },
  lockfiles: {},
  packages: [],
  licenseObligations: evidence.licenseObligations,
  manualAssets: evidence.manualAssets,
  vendorAssets: evidence.vendorAssets,
  limitations: evidence.limitations,
};

for (const tree of ['site', 'uploader']) {
  const path = `${tree}/package-lock.json`;
  const bytes = await readFile(new URL(path, root));
  const lock = JSON.parse(bytes);
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error(`Unsupported lockfile: ${path}`);
  inventory.lockfiles[tree] = { path, sha256: sha256(bytes), lockfileVersion: lock.lockfileVersion, entries: Object.keys(lock.packages).length };
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    const name = entry.name ?? (packagePath ? packagePath.split('node_modules/').at(-1) : lock.name);
    const reviewed = evidence.packageResolutions.find((item) => item.name === name && item.version === entry.version && item.integrity === entry.integrity);
    const license = entry.license ?? 'unknown';
    const effectiveLicense = reviewed?.reviewedLicense ?? license;
    const obligationIds = [...new Set(effectiveLicense.replace(/[()]/g, '').split(/\s+(?:AND|OR)\s+/))];
    inventory.packages.push({
      tree, path: packagePath, name, version: entry.version,
      license, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null,
      dev: entry.dev === true, optional: entry.optional === true,
      ...(reviewed ? { reviewedLicense: reviewed.reviewedLicense, licenseEvidence: `${evidencePath}#${reviewed.name}@${reviewed.version}` } : {}),
      obligationIds: obligationIds.filter((id) => Object.hasOwn(evidence.licenseObligations, id)),
      obligationStatus: packagePath === '' && effectiveLicense === 'AGPL-3.0-only' ? 'owner-approved; distribution-evidence-required' : obligationIds.every((id) => Object.hasOwn(evidence.licenseObligations, id)) ? 'summary-only; distribution-evidence-required' : 'unreviewed-license',
    });
  }
}

const destination = new URL('docs/third-party-inventory.json', root);
await writeFile(destination, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Generated ${inventory.packages.length} lockfile entries at ${fileURLToPath(destination)}`);
