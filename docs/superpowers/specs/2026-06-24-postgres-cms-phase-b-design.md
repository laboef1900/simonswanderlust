# Design — Postgres CMS Phase B: In-Admin Post Editor + Publish + Export

**Date:** 2026-06-24
**Status:** Approved (brainstorming) — ready for implementation planning
**Parent design:** `docs/superpowers/specs/2026-06-23-postgres-cms-authoring-design.md`
**Builds on:** Phase A (`docs/superpowers/plans/2026-06-23-postgres-cms-phase-a.md`, PR #4) — the
`posts` table, the Postgres Content Layer loader, and the `blog-builder` runtime build endpoint.

## Problem

Phase A made the blog build its content from Postgres, but there is still **no way to author a
post from the admin** — posts only enter Postgres via the one-shot migration script. Phase B adds
the in-admin editor (create + edit DE/EN posts), a **Publish** action that triggers the existing
`blog-builder`, and an **MDX export** that serves as the human-readable backup (there is no git
history of content anymore).

## Goals

- Create and edit bilingual (DE+EN) posts entirely from the uploader admin, behind the existing login.
- **Publish** = mark the post published and rebuild the live site via the Phase A builder — one button.
- **Export** posts to MDX on the `/data` volume as the durable backup (auto on publish + on demand).
- Reuse the existing image flow (`/upload`, optional `/suggest`) for hero and body images.
- Preserve the **SEO slug contract** (slug = the live URL; never renamed once published).

## Non-Goals (YAGNI)

- No delete-from-admin (rare; removing a live URL has SEO consequences — stays a manual op).
- No revision history / draft-vs-published diffing beyond the single `status` flag.
- No WYSIWYG; bodies are Markdown (responsive images handled by the Phase A build transform).
- No scheduling / future-dated publish, no multi-build queue UI.
- No change to the Phase A loader, build mechanism, or schema shape.

## Key Decisions (from brainstorming)

1. **Both roles author.** Post routes use `requireAuth` (admin **and** author); admins still
   exclusively manage user accounts (`requireAdmin`, unchanged).
2. **Scope = create + edit** (no delete in v1).
3. **Integrated image upload** in the editor (hero picker + body-image insert call `/upload`).
4. **Auto-export on publish + on-demand "Export all"** to `/data/backup`.
5. **EasyMDE vendored** into `public/` (no external CDN — matches the self-hosted-fonts rule).
6. **Publish awaits the build synchronously** and shows the result (the builder's `/build` is
   synchronous, ~20–45s).
7. **`translation_key` auto-generated** on create (internal link for the DE/EN pair; not a user field).
8. **Both locales required** for a post (the site is bilingual; completeness is part of the contract).

## Architecture

Everything is in the **uploader** (Node 22 + Fastify 5), reusing its auth, Postgres pool, and image
endpoints. It writes the `posts` table that the Phase A site loader reads, and calls the Phase A
`blog-builder` over the internal Docker network.

| Unit | Responsibility | Location |
|------|----------------|----------|
| `postStore` | CRUD over `posts` as DE/EN pairs; draft upsert; publish | `uploader/src/posts.ts` (Postgres) + in-memory impl for tests |
| post validation | server-side mirror of the Astro zod schema | `uploader/src/posts.ts` (or `post-validate.ts`) |
| publish→build client | POST the builder `/build` with the shared secret, await result | `uploader/src/publish.ts` |
| MDX export | render posts → MDX files on `/data/backup` (+ zip) | `uploader/src/export.ts` |
| post routes | `GET/POST/PUT /posts*`, `POST /posts/:tk/publish`, `POST /export` | `uploader/src/server.ts` |
| editor pages | list + DE/EN editor; integrated upload; slug-lock | `uploader/public/posts.html`, `editor.html`, vendored EasyMDE |
| schema | `ensureSchema` also creates `posts` (idempotent) | `uploader/src/db.ts` |

### Data model

Reuses the Phase A `posts` table unchanged (one row per locale, linked by `translation_key`;
`status ∈ {draft, published}`; `images` jsonb map; `slug` unique per locale). The uploader's
`ensureSchema` gains the same idempotent `CREATE TABLE IF NOT EXISTS posts (...)` so the uploader
owns writes even on a fresh DB.

A **logical post** is the `(translation_key)` pair of a `de` row and an `en` row. `postStore`
always reads/writes them together.

### Post store interface

```
interface PostInput {            // one locale's editable fields
  locale: 'de' | 'en';
  slug: string;
  title: string; excerpt: string;
  heroImage: { src: string; width: number; height: number; alt: string };
  bodyMarkdown: string;
  images: Record<string, { width: number; height: number }>;
}
interface PostPair {             // the shared + per-locale data for one logical post
  translationKey: string;
  shared: { date: string; country: string; countryCode: string; region: string;
            coordinates: { lat: number; lng: number };
            stops?: {...}[]; route?: string; keyFacts?: Record<string,string> };
  de: PostInput; en: PostInput;
  status: 'draft' | 'published';
}
interface PostStore {
  list(): Promise<PostSummary[]>;                 // {translationKey, titleDe, slugDe, slugEn, status, updatedAt}
  get(translationKey): Promise<PostPair | null>;
  upsertDraft(pair: PostPair): Promise<PostPair>; // create or update both rows as draft
  publish(translationKey): Promise<void>;          // both rows → status='published'
}
```

`upsertDraft` generates `translation_key` (e.g. `randomUUID()`) on create; on update it preserves
the key. Slug immutability is enforced here: if either row is already `published`, its `slug` may
not change (→ `PostError`).

### Validation

Two validation levels, so work-in-progress can be saved but only complete posts go live:
- **Draft (`upsertDraft`)** — light: a DE title is required (to derive the slug), and `slug` must
  match `^[a-z0-9][a-z0-9-]*$` if present. Other fields may be empty/partial.
- **Publish** — full: a validator mirroring the Astro `trips` zod schema (the single source of the
  shape) checks **both** locales — required `title`/`excerpt`/`country`/`countryCode`(len 2)/
  `region`(enum)/`heroImage`(url + positive ints + non-empty alt)/`coordinates`(numbers), slug
  format, non-empty body. Incomplete → publish rejected.
Failures return `400 {error}`; the editor surfaces them inline.

### Publish → build

`POST /posts/:tk/publish`:
1. Validate the stored pair is complete (both locales valid).
2. `postStore.publish(tk)` — both rows `status='published'`.
3. `publish.ts` POSTs `${BUILDER_URL}/build` with header `x-build-secret: ${BUILD_SECRET}`, awaits
   (timeout ~120s), and returns `{ ok, release }` or `{ ok:false, error }` from the builder.
4. Auto-export the published post's MDX (see Export).
Response carries the build result so the editor can show "Published ✓ (release …)" or the build log
tail. New uploader env: `BUILD_SECRET` and `BUILDER_URL` (default `http://blog-builder:4000`),
wired in both compose files' `images` service.

### Export

`export.ts` renders a `PostPair` to two MDX files (frontmatter from shared+locale fields; body =
`bodyMarkdown` with each markdown image rewritten back to `<BodyImage src width height alt/>` using
the `images` map) and writes `/data/backup/trips/{de,en}/<slug>.mdx`. `POST /export` writes every
post and returns a `.zip`; publish auto-exports just the changed post. This is the durable,
human-readable backup that replaces git history.

### Editor UI

- **`public/posts.html`** — table (title, status, updated), **New post**, **Edit**, **Export all**;
  the admin nav gains a "Posts" link. Loads via `GET /posts`; gated client-side by `auth.js`
  `ensureAuthed()`.
- **`public/editor.html`** — **DE/EN tabs**; a shared frontmatter form (date, country, countryCode,
  region, coordinates, optional stops/route/keyFacts) and per-locale fields (title, excerpt, hero
  image, body). **Hero picker** uploads via `/upload` and fills the hero object; **"insert body
  image"** uploads, inserts `![alt](url)` at the cursor, and records `{width,height}` in that
  locale's `images` map; optional **AI alt** via `/suggest`. Body editing uses **EasyMDE**
  (vendored). **Save draft** → `POST/PUT /posts`; **Publish** → `POST /posts/:tk/publish` with a
  "building…" state then the result. **Slug** is derived from the DE title (slugified), shown as the
  live-URL preview, editable while draft, disabled once published.
- Reuses `auth.js`; on any `401`, redirect to `/login`.

## Error handling

- Validation → `400 {error}` (inline in the editor).
- Publish: builder unreachable / non-2xx / build failure → the post stays `published` in the DB but
  the response reports the build error; the editor shows it and offers Retry (re-publish re-triggers
  the build). A failed build never replaces the live site (Phase A atomic swap).
- Slug change on a published post → `409`.
- Duplicate `(locale, slug)` → `409`.
- Export write failure → `500 {error}`; publish still succeeds (export is best-effort, logged).
- All post/export routes `requireAuth`; anonymous → `401` (editor redirects to `/login`).

## Testing

Vitest (in-memory `postStore`, no live DB):
- `postStore`: create/list/get/update; `translation_key` generated on create, preserved on update;
  publish flips both rows; slug-immutability-after-publish guard; duplicate-slug guard.
- validation: each rule (countryCode len, region enum, hero url/dims/alt, slug format, both locales).
- export: `PostPair` → MDX round-trips (frontmatter + `<BodyImage>` reconstruction from the images map),
  inverse of the Phase A migration parser.
- publish client: mocked builder `fetch` — success returns `{ok,release}`; non-2xx / network error
  surfaced; correct `x-build-secret` header sent.
- routes via Fastify `inject`: `requireAuth` gating; `POST /posts/:tk/publish` calls the builder
  (injected mock) and auto-exports; `POST /export` writes files (temp dir).
- Static editor HTML verified manually (and by the deploy smoke).

Gates: `npm test` + `npm run typecheck` (uploader). No `any`/`@ts-ignore`.

## Dependencies / config

- New uploader dep: **EasyMDE** (vendored into `public/` like the webfonts; no CDN at runtime).
- New env (both compose files, `images` service + `.env.example`): `BUILD_SECRET` (shared with
  `blog-builder`), `BUILDER_URL` (default `http://blog-builder:4000`).
- `archiver` (or Node's `zlib`/a minimal zip) for the `.zip` download — prefer a tiny dependency-free
  approach if practical; otherwise a small, vetted zip lib.

## Risks

- **Build-time coupling unchanged** — publish depends on `blog-builder` + Postgres being up (Phase A
  property; the editor surfaces build errors and the live site stays on the last good build).
- **Slug contract** — the editor must hard-lock the slug after publish; covered by a server guard +
  test, since a slip permanently breaks a live URL.
- **EasyMDE bundle size / vendoring** — keep it to the minified asset; it's an admin-only page.
- **Two MDX↔post mappings** (Phase A migration parser, Phase B export renderer) must stay inverse;
  covered by the export round-trip test.
