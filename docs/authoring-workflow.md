# Authoring & Publishing Workflow

How to write a new travel post, add its photos, and get it live. Three stages:
**(1) upload the photos**, **(2) write the post in GitHub**, **(3) publish (rebuild)**.

The golden rule that shapes everything: **text lives in git, images do not.** Posts are
MDX files committed to the repo; photos are uploaded to the self-hosted **image uploader**,
which stores optimized variants on the server and serves them from
`https://img.simonswanderlust.com`. A post only ever references image **URLs**.

---

## Stage 1 — Upload the photos (do this first)

The uploader must be running (`docker compose up -d` brings it up with the blog). For the AI
alt-text suggestions, LM Studio must be running with `qwen/qwen3-vl-4b` **on the same machine
you're authoring from** — captioning happens in your browser, calling LM Studio directly at
`http://localhost:1234` (set on the LLM settings page). No suggestions? You can always type the
alt text by hand.

**Hero image** (one per post) — open the uploader admin:

- `https://simonswanderlust.com/admin/` (locally: `http://localhost:8090/admin/`) — the admin
  panel runs on the site's own domain under `/admin/`, WordPress-style (the site's nginx proxies
  it to the uploader). The uploader's own `:3000/admin/` still works too.
- Enter the token (`grep AUTH_TOKEN .env`), a **key** like `trips/<slug>/hero`, alt text, pick the photo, **Upload**.
- Copy the returned `heroImage:` YAML block.

**Body / gallery photos** (the rest) — open the batch page:

- `…/admin/batch.html`
- Enter the token + a shared **prefix** like `trips/<slug>`, pick several photos, **Suggest**.
- The local model proposes a slug + **German and English** alt text per photo; review/edit.
- **Upload all**, then copy the `<BodyImage …>` snippets (one DE, one EN per photo).

> Key naming: use `trips/<slug>/<name>` (lowercase `a–z 0–9 / _ -`). The `<slug>` should match
> the post's filename (below). Upload before publishing, or the URLs 404.

---

## Stage 2 — Write the post in GitHub

> **Coming in Phase B:** an in-admin editor will replace this stage. For now, writing MDX in
> GitHub is the authoring path.

Each post is **two MDX files** — one per language — under `site/src/content/trips/`:

- German: `site/src/content/trips/de/<slug>.mdx`  → lives at `simonswanderlust.com/<slug>/`
- English: `site/src/content/trips/en/<slug>.mdx` → lives at `simonswanderlust.com/en/<slug>/`

**The filename IS the live URL slug** — it must match the existing WordPress slug exactly and
must never be renamed (SEO contract). Link the two languages with the same `translationKey`.

In GitHub: open the repo → navigate to the folder → **Add file → Create new file** → name it
`<slug>.mdx` → paste the content → **Commit** (to `main`, or a branch + PR). Repeat for the
other language.

### Frontmatter (all required unless marked optional)

```yaml
---
title: 'Griechenland: Sonne und Abenteuer Rhodos'   # page title
date: 2021-07-25                                     # publication / travel date
country: 'Griechenland'                              # localized country name
countryCode: 'GR'                                    # ISO-3166 alpha-2
region: 'europe'                                     # europe | north-america | south-america
translationKey: 'rhodes-2021'                        # SAME value in the DE and EN file
excerpt: 'Eine Woche Sonne, Meer und Altstadtgassen.' # 1-2 sentence summary
heroImage:                                           # ← paste from the uploader's /admin/
  src: 'https://img.simonswanderlust.com/trips/rhodes-2021/hero'
  width: 2560
  height: 965
  alt: 'Küste von Rhodos im Sommerlicht'             # in the page's language
coordinates: { lat: 36.4341, lng: 28.2176 }
# optional:
# stops: [{ name: 'Lindos', lat: 36.09, lng: 28.09 }]
# route: 'Rhodos-Stadt → Lindos → Prasonisi'
# keyFacts: { 'Beste Reisezeit': 'Mai–Oktober', 'Dauer': '7 Tage' }
---
```

### Body

Markdown (headings, lists, links, etc.). To place a photo, paste the matching `<BodyImage>`
snippet from the batch page — **DE snippet into the German file, EN snippet into the English
file** (same image, language-appropriate alt):

```mdx
## Altstadt und Strände

Wir starteten in der Altstadt …

<BodyImage src="https://img.simonswanderlust.com/trips/rhodes-2021/old-town" width={1600} height={1067} alt="Gepflasterte Gasse in der Altstadt von Rhodos" />

Danach ging es an den Strand …
```

`BodyImage` is registered globally for post bodies (in `StoryPage.astro`), so **no import is
needed** — just paste the tag. It renders a responsive `<picture>` (AVIF + WebP, multiple sizes).

---

## Stage 3 — Publish (trigger a rebuild)

The blog is a **static site** served by an nginx container. Since Phase A, content lives in
**Postgres** — not in the Docker image. The site is built at runtime by a long-running
**`blog-builder`** service (`site/build-server.mjs`) that runs `astro build` on demand and writes
the output into a shared `blog-dist` volume that the `blog` nginx container serves.

**`docker compose up -d --build blog` no longer rebuilds the content.** Rebuilding the blog
image only updates the Astro/template code, not the post data.

To publish content changes after committing and importing them into Postgres, trigger a rebuild
via the `blog-builder`'s secret-gated HTTP endpoint (from the server):

```bash
curl -X POST http://localhost:3001/build \
  -H "Authorization: Bearer $BUILD_SECRET"
```

The service logs progress to stdout (`docker compose logs -f blog-builder`) and atomically swaps
in the new build when complete.

> **Phase B:** an in-admin Publish button will trigger this rebuild automatically — no manual
> `curl` needed.

Notes:

- **Images don't need a rebuild.** They're served by the uploader independently — uploading or
  re-uploading a photo is live immediately. Only content (text) changes need a rebuild.
- **Re-uploading the same key overwrites** the variants (immutable cache means you may need a
  hard refresh / cache bust to see a replaced image).
- **New environment variables** required for the blog stack: `DATABASE_URL` (Postgres connection
  string) and `BUILD_SECRET` (secret for the build trigger endpoint). See `uploader/.env.example`.

---

## Quick checklist

- [ ] Photos uploaded (hero via `/admin/`, body via `/admin/batch.html`); snippets copied.
- [ ] `site/src/content/trips/de/<slug>.mdx` created — frontmatter + `heroImage` + body with DE `<BodyImage>` tags.
- [ ] `site/src/content/trips/en/<slug>.mdx` created — same `translationKey`, EN alt, EN `<BodyImage>` tags.
- [ ] Slug matches the live WordPress slug (never renamed).
- [ ] Committed to GitHub and imported into Postgres.
- [ ] On the server: trigger a rebuild (`curl -X POST http://localhost:3001/build -H "Authorization: Bearer $BUILD_SECRET"`).
- [ ] Verify the post renders at `/<slug>/` and `/en/<slug>/`, hero + body images load.
