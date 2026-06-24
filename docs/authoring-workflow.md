# Authoring & Publishing Workflow

How to write a new travel post, add its photos, and get it live. Three stages:
**(1) upload the photos**, **(2) write and publish via the in-admin editor**, **(3) rebuild (automatic on Publish)**.

**Post content lives in Postgres** — not in git or baked into the Docker image. The in-admin
editor (Phase B) is the authoring interface: you write DE and EN content directly in the browser
and hit **Publish** to trigger a rebuild. Photos are kept out of git and Postgres: they go to
the self-hosted **image uploader**, which stores optimized variants on the server and serves them
from `https://img.simonswanderlust.com`. A post only ever references image **URLs** — and you
can upload images inline from the editor without visiting a separate page.

---

## Importing existing WordPress content (one-time)

If you have an existing WordPress site with posts to migrate, you can import them directly
into Postgres without manually re-authoring each one:

1. **Export from WordPress** — WordPress admin → Tools → Export → select "All content" → download
   the `.xml` file (WXR format).
2. **Sign in to the uploader admin** — `/admin/` (the same login that manages posts and photos).
3. **Import** — Open the **Posts** tab, click **Import**, select the WXR file, and upload.
4. **What happens** — The importer parses the export, downloads hero + body images from the live
   WordPress site (so the old site must be reachable during import), stores optimized variants
   through the uploader's pipeline, and creates **draft posts** in Postgres. Slugs are preserved
   exactly — DE posts at the root, EN under `/en/`. Structured travel fields (country, region,
   coordinates, keyFacts) are filled with placeholder values — open each draft in the editor to
   enrich them. Images are already re-hosted, so no manual re-upload is needed.
5. **Refine and publish** — Open each draft in the editor, review the imported content, fill in
   missing details, and hit **Publish** when ready.

**Note:** The import is **idempotent by slug** — re-importing the same WXR will not overwrite
published posts or duplicate existing drafts. Only draft posts from this import are refreshed.

---

## Stage 1 — Upload the photos (do this first)

The uploader must be running (`docker compose up -d` brings it up with the blog). For the AI
alt-text suggestions, LM Studio must be running with `qwen/qwen3-vl-4b` **on the same machine
you're authoring from** — captioning happens in your browser, calling LM Studio directly at
`http://localhost:1234` (set on the LLM settings page). No suggestions? You can always type the
alt text by hand.

**Sign in first** — open `/admin/` (`https://simonswanderlust.com/admin/` or locally
`http://localhost:3000/admin/`). If this is a brand-new deployment, the first visit to `/login`
prompts you to create the initial admin account. After signing in, all admin pages work via the
session cookie — no token to paste.

**Hero image** (one per post) — you can upload it directly from the editor (see Stage 2), or
use the standalone upload page first:

- `https://simonswanderlust.com/admin/` (locally: `http://localhost:3000/admin/`) — enter a
  **key** like `trips/<slug>/hero`, alt text, pick the photo, **Upload**.
- Copy the returned `heroImage:` YAML values to paste into the editor's hero fields.

**Body / gallery photos** (the rest) — you can upload inline from the editor, or pre-upload in
bulk via the batch page:

- `…/admin/batch.html`
- Enter a shared **prefix** like `trips/<slug>`, pick several photos, **Suggest**.
- The local model proposes a slug + **German and English** alt text per photo; review/edit.
- **Upload all**, then copy the `<BodyImage …>` snippets (one DE, one EN per photo) into the
  editor's body fields.

> Key naming: use `trips/<slug>/<name>` (lowercase `a–z 0–9 / _ -`). The `<slug>` should match
> the post slug (below). Upload before publishing, or the URLs 404.

---

## Stage 2 — Write and publish via the in-admin editor

The in-admin editor at `/admin/posts.html` is the authoring interface — no GitHub or `curl`
needed. Content is stored in **Postgres**; MDX files are generated automatically as backups.

### Create a new post

