import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'legal-assets-'));
  roots.push(root);
  const put = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await put('uploader/scripts/vendor-licenses/supplement.txt', 'Supplemental original notice\r\n');
  await copyFile(new URL('../scripts/copy-legal.mjs', import.meta.url), join(root, 'uploader/scripts/copy-legal.mjs'));
  await mkdir(join(root, 'site/src/i18n'), { recursive: true });
  await copyFile(new URL('../../site/src/i18n/ui.ts', import.meta.url), join(root, 'site/src/i18n/ui.ts'));
  await put('LICENSE', 'First-party license\n');
  await put('NOTICE', 'First-party rights exclusions\n');
  await put('docs/third-party-inventory.json', '{"inventory":true}\n');
  await put('docs/third-party-evidence.json', '{"evidence":true}\n');
  await put('docs/third-party-image-evidence.json', '{"images":[]}\n');
  return { root, put, run: (tree: string, ...source: string[]) => execFileSync(process.execPath, [join(root, 'uploader/scripts/copy-legal.mjs'), tree, ...source]) };
}

describe('static legal distribution', () => {
  it.each(['site', 'uploader'])('delivers verbatim notices and usable localized links for %s', async (tree) => {
    const { root, put, run } = await fixture();
    await put(`${tree}/package-lock.json`, JSON.stringify({ packages: {
      '': { name: tree },
      'node_modules/one': { version: '1.0.0', license: 'MIT' },
      'node_modules/one/node_modules/two': { version: '2.0.0', license: 'BSD-3-Clause' },
      'node_modules/no-notice': { version: '1.0.0', license: 'MIT' },
      'node_modules/optional-absent': { version: '1.0.0', optional: true },
    } }));
    await put(`${tree}/node_modules/one/LICENSE`, 'Copyright A\r\nPermission A\r\n');
    await put(`${tree}/node_modules/one/licenses/embedded.txt`, 'Embedded component notice\n');
    await put(`${tree}/node_modules/one/node_modules/two/NOTICE.txt`, 'Nested package notice\n');
    await put(`${tree}/node_modules/no-notice/package.json`, '{}');
    run(tree);
    const out = join(root, tree, 'public/legal');
    const notices = await readFile(join(out, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    for (const text of ['Copyright A\r\nPermission A\r\n', 'Embedded component notice\n', 'Nested package notice\n', 'Supplemental original notice\r\n']) expect(notices).toContain(text);
    expect(await readFile(join(out, 'LICENSE.txt'), 'utf8')).toBe(await readFile(join(root, 'LICENSE'), 'utf8'));
    expect(JSON.parse(await readFile(join(out, 'notice-gaps.json'), 'utf8')).packages).toEqual([
      { path: 'node_modules/no-notice', name: 'no-notice', version: '1.0.0', license: 'MIT' },
    ]);
    for (const locale of ['de', 'en']) {
      const html = await readFile(join(out, `${locale}.html`), 'utf8');
      expect(html).toContain(`<html lang="${locale}">`);
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
      expect(hrefs).toContain('LICENSE.txt');
      expect(hrefs).toContain('https://github.com/laboef1900/simonswanderlust');
      for (const href of hrefs.filter((href) => !href.startsWith('https:'))) expect((await readFile(join(out, href))).length).toBeGreaterThan(0);
    }
    // Regenerating must replace stale notices, not append duplicates/old terms.
    await put(`${tree}/node_modules/one/LICENSE`, 'Replacement permission\n');
    run(tree);
    const refreshed = await readFile(join(out, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    expect(refreshed).not.toContain('Permission A');
    expect(refreshed).toContain('Replacement permission\n');
  });
  it('retains exact release source links across runtime site regeneration', async () => {
    const { root, put, run } = await fixture();
    await put('site/package-lock.json', '{"packages":{}}');
    const revision = 'abc123'.repeat(6) + 'abcd';
    run('site', 'owner/project', revision);
    run('site'); // Runtime Astro rebuild keeps the image's recorded provenance.
    for (const locale of ['de', 'en']) {
      const html = await readFile(join(root, `site/public/legal/${locale}.html`), 'utf8');
      expect(html).toContain(`https://github.com/owner/project/archive/${revision}.tar.gz`);
      expect(html).toContain(`https://github.com/owner/project/tree/${revision}`);
    }
    expect(JSON.parse(await readFile(join(root, 'site/public/legal/source-release.json'), 'utf8'))).toEqual({ repository: 'owner/project', revision });
    run('site', '', ''); // A local Docker build must not inherit an upstream claim.
    expect(await readFile(join(root, 'site/public/legal/en.html'), 'utf8')).not.toContain('/archive/');
    expect(JSON.parse(await readFile(join(root, 'site/public/legal/source-release.json'), 'utf8'))).toBeNull();
  });

  it.each([
    ['owner/project" onclick="bad', 'a'.repeat(40)],
    ['owner/..', 'a'.repeat(40)],
    ['owner/project', 'main'],
    ['', 'a'.repeat(40)],
    ['owner/project', ''],
  ])('refuses invalid or incomplete source identifiers %s %s', async (repository, revision) => {
    const { put, run } = await fixture();
    await put('site/package-lock.json', '{"packages":{}}');
    expect(() => run('site', repository, revision)).toThrow();
  });

  it('refuses malformed stored provenance instead of rendering an unsafe source link', async () => {
    const { put, run } = await fixture();
    await put('site/package-lock.json', '{"packages":{}}');
    await put('source-release.json', '{"repository":"owner/project","revision":"\\" onclick=\\"bad"}');
    expect(() => run('site')).toThrow();
  });
});

// #291: the published inventory (and the legal/ copies built from it) must describe the
// dependencies that actually ship. A lockfile or evidence change without
// `node uploader/scripts/generate-third-party-inventory.mjs` silently publishes stale notices.
describe('committed third-party inventory', () => {
  it('was generated from the committed lockfiles and evidence', async () => {
    const root = new URL('../../', import.meta.url);
    const digest = async (path: string) => createHash('sha256').update(await readFile(new URL(path, root))).digest('hex');
    const inventory = JSON.parse(await readFile(new URL('docs/third-party-inventory.json', root), 'utf8'));
    const stale = [];
    for (const tree of ['site', 'uploader']) {
      if (inventory.lockfiles[tree].sha256 !== await digest(`${tree}/package-lock.json`)) stale.push(`${tree}/package-lock.json`);
    }
    if (inventory.evidence.sha256 !== await digest(inventory.evidence.path)) stale.push(inventory.evidence.path);
    if (inventory.imageEvidence.sha256 !== await digest(inventory.imageEvidence.path)) stale.push(inventory.imageEvidence.path);
    expect(stale, 'regenerate with: node uploader/scripts/generate-third-party-inventory.mjs').toEqual([]);
  });
});
