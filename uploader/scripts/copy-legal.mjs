// Package static notices; never execute dependency code or access application data.
// Run after npm ci: node uploader/scripts/copy-legal.mjs site|uploader
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const tree = process.argv[2];
if (tree !== 'site' && tree !== 'uploader') throw new Error('Expected site or uploader');
const { ui } = await import(new URL('../../site/src/i18n/ui.ts', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const treeRoot = join(root, tree);
const out = join(treeRoot, 'public', 'legal');
const sourcePath = join(root, 'source-release.json');
const validateSource = (source) => {
  if (source === null) return;
  if (!source || typeof source.repository !== 'string' || typeof source.revision !== 'string'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(source.repository)
    || ['.', '..'].includes(source.repository.split('/')[1])
    || !/^[a-f0-9]{40}$/.test(source.revision)) throw new Error('Invalid release source provenance');
};
// Only release builds supply identifiers. Default/local builds explicitly record
// unknown; never infer clean source provenance from a checkout's HEAD.
let source = null;
if (process.argv.length === 5) {
  const [repository, revision] = process.argv.slice(3);
  source = repository === '' && revision === '' ? null : { repository, revision };
  validateSource(source);
  await writeFile(sourcePath, JSON.stringify(source, null, 2) + '\n');
} else if (process.argv.length === 3) {
  try { source = JSON.parse(await readFile(sourcePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  validateSource(source);
} else throw new Error('Expected tree and optional repository/full revision pair');
await mkdir(out, { recursive: true });
for (const [source, destination] of [
  ['LICENSE', 'LICENSE.txt'], ['NOTICE', 'NOTICE.txt'],
  ['docs/third-party-inventory.json', 'third-party-inventory.json'],
  ['docs/third-party-evidence.json', 'third-party-evidence.json'],
  ['docs/third-party-image-evidence.json', 'third-party-image-evidence.json'],
]) await copyFile(join(root, source), join(out, destination));
await writeFile(join(out, 'source-release.json'), JSON.stringify(source, null, 2) + '\n');

const escapeHtml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
for (const locale of ['de', 'en']) {
  const text = (key) => escapeHtml(ui[locale]['editor.chrome.' + key]);
  const links = [
    ['LICENSE.txt', 'licenseText'], ['NOTICE.txt', 'rightsNotice'],
    ['https://github.com/laboef1900/simonswanderlust', 'upstreamSource'],
    ['THIRD-PARTY-NOTICES.txt', 'thirdPartyNotices'],
    ['third-party-inventory.json', 'dependencyInventory'],
    ['third-party-evidence.json', 'licenseEvidence'], ['notice-gaps.json', 'noticeGaps'],
    ['third-party-image-evidence.json', 'imageEvidence'],
  ];
  if (source) {
    const base = `https://github.com/${source.repository}`;
    links.push([`${base}/archive/${source.revision}.tar.gz`, 'releaseSourceArchive']);
    links.push([`${base}/tree/${source.revision}`, 'releaseSourceTree']);
  }
  await writeFile(join(out, `${locale}.html`), `<!doctype html>
<html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${text('softwareNotices')}</title>
<main><h1>${text('softwareNotices')}</h1><p>${text('softwareSummary')}</p>
<ul>${links.map(([href, key]) => `<li><a href="${escapeHtml(href)}">${text(key)}</a></li>`).join('\n')}</ul>
<p>${text(source ? 'sourceRecorded' : 'sourceUnknown')}</p>
<p>${text('sourceCaveat')}</p></main></html>\n`);
}

const noticeName = /^(?:licen[cs]e|copying|notice|copyright|authors)(?:$|[._-])/i;
const noticeDirectory = /^(?:licen[cs]es?|notices?)$/i;
async function collect(directory, prefix = '', all = false) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isFile() && (all || noticeName.test(entry.name))) {
      files.push([relative, await readFile(join(directory, entry.name), 'utf8')]);
    } else if (entry.isDirectory() && (all || noticeDirectory.test(entry.name))) {
      files.push(...await collect(join(directory, entry.name), relative + '/', true));
    }
  }
  return files;
}
const lock = JSON.parse(await readFile(join(treeRoot, 'package-lock.json'), 'utf8'));
const notices = ['Third-party notices collected from installed packages. Original texts follow unchanged.\nThis file is not a native-library SBOM or proof of corresponding-source availability.\n'];
const missing = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  let files;
  try { files = await collect(join(treeRoot, path)); }
  catch (error) {
    if (error.code === 'ENOENT') continue; // Uninstalled optional/dev packages are still in the lock inventory.
    throw error;
  }
  const name = entry.name ?? path.split('node_modules/').at(-1);
  if (!files.length) missing.push({ path, name, version: entry.version, license: entry.license ?? 'unknown' });
  for (const [file, text] of files) notices.push(`\n===== ${name}@${entry.version} (${path}/${file}) =====\n\n${text}`);
}
// Reviewed notices missing from upstream npm packages, retained for browser recipients too.
for (const [file, text] of await collect(join(root, 'uploader/scripts/vendor-licenses'), '', true)) {
  notices.push(`\n===== Supplemental upstream notice: ${file} =====\n\n${text}`);
}
await writeFile(join(out, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n') + '\n');
await writeFile(join(out, 'notice-gaps.json'), JSON.stringify({
  scope: 'Installed npm packages without a recognized notice file; inspect upstream and emitted artifacts before release. Supplemental notices may resolve some entries. Not a compliance verdict.',
  packages: missing,
}, null, 2) + '\n');
console.log(`Packaged ${tree} legal assets; ${missing.length} installed packages need notice review`);
