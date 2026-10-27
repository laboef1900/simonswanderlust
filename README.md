# Wanderlust Studio

**A self-hosted CMS for travel blogs. Built for the stories, photographs and places worth sharing.**

Turn a journey into a photo-rich travel journal: write your story, arrange the gallery,
plot the route and publish in German and English. Wanderlust Studio brings the editor,
media library, maps and publishing workflow together—with your content on your own server.

Originally built for **Simon's Wanderlust**, it pairs a browser-based writing studio with
an editorial, photography-first blog. No editing Markdown files in git to publish a post.
No separate image service or build server to run.

**[Start your travel journal](#quick-start-full-stack-docker)** ·
[Explore the authoring workflow](docs/authoring-workflow.md) ·
[Browse releases](https://github.com/laboef1900/simonswanderlust/releases)

## More journey. Less publishing machinery.

### Give your photography room to breathe

Upload a collection of photos, organize it into folders and build a gallery without
leaving the editor. Choose justified rows, a wide break-out or a slider; readers can
open the photographs in a lightbox.

The image pipeline creates responsive **AVIF and WebP** variants automatically, with a
JPEG option for JPG uploads. Choose your quality settings and compare the result before
committing to them. Keep the originals privately; publish optimized variants without
embedded GPS coordinates.

Photo descriptions have a home, too. Manage German and English alt text and captions in
**Media**, and article galleries pick up the current values on the next site rebuild.
Describe a photograph once per language—not again in every story that uses it.

### Write the story, not the layout

A focused Markdown editor keeps the manuscript at the centre. Add an opening photograph,
a separate title image, key facts and an itinerary, then preview the result before it
goes live. The public blog gives those ingredients an editorial layout, with generous
photography, a table of contents, destination pages and expedition-log details.

**Drafts, revision history and explicit publishing** give you room to work. Saving changes
to an existing article does not publish them. Publish when the story is ready; the app
builds and serves the new static pages. Gallery descriptions from Media follow their own
next-rebuild update rule.

### Put the places on the page

Give readers a way to follow your travels—not just read about them. A travel map connects
your published stories, while individual articles can show their location and route stops.
Country-coordinate assistance and optional waypoint search help you place the journey.

Public maps use **self-hosted map tiles and fonts**. They do not need a third-party map
service in your readers' browsers. Editor waypoint searches are separate and use an
external geocoding service when requested.

### Tell it in two languages

German and English belong to the same story. Switch between locale tabs to write titles,
excerpts, country names, key facts and photo descriptions, while shared trip details stay
together. Readers get language switching and linked translations: German at the root,
English under `/en/`.

This is a purpose-built **DE/EN workflow**, not a promise of automatic translation or an
arbitrary-language site builder.

### Keep your voice. Get help where it counts.

Optional AI tools can suggest excerpts, review a story and describe photographs. Choose
local or remote providers independently for editorial work and photo descriptions.
Review Story works on the unsaved active language; suggestions do not silently rewrite
your article or gate publishing.

For a large photo collection, generate titles, bilingual alt text, captions and tags in
bulk. Fill empty fields by default; replacing existing descriptions is an explicit choice.
Bulk photo-detail generation saves as it runs, while single-photo suggestions wait for
**Save details**.

**AI is optional.** Writing, uploading and publishing work without a model. When enabled,
model requests go directly from the author's browser to the selected provider; the server
never runs inference. Remote providers may charge for use and receive the submitted content.

## A travel blog you control

- **Your stories, your server.** Posts, accounts and comments live in Postgres. Image
  originals, generated variants, releases and backups stay in your self-hosted storage.
- **A static reading experience.** Astro builds the public pages ahead of time; the CMS
  does not assemble each article on every reader request.
- **Discovery built in.** Canonical URLs, language alternates, social-sharing metadata,
  structured article data, sitemaps and RSS feeds are part of the public site.
- **Conversations without a comment platform.** Optional reader comments are self-hosted,
  held for moderation and support author replies. Readers do not need to supply an email.
- **A way out, not a lock-in.** Export posts as MDX, back up the database and archive your
  images. Scheduled and on-demand backups are available in the admin.
- **A path from WordPress.** Import a WXR export, preserve existing post slugs and re-host
  its photos. Imported stories arrive as drafts for you to review before publishing.

## From camera roll to published story

1. **Collect.** Upload your photographs to Media, organize folders and add descriptions.
2. **Compose.** Write the article, choose your images and gallery layout, and add trip facts
   and map stops. Work on the second language in the same editor.
3. **Review.** Open Preview, check the photos and wording, and use optional editorial help.
4. **Publish.** The app rebuilds the blog and switches to the new release. Your photographs,
   maps and story are ready for readers.

[Walk through your first post](docs/authoring-workflow.md).

## Quick start (full stack, Docker)

**Bring your own server, keep your own journal.** The stack runs as two containers:
one app for the CMS, image processing and public blog, plus Postgres. Published images
are available for amd64 and arm64.

This repository includes Simon's Wanderlust branding and a DE/EN site. Adapting it to your
own blog means updating the site identity, domain configuration and any templates you want
to change in source. It is a self-hosted project, not a hosted signup service or a no-code
theme marketplace. This README describes the current source; tagged images contain the
features shipped in their release.

### Start with a released image

You need Docker Engine with Compose (or Docker Desktop). From a checkout of this repository:

```bash
cp uploader/.env.example .env
```

Before starting, edit your private `.env`:

- Set `POSTGRES_PASSWORD` to a strong, randomly generated password. Compose derives
  `DATABASE_URL`; leave the bare-development override commented out.
- For a local trial, set `PUBLIC_BASE_URL=http://localhost:3000` and
  `IMG_HOST=localhost:3000`. For a server, use your image domain and its matching host.
- Set `IMAGE_TAG` to the [release](https://github.com/laboef1900/simonswanderlust/releases)
  you want to run. The committed default is `0.17.1`.

The app runs as non-root uid 1000. On a Linux host, prepare the data directory so it is
writable, then start the stack:

```bash
mkdir -p uploader/data
sudo chown -R 1000:1000 uploader/data
docker compose pull
docker compose up -d
```

If the GHCR package requires authentication, run `docker login ghcr.io` before pulling.
Open **http://localhost:3000/login** to create the first admin account, then head to the
editor and write your first post.

For public hosting, use **one HTTPS reverse proxy in the host network namespace**, with no
CDN or additional proxy hop, and route both blog and image domains to `127.0.0.1:3000`.
Preserve the verbatim `Host`, overwrite `X-Forwarded-Proto` with the proxy's own scheme,
and append or overwrite `X-Forwarded-For` so the rightmost entry is its accepted client.
Compose exposes port 3000 on **loopback only** and sets `TRUSTED_PROXY: docker-gateway`
literally; do not add it to `.env`. The app trusts only loopback and the discovered bridge
gateway at hop zero, and refuses boot if gateway discovery fails. Postgres stays internal.
Before cutover, verify the actual target-server peer, HTTPS `Secure` cookies and independent
rate-limit buckets from two external networks; Docker Desktop TCP proof is not a VPS
rehearsal. See [architecture and deployment](ARCHITECTURE.md) and the
[security model](SECURITY.md#transport-headers--proxy) before exposing the service.

### Build the current source

Compose runs images; it does not build them. To use your own changes:

```bash
docker build -t ghcr.io/laboef1900/simonswanderlust-app:local .
IMAGE_TAG=local docker compose up -d
```

The Dockerfile uses Docker Hardened Images (`dhi.io/node`); building requires access to
those base images. Pulling a finished release from GHCR does not require a DHI login.

**Redeploying the app does not rebuild an existing blog.** Use Publish or **Rebuild site
now** to regenerate the static output. See [the publishing guide](docs/authoring-workflow.md).

### Connect an optional AI provider

Configure providers and per-use-case models under **Settings → AI models**. Local-only
use needs no encryption master key. Remote credentials require a private `ENCRYPTION_KEY`
and separate key escrow for recovery. Credentials are encrypted at rest but disclosed
to signed-in authors for browser-direct requests.

[Provider setup and credential recovery](uploader/README.md#ai-providers-and-encrypted-credentials-214-registry-2026-10-19).

## Backups

Your journal deserves a copy somewhere else. The built-in database dumps and incremental
image archives live under `/data/backup/db`, on the **same disk as the running app**.
Schedule a host-level offsite backup of `./uploader/data` as well; keep any AI encryption
master key separately. A local backup alone is not disaster recovery.

[Backup and restore procedures](ARCHITECTURE.md#backups--disaster-recovery).

## Under the hood

| Part | Responsibility | Stack |
| :-- | :-- | :-- |
| [`site/`](site/) | Photography-first public blog, built from published Postgres content | Astro 7, Tailwind 4, MapLibre |
| [`uploader/`](uploader/) | Wanderlust Studio, media processing, imports, builds and serving | Node 26, Fastify 5, sharp |
| Postgres | Stories, accounts, media metadata and comments | PostgreSQL 18 |

The app runs Astro builds at runtime and serves the resulting release itself. Content is
managed through the CMS, not committed as source files; MDX exports are portable backups.
There is no separate build-server container to operate.

For local site development with Node 26+ and a reachable, initialized Postgres database:

```bash
cd site
npm ci
npm run dev
```

Set `DATABASE_URL` for the site process. Both `npm run build` and `npx astro check` load
content from Postgres. Site unit tests run with `npm test` without a database; uploader
integration tests need a separate `TEST_DATABASE_URL`.

## Software, contributions and content rights

**Wanderlust Studio software is licensed under [GNU AGPL version 3 only](LICENSE)
(`AGPL-3.0-only`). Copyright 2026 Simon and contributors.** This covers original
application code, tests, build scripts and technical documentation, without warranty
to the extent permitted by law. Third-party components retain their own licenses.

Stories and translations, uploaded photos and illustrations, MDX story content
(including `site/src/content/trips/` stubs), reader submissions and brand/logo
artwork are **excluded from the software grant and are not open-licensed here**.
Permission comes from their respective rightsholders, unless separately licensed
or permitted by law. No ownership of users' or third parties' content is claimed.
Using the CMS does not itself put authored content under AGPL or change its
visibility/access controls. Software embedded in generated output retains its
applicable license; AGPL §2 governs when output constitutes a covered work.

Original software contributions are accepted under **AGPL-3.0-only, inbound =
outbound**, with **no DCO or CLA**. Submit only material you have authority to
license and preserve third-party notices. This is not a copyright assignment.

The product stays **Wanderlust Studio**. The software grant does not grant rights
to brand a separate service as “Simon's Wanderlust” or “Wanderlust Studio”, use
their logos, or imply endorsement. See [NOTICE](NOTICE) and the
[owner decision](docs/superpowers/specs/2026-10-27-software-content-brand-rights-design.md).
The separately approved image rename is implemented on
`feature/issue-291-image-name`; old artifacts remain untouched.

### Distributing and operating modified software

Provide the exact version's Corresponding Source under AGPL §6 when distributing
object code, with clear source directions alongside each image/release. Modified
network versions must prominently offer their Corresponding Source to all remote
users, at no charge, under §13. A moving upstream branch or package inventory alone
is not proof of correspondence. Release builds record the existing GitHub repository
and full commit in `/app/source-release.json`; legal indexes offer that exact
revision's archive and source tree, and release notes pair the links with the image
digest. Local builds without that provenance explicitly show an unknown revision.
Operators modifying code must provide their actual source and update those static
directions, not claim their changes match upstream. The source archive contains
tracked repository files; any tracked stories/content remain excluded from the
software license. It collects no deployed uploads, databases, settings or secrets.
No runtime configuration, source-download API or content export is introduced.

`node uploader/scripts/generate-third-party-inventory.mjs` regenerates the lockfile
[inventory](docs/third-party-inventory.json); [evidence](docs/third-party-evidence.json)
records non-lockfile assets and obligations. After `npm ci`, run
`node uploader/scripts/copy-legal.mjs site` and
`node uploader/scripts/copy-legal.mjs uploader` from the repository root to package
licenses, rights statements, inventory and installed-package notices. Docker does
both; site `predev`/`prebuild` also refresh site notices. They are delivered through
existing static serving at `/legal/de.html`, `/legal/en.html` and
`/admin/legal/en.html`. Review `notice-gaps.json` and actual emitted/native assets:
collecting notice files is not a complete dependency or corresponding-source audit.
Exact historical `0.17.1` amd64/arm64 inspection and verified DHI base SBOM/source
attestations are recorded in [image evidence](docs/third-party-image-evidence.json).
Those images lack readable glyph/native package notices; this patch does not
change their bytes or certify old images. Full native component notices, matching
Rust standard-library notices and source/relink directions are now included as
supplements. Review the recorded upstream missing-notice and mutable-input
limitations, then check correspondence and delivery in the final rebuilt release.

## Documentation

- [Authoring workflow](docs/authoring-workflow.md) — photos, stories, galleries and publishing.
- [Architecture](ARCHITECTURE.md) — storage, deployment, builds, backups and recovery.
- [Security](SECURITY.md) — permissions, photo privacy, credentials and request safeguards.
- [Map assets](docs/map-assets.md) — self-hosted basemaps and fonts.
- [Site development](site/README.md) · [CMS operations](uploader/README.md).
- [Contributor conventions](CLAUDE.md) · [Design specs and plans](docs/superpowers/).

<details>
<summary>Maintainers: releases and upgrade notes</summary>

### Cutting a release

**Current release: v0.17.1.** Fixes since v0.17.0:

- Gallery reloads no longer risk saving mixed DE/EN content after partial form loading;
  failed reloads preserve a local recovery copy and block Save, Preview and Publish.
- Galleries inserted at the end of a story stay separated from subsequent photos and prose.
- Editor and public story maps frame split antimeridian routes consistently, preserve
  genuinely wide routes, and keep route overlays visible when the local basemap is unavailable.
- Publish checks readiness against the images actually rendered in the story, including
  direct Markdown and HTML references, without blocking on unused image metadata.
- Image backups exclude unfinished temporary files and capture completed images that cross
  an incremental archive boundary, using a cutoff from the images filesystem.

Before upgrading, take **Back up now** and retain the previous image and backup.
The first image backup after this upgrade creates a **full image archive** to establish
the new cutoff provenance; allow capacity for that archive plus the existing free-space
reserve. Missing or invalid backup state also requires a full archive. Existing archives
are preserved; insufficient space reports a failure rather than deleting backup history.
See [Database dumps](ARCHITECTURE.md#database-dumps).

Upgrading from before v0.17.0: GPX recovery requires the private v10 database dump **and
its matching route archive**. Restore is offline: stop the app before running the restore
CLI, then restart it after inspecting the result. API clients calling
`POST /posts/:tk/publish` must send `baseUpdatedAt` and `baseRouteVersion`; the bundled
editor already does so. GPX originals, elevation and timestamps stay private but are
readable by authenticated authors. Publish creates a simplified, four-decimal 2D route;
explicitly adopted waypoints remain shared stops at their exact coordinates.
Deploying does not publish drafts or rebuild the live blog. Route precision is not
anonymization: remove sensitive points and inspect separately adopted stops before Publish.

Upgrading from before v0.15.0: take **Back up now** before deploying. First boot migrates
`settings.json` and the stored AI key into the provider registry, keeping
`settings.json.pre-ai-registry`. Rolling back needs the older image, the dump and that file.

1. On a `feature/*` branch from `dev`, update both apps' package and lockfile versions,
   plus `IMAGE_TAG` defaults in `docker-compose.yml` and `uploader/.env.example`. Update
   the release notes here.
2. Merge a green PR into `dev`, then a green release PR from `dev` into `main`.
3. Tag the merged release on `main` (example for this release):

```bash
git fetch origin main
git tag -a v0.17.1 origin/main -m "Release v0.17.1"
git push origin v0.17.1
```

Never push directly to protected branches, tag an unmerged feature branch or replace a
published tag. The release workflow builds once for amd64 and arm64, pushes to GHCR and
creates the GitHub Release. It requires repository variable `DHI_USERNAME` and secret
`DHI_TOKEN` to pull the hardened base images. Verify the workflow before deployment;
publishing a release does not deploy it or rebuild the live blog.

</details>
