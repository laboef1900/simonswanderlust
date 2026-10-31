# Native released-image clean-install rehearsal — 2026-10-29

## Result and scope

[Issue #292](https://github.com/laboef1900/simonswanderlust/issues/292) was exercised on two fresh native Linux VMs using the **published 0.17.1 image**, not an image built from this PR. Both jobs in [run 40852293736, attempt 1](https://github.com/laboef1900/simonswanderlust/actions/runs/40852293736) succeeded. This is a bounded HTTPS/API installation rehearsal with one bilingual story and two synthetic photos, **not** a production qualification, browser walkthrough, hosting minimum, or claim that all features work.

The released image predates the native-codec fixes tracked in [#347](https://github.com/laboef1900/simonswanderlust/issues/347). Only benign generated PNG inputs were used. This record does not endorse its older codec floor for untrusted uploads, recommend downgrading to it, establish a supported rollback window ([#298](https://github.com/laboef1900/simonswanderlust/issues/298)), or claim current/unmerged source fixes are shipped. The broader installation guide and default changes belong to [#293](https://github.com/laboef1900/simonswanderlust/issues/293).

The known split-domain comment defect [#319](https://github.com/laboef1900/simonswanderlust/issues/319) reproduced on both architectures: a blog-Origin POST returned **403**. The image-Origin **201** control is not a working blog comment form. HTTP `/health` returned **200** after restart, but the final Docker health sample was still **`starting`**, not `healthy`.

## Source and evidence chain

- Installer baseline: [`11e16d1b8e43141d296b801ee663a351ae3fe415`](https://github.com/laboef1900/simonswanderlust/tree/11e16d1b8e43141d296b801ee663a351ae3fe415). The four installer inputs were hash-checked unchanged at execution.
- Proof checkout: [`657c19652c388ffd479573b62bc5d951fa9c947b`](https://github.com/laboef1900/simonswanderlust/tree/657c19652c388ffd479573b62bc5d951fa9c947b), branch `feature/issue-292-clean-install-rehearsal`, [PR #473](https://github.com/laboef1900/simonswanderlust/pull/473). This is the harness/source revision, **not** the released app's image identity.
- Historical [workflow](https://github.com/laboef1900/simonswanderlust/blob/657c19652c388ffd479573b62bc5d951fa9c947b/.github/workflows/issue-292-native.yml), [harness](https://github.com/laboef1900/simonswanderlust/blob/657c19652c388ffd479573b62bc5d951fa9c947b/.github/issue-292/rehearse.py), [manifest](https://github.com/laboef1900/simonswanderlust/blob/657c19652c388ffd479573b62bc5d951fa9c947b/.github/issue-292/provenance.json), and [execution constraints](https://github.com/laboef1900/simonswanderlust/blob/657c19652c388ffd479573b62bc5d951fa9c947b/.github/issue-292/REHEARSAL.md) preserve the exact temporary machinery. These four scaffold files are removed from the final documentation-only change, not added to ordinary CI.
- [amd64 job 123374504592](https://github.com/laboef1900/simonswanderlust/actions/runs/40852293736/job/123374504592): artifact `issue-292-amd64-40852293736-1`, generation `40852293736-1-amd64`.
- [arm64 job 123374504069](https://github.com/laboef1900/simonswanderlust/actions/runs/40852293736/job/123374504069): artifact `issue-292-arm64-40852293736-1`, generation `40852293736-1-arm64`.
- Artifact retention was **seven days**. Retained private copies are under the maintainer's repository-local `.local/backlog-execution-2026-10-27/issue-292-native-ci-40852293736/`, in the artifact-named directories above; run metadata is the sibling `issue-292-native-ci-run.json`. These are not public download links and are not committed. The digest inventory below lets retained copies be checked after CI artifact expiry.

Only seven positively selected JSON/JSONL files per architecture were exported: `steps.jsonl`, `provenance.json`, `released-manifest.json`, `corpus.json`, and the three `*-memory.json` files. The exporter refused symlinks/non-regular files and screened parsed selected files for generated secret values and private-key markers. No passwords, cookies, keys, private env files, TLS material, raw request/response dumps or raw Docker logs are part of this record. The parent inspected the downloaded evidence. No owner data was used.

## Host and image inventory

Both hosts were fresh GitHub standard-runner VMs: Ubuntu **24.04.5 LTS**, kernel `7.0.0-1017-azure`, virtualization `microsoft`, four CPUs. Runner labels were `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64); no emulation. Docker client/server **28.0.4**, API **1.48**; Compose **2.38.2**; Python **3.12.3**; OpenSSL **3.0.13**. Both daemons were native, rootful, `overlay2`, cgroup v2, with **zero containers and zero volumes** before the run. Existing image caches were allowed; no daemon cleanup or package installation was performed.

All following inventory sizes are **bytes**, not advertised runner capacity. Run-root and Docker-root checks resolved to the same filesystem device `2049` on each VM, total `154894188544` bytes; do not add them as separate storage.

| Observed resource | amd64 | arm64 |
| --- | ---: | ---: |
| Host total memory | 16760344576 | 16715927552 |
| Available memory before pulls | 15701671936 | 15489839104 |
| Available memory after pulls | 15417655296 | 15483727872 |
| Host swap total and free (before/after pulls) | 3221221376 | 3221221376 |
| Filesystem free before pulls | 91883028480 | 114268803072 |
| Filesystem free after pulls | 90271526912 | 112662933504 |
| Filesystem free at final sample | 90195210240 | 112586534912 |

Docker applied `Memory = MemorySwap = 4831838208` bytes (**4608 MiB**) to the app. Admission allowances were two CPUs, available memory of that ceiling plus `2147483648` bytes host reserve, `8589934592` bytes free before pulls and `3221225472` after pulls. These were test-allocation guards, **not measured minimum hosting requirements**. No host sizing conclusion follows from a successful run on roughly 16 GB hosts.

Released tag: [`v0.17.1`](https://github.com/laboef1900/simonswanderlust/releases/tag/v0.17.1), published `2026-10-26T11:17:37Z`; requested image `ghcr.io/laboef1900/simonswanderlust-app:0.17.1`. The tag's index and both platform descriptors were checked; a private Compose override selected the native platform digest before pull/start.

| Image identity | Digest |
| --- | --- |
| App multi-platform index | `sha256:24b6ad8e0a9231abe21f5b5e23dab20ff74dacd3ad4d1fd3cd1592f4bd147805` |
| App linux/amd64 platform manifest | `sha256:85224391cc9b58d46c97b73ab54f14758e591a725ec5962a8895221bde9ab945` |
| App linux/arm64 platform manifest | `sha256:fade3acc3f54f41df6fbbbfbeb894ec21ca80db461f46a02497993699831fdd7` |
| `postgres:18-alpine` observed RepoDigest | `postgres@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5` |
| `nginx:1.28-alpine` observed RepoDigest | `nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236` |

The support-image RepoDigests were observed from their tags, not supplied as platform pins. Native local image IDs and Docker-reported uncompressed sizes follow; sizes are not incremental disk usage or download sizes.

### amd64 local images

| Image | Image ID | Uncompressed bytes |
| --- | --- | ---: |
| released-image | `sha256:0708002232ac3acefb8cfe4a0574cd1051722f4d3fc4fa0cecedd1b629242db8` | 1130613503 |
| database-image | `sha256:57b23a0326ee442e83b3d3fa027c5a148be0a392d7c91d1ca4e1e70131ee859a` | 303728840 |
| proxy-image | `sha256:dc73b49f5124cf2ee538dfbdfbd121f0b4ccdcb20fea30f3a81bd477c02e2bb5` | 62072530 |

### arm64 local images

| Image | Image ID | Uncompressed bytes |
| --- | --- | ---: |
| released-image | `sha256:635b17dda0f13133ef708f6b08d06c96885cc24926a3a5391b3374cdf800aac6` | 1131432921 |
| database-image | `sha256:d198b39c31a6df6012ac71d61fe3596277c3c06e0884fc24965669cb8d799f10` | 297982666 |
| proxy-image | `sha256:feb29ad4d53f4c6d793d598ed2af77917b8587163de8df86d6ae8e2acec5a5d4` | 61408152 |

## Reproduction runbook and per-architecture log

This is the sequence executed, with the exact harness available at the proof commit above. Repetition requires newly authorized disposable native Linux hosts, newly generated secrets and empty, separate runtime/export directories outside the checkout. **Do not run the historical harness against a working installation or copy owner `.env`, `uploader/data`, or `.local` content into it.** It refuses existing containers/volumes and changed installer hashes. Future releases require a new reviewed baseline and evidence generation; this is not a recommendation to install the historical release.

The workflow used a sanitized `env -i`, a private HOME/Docker configuration, root access only on the disposable VM, a mode-0700 run root and mode-0600 private env file. It installed nothing, built no app image and exposed no public ingress. Execution was bounded to 80 minutes plus a 180-second termination grace within a 90-minute job. Its historical invocation was:

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

The linked workflow defines those values, including the exact PR-head checkout and unique `${run_id}-${run_attempt}-${architecture}` generation. The temporary workflow is no longer an ongoing qualification gate.

Each architecture followed the same sequence. Times below are UTC on 2026-10-29; ranges mark observed step events rather than precise operation durations.

| Step and observed outcome | amd64 | arm64 |
| --- | --- | --- |
| Start new generation, verify host and resources | 09:46:49–09:46:52; pass | 09:46:50; pass |
| Resolve released image and pull native app, Postgres, proxy; inventory again | 09:47:18; pass | 09:47:13; pass |
| Intentionally skip uid/gid 1000 ownership on root-owned 0755 data directory | 09:47:59; permission failure observed, exit 1, restarting, unhealthy | 09:47:54; same |
| Apply documented ownership to this disposable data directory; start stack/proxy | Subsequent HTTPS/API steps pass | Subsequent HTTPS/API steps pass |
| Verify both TLS hostnames and default-trust rejection; inspect network/limits | 09:48:03; pass | 09:47:58; pass |
| GET `/login`, POST `/setup` via HTTPS | 09:48:03; both 200, Secure + HttpOnly session cookie | 09:47:58; same |
| Enable comments, wait for initial release, sample idle, upload two PNGs concurrently and await both `ready` | 09:48:33; two photos encoded | 09:48:27; two photos encoded |
| Save one bilingual draft and synchronously Publish | 09:48:33–09:48:35; 200 | 09:48:27–09:48:30; 200 |
| Fetch DE/EN pages and actual image-domain `-640.webp` bytes | 24735 / 24642 / 3188 bytes | 24735 / 24642 / 3188 bytes |
| Blog-Origin comment POST, then image-Origin control | 09:48:35; 403 known #319 / 201 pending and hidden publicly | 09:48:30; same |
| Restart DB then app; re-read authenticated post, compare published DE/EN page and variant bytes, check pending moderation row | 09:48:38; all survive, `/health` 200 | 09:48:33; same |
| Six distinct forged XFF client addresses after restart resets limiter | 09:48:38; 403 × 5, then 429 | 09:48:33; same |
| Final container sample | 09:48:38; `OOMKilled=false`, Docker health **starting** | 09:48:33; same |
| Stop this generation's Compose services and proxy | 09:48:39; both stopped | 09:48:33; both stopped |

Restart evidence covers the authenticated session, stored story, **published static pages**, image bytes and pending comment. It does not claim separate edits to the CMS `pages` table, full database equality or backup/restore coverage. No OOM was reported in the final app state; there was no claim of a completed Docker-health transition. The harness stopped services without deleting volumes/data; disposal of the temporary GitHub VMs was the cleanup boundary.

### Verified HTTPS proxy example

This is the exact nginx configuration used on **both** disposable hosts, not a public DNS/certificate provisioning recipe. The container used host networking, read-only root/config/TLS mounts, tmpfs for `/var/cache/nginx` and `/var/run`, no privileged flag and no Docker socket. Port 443 was loopback-only; the app binding was exactly `127.0.0.1:3000`, and Docker reported `5432/tcp: null` for the DB (unpublished).

```nginx
events {}
http {
 access_log off;
 error_log /dev/null crit;
 server {
  listen 127.0.0.1:443 ssl;
  server_name blog.issue292.test img.issue292.test;
  ssl_certificate /tls/server.pem;
  ssl_certificate_key /tls/server.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 25m;
  client_body_timeout 30s;
  location / {
   proxy_pass http://127.0.0.1:3000;
   proxy_set_header Host $http_host;
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header X-Forwarded-For $remote_addr;
   proxy_set_header X-Forwarded-Host "";
   proxy_connect_timeout 5s;
   proxy_send_timeout 60s;
   proxy_read_timeout 960s;
  }
 }
}
```

The sole proxy preserves Host, **overwrites** reader-supplied XFF with the socket address and forwarded protocol with its TLS scheme, and clears forwarded host. This matches the app's one-hop `trustProxy: 1` topology, not an arbitrary CDN/proxy chain. A false incoming `X-Forwarded-Proto: http` on setup still yielded Secure/HttpOnly cookies. Six requests with differing forged XFF addresses yielded five known-origin 403s then a 429 under one limiter budget.

The 960-second read timeout exceeds the app's 900-second build deadline; connect/send/incoming-body timeouts are 5/60/30 seconds. Fastify's `requestTimeout` bounds receipt, not handler runtime. These values were exercised by the short successful publish, **not** by a 15-minute timeout/failure test. Suppressed nginx logs were a secret-minimizing rehearsal choice, not a production logging recommendation.

A generated two-day CA signed a certificate with both names as SANs. The HTTPS client connected to loopback while using each hostname for SNI and verification, trusting that CA in its own SSL context only. Both names negotiated **TLS 1.3 / TLS_AES_256_GCM_SHA384**; the default trust context rejected the private CA as expected. No `-k`, system trust-store edit, hosts-file edit, public DNS or browser profile was involved.

| Architecture | Verified server certificate SHA-256 (same for both names on that host) |
| --- | --- |
| amd64 | `b5c62ae7a4a91b040904bda382bbc68009cf2d684d9d93650180cd8069a8af30` |
| arm64 | `9e48219f79b01e388b602d59f41034d08dcb6fa544424b9dd12100ac2e32b085` |

### Known #319 reproduction

Set `PUBLIC_BASE_URL=https://img.issue292.test` and `IMG_HOST=img.issue292.test`; route both test hosts through the proxy above. After setup, enable comments globally and on the published synthetic story. Submit unauthenticated `POST https://blog.issue292.test/comments` with JSON fields `translationKey` (the saved story's returned key), `postedLocale: "en"`, `authorName: "Synthetic Reader"`, `body: "Synthetic rehearsal comment."` and `Origin: https://blog.issue292.test`. Both runs returned **403**. With only Origin changed to `https://img.issue292.test`, both returned **201**, with exactly one matching pending moderation row and none in the public comment list. That Origin control demonstrates the defect; it is **not** a user-facing workaround or proof of browser/CORS behavior. No fix was made here.

## Resource measurements

### Corpus and disk

Each run generated the same two metadata-free 6000 × 4000 RGB PNGs (24 MP each), deterministic grayscale stripes/gradients, seeds 31 and 62. These are **highly compressible synthetic inputs**, not representative travel-camera photos. No owner photos, malformed input, adversarial codec tests or remote corpus were used. One small story pair with `## Rehearsal` and one synthetic paragraph per locale was published; both locales used the first photo as hero. The second photo exercised concurrent encoding, not a second story.

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| `synthetic-1.png` | 525377 | `02d09e2adddc49b5f54f131867d02d376ca4ca1caab3a5f9900147d9055689a1` |
| `synthetic-2.png` | 525376 | `3010c3177dc7d5b76ca0e1215aca9bf57b426fa3942ba702b90626ca145c6b29` |

Disk was measured by walking retained originals/variants, summing `st_size` (apparent) and `st_blocks × 512` (allocated). Both architectures had identical results:

| Image tree measure | Before | After | Delta per photo (`(after − before) / 2`) |
| --- | ---: | ---: | ---: |
| Apparent bytes | 0 | 1291557 | 645778.5 |
| Allocated bytes | 0 | 1327104 | 663552 |
| Files | 0 | 18 | 9 |

This excludes database, site releases, backups, image layers, TLS and other runtime files. The filesystem-free observations above include unrelated system activity and must not be treated as per-photo costs. Neither these averages nor the input's 24 MP dimensions establish realistic disk/photo capacity.

### Memory method and derived maxima

A Docker exec starts a short-lived Node sampler, reads app-container cgroup v2 `memory.current` / `memory.peak`, and sums `/proc/*/status` `VmRSS` (KiB × 1024) excluding the sampler's own process. Astro RSS sums processes identified by `astro.mjs`; no command lines were exported. The sampler waits one second after each sample; observed intervals were approximately **1.102–1.226 seconds**. Sampler overhead remains in cgroup values. All six phase files had **zero sample failures** and non-null cgroup observations.

For each row, the value is `max(sample[field])` over that phase's non-null samples. These are independent maxima, not necessarily simultaneous. **Current cgroup memory is not RSS**: it includes app children and page cache. RSS sums can double-count shared pages. Sparse phase samples miss short peaks, especially with only three publish samples; sampled current/RSS maxima are lower bounds, not exact phase peaks. `cgroupLifetimePeak` is the kernel's cumulative container-lifetime high-water mark observed during the phase, **not reset per phase**: idle already includes initial build history, and publish retains the earlier encode peak. Never label that retained peak “Astro build peak.” Initial-build peak was not separately phase-sampled.

Exact byte maxima:

| Arch / phase | Samples | Elapsed seconds¹ | Current cgroup max | Lifetime peak observed | Process RSS sum max | Astro RSS max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| amd64 / idle-baseline | 9 | 10.000514 | 119390208 | 774619136 | 168099840 | 0 |
| amd64 / encode | 11 | 12.162461 | 2039635968 | 2040684544 | 2086088704 | 0 |
| amd64 / publish-build | 3 | 2.768995 | 1240977408 | 2040684544 | 1386422272 | 679485440 |
| arm64 / idle-baseline | 10 | 10.068129 | 117145600 | 792801280 | 163504128 | 0 |
| arm64 / encode | 11 | 12.133968 | 1967599616 | 1968648192 | 2011533312 | 0 |
| arm64 / publish-build | 3 | 2.600640 | 1288634368 | 1968648192 | 1425850368 | 721371136 |

¹ The phase context's elapsed time includes sampler teardown and is rounded here to six decimals; it is not a benchmark of CPU-only build/encode time.

For scale, divide bytes by **1048576** (MiB):

| Arch / phase | Current cgroup max MiB | Lifetime peak observed MiB | Process RSS sum max MiB | Astro RSS max MiB |
| --- | ---: | ---: | ---: | ---: |
| amd64 / idle-baseline | 113.859 | 738.734 | 160.312 | 0.000 |
| amd64 / encode | 1945.148 | 1946.148 | 1989.449 | 0.000 |
| amd64 / publish-build | 1183.488 | 1946.148 | 1322.195 | 648.008 |
| arm64 / idle-baseline | 111.719 | 756.074 | 155.930 | 0.000 |
| arm64 / encode | 1876.449 | 1877.449 | 1918.348 | 0.000 |
| arm64 / publish-build | 1228.938 | 1877.449 | 1359.797 | 687.953 |

**Ceiling/rationale disposition:** retain the existing equal 4608 MiB memory and memory+swap ceilings. The Compose rationale now cites these measured whole-cgroup observations and this corpus instead of the unreconfirmed “19 pages / ~0.47 GB build RSS / ~1.94 GB per 24 MP frame” estimates. This small corpus stayed below the ceiling; it does not validate a lower ceiling, establish per-frame costs, or prove safe concurrency on a smaller host. The work-lock rationale (build and encode mutually exclusive, so budget max rather than sum) is unchanged. Only explanatory comments changed; no resource limit or runtime configuration changed.

## README deviations and acceptance mapping

| README instruction / issue criterion | Evidence, deviation and disposition |
| --- | --- |
| Fresh released-image install on both architectures | Native jobs passed; exact release/platform identities, versions, steps and resources recorded above. No current-source app build. |
| Copy template to `.env`, choose domains/password/tag, then Compose pull/up | Hashed template/Compose copied into a generation-private root; random password and existing domain variables set. Used private `--env-file` and a digest override rather than literally `.env`/mutable tag, to isolate secrets and prove image identity. These are disclosed rehearsal adaptations, not product requirements. |
| Prepare bind mount with uid/gid 1000 ownership | Negative test intentionally omitted it and observed EACCES/permission-denied detection, exit 1, restart/unhealthy. Applying ownership enabled subsequent steps. README now names the symptom; do not test this on existing content. |
| Override Simon-specific domain defaults | README now explicitly names both fallback values. Unset **or empty** `PUBLIC_BASE_URL` / `IMG_HOST` triggers Compose `:-` fallbacks to `https://img.simonswanderlust.com` / `img.simonswanderlust.com`; override both together. Required `:?` defaults are #293, not changed here. |
| Open `/login`, create account, upload, publish | Real HTTPS GET/setup/upload/save/publish API paths exercised; interactive login/editor/upload UI, console behavior and screenshots **not run**. No UI changed. |
| Public HTTPS reverse proxy | Real TLS with hostname verification on both names and default-trust rejection, verified loopback app/unpublished DB, overwritten proxy headers. Private CA/client trust only; no browser/system certificate-store or public certificate issuance evidence. |
| Split-domain reader comments | Known #319 reproduced and documented above; image-Origin control is not successful blog posting. No behavior fix in this issue. |
| Restart and health | Session/story/static pages/image/pending comment survive DB+app restart; HTTP health 200. Final Docker health remained `starting`; no `healthy` claim. |
| Measured peak memory/disk with corpus | Exact samples/derivations and caveats above; sampling does not establish exact phase peaks. Compose sizing comments now cite this bounded evidence, retaining both limits without inventing a hosting minimum. |
| No credentials in recorded evidence | Positive export allow-list, secret screening, reviewed evidence projections; hashes rather than secret/TLS material. |

There is no remaining prerequisite for this bounded documentation deliverable. Known product defect #319 and the explicit non-coverage above remain; successful jobs do not erase them. Public deployment/browser qualification, realistic corpus capacity, supported installation defaults (#293), codec security qualification (#347) and rollback policy (#298) are not established by this record.

## SHA-256 inventory

Hashes identify exact bytes, not an independent signature. Both architectures reported identical installer-input hashes matching the baseline manifest.

| Input / proof material | SHA-256 |
| --- | --- |
| `README.md` (rehearsed baseline) | `7b7f5f3ef20910672131174192eccc5b884ff6bdd6af3cdf37836b17b640463a` |
| `SECURITY.md` (rehearsed baseline) | `64e5f26909210e2c6b32d2c24df3bc5d8f5cdd5a62823a69e92115b42f9e1a43` |
| `docker-compose.yml` (rehearsed baseline) | `b20cb8114aaa6e121a7e975815eee33aaf810db8dd677d51fe036cdc3fe75af5` |
| `uploader/.env.example` (rehearsed baseline) | `c144005427db3a14e2b20270c653c9b19325370dd4080f52de92812a6c8c5bcf` |
| Historical harness | `3bc83be9b88567eb6329788f7dfea29de2bdd0c4bf860170344ba9a43ac1c183` |
| Historical workflow | `d12e49278a455aff3f309f613fb8ff9b994aa0f5a3b6dc1a3c0d9c564d535f19` |
| Historical manifest | `43e08572c2e8ffb62b889726912bd439155f61ade94091e02d790fcdaf38ebc9` |
| Canonical issue input | `5b5fedfd488e6f3605f3347aa09bbd617427b2c759d29e553b4caff4f070b440` |
| Release inventory input | `5544340519c5a716d7437ec2fd15270dd9505846fb07a9ecd058ea69031eb523` |
| Original local preparation `.issue-runtime/rehearse.py` (retained, not removed) | `0d12448d6fa40eafdf3226be02803bf59cbc8840a7b558de0382162330880eeb` |
| Original local preparation `.issue-runtime/REHEARSAL.md` (retained, not removed) | `8f5db5af60fa2ccb11edf5afde4079b9e1b74d2700286ef0ee77158d8958ab95` |
| Private run metadata `issue-292-native-ci-run.json` | `ede4ca040b669a128fd99e9370078f4a70883ff0162394810f2ca5812efd745f` |

### amd64 evidence and tools

| Retained file / executable | SHA-256 |
| --- | --- |
| `corpus.json` | `f962c36f4ef41dcb539b9ff7461093112b494604250af716c6075ee4dbf9b779` |
| `encode-memory.json` | `8608043088e32683a29040919a80867acb6e1cf91ed5127cb9e057cf54205064` |
| `idle-baseline-memory.json` | `c88a8a6c4d3e97ef5f963fab6a363f3f13461a688c0ba0cedc3ee0ae76d6c981` |
| `provenance.json` | `b77c0a008498a81318938918b883968d9f9ff04fbb9ebc82629b5f8d757d61dc` |
| `publish-build-memory.json` | `b95f24ad516c00b377952d63658ff479a17660152851e0fa27ad12667af08b0f` |
| `released-manifest.json` | `a0ff30e4316d4adad704613ec5250f275d96191c63b7bbc900d41b034b0cc1f9` |
| `steps.jsonl` | `145da8b3f2db2379bc58a7dd9cc2660a86fde4cf84d64d144936ebdab5939b3b` |
| Host `docker` executable | `6435ff9214bf8e0931078fb0980809728cac0a54a526d4f28a26d3e48132b58d` |
| Host `python3` executable | `e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f` |
| Host `openssl` executable | `b4f547c0f16272d1cc7f870330a6f2c243710c335e7a99c734ff7a0c6fdb2503` |

### arm64 evidence and tools

| Retained file / executable | SHA-256 |
| --- | --- |
| `corpus.json` | `f962c36f4ef41dcb539b9ff7461093112b494604250af716c6075ee4dbf9b779` |
| `encode-memory.json` | `420847267746dc43af47fe63e36b7169a25c4953f44398161ef943d79a86dca9` |
| `idle-baseline-memory.json` | `cc39cb72ccdaa28c106c11a2744eab16540c97298a2968d1a47a40ad1deab8ce` |
| `provenance.json` | `f8df4d0046457964da2c450095e366cf94ba1ac1ad5f1e74a666dba09ccaa164` |
| `publish-build-memory.json` | `2342029a1fef9c23b4f236f5125a0fd460034af269baa1a40f60dd3f74f14013` |
| `released-manifest.json` | `a0ff30e4316d4adad704613ec5250f275d96191c63b7bbc900d41b034b0cc1f9` |
| `steps.jsonl` | `ccf18995f0705466ec37bdc55101b16180983e07817f057a8c12cf3de611833b` |
| Host `docker` executable | `94128e4afada0d46de642165e79dd70beb08e6775014648013283ed901b68248` |
| Host `python3` executable | `c86f21d0da9290ece2d7d49a3f7ed52aed59cb029abdf0ea25c79634f6cbe960` |
| Host `openssl` executable | `a2044013d30169104887d7823bf7a0a1d443eafc34d7501876e22da532f24f0e` |
