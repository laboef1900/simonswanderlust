# Authoring & Publishing Workflow

How to write a new travel post, add its photos, and get it live. Three stages:
**(1) upload the photos**, **(2) write the post in GitHub**, **(3) publish (rebuild)**.

The golden rule that shapes everything: **text lives in git, images do not.** Posts are
MDX files committed to the repo; photos are uploaded to the self-hosted **image uploader**,
which stores optimized variants on the server and serves them from
`https://img.simonswanderlust.com`. A post only ever references image **URLs**.

---

## Stage 1 — Upload the photos (do this first)

The uploader must be running (`docker compose up -d` brings it up with the blog), and for the
AI alt-text suggestions, LM Studio must be running with `qwen/qwen3-vl-4b` on `:1234`.

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

## Stage 3 — Publish (rebuild the blog)

The blog is a **static site** served by an nginx container; it is built at image-build time, so
a content change is live only after the blog image is rebuilt. There is **no auto-deploy yet**
(see below). On the server:

```bash
git pull                              # fetch the new/edited MDX from GitHub
docker compose up -d --build blog     # rebuild + restart only the blog container
```

Notes:

- **Images don't need a rebuild.** They're served by the uploader independently — uploading or
  re-uploading a photo is live immediately. Only **text/MDX** changes need the blog rebuild.
- **Re-uploading the same key overwrites** the variants (immutable cache means you may need a
  hard refresh / cache bust to see a replaced image).

### Optional: automate publishing

Right now publishing is the manual `git pull && docker compose up -d --build blog` above. If you
want a push-to-publish flow, options are: a GitHub Actions workflow that SSHes to the server and
runs that command on every push to `main`, or a small webhook listener on the server. Ask and
this can be added as its own small task.

---

## Quick checklist

- [ ] Photos uploaded (hero via `/admin/`, body via `/admin/batch.html`); snippets copied.
- [ ] `site/src/content/trips/de/<slug>.mdx` created — frontmatter + `heroImage` + body with DE `<BodyImage>` tags.
- [ ] `site/src/content/trips/en/<slug>.mdx` created — same `translationKey`, EN alt, EN `<BodyImage>` tags.
- [ ] Slug matches the live WordPress slug (never renamed).
- [ ] Committed to GitHub.
- [ ] On the server: `git pull && docker compose up -d --build blog`.
- [ ] Verify the post renders at `/<slug>/` and `/en/<slug>/`, hero + body images load.
