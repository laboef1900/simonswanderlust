# 2026-09-05 — Slug auto-derivation guard for unpublished posts (#122)

**Risk: High** per CLAUDE.md ("any slug or route change" / Golden Rule 2). Branch:
`feature/122-slug-derive-guard`.

## Defect

`editor.html` re-derived the slug from the title on **every** title keystroke unless the post was
published. Nothing distinguished a slug the author typed, or one loaded from the server, from a
derived one. The WXR importer creates **drafts** under the live WordPress slugs with placeholder
metadata that authors must edit before publishing — so the normal workflow (open the imported
draft, fix a title typo, publish) silently replaced the live slug with whatever the new title
derived to, and Publish then changed the URL.

## Invariants

1. **Auto-derivation only fills an empty slug.** Per locale, the editor derives `slugify(title)`
   while the slug field is *still automatic*: a new post starts automatic; the field turns
   manual when the author types a non-empty value into it, and back to automatic when they clear
   it. Any slug that came from the server (`loadPost`), a revision snapshot (`restoreRevision`),
   or the local unsaved stash (`populateForm` in every case) is manual. Published posts keep their
   existing disabled fields.
2. **A slug change on an existing draft is explicit.** The editor remembers the slugs it loaded
   (`loadedSlugs`). If a save would change a non-empty loaded slug, it asks for confirmation
   naming the locale, the old and the new slug, and only then sends `confirmSlugChange: true`.
   The server (`POST/PUT /posts` in `server.ts`) refuses a slug change on an existing pair whose
   stored slug is non-empty unless that flag is present — **409 `slug_change_unconfirmed`** — so a
   stale tab, a script, or a future client cannot rename a draft by accident. Filling in a slug
   that was `''` (DE-first draft getting its EN slug, #119) needs no confirmation. Published posts
   are still governed by the stricter `slug_locked`.
3. The importer, `POST /posts/bulk`, duplicate-post and publish paths are untouched: the guard
   lives in the HTTP `upsert` route, not in the store, and only fires when `tk` names an existing
   pair whose slug differs from the payload.

## Trust boundaries / misuse

- The confirm flag is a *deliberateness* signal from an authenticated author, not an
  authorization: any author may still rename a draft slug, exactly as before. What changes is
  that it can no longer happen without the author seeing it.
- No new server input reaches storage: `confirmSlugChange` is stripped from the payload like
  `updatedAt`; `validateDraft` rejects a non-boolean value.

## Rollback

Revert the PR. No schema or data change; a client that keeps sending `confirmSlugChange` is
ignored by the reverted server (the field was already tolerated as an unknown key).

## Verification

- `uploader/test/server.test.ts` — PUT that renames a draft slug without the flag → 409
  `slug_change_unconfirmed`, nothing saved; with the flag → 200; filling an empty EN slug → 200
  without the flag; POST (new pair) never asks.
- `uploader/test/editor-slug.test.ts` — the extracted derivation rule (`public/slug-derive.js`):
  derives while automatic, stops after a manual edit, resumes after clearing, never on a loaded
  slug.
- Browser verification of the real editor: open an imported-style draft, edit the title, the
  slug stays; change the slug and save → confirm dialog; screenshot in the PR.