1. Sign in and open **Posts** (`/admin/posts.html`).
2. Click **New post** — the editor opens at `/admin/editor.html`.
3. Fill in the **German** tab first (the slug is set here and locked once saved):

   | Field | Notes |
   |-------|-------|
   | **Slug** | Must match the live WordPress slug exactly — it becomes the URL (`/<slug>/`). Locked after first save. |
   | **Title** | DE page title |
   | **Date** | Publication / travel date (YYYY-MM-DD) |
   | **Country** | Localized country name |
   | **Country code** | ISO-3166 alpha-2 (e.g. `GR`) |
   | **Region** | `europe` \| `north-america` \| `south-america` |
   | **Excerpt** | 1-2 sentence summary |
   | **Hero image** | Paste the `src` URL, width, height, and alt text from the uploader; or use the inline **Upload** button next to the hero fields |
   | **Coordinates** | `lat`, `lng` decimal |
   | **Body** | Markdown (EasyMDE editor). Use `<BodyImage src="…" width={…} height={…} alt="…" />` tags to embed photos — paste snippets from the batch page, or upload inline via the body toolbar. |

4. Switch to the **English** tab and fill in the EN fields (title, excerpt, alt text, body).
   The slug and shared fields (date, countryCode, region, coordinates) carry over automatically.
5. Click **Save draft** — both locale rows are written to Postgres. The post is not yet live.

### Publish

Click **Publish** — this marks both locale rows as published and triggers the `blog-builder`
rebuild automatically. Wait for the confirmation toast, then verify the post is live at
`/<slug>/` and `/en/<slug>/`.

> The `blog-builder` rebuild is the same process as the manual `curl` call in Stage 3 — the
> Publish button just fires it for you.

### Edit an existing post

Open **Posts**, find the post, click **Edit**. Changes take effect after the next **Publish**.
Saving without publishing updates the draft but leaves the live site unchanged.

### Export / backup

The **Export all** button (Posts list) writes MDX backup files for all published posts to
`/data/backup` on the server. These are reference copies — Postgres is the source of truth.

### Body images

`<BodyImage>` tags in the body render as responsive `<picture>` elements (AVIF + WebP, multiple
sizes) — the same as in the MDX era. Paste the tag directly; no import is needed. Use the
**DE body** tab for German alt text and the **EN body** tab for English alt text (same image
URL, language-appropriate alt):

```
<BodyImage src="https://img.simonswanderlust.com/trips/rhodes-2021/old-town" width={1600} height={1067} alt="Gepflasterte Gasse in der Altstadt von Rhodos" />
```

---

## Stage 3 — How the rebuild works

The **Publish** button in the editor triggers a rebuild automatically — you don't need to run
`curl` manually under normal authoring conditions. This section explains what happens under the
hood and how to trigger a rebuild manually if needed.

The blog is a **static site** served by an nginx container. Content lives in **Postgres** — not
in the Docker image. The site is built at runtime by a long-running **`blog-builder`** service
(`site/build-server.mjs`) that runs `astro build` on demand and writes the output into a shared
`blog-dist` volume that the `blog` nginx container serves.

**`docker compose up -d --build blog` does not rebuild the content.** Rebuilding the blog
image only updates the Astro/template code, not the post data.

To trigger a rebuild manually (e.g. from the server, or after a template code change):

```bash
curl -X POST http://localhost:3001/build \
  -H "Authorization: Bearer $BUILD_SECRET"
```

The service logs progress to stdout (`docker compose logs -f blog-builder`) and atomically swaps
in the new build when complete.

Notes:

- **Images don't need a rebuild.** They're served by the uploader independently — uploading or
  re-uploading a photo is live immediately. Only content (text) changes need a rebuild.
- **Re-uploading the same key overwrites** the variants (immutable cache means you may need a
  hard refresh / cache bust to see a replaced image).
- **Required environment variables** for the blog stack: `DATABASE_URL` (Postgres connection
  string) and `BUILD_SECRET` (secret for the build trigger endpoint). See `uploader/.env.example`.

---

## Quick checklist

- [ ] Photos uploaded — hero and body images via the editor's inline upload, or pre-uploaded via `/admin/` (hero) and `/admin/batch.html` (batch); snippets/URLs ready.
- [ ] In the editor: DE tab filled — slug (matches live WordPress slug, never renamed), title, date, country, countryCode, region, excerpt, heroImage fields, body with DE `<BodyImage>` tags.
- [ ] In the editor: EN tab filled — title, excerpt, EN alt texts, EN body with EN `<BodyImage>` tags.
- [ ] **Save draft** — both locale rows written to Postgres.
- [ ] **Publish** — rebuild triggered automatically.
- [ ] Verify the post renders at `/<slug>/` and `/en/<slug>/`, hero + body images load.
