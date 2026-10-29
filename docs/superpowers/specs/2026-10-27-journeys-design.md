# Journeys: model, cardinality, lifecycle and public route contract (#308)

**Date:** 2026-10-27 · **Owner approval:** 2026-10-28
**Issue:** #308, child of epic #307. It blocks #309 (storage, admin, backups) and #310 (public pages).
**Risk:** HIGH. It adds new public routes (Golden Rule 2 territory), new tables in
`uploader/src/db.ts`, a new `DUMP_VERSION`, and a restore allow-list change.
**Status:** **OWNER APPROVED, 2026-10-28 — implementation qualification tracked in §21.** The owner
approved D1–D10, selecting D3's permanent per-locale first-publication slug lock and D4's required
non-empty plain-text intro (§20). No implementation PR, merge, deployment, publication, existing
story URL rename or owner-data operation is approved by this record. #309 and #310 retain their
implementation approval and verification gates.
**Hard prerequisites:** #283 (language mode contract) and #287 (route reservation contract) were
owner-approved on 2026-10-27, including **Prepare translations before activation**. **[#283]**
and **[#287]** below identify integration dependencies, not pending owner decisions. Read the
approved `2026-10-27-issue-283-language-mode-contract.md` §§5–10 and
`2026-10-27-issue-287-pages-navigation.md` D2/D5.1; their implementation must be integrated before
the dependent journey behavior ships. This contract does not reopen their approved choices.
**Baseline:** `dev` at `11e16d1` (v0.17.1). GPX public artifacts (#314) are merged, `DUMP_VERSION`
is 10, and PR #271 is merged.

---

## 1. What a journey is

A **journey** groups existing stories into a named, ordered trip, for example "Ecuador 2025" with
Quito → Cuyabeno → Galápagos. It has its own title, intro, slug and hero in each locale, and an
ordered list of member stories referenced by `translationKey`. It never copies story content.
Readers get one page per locale that lists the published members in order and shows an overview
map. Each published member story gets a small "part of this journey" strip.

Journeys live in **their own tables and their own Content Layer collection**. They are never
`posts` rows and never `trips` entries. N° numbers (`entryNumberOf`, `site/src/lib/trips.ts:127-133`),
stats (`tripStats`, `:78`), region counts and `liveRegions` (`:92-115`), RSS
(`site/src/pages/rss.xml.js:7`, `site/src/pages/en/rss.xml.js`) and the map pins
(`site/src/lib/map-data.ts:27-29`) all iterate `getCollection('trips')`. A journey stored as a post
would renumber every N°, inflate the stats and region counts, and add itself to RSS and the map.
This rule is fixed by the issue and is not up for decision.

### Invariants (every decision below must keep them)

- **I1. No story URL changes.** Every existing story, region, map, About and feed URL stays
  byte-identical. Joining, leaving or reordering a journey never moves a story (Golden Rule 2).
- **I2. No draft is revealed.** No public output (journey page, journey index, story strip, map
  data, sitemap, alternates, JSON-LD) ever contains a draft story's title, slug, excerpt, body,
  hero or coordinates, or any content from a draft journey or from a journey's unpublished working
  copy.
- **I3. Region pages, N° numbers, stats, RSS, the homepage and the global map are unchanged.**
- **I4. Non-member story pages are unchanged** from a pre-change build, apart from hashed asset
  names. That includes their `StoryPagination` and every other part of the page.
- **I5. Deleting a journey never deletes, unpublishes or edits a story.**
- **I6. Membership never has to be cleaned up by hand.** A deleted story leaves no membership row
  and no snapshot reference behind (§7).
- **I7. No line is drawn that was never travelled** (`site/src/lib/map-chart.ts:29-32`, §9).
- **I8. Everything the public sees comes from published snapshots.** Journeys follow the same
  rule #20 set for posts.

---

## 2. Decision summary (owner)

The owner approved the following contract on 2026-10-28 (§20). §§3–14 specify it in full.
Alternatives remain below only as rejected design history, not active implementation choices.

| # | Decision | Approved contract | Rejected alternatives (historical) |
|---|---|---|---|
| D1 | Cardinality | **A story belongs to at most one journey.** Working membership and published snapshots together count as one claim. | Many journeys per story |
| D2 | Member-story navigation | **A distinct journey strip. `StoryPagination` is unchanged.** | Replace `StoryPagination` on member pages; two prev/next navs side by side |
| D3 | Route shape and slugs | **Localized `rundreisen` / `journeys` bases under the approved language mode**, with an index in each live locale. DE-primary paths are `/rundreisen/<slug>/` and `/en/journeys/<slug>/`. **Permanent per-locale first-publication slug locks (option B).** | DE `/reisen/`; DE `/touren/`; no index page; status-only slug locks (option A) |
| D4 | Locale metadata | **Per-locale title, slug, hero and non-empty plain-text intro for every requested enabled, non-omitted locale; primary required, secondary explicitly omittable [#283].** | Optional intro; shared hero; Markdown intro |
| D5 | Lifecycle | **Own draft/published state and snapshot; a locale with zero published members is not built or linked. Publish requires at least one member and latches the primary-language lock (§7.3), including while dormant.** | Built empty; minimum of 2 members; no journey-publication language latch |
| D6 | Membership and ordering | **Manual order. Authors create, edit and reorder drafts and working copies. Admins publish, unpublish and delete.** Draft stories may be members, and they never render | Date order; authors may also delete |
| D7 | Deletion cleanup | **Inside `pgPostStore.remove()`'s transaction: scrub every working and retained snapshot reference, compact working positions, plus equivalent boot sweep and memory semantics and a loader filter (§14)** | Leave dangling rows and filter them in the loader only |
| D8 | Overview map lines | **Pins in journey order with no connecting line. Each member's own published GPX `track` runs are drawn as separate lines, with no connector between stories.** `map-chart.ts:29-32` is unchanged | Pins only, without GPX tracks |
| D9 | Sitemap, RSS, homepage, nav, comments | **Built journey pages go in the sitemap (no filter). RSS: no. Homepage: no. Site nav: no. Comments: story-only** | Filter journeys out of the sitemap; a nav entry (through #287's nav model); RSS items |
| D10 | Export, preview, revisions | **No MDX export (the DB dump is the backup). No draft preview page. No revision history in v1** | A JSON export to `/data/backup/journeys/`; a preview under the #124 CSP; `journey_revisions` |

D10 was additional to the issue's decision list and is explicitly included in the owner's
approval, rather than left implied.

---

## 3. D1 — Cardinality: at most one journey per story

**Rule.** At any moment a story (`translationKey`) is **claimed** by at most one journey. A
journey claims a story if the story is in that journey's working membership, **or** in the
`members` of that journey's `published_snapshot` while the journey's status is `published`.

**Why the snapshot counts too.** Take a story S in published journey A. Without the snapshot
claim, an author could remove S from A's working copy (an unpublished change), add S to journey B,
and an admin could publish B. S would then be listed on two live journey pages, and the back-link
on S's page would be ambiguous. With the snapshot claim, adding S to B is refused with 409
`story_in_other_journey`. The response names A and says "publish or unpublish A first".

**How it is enforced.**
- The unique index `journey_members_tk_idx` covers working membership (§12).
- The snapshot claim is checked inside the journey save transaction, under the member pair lock
  (§8): `SELECT id FROM journeys WHERE id <> $1 AND status = 'published' AND published_snapshot->'members' ? $2`.
- Restore refuses a dump in which any `translationKey` is claimed twice (§13).
- The site loader also defends against it (§10). If a story is ever found in two live snapshots,
  both journey pages still list it, but the story page renders **no** strip and the build logs a
  warning. It does not fail the build, because a failed build would block every Publish over a
  condition that cannot be constructed.

**Rejected: many journeys per story.** The story page would need one strip per journey or a
disambiguation step, prev/next would become several overlapping sequences, and the admin's "part
of journey" field would become a list. None of the stated outcomes ("Ecuador 2025" holding three
stories) needs it. It can be added later without breaking anything: drop the unique index and
render a list. Going the other way, from many to one, would mean deleting data.

---

## 4. D2 — Member-story navigation: a distinct strip, `StoryPagination` unchanged

Every story page renders chronological prev/next today: `newer`/`older` from `byLocale`
(`site/src/components/pages/StoryPage.astro:31-34`), rendered by `StoryPagination` (`:125`) as
`<nav aria-label="{story.pagination}">`.

**Approved.** A new `JourneyStrip` component renders on **member** story pages only. It sits
after the article and `GalleryIsland`, and before `CommentsIsland`. That puts it at the end of the
reading, above comments, and visually separate from the chronological pager at the foot of the
page. Its content:

- `<nav aria-label="{journey.strip.label}: {journey title}" data-journey-strip>`. The accessible
  name is different from `StoryPagination`'s, so screen-reader landmark lists show two
  distinguishable navs.
- A line reading "Part of the journey" with the journey title, linked to the journey page in the
  same locale.
- "Story {n} of {m}". `n` and `m` count only the stories published in **this** locale, in journey
  order.
- "Previous in journey" and "Next in journey" links to the neighbouring published members in this
  locale. A link is omitted at either end. Draft members and members missing in this locale are
  skipped. Their titles and slugs are never emitted.
- No hero thumbnails, so the strip stays visually lighter than the pager below it. Visual
  treatment follows the Expedition Log language in `DESIGN.md`: a mono label and the dashed route
  rule. All copy lives in `site/src/i18n/ui.ts` for both locales.

`StoryPagination` is **unchanged** on every page, including member pages, so a member's
chronological neighbours stay as they are.

**Output change on member pages.** Exactly one `<nav data-journey-strip>` block is added. Nothing
else on the page changes. A published member can have no strip when the journey has no committed
snapshot content for that locale (for example, the journey's secondary is omitted).

**Test that asserts it, over built HTML** (#310). The fixture database has published journey J
with members A (published), B (draft), C (published) in that order, plus a non-member published
story N. Build, then parse the built HTML:
1. A's page has exactly one `[data-journey-strip]`. It links to J's page, says "1 of 2", has no
   previous link, and its next link goes to C's URL. B appears nowhere.
2. C's strip says "2 of 2", its previous link goes to A, and it has no next link.
3. On A and C, the `nav[aria-label="{story.pagination}"]` subtree is byte-identical to the same
   subtree in a pre-change build of the same fixture. The chronological pager is kept, not
   replaced and not merged.
4. N's page is byte-identical to the pre-change build after hashed asset names are normalized
   (I4).
5. B's title, slug and excerpt are absent from every file in `dist/` (I2).

**Rejected: replace `StoryPagination` on member pages.** Member pages would lose their
chronological neighbours. Pages that were never edited would change output when a journey is
published. The "next" link would mean different things on member and non-member pages.

**Rejected: two prev/next navs side by side.** Two "Next story" links pointing to different
stories in one region is confusing to read and fails WCAG 2.4.4/2.4.6 unless every label is
qualified, and once every label is qualified it is a distinct strip anyway.

---

## 5. D3 — Route shape, slugs and reservation

### 5.1 Route table (DE-primary mode, today's mode)

| Page | DE | EN | Built when |
|---|---|---|---|
| Journey | `/rundreisen/<de-slug>/` | `/en/journeys/<en-slug>/` | The journey is published, its snapshot has content for the locale, and at least one member is published in the locale (§7.2) |
| Journey index | `/rundreisen/` | `/en/journeys/` | At least one journey page is built in that locale |

Path helpers go in `site/src/lib/paths.ts` and follow the existing pattern:
`journeyBases: Record<Locale, string> = { de: 'rundreisen', en: 'journeys' }`,
`journeysIndexPath(locale)` and `journeyPath(slug, locale)`. Existing helpers stay byte-identical,
and `paths.test.ts` pins that.

**[#283] Locale-prefix dependency.** Paths are computed as `localePrefix(locale) + '/' +
journeyBases[locale] + '/' + slug + '/'`, using the approved mode's enabled locales only. The
base and slug belong to their locale and never change with the mode. DE-primary gives the table
above; EN-primary gives `/journeys/<en-slug>/` and `/de/rundreisen/<de-slug>/`. DE-only and EN-only
build only their root-locale routes. After the publication lock, a primary switch is refused
(`language_primary_locked`); secondary activation is additive and retains #283/#287's approved
page preparation/preflight. **There is no redirect migration.** Journey URLs join the published
URL-set invariant. Extend the shared mode-aware route table and uploader URL mirror rather than
reintroducing fixed DE/EN route twins.

### 5.2 Why `/rundreisen/` and not `/reisen/`

The site already uses "Reisen" to mean **stories**: the stats line reads "20 REISEN"
(`ui.ts:257`, `trips.ts:117`), and the map intro reads "Alle Reisen auf einen Blick"
(`ui.ts:199`). A `/reisen/` page listing three journeys next to a header claiming "20 REISEN"
would use one word for two units. "Rundreise" is the common German word for a multi-stop trip
("Rundreise durch Ecuador") and does not imply a return to the start.

**Owner selection, 2026-10-28:** `rundreisen` for DE and `journeys` for EN, under #283's approved
locale-prefix contract. The `/reisen/` candidate and `/touren/` alternative were not selected.

### 5.3 Slug rules

- Format: `isSafeSlug` (`uploader/src/posts.ts:236`), at most 100 characters. `''` means "no slug
  yet" for a draft (the #119 sentinel). Publish refuses `''`.
- Uniqueness: one journey per `(locale, slug)`, enforced by a partial unique index
  (`WHERE slug <> ''`), with 409 `duplicate_slug`. A journey slug is a child of its reserved public
  base, not a root dynamic claim. This is safe only after the disjoint API/public reservations
  and reverse-collision gates in §5.4; reservation alone does not resolve overlapping handlers.
- **Approved D3, option B — permanent first-publication lock:** once
  `journey_locales.published_at IS NOT NULL`, changing that locale's slug returns 409
  `slug_locked`, including after unpublish. Never-published locales remain editable even when
  another locale of the journey has been published. This matches approved #283/#287 and archived
  #308. The schema records this per-locale history (§12); no pair-level `first_published_at`
  column is needed. Deleting/recreating is a separately confirmed destructive action, not a
  rename mechanism.
- Filling a never-published empty slug does not ask. Renaming a never-published non-empty slug
  requires `confirmSlugChange: true`, with both URLs shown (409 `slug_change_unconfirmed` without
  it). Confirmation can **never** bypass the permanent lock. Auto-derivation only fills an
  automatic slug (#122). No story URL change or post-lock language-primary switch is authorized.
- **Rejected historical option A — status-only lock:** unlocking a slug after unpublish could
  permanently lose a previously public URL without a redirect. This would have diverged from
  #283's first-publication rule. The owner chose B; do not implement that divergence.

### 5.4 Reservation **[#287]**

The public bases are first path segments a story or page slug could shadow. Approved #287 D2
owns the pure shared module `site/src/lib/reserved-routes.ts`, its
`RESERVED[namespace]` entries (`segment`, `owner: app|site|locale|legacy`, optional `pageKind`),
`reservation(namespace, slug)` for static reservations, and `namespaceOf(locale, mode)` for
`root`, `de` or `en`. The uploader and site use this same contract:

- **#309 API reservation and gate, before #309 merges:** use the disjoint authenticated prefix
  **`/journey-admin`**, never `/journeys`. Add `{segment: 'journey-admin', owner: 'app'}` to
  `RESERVED.root` with the route registration. The all-features Fastify `onRoute` equality test
  must include it. The PR must record #287 D2.6's read-only collision-query result for
  `(root, journey-admin)` against the actual deployment/content target, covering story/page
  working slugs and published snapshots. The boot report must agree. This gate cannot wait
  until #310: #309's explicit handlers already intercept slashless public requests.
- **#310 public reservations and gate, before #310 merges:** add
  `{segment: 'rundreisen', owner: 'site'}` in `namespaceOf('de', mode)` and
  `{segment: 'journeys', owner: 'site'}` in `namespaceOf('en', mode)` with the route family,
  as applicable to enabled locales. Record the same reverse-collision query and boot report for
  these public `(namespace, segment)` pairs in the target's mode, including the candidate
  secondary namespace before activation. Equality tests cover all four approved modes. In
  DE-primary bilingual mode the pairs are `(root, rundreisen)` and `(en, journeys)`; in
  EN-primary they are `(de, rundreisen)` and `(root, journeys)`.
- **Disjointness is structural:** `/journey-admin[/*]` never shares a first segment with
  `/journeys[/*]` or `/rundreisen[/*]`. Anonymous slashless public paths must reach the blog's
  canonical trailing-slash redirect, never `requireAuth`; both spellings are regression cases.
- **Dynamic claims:** #287's story/page writers reject new conflicting claims under its
  language → sorted content → sorted namespace lock order. Journey child slugs need no namespace
  lock because the public bases are statically reserved; their own uniqueness remains enforced.
- **Build backstop:** #287 D2.7 rejects duplicate output paths and site/page collisions. Its
  grandfathered app/legacy warning is not permission to introduce a new shadow: the relevant
  implementation's pre-merge query must already have resolved that collision.

If a selected segment shadows an existing published story or page, the collision gate blocks
the change. Resolve it by changing the **new** segment and its tests/reservations, with an owner
amendment to this approved route contract; do not silently substitute a public prefix or claim
authorization to displace the existing URL. Any replacement API prefix must remain disjoint.
Never rename existing live story slugs to make room. Existing claims are grandfathered by #287's
stored-row rule, not by an invented migration or redirect. Collision-query results remain
implementation prerequisites; this approval supplies no such evidence.

**Rejected: a root-level `/<journey-slug>/`.** It would share the DE story namespace, need
two-way collision checks on every save of either kind, and let a journey squat on a story's future
URL.

**Rejected: no index page.** `/rundreisen/` would 404 for a reader who trims the URL. The approved
index follows the region-index pattern and is built only when that locale has a live journey.

---

## 6. D4 — Locale metadata

Each journey stores, **per locale**:

| Field | Rule |
|---|---|
| `slug` | §5.3 |
| `title` | Plain text, 1–200 characters when publishing. Control characters (`\p{C}`) stripped, as `media-store.ts` `cleanText` does (#133) |
| `intro` | **Plain text**, up to 2000 characters, with `intro.trim().length > 0` required at Publish for each requested enabled, non-omitted locale. Blank lines separate paragraphs, rendered as escaped `<p>` elements, never `set:html` |
| `heroImage` | Same shape as a story hero: `src`, `width`, `height`, `alt`, optional `format`/`focus`. Required to publish |

Shared, not per locale: `members` (ordered `translationKey`s) and status.

- **Hero type is the three-place trap** (CLAUDE.md *@ai-warning*). The journey hero must reuse
  `HeroImage` (`uploader/src/posts.ts`), `RemoteHeroImage` (`site/src/lib/images.ts`) and the
  site's `storyImage` Zod schema (`site/src/content.config.ts`). It must not declare a fourth copy.
  #309/#310 extend the existing compile-time pin and the `focus` round-trip test to cover it.
- **Hero source contract:** a non-empty journey hero `src` is the canonical **unsuffixed base
  URL**, not a concrete variant URL. At save and again at Publish, parse an absolute HTTP(S) URL
  without credentials, query or fragment; require origin equality with the configured image
  base (`new URL(src).origin === new URL(imageBase).origin`) before key lookup. Require an
  existing safe-key-valid base under that image base: after `srcToKey(src, imageBase)` produces
  `key`, require `src === imageBase + '/' + key`. Thus a pasted `photos/a-640.webp` is rejected
  with `invalid_journey`, **not silently accepted or normalized**, even if it resolves to ready
  key `photos/a`. The media picker supplies `photos/a`'s base URL. Empty/absent heroes remain
  permitted in working drafts. Persist and snapshot only the canonical base form.
- **Journey-specific hero publish gate:** for every requested locale, require the canonical
  base above, an existing media row for its key and `status === 'ready'`. Missing rows are
  refused, not treated as legacy-ready; processing/missing/error rows are refused too.
  Validate positive finite dimensions and the existing hero alt/format/focus contract.
  Return bounded locale-scoped `invalid_journey` details for malformed/foreign/noncanonical/
  key-invalid heroes and `journey_hero_not_ready` for unknown or non-ready media, without raw
  errors or EXIF. Do not simply reuse `publicationImages`/`notReadyPhotos`: the baseline omits
  foreign heroes from readiness checks and permits missing legacy rows. No remote fetch is added.
  `retargetImageOrigins` remains a deployment-origin adaptation only: it neither validates a
  hero nor strips a variant suffix. `RemoteImage`/`srcset`/`fallbackSrc` append size and format to
  the stored base exactly once; the snapshot schema and `readDump` must reject suffixed sources.
- **Media usage:** journey heroes (working and published snapshot) are added to the media-usage
  corpus that `imageUsage` scans (`uploader/src/media-files.ts:75`, `server.ts:589`,
  `main.ts:108`). That way, deleting a photo used as a live journey hero is refused, which is the
  #115 rule.

**Locale coverage [#283], approved for journeys under D4.** Both `journey_locales` rows always
exist. Each has required boolean `omitted` and nullable `published_at` (§12). Omission is an
explicit author request, never inferred from empty fields or absence from a payload:
- Create primary with `omitted=false`; create a bilingual secondary with `omitted=false`
  (translation expected), or a disabled secondary with `omitted=true`. Preserve retained text.
  The primary cannot be omitted. Only a never-published secondary may become omitted; otherwise
  return 409 `locale_published`. The DB CHECK `NOT omitted OR published_at IS NULL`, the store's
  snapshot-membership validation and `readDump` jointly enforce this pair/snapshot model; do not
  copy the posts CHECK verbatim, since journey locale rows have no per-row status/snapshot.
- Define `requestedLocales = enabledLocales.filter(L => !working[L].omitted)`. Publish requires
  primary membership and validates **every** requested locale. An incomplete non-omitted
  secondary refuses publication; it is neither silently omitted nor allowed to break the build.
  Save changes working coverage only. It never inserts/removes a published snapshot locale.
  `hasUnpublishedChanges` includes requested-versus-committed coverage differences.
- A successful Publish snapshots **exactly** that requested set and stamps each newly published
  locale's `published_at` without clearing history. Unpublish retains snapshots/history.
  A never-published secondary un-omitted and saved after the journey was published remains
  absent from the retained snapshot until the next successful Publish.
- Mode writes join §8's language-first transaction protocol. Enabling a secondary leaves journey
  omission flags/content and snapshots unchanged (no automatic publication); an author explicitly
  un-omits, completes and publishes it. Pre-lock disabling marks never-published secondary rows
  omitted while retaining text; a pre-lock primary switch makes the new primary non-omitted and
  leaves incomplete drafts for explicit completion. Never mutate snapshots on a mode change.
  Approved #287's page preparation/activation preflight remains mandatory and unchanged.
- A journey page in L requires enabled L, committed journey snapshot content in L and at least
  one member's published `trips` entry in L. Missing/draft/omitted story locales are skipped;
  “n of m” and prev/next count only those visible entries and may differ between DE and EN.
- Journey `hreflang` alternates exist only for built locale pages. Single-language installs
  emit only that locale's routes. Working `omitted` changes never hide existing public output.

**D4 owner selection, 2026-10-28:** `intro.trim().length > 0` is required at Publish for every
requested enabled, non-omitted locale, within the 2000-character cap. Empty or whitespace-only
intro remains permitted in a working draft, never in a committed published locale snapshot.
The optional-intro alternative was not selected.

**Rejected: a shared hero.** Story heroes are per locale (alt text is language-specific), and a
journey should not invent a second convention. **Rejected: a Markdown intro.** It would be the
first `set:html` on this surface and would need the full sanitize-and-render path for no stated
need. It can be added later through `renderMarkdown`.

---

## 7. D5 — Lifecycle

### 7.1 States

A journey has its own `status` (`draft` | `published`), a working copy (`journey_locales` and
`journey_members`) and a `published_snapshot`. This is the #20 pattern.

| Action | Who | Effect | Rebuild |
|---|---|---|---|
| Create | author or admin | `draft`, empty snapshot | no |
| Save working copy | author or admin | Writes the working copy. A published journey shows "unpublished changes", and its live page is unchanged | no |
| Publish | **admin** | Validates (§7.3), copies the working copy into `published_snapshot`, sets `status='published'` and `published_at` | yes, synchronous like posts |
| Unpublish | **admin** | Sets `status='draft'` and keeps the snapshot (same as posts) | yes |
| Delete | **admin** | Deletes the journey and its locale and member rows (cascade). Stories are untouched (I5) | yes, if it was published |

The confirmation for each destructive action states its scope (CLAUDE.md *Accessibility*): for
example, "Delete journey 'Ecuador 2025'. Its 3 stories stay published at their URLs."

### 7.2 Zero published members

**Approved: not built, never linked.** A published journey whose snapshot has no member
published in locale L produces **no** page in L. It is absent from the index, the sitemap and
`hreflang`, and no strip links to it (there is no member page to carry one). It appears once a
member is published. That is the same rule `liveRegions` applies to region pages
(`trips.ts:92-115`). The admin list shows "Published, not live in DE/EN: no published stories".

This means **publishing a story can make an already-published journey appear**. That is
deliberate: the admin published the journey, and the story's own publish is the gate.

- Publish refuses a journey with **zero members in total** (`journey_empty`), because it could
  never go live.
- **Rejected: built empty.** It would publish a thin page with a map and no stories,
  which is the outcome `liveRegions` exists to prevent.
- **Rejected: a minimum of 2 members.** The approved minimum at Publish is one member; a
  one-story journey is thin but honest. Later deletions may leave a published journey dormant.

### 7.3 Publish validation

Under §8's locks, re-read the mode, working coverage, members and exact `baseUpdatedAt` token.
Require the primary in `requestedLocales` and complete title, safe non-empty slug and valid hero
for **each** enabled, non-omitted requested locale (§6), including a non-omitted secondary.
Require `intro.trim().length > 0` within the 2000-character cap for that same requested set.
Apply §6's explicit origin/key/**known-ready** media gate to the same locale set. Require at least
one member, all member keys present in `posts`, and no conflicting D1 claim. Draft members remain
allowed and cannot render. A stale token is 409 `conflict`, as with `assertPublishTokens`.
Commit snapshot/status/history atomically. Approved D5 extends the language publication latch:
journey Publish also sets `site_language.locked_at = COALESCE(locked_at, now())`, even if dormant,
so retained journey coverage cannot later be invalidated by a primary switch or disable.
This journey-specific extension was approved under #308; #283's existing contract is unchanged.
The latch survives unpublish and deletion. Include retained journey locale publication history
in boot/recovery lock derivation alongside story history; a missing/null latch never unlocks an
install with such history. Version-N dump validation requires a locked language row when any
journey locale has publication history, and restore preserves the dump's matching lock/content.
Commit and release DB locks before the one ordinary rebuild; never acquire the build/encode lock
inside the transaction or wrap the builder in a second non-reentrant work lock. A failed build
keeps the old release and reports persisted publication/build failure distinctly.

---

## 8. D6 — Membership, ordering and concurrency

- **Order is manual.** `position` is an integer, and the save writes the full ordered list. Travel
  order often differs from story dates, because a story's `date` is when it was written up or one
  day of a multi-day trip. **Rejected: date order.** It needs no reorder UI, but the
  journey could not tell the trip in the order it happened.
- **Who edits:** authors and admins can create, save and reorder (`requireAuth`). Publish,
  unpublish and delete are `requireAdmin`. That mirrors posts and #309's acceptance criteria.
- **Members:** only existing `translationKey`s, unique within the request, at most 50, all subject
  to the D1 claim. Unknown keys get 400 `unknown_member` and duplicates get 400
  `duplicate_member`. Draft stories are allowed, so an author can plan a journey before every
  story is published.
- **Reordering is keyboard-operable** (move up/down buttons with a polite live-region
  announcement), not drag-only. Delete uses `admin-confirm.js`, and DraftGuard protects unsaved
  edits.
- **Optimistic concurrency:** `GET` returns `updatedAt`. Save and publish echo it as
  `baseUpdatedAt`, and the comparison happens in JS (`assertNotStale` and `assertPublishTokens`
  semantics). A stale tab gets 409 `conflict` and its edits stay in the form. `updated_at` is
  advanced in milliseconds with the `touchPostPair` technique (`post-pair-lock.ts`), so two writes
  in the same millisecond cannot share a token.

### Locking (no deadlock by construction)

Combined order: **singleton language row `FOR UPDATE` → sorted post-pair locks →
sorted journey locks → any later namespace/route-version locks required by existing contracts**.
Never acquire the language row after a content lock. Journey locks use
`pg_advisory_xact_lock(hashtextextended('journey:' || id, 0))`. UUIDs and translation keys are
sorted deterministically. #283/#287's existing content/namespace/route protocols remain intact.

| Operation | Locks, in order |
|---|---|
| Journey create / save / publish | Language → pair locks for requested ∪ current working ∪ all retained snapshot members → journey lock |
| Journey unpublish / delete | Language → journey lock (no pair locks needed; neither adds references nor reads story content) |
| `pgPostStore.remove(tk)`, single or bulk | Language → sorted affected pair locks → sorted locks of **every** journey with a working row or retained snapshot reference to a removed key, regardless of journey status |
| Post save / publish / unpublish | Approved language-first → sorted pair/content locks → existing later locks; no added journey lock unless removing references |
| `PUT /language` affecting journey coverage | Language → sorted affected pair locks if any → sorted journey locks; update/revalidate coverage per §6 alongside the approved page preflight |
| Boot orphan repair | Before admitting writers under storage ownership: language → sorted missing-key pair locks → sorted affected journey locks; same repair as §14 |

Every journey reference/coverage writer takes the language row first, including cleanup. Thus a
save can discover its current member union while holding that row, acquire pair locks, then
re-read the membership/token under the journey lock without racing another journey writer.
Story deletion discovers **all** references under the same protocol, not only D1's current
claimant: an unpublished A can retain S after B acquires the current claim. Scrub both.
No path adds a new pair lock after taking a journey lock.

A save/delete race therefore has two serial outcomes: delete first → `unknown_member`; save
first → delete removes references, compacts positions and advances every changed journey's token,
so a stale later save gets 409. Mode/publication races similarly validate and commit against one
mode or refuse, never validate under one mode and commit under another. Memory stores model the
same serial outcomes. No DB transaction waits on the build lock; the builder runs after commit.

---

## 9. D8 — Overview map, discontinuity and text alternative

`site/src/lib/map-chart.ts:29-32`: "No line joining the pins. Each pin is a separate trip, not a
leg of one journey — a polyline through them would draw a route that was never travelled." A
journey's member order is an **asserted** order, not travelled geometry. Joining the pins would
claim the author travelled in a straight line from Quito to the Galápagos.

**Approved rendering** (self-hosted PMTiles basemap only, progressive enhancement):
- One pin per **published member in this locale**, at the story's `coordinates`, with a visible
  number label (1…m) that matches the story list order. The number is a list index, not a route.
- **No line joins pins, and no line joins different stories.** Where a member's published snapshot
  carries the approved GPX public artifact (`track`, `site/src/lib/public-track.ts`, #311/#314),
  its runs are drawn as **separate** line features under the pins, exactly as each story's own map
  draws them (`travel-map.ts:128-141`). The gaps between runs and between stories stay gaps.
  Nothing is added, interpolated or simplified across them. Bounds extend over every pin and run
  (antimeridian framing from #336).
- Stops are not drawn on the overview. Each story's mini-map already has them, and on a
  multi-story map they crowd the pins. Including stops was not selected.
- `map-chart.ts:29-32` is **not amended**. The journey map code carries its own `@ai-warning` that
  restates the rule and points to this section. The only lines on any map remain GPX public
  artifacts.

**Text alternative (works without JS, tiles or WebGL; WCAG 1.1.1):**
- The ordered story list on the journey page *is* the primary content. Each item has the number,
  linked title, country and date, and reuses the existing card component. The map adds nothing
  the list lacks.
- Under the map, a localized note: "The map shows each story's location. Lines are only recorded
  GPS routes. Distances between stories are not drawn." This states the discontinuity in words.
- For each member with a `track`, the map's text fallback lists that story's public run summary
  through the existing `publicTrackSummary` (`public-track.ts`: run length and start/end at public
  precision, **no cross-gap distance**). No journey-wide total distance is computed, because it
  would sum gaps.
- The map container gets an accessible name ("Map of the journey {title}"), and its interactive
  pins are keyboard reachable as on `/karte/`. Checked at 320/390px with keyboard and a screen
  reader (#310).

**Rejected: pins only, without tracks.** It discards the member's approved public geometry.
**Rejected and out of scope: a line joining the pins.** The owner did not authorize amending
`map-chart.ts:29-32` or drawing connections without travelled geometry.

---

## 10. Public read path and leakage guarantees (#310)

- New collection `journeys`, loaded by `postgresJourneysLoader` through the approved shared
  `loader-pool.ts` exported-snapshot helper (#283 §10.2 / #273 §6.1), retaining #110 timeouts.
  `build.ts` exports one `REPEATABLE READ READ ONLY` PostgreSQL snapshot and holds its transaction
  until the child exits. The journey loader imports `SITE_DATABASE_SNAPSHOT` on its checked-out
  connection **before the first query**, exactly like trips, pages, language, identity and
  navigation. Validate the internal builder-generated identifier per the shared helper; all reads
  remain on that checked-out connection, never a later `pool.query`. Invalid/expired snapshot
  fails closed; no fresh-read fallback. Only genuinely absent input in standalone development
  retains the helper's existing development behavior; empty supplied input is invalid. Release
  the connection on success/error/timeout. This is the same build epoch, not merely the same pool.
- It runs **one journey-content query**:
  `SELECT id, published_snapshot FROM journeys WHERE status = 'published' AND published_snapshot IS NOT NULL`.
  Transaction/snapshot setup is not another content query. It never reads working
  `journey_locales`, `journey_members`, `posts` or `post_routes`.
- Entries: `de/<slug>` and `en/<slug>` only for enabled locales present in the committed snapshot,
  with `{ journeyId, title, intro, heroImage, members: string[] }` validated by a strict Zod schema
  (unknown keys rejected). Working omission flags are not a public read input.
- **Members are resolved at page render against `getCollection('trips')`**, by `translationKey`
  and locale. That collection already contains only published story snapshots
  (`postgres-loader.ts:107-110`). A draft, unpublished, deleted or locale-missing member is
  **absent from the set being searched**, so nothing about it can be emitted. A leak would require
  bypassing `trips`, and the loader-isolation test pins that it does not.
  Their optional GPX geometry is only the validated `publicTrackSchema` artifact in those same
  published entries. Never consult working `post_routes`, private archives or another build epoch.
- The journey page, the index, the strip and the sitemap all derive "live in locale L" from one
  helper, `liveJourneys(journeys, trips, locale)`, which follows the same single-rule pattern as
  `liveRegions`. Something that is linked is therefore always something that is built.
- **Approved D9:** built journey pages enter the sitemap through `@astrojs/sitemap`'s default
  (`astro.config.mjs:35`, no filter). Unbuilt journeys cannot appear. RSS stays stories-only, and
  the homepage and `Nav.astro` are unchanged. A nav entry was not selected: it would change every
  page and break I4's parity check. Any future navigation proposal needs its own scope approval
  through #287's nav model. Journey pages have no comments; `CommentsIsland` stays story-only.
  JSON-LD remains optional under the approved scope and, if added, uses only snapshot data.
- Unpublishing or deleting a journey removes its pages on the next build, with no redirect (as for
  stories). Strips disappear from member pages at the same time.

---

## 11. Admin and API contract (#309)

### 11.1 Admin
A new `uploader/public/journeys.html` (list) and journey editor reuse the admin shell, posts-list
patterns, DraftGuard and `admin-confirm.js`. The story editor's Story details show "Part of
journey: {title}" read-only, or nothing. Member pickers show each story's status with text as well
as colour.

### 11.2 Routes (all bodies validated at the boundary, JSON body ≤ 64 KiB)

| Route | Guard | Notes |
|---|---|---|
| `GET /journey-admin` | `requireAuth` | Summaries: id, titles, slugs, status, `hasUnpublishedChanges`, member count, live-per-locale |
| `GET /journey-admin?member=<tk>` | `requireAuth` | The current claiming journey for the story editor, or `null` (not every retained reference) |
| `GET /journey-admin/:id` | `requireAuth` | Working copy, `updatedAt`, both locale rows with `omitted`/publication history, members with title and status |
| `POST /journey-admin` | `requireAuth` | Create a draft; `{ de, en, members }`, each locale includes explicit boolean `omitted` |
| `PUT /journey-admin/:id` | `requireAuth` | `{ baseUpdatedAt, de, en, members, confirmSlugChange? }`; full locale working objects include `omitted` |
| `POST /journey-admin/:id/publish` | `requireAdmin` | `{ baseUpdatedAt }` → rebuild, which reports `build` like posts |
| `POST /journey-admin/:id/unpublish` | `requireAdmin` | → rebuild |
| `DELETE /journey-admin/:id` | `requireAdmin` | → rebuild if it was published |

Errors use stable codes (`conflict`, `duplicate_slug`, `slug_locked`, `slug_change_unconfirmed`,
`unknown_member`, `duplicate_member`, `story_in_other_journey`, `journey_empty`, `invalid_journey`,
`locale_published`, `journey_hero_not_ready`), never raw database messages. `:id` must be a UUID,
otherwise 404. No response carries GPS or uploader identity. The editor retains both locale
objects when only enabled fields are shown; hidden retained content is never replaced by blanks.
Publication history is response-only: clients cannot set or clear it.
Register mutations through the existing server ownership-fencing/tracked-write hooks, with no
opt-out. Owner loss/read-only admission refuses them before mutation; auth remains independent.

---

## 12. Schema (additive and idempotent, in `ensureSchema`)

```sql
CREATE TABLE IF NOT EXISTS journeys (
  id                 uuid PRIMARY KEY,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_snapshot jsonb,
  published_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journeys_published_has_snapshot CHECK (status = 'draft' OR published_snapshot IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS journey_locales (
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  locale     text NOT NULL CHECK (locale IN ('de','en')),
  slug       text NOT NULL DEFAULT '' CHECK (char_length(slug) <= 100),
  title      text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  intro      text NOT NULL DEFAULT '' CHECK (char_length(intro) <= 2000),
  hero_image jsonb,
  omitted    boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  CONSTRAINT journey_locales_omitted_unpublished CHECK (NOT omitted OR published_at IS NULL),
  PRIMARY KEY (journey_id, locale)
);
CREATE UNIQUE INDEX IF NOT EXISTS journey_locales_slug_idx ON journey_locales (locale, slug) WHERE slug <> '';
CREATE TABLE IF NOT EXISTS journey_members (
  journey_id      uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  translation_key text NOT NULL,
  position        integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (journey_id, translation_key),
  UNIQUE (journey_id, position)
);
-- D1: a story is in at most one journey's working membership.
CREATE UNIQUE INDEX IF NOT EXISTS journey_members_tk_idx ON journey_members (translation_key);
-- D7 boot repair uses §14's transaction, not a standalone DELETE:
-- remove all missing-pair references from working lists and every retained snapshot;
-- rewrite affected working lists with positions 0..n-1 and advance changed journey tokens.
```

- Foreign keys exist **within** the journey tables, because `journeys.id` is a single-column key.
  **There is no FK to `posts`**, because `posts` has no single-column pair key (`db.ts:88-89`,
  issue text). D7 covers that instead.
- `posts` gets **no new column**.
- CHECK constraints are write-once on deployed databases (the `db.ts` media/comments
  `@ai-warning`); later changes use a named constraint swap, not an edit of this `CREATE TABLE`.
  Both locale rows, the primary/non-omitted invariant, and snapshot/history consistency are
  enforced at the locked store boundary and by `readDump`; a same-row CHECK cannot inspect the
  parent JSON snapshot or `site_language`. An omitted locale must have no snapshot key.
- Save writes the member list as `DELETE` + ordered `INSERT` inside the locked transaction, so
  `UNIQUE (journey_id, position)` never needs deferral.

### 12.1 Published snapshot shape (`journeys.published_snapshot`, version 1)

```json
{
  "version": 1,
  "members": ["<translationKey>", "..."],
  "locales": {
    "de": { "slug": "ecuador-2025", "title": "…", "intro": "…", "heroImage": { "src": "…", "width": 0, "height": 0, "alt": "…" } },
    "en": { "slug": "ecuador-2025", "title": "…", "intro": "…", "heroImage": { "src": "…", "width": 0, "height": 0, "alt": "…" } }
  }
}
```

The `members` order is the journey order. The array is unique, has at most 50 entries, and holds
`translationKey`s only (no story content, I8). A locale key exists exactly when that locale was
included in the last successful Publish, not whenever its working `omitted` flag is false.
Disabled/omitted locales have no key; a newly un-omitted, saved-but-unpublished secondary can also
have no key. Any snapshot includes the primary and only enabled locales; locale history and
snapshot keys agree even after unpublish. Empty members after deletion are valid dormant
snapshots, although Publish refuses a new empty list. Working content may differ from snapshots.
The uploader, site and `readDump` share strict versioned validation without accepting unknown
keys. Hero dimensions in the schematic JSON above stand for positive actual dimensions, not
literal zero-valued valid fixtures. Build the snapshot in JS from the locked working rows.

---

## 13. Backup: dump version, allow-list, restore and pre-restore dump

- **`DUMP_VERSION` becomes N = (the version on `dev` when #309 lands) + 1.** Allocate it after
  the integrated language/page/identity changes, not from the historical v10 baseline.
  Add N to `SUPPORTED_DUMP_VERSIONS` and its version history; preserve every supported older
  version's own validation, including the approved language and GPX projection rules.
- `dumpDatabase` captures the three tables inside the existing `REPEATABLE READ` snapshot
  (`backup.ts:153`), with explicit column lists:
  - `journeys`: `id, status, published_snapshot, published_at, created_at, updated_at`
  - `journey_locales`: `journey_id, locale, slug, title, intro, hero_image, omitted, published_at`
  - `journey_members`: `journey_id, translation_key, position`
  These become `tables.journeys`, `tables.journey_locales` and `tables.journey_members` in the
  `Dump` interface.
- **`readDump` validation**, following the post_routes precedent of `backup.ts:759-765`:
  - For `version >= N`, all three arrays are required. For `version < N`, any of the three keys
    present means refusal (`'Journeys require a version N recovery set.'`).
  - Rows are validated structurally: UUIDs; status and locale in their allow-lists; `isSafeSlug`
    or `''`; length caps; exactly both locale rows per journey; unique non-empty `(locale, slug)`;
    locale/member rows reference a journey in the dump; contiguous unique positions starting at
    zero; snapshot validated against the v1 schema; `published` implies a snapshot.
  - Using the **dump's** language mode, validate §6's omission/history rules, primary presence,
    permitted snapshot-bearing locale keys and complete committed locale metadata, including
    non-empty plain-text intro. Do not require a newly requested secondary to already have a
    snapshot or require an edited working copy to equal its retained published snapshot.
  - **Every member and snapshot `translationKey` must exist in `tables.posts`, and no key may be
    claimed twice (D1).** Otherwise the dump is refused with a fixed message that does not echo
    content. This fails closed, consistent with v10 route validation. A dump written by this code
    cannot violate it, because remove() scrubs inside its transaction and the dump is a single
    snapshot.
- **Restore requires a journey-aware recovery reader for every dump version whenever the target
  schema contains journey tables**, including during application rollback and for pre-N dumps.
  The recovery image must also retain §16's security floors and #398's admission controls;
  accepting an old dump version alone does not make a pre-journey reader safe for this schema.
  In one `restoreDatabaseContents` transaction, `DELETE FROM journeys` (cascading to locales
  and members) precedes `DELETE FROM posts`. Restore posts, then journeys/locales/members, plus
  the dump's matching normalized `site_language` and publication-lock state atomically.
  **A pre-N dump restores an empty journey set and its version-correct language state together**;
  it never leaves the destination's former journey rows beside the restored mode. The verified
  pre-restore recovery set includes journeys and language state and is the undo. Transaction
  failure leaves the original content, journeys and language state intact.
  `RestoreCounts` gains `journeys`. The CLI `RESTORE_TABLES` (`cli.ts:55`), its per-table summary
  and its "restored …" line gain the three tables.
  This remains **offline recovery** under approved #398: stop all app/maintenance writers,
  retain Postgres, acquire exclusive storage/database ownership, validate source dump plus
  manifest-paired private archives and verify the undo set before destructive SQL. Confirmation,
  cross-mode restore consent and version checks remain mandatory. No live restore route, no
  ordinary live `compose exec … restore`, no fencing bypass. Preserve staged/input/undo material
  on ambiguous failure; restart/rebuild only after confirmed success. These are requirements,
  not authorization to perform any restore.
- Revisions stay excluded, and journeys have none in v1.
- **MDX export (approved D10): none.** `Export all` stays stories-only. The site never reads
  exported MDX, and the DB dump is the authoritative backup. The alternative JSON export under
  `/data/backup/journeys/` was not selected; neither draft preview nor revisions are in scope.

---

## 14. D7 — Story unpublish and delete

| Story event | Effect on journeys |
|---|---|
| A member is **unpublished** | No journey change. On the next rebuild (unpublish already rebuilds) it drops out of the journey page, its neighbours' strips skip it, and if it was the last member live in L the journey page in L disappears (§7.2). Republishing restores it **in place** |
| A member is **deleted** (`pgPostStore.remove`, single or bulk) | In the same transaction, follow §8 and discover every journey whose working list **or any retained snapshot** names a removed key, regardless of status/current D1 claim. Lock all in sorted ID order. For each, filter deleted keys from its ordered working list, replace that list using DELETE + ordered INSERT with positions `0..n-1`, and remove the keys from `published_snapshot.members` preserving the other order/version/content. Advance `updated_at` for every changed journey, then delete the story/revisions under the existing protocol. Rollback restores all changes together. Deleting a published story already rebuilds |
| Boot | Before admitting writers, perform the same transactional repair for missing story pairs: all working and retained snapshot references, sorted locks, stable-order compaction and token advances. This handles dangling references, including older-code removals; a consistent DB is a no-op. It is **not** recovery from an older-code restore or a language/snapshot mismatch (§13/§16) |
| Build | Resolution through published `trips` (§10) makes any leftover reference non-public; it does not replace transactional integrity |

The memory twin performs the same all-reference repair, stable-order compaction and token changes
atomically; it must not model only the current claimant. An unpublished A can retain S in its
snapshot while B owns S's current claim: deleting S scrubs both A and B, including snapshot-only
references. Working positions `0,1,2` become `0,1`, never `0,2`. Immediately dumping after any
single/bulk deletion or boot repair must pass `readDump` and restore without relying on another
boot. Snapshot scrubbing only removes deleted references, never adds working content; this is
the sole exception to Publish-only snapshot replacement.

A cross-mode inconsistency cannot be repaired by deleting orphan memberships: every member key
may still exist. Do not invent a destructive boot migration, clear journeys or rewrite snapshot
locales to force compatibility. Such an inconsistent target requires operator-led recovery with
a coherent verified recovery set and the journey-aware reader under §13, not silent boot repair.

**Rejected: tolerating dangling rows and filtering in the loader only.** The output would be
correct, but the admin would show "unknown story" rows forever, D1's claim check would compare
against keys that no longer exist, and restore validation would have to accept dangling keys.
#137 and the comments cleanup set the precedent of cleaning up in the transaction plus a boot
sweep.

---

## 15. Trust boundaries and misuse cases

| Misuse / failure | Defence |
|---|---|
| **A journey listing a draft** reveals its title or slug | Members resolve against `trips` (published snapshots only). Built-HTML test (§4 item 5, #310) |
| **The journey's working copy leaks** through an unrelated rebuild | The loader reads `journeys.published_snapshot` only and never touches the working tables. Loader-isolation test |
| **Slug squatting**: an author claims a slug to block a future story URL | Journey slugs live under their own base and cannot shadow a story. Publishing is admin-only |
| **Base or API segment shadows a story** (`/rundreisen/`, `/journeys/`, `/journey-admin`) | Disjoint prefixes, #287 reservation, API reverse gate **before #309**, public reverse gate **before #310** (§5.4) |
| An author publishes, or deletes as a destructive shortcut | `requireAdmin` on publish, unpublish and delete. Route authz matrix test |
| Two tabs or two authors save | 409 `conflict`, edits kept |
| A story is moved into a second journey to make it live twice | D1 claim over working membership and the published snapshot, unique index, restore check |
| Race between a story delete and a journey save | Lock order (§8) |
| **XSS** through the title or intro | Plain text, escaped by Astro, no `set:html` |
| A hero pointing at a foreign, unknown or unready image | Explicit origin equality, canonical unsuffixed base URL, safe key and an existing ready media row for every requested locale (§6); no legacy missing-row bypass |
| A media delete removes a live journey hero | Journey heroes are added to the usage corpus |
| An oversized payload or member list | Length caps, ≤ 50 members, 64 KiB body, DB CHECKs |
| A hand-edited or hostile dump | Strict `readDump` validation. The status allow-list never mints `published` without a snapshot |
| An implied route that was never travelled | D8: no connecting lines, text states the discontinuity |
| GPS exposure | Only published story `coordinates` and the already-public `track` artifact. Nothing comes from media EXIF |

There is no new unauthenticated surface. Public journey pages are static output.

---

## 16. Compatibility, rollout and rollback

- **Rollout order:** integrate approved #283/#287 contracts → implement this owner-approved
  #308 contract → owner-approved #309 (tables/store/admin/dump, API-prefix reservation and
  collision evidence) → owner-approved #310 (shared-snapshot loader, public routes/strip/map
  and public-prefix collision evidence). #309 alone creates no public output. Specification
  approval does not establish implementation readiness or waive any acceptance evidence.
- **Rollback of #310:** journey-only code revert and rebuild on a compliant image. Pages/strips
  disappear; story URLs stay unchanged. Removed journey URLs were new; their loss affects their
  own SEO. The previous release stays live on a failed build.
- **Rollback of #309:** journey-only revert or fix-forward; tables stay inert (no `DROP`).
  This is **not** authorization to deploy baseline v0.17.1 or undo security fixes. Every recovery
  image retains #347's patched codecs (sharp ≥0.35.5, heif ≥1.23.2, rsvg ≥2.63.2) and applicable
  #369 dependency/proxy/static-serving controls, plus storage ownership/fencing and restore
  admission. If no compliant revert is available, use fix-forward/containment.
  1. Pre-journey code rejects version-N dumps, but its ability to read a pre-N dump does **not**
     authorize its use against a target with journey tables. **Every restore into that schema
     uses a journey-aware, security-compliant recovery image**, even when the running application
     was rolled back or the recovery set predates journeys. Keep the allow-list intact and use
     #398's stopped-app exclusive-owner procedure. §13 clears journeys and restores matching
     version-correct language state atomically for pre-N input. Release notes state both the
     dump-version and target-schema compatibility boundaries.
  2. Older-code story removal can leave dangling references; re-upgrade boot repair scrubs all
     working/retained references, compacts positions and advances changed tokens. It does **not**
     reconcile an older-code restore's language/snapshot mismatch: unchanged member keys can
     leave that mismatch wholly invisible to orphan detection. An unsupported restore is an
     operator-led recovery incident, not permission to discard or rewrite journey data at boot.
- **Containment:** unpublishing a journey (admin) removes its public output on the next build
  without code changes.

---

## 17. Regression tests the implementation must add

**#309 (uploader)**
- Store contract suite run against both the memory store and pg: create, save, reorder, publish,
  unpublish, delete; `updatedAt` token conflicts; slug lock and confirmation; D1 working and
  snapshot claim (409); unknown/duplicate members; empty-journey publish refusal.
- Barrier-controlled pg races: story delete versus journey save; journey publication/coverage
  save versus mode change/secondary activation; concurrent claimant transfer. Assert §8's
  language → sorted pairs → sorted journeys order, exact-token revalidation and serial outcomes.
- Delete an interior member, then dump → read → restore immediately: stable contiguous positions.
  Cover single/bulk delete, snapshot-only references and unpublished A retaining S while B
  claims S. Scrub **all** journeys in the same transaction; forced rollback leaves them intact.
  Boot sweep and memory twin reproduce all-reference cleanup, compaction and token semantics.
- Coverage: all four modes; primary omission refusal; incomplete non-omitted secondary refusal;
  explicit omission; un-omit + Save leaves old snapshot/public projection intact; Publish adds
  only validated requested locales; locale history freezes omission, including after unpublish.
  Assert permanent per-locale slug locks survive unpublish and reject confirmation bypass;
  never-published locale slugs remain editable. Empty/whitespace-only intro refuses Publish for
  every requested locale while draft Save permits it; omitted/disabled locales are not gated.
- Hero gates: foreign origin (including prefix-lookalike), invalid URL/key, query/fragment,
  concrete variant suffix and missing media row refused; processing/missing/error rows refused;
  a canonical local unsuffixed base for an existing ready key succeeds. Assert save and Publish
  reject `photos/a-640.webp` rather than persisting it, even when `photos/a` is ready. Preserve
  dimensions/focus round-trip. No “missing legacy row is ready” shortcut.
- #309 reservation equality and API reverse-collision evidence (§5.4); ownership-loss/fenced
  mutation refusal remains covered by the real wiring.
- Route authz matrix: author may create, save and read; author gets 403 on publish, unpublish and
  delete.
- Media usage includes journey heroes, so deleting one is refused.
- Backup: v-N dump round-trip reproduces the journeys exactly; every older supported version still
  restores (journeys empty); `readDump` rejects journey keys in a pre-N dump, dangling or twice-
  claimed keys, and a malformed snapshot; allow-list test updated; CLI counts.
- Restore a pre-N DE-primary recovery set into a target containing EN-only journey snapshots,
  with identical member translation keys in both sets. Through the journey-aware recovery
  reader, assert journeys/locales/members become empty and matching language state commits in
  the same transaction; immediate dump/read/restore succeeds. Inject transaction failure and
  assert both original journey rows and original language state remain. Cover the EN-primary
  mirror and schema-aware recovery admission without destructive boot normalization.
- `main-boot.integration.test.ts`: the real `main.ts` wiring creates, publishes and rebuilds a
  journey (the #206 lesson).

**#310 (site)**
- `paths.test.ts`: journey paths in both locales, with existing helpers unchanged.
- Loader isolation: one journey snapshot content query within the shared exported PostgreSQL
  build snapshot, no working tables; draft journeys produce no entries; strict schemas.
  Barrier-test concurrent member/journey/mode mutations: all projections use the same epoch.
  Invalid/expired snapshot fails closed and releases connections on failure/timeout.
- Built HTML: the §4 assertions (strip, kept pager, draft absent); a zero-published-member journey
  produces no page, no index entry, no sitemap URL and no strip link; non-journey paths and
  non-member story pages match a pre-change build; N° numbers match.
- Render a canonical journey hero through the real `RemoteImage` consumer; inspect every
  `<source srcset>` URL and fallback `<img src>`. They must append exactly one generated
  `-<width>.<format>` suffix to the base (never `a-640.webp-1280.webp`), including after origin
  retargeting. Invalid suffixed snapshot sources are refused, not passed to rendering.
- Map: the fallback lists every published member link; no line feature joins pins or different
  stories (the line features equal exactly the members' `track` runs); keyboard and screen-reader
  check at 320/390px.
- `ui.ts` completeness and #287 reservation equality tests across all modes with `rundreisen`
  and `journeys` (site), plus `journey-admin` (app, already landed with #309). #310 records its
  public reverse-collision evidence separately; anonymous slashless and trailing-slash public
  journey/index requests never hit the authenticated API.

---

## 18. `SECURITY.md` and `ARCHITECTURE.md` impact (written when #309/#310 land, not now)

- **`SECURITY.md`:** a new authenticated author write surface (`/journey-admin*`), with
  publish/unpublish/delete admin-only; draft-isolation rule for journeys (snapshot-only loader,
  member resolution through `trips`); journey hero included in media-usage protection; dump
  version N contents; the *High risk* list in `CLAUDE.md` gains "journey tables, snapshot and
  membership cleanup". No new public write surface and no new secret.
- **`ARCHITECTURE.md`:** *Data model* gains the three tables and the no-FK/cleanup rule; *Content
  pipeline* gains the third collection and live-journey rule; *Database dumps* gains the version-N
  row and the restore scope sentence.
- **`CLAUDE.md`:** a project-status entry, the High-risk list, and Repository Structure (new
  loader and pages).
- **`DESIGN.md`:** the journey page, the strip and the overview map, in the Expedition Log
  language.

---

## 19. Devil's-advocate self-review

- *"Members resolved at render can still leak through the map JSON."* No. The map's
  `data-geojson` is built from the same resolved `trips` set, and the built-HTML test decodes it.
- *"Publishing a story silently publishes a journey page."* True, and intentional (§7.2). The
  journey was published by an admin. The admin list shows the dormant state so it is not a
  surprise.
- *"A snapshot scrub outside Publish breaks #20."* #20 forbids working-copy content reaching the
  public site. The scrub only removes a reference to a story that no longer exists, and a rebuild
  would drop that story anyway.
- *"Two advisory-lock namespaces may collide."* A collision only serializes unrelated work,
  exactly as for post pairs.
- *"Per-locale prev/next differs."* Approved #283 permits one-locale stories; each sequence
  remains correct for the links its reader can follow.
- *"The dump version races #283."* N is defined relative to `dev` when #309 lands, not hard-coded.
- *"Zero members in total but published."* Refused at publish. If all members are later deleted,
  the journey stays published and dormant, and the admin list says so.
- *"Unpublished snapshots do not count as claims, so cleanup can ignore them."* False: D1 claims
  govern exclusivity; I6 and dump validity govern **all** retained references. §14 scrubs both.
- **Integration requirements, not reopened decisions:** approved #283 provides coverage/history,
  no-redirect language locking and the exported build snapshot; approved #287 provides the shared
  reservations and pre-merge reverse gates. #398, #347 and #369 remain safety floors (§13/§16).
- **Decisions resolved, implementation still gated:** the owner approved D1–D10 on 2026-10-28,
  choosing permanent per-locale slug locks, required non-empty plain-text intro and the
  journey-publication language latch. The prior full independent specification re-review found
  no remaining actionable P1/P2 findings (§20). No runtime checks, collision-query evidence,
  implementation completion, deployment or owner-content changes are claimed by this document.

---

## 20. Approval record

**OWNER APPROVED, 2026-10-28.** Source: owner answers in the current implementation conversation,
recorded in the original checkout's
`.local/backlog-execution-2026-10-27/issue-308-owner-decision.json`.

| Decisions | Recorded owner selection |
|---|---|
| D1, D2, D5–D10 | Approve the proposed reviewed contract, including schema, backup, security and rollback boundaries. This includes the dormant journey's publication-language latch |
| D3 | Localized `rundreisen` / `journeys` prefixes under the approved language modes; permanent per-locale first-publication slug locks (option B) |
| D4 | Require non-empty plain-text intro in every requested enabled, non-omitted locale |

**Review provenance:** before these owner selections, `ReviewJourneyDesign` completed a full
re-review of the corrected 919-line proposal and returned **“correct as an owner-gated proposal”**,
with **no remaining actionable P1/P2 findings** (confidence 0.96). That verdict addressed the
complete proposal, including canonical unsuffixed hero sources and journey-aware cross-version
recovery. It is specification-review evidence, not implementation or runtime verification.

**Scope of approval:** implementation contract only. #283/#287 remain unchanged approved
prerequisites. Target-specific collision evidence, integration of their language/reservation/
shared-build-snapshot contracts, landing dump-version allocation, implementation-PR approvals
and all archived #309/#310 acceptance checks remain required. This record does not label any
journey feature implemented or authorize merge, deployment, publication, an existing story URL
rename, or an owner-data/content operation.

## 21. #309 implementation and qualification boundary (2026-10-29)

The authoring implementation uses `uploader/src/journeys.ts`, `journey-cleanup.ts` and
`journeys-admin.ts`. Its three tables are separate from posts; the only post-store coupling
is same-transaction reference removal. `site/src/lib/journey-snapshot.ts` is the strict,
versioned snapshot boundary shared by storage, recovery and the public reader. Native
recovery format **14** follows pages/navigation format 13; allocation must be rechecked
against the integration branch before landing.

The API owns **`/journey-admin`**, not `/journeys`. Static reservation and synthetic
collision/route regression coverage do **not** establish the actual-target reverse gate.
The owner/deployment target must supply the read-only report for `(root, journey-admin)`,
covering story/page working and committed slug claims, before merge. No target-content
read, rewrite, publication, deployment or collision clearance is claimed here.

Source regression coverage accompanies the store, real PostgreSQL lock races, ownership
loss, cleanup, recovery, authenticated routes and editor. Source completion is not evidence
that those checks ran: the integration owner must run the full affected suites with
`TEST_DATABASE_URL`, type checking, a real main-process build/publication smoke, and
keyboard/browser qualification after merging the source slices. The approved security
floors, human implementation-PR approval and rollback/recovery limits in §§13/16 remain.

### Observed #309 qualification

The subsequent isolated run at `0c87708` used actual `main.ts`, PostgreSQL18.6, Astro
builds and native browser controls. Its81 retained observations cover author creation,
keyboard ordering/reload, authorization refusals, two-tab409 without token adoption,
permanent slug history, omitted/disabled locales, committed-snapshot isolation, and
all-reference story cleanup with compact retained ordering. Confirmed journey deletion
preserved member story identities/URLs; the terminal editor emitted no further mutation.

A genuine navigation-save postcommit release-write failure retained the saved token and
old live release; restoring exact permissions and choosing Rebuild promoted the saved
navigation without a second PUT. Native-owned offline N14 dump/read/restore matched
journey and language state. An immutable pre-journey318 writer emitted a genuine unedited
N13 dump; restoring it into a separate fresh EN-only journey target with explicit
cross-mode consent cleared all journey tables and restored matching DE-primary language.
Immediate N14 dump/read/restore also succeeded. Undo sets and hashes are retained.

Desktop/320/390px controls and keyboard outcomes were inspected. All owned apps/tabs
were closed and permissions restored; no owner content was used. The actual-target
collision report, landing format allocation, human implementation approval and applicable
physical/screen-reader checks remain separate gates, not established by these fixtures.

Independent implementation review identified two editor state defects: a stale clean
Unpublish adopted a newer token without its working copy, and recovery of a never-saved
journey left automatic derivation enabled for a manually chosen slug. Lifecycle results
now adopt working copy and token together; a newer input generation retains its original
editing base rather than silently accepting a newer token. Recovered nonempty slugs disable
automatic derivation, while empty ones remain automatic. Both consumer regressions failed
before repair; all19 journey editor cases passed afterward.

Actual `9288b32` qualification used two native browser tabs and genuine PostgreSQL-backed
routes/builds. B saved both introductions, EN title, hero metadata/focus and reordered
membership. Stale clean A's Unpublish returned and displayed B's working copy; A's next
one-field Save used that returned token. HTTP and independent SQL confirmed that B's other
values/order survived. Native typing could not modify the disabled form during the real
Unpublish build. A separate new-journey recovery used actual debounced/beforeunload storage
and the real confirmation dialog: the next title edit preserved the manual DE slug while
the recovered empty EN slug derived normally. POST, GET and SQL agreed. Desktop/320px
keyboard states were inspected. The record discloses rejected fixture attempts and an
initially cancelled recovery; successful qualification was separate. Owned sessions,
browser storage/tabs and app were closed, with synthetic data and evidence retained.
