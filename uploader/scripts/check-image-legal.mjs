// Release-time legal artifact gate for one built app image (#291). Read-only:
// it never runs the image — files are extracted from a stopped container with
// `docker cp` and compared against the repository at the recorded revision.
//
//   node uploader/scripts/check-image-legal.mjs <image> [--platform linux/amd64]
//        [--revision <40-hex>] [--out <report.json>]
//
// Without --revision the image must record no source provenance (a default
// local build). With --revision it must record exactly that repository
// revision, which must also be the commit the release tag points at.
// Exit code 1 on any failed check. The report is evidence for the owner's
// release decision, not a legal clearance; see the #291 spec.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'laboef1900/simonswanderlust';
const LICENSE_SHA256 = '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0'; // GNU AGPL-3.0 primary text, spec §1
const GLYPH_OFL_SHA256 = '7713cfc8e3c36d5ec4aa3d6cffe7500a1b3310f8a86d914b8ea09c2a9dee7c2d'; // basemaps-assets fonts/OFL.txt at the pinned revision
const LEGAL_FILES = ['LICENSE.txt', 'NOTICE.txt', 'THIRD-PARTY-NOTICES.txt', 'notice-gaps.json', 'source-release.json',
  'third-party-inventory.json', 'third-party-evidence.json', 'third-party-image-evidence.json', 'de.html', 'en.html'];
// Browser-served assets copied out of npm packages (copy-fonts/copy-vendor/copy-easymde).
const SERVED_ASSETS = [
  ['fonts/inter-latin-wght-normal.woff2', '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'],
  ['fonts/ibm-plex-mono-latin-400-normal.woff2', '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'],
  ['fonts/ibm-plex-mono-latin-600-normal.woff2', '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2'],
  ['vendor/easymde.min.js', 'easymde/dist/easymde.min.js'],
  ['vendor/easymde.min.css', 'easymde/dist/easymde.min.css'],
  ['vendor/preact-htm.js', 'htm/preact/standalone.module.js'],
  ['vendor/maplibre-gl.mjs', 'maplibre-gl/dist/maplibre-gl.mjs'],
  ['vendor/maplibre-gl-worker.mjs', 'maplibre-gl/dist/maplibre-gl-worker.mjs'],
  ['vendor/maplibre-gl-shared.mjs', 'maplibre-gl/dist/maplibre-gl-shared.mjs'],
  ['vendor/maplibre-gl.css', 'maplibre-gl/dist/maplibre-gl.css'],
  ['vendor/maplibre-LICENSE.txt', 'maplibre-gl/LICENSE.txt'],
  ['vendor/pmtiles.js', 'pmtiles/dist/pmtiles.js'],
  ['vendor/fflate-LICENSE.txt', 'fflate/LICENSE'],
  ['vendor/font-awesome/css/font-awesome.min.css', 'font-awesome/css/font-awesome.min.css'],
  ['vendor/font-awesome/fonts/fontawesome-webfont.woff2', 'font-awesome/fonts/fontawesome-webfont.woff2'],
];
// Packages whose code/fonts reach browsers; their notices must be in the served aggregate.
const SERVED_PACKAGES = ['@fontsource-variable/inter', '@fontsource/ibm-plex-mono', 'easymde', 'codemirror', 'htm', 'preact', 'maplibre-gl', 'fflate'];
const SERVED_SUPPLEMENTS = ['pmtiles-LICENSE.txt', 'font-awesome-LICENSE.txt'];
// Platform builds are named `<pkg>-<os>-<arch>` (`@img/sharp-libvips-linux-arm64`) or
// `@scope/<os>-<arch>` (`@esbuild/linux-arm64`); both collapse to one family.
const PLATFORM_SUFFIX = /[-/](?:darwin|linux|linuxmusl|win32|freebsd|android|openbsd|wasm32|wasi)(?:-[a-z0-9]+)*$/;

