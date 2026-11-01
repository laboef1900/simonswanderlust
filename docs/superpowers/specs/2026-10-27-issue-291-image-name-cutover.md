# #291 — Separate container image-name cutover

## Owner decision and scope

Owner Simon approved on **2026-10-27**: rename only the container image to
**`ghcr.io/laboef1900/wanderlust-studio`**. Keep the **Wanderlust Studio** product name,
GitHub repository and npm package names unchanged. This is the separate implementation
required by #291, not a license decision or a release authorization. License files,
package licensing metadata, inventories and source-offer routes belong to the other
#291 implementation slice.

Risk: release configuration affects the artifact operators select. This cutover changes
only the current Compose image reference, release destination and operator documentation;
it does not change the Dockerfile, runtime, build/publish behavior inside the application,
credentials, persistent data, ports or volumes.

## Contract and invariants

- The current Compose file and release workflow use only the approved new image name.
  The workflow keeps its existing version, major/minor and `latest` tag shapes, platform
  matrix, authentication and permissions. There is no dual push or compatibility alias.
- A source rename does not make a registry artifact exist. No release is published,
  retagged or deleted by this work; no release/package versions are bumped.
- `ghcr.io/laboef1900/simonswanderlust-app:0.17.1` is a historical released reference,
  not `ghcr.io/laboef1900/wanderlust-studio:0.17.1`. Earlier dated single-app design and
  implementation records retain the original image names and tag examples as history.
- Compose requires nonempty `IMAGE_TAG`; the example deliberately leaves it empty.
  Retaining the old `0.17.1` default would instruct installers to pull an artifact that
  this cutover has not created. Neither `latest` nor an invented next version substitutes
  for a confirmed release. The release process keeps explicit version selection.
- The local-source path builds `ghcr.io/laboef1900/wanderlust-studio:local` before running
  Compose with `IMAGE_TAG=local`. This is not a registry publication.
- Existing operator `.env` files are never rewritten. An existing nonempty old tag cannot
  be distinguished from a future published tag by Compose interpolation: operators must
  deliberately select a confirmed new-name release before using the new Compose file.

## Exact remaining release prerequisite

**The first release under the new image name is a future human action.** Before anyone
uses the released-image installation instructions:

1. The owner authorizes a new release version; normal version/release-note changes land
   through `feature/* → dev → main` with required checks. Do not recreate or replay any
   existing version tag, and do not retag an old image into the new package.
2. The owner creates and pushes the new version tag on merged `main`. The release workflow
   needs the existing `DHI_USERNAME` repository variable, `DHI_TOKEN` secret and scoped
   `GITHUB_TOKEN`; this work does not create or change them.
3. The workflow successfully builds and publishes both amd64 and arm64 images to the new
   GHCR package. Confirm the version/digest, GitHub release and package visibility/access
   for intended installers. Public access is not assumed merely from the old package.
4. Only then does an authorized operator select that published version in their private
   `.env`, pull and deploy. Publication does not itself deploy or rebuild a live blog.

Until then, use the documented local build for current-source evaluation. Existing
installations retain their existing deployment configuration until an upgrade is authorized.

## Trust boundaries and recovery

The trusted publisher still authenticates to GHCR through the workflow's existing token;
the new artifact name is fixed configuration, not user input. `SECURITY.md`'s authentication,
SSRF, output-safety, privacy, secrets and data-preservation rules are unchanged. No server
route, source-offer route, model access, secret value or content store changes here.

For a failed first publication, leave deployments untouched and fix the release failure;
never make the new name appear usable by copying old tags. Preserve existing images and
recorded digests as history. This branch includes #347's codec upgrade: rolling back to
vulnerable codecs is not authorized; its recovery remains roll-forward. No schema migration,
restore, re-encoding or deletion of `/data` is needed for this naming change.

## Observed local qualification — 2026-10-28

The isolated qualification used committed tree
`028552ca6926ffcd3b2c96a96f276b422151ba2d`, before this evidence-only update.
No automated tests, lint or formatters were run in this slice.

- Real Compose interpolation with an isolated environment refused both unset and empty
  `IMAGE_TAG`. Explicit `local` and the unique local fixture tag resolved only to
  `ghcr.io/laboef1900/wanderlust-studio`; neither was represented as a published release.
- The integrated release workflow retains the version/major-minor/latest tag shapes,
  amd64/arm64 matrix, and `SOURCE_REPOSITORY=${{ github.repository }}` /
  `SOURCE_REVISION=${{ github.sha }}` build arguments. Current operator callers use the
  new name; historical `simonswanderlust-app:0.17.1` references remain historical.
