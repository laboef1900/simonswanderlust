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
    ['https://github.com/laboef1900/wanderlust-studio', 'upstreamSource'],
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
  const statusBadge = source ? `${escapeHtml(source.repository)} @ ${escapeHtml(source.revision.slice(0, 10))}` : 'AGPL-3.0-only';
  await writeFile(join(out, `${locale}.html`), `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text('softwareNotices')}</title>
<style>
  :root {
    --ink: #202630; --muted: #626974; --navy: #263b51; --accent: #416486;
    --accent-hover: #2f5273; --accent-soft: #eaf0f6;
    --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; padding: clamp(1.25rem, 4vw, 3rem) 1rem;
    font-family: var(--sans); font-size: 0.9375rem; line-height: 1.6; color: var(--ink);
    background-color: #fbfbfd;
    background-image:
      radial-gradient(64% 58% at 17% 83%, rgb(196 201 208 / 0.56) 0%, rgb(206 211 217 / 0.24) 46%, transparent 82%),
      linear-gradient(to top right, #d0d4da 0%, #dbdfe4 33.333%, #eceef1 62%, #f6f7f9 84%, #fbfbfd 100%);
    background-attachment: fixed;
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: 46rem; margin: 0 auto; padding: clamp(1.5rem, 4vw, 2.5rem);
    border-radius: 0.75rem;
    background: rgb(255 255 255 / 0.78);
    backdrop-filter: blur(16px) saturate(112%); -webkit-backdrop-filter: blur(16px) saturate(112%);
    border: 1px solid rgb(255 255 255 / 0.72);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.8), 0 1px 3px rgb(20 42 66 / 7%), 0 12px 28px -8px rgb(20 42 66 / 10%);
  }
  .badge {
    display: inline-block; margin-bottom: 0.75rem; padding: 0.2rem 0.65rem;
    border-radius: 999px; background: var(--accent-soft); color: var(--accent-hover);
    font: 600 0.75rem/1.3 var(--mono);
  }
  h1 { margin: 0; font-size: clamp(1.375rem, 3vw, 1.75rem); font-weight: 700; letter-spacing: -0.02em; line-height: 1.25; }
  .lead { margin: 0.625rem 0 0; color: var(--ink); font-size: 0.9375rem; }
  ul { list-style: none; margin: 1.5rem 0; padding: 0; border-top: 1px solid rgb(38 59 81 / 0.12); }
  li { border-bottom: 1px solid rgb(38 59 81 / 0.10); }
  li a {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: 0.75rem 0.25rem; color: var(--ink); font-size: 0.875rem; font-weight: 600;
    text-decoration: none; transition: color 140ms ease;
  }
  li a::after {
    content: 'Open'; flex: none; padding: 0.2rem 0.7rem;
    border: 1px solid rgb(65 100 134 / 0.34); border-radius: 999px;
    background: #fff; color: var(--accent-hover); font-size: 0.75rem; font-weight: 600;
    box-shadow: 0 1px 2px rgb(20 42 66 / 0.05);
  }
  li a:hover { color: var(--accent-hover); }
  li a:hover::after { border-color: var(--accent); background: var(--accent-soft); }
  li a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 0.375rem; }
  .note { margin: 0.75rem 0 0; color: var(--muted); font-size: 0.8125rem; line-height: 1.55; }
</style>
</head>
<body>
<main>
<span class="badge">${statusBadge}</span>
<h1>${text('softwareNotices')}</h1>
<p class="lead">${text('softwareSummary')}</p>
<ul>${links.map(([href, key]) => `<li><a href="${escapeHtml(href)}">${text(key)}</a></li>`).join('\n')}</ul>
<p class="note">${text(source ? 'sourceRecorded' : 'sourceUnknown')}</p>
<p class="note">${text('sourceCaveat')}</p>
</main>
</body>
</html>\n`);
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
