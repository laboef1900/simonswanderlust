# Issue #347: upgrade sharp so untrusted AVIF and SVG input stops reaching vulnerable codecs

**Status: OWNER APPROVED, 2026-10-27.** The owner selected **“Approve upgrade; roll forward
only”** for PR #403 at `57f986a109d0ed7d8c6339723b8247cddbbe9bcb` in the implementation
session. This authorizes the specified sharp 0.35.5/libvips 1.3.4 upgrade, not deployment or a
rollback to vulnerable codecs. Under `CLAUDE.md` this remains high risk. Local suites and both
candidate-image runtime checks passed (§12); final-head independent review and CI remain required.

Baseline: `origin/dev` @ `11e16d1b8e43141d296b801ee663a351ae3fe415`, app version `0.17.1`.
Related: #369, the wider production-dependency and `trustProxy` work. §9 fixes the order of the two.

## 1. Baseline problem (verified against the original tree and upstream)

| Fact | Evidence |
| --- | --- |
| `uploader/package.json:36` declares `"sharp": "^0.35.3"`. `uploader/package-lock.json` resolves `sharp` 0.35.3, `@img/sharp-linux-{x64,arm64}` 0.35.3 and `@img/sharp-libvips-linux-{x64,arm64}` 1.3.2. | lockfile |
| `site/package.json` has no direct sharp dependency. `site/package-lock.json` resolves `sharp` 0.35.3 (`"optional": true`) as an optional dependency of `astro@7.0.6` (`"sharp": "^0.34.0 \|\| ^0.35.0"`), with libvips 1.3.2. | lockfile |
| `@img/sharp-libvips-linux-x64@1.3.2` ships `heif 1.23.1`, `rsvg 2.62.90` and `vips 8.18.3` (its `versions.json`), matching the issue's runtime probe. | `npm pack`, then `package/versions.json` |
| GHSA-rgj7-g3m4-5g8c covers libheif (High 8.9, CWE-122). Affected `< 0.35.4`, patched `>= 0.35.4`. It can lead to RCE on glibc Linux; the advisory names a `node` binary built as a position-independent executable (PIE) as part of the hardening. | [advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c) |
| GHSA-wq5f-xc86-pv6w covers librsvg CVE-2026-96889 (High 8.9, CWE-416). Affected `< 0.35.5`, patched `>= 0.35.5` (librsvg 2.63.2). The RCE preconditions are the same. | [advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) |
| sharp 0.35.4 (libvips 1.3.3) ships `heif 1.23.2` but still `rsvg 2.62.91`. **0.35.5 is the lowest release that clears both advisories.** | `versions.json` of `@img/sharp-libvips-linux-x64@1.3.3` |
| GHSA-f88m-g3jw-g9cj (libvips, `< 0.35.0`) is already fixed at 0.35.3. The two advisories above are the only open sharp advisories. | [advisory list](https://github.com/lovell/sharp/security/advisories) |
| Every decode path runs on the prebuilt libvips. See the list after this table. | code read |
| AVIF decodes as `heif` (`pipeline.ts:31-33`). SVG is rasterised, and its original is deliberately stored as `-orig.png` (`pipeline.ts:104-118`, pinned by `pipeline.test.ts:172`). | code read |
| The site tree never calls sharp: no `astro:assets`, no `<Image>`, no `image` config. Astro loads sharp only to optimise images. The package is still installed by `npm ci` in the `site-build` stage and copied into the runtime image. | grep of `site/src`, `site/astro.config.mjs`; `Dockerfile` |
| The native binaries are installed at **image build time** and copied into the runtime stage. A running container keeps the codecs it was built with. | `Dockerfile` (`uploader-build`, `site-build`) |
| The supported release platforms are `linux/amd64` and `linux/arm64`, both built on the DHI glibc bases. The repo does not record the deployed server's architecture. | `.github/workflows/release.yml:58`, `README.md:112,273`, `ARCHITECTURE.md:672` |

Decode paths into `probeImage`, `encodeVariant` and `processImage` (`pipeline.ts:112-201`):

- `POST /upload`, guarded by `requireAuth`, so **any author** can reach it. The only format gate
  is the mimetype the client chooses, which must start with `image/` (`server.ts:440`).
- The async encode queue, and `POST /media/retry` (`requireAuth`).
- `POST /settings/image-preview` (`requireAdmin`).
- The WXR re-host (`wp-images.ts:41`, `requireAdmin`). These are **bytes fetched from third-party
  hosts**.

Stored originals are also decoded with `sharp(file).metadata()`:

- `media-sync.ts:137`, at boot and on `POST /media/rescan`;
- `wp-images.ts:144`, when an import resumes;
- `exif-audit.ts:104`, from the CLI.

Risk framing: everyone who submits images is authenticated, except the WXR import, which decodes
bytes from WordPress-era third-party hosts. I have not established whether the bugs are
exploitable in the DHI runtime; §6 measures the relevant facts (glibc, and whether `node` is PIE).

## 2. Recommended contract

### Exact pins and codec provenance

Pin **sharp 0.35.5** in **both** trees. It is the current npm `latest`, published 2026-09-27; the
`next` tag points at the older 0.35.5-rc.1. Pin its platform and libvips packages as follows:

| Package | Version | `dist.integrity` (npm registry) | npm provenance |
| --- | --- | --- | --- |
| `sharp` | 0.35.5 | `sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==` | SLSA v1. Git tag `v0.35.5` = commit `51a990faa26ade5586a4934ac9673c98d8893326`, signed by the maintainer (GPG `26C1635893ACB81F`). |
| `@img/sharp-linux-x64` | 0.35.5 | `sha512-SxFtLTeJInhAA9Q836kux2vZNeOBQEx658qvbboZScr0wIARym3IcGmW7KpVD5sbVg0Ojy+udFQdayYIZyoNog==` | SLSA v1, `libc: ["glibc"]` |
| `@img/sharp-linux-arm64` | 0.35.5 | `sha512-LYVx5JTsOM2CBzmxreh+nl64/3H6Xb09iSLknqH47z2T2DFFxDeFLP5y4dJwe6H7uGQlHPyEEtIqyo3DYsRwdQ==` | SLSA v1 |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | `sha512-GJ//SSXbnwSDes02umB3nDJLFcQzw8a18V8fyhqr6tV515tOEMdImjjxj1AoafMRz56F3PHgftnj1QEKSU1zkw==` | SLSA v1, `libc: ["glibc"]` |
| `@img/sharp-libvips-linux-arm64` | 1.3.4 | `sha512-Y3dgX/6lE2QhQb+Gxy0WZxfg9MEm/JBjamZpS2IklP7xIQoKN4hzAm7KcMVGtaVDt3neE9OKBC7vAfonA/Lr1A==` | SLSA v1 |
| `@img/sharp-darwin-arm64` and `@img/sharp-libvips-darwin-arm64` (dev machines) | 0.35.5 and 1.3.4 | `sha512-QRUlFQ0WxvdWyqqG/WtI3iupfD5rBzmCHXSdPsY91sAtVtTo7Q4cb6zOccZ3gqEqkr0f1As1ehLqmEpDsRf+lg==` and `sha512-5R89nBYiRdUlSWJxPhO+GVtaXzXSxKnRu/xqMn3KTA3L9EB9Oy/P+Nn2f2vlhPuUdy/Zusb2DarbyTpGCfEDuw==` | SLSA v1 |

Package-set changes:

- Every other `@img/sharp-*` platform entry already in the locks moves to the same
  0.35.5 / 1.3.4 pair.
- sharp 0.35.5 declares exactly the same `@img/*` optional-package set as 0.35.3.
- Its runtime dependency ranges are unchanged: `@img/colour ^1.1.0`, `detect-libc ^2.1.2`,
  `semver ^7.8.5`.

Codec provenance, read from each package's `versions.json`:

| libvips package 1.3.4 | heif | rsvg | vips | aom | webp | exif |
| --- | --- | --- | --- | --- | --- | --- |
| linux-x64, linux-arm64, linuxmusl-x64, linuxmusl-arm64, darwin-arm64 | **1.23.5** | **2.63.2** | 8.18.7 | 3.15.1 | 1.6.0 | 0.6.26 |

The required floors are heif ≥ 1.23.2 and rsvg ≥ 2.63.2. Both supported release platforms meet them.

### Upstream changes from 0.35.3 to 0.35.5

Sources: the [0.35.4](https://github.com/lovell/sharp/releases/tag/v0.35.4) and
[0.35.5](https://github.com/lovell/sharp/releases/tag/v0.35.5) release notes.

- coordinate bounds for resize and composite;
- palette bit-depth rounding;
- `tiff.subifd`;
- `info.pages`;
- stream-end handling;
- bounds checks on `linear` and GIF `delay`;
- WebAssembly-fallback errors;
- JXL TypeScript options;
- removal of one non-existent named TypeScript export;
- `extend` dimensions;
- gain-map `extract`/`rotate`.

The repo imports sharp only as its default export; grep found no named imports. sharp 0.35.x has
no install lifecycle script.

### Files to change (implementation PR, after approval)

Edit only these files:

1. `/Users/simon/localGIT/simonswanderlust-issue-347/uploader/package.json`
   - Change `"sharp": "^0.35.3"` to `"^0.35.5"`, so a fresh resolve can never pick a vulnerable
     release.
   - Rename the `allowScripts` key `"sharp@0.35.3": true` to `"sharp@0.35.5": true`. A key for an
     uninstalled version would be dead weight.
   - Regenerate `/Users/simon/localGIT/simonswanderlust-issue-347/uploader/package-lock.json`
     with `npm install sharp@0.35.5` (Node 26).
2. `/Users/simon/localGIT/simonswanderlust-issue-347/site/package-lock.json`
   - Run `npm update sharp`. `site/package.json` stays unchanged: sharp remains Astro's optional
     transitive dependency.
   - Fallback, only if npm will not move the transitive entry: a scoped
     `"overrides": { "sharp": "0.35.5" }` in
     `/Users/simon/localGIT/simonswanderlust-issue-347/site/package.json`. The PR states that this
     was needed; #369's Astro bump removes it.
3. Lock review rule:
   - The diff is limited to `sharp`, `@img/sharp-*`, `@img/sharp-libvips-*` and their required
     dependency changes. `@img/sharp-wasm32@0.35.5` requires `@emnapi/runtime ^1.11.3`, so both
     locks must advance runtime 1.11.2 → 1.11.3; retaining 1.11.2 makes `npm ci` fail.
   - `semver` and `detect-libc` may move only if npm re-dedupes them inside their existing ranges.
   - Unrelated package movement remains #369's scope; no broad audit fix is part of #347.
4. Permanent tests (behaviour, not version text):
   - `/Users/simon/localGIT/simonswanderlust-issue-347/uploader/test/pipeline.test.ts` gains AVIF
     **input** cases:
     - A generated AVIF through `processImage` yields `original.ext === 'avif'`, the original
       bytes unchanged, and avif+webp variants at `variantWidths(width)`.
     - An AVIF carrying Make/Model and a GPS IFD (`withExif`, IFD3) yields variants with no
       `GPSInfo`. The test first asserts that the **input's** EXIF really holds GPS, so it cannot
       pass vacuously.
   - `/Users/simon/localGIT/simonswanderlust-issue-347/uploader/test/server.test.ts`, in the
     `/settings/image-preview` describe block, gains AVIF-input and SVG-input cases. Each returns
     200 with the requested format, the correct dimension headers and no EXIF. Today that route is
     exercised only with JPEG input (`gpsJpeg`).
   - These tests must keep passing unmodified, because they are the consumer contract:
     JPEG/GPS (`pipeline.test.ts:101`), the allow-list (`:111-136`), SVG → `png` (`:172`), and
     the preview EXIF strip (`server.test.ts:3611`).
5. Docs:
   - `/Users/simon/localGIT/simonswanderlust-issue-347/SECURITY.md`: see §8.
   - `/Users/simon/localGIT/simonswanderlust-issue-347/ARCHITECTURE.md`, release flow section: a
     native codec fix ships only through a new image, and the previous image's digest is recorded
     before deploying.
   - `/Users/simon/localGIT/simonswanderlust-issue-347/CLAUDE.md`, *Project Status*: implementation
     evidence with an explicit release-pending qualification.
   - Historical plans are not edited.

### Rejected alternatives

- **Stop at sharp 0.35.4.** It keeps rsvg 2.62.91, which is inside GHSA-wq5f.
- **Use the advisory workaround (`sharp.block` of the HEIF/SVG loaders) instead of upgrading.**
  It would remove accepted upload formats, and the issue forbids changing format guards.
  Decoder blocking is **out of scope** for #347.
- **Use a globally installed system libvips.** It needs a native toolchain in the DHI `-dev`
  stage and distro patch tracking, which is more supply-chain surface than the attested prebuilt
  packages.
- **Add a direct `sharp` dependency to `site/package.json`.** It would misstate a dependency the
  site never calls, and it would outlive #369's Astro bump.
- **Add permanent tests that assert lock or version text.** They test manifest wording, not
  behaviour. The version floor is checked once, by a throwaway smoke run against the loaded
  binary (§6.C).
- **Fold #347 into #369.** #369 waits on a separate `trustProxy` security design, and the issue
  asks for the sharp fix to remain independently trackable.

## 3. Trust boundaries and misuse cases

| Boundary | Who supplies bytes | Misuse | Control after this change |
| --- | --- | --- | --- |
| `POST /upload` → encode queue | any authenticated author | crafted AVIF/SVG hitting a libheif/librsvg memory-safety bug | patched codecs; existing 25 MiB / one-part cap, `mem_limit`, work-lock, fixed-enum error recording (unchanged) |
| WXR re-host | third-party hosts named in the export (an admin starts the import) | hostile image behind an attacker-controlled media URL | patched codecs; `safeFetch` SSRF guards and byte cap (unchanged) |
| `POST /settings/image-preview` | admin | as above, in memory | patched codecs; single-flight and work-lock (unchanged) |
| boot/rescan `metadata()` on stored originals | whatever was stored earlier | a malicious original stored under the vulnerable image is re-parsed on every boot | patched codecs; this re-opens under rollback (§7) |
| sharp in the `site` tree | nobody today | a future `astro:assets` use would decode with the locked version | the same pin; §6.C checks the site copy in the built image |

Unchanged: authorization, decoder and format policy, the SVG → `-orig.png` mapping, the EXIF
allow-list, and `redactForNonAdmin`.

## 4. Invariants (must hold before and after)

1. Public variants carry only the EXIF allow-list (`exif.ts`) plus ICC: no GPS IFD, XMP, IPTC or
   Orientation. Preview output carries no EXIF. Originals keep their full metadata and are never
   served.
2. An SVG original is stored as `-orig.png`, never `-orig.svg` (the stored-XSS guard).
3. AVIF originals keep ext `avif`. The JPEG-only profile still emits `.jpeg` variants through the
   same allow-list.
4. Variant filenames and widths (`variantWidths`, `formatsFor`) are unchanged, so media-sync's
   `isCompleteSet` judges existing sets exactly as before.
5. Nothing changes in the schema, the `/data` layout, settings or routes. The upgrade rewrites no
   existing variant.
6. Each tree resolves exactly one sharp: `npm ls sharp` shows a single `0.35.5`.

## 5. Rebuild and deployment requirement

- A lock change alone patches nothing that is running. The codecs live in the image layers. The
  fix reaches production only through:
  1. a new release image, built by `release.yml` from a `v*.*.*` tag for amd64 and arm64;
  2. an `IMAGE_TAG` bump on the server;
  3. `docker compose pull && docker compose up -d`.
- Tagging, releasing and deploying are owner actions outside this work. This spec only documents
  that they are required.
- A developer `node_modules` stays vulnerable until `npm ci` runs in each tree.
- `/data/site` releases need no republish: they contain no sharp output.
- Existing variants need no re-encode: the advisories concern decoders, and variants are output.
  - New uploads get new content-hash and profile keys, so no public URL is overwritten.
  - A later `POST /media/retry` re-encodes into the same filenames (idempotent by design) with
    the new libraries.
- New AVIF/WebP bytes may differ slightly from the 0.17.1 output (vips 8.18.3 → 8.18.7, aom
  3.14.1 → 3.15.1). This is expected and has no contract impact.

## 6. Acceptance verification

Ordinary local and CI coverage stays the primary evidence: the full Vitest suites in both trees,
on developer machines and on CI. The container checks in C and D are **additional**: they prove
that the shipped Linux image loads the patched codecs and that the same consumer behaviour holds
there. They do not replace or narrow any suite. All of A–D must pass, with results recorded in
the PR. E is the owner's post-deploy check.

**A. Dependency resolution (local).**
- `npm ls sharp` in each tree shows a single 0.35.5.
- One `npm audit --omit=dev` per tree on the PR head lists neither GHSA-rgj7-g3m4-5g8c nor
  GHSA-wq5f-xc86-pv6w.
- Expected result in the site tree: the Astro advisory GHSA-26w7-cxv4-gfx2 (`astro < 7.2.8`)
  **remains** until #369, because it is keyed on the Astro version, not on the codec. The PR
  states this, with the evidence that sharp is not called: no `astro:assets`, no `<Image>`, no
  image config, static output, no image endpoint.

**B. Local and CI suites (Linux x64 glibc on CI; the developer's platform locally).**
- Uploader: the full suite, with `TEST_DATABASE_URL` set so the Postgres-backed suites run, and
  `npx tsc --noEmit`.
- Site: `npm test`, `npx astro check` and `npm run build`.
- This covers the new AVIF-input and preview tests and the existing JPEG/GPS, allow-list and SVG
  tests. It also covers the import suites (`wp-images`, `wp-import`) and the encode-queue and
  media-sync suites.

**C. Throwaway loaded-codec smoke in the shipped image, on both supported platforms.**

Build with the release bases, for `<arch>` in `amd64` and `arm64`:

```
docker build --platform linux/<arch> -t sw347:<arch> /Users/simon/localGIT/simonswanderlust-issue-347
```

Use the default DHI `NODE_BUILD`/`NODE_RUNTIME`. The `node:26-slim` fallback does not count: it is
not the shipped base. arm64 runs natively on Apple silicon; amd64 runs under emulation.

The smoke script is **not committed**. It lives in the worktree's ignored scratch directory,
outside tracked source and owner data, is mounted read-only, and uses only image-provided
dependencies (`sharp`, `/app/uploader/src/{pipeline,exif,variants}.ts`, tsx and Node built-ins).

```
docker run --rm --platform linux/<arch> --network none --read-only --tmpfs /tmp --user 1000 \
  -v <scratch>/smoke.ts:/probe/smoke.ts:ro --entrypoint node sw347:<arch> --import tsx /probe/smoke.ts
```

The script exits non-zero on any failed assertion and prints:

- `process.arch`.
- `process.report.getReport().header.glibcVersionRuntime`. It must be defined, so the glibc
  `linux-*` package was loaded.
- The PIE status of `process.execPath`: the ELF `e_type` at byte offset 16 is 3 for PIE (DYN)
  and 2 for a non-PIE executable (EXEC). This is **measured evidence** for §7 and SECURITY.md, not
  a gate.
- `sharp.versions` for `/app/uploader`, and for `/app/site` via
  `createRequire('/app/site/package.json')`. Both must report sharp 0.35.5, heif 1.23.5,
  rsvg 2.63.2 and vips 8.18.7.

It then runs `processImage` on benign generated inputs:

| Input | Profiles | Expected result |
| --- | --- | --- |
| JPEG with Make/Model and a GPS IFD | default and `convertJpeg:false` | no variant has `GPSInfo` under `readExif`; Make/Model kept |
| 16×16 AVIF | default | ext `avif`; avif+webp variants |
| 16×16 SVG | default | ext `png`; avif+webp variants |

**D. Container end-to-end on a disposable stack (both platforms; never the repo compose file).**

`docker-compose.yml` bind-mounts `./uploader/data` and uses the real `pgdata` volume, so the
stack is assembled by hand:

- a dedicated network;
- `postgres:18-alpine` with a throwaway generated password and the named volume `sw347-pg`;
- the app with the named volume `sw347-data` on `/data`, published on `127.0.0.1:3300`, with
  `PUBLIC_BASE_URL=http://localhost:3300` and `IMG_HOST=localhost:3300`.

Steps:

1. Create a throwaway admin through `/setup`, with a CSPRNG password that is never echoed or
   logged.
2. Upload the three fixtures with `POST /upload`, using the multipart shape from
   `test/server.test.ts`, until `GET /media` shows `ready`.
3. Fetch every variant through the image host: expect 200 and the correct `Content-Type`.
4. Run `docker exec … node --import tsx src/cli.ts audit-exif`: it must report **zero** GPS
   variants while the JPEG original holds GPS.
5. Call `POST /settings/image-preview` for each fixture, with `format=avif` and with
   `format=webp`: expect 200 and no EXIF.
6. Call `POST /media/rescan`: the report has no errors.

The WXR import stays covered by B. A hermetic container import would need `safeFetch` to accept
loopback or private addresses, and weakening that guard is forbidden. Its decode step is the same
`processImage` that C proves. Cleanup removes only the `sw347-*` containers, network and volumes.

**E. Post-deploy (owner, after the owner's own release).**
1. Before switching, record the digest of the current image (§7).
2. After `up -d`, `/health` is green, and
   `docker exec app node -e "console.log(require('sharp').versions)"` (exec form, working
   directory `/app/uploader`) reports the §2 versions.
3. Upload one real photo: the variants render, and `audit-exif` still reports zero GPS variants.

## 7. Recovery and containment: roll forward only

The owner expressly declined authorization to restore vulnerable codecs. Recover from a
0.35.5-specific regression with a corrected, tested image that retains the patched codec
floors; do not downgrade to 0.35.3 or 0.35.4.

There is no schema, `/data` layout or settings migration. Existing originals, variants and
static releases remain compatible files. Preserve them and the database while diagnosing a
failure; never re-import, wipe storage or restore content merely to undo this dependency change.

A previous image may be retained as diagnostic evidence, but its existence is not permission
to deploy it. Returning to heif 1.23.1 or rsvg 2.62.90 would reintroduce the vulnerabilities,
including in boot reconciliation and rescan of retained originals. Avoiding new uploads
alone does not make that downgrade safe. Release and deployment remain separate owner actions.


## 8. SECURITY.md reconfirmation (implementation PR)

- Reconfirm *Published image metadata (allow-list)* unchanged.
- Add a short "Native image decoders" note covering four points:
  - decoding uses sharp's prebuilt libvips, which changes only through an image rebuild and
    redeploy;
  - the codec versions the shipped image was verified with;
  - the measured PIE status of the shipped `node`;
  - the roll-forward-only recovery constraint from §7.
- The upload, import and preview authorization text stays unchanged.

## 9. Dependency contracts and ordering

DesignProxy369, the author of #369's design, has confirmed the following.

- **#347 lands first** as a narrow lock change. #369 rebases onto it.
- #369 owns the Astro ≥ 7.2.8 bump and every non-sharp package. `astro@7.2.8` declares optional
  `sharp ^0.35.4`, and so does the current `latest`, 7.4.2; both admit 0.35.5.
- #369 must keep sharp at 0.35.5 or later and libvips at 1.3.4 or later in both locks, keep the
  `allowScripts` key `sharp@0.35.5`, and re-run §6.A and §6.C after it regenerates the locks.
  #369 adds no permanent version guard of its own either.
- If #369 had to land first, it would carry no sharp change, and #347 would regenerate on top of
  it.
- The site `overrides` fallback (§2), if it was used, is removed by #369's Astro bump.
- No other open spec owns `pipeline.ts`, the locks or the Dockerfile bases.

## 10. Owner approval record

- **Approver:** repository owner, interactive implementation session.
- **Date:** 2026-10-27.
- **Evidence:** the answer **“Approve upgrade; roll forward only”** to the approval question
  linked to PR #403 at `57f986a109d0ed7d8c6339723b8247cddbbe9bcb`.
- **Approved:** §2's upgrade in both trees, preserving formats and EXIF controls, before #369.
- **Not authorized:** a vulnerable-codec rollback, release, deployment or decoder-policy change.


## 11. Evidence sources

- Advisories:
  - [GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
  - [GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)
  - [GHSA-f88m-g3jw-g9cj](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj)
  - [astro GHSA-26w7-cxv4-gfx2](https://github.com/withastro/astro/security/advisories/GHSA-26w7-cxv4-gfx2)
- Release notes: [sharp v0.35.5](https://github.com/lovell/sharp/releases/tag/v0.35.5),
  [sharp v0.35.4](https://github.com/lovell/sharp/releases/tag/v0.35.4).
- npm registry, queried 2026-10-27:
  - `npm view sharp versions dist-tags`;
  - `npm view <pkg>@<ver> dist.integrity dist.attestations.provenance.predicateType optionalDependencies libc`;
  - `npm view astro@{7.2.8,latest} optionalDependencies`.
- `versions.json` from `npm pack` of:
  - `@img/sharp-libvips-{linux-x64,linux-arm64,linuxmusl-x64,linuxmusl-arm64,darwin-arm64}@1.3.4`;
  - `@img/sharp-libvips-linux-x64@{1.3.2,1.3.3}`.
- Repo files at the baseline, all under `/Users/simon/localGIT/simonswanderlust-issue-347`:
  - `uploader/package.json` and both lockfiles;
  - `Dockerfile`, `docker-compose.yml`, `.github/workflows/{ci,release}.yml`;
  - `uploader/src/{pipeline,server,media-sync,wp-images,exif-audit}.ts`;
  - `uploader/test/{pipeline,server}.test.ts`;
  - `SECURITY.md` (*Published image metadata*), `ARCHITECTURE.md` (release flow) and `README.md`.

## 12. Implementation verification, 2026-10-27

- `npm ci` succeeded in both trees. `npm ls sharp` reports one 0.35.5 per tree, without a site
  override or a direct site sharp dependency.
- Uploader typecheck passed. Focused pipeline/server/EXIF/audit suites passed (4 files,
  274 tests), then the complete uploader suite passed (101 files, 2,333 tests) with isolated
  Postgres integration enabled. Site: 367 tests passed; Astro check reported zero errors,
  warnings and hints; production build passed. Existing build notices about the map chunk and
  empty fixture collection were not suppressed.
- Production-only audits contain neither sharp advisory. Other vulnerabilities remain for #369:
  uploader 3 high; site 10 high and 1 critical. In particular the Astro advisory remains at
  Astro 7.0.6; this narrow fix does not claim to clear the whole dependency audit.
- Both images built from the unchanged release Dockerfile and default DHI bases. Scratch files
  and private env files were excluded from the build context. Base manifest digests:
  `dhi.io/node:26-dev@sha256:0c199c224fbc0dd15ca49b716ab92f9ffaee604f29e9a778d84e9b4ab7e9e771`;
  `dhi.io/node:26@sha256:dc87c509f7279f734d04036f696bf9aad1b8d66f34750f32c30c5b85e033187f`.

| Candidate | Execution | Local manifest-list digest |
|---|---|---|
| `swl-issue347:arm64` | Native Linux ARM64 in Docker | `sha256:0182855712073db3a7cde67dccbc930523682f3ef36ca55b78f588c213c468a8` |
| `swl-issue347:amd64` | Linux AMD64 under emulation | `sha256:0ffcb467ef23c2e4d85762ea9c50139024f639a4391e22d25fbdbdb7ba66e016` |

For **each** candidate:

- The network-disabled, read-only codec probe loaded the exact §2 versions from both trees,
  measured glibc 2.41 and PIE Node (`e_type=3`), and decoded/encoded ten variants across JPEG's
  modern/JPEG-only profiles, AVIF input and SVG input. Dimensions, representative decoded
  pixel colours, untouched originals, SVG `png` naming and metadata privacy were asserted.
- A dedicated Postgres 18.6 database and empty app volume booted the real `src/main.ts`.
  Synthetic `/setup` succeeded; subsequent runs used that account's login. JPEG, AVIF and SVG
  uploads reached `ready`; eight variants from the completed scenario returned 200 with the
  correct MIME type and decoded pixels. Each original URL returned 404 anonymously.
- Six quality previews (three inputs × AVIF/WebP) returned 200, correct dimensions and no EXIF.
  Media count and stored file sizes/mtimes stayed unchanged. Rescan inserted, demoted, marked
  missing and recovered zero rows.
- The actual `audit-exif` CLI found 16 variants across five synthetic keys, 12 carrying allowed
  EXIF and **zero carrying GPS**. Two JPEG keys came from earlier smoke attempts: Node fetch
  did not apply the intended virtual-host header. The harness was corrected to use
  `node:http` for image-host requests; a host-side fetch of the actual public-origin URL also
  returned 200. No application change or guard relaxation was made for this harness error.

Passwords/cookies were never printed; only disposable data was used. Detailed command/audit
evidence is retained in the session's gitignored execution ledger. No image was pushed,
released or deployed, and no owner corpus was inspected or rewritten.