- The actual current Dockerfile built successfully for **linux/arm64**, using its default
  DHI bases and full default map extraction, without a push. The retained unique tag is
  `ghcr.io/laboef1900/wanderlust-studio:qualification-20261028192804`;
  image ID is
  `sha256:b657a5af6088efe39c60cd78fe1af9c1d1fb5115041df00f91254f68620c819c`.
  Runtime DHI base digest:
  `sha256:dc87c509f7279f734d04036f696bf9aad1b8d66f34750f32c30c5b85e033187f`;
  build DHI base digest:
  `sha256:c8939885965365c675a024d062bcb761bda4b47e95ce0323aa998ac9bc312fd6`.
- The real Compose app ran on loopback `33491`, with only a new absolute fixture data
  directory and disposable database `swl_291_image_20261028192804` on the recovered
  test Postgres. The validated override removed the default data mount, DB dependency
  and `pgdata` volume. The app resolved `docker-gateway` to its own bridge gateway.
  `/health` returned 200 with `ok`, `db` and `release` true. Boot generated a release;
  authenticated `POST /rebuild` generated another real release successfully.
- Anonymous public DE/EN pages, admin static pages, both legal indexes/source records,
  both third-party notice bundles, and `/map/fonts/OFL.txt` returned 200.
  A managed browser rendered the public English page, legal index and authenticated
  posts page. This is an empty synthetic-content installation, not a populated-story
  or production-load qualification.
- Actual versions: Node `26.12.1`, sharp `0.35.5`, sharp-libvips package `1.3.4`,
  libvips `8.18.7`, libheif `1.23.5`, libaom `3.15.1`. The image carries basemap
  build `20261028`, glyph revision `028c18f713baecad011301ff7a69acc39bcc2ae7`,
  readable map OFL text, and the three expected admin WOFF2 fonts.
  The Linux ARM64 libvips package itself still lacks a license file, as recorded by
  the inherited evidence; emitted bundles include the reviewed supplemental
  `sharp-libvips-1.3.4` component/third-party notices and Satteri notice text.
  This inspection is not a new legal-compliance or corresponding-source verdict.
- No source build arguments were supplied: `/app/source-release.json` and both served
  source records are honestly `null`; the rendered legal page explicitly says no
  exact revision is recorded for this local/unversioned installation.

Evidence (build/container logs, selected safe Compose fields, runtime JSON and browser
screenshots) remains in the qualification worktree at
`.issue-runtime/image-20261028192804/`. The image, fixture database and generated site
data are retained. Only the owned app container/network, browser tab and temporary
admin credentials/sessions were removed; the shared test Postgres was not stopped.

**Limits:** this cutover qualification did not build or exercise AMD64, execute the
release workflow, publish anything, or establish new-package registry availability.
Inherited historical/native evidence is not relabeled as a new-platform runtime result.
The first owner-authorized publication, both-platform release qualification and registry
access checks remain the future release gate described above.

## First publication — v0.18.1, 2026-11-01

Owner-authorized. The `v0.18.0` tag (`9c575c9`) ran
[release run 41355438196](https://github.com/laboef1900/simonswanderlust/actions/runs/41355438196),
which failed in the native-build stage before pushing anything: `release.yml` passed floating
`dhi.io/node:26-dev`/`dhi.io/node:26` build arguments over the Dockerfile's digest-pinned
defaults, and `container-toolchain.mjs` refuses non-immutable references. No image or GitHub
Release exists for v0.18.0; the tag was left in place, not replaced. #508 dropped the
overrides and the release moved forward to v0.18.1.

| Item | Value |
| --- | --- |
| Tag / commit | `v0.18.1` → `4c715085a944f88133d430b1a654b7de71d4decf` (merged `main`) |
| Workflow | [run 41358308153](https://github.com/laboef1900/simonswanderlust/actions/runs/41358308153), success |
| Index digest | `sha256:6a12b5fb85be4a31fb3e325dfaf4eb95128031eeb8c8b9a2fa45527ff64fba9c` |
| `linux/amd64` | `sha256:324e68420e53cb52e8ec89250619b9ae3c631ee7d9f212324a7573e28d6170f1` |
| `linux/arm64` | `sha256:b385a9d938b094c339f27f4d11ea83582b122025fbaebe1e5174996f5edc72e0` |
| Tags | `0.18.1`, `0.18`, `latest` |
| Package visibility | `public` (GitHub packages API) |
| GitHub Release | [v0.18.1](https://github.com/laboef1900/simonswanderlust/releases/tag/v0.18.1) |

No deployment, operator `.env` change or live-blog rebuild was part of this publication.
