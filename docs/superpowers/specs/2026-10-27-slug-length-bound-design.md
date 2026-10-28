# #353 — Bound slug components without renaming URLs

**Status: OWNER APPROVED 2026-10-28. Risk: High.** Approved: 251 ASCII bytes, truncation only for newly auto-derived slugs and the blocking compatibility inventory. No existing/manual URL rename, owner-data mutation or deployment is authorized.

## Decision requested

Approve **251 ASCII bytes** as the maximum accepted nonempty story slug, enforcement at HTTP and store boundaries, and truncation of **new automatically derived** slugs only. Approve the compatibility gate below: an existing over-bound record stops rollout for an explicit owner decision; it is never silently renamed, unpublished, omitted from a build, or rewritten in a backup.

251 is deliberately chosen instead of the issue's suggested WordPress-style 200: the current grammar is ASCII `[a-z0-9][a-z0-9-]*`, so characters equal UTF-8 bytes. `251 + '.mdx'.length = 255`, fitting the stricter existing export filename as well as route directories. Choosing 200 would unnecessarily disqualify filesystem-safe URLs of 201–251 bytes. This does not widen the grammar or change route policy.

## Evidence and scope

Issue #353 supplies the PostgreSQL/Astro reproduction; it was not rerun. At the review baseline, `uploader/src/posts.ts` checks only slug syntax; `validateDraft` and `validateLocale` call `checkSlug`, while the importer calls `isSafeSlug` before fetching. `draftWithDefaults` is the common normalization boundary of both stores and bypasses the HTTP validator. `editor.html:slugify` has no length bound. `export.ts:exportPost` writes `<slug>.mdx`; DE/EN `[slug].astro` routes produce a directory component from the slug.

No schema/index migration, alternate filename scheme, redirect, live URL change, or expansion of #287's reserved-name work is included.

## Contract

- Define one server-side maximum and include it in `isSafeSlug`/`checkSlug`. Both locale errors identify `de.slug` or `en.slug`, the limit and supplied length; do not echo a multi-kilobyte slug. `validateDraft` rejects excessive input with the existing `PostError` → HTTP 400 mapping, before a database write.
- Apply the same nonempty check in `draftWithDefaults` before either store writes. Import preflight rejects an over-bound group before image fetches using its existing rejected-group outcome. Do not turn import's existing summary API into HTTP 400 per group.
- Keep `''` as the existing draft-only unset sentinel. Publish validation still requires a nonempty bounded slug for both locales, including legacy rows loaded from storage. Single publish refuses with a field-specific 400 before publishing/building; bulk publish reports that pair as failed through its existing per-pair result.
- In editor `slugify`, apply the bound **after** ASCII normalization, then remove any trailing hyphen created by the cut. Preserve the existing empty-result fallback. Do not truncate a typed, pasted, loaded, restored, stashed, or previously published slug; existing auto/manual provenance and rename-confirmation/slug-lock rules remain authoritative. Test browser/server constant parity rather than introducing a new endpoint just for this number.
- `exportPost` validates both locale filenames before creating either file, preserving the unset-locale skip. A legacy invalid filename produces an intentional error rather than a partial pair or `ENAMETOOLONG`; it is not silently shortened. Database backups, not MDX renaming, preserve such legacy records.

## Existing-record compatibility gate

Before activating the change, obtain an owner-authorized **read-only** inventory of both working slugs and published-snapshot slugs (translation key, locale, status, byte count, exact URL). Include imported drafts: draft status does not mean a WordPress URL is disposable. This proposal does not claim that inventory has happened or that the corpus is clean.

- No value above 251: enable the bound; every existing accepted URL remains byte-identical.
- Any value above 251: do not auto-migrate and do not activate the cap on that installation until the owner resolves the compatibility finding. Records and last-known-good release remain intact and readable. Values 252–255 can be routable but cannot use the existing `<slug>.mdx` export contract; values above 255 cannot be directory components on the stated filesystems. A guard alone cannot make those existing records buildable while also preserving their URLs and current storage layout.
- This proposal **does not approve renaming even the draft findings**. If any such real URL must remain, a separately approved route/export-storage design is required before rollout. A content correction/unpublish requires its own explicit owner authorization and backup; neither is implied here. Reject new over-bound submissions in the meantime through the proposed boundary fix where deployment can be isolated safely.

This conditional rollout is intentional, not grandfathering an unsafe value into future publication. It resolves the issue's tension between a universal safe bound and the prohibition on renaming owner URLs without inventing a compatibility shim.

## Trust, verification and recovery

The author/import payload crosses into a database unique index and filesystem components. Bound checks precede those sinks; existing authorization, slug uniqueness, rename confirmation, path guards and publish concurrency tokens stay unchanged. Reconfirm `SECURITY.md` input validation/imported-slug and publish invariants, and document the 251-byte contract and compatibility prerequisite in the existing authoring documentation.

Implementation acceptance (not exercised here): tests at 250/251/252 and multi-kilobyte lengths in each locale; unset versus publish-required; memory/Postgres store parity; direct importer/store bypass; field-specific HTTP 400 with no write/build; bulk failure without publishing that pair; 251-byte MDX filename and actual Astro DE/EN output; export rejection before either locale write; editor long-title derivation and loaded/manual/stashed slug preservation; a disposable existing over-bound row/snapshot inventory with no mutation. Retain existing slug and concurrency tests. Run affected uploader tests/typecheck and site tests/`astro check`/build against disposable PostgreSQL after implementation.

No persistent migration is required. Roll back code only while retaining the last good static release and preventing new unsafe saves/publishes operationally; reverting validation reopens the defect. Never repair by deleting a record or changing a URL. Integrate with approved #273/#283/#287 identity/routing changes rather than reimplementing them; apply this same bound to their story-slug validation chokepoint.