const args = process.argv.slice(2);
const image = args.find((arg) => !arg.startsWith('--'));
const option = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const platform = option('--platform');
const revision = option('--revision');
const outPath = option('--out');
if (!image) throw new Error('Expected an image reference');
if (revision !== undefined && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('--revision must be a full 40-character commit');

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const docker = (...argv) => execFileSync('docker', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const checks = [];
const check = (id, ok, detail) => { checks.push({ id, ok: Boolean(ok), detail }); return ok; };

// Expected first-party files come from the recorded revision when there is one,
// so the comparison is against what was released, not whatever is checked out.
async function expected(path) {
  if (revision) {
    const result = spawnSync('git', ['-C', root, 'cat-file', '-p', `${revision}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git cannot read ${path} at ${revision}; fetch that commit first`);
    return result.stdout;
  }
  return readFile(join(root, path));
}
async function expectedList(dir) {
  if (revision) return execFileSync('git', ['-C', root, 'ls-tree', '--name-only', `${revision}:${dir}`], { encoding: 'utf8' }).trim().split('\n');
  return readdir(join(root, dir));
}

const inspect = JSON.parse(docker('image', 'inspect', image))[0];
const labels = inspect.Config?.Labels ?? {};
const created = docker('create', ...(platform ? ['--platform', platform] : []), image).trim();
const scratch = await mkdtemp(join(tmpdir(), 'image-legal-'));
const extracted = new Map();
async function fromImage(path) {
  if (extracted.has(path)) return extracted.get(path);
  const target = join(scratch, String(extracted.size));
  const copy = spawnSync('docker', ['cp', `${created}:${path}`, target], { encoding: 'utf8' });
  const bytes = copy.status === 0 ? await readFile(target).catch(() => null) : null;
  extracted.set(path, bytes);
  return bytes;
}
const text = async (path) => (await fromImage(path))?.toString('utf8') ?? null;
const same = (a, b) => a !== null && b !== null && Buffer.compare(a, b) === 0;

try {
  check('image.labels.licenses', labels['org.opencontainers.image.licenses'] === 'AGPL-3.0-only', labels['org.opencontainers.image.licenses'] ?? null);
  check('image.labels.source', labels['org.opencontainers.image.source'] === `https://github.com/${REPOSITORY}`, labels['org.opencontainers.image.source'] ?? null);
  if (revision) check('image.labels.revision', labels['org.opencontainers.image.revision'] === revision, labels['org.opencontainers.image.revision'] ?? null);

  const license = await fromImage('/app/LICENSE');
  check('app.LICENSE.sha256', license && sha256(license) === LICENSE_SHA256, license ? sha256(license) : 'missing');
  check('app.LICENSE.matches-repository', same(license, await expected('LICENSE')));
  const notice = await fromImage('/app/NOTICE');
  check('app.NOTICE.matches-repository', same(notice, await expected('NOTICE')));
  for (const tree of ['site', 'uploader']) {
    const manifest = await text(`/app/${tree}/package.json`);
    check(`${tree}.package.json.license`, manifest && JSON.parse(manifest).license === 'AGPL-3.0-only', manifest ? JSON.parse(manifest).license : 'missing');
  }

  const sourceText = await text('/app/source-release.json');
  let source;
  try { source = sourceText === null ? undefined : JSON.parse(sourceText); } catch { source = undefined; }
  if (revision) {
    check('app.source-release.json', source && source.repository === REPOSITORY && source.revision === revision, source ?? sourceText);
  } else {
    check('app.source-release.json.local-null', source === null, source ?? sourceText);
  }

  const docs = {};
  for (const name of ['third-party-inventory.json', 'third-party-evidence.json', 'third-party-image-evidence.json']) {
    docs[name] = await fromImage(`/app/docs/${name}`);
    check(`app.docs.${name}.matches-repository`, same(docs[name], await expected(`docs/${name}`)));
  }
  const inventory = docs['third-party-inventory.json'] ? JSON.parse(docs['third-party-inventory.json']) : null;
  for (const tree of ['site', 'uploader']) {
    const lock = await fromImage(`/app/${tree}/package-lock.json`);
    check(`inventory.lock.${tree}.fresh`, inventory && lock && inventory.lockfiles[tree].sha256 === sha256(lock),
      { inventory: inventory?.lockfiles[tree].sha256 ?? null, image: lock ? sha256(lock) : 'missing' });
  }
  check('inventory.evidence.digest', inventory && docs['third-party-evidence.json'] && inventory.evidence.sha256 === sha256(docs['third-party-evidence.json']));
  const evidence = docs['third-party-evidence.json'] ? JSON.parse(docs['third-party-evidence.json']) : null;
  const reviewedRows = evidence?.installedNoticeGapReview?.packages ?? [];
  const reviewedGaps = new Set(reviewedRows.map((row) => `${row.name}@${row.version}`));
  // The review scanned a Darwin host; the image carries the same packages' Linux platform builds.
  const reviewedFamilies = new Set(reviewedRows.map((row) => `${row.name.replace(PLATFORM_SUFFIX, '')}@${row.version}`));
  const supplements = await expectedList('uploader/scripts/vendor-licenses');

  for (const tree of ['site', 'uploader']) {
    const legal = `/app/${tree}/public/legal`;
    const present = {};
    for (const name of LEGAL_FILES) present[name] = (await fromImage(`${legal}/${name}`)) !== null;
    check(`${tree}.legal.files-present`, Object.values(present).every(Boolean), present);
    check(`${tree}.legal.LICENSE.txt`, same(await fromImage(`${legal}/LICENSE.txt`), license));
    check(`${tree}.legal.NOTICE.txt`, same(await fromImage(`${legal}/NOTICE.txt`), notice));
    for (const name of Object.keys(docs)) check(`${tree}.legal.${name}`, same(await fromImage(`${legal}/${name}`), docs[name]));
    check(`${tree}.legal.source-release.json`, (await text(`${legal}/source-release.json`)) === sourceText);

    const aggregate = await text(`${legal}/THIRD-PARTY-NOTICES.txt`);
    const headers = aggregate ? [...aggregate.matchAll(/^===== (.+) =====$/gm)].map((m) => m[1]) : [];
    const missingSupplements = supplements.filter((file) => !headers.includes(`Supplemental upstream notice: ${file}`));
    check(`${tree}.legal.supplements-retained`, aggregate && missingSupplements.length === 0, { missing: missingSupplements });
    if (tree === 'uploader') {
      const missingServed = SERVED_PACKAGES.filter((name) => !headers.some((h) => h.startsWith(`${name}@`)))
        .concat(SERVED_SUPPLEMENTS.filter((file) => !headers.includes(`Supplemental upstream notice: ${file}`)));
      check('uploader.legal.served-asset-notices', missingServed.length === 0, { missing: missingServed });
    }

    const gaps = JSON.parse(await text(`${legal}/notice-gaps.json`) ?? '{"packages":[]}').packages;
    const classified = { reviewed: [], platformVariantOfReviewed: [], unreviewed: [] };
    for (const gap of gaps) {
      const key = `${gap.name}@${gap.version}`;
      const family = `${gap.name.replace(PLATFORM_SUFFIX, '')}@${gap.version}`;
      (reviewedGaps.has(key) ? classified.reviewed : reviewedFamilies.has(family) ? classified.platformVariantOfReviewed : classified.unreviewed).push(key);
    }
    check(`${tree}.legal.notice-gaps-accounted`, classified.unreviewed.length === 0, classified);

    for (const locale of ['de', 'en']) {
      const html = await text(`${legal}/${locale}.html`) ?? '';
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      const localLinksResolve = hrefs.filter((href) => !href.startsWith('https:')).every((href) => present[href]);
      const sourceLinks = revision
        ? hrefs.includes(`https://github.com/${REPOSITORY}/archive/${revision}.tar.gz`) && hrefs.includes(`https://github.com/${REPOSITORY}/tree/${revision}`)
        : !hrefs.some((href) => href.includes('/archive/') || href.includes('/tree/'));
      check(`${tree}.legal.${locale}.html`, html.includes(`<html lang="${locale}">`) && localLinksResolve && sourceLinks, { hrefs });
    }
  }

  for (const [served, packaged] of SERVED_ASSETS) {
    check(`uploader.served.${served}`, same(await fromImage(`/app/uploader/public/${served}`), await fromImage(`/app/uploader/node_modules/${packaged}`)));
  }
  for (const file of SERVED_SUPPLEMENTS) {
    check(`uploader.served.vendor/${file}`, same(await fromImage(`/app/uploader/public/vendor/${file}`), await expected(`uploader/scripts/vendor-licenses/${file}`)));
  }

  const dockerfile = (await expected('Dockerfile')).toString('utf8');
  const pinnedGlyphs = dockerfile.match(/^ARG GLYPHS_REVISION=([a-f0-9]{40})$/m)?.[1] ?? null;
  const glyphRevision = (await text('/map-assets/GLYPHS_REVISION'))?.trim() ?? null;
  check('map.glyphs.revision', pinnedGlyphs && glyphRevision === pinnedGlyphs, { image: glyphRevision, dockerfile: pinnedGlyphs });
  const ofl = await fromImage('/map-assets/fonts/OFL.txt');
  check('map.glyphs.OFL.txt', ofl && sha256(ofl) === GLYPH_OFL_SHA256, ofl ? sha256(ofl) : 'missing');
  for (const stack of ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']) {
    check(`map.glyphs.${stack}`, (await fromImage(`/map-assets/fonts/${stack}/0-255.pbf`)) !== null);
  }
  const basemapBuild = (await text('/map-assets/BASEMAP_BUILD'))?.trim() ?? null;
  check('map.basemap.build-recorded', basemapBuild && /^\d{8}$/.test(basemapBuild), basemapBuild);
  check('map.basemap.present', (await fromImage('/map-assets/basemap.pmtiles'))?.length > 0);
} finally {
  spawnSync('docker', ['rm', created]);
  await rm(scratch, { recursive: true, force: true });
}

const report = {
  checkedAt: new Date().toISOString(),
  image, imageId: inspect.Id, repoDigests: inspect.RepoDigests, platform: `${inspect.Os}/${inspect.Architecture}`,
  mode: revision ? { release: true, repository: REPOSITORY, revision } : { release: false, note: 'local/unversioned build; no release is certified' },
  labels,
  passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length,
  checks,
  scope: 'Presence/correspondence of first-party license texts, notices, inventories, provenance, served asset notices and map notices in one image. Not a legal clearance, SBOM or native corresponding-source verdict.',
};
if (outPath) await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.ok ? '' : ' ' + JSON.stringify(c.detail)}`);
console.log(`${report.failed === 0 ? 'PASS' : 'FAIL'}: ${report.passed} passed, ${report.failed} failed — ${image} (${report.platform}) id ${inspect.Id}`);
process.exitCode = report.failed === 0 ? 0 : 1;
