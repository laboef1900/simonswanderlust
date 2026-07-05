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

The uploader must be running (`docker compose up -d` brings it up with the blog).

**Sign in first** — open `/admin/` (`https://simonswanderlust.com/admin/` or locally
`http://localhost:3000/admin/`). If this is a brand-new deployment, the first visit to `/login`
prompts you to create the initial admin account. After signing in, all admin pages work via the
session cookie — no token to paste.

**Hero image** (one per post) — you can upload it directly from the editor (see Stage 2), or
use the standalone upload page first:

- `https://simonswanderlust.com/admin/` (locally: `http://localhost:3000/admin/`) — enter a
  **key** like `trips/<slug>/hero`, alt text, pick the photo, **Upload**.
- Copy the returned `heroImage:` YAML values to paste into the editor's hero fields.

**Body / gallery photos** (the rest) — upload them inline from the editor's body toolbar:
each upload inserts a markdown image (`![alt](URL)`) at the cursor and records the photo's
dimensions automatically. Alternatively, pre-upload via the standalone upload page using a
`trips/<slug>/<name>` key per photo and paste the returned `<BodyImage …/>` body snippet into
the post body — it is converted to a markdown image on save. Write the German and English alt
text by hand.

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
   | **Body** | Markdown (EasyMDE editor). Embed photos via the body toolbar's inline upload — it inserts a markdown image (`![alt](URL)`) and records the dimensions automatically. Pasted `<BodyImage …/>` tags (from an MDX backup or the upload page) also work: they're converted on save. |

4. Switch to the **English** tab and fill in the EN fields (title, excerpt, alt text, body).
   The slug and shared fields (date, countryCode, region, coordinates) carry over automatically.
5. Click **Save draft** — both locale rows are written to Postgres. The post is not yet live.

### Publish

Click **Publish** — this marks both locale rows as published, takes a **published snapshot** of
the current content (the exact version the live site will serve), and runs the rebuild
in-process, awaiting it before the request returns. Wait for the confirmation toast, then verify
the post is live at `/<slug>/` and `/en/<slug>/`.

> See Stage 3 for what the rebuild does and how to trigger it manually (e.g. after a restore).

### Edit an existing post

Open **Posts**, find the post, click **Edit**. Saving a draft of a published post **never**
changes the live site — rebuilds of any kind (publishing another post, saving the About page,
**Rebuild site now**) keep serving the published snapshot, not your in-progress edits. The Posts
list marks such posts with an **edited** badge and the editor status line shows
*has unpublished changes*. Your edits go live only when you hit **Publish** again, which
refreshes the snapshot.

### Export / backup

The **Export all** button (Posts list) writes MDX backup files for all posts to
`/data/backup` on the server. Exports contain the **working copies** (what you see in the
editor) — including draft edits not yet published. These are reference copies — Postgres is the
source of truth.

### Body images

Body photos are markdown images (`![alt](URL)`) whose dimensions are recorded in the post's
images map — at build time they render as responsive `<picture>` elements (AVIF + WebP,
multiple sizes), the same markup as in the MDX era. The editor's inline body upload does both
steps for you: it inserts the markdown image at the cursor and records the dimensions.

Pasting a `<BodyImage src="…" width={…} height={…} alt="…" />` tag also works — e.g. from an
MDX backup under `/data/backup`, or the body snippet shown by the standalone upload page. It is
normalized to a markdown image on save and its width/height are merged into the images map.
Use the **DE body** tab for German alt text and the **EN body** tab for English alt text (same
image URL, language-appropriate alt):

```
<BodyImage src="https://img.simonswanderlust.com/trips/rhodes-2021/old-town" width={1600} height={1067} alt="Gepflasterte Gasse in der Altstadt von Rhodos" />
```

> Don't hand-write a bare markdown image for a photo whose dimensions were never recorded
> (i.e. not uploaded via the editor toolbar and not pasted as a `<BodyImage …/>` tag) — it
> renders as a plain `<img>` without the responsive treatment.

---

## Stage 3 — How the rebuild works

The **Publish** button in the editor triggers a rebuild automatically and waits for it to finish
before confirming — you don't need to run anything manually under normal authoring conditions.
This section explains what happens under the hood and how to trigger a rebuild manually if needed.

The blog is a **static site**, but there's no separate build server or web server anymore: the
same `app` container that runs the admin/CMS also builds and serves the blog. Content lives in
**Postgres** — not in the Docker image. `uploader/src/build.ts` spawns `astro build` **in-process**
(via plain `node`, no shell) on demand, and writes the output into `/data/site/releases/<stamp>`,
then atomically flips the `/data/site/current` symlink that the app serves directly.

**`docker compose up -d --build` does not rebuild the content.** Rebuilding the `app` image only
updates the Astro/template code, not the post data.

To trigger a rebuild manually (e.g. after a database restore, or a template code change), sign in
as an admin and use the **Rebuild site now** button on the settings page (`/admin/settings.html`),
which calls the admin-only `POST /rebuild` route.

Notes:

- **Rebuilds render published snapshots only.** The site is built from each post's published
  snapshot (taken at Publish time) — saved-but-unpublished edits never appear on the live site,
  no matter what triggers the rebuild.
- **Images don't need a rebuild.** They're served by the app independently — uploading or
  re-uploading a photo is live immediately. Only content (text) changes need a rebuild.
- **Re-uploading the same key overwrites** the variants (immutable cache means you may need a
  hard refresh / cache bust to see a replaced image).
- **Required environment variable** for the stack: `DATABASE_URL` (Postgres connection string).
  See `uploader/.env.example`.

---

## Quick checklist

- [ ] Photos uploaded — hero and body images via the editor's inline upload, or pre-uploaded via `/admin/` (hero); snippets/URLs ready.
- [ ] In the editor: DE tab filled — slug (matches live WordPress slug, never renamed), title, date, country, countryCode, region, excerpt, heroImage fields, body photos inserted via the toolbar (or pasted `<BodyImage …/>` tags — converted on save) with DE alt text.
- [ ] In the editor: EN tab filled — title, excerpt, EN hero alt text, EN body with its own photo inserts (EN alt text).
- [ ] **Save draft** — both locale rows written to Postgres; the live site is never affected by a save.
- [ ] **Publish** — snapshots the content as the live version and triggers the rebuild automatically.
- [ ] Verify the post renders at `/<slug>/` and `/en/<slug>/`, hero + body images load.
