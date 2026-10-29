# Temporary #292 native released-image rehearsal

## Prepared, not executed

This directory and `../workflows/issue-292-native.yml` are **one-time qualification scaffolding**, not application code, a deployment, a new ordinary CI requirement, or evidence of a successful rehearsal. The parent must remove them from the final documentation-only PR after retaining and reviewing the evidence. No runtime, syntax check, test, formatter, build, commit or push was performed during this preparation.

The full canonical issue was read from `.local/backlog-execution-2026-10-27/issues/292.md`. This adapts the actual `.issue-runtime/rehearse.py` rather than replacing its exercise with a smaller smoke test. The original local preparation files remain untouched. `provenance.json` retains their exact SHA-256s, the canonical issue and release-inventory hashes, the source revision, and hashes of the four installer inputs. At execution the harness refuses changed inputs rather than silently rehearsing different instructions. Its own hash, workflow hash, provenance-manifest hash, PR-head revision, generation and runner label join the evidence. No absolute owner-machine path is exported.

## Runner decision and admission

The repository is public. [GitHub's standard-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) states that standard public-repository runners are free/unlimited and each non-single-CPU job receives a new VM. Its table lists four CPUs, 16 GB RAM and 14 GB SSD for both `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64). Those advertised figures are **not actual free disk**, and are not a measured minimum for this application.

The workflow uses separate native matrix jobs on exactly those labels. It only admits same-repository PRs from `feature/issue-292-clean-install-rehearsal` to `dev`, only when the scaffold paths change, and only while the repository is public. It has `contents: read`, checkout credential persistence disabled, and no services, caches, secrets, `pull_request_target`, Docker installer, emulation, image-building or deployment action. No larger/billable runner is selected.

Before pulling or starting images, each job must have:

- Linux running as a VM, Python 3, OpenSSL, `systemd-detect-virt`, Docker Engine and Compose already available. A missing or inaccessible prerequisite is a failed rehearsal, **not permission to install it**.
- Root access on that disposable VM, a native matching rootful Docker daemon at `unix:///var/run/docker.sock`, and functioning memory/swap-limit support.
- **Zero existing containers and zero volumes**. Existing image caches do not imply an existing application deployment. The harness never removes containers/volumes, prunes, changes daemon settings or frees host disk to pass this gate.
- Free loopback ports 3000 and 443; the selected app, Postgres and proxy images must all match the host architecture.
- Actual resource inventory: CPUs, `/proc/meminfo` available/total memory and swap, filesystem devices and actual free/total bytes on **both** the runtime and Docker storage filesystems. These are recorded before and after pulls.

Admission allowances are deliberately explicit: at least two CPUs, the existing 4608 MiB application ceiling plus 2048 MiB available host reserve, 8 GiB free on the relevant filesystems before image pulls, and 3 GiB after pulls for this two-photo exercise. These are conservative **test-allocation budgets**, not empirically established hosting minima or an image-expansion guarantee. Pull failures or subsequent space exhaustion remain failures, never a reason for daemon cleanup. Actual local image sizes and actual image-tree disk usage are recorded. The harness also checks that Docker applied the existing 4608 MiB memory **and equal memory+swap** ceilings.

## Released input, not a development image

The release remains `v0.17.1`, published 2026-10-26:

- Index: `sha256:24b6ad8e0a9231abe21f5b5e23dab20ff74dacd3ad4d1fd3cd1592f4bd147805`
- amd64: `sha256:85224391cc9b58d46c97b73ab54f14758e591a725ec5962a8895221bde9ab945`
- arm64: `sha256:fade3acc3f54f41df6fbbbfbeb894ec21ca80db461f46a02497993699831fdd7`

The public repository is `ghcr.io/laboef1900/simonswanderlust-app`. The harness verifies that the release tag still identifies the pinned index and that both platform descriptors match the recorded release inventory; a generation-private Compose override selects the native **platform digest before pull/start**. The latest-release check also refuses a silently changed release. Postgres and nginx identities are resolved and recorded separately; their existing public tags are not presented as immutable historical fixtures.

This release predates #347's codec fixes. It receives only two generated benign 6000×4000 RGB PNGs with deterministic grayscale stripes/gradients and no metadata. No owner photos, hostile input, codec security testing, unsupported downgrade, security-support claim or deployment qualification is authorized.

## Exact execution

The parent commits/pushes this temporary scaffold to the named branch and opens/updates its PR into `dev`; the normal `pull_request` event runs both jobs. There is no `workflow_dispatch` dependency on the default branch and no merge/release required. The exact invocation lives in the workflow and is:

```bash
sudo -n env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  timeout --signal=TERM --kill-after=180s 80m \
  python3 "$SOURCE_ROOT/.github/issue-292/rehearse.py" \
  --fresh-disposable-linux-host --resources-reviewed \
  --expected-architecture "$EXPECTED_ARCH" --runner-label "$RUNNER_LABEL" \
  --generation "$GENERATION" --checkout-sha "$CHECKOUT_SHA" \
  --source-root "$SOURCE_ROOT" --run-root "$RUN_ROOT" \
  --evidence-export "$EVIDENCE_EXPORT"
```

The workflow supplies the exact checked-out PR-head SHA and workspace, matching runner label/architecture, and generation `${github.run_id}-${github.run_attempt}-${matrix.arch}`. Private runtime and public sanitized export are separate new siblings under `runner.temp`, named `issue-292-<generation>-private` and `issue-292-<generation>-evidence`. Existing paths are refused. Do not invoke this on the owner's workstation or an existing server. The job has a 90-minute ceiling; the process has an 80-minute deadline with a bounded cleanup interval. Signals attempt sanitized failure export and project-scoped stopping; forced termination can prevent evidence export. A missing artifact is not a passing run.

The run directory is mode 0700, with a generation-private HOME/Docker configuration and `private.env` mode 0600. It is outside the checkout. Environment variables, credentials and Docker configuration are not inherited. Only the freshly created disposable data directory is chowned. Do not copy an old run directory, owner `.env` or owner data into a new generation.

## Preserved real exercise and interpretation

1. Copy the hashed installer Compose/template; privately generate the database password; set the existing image URL/host knobs to `img.issue292.test`; leave the optional database override and AI key unset. A generated digest override and non-default private env filename are recorded rehearsal adaptations, not instructions to rename a product configuration.
2. Pull the released native image and support images. Record image identifiers/digests, CLI versions and CLI executable hashes, kernel/OS/VM identity and resources. No local application image is built.
3. Create root:root 0755 bind data, intentionally omit the README chown, start and inspect bounded in-memory logs for an actual permission failure. Export only the permission-failure boolean and state/exit/health projection. Stop if the expected failure does not occur. Apply uid/gid 1000 ownership to that disposable directory and start again.
4. Start nginx on **127.0.0.1:443 only**, forwarding to the app's **127.0.0.1:3000**. Verify actual Docker bindings and an unpublished database. The single ingress preserves `Host`, overwrites XFF with the socket client address, overwrites forwarded protocol with its TLS scheme, and clears forwarded host. It never trusts reader-supplied proxy headers.
5. Generate a private two-day CA and SAN certificate for blog/image test names. The actual HTTPS client connects to loopback using the requested hostname for SNI and certificate verification. Only its SSL context trusts the CA; default trust must reject it. No `-k`, host trust-store edit, hosts-file edit, public DNS, public ingress or owner browser profile is involved. TLS 1.2/1.3, body limit 25 MiB, read timeout 960 s (above the 900 s application build bound), send 60 s, connect 5 s and incoming-body 30 s remain explicit. nginx has read-only mounts/root and no privileged flag or Docker socket.
6. Visit `/login` over HTTPS, submit `/setup`, assert Secure/HttpOnly cookies even with a false incoming `X-Forwarded-Proto: http`, enable comments, and wait for the real initial release.
7. Measure idle memory, concurrently upload both synthetic photos through TLS, await real media-ready status, measure image disk deltas, save a complete bilingual draft and synchronously Publish while measuring memory. Verify both published pages and a real image-domain WebP variant.
8. Reproduce **known #319**: the blog-Origin unauthenticated comment must fail 403; an image-Origin control must return 201 and remain pending/hidden publicly. The control is not evidence that the blog's comment form works.
9. Restart database and app; verify health, authenticated session, stored post, both published-language byte streams, image bytes and pending moderation row survive.
10. After restart clears the limiter, six requests with different forged XFF values must produce five known-origin 403s then 429, demonstrating the sole proxy's replacement of attacker-supplied XFF. Record final container state/free disk, then stop only the generation's project and proxy. Volumes/data are not deleted; GitHub VM disposal is the cleanup boundary.

Simon's `PUBLIC_BASE_URL` and `IMG_HOST` defaults remain unchanged in product files. Both must be overridden together; omitted or explicitly empty Compose `:-` variables still use Simon's defaults. Requiring them with `:?` belongs to #293. This automated API exercise is not a claim that the README was followed interactively without adaptations.

## Measurement and evidence boundary

Memory files contain approximately one-second samples. `cgroupCurrent` includes children/page cache and is **not RSS**. `cgroupLifetimePeak` is cumulative over the container lifetime, including initial build, not a phase-reset peak. `processRssSum` can double-count shared pages; `astroRss` identifies Astro subprocesses internally without exporting command lines. Missing samples/all-null cgroup observations fail the rehearsal. Sampling launches a short-lived Node process and can miss short peaks. Parent reports non-null maxima, counts, durations and failures as **sampled lower bounds**, comparing cumulative peaks separately.

Disk figures walk retained originals/variants only: apparent bytes, allocated blocks, before/after deltas, file counts and the two-photo average. They exclude DB, releases and image layers. Synthetic compressible PNGs and a small bilingual story do not establish worst-case camera-photo sizing or confirm the old 19-page/general encoder rationale. Keep that general rationale unconfirmed unless the reviewed observations actually support it. Never extrapolate a minimum machine size from these two files.

The exporter and upload action independently use the following **positive filename list**, not a recursive run-root upload:

- `steps.jsonl`
- `provenance.json`
- `released-manifest.json`
- `corpus.json`
- `idle-baseline-memory.json`
- `encode-memory.json`
- `publish-build-memory.json`

Before creating an uploadable directory, the exporter rejects symlinks/non-regular files, parses JSON/JSONL, and screens every selected file against all generated passwords/session-cookie values and PEM private-key markers. Evidence is constructed from safe projections; this screen is defense in depth, not generic redaction of arbitrary logs. Missing later-phase files are expected on failure. Private run roots, env files, TLS material (including certificates), cookies, request/response dumps, raw Docker logs and inspect environments are **never uploaded**. Artifact retention is seven days. Parent must still review downloaded evidence before publishing it elsewhere.

## Remaining parent/manual limits

- Parent owns syntax/workflow review and real CI execution. No success, resource observation, TLS verification or architecture acceptance is claimed by this preparation.
- CI uses the real HTTPS API and real application/publish path, but not an interactive browser. Login/setup/editor UX, browser certificate acceptance, browser-console behavior and screenshots are not covered. A browser cannot reach the job's loopback endpoint from the owner's computer; do not expose it or use a relay tunnel as an unreviewed workaround.
- After completion the harness stops services; the ephemeral VM and private CA are not retained. An additional authorized disposable-host/browser walkthrough requires a separate execution plan, not restarting owner services.
- Record each architecture independently as pass/fail/known defect/not run. Parent must classify README deviations, preserve the #319 reproduction, assess memory/disk caveats, and update final README/architecture/issue evidence as warranted. A `rehearsal-finished` event alone is not issue closure.
- If runner prerequisites, released-image availability, input hashes or resource admission fail, retain the sanitized failure and report the prerequisite. Never weaken freshness/native/TLS/isolation checks merely to produce green CI.
