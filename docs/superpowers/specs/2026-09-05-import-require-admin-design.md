# `POST /import` becomes admin-only (issue #97)

**Date:** 2026-09-05 · **Risk:** high (authorization change) · **Size:** small

## Decision

`POST /import` moves from `requireAuth` to `requireAdmin`. The admin UI follows: `import.html`
calls `Auth.ensureAuthed({ admin: true })` and the "Import WXR" nav entry is flagged `admin: true`,
so a non-admin author never sees a link to a page that bounces them.

## Why

`SECURITY.md` draws the admin line at **reversibility**, and an import is reversible in principle
(drafts can be deleted). Three things nonetheless put it on the admin side:

1. **Outbound reach.** The importer fetches from hosts named in the export. `isBlockedHost` does
   not block RFC1918, so an author-level import can drive requests at internal addresses. #90
   removed the response oracle; #97 removes the trigger from non-admins.
2. **Amplification.** The per-import distinct-image cap (#96) bounds a run at 20,000 fetches, which
   is still a large budget to hand any session holder.
3. **Coherence.** The knobs governing an import (`importDelayMs`, `importRetries`) live in
   `/settings`, which is admin-only. An author previously ran a job whose parameters they could
   not read.

Every comparable surface (`/rebuild`, `/settings`, `/backups`, publish, irreversible media ops) is
already admin-only.

## Trust boundaries

- Before: any authenticated session → import. After: admin session → import; author → 403.
- The 403 is produced by the shared `requireAdmin` preHandler, before the multipart body is read.
- No change to `safeFetch`, the traversal guards, or the import pipeline itself.

## Misuse cases considered

- Author uploads a crafted export to probe the internal network → now 403 before any parse.
- Author triggers repeated large imports to exhaust `/data` or the source host → now 403.
- Admin misuse is unchanged and accepted: the admin already has `/settings`, `/backups`, and
  `/rebuild`.

## Invariants (tested in `uploader/test/server.test.ts`, "WordPress import")

- Anonymous → 401. Non-admin author → 403 and no post is created. Admin → unchanged 200 path.

## Rollback

Revert the commit: one preHandler token, one `ensureAuthed` argument, one nav flag, docs. No data
or schema change is involved.
