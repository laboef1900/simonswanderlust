# WXR Importer Hardening — Throttle, Bounded Retry, Resumability — Design

**Date:** 2026-07-30
**Status:** Approved (scope decided on issue #85)
**Risk:** **High.** CLAUDE.md's Change Risk table names `safeFetch`/WXR import explicitly. Requires
this spec, trust-boundary and misuse-case analysis, full affected suite plus failure/recovery
tests, explicit human approval, and a documented rollback plan.
**Repos touched:** blog repo — `uploader/` only. No `site/` change, no schema change, no new
endpoint, no new runtime dependency, no new persistent file.
**Builds on:** `2026-06-24-wp-import-design.md` (the importer itself) and
`2026-07-26-media-library-and-galleries-design.md` (`work-lock.ts`, `encode-queue.ts`, the
deterministic-key contract).
**Closes:** #85.

## Why this exists

The 2026-07-29 WordPress migration imported 9 DE/EN pairs and re-hosted 665 photos — but not
through `POST /import`. The route was tried first and failed, so the migration used a throwaway
script that worked around three separate weaknesses. Issue #85 records the measurements:

- **No throttling.** `buildLocale` re-hosts in a tight sequential loop with no pacing. Against
  `simonswanderlust.com` that lasted **37 images over 7.5 minutes** before the host refused
  connections — fetch times climbed 2.3 s → 13 s → 18 s, then the remaining ~600 requests all
  failed inside 13 seconds. A fixed ~1.2 s spacing completed all 665.
- **The failure is silent.** `importWxr` returned `imported: 9, skipped: 0` — a clean success —
  while every gallery line kept its original `wp-content` URL, because a failed fetch deliberately
  leaves the line untouched (correct, but invisible).
- **No retry.** One transient refusal loses the photo permanently for that run.
- **No resumability.** An abandoned run re-fetches everything from zero.

The migration is done, so this is not urgent. But the importer is a shipped feature that today only
works for exports small enough to finish inside a browser timeout and under whatever rate limit the
source host enforces.

## Scope

Issue #85 offers "Minimum", "Better", and "Either way" directions. This spec implements
**Minimum + "Either way"**, plus the controls that make them safe.

**In scope:**

1. Configurable inter-request delay.
2. Bounded retry with backoff, restricted to genuinely transient failures.
3. Accurate image accounting in the summary, so a partial import cannot look clean.
4. Resumability — a re-run re-fetches only what is missing.
5. The bounds and mutual exclusion that (1)–(4) require in order not to make things worse
   (§Misuse cases). These are not scope creep: retry without them is a 4× amplifier on an
   already-large amplifier, and resumability whose recovery path is "click Import again" is unsafe
   without single-flight.

**Deliberately NOT in scope** — each with its reason, so a reviewer can see it was decided rather
than missed:

| Excluded | Why |
| --- | --- |
| Moving the import onto `encode-queue.ts` / `work-lock.ts` | Issue #85's "Better" option. A large architecture change; must not ride along with a hardening fix. |
| A progress-polling endpoint | Same. Belongs with the async move. |
| Publish-time refusal on leftover `wp-content` URLs | Real gap (§Accepted residual risk). Touches the publish gate — its own named-sensitive surface. Separate issue. |
| `/import` → `requireAdmin` | An auth-model change. Filed separately. |
| A `/data` free-space precondition on `/import` | Adjacent gap (`/upload` has one at `server.ts:269`). `insufficientSpace` needs a known incoming size, which an import does not have; needs its own design. |
| `redirect: 'manual'` in `safeFetch` | Would harden the redirect hop, but WP media URLs legitimately redirect; changing it risks the importer. Residual risk recorded in `SECURITY.md`. |
| `nameFromUrl` non-injectivity | Pre-existing: `foo.jpg` and `foo.png` both normalise to `foo`. Filed separately. |
| `bySlug` cross-locale slug collision | Pre-existing: `wp-import.ts:113-129` flattens DE and EN slugs into one namespace, so a group can bind to the wrong `translationKey`. Filed separately. |
| Disambiguating `ImportSummary.skipped` | It conflates four causes (missing translation, unsafe slug, deliberately-not-overwritten-because-published, a genuine `upsertDraft` failure). Real reporting debt, but #85 is about the **image** tier; the warnings already distinguish them in prose. Filed separately. |
| A per-import cap on distinct images | Would bound the pre-existing first-attempt amplification against a *succeeding* host (§M1). Needs a decision about what limit does not break a legitimate large export. Filed separately. |

## Architecture: four decorators around the existing `rehost` seam

`ImportDeps.rehost` (`wp-import.ts:10`) is already the injection point for the whole per-image
remote-fetch step. Everything here composes around it. Nothing moves into `buildLocale`'s loops.

```
per pair:  sharedRehost( resume+tally( retry( pace( rehostImage ) ) ) )
           └ existing    └────────── created once per import run ──────────┘
```

**`pace` sits inside `retry`, not outside it.** An earlier draft of this spec had
`pace( retry( … ) )`; implementation showed the inner position is strictly better and it is
what shipped. Outside, only the first attempt of each image passes the gate, so the gate's
`nextAt` is never advanced by a retry and the image *after* a retried one can fire
immediately. Inside, every actual network attempt is paced and the gate stays accurate — and
it costs nothing, because a backoff of 5 s already satisfies a 1.2 s gate, so no extra sleep
is emitted. Every invariant below holds either way; this position holds them more cleanly.

**The order is an invariant, not a detail.** It is pinned by `test/wp-import.test.ts`.

| Layer | Lifetime | Responsibility |
| --- | --- | --- |
| `sharedRehost` | per pair | Existing. Dedups by URL within a DE/EN pair. |
| `resume` | per run | Disk lookup by storage key. On a hit, return without fetching. Sole accounting and warning point. |
| `pace` | per run | Elapsed gate before a network call. |
| `retry` | per call | Bounded attempts with backoff. |

### Why retry must sit below `sharedRehost`

`sharedRehost` stores the **promise** before awaiting it and never deletes it on rejection
(`wp-import.ts:41-48`), so it memoises *rejections*. Wrapping retry above it would hand the same
already-rejected promise to every subsequent attempt: N attempts doing zero network work while
still paying the full backoff. Retry below the memo also means a URL shared by both locales is
retried once per pair, not once per locale.

### Why `resume` must sit below `sharedRehost` too

The 2026-06-24 export was ~650 distinct images arriving as **1,338** `rehost` calls, because a
DE/EN pair is two bodies referencing the same photos (`wp-import.ts:23-37`). Below the memo,
`resume` is invoked exactly once per distinct (pair, URL) — which is what makes the counters honest
and stops a resumed run from re-probing the disk twice per photo.

### Why `pace` must sit below `resume`

A resume hit must pay **no** delay. With `pace` above `resume`, resuming a 665-photo import would
sleep ~13 minutes while fetching nothing.

### The elapsed gate

```
await sleep(Math.max(0, nextAt - now()));
nextAt = now() + delayMs;
```

Not a flat pre-attempt sleep. Three consequences, all wanted:

- The first request of a run finds the gate open, so N images cost **(N−1) × delay**, not N × delay.
- A fetch+encode that already took 5 s has satisfied the gate, so the throttle adds **no** dead
  time. This reclaims essentially the whole ~13 min a flat sleep would add to a 665-photo run, and
  narrows rather than widens the window in which import-driven `sharp` runs alongside an
  in-process `astro build` (§Accepted residual risk).
- Throttle and backoff compose for free: a 45 s backoff already satisfies "≥1.2 s between
  requests", so the delay is not double-counted.

One gate instance per `importWxr` call — not per pair, and not per call.

## Resumability: derived from disk, not from a state file

Issue #85 suggests persisting `url -> {src,width,height}` to `/data`. **This spec derives the same
information from `/data/images` instead, and adds no new persistent state.**

### Why this is possible

The importer's storage keys are deterministic *by design*. `storage.ts`'s `contentHashKey`
`@ai-warning` states that the WP re-host path deliberately does **not** content-hash, precisely so
re-imports are idempotent. Confirmed: every other write path — `POST /upload`, the editor's inline
photo upload, the bulk media library, and the CLI — appends `-<hash8>` via `contentHashKey`
(`server.ts:288`, `cli.ts:17`). So the **un-hashed** `trips/<slug>/<name>` namespace belongs
exclusively to the WXR importer.

`walkStorageKeys(storageDir)` (`media-sync.ts:48`) already builds `key -> { hasVariants,
largestVariant, origBytes }` in one recursive `readdir`, is already tested, and already runs at
every boot. `variantWidths(intrinsic)` always appends the intrinsic width as its last element
(`variants.ts:15-16`), so the largest webp variant's **filename encodes the intrinsic width**, and
`probeImage` reads the height from that file in ~0.2 ms (`pipeline.ts:61-69`). Variants are not
upscaled and preserve aspect ratio, so at the intrinsic width the variant's dimensions *are* the
`RehostResult`'s dimensions.

### The lookup

Given a candidate key, `resume` returns a `RehostResult` iff **all** hold:

1. The key is **not** a hero slot (see below).
2. `walkStorageKeys` recorded a `largestVariant` for that exact key.
3. The **complete** expected variant set exists: every `variantWidths(w) × FORMATS` filename.
4. `sharp(<largest webp>).metadata()` yields a positive height **and** a width equal to the one
   parsed from the filename — which makes this a dimension-identity check, not merely an
   existence check. Reads by path rather than through `probeImage` (which takes a `Buffer`),
   matching the existing `probeDims` helper in `media-sync.ts:85-92`. Sub-millisecond per photo,
   against a ~5 s fetch+encode.

Then `src = ${baseUrl}/${key}`, recomputed from the **live** config.

Otherwise it falls through to `pace(retry(rehostImage))`.

### The hero slot is never resumed

The hero key is `trips/<slug>/hero` (`wp-import.ts:60`) — it encodes **nothing about the URL**, so
disk cannot distinguish "the featured image I already fetched" from "a *different* featured image
now occupying that slot". `resume` therefore returns `null` for any key ending in `/hero`, as an
explicit rule carrying an `@ai-note`, and the hero is always re-fetched.

Cost is one fetch per pair — 9 on the real export. It is also the *more* correct behaviour: a
changed featured image now updates on re-import, where a URL-keyed state file would only have
noticed because the URL changed.

If the same URL is both the hero and a body image, behaviour is unchanged from today: the hero call
runs first, `sharedRehost` memoises it by URL, and the body reference receives the hero's result.

### The disk index is built once per run and deliberately not refreshed

`walkStorageKeys` runs once, before the first pair. It therefore does **not** see files the same run
writes. That is wanted, and it is what makes two behaviours hold:

- Two pairs can never read each other's in-run writes, so the cross-trip scoping invariant cannot be
  weakened by ordering.
- A `nameFromUrl` collision within a pair (`foo.jpg` and `foo.png` both → key `…/foo`) still fetches
  twice and lets the second overwrite the first, exactly as today. A refreshed index would have
  changed that silently.

### Why this is better than a state file

- **No new trust boundary.** A state file at `/data` is untrusted input that would need
  `assertSafeKey`, URL validation, dimension bounds, an entry cap, a size guard before
  `readFileSync` (`MAX_STRING_LENGTH` is 536,870,888 — above it the read throws and, under the
  house `catch → default` convention, resumability would silently cease to exist), and a decision
  about symlinks at the path. None of that exists here.
- **No prototype-pollution path.** `wp-import.ts:72` and `:100` do `images[r.src] = …` on a plain
  object literal. A cache-supplied `src` of `__proto__` would invoke the setter instead of
  registering a key, and `imagesMapError` would then see an object with no own keys and return
  `null`. Deriving `src` as `${baseUrl}/${key}` makes that unreachable.
- **It cannot disagree with reality.** Dimensions come from the file that will actually be served.
  A state file can outlive the pixels it describes.
- **No growth, no pruning, no rotation, no backup gap.** `archiveImages` is rooted at `storageDir`
  (`backup.ts:87`) and `dumpDatabase` covers only the tables, so a `/data`-root file would have
  been the only content in no backup at all.
- **It matches the house convention.** CLAUDE.md requires in-memory state to be *reconstructible*;
  the two existing instances are `encodeQueue.recover()` re-seeding from `status='processing'` and
  `media-sync` reconciling disk against the database. This is a third of the same kind.
- **`src` is origin-independent by construction**, so a database moved between environments cannot
  be poisoned with stale-origin URLs. (`site/`'s `retargetImageOrigins` from #88 would repair the
  *site* build, but the uploader's own `srcToKey` returns `null` for a foreign origin, which makes
  the publish gate report clean and `imageUsage` find zero references — so a stale origin inside
  the uploader is genuinely harmful.)

### What it costs

- **The hero is always re-fetched.** The hero key is `trips/<slug>/hero` (`wp-import.ts:60`), which
  encodes nothing about the URL, so disk cannot tell "the featured image I already fetched" from "a
  *different* featured image now occupying that slot". Re-fetching is both the safe answer and the
  more correct one: a changed featured image now updates on re-import, where a URL-keyed state file
  would have needed the URL to change to notice. Cost is one fetch per pair — 9 on the real export.
- **A `nameFromUrl` collision resolves differently than today.** Today `foo.jpg` and `foo.png` both
  fetch and the second overwrites the first. On a resumed run the second now reuses the first's
  files. Both outcomes are wrong; this one destroys nothing. The underlying non-injectivity is
  pre-existing and filed separately.
- **A WordPress filename ending in `-` plus 8 hex characters** under the same slug as an existing
  editor upload would collide with the hashed namespace. The import would then reuse the author's
  photo rather than overwriting it — where today it overwrites. Accepted: vanishingly unlikely, and
  the non-destructive direction.

## Retry classification

`FetchError` (`safe-fetch.ts:1`) gains three **additive** fields. Every existing message string
stays byte-identical, because `test/safe-fetch.test.ts` asserts on message text.

```ts
kind: 'invalid-url' | 'blocked' | 'http' | 'timeout' | 'too-large' | 'network'
status?: number   // for kind 'http'
code?: string     // from err.cause.code, e.g. 'ENOTFOUND'
```

`scheme` and `credentials` are folded into `invalid-url` — nothing branches on them separately.

**The policy lives in `wp-import.ts`, not `safe-fetch.ts`.** Retry is the importer's concern;
`safeFetch` stays a fact-reporter and the SSRF chokepoint, and does not grow responsibilities.

| Retryable | Not retryable |
| --- | --- |
| `timeout` | `invalid-url`, `blocked`, `too-large` |
| `network`, except `code === 'ENOTFOUND'` | `http` with any other status |
| `http` with status 429 or ≥ 500 | **anything that is not a `FetchError`** |

Three rules deserve their own justification:

- **Never retry a non-`FetchError`.** `processImage` and `storeVariants` throw plain `Error`s.
  `sharp` is configured `failOn: 'none'` and runs `2 + 2×|variantWidths|` pipelines per image
  inside a `mem_limit: 4608m` container, so four decode attempts on the same hostile buffer is
  memory-pressure amplification, not recovery. An `ENOSPC` from `storeVariantFiles` likewise gets
  no extra chances to leave more partial variant sets. **Only the fetch is retried.**
- **`ENOTFOUND` is not transient.** `safe-fetch.ts:100` is a catch-all that funnels DNS failures,
  `ECONNREFUSED`, and genuine programming errors into one bucket. Treating all of it as retryable
  means a WXR whose source host is simply gone costs 665 × 65 s ≈ **12 hours of pure backoff** to
  report a failure that was knowable in seconds.
- **`Retry-After` is deliberately not honoured.** It is attacker-chosen, and `Retry-After: 86400`
  would stall a handler that nothing bounds (`requestTimeout` bounds only *receiving* a request —
  `server.ts:95-101`). `safeFetch` discards headers on a non-ok response anyway, so honouring it
  would require widening the SSRF chokepoint's contract for a feature whose only effect is to hand
  a remote host a stall lever. A 429 counts toward the per-host breaker instead, which is the
  correct response to a host asking you to stop.

**Backoff:** 5 s / 15 s / 45 s — the values the migration script used successfully.

## Trust boundaries

Unchanged from today except where noted. The WXR upload is attacker-influenced input.

| Boundary | Control | Effect of this change |
| --- | --- | --- |
| Remote image URL → network | `safeFetch`: `assertFetchableUrl` (scheme, credentials, literal-IP loopback/link-local), 15 s timeout, streamed 25 MiB cap | **Unchanged and not weakened.** `assertFetchableUrl` runs *inside* `safeFetch` (`:68`), and `retry` calls `safeFetch(raw)` fresh each attempt, so every attempt re-validates. Neither the URL nor the returned `URL` object is hoisted out of the loop. Pinned by a test that counts validations per attempt. |
| WXR slug → filesystem path | `isSafeSlug` at the group boundary before any re-host, `assertSafeKey` inside `storeOriginal`/`storeVariantFiles` | Unchanged. `resume` additionally routes every key it builds a path from through `assertSafeKey`. |
| `/data/images` → resume decision | Complete-variant-set check, `probeImage` | **New, fail-closed.** A partial or absent variant set re-fetches. |
| Import result → post body / `images` map | `imagesMapError` at the `posts.ts` store chokepoint | Unchanged. Note it validates only *values*, never the URL key — which is why `src` is derived rather than stored. |
| Import result → author | `ImportSummary` JSON | **Tightened** — see below. |

### Information disclosure: a leak this change would otherwise sharpen

`isBlockedHost` (`safe-fetch.ts:26-37`) blocks loopback and link-local literals only. **RFC1918 is
not blocked**, and neither are compose-internal hostnames. Today's warnings echo the raw URL plus
the undici message, so an author can already probe the internal network:

```
image http://10.0.0.5:8080/x for slug: request failed for …: connect ECONNREFUSED 10.0.0.5:8080
```

`/import` is `requireAuth`, not `requireAdmin`, so that is available to any non-admin author.
Adding `kind` and `status` to the response would sharpen it into a clean discriminator, and retry
timing would add a second channel. CLAUDE.md is explicit: never return raw infrastructure errors.

**Therefore:** warnings carry a **stable reason string** derived from `kind` ("download failed",
"timed out", "blocked address", "too large", "network error") plus the URL the author themselves
supplied. `status`, `code`, and the underlying message go to **stdout only**. The counts leak
nothing. This is a net reduction in disclosure relative to today.

### Where warnings are emitted

Today each of `buildLocale`'s three catch blocks (`wp-import.ts:61`, `:73`, `:93`) pushes its own
warning, so a URL referenced by both locales of a pair produces **two** warnings for **one**
memoised failure. That double-reporting is exactly what the issue calls a summary that cannot be
trusted.

- The `resume` layer becomes the **sole** emitter of per-image warnings. It runs once per distinct
  (pair, URL), so one failure yields one warning. It has the storage key, which carries both the slug
  and the role (`…/hero` vs `…/<name>`), so no context is lost.
- `buildLocale`'s catch blocks keep **catching** — the loop must continue and the line must be left
  untouched so nothing is lost — but stop **pushing**.
- Group-level warnings stay exactly where they are in `importWxr` (missing translation, unsafe slug,
  already-published, a thrown `upsertDraft`).
- The array is capped at **200** entries plus one final `…and N more (see server logs)`. With a dead
  CDN it would otherwise exceed 1,300 strings, each embedding a full URL, in a single JSON body on a
  route with no response-size limit.

## Misuse cases

### M1 — Retry/delay amplification against a third party

`sharedRehost` is scoped to one translation pair, deliberately (`wp-import.ts:23-37`), so a photo
referenced by N distinct translation groups is fetched N times. That is the amplifier.

The upload cap is **25 MiB** (`server.ts:157-159`; note the single global multipart registration is
shared with `/upload`, and `files: 1` carries a load-bearing `@ai-warning` — neither may be
relaxed). A minimal accepted DE/EN group is ~634 bytes, so one attachment URL declared **once** and
referenced from every group reaches roughly **40,400 fetches** — a ~40,000× amplification against a
single third-party URL. `/import` is author-level, unrated, and has no concurrency guard.

**The first-attempt amplification pre-exists.** Bounded retry is what this change adds, and it would
multiply it by up to `retries + 1`. Compensating controls:

- **`retryBudget` — a per-import cap on *retry* attempts only. Default 200.** Deliberately not a
  total-attempt budget: first attempts are the legitimate work (one per distinct image) and capping
  them would break a genuinely large export, whereas retries are exactly the amplification this
  change introduces. So the extra load this PR can add to any victim is bounded at **+200 fetches
  per import, regardless of export size** — not `retries × N`. Once exhausted, failures stop being
  retried and one warning records it.
- **`hostFailureLimit` — a per-host consecutive-failure breaker. Default 20.** After 20 consecutive
  failures against one host, stop fetching that host for the remainder of the run, first attempts
  included. A success resets the counter. This is the control that makes a 429 or a dead host cost
  seconds instead of hours, and it is the only control that bounds the **pre-existing** first-attempt
  amplification: the 40,400-fetch scenario becomes ~20.
- **Single-flight (M2).** The gate is per-run state, so without mutual exclusion K concurrent imports
  give the victim K× the configured rate and the throttle provides no aggregate guarantee at all.
- **No silent caps.** Every bound that truncates work emits a warning and a stdout line. A truncated
  run must never read as a complete one — that is the whole point of the issue.

**Precisely what changes, without overclaiming:** against a host that keeps *failing*, total
exposure drops far below today's (the breaker trips at 20). Against a host that keeps *succeeding*,
the fetch **count** is unchanged from today — what changes is that the **rate** is now bounded by
`importDelayMs`, and single-flight stops that rate from being multiplied. Bounding the count of
successful fetches is a job for the excluded per-import image cap, and is not claimed here.

`importDelayMs` admits `0`, which restores pre-#85 behaviour. That is intentional: importing from a
local WordPress on a LAN has no reason to pace. Blast radius is bounded by the budget and the
breaker, not by the delay's lower bound.

### M2 — Concurrent imports

`POST /import` has no in-flight guard, and after this change the documented recovery path becomes
"re-run the import". Two concurrent runs over the same export means: both see a mostly-empty resume
state and both fetch everything (the exact double-charging this feature exists to prevent); the
victim host sees 2× the configured rate; `storeVariantFiles` writes variants with plain
non-atomic `writeFile` (`storage.ts:110-123`), so concurrent writers to one deterministic key can
leave a **mixed variant set from two different source images**; and two `sharp` pipelines run in a
`mem_limit: 4608m` / `memswap_limit: 4608m` container where an OOM kills the blog, the admin, and
the image host together.

**Control:** a module-scoped in-flight flag returning **409** before the multipart body is read.
This is emphatically *not* `work-lock.ts` — no lock is acquired and no queue is involved.

### M3 — A malicious or corrupted `/data/images`

Not applicable by construction: there is no new state file, and the resume check is fail-closed on
an incomplete variant set. A key whose files were tampered with yields either a re-fetch or the
dimensions of the file that will actually be served.

## Invariants

Each is stated so it can be tested, and each has a test.

1. **Layer order.** `sharedRehost( resume( pace( retry( rehost ) ) ) )`. A resume hit emits no
   sleep and no fetch. A URL shared by both locales of a pair produces exactly one `resume` call and
   at most `retries + 1` fetch attempts.
2. **Pair scoping survives.** A URL shared by two *different* trips is re-hosted twice, under two
   keys differing by slug. This is `wp-import.ts:23-37`'s "deleting one trip cannot strip another's
   images", and it now holds **structurally** — the key contains the slug — rather than by
   convention.
3. **No double-charging on resume.** After a run in which URL X failed and Y, Z succeeded, a second
   run against the same `storageDir` fetches **exactly** `[X]`, plus the hero URL of each rebuilt
   pair (which is never resumed, by design). Asserted by call *identity* on a spy, not by count —
   and the test fixture declares no featured image, so the expected set is exactly `[X]`.
4. **`hosted + failed === total`**, counted over distinct (pair, URL). A resume hit counts as
   `hosted` and as no fetch.
5. **Only the fetch is retried.** A non-`FetchError` produces exactly one attempt.
6. **Every attempt re-validates the URL.** `assertFetchableUrl` runs once per attempt.
7. **Fail-closed resume.** An incomplete variant set on disk re-fetches.
8. **One import at a time.** A second concurrent `POST /import` gets 409 and performs no work.
9. **No infrastructure detail in the response.** No `status`, no `code`, no undici message.
10. **Existing behaviour preserved.** All seven current `wp-import.test.ts` cases pass unchanged,
    and `importWxr`'s own defaults (`delayMs: 0`, `retries: 0`) keep them instant.

## Recovery behaviour

**If the process is killed mid-import** (SIGKILL, OOM, `docker stop` past the grace period):

- Images already re-hosted are complete on disk, because `storeVariants` writes the original first
  and then the variants, and a `RehostResult` is only returned after both. There is no cursor to
  advance and nothing to corrupt — the absence of a state file is what makes this trivially safe.
- A pair interrupted before `upsertDraft` (`wp-import.ts:141`) simply does not exist in Postgres.
  Its images are on disk.
- On re-run, `resume` finds those images and the pair is rebuilt from disk with **no body or gallery
  fetches** — only its hero, which is never resumed. This is the failure/recovery path the issue asks
  for, and it is tested.
- An image killed *between* the original write and the last variant write leaves an incomplete set.
  The complete-set check re-fetches it. Duplicated work on resume is benign; a gap is not — the
  same asymmetry `backup.ts` already encodes for its image-archive cursor.

**Shutdown** needs no new step. `shutdown.ts`'s drain is explicitly best-effort and must not be
depended on; nothing here depends on it, because there is no buffer to flush.

**Rollback:** revert the PR. There is no migration, no schema change, no new file on `/data`, and no
change to what `storeVariants` writes — so a revert leaves already-imported content untouched and
restores the previous behaviour exactly. Two new `settings.json` keys would remain in the file and
be dropped on the next load by the known-keys pick at `settings.ts:69-76`.

## Configuration

Two fields in the JSON settings store — not `.env`, per CLAUDE.md.

| Field | Range | Default |
| --- | --- | --- |
| `importDelayMs` | 0 – 10000 | 1200 (the measured working value) |
| `importRetries` | 0 – 5 | 3 |

**Adding a `Settings` field silently no-ops unless all six places change**, and none of the
omissions fails `tsc`:

1. the `Settings` interface, 2. `defaultSettings()`, 3. `validate()`, 4. the explicit key pick at
`settings.ts:69-76` (omitted keys are dropped from `settings.json` on load), 5. the allow-list in
`POST /settings` (`server.ts:592-601`), 6. `settings.html` — markup **and** `fill()` **and** the
POST body.

**Trap:** `validate()` runs on **load** as well as on update, and one out-of-range value rejects the
*whole* file back to defaults (`settings.ts:77-84`). Both defaults must therefore pass their own
validator, or saving these settings would silently wipe the owner's LM and backup configuration. An
older `settings.json` lacking both keys merges with the defaults and validates cleanly.

`importWxr` does **not** import `settings.ts`. The route reads `cfg.settings.get()` and passes the
values through `ImportDeps`, following the `retention: () => settings.get().backupRetention`
read-at-use idiom (`main.ts:72`) and the `cfg.loginLimiter ?? fixedWindowLimiter({…})` precedent
(`server.ts:133`).

### Wiring: `main.ts` is untouched

`resume` depends on a **fresh** disk walk, so it cannot be a boot-time singleton like `settings` or
`dbBackup`. The route constructs it per request:

```ts
resume: await createRehostResume({ storageDir: cfg.storageDir, baseUrl: cfg.baseUrl })
```

Consequently `main.ts` needs no change at all — no new path derivation, no new injected store, and
no new entry in `ARCHITECTURE.md`'s env table. The complete file list is: `safe-fetch.ts`,
`wp-images.ts`, `wp-import.ts`, `settings.ts`, `server.ts`, `public/settings.html`,
`public/import.html`, `public/admin.css` (one `.notice-warn` rule for the partial-import
callout), plus tests and docs.

**Coherence note, accepted:** `POST /settings` is `requireAdmin` while `POST /import` is
`requireAuth`, so a non-admin author runs an import governed by knobs they cannot read or change.
That is a symptom of `/import`'s auth level, which is out of scope here and filed separately.

## The testability seam

All additions to `ImportDeps` are optional with production defaults, matching
`SafeFetchOptions.fetchImpl?` (`safe-fetch.ts:6`) and `RateLimitOptions.now?`
(`rate-limit.ts:11,19`).

```ts
export interface ImportDeps {
  postStore: PostStore; storageDir: string; baseUrl: string;
  rehost?: (url: string, key: string, alt: string) => Promise<RehostResult>;
  delayMs?: number;                       // default 0   — the ROUTE passes settings
  retries?: number;                       // default 0   — the ROUTE passes settings
  sleep?: (ms: number) => Promise<void>;  // default: real setTimeout
  now?: () => number;                     // default: Date.now
  resume?: RehostResume;                  // omit ⇒ no resume lookup
  retryBudget?: number;                   // default 200 — retries only, not first attempts
  hostFailureLimit?: number;              // default 20  — consecutive failures per host
}
```

`RehostResume` and `createRehostResume` live in `wp-images.ts`, beside `rehostImage`: both answer
"produce the `RehostResult` for this URL and key", one by fetching and one by reading what is already
there. The file is 17 lines today, so this is a cohesive home rather than a new module.

**Fake timers are the wrong tool here and are not used.** There is exactly one `vi.useFakeTimers()`
in the tree (`test/posts.test.ts:277-294`), it only calls `setSystemTime`, and nothing installs a
shim to keep real `fs`/`sharp`/`pg` work ticking — installed fake timers would hang any importer
test using a real `rehost`. `vitest.config.ts` sets no `testTimeout`, so the 5 s default applies and
a real 5+15+45 s backoff is untestable by construction. The delay is injected instead.

## Test plan

New and extended cases in `uploader/test/`:

**`wp-import.test.ts`**
- Pacing order: assert a single shared array equals
  `['fetch:a','sleep:1200','fetch:b','sleep:1200','fetch:c']`. Ordering, not just totals.
- The memoised second locale adds no `sleep:` entry (invariant 1).
- A resume hit adds no `sleep:` and no `fetch:` entry (invariants 1, 4).
- Elapsed gate: a `rehost` that consumes more than `delayMs` of injected clock emits no sleep.
- Retry, retryable: two `FetchError{kind:'network'}` then success ⇒ 3 calls,
  `sleeps === [5000, 15000]`, `images` = `{total:1, hosted:1, failed:0}`.
- Retry, non-retryable: one `FetchError{kind:'blocked'}` ⇒ 1 call, no sleeps.
- Retry, non-`FetchError`: a plain `Error` ⇒ 1 call, no sleeps (invariant 5).
- Retry below the memo: a URL failing in both locales ⇒ at most `retries + 1` attempts total,
  one warning, `failed === 1` (invariants 1, 4).
- Accounting: 665-style dedup ⇒ `total` counts distinct (pair, URL), not calls.
- **Failure/recovery, durability leg:** all fetches succeed but `upsertDraft` throws ⇒
  `skipped === 1`, and the images are nonetheless on disk, so a resumed run needs no fetch.
- **Failure/recovery, resume leg (wiring):** with an injected fake `RehostResume`, run 1 has `c.jpg`
  scripted to fail (`retries: 0`) ⇒ `{total:3, hosted:2, failed:1}`. Reset the spy, clear the failure,
  re-run ⇒ `expect(calls).toEqual(['https://wp/c.jpg'])`, `summary.updated === 1`,
  `{total:3, hosted:3, failed:0}`, and the stored post's `images` map holds all three (invariant 3).
- **Failure/recovery, resume leg (end to end):** the same scenario with the **real** `rehostImage`
  and the **real** `createRehostResume` against a `mkdtemp` `storageDir`, driving a stub `fetchImpl`
  that serves a `sharp({create:{…}})`-generated image — the house pattern from `cli.test.ts:18` and
  `pipeline.test.ts:12`. This is the test that proves resumability actually reads the bytes on disk
  rather than a mock, and it is the one a reviewer should look at first.
- **Fail-closed resume:** delete one variant file from a complete set ⇒ that URL re-fetches
  (invariant 7). Same for an absent set and for a zero-byte variant.
- **The hero is never resumed:** a pair with a featured image, re-run against a `storageDir` that
  already holds `trips/<slug>/hero` ⇒ the hero URL is fetched again while body images are not.
- **Cross-trip scoping:** two groups referencing one URL ⇒ two fetches, two keys differing by slug
  (invariant 2).
- `retryBudget` exhausted ⇒ retries stop, first attempts continue, a warning records the truncation.
- Per-host breaker ⇒ after `hostFailureLimit` consecutive failures on a host, later URLs on that host
  fail without a fetch; a different host is unaffected; an intervening success resets the counter.
- Warnings carry no `status`, no `code`, no undici message (invariant 9).
- Warnings are capped, with an explicit "…and N more" entry.

**`wp-images.test.ts`** — `createRehostResume` in isolation against a `mkdtemp` dir: a complete
variant set resolves with the dimensions read from the file; an incomplete set, an absent key, a
zero-byte variant, and a `/hero` key all resolve to `null`; `src` tracks the `baseUrl` passed in, so
the same disk resolves to different origins for different configs (the origin-independence property).

**`safe-fetch.test.ts`** — each `kind` is tagged for its trigger; `status` set for `http`; `code`
carried through from `err.cause`; every existing message assertion still passes;
`assertFetchableUrl` runs once per retry attempt (invariant 6).

**`server.test.ts`** — a second concurrent `POST /import` returns 409 and performs no work
(invariant 8); the route passes the configured delay/retries.

**`settings.test.ts`** — accept/reject at both bounds for both fields; an older `settings.json`
without them keeps every other value.

**`admin-pages.test.ts`** — the two new inputs exist and are wired into `fill()` and the POST body.

## UI

`import.html` gains one paragraph: the import continues server-side if the browser gives up, and
re-running it resumes rather than restarting. After this change that is the entire user-facing
recovery story, and the page currently says nothing about it. (`import.html` has no test coverage
today, so any assertion worth keeping is added to `admin-pages.test.ts` deliberately.)

## Accepted residual risk

- **The author may never see the summary.** At 1200 ms a 665-photo import is a ~13-minute single
  request bounded only by the reverse proxy, and #72 (Traefik timeouts) is open. If the proxy cuts
  first, the import continues server-side and `import.html` shows a failure. Mitigations: the
  summary is logged to **stdout** at import end, and resumability makes a re-run converge. A
  delivered in-browser summary requires the progress surface that #85's "Better" option carries and
  this spec excludes. **Stated here rather than discovered later.**
- **A partial import is visible but not un-publishable.** A failed body image leaves
  `![alt](https://…/wp-content/…)` in the body with no `images` entry, so `body-images.ts` emits the
  `<img>` unchanged and hot-links the old WordPress domain; a failed gallery line lacks its `WxH`,
  is never lifted into `images`, and the photo silently vanishes at render. Neither is blocked:
  `validateForPublish` inspects only the hero `src`, and `notReadyPhotos` reports clean because
  `srcToKey` returns `null` for a foreign origin. Hero failures *are* loud (the placeholder fails
  publish validation); body and gallery failures are silent all the way to the live site, and after
  Phase 4's DNS cutover they 404. This spec makes them **visible** (counts, one warning per failure,
  a stdout line) but not **fatal**. The publish-time refusal is a separate issue.
