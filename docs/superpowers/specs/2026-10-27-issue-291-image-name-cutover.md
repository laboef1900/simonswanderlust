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

## Verification hand-off

No builds, tests, lint, formatters or registry mutations run in this implementation slice.
The parent integration owner checks Compose interpolation (empty/unset tag fails; explicit
version and local tag resolve only to the new name), release workflow configuration and
local-image build/run evidence. These configuration/runtime checks are the substantive
regression evidence; no source-string or wording-only tests are added. Publication and
registry access checks remain part of the separately authorized future release.
