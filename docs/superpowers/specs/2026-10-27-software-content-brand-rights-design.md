# #291 — Software, contribution, content and brand rights

**Status: OWNER APPROVED — implementation with release-artifact gates below.**
Approver: **Simon (repository owner)**. Approval date: **2026-10-27**.
Risk: owner legal/product decision; static notice/attribution packaging changes.

The owner selected AGPLv3, inbound = outbound without DCO/CLA, content excluded
from the software grant, retention of Wanderlust Studio, and a separately
implemented GHCR image rename. The implementation identifier is
**AGPL-3.0-only**, not “or later”, as specified in the owner-decision handoff.
This record neither warrants license compatibility nor provides legal advice.

## Approved decisions

### 1. Software

Original application code, tests, build scripts and technical documentation are
licensed under **GNU Affero General Public License version 3 only**.
Copyright notice: **Copyright 2026 Simon and contributors**.
`LICENSE` is the verbatim [GNU primary text](https://www.gnu.org/licenses/agpl-3.0.txt),
retrieved 2026-10-27: 34,523 bytes, SHA-256
`0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`.
Both package manifests and lock roots declare `AGPL-3.0-only`.
Third-party material retains its own terms; this does not relicense it or claim
authority over earlier contributors' separately owned rights.

AGPL §2 distinguishes covered output from ordinary stored/authored data;
§6 requires Corresponding Source when conveying object code; §13 requires
modified network versions to prominently offer their Corresponding Source
to all remote users at no charge. An upstream repository link does not prove
correspondence to a modified deployment. No promise of automatic legal
compliance is made.

### 2. Contributions

**Inbound = outbound under AGPL-3.0-only; no DCO or CLA.** Contributors must have
authority to submit the material and retain third-party notices. No copyright
assignment or retroactive contributor agreement is implied.

### 3. Stories, photos and brand rights

Authored stories/translations, MDX story content and stubs under
`site/src/content/trips/`, uploaded photos/illustrations, reader submissions
and brand/logo artwork are excluded from the software grant and are not
open-licensed here. Rights remain with their respective rightsholders; no
ownership of users' or third parties' content is claimed. Existing individual
licenses and statutory permissions are unaffected. No visibility, authentication,
authorization, publication or export behavior changes.

The software grant does not grant branding rights to “Simon's Wanderlust”,
“Wanderlust Studio” or their logos for a separate service, or imply endorsement.
No trademark registration is asserted. Factual software identification is
distinct from branding a separate service.

### 4. Product and image names

**Keep Wanderlust Studio.** Rename the GHCR package to
`ghcr.io/laboef1900/wanderlust-studio` in the separate implementation branch
**`feature/issue-291-image-name`**, not in this license patch.
The cutover is at the **next owner-authorized release**; existing public artifacts
and tags remain untouched. See
[`2026-10-27-issue-291-image-name-cutover.md`](2026-10-27-issue-291-image-name-cutover.md).
Repository/npm names are unchanged. Other personal copy remains #274's scope.

## Inventory and reproducibility

Run from the repository root, without installs/network/application execution:

```sh
node uploader/scripts/generate-third-party-inventory.mjs
```

The initial preparation produced 911 entries (site 611, uploader 300). That
count is historical, not a claim about the rebased locks. Regenerate after every
lock change; the parent owns the final refresh after #369 integration. The
[`third-party-inventory.json`](../../third-party-inventory.json) records both
lockfile SHA-256 values, every package path/version/resolution/integrity and
verbatim license metadata. [`third-party-evidence.json`](../../third-party-evidence.json)
contains the separately maintained dated sources, artifact observations,
non-lockfile assets and per-license obligation summaries. Its digest is recorded
in the generated inventory. Exact name/version/integrity matching prevents an
old reviewed license from silently applying to a new package version.
This implementation's metadata-only generator run produced **917 entries** from
the rebased head after the approved root license fields were added.

Ten third-party missing-license entries are resolved as **MIT**: `satteri@0.9.4`
and its nine `@bruits/satteri-*` platform/WASI packages. All ten registry tarballs
were read without installing/executing code and matched their lock SHA-512.
The wrapper contains `package/LICENSE`; native/WASI packages omit a named license
file. Their registry `gitHead` identifies
[`815424811e52f097b4052d2ddd0051b32fbbbc55`](https://github.com/bruits/satteri/tree/815424811e52f097b4052d2ddd0051b32fbbbc55),
whose [MIT license](https://raw.githubusercontent.com/bruits/satteri/815424811e52f097b4052d2ddd0051b32fbbbc55/LICENSE)
is Copyright 2026 Bruits. Evidence preserves all ten URLs, hashes and observations.
The first-party roots now declare the approved AGPL-3.0-only license.
This package-level resolution is not a license inventory of statically linked
Rust/WASM dependencies.

All observed license expressions have obligation references, including
[LGPL v3](https://www.gnu.org/licenses/lgpl-3.0.en.html) for sharp/libvips and
MPL-2.0; `AND` requires all listed terms, `OR` offers alternatives. Do not trim
site devDependencies from redistribution accounting: the Dockerfile installs
and copies them for runtime Astro builds. Scripts copying npm JS/CSS/fonts are
included; existing pmtiles/font-awesome supplemental notices must be preserved.
Browser recipients do not receive the image's `node_modules` directory, so
bundle/served-font notice retention needs its own inspection.

## Non-lockfile findings (sources reviewed 2026-10-27)

- **DHI `node:26-dev` / `node:26`:** [Docker's current documentation](https://docs.docker.com/dhi/)
  says the open-source catalog is Apache-2.0. This is not a blanket license for
  every OS/Node component. Runtime base layers are distributed; build bases are
  not copied wholesale. [Signed per-platform SBOM instructions](https://docs.docker.com/dhi/explore/security-concepts/sbom/)
  provide the release-specific component evidence. Mutable tags do not identify
  the exact bases in previously published GHCR images.
- **Alpine `3.22`:** [official image license guidance](https://raw.githubusercontent.com/docker-library/docs/master/alpine/license.md)
  delegates to per-package licenses, not one image-wide license. Examples in the
  v3.22 repository: [BusyBox 1.37.0-r20, GPL-2.0-only](https://pkgs.alpinelinux.org/package/v3.22/main/x86_64/busybox)
  and [musl 1.2.5-r13, MIT](https://pkgs.alpinelinux.org/package/v3.22/main/x86_64/musl).
  These are observed repository versions, not claimed historical build versions.
  Only `/map` is copied from `mapfetch`; distributing its build image/cache would
  additionally require the tool/package notices and applicable source provision.
- **go-pmtiles 1.30.3:** [release-specific BSD-3-Clause](https://raw.githubusercontent.com/protomaps/go-pmtiles/v1.30.3/LICENSE).
  Build-only CLI; not copied into the final image. Binary redistribution requires
  notices, and a distributed build image needs its Go dependencies accounted for.
- **Basemap:** [Protomaps identifies the download as an ODbL Produced Work](https://docs.protomaps.com/basemaps/downloads),
  not a license for the application. [Data source terms](https://raw.githubusercontent.com/protomaps/basemaps/main/LICENSE_DATA.md)
  additionally identify OSM coastlines, public-domain Natural Earth and CC-BY-4.0
  ESA WorldCover landcover. Preserve source/build identity and notices in image
  distribution. [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) §4.3 covers
  Produced Work attribution; §§4.2/4.4/4.6 separately govern database/derivative
  distribution. Do not automatically claim the blog's source must become ODbL.
- **Glyphs:** [`fonts/OFL.txt`](https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts/OFL.txt)
  is OFL 1.1, Copyright 2022 The Noto Project Authors. Observed upstream main:
  `028c18f713baecad011301ff7a69acc39bcc2ae7`. Docker now pins this revision,
  copies `fonts/OFL.txt` beside the three glyph stacks and records
  `/map-assets/GLYPHS_REVISION`. Historical image glyph metadata/notice presence
  still needs artifact inspection; the new pin proves nothing about old images.

## Applied attribution and notice delivery

Public full/mini maps and the admin context map now link the existing
OpenStreetMap credit to `https://www.openstreetmap.org/copyright`, retaining
MapLibre's visible attribution control. [Protomaps legal terms](https://protomaps.com/legal)
require that corner credit and link; [OSM guidance](https://www.openstreetmap.org/copyright)
likewise requires making ODbL availability clear. No extra Protomaps product
branding is required by those terms.

`copy-legal.mjs` delivers the original license, rights NOTICE, inventory, package
and image evidence, installed-package notice texts and reviewed supplements to both
static trees. DE/EN legal indexes use `ui.ts`; the public footer and existing
admin shell link them. No API/auth/data boundary is added. The Docker stages
invoke it after install; site predev/prebuild refresh its generated files.
`notice-gaps.json` lists installed packages with no recognized notice file;
absence from that report is not proof of complete native/bundled compliance.
The full GNU GPL/LGPL v3 texts, Satteri 0.9.4 MIT notice, Node 26.12.1 LICENSE,
sharp-libvips 1.3.2/1.3.4 summaries and full component notices are retained
alongside the existing PMTiles/Font Awesome notices. Native evidence now goes
beyond package license labels:

- Satteri's exact source Cargo.lock: **154** registry archives checksum-matched;
  omitted notices recovered from each crate's recorded Git revision where present.
- Current libvips 1.3.4: **33** source/patch downloads and **357** librsvg lock
  crates; historical 1.3.2: **32** source/patch downloads and **348** lock crates.
  Original notice texts, exact source URLs and review-time hashes are delivered.
- Cargo's [documented `--workspace` semantics](https://doc.rust-lang.org/cargo/commands/cargo-update.html)
  preserve existing non-workspace versions. The script removes features, so the
  original lock supplies a conservative dependency superset, not an exact linkage
  claim. The earlier concern that this necessarily floats all crates is corrected.
- Actual amd64/arm64 native binaries identify Rust **1.95.0**, **1.98.0-nightly**
  and **1.101.0-nightly** and their full compiler source revisions. Official
  release archives were SHA-256 verified, matched to those revisions, and their
  release-generated `COPYRIGHT-library.html` preserved verbatim. No compiler was
  installed or executed. Exact source repositories and library source directions
  accompany those notices.

The component inventories include build/dev/optional-platform supersets. This
does not claim every listed component is linked. `NATIVE-SOURCE-DIRECTIONS.txt`
documents matching libvips rebuild/replacement paths, exact DHI source indexes
and the genuine missing-notice/mutable-input limitations.

The downloaded supplemental files were preserved verbatim:
GNU LGPL-3.0 SHA-256 `e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118`,
GNU GPL-3.0 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`,
Satteri 0.9.4 `902c04ca47795eb6e9b2a2f178a9d9e62f5330988a8d6e1818ee33aeb0f426c1`.
Their sources are [GNU LGPL](https://www.gnu.org/licenses/lgpl-3.0.txt),
[GNU GPL](https://www.gnu.org/licenses/gpl-3.0.txt) and the pinned Satteri license above.

The release workflow passes its existing `github.repository` and full
`github.sha` as nonsecret build-time provenance. `copy-legal.mjs` validates
the GitHub repository path and full 40-character revision, records
`/app/source-release.json`, and emits exact archive/tree links in both static
legal indexes. Runtime site rebuilds retain that image provenance. Default
local builds explicitly record unknown, not a clean-source claim based on HEAD.
The release body places exact-version source directions next to the image
digest. No new runtime knob, API or download routing is introduced.

The GitHub archive contains tracked repository files; any tracked stories/content
remain excluded from the software grant. No deployed uploads, database dump,
settings or credentials are collected.
Operators modifying code must provide their actual source and update static
source directions rather than retain an upstream claim that no longer matches.
The project archive does not replace dependency-specific source/relink duties.

The locked public theme displays landcover. The
[ESA source](https://esa-worldcover.org/en/data-access) requires
“© ESA WorldCover project [year] / Contains modified Copernicus Sentinel data
([year]) processed by ESA WorldCover consortium”, with the source year rather
than the app release date. The artifact investigation below supports **2020**;
the public full/mini maps now carry that exact credit and a CC-BY-4.0 link.
The NOTICE and map documentation explain the Daylight transformations and
Protomaps tiling/app slice. An OSM-only link would not meet this source's credit.

The admin hand-written context style has earth/water/roads/boundaries/places,
not a landcover layer. Do not add an invented ESA year to that style.

Upstream investigation on 2026-10-27: the build metadata service's
[`builds.json`](https://build-metadata.protomaps.dev/builds.json) records
`20261027.pmtiles` as basemap 4.15.2. At commit
[`42ffaaa4a85a41bfcb23e43cc0f5b492a5eca123`](https://github.com/protomaps/basemaps/blob/42ffaaa4a85a41bfcb23e43cc0f5b492a5eca123/tiles/src/main/java/com/protomaps/basemap/Basemap.java),
the default landcover input is `r2-public.protomaps.com/datasets/daylight-landcover.gpkg`.
Daylight's [primary announcement](https://daylightmap.org/2023/10/11/landcover.html)
identifies **ESA WorldCover 2020**, remapped, denoised, smoothed and vectorized.
Read-only image inspection then established the missing artifact linkage:
published `0.17.1` amd64/arm64 carry `BASEMAP_BUILD=20261026`, tileset 4.15.2
and a landcover layer; both local #347 candidates carry 20261024 / 4.15.2.
Both dates are also present in that build inventory. This supports the
documented Daylight/ESA 2020 lineage, not a claim about uninspected releases or
future changed inputs. The metadata service root returns 404; `builds.json`
is the reachable inventory.

The exact public index, platform manifests, source revision, package versions
and observed notice gaps are recorded in
[`third-party-image-evidence.json`](../../third-party-image-evidence.json).
No inspected image contains a readable glyph OFL/revision or named native
sharp-libvips/Satteri notice file. Historical libvips is **1.3.2 / 8.18.3**;
the #347 candidates carry **1.3.4 / 8.18.7**. Their different pinned upstream
notice summaries and source revisions are retained rather than conflated.

Published build provenance identifies the exact DHI runtime base index
`sha256:dc87c509f7279f734d04036f696bf9aad1b8d66f34750f32c30c5b85e033187f`.
Docker Scout 1.27.0 verified both platform SBOM and source-attestation signatures,
claims and offline transparency-log inclusion against Docker's DHI public key.
Each SBOM lists 20 components; their license assertions and PURLs are recorded
verbatim in the image evidence (missing assertions remain missing).
The attested source-image indexes are reachable and recorded by digest. This is
stronger than the embedded SPDX file's single `NOASSERTION` aggregate; it is
still not a claim that all source archives have been unpacked or rebuilt.

## Verification and remaining artifact gates

Regression tests exercise real MapLibre attribution sanitization/disclosure
and link activation for full/mini maps at narrow/wide sizes, without WebGL.
Filesystem tests exercise notice collection, nested dependency notices, missing
notice reporting, verbatim preservation, localized link targets, regeneration,
exact source archive/tree links, unknown local provenance and malformed/injected
source identifiers. They are added but **not run by this worker**.

1. Preserve historical artifacts and apply the recorded findings to remediation
   planning for already-public `0.17.1`. Do not claim other historical versions
   were inspected. Exact DHI source artifacts and retrieval directions are now
   recorded, and existing base copyright/common-license files were observed.
2. Resolve or explicitly account for genuine upstream notice gaps before release:
   `json-escape-simd 3.0.2` declares MIT but its archive, pinned repository root
   and leading source comments contain no original notice. Some source-only or
   non-Linux crates also omit notices; no owners/years were invented. Review-time
   source/patch hashes do not attest the bytes returned by a mutable PR-patch URL
   at a historical binary build. Rebuild/relink and final binary/source matching
   remain artifact checks, not findings established by source review alone.
3. Refresh inventory after final #369 locks, inspect `notice-gaps.json`, final
   image notice files, emitted browser/font assets and exact-version source
   availability. Publish clear Corresponding Source directions alongside each
   authorized image/release; a source archive of project files alone is not
   automatically the complete native dependency Corresponding Source.
4. Parent runs affected suites, typechecks, image/static-path inspection and
   DE/EN desktop/mobile browser verification (public full/mini and admin maps,
   keyboard disclosure/link access, legal indexes and notices).

These duties include the **already-public `simonswanderlust-app` package**,
not just the future renamed package. The approved license and this packaging
patch do not retroactively certify prior distributions. No application build,
test, typecheck, lint, formatter, browser, deployment or owner-data operation
was performed by this worker. The inventory generator is metadata-only.