- **Retry multiplies an accepted SSRF gap.** `assertFetchableUrl` is a pre-resolution string check
  and `safeFetch` uses `redirect: 'follow'`, so neither DNS rebinding nor a redirect hop is
  inspected. Retry turns one race per URL into up to `retries + 1`. This is a **security-model
  change** and is recorded in `SECURITY.md` with `retryBudget` and the per-host breaker as its
  compensating controls. `assertFetchableUrl` still runs on every attempt.
- **Import encodes do not take `work-lock`.** `rehostImage` → `processImage` runs `sharp` outside
  the shared build/encode mutex, so a long import can encode concurrently with an in-process
  `astro build`, both peaking near 2 GB in a 4608 MiB container. The elapsed gate *narrows* this
  window relative to a flat sleep, but does not close it. Refusing to start an import while the
  exclusive lock is held would be a few lines against `workLock.stats()`; it is excluded here
  because it belongs with the async move. Filed separately.

## Definition of done

- `npx tsc --noEmit` and `npm test` green in `uploader/`; CI green (CI is authoritative for the
  Postgres-backed suites, which skip locally without `TEST_DATABASE_URL`).
- Every invariant in §Invariants has a test.
- `SECURITY.md` updated for the retry/redirect exposure change; `CLAUDE.md` status line updated;
  follow-up issues filed for each deferred item in §Scope.
- Explicit human approval before merge, per CLAUDE.md's High-risk row.
