# Phone authoring audit and mobile acceptance matrix (#300)

Date: 2026-10-27. Risk: **Low** (investigation and documentation; no app change).
Status: **APPROVAL PENDING.** Nothing in this note is owner-approved yet. Decisions D1–D5 below
are proposals. The device audit has **not** been run, so this note records no device finding.
**Hard prerequisites for any gating result:** access to suitable physical iOS and Android devices
(D1) and a trusted-TLS disposable test instance (D4). Access has not been supplied; no tier-A run
has occurred. Ownership of both phones is not required.
Part of epic #299. It blocks #301 (Media on a phone) and #302 (compose/preview/publish on a phone).
Historical drafting baseline: `dev` at `11e16d1` (v0.17.1); the issues were planned against
`9e400f9`. Source/host observations below are the original drafting record, not a new audit or
verification of the eventual test build. Record that build and recheck hypotheses when executing.

This note becomes the durable in-repo record that #300 and #299 require. Once the owner approves
it, it holds the support matrix, the harness decision and the findings summary. The detailed
evidence (screenshots, recordings) stays attached to issue #300, because binaries do not go in
git (Golden Rule 5).

## 1. What this note is, and what it is not

- **Is:** a proposed device/browser matrix, a scripted end-to-end journey, the probes each
  hypothesis needs, the evidence fields every result must carry, the rule for assigning each
  finding to #301, #302 or the resilience epic #303, and the two owner decisions the issue
  names, with measurement choices, execution prerequisites and conditional exceptions separated.
- **Is not:** a findings list. Under #300 a finding exists only once it is reproduced on a device
  in the agreed matrix. Section 6 lists **candidate** findings: hypotheses with static evidence
  and, in one case, a reproduction on the host outside the app. Each is still an investigation
  item.
- **Not in scope:** fixing anything (#301/#302), any app/runtime/CSS/test change, any new
  dependency (that is decision D2), and any change to `DESIGN.md` or `PRODUCT.md` before approval.

### Evidence labels used below

| Label | Meaning |
|---|---|
| `[STATIC]` | Read in the source at `11e16d1`; file and line cited. |
| `[HOST]` | Reproduced on the drafting Mac **outside the app**: library-level, not through a route, not on a phone. |
| `[EXTERNAL]` | Vendor or platform documentation; the link is given. |
| `[INFERENCE]` | Expected platform behaviour, not observed for this app. The device run must confirm or reject it. |
| `[DEVICE]` | Observed on a real device in the matrix. **No entry carries this label yet.** |
| `[EMULATED]` | Observed in Chromium device emulation (tier B). Never sufficient to close a gate. |

## 2. Test tiers: native devices versus emulation

| Tier | What it is | Gating? | What it can establish | What it cannot |
|---|---|---|---|---|
| **A: native device** | Accessible real iPhone and Android hardware, with the browsers in D1, against a disposable instance (§8). | **Yes, for observed scenarios only.** Only physical-device evidence can pass a device gate. | The exercised keyboard/viewport, popup, lifecycle, picker/camera, scaling, hardware-keyboard, touch and network scenarios in §5. | Untested scenarios, widths, devices or browser builds. Remote hardware access does not by itself prove camera acquisition, Bluetooth input or OS-discard coverage. |
| B: Chromium emulation | A managed Chromium with device metrics, touch emulation and a mobile UA (the parent agent can run this). | **No.** Pre-check and regression smoke only. | Layout reflow and horizontal overflow at 320/390 CSS px; measured target sizes; DOM focus order with a keyboard; overflow at a doubled default font size; Chromium's popup policy; EasyMDE's mobile branch (it picks `contenteditable` from the UA, `easymde` 2.21.0 `src/js/easymde.js:2205`). | Any WebKit/iOS behaviour. The on-screen keyboard (emulation shows none). The visual-viewport/`100dvh` interaction. Real IME, autocorrect and selection handles. The OS file picker and HEIC transcoding. Tab discard and backgrounding. Dynamic Type. |
| C: iOS Simulator (optional) | Xcode's simulator runs real iOS Safari/WebKit without the hardware. | No; a tier-A supplement only. | WebKit layout, popup policy and the software keyboard on a host. | Camera, real photos from the owner's library, and real memory pressure. **Not available on the drafting Mac:** Xcode is installed, but `xcrun simctl list runtimes` lists no iOS runtime. |

Desktop Safari's Responsive Design Mode is WebKit on macOS, not iOS Safari. It counts as tier B
quality, not tier C.

## 3. D1: proposed support matrix (owner names the exact devices and versions)

Historical vendor release references (not observed installed versions or a freshness guarantee):

- **iOS Safari 27** ships with iOS 27. Safari 27.0 was released 2026-09-14
  ([Apple Safari release notes index](https://developer.apple.com/documentation/safari-release-notes),
  `[EXTERNAL]`); 27.2 is in beta.
- **Chrome for Android 156** (156.0.8078.47 rolled out from 2026-10-20,
  [Chrome Releases](https://chromereleases.googleblog.com/2026/10/chrome-for-android-update_095004068.html),
  `[EXTERNAL]`).

| Cell | Platform | Browser | Device (owner to name) | Gating |
|---|---|---|---|---|
| A-iOS | iPhone on the owner-approved current stable iOS major | Safari, exact installed build recorded at execution | Accessible iPhone hardware; ability to reach each exact width/text cell must be established, not inferred from its model. | Yes |
| A-And | Android phone on the owner-approved OS | Current stable Chrome, exact installed build recorded at execution | Accessible Android hardware; borrowed hardware is sufficient. | Yes |
| B-320 / B-390 | Chromium emulation | Managed Chromium | 320×640 @2x and 390×844 @3x, touch, mobile UA | No (pre-check) |

**Proposed version policy:** "supported" means the current stable major of each browser at the
time of a matrix run, with exact installed OS/browser builds recorded. The owner approves this
policy or names a different supported range. A previous-major-only defect is recorded separately;
it requires a waiver only if it violates an agreed support requirement. The matrix is re-run when
#301 or #302 lands, and when a later change touches the shell, editor, Media or `admin.css`
responsive rules.

**Proposed exclusions** (each recorded, none tested as gating): iPad, Firefox for Android, Samsung
Internet, in-app browsers (Mail, Messages, social apps), and home-screen web apps.
**Landscape** is proposed as a non-gating spot check of the editor with the keyboard open (owner
choice under D1), because the adapt guidance warns against forgetting it.

**Optional tooling choice, not a production prohibition:** a cloud real-device service may
provide some hardware access. It is not a required dependency and is not ruled out by the
self-hosted production architecture. Using it needs explicit owner authorization for the provider,
account, cost, disposable credentials/data, retention and access model. No purchase, account or
dependency is authorized here. Establish its actual capabilities before assigning evidence:
camera/Photos/Files acquisition, Bluetooth input, OS discard and exact width/text conditions
cannot be assumed. Unsupported scenarios still need suitable physical access; emulation is tier B.

## 4. D3: what "320/390 px" and "200% text" mean on each platform

The issue requires **exactly 320 and 390 CSS px**, each at normal and 200% text, on each gating
platform. A model's advertised resolution, a setting's label, or a nearby width is not a
measurement. Record `innerWidth`, `visualViewport.width`, `devicePixelRatio`, computed root
`font-size` and representative rendered text sizes, before/after scaling and with keyboard
closed/open, using the remote inspector (§8). Record layout and visual viewport separately.

| Run | Physical-device procedure (both platforms) | Tier-B equivalent |
|---|---|---|
| **W390** | Establish a layout viewport of **390 CSS px** at normal text and record the measurement. iOS Standard/Display Zoom or Android display-size controls are possible means, not guarantees. 375/384/393/402/412 px are supplemental runs, never W390 passes. | 390×844 @3x |
| **W320** | Establish a layout viewport of **320 CSS px** at normal text and record the measurement. A width below 320 is supplemental too; `≤ 320` does not satisfy an exact cell. Availability is unestablished on both platforms. | 320×640 @2x |
| **T200** | Use an owner-agreed method and establish that relevant UI text actually reaches 200% of its normal size. Record unchanged or differently scaled controls too. Browser text controls, OS font scaling and page zoom are not interchangeable. A 200% setting alone or a doubled root font is insufficient evidence. | Doubling browser default font size or root `font-size` is a labelled approximation; fixed-size controls may not scale. |
| **DT / system scaling** | Separately exercise iOS Larger Text at the largest accessibility size and Android system font size at maximum. Record measured effects, reflow and task usability; no effect is a hypothesis, not automatically a defect or proof of T200. | No native-platform equivalent. |

**Required combinations (unchanged from #300/#301/#302):** W390, W390+T200, W320 and
W320+T200 for both iOS and Android. For a combined cell, establish the exact named layout width
**with scaling applied** and measure the text enlargement. Safari page zoom may alter the
viewport; a nominal 390-wide baseline that becomes ~195 px at 200% is a supplemental zoom run,
not a W390+T200 pass. Record all resulting overflow; do not silently waive it using a WCAG
reflow-floor argument. Text-only scaling cannot be assumed available or effective on either OS.

If a width/text combination cannot be established with available hardware and controls, keep
that exact cell **open**. Record attempts and measured alternative widths/scales. Only a scoped
owner exception naming the unmet requirement and substituted evidence (§7, D3) can permit
acceptance with that gap; it is never an exact-cell pass, and tier B cannot substitute.

## 5. The journey and the probes

### 5.1 Accounts and fixtures

The instance is disposable (§8). It has one **admin** and one **author** (non-admin) account,
created only for the audit, with generated passwords that are not the owner's. The fixture
photo set, `FX-300`, is assembled for the audit and is never the owner's library:

| Fixture | Purpose |
|---|---|
| 8 ordinary camera JPEGs from the phone (location services **off**, or taken somewhere non-sensitive) | The 10-photo batch (with the next two) |
| 1 photo shot on iPhone with Camera → Formats → **High Efficiency** (HEIC) | HEIC path through the picker |
| 1 photo over **25 MiB** (e.g. a large panorama, or a JPEG made > 25 MiB on a desktop and transferred to the phone) | Size refusal |
| Android: 1 photo shot as HEIF if the camera offers it, and 1 "Ultra HDR" JPEG if the device produces one | Android format path |

Use the same HEIC fixture transferred to Android when that camera cannot produce HEIF; distinguish
source format from what Photos/Gallery, Take Photo and Files actually deliver. Ensure at least
one Files selection delivers a client-observed file larger than 25 MiB even if Photos transcodes
the original below the limit. Exercise decoding in the actual disposable server image: a filename,
MIME label or successful metadata probe is not proof that variants can be encoded.

**Story fixture `ST-300`:** create a fresh disposable story per run with unique fixture-only slugs
(record the chosen slugs and translation key; never rename an existing story). On this drafting
baseline both DE and EN are required. In **each** locale enter a title, slug, excerpt, country,
three paragraphs, a ready hosted hero with descriptive locale-specific alt text, two ready hosted
inline photos and one three-photo gallery with locale-specific alt/captions. Exercise gallery
ordering and preserve the existing fence/layout semantics. Fill a valid date, matching two-letter
country ISO code, supported region and finite in-range coordinates for a non-sensitive public
place; add key facts in both locales. Record the actual fixture values and photo keys in evidence.
The human operator supplies descriptions matching the synthetic/test photos, not invented claims
about owner content. No foreign image URLs, unready photos or body H1s may be used to bypass gates.

Record the tested build's language mode/policy. If a later approved build supports single-language
publishing, complete all fields for every locale required by that mode and verify its actual
public-route behavior; do not invent an EN requirement for a DE-only mode or skip EN on a bilingual
run. The #300 DE/EN media-description and both-editor-tab coverage still needs a bilingual run;
a single-language run is additional coverage, not a substitute or authorization to change policy.

### 5.2 Journey (run once per gating cell × combination, first as author, then as admin)

| Step | Action | What to record (pass criterion in **bold**) |
|---|---|---|
| J1 | Open `/login`, sign in (try password-manager autofill). | Focus on input does not zoom the layout or cause horizontal scroll. **Signed in; no horizontal scroll at W390/W320.** |
| J2 | Shell: open the navigation drawer, move to Media, close the drawer. | Drawer traps focus, closes with Escape (keyboard) and the scrim (touch). **Every control reachable and ≥ 24×24 CSS px (WCAG 2.2 SC 2.5.8).** Record any control under 44 px. |
| J3 | Media alone, without opening the editor: select the 10 FX-300 photos from Photos/Gallery; additionally exercise Take Photo and Files acquisition, including the special files. | Record client `File.name`/`type`/`size`, upload request presence, transfer progress, stored original and media-row states. **A determinably >25 MiB file is visibly refused with a reason before any upload request or file-body transfer. Every accepted file reaches ready or a visible terminal failure with a reason; nothing stays stranded in processing.** Transfer completion/HTTP success must not claim encoding success while the row is `processing`. Copy must explain that the tab stays open for transfer, not for server encoding. |
| J4 | Lock the screen for 30 s mid-batch, then unlock. Repeat by switching to another app. | Which files landed, failed or kept going. (Outcome-unknown handling is #305's; here the behaviour is only recorded.) |
| J5 | Describe one photo: title, DE alt, EN alt, DE caption, EN caption; save and reopen. Repeat entry using touch and the Bluetooth keyboard. Try AI suggestions if already configured; record an unavailable provider without hanging. | **Fields not hidden by the keyboard; Save reachable; focus visible; all saved locale values re-read correctly.** Optional unconfigured AI is marked not exercised, not failed or waived. |
| J6 | Posts → New post. Enter ST-300 title, unique slug, excerpt and three paragraphs in DE **and EN** on the bilingual baseline (apply §5.1 mode policy on later builds). | Keyboard covering the active field or command bar; selection handles, autocorrect, caret and toolbar wrap. **Text entered by touch and hardware keyboard lands where expected in each required locale.** |
| J7 | In each required locale choose the ready ST-300 hero and enter its alt; insert two inline photos and one three-photo gallery, with captions on. Reorder via the gallery picker. | **Picker usable by touch and keyboard; ordering operable; saved fence semantics and photo order match desktop.** |
| J8 | Story details drawer: complete date, country ISO, region, coordinates, each required locale's country and key facts; close it. Use the gaps bar to locate and complete any remaining required fields. | Focus trap, Escape/scrim close, focus returning to opener. **All required fields reachable with the keyboard open; no completeness gap remains before publishing.** Server publish validation is unchanged and authoritative. |
| J9 | Save draft, then reopen the saved fixture. | Status visible/wrapping. **Save succeeds and reloaded content, locale metadata, hero, inline photos and gallery order match the entered fixture**, not merely a transient Saved label. |
| J10 | More actions → Preview. Run on normal network and with a measured save longer than 10 s (§5.3 P1); inspect every required locale's preview. | **Preview opens without a popup-blocker prompt, or a working fallback link opens it**, and displays the fixture text, hero, two inline photos and gallery. |
| J11 | Make distinct unsaved final edits, background within 2 s, then execute P2's live return and discarded-page recovery separately. | **Restoring the discarded/reopened page offers the stash; accepting it restores the final unsaved edits.** Retained in-memory text on a live return alone does not pass recovery. |
| J12 | Admin: save recovered edits, resolve any gaps, Publish → confirm and await completion. Author: confirm Publish remains absent; do not attempt to publish as author. | **Confirmation and gaps bar operable by touch/keyboard; admin publication/rebuild succeeds. Open the actual public story on the disposable served site (not Preview) for each published locale and verify the final text, hero, two inline photos and gallery, captions/order and loaded image variants.** Record public URLs, publication result and served evidence. A toast, accepted request or failed build does not pass. **Authors see no Publish.** |

### 5.3 Probes for the issue's hypotheses

| Probe | Procedure | Applies to |
|---|---|---|
| **P1 Preview popup** | Tap Preview on a normal network and with an available, authorized test-LAN throttling mechanism. Measure that the actual save request exceeds 10 s before testing popup/fallback behavior; a profile label alone is insufficient. A proxy or OS developer conditioner is optional tooling, not assumed installed or effective. If unavailable, mark the slow-save probe blocked, not passed. User-activation expiry after `await` is implementation-defined `[INFERENCE]`. | H1 |
| **P2 Background/discard** | Add a unique unsaved marker in the last 2 s before (a) switching apps for 60 s, (b) locking for 5 min, and (c) backgrounding then closing/discarding the browser process and reopening the same draft. Candidate methods are iOS app-switcher close and Android `adb shell am kill com.android.chrome`; record the actual lifecycle observed, not an assumed equivalence to OS discard. Distinguish a still-live page from a new document. On the recovery path capture the offered stash, accept it and check the final marker plus edited locale fields. If the method does not discard, that probe remains open. Do not press Save or wait out the normal debounce before backgrounding. | H2 |
| **P3 Keyboard geometry** | With the on-screen keyboard open: focus the last field in the drawer, the EN title, and the body near the bottom. Record whether the sticky command bar stays visible and whether the page pans. Repeat with a Bluetooth keyboard (no on-screen keyboard) and in landscape (non-gating). | H4, H5 |
| **P4 Hardware keyboard** | Pair a Bluetooth keyboard. Tab through J2–J12; record the order and any trap or invisible focus. Try EasyMDE shortcuts (Cmd/Ctrl-B, -I). | J2–J12 |
| **P5 Session** | (a) Log out in a second tab mid-edit, then Save → expect a stash plus a `?next=` round trip. (b) Log out mid-upload on Media → expect a bare `/login` (known; #305). (c) Open an admin URL from a link in another app or site (the session cookie is `SameSite=Strict`, `uploader/src/authn.ts:24-31`). Record whether the session is used. | H8, H14 |
| **P6 Photo formats and limits** | For each special file and acquisition path, record client name/type/byte size, whether any `/upload` request starts, HTTP result if one exists, actual stored format/extension and media status/reason. **Oversized where determinable: no upload request, clear refusal.** Known unsupported formats need clear pre-upload refusal where determinable; accepted files must exercise the actual image's decoder and visibly reach `ready` or terminal failure. Capture transfer completion separately from readiness, including the intermediate `processing` state if observed; never infer encoding success from 2xx or a queue label. Server validation remains authoritative. | H6, H7 |
| **P7 Storage persistence** | iOS: leave an unsaved stash, do not open the admin for 8 days, then reopen. Optional, because it takes long. Record whether the stash survived. | H13 |

### 5.4 Child acceptance that the phone run cannot replace

- **#301 permissions:** as author, media/folder deletion remains unavailable; preserve automated
  route authorization coverage proving direct deletion requests are refused and records survive.
  Do not change the admin-only routes. Preserve Media dirty guards.
- **#301 desktop:** retain desktop drag-and-drop and multi-select behavior, with Media DOM/queue
  regression coverage and desktop evidence. A phone result does not establish either.
- **#302 lifecycle:** add behavioral regression coverage for `visibilitychange`/`pagehide` stashing
  and recovery of final edits in `editor-dom.test.ts` or the DraftGuard VM coverage in
  `admin-pages.test.ts`. Preserve tab isolation, user scoping and `markClean` generation semantics.
- **#302 desktop:** keep editor DOM, linter and review consumer-visible regressions covered.
  Adapt behavioral tests to approved changes; remove incidental wording/implementation assertions,
  not meaningful checks. No mobile-only editor, desktop restyle or weakened publish gate/permission.
- Implementation owners run the affected full suites, uploader typecheck and applicable
  Postgres/site checks required by the issues, plus desktop and agreed physical-device smoke.
  This documentation-only correction runs none of them and makes no implementation-pass claim.

## 6. Candidate findings register (hypotheses, not findings)

No row is a confirmed device finding. "Proposed owner" is the attribution if the device run
confirms the row (§7).

| ID | Hypothesis | Evidence so far | Device test | Proposed owner if confirmed |
|---|---|---|---|---|
| H1 | Preview calls `window.open` only after `await doSaveDraft()`, so a browser may treat it as an unrequested popup. | `[STATIC]` `uploader/public/editor.html:1803-1807`. | P1, J10 | **#302** |
| H2 | Draft stashing relies on a 5 s debounce plus `beforeunload`; there is no `pagehide`/`visibilitychange` stash. A tab killed in the background loses up to the last 5 s of typing, or everything since the last stash. | `[STATIC]` `draft-guard.js:44` (default `debounceMs` 5000; `editor.html:594-604` passes none), `:186-191` (the only lifecycle listener). `uploader/public/` has no `pagehide` listener; the only `visibilitychange` is the GPX notice in `editor-gpx.js:495`. | P2, J11 | **#302** (lifecycle stash). Key shape and user isolation stay with **#306** (§7 sequencing). |
| H3 | EasyMDE uses `contenteditable` on a mobile UA, and CodeMirror 5 touch selection and autocorrect may misbehave. The toolbar (9 buttons, 3 separators) may wrap rather than overflow at 320. | `[STATIC]` `easymde.js:2205` (UA-detected `inputStyle`); `editor.html:563-576`; toolbar `flex-wrap: wrap` at `admin.css:1240-1251`. | J6, P4 | **#302** |
| H4 | The shell is `100dvh` with one inner scroll container and a sticky command bar. The viewport meta sets no `interactive-widget`, so the keyboard is expected to shrink only the visual viewport `[INFERENCE]`. The command bar or the active field may then sit under the keyboard or pan away. | `[STATIC]` `admin.css:1373-1379`, `:2094-2097`; `editor.html:5` (`width=device-width, initial-scale=1` only). | P3 | **#302** (editor); **#301** for the Media detail panel |
| H5 | Inputs render at 14 px (`0.875rem`); iOS Safari zooms on focus below 16 px, shifting the layout and causing horizontal panning. | `[STATIC]` `admin.css:163-174` (no coarse-pointer font override; `:72-74` changes only heights). `[INFERENCE]` for the zoom. | J1, J5, J6 | **#302**: shared `admin.css`, landed once; #301 rebases. It is a documented-token change, so `DESIGN.md` is updated with the fix. |
| H6 | An HEVC HEIC that reaches the server untranscoded passes the `/upload` probe, is stored as `-orig.avif`, then fails encoding with code `encode_failed`. | `[HOST]` See §6.1. `[STATIC]` probe and classification: `pipeline.ts:31-33,112-120`, `server.ts:487-497`, `encode-queue.ts:157-158,200`. **Open:** whether iOS/Android hand the page HEIC or a JPEG. | P6 | **#301** (refuse clearly before or at upload; the terminal state is visible) |
| H7 | No client-side size check: a > 25 MiB photo transfers fully, then the server answers 413. The visible reason is whatever the 413 body's `error` says. | `[STATIC]` `media-api.js:174-200` (no `file.size` check, no XHR timeout); `server.ts:322-324`. | P6 | **#301** |
| H8 | A 401 on Media goes to `/login` with no `?next`, so the author lands on the Desk afterwards. | `[STATIC]` `media-browser.js:42`, `media-picker.js:67`. | P5(b) | **#305** (already decided in #301 *Out*) |
| H9 | A locked screen or backgrounding mid-upload fails XHRs with `network error` even when the server may have stored the file. `retryFailed()` then re-sends every failed item. | `[STATIC]` `media-api.js:196,290-295`. `[INFERENCE]` for the iOS suspension behaviour. | J4 | **#305** (outcome-unknown); **#301** for the "keep this tab open" copy |
| H10 | A local AI provider configured as `http://localhost:…` (or plain HTTP from an HTTPS admin) is unreachable from a phone. | `[INFERENCE]` from the browser-direct design (CLAUDE.md §4) and mixed-content rules. | J5 | **#301** for a reproduced failure of configured AI or unclear/hanging feedback. Optional unconfigured AI needs no waiver. |
| H11 | `env(safe-area-inset-*)` paddings evaluate to 0 because `viewport-fit=cover` is not set, so notch handling is the browser's letterboxing. | `[STATIC]` `admin.css:2737,2776-2777,2880`; viewport meta above. | J2, P3 landscape | **#302** only if observed overlap violates a requirement. Working letterboxing needs no exception. |
| H12 | Dynamic Type does not change the admin's text. | `[INFERENCE]` (§4 DT). | DT run | Record actual scaling/usability; **#302** if a demonstrated result violates the agreed scaling/accessibility requirement. Lack of this optional mechanism alone is not a waived requirement; T200 still needs proof. |
| H13 | iOS Safari's 7-day cap on script-writable storage can delete a DraftGuard stash after a week without a visit. | `[EXTERNAL]` [WebKit: Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) (cap on all script-writeable storage). | P7 (optional) | **#304** "Limits" section / **#306** `docs/authoring-workflow.md` |
| H14 | Entering the admin from a link in another site or app may not send the `SameSite=Strict` cookie on that first navigation. | `[STATIC]` `authn.ts:27`. `[INFERENCE]` for each browser's same-site classification of the navigation. | P5(c) | Record navigation/recovery behavior. Expected secure-cookie behavior needs no waiver; attribute only a demonstrated unmet requirement. Not phone-specific; weakening the cookie is out of scope. |
| H15 | 44 px coarse-pointer controls meet SC 2.5.8, but icon-only or `--control-h-sm` buttons with fixed sizes outside the token may not. | `[STATIC]` `admin.css:72-74`. Not measured. | J2–J12 (tier B measurement first) | Whichever of **#301**/**#302** owns the page |

Documentation discrepancy found while drafting (not a phone finding): `PRODUCT.md` says "WCAG 2.1
AA minimum". `CLAUDE.md` (*Accessibility*) is authoritative and targets **WCAG 2.2 AA**, which this
note and #300/#302 (SC 2.5.8) use. `PRODUCT.md` is **stale** on this point. Aligning it is a
separate documentation change, not an owner decision.

### 6.1 Host reproduction behind H6 (`[HOST]`, not a device result)

- **Setup:** on the drafting Mac (`darwin-arm64`), using the repository's installed `sharp` 0.35.3
  (libvips 8.18.3, libheif 1.23.1, `aom` present, no HEVC decoder listed).
  `sharp.format.heif.input.fileSuffix` is `[".avif"]`.
- **Fixture:** a 640×480 JPEG generated with sharp and converted with macOS
  `sips -s format heic`. `file` reports "HEIF Image HEVC Main or Main Still Picture Profile".
- **`metadata()` (as in `probeImage`):** succeeds, with `format: 'heif'`, `compression: 'hevc'`,
  640×480. By `pipeline.ts:118-119` the probe's extension is therefore `avif`.
- **Resize + `.webp()` encode (as in `encodeVariant`):** throws
  "heif: Error while loading plugin: Support for this compression format has not been built in".
  That message does not match the `decode_failed` pattern at `encode-queue.ts:157`, so it would
  be recorded as `encode_failed` (`[STATIC]` reading, not run through the queue).
- **Limits:** the container's Linux sharp build was not checked; it is `[INFERENCE]` that it
  matches the darwin prebuilt's codec set. The run did not go through `/upload` or the encode
  queue. Whether a phone ever sends HEVC HEIC to `accept="image/*"` (`media.html:23`) is exactly
  what P6 must establish.

## 7. Attribution rules (every finding lands in exactly one place)

| Area | Owner |
|---|---|
| Media page: file picker, upload queue display, refusal copy, size/format pre-checks, the Media detail panel and its keyboard behaviour, Media AI on a phone | **#301** |
| Editor: command bar, locale tabs, EasyMDE, media/gallery pickers in the editor, Story details drawer, Preview, Publish/gaps bar, the lifecycle (`pagehide`/`visibilitychange`) stash | **#302** |
| Lost or ambiguous responses (save, upload), 401 mid-batch, `?next` on Media | **#305** (epic #303) |
| Stash keys, user scoping, offline signals, stale-tab conflicts, storage-limit documentation | **#306** / **#304** "Limits" (epic #303) |
| Shared shell/`admin.css` tokens (e.g. H5) | The first of #301/#302 to land (default **#302**); the other rebases |
| A demonstrated unmet acceptance/support requirement or required cell unavailable after documented attempts, which the owner elects to leave unresolved | **Explicit owner exception record** here: precise waived requirement/cell, evidence and substituted coverage, reason, risk, compensating controls, approver, review/expiry date, device/build and date. Not a pass. Passing behavior, unconfirmed hypotheses, optional unconfigured AI and out-of-support observations need no waiver. |

Sequencing (from #299/#302/#306): whichever of #302 and #306 lands second rebases onto the other's
`draft-guard.js` invariants (#138 tab keys, #22 `markClean` generations, #306 user scoping). The
same rule applies to #301 and #306 on `media-browser.js`.

## 8. Test environment, trust boundaries and misuse

- **Never production, never owner content.** A disposable database and `/data`, and the two audit
  accounts. Nothing is restored from a production dump.
- **Reachability.** Compose publishes only `127.0.0.1:3000` (`docker-compose.yml:15`; #108), so a
  phone cannot reach a default stack. **Do not edit `docker-compose.yml` for the audit.** The
  choices are:
  1. **Recommended:** a disposable instance behind TLS at a test hostname (e.g. a staging
     reverse proxy). This keeps parity with production: a secure context, and a `Secure` cookie,
     because `trustProxy: 1` (`server.ts:189`) reads `X-Forwarded-Proto`.
  2. **Local TLS reverse proxy on a trusted LAN**, using an existing owner-provided proxy/tool
     and a certificate trusted by both phones (temporary local CA installed only with permission).
     Terminate HTTPS there and forward to the disposable app bound to **loopback**, not
     `HOST=0.0.0.0`. Fastify's bare dev listener is HTTP; installing a CA alone does not add TLS.
     Keep exactly the trusted one-hop proxy contract: preserve the intended host, replace
     client-supplied forwarded headers, and set `X-Forwarded-Proto: https`. Verify the served
     origin is a secure context and the session cookie is Secure. Do not expose the backend or
     Postgres to the LAN. Remove temporary phone CA trust/certificates and stop the proxy/app
     after the audit. This proposes no new app dependency or purchased service.
  3. Plain HTTP on the LAN is acceptable **only for non-gating smoke**. It is not a secure context
     (e.g. `crypto.randomUUID` is absent, so `draft-guard.js:29-31` takes its fallback), and the
     cookie is not `Secure`, so its results can differ from production.

  In every case `PUBLIC_BASE_URL`/`IMG_HOST` must name the host the phone uses, or variants will
  not load (`main.ts:76-79`). The LAN-exposed instance is stopped when the run ends.
- **Remote inspection** (a manual tool, not a dependency): Safari Web Inspector from the Mac for
  the iPhone (Settings → Safari → Advanced → Web Inspector), and `chrome://inspect` over USB for
  Android. These read the §4/§9 numbers and the P6 file metadata. No probe code is added to the
  app.
- **Location privacy in evidence.** The admin Media detail shows GPS for admins
  (`media-browser.js:298-310`). Fixture photos are taken with location off or at a non-sensitive
  place, and every screenshot is checked for GPS, usernames and URLs of non-test hosts before it
  is attached to the issue.
- **Credentials.** The audit passwords are generated, never typed on camera, and never pasted
  into the issue. If AI is exercised, the provider key is a disposable one and is never shown in
  a screenshot (Settings shows presence only).
- **Misuse to avoid:** raising the 25 MiB cap, disabling rate limits, or toggling auth to "get
  through" a step. A blocked step **is** the finding.

## 9. Evidence record (one per matrix cell result and one per finding)

| Field | Example / rule |
|---|---|
| `id` | `F-300-07` (finding) or `R-A-iOS-W390-T200-author` (cell run) |
| `date`, `tester` | ISO date; who ran it |
| `tier` | A / B / C. Only A can pass a cell. |
| `device`, `os_build` | Actual hardware model and full installed OS build; unknown until execution |
| `browser_build` | Actual installed browser/version/build; vendor release references are not device evidence |
| `role` | author / admin |
| `viewport` | `innerWidth×innerHeight`, `visualViewport.width×height` (keyboard closed **and** open), `devicePixelRatio` |
| `text_setting` | Actual control/value; before/after root and representative text measurements, viewport changes and any unscaled controls |
| `input_mode` | touch / BT keyboard (model) / both |
| `network` | Wi-Fi / cellular / throttled (profile) |
| `app_build` | Commit SHA or image tag of the disposable instance, and the environment option from §8 |
| `fixture` | FX-300 item ids, client-observed byte formats/sizes and actual decoder result; ST-300 fields, slugs, photo keys, language policy and public served URLs |
| `step` | J-step or P-probe |
| `expected` / `actual` | Short, concrete |
| `repro` | Numbered steps from a fresh sign-in |
| `frequency` | n of m attempts |
| `artifacts` | Screenshot/recording links **on issue #300** (never committed) |
| `severity` | blocker (journey cannot finish) / major (finishes with a workaround) / minor / cosmetic |
| `wcag` | SC number if applicable (e.g. 2.5.8, 1.4.4, 1.4.10, 2.4.7, 2.4.11) |
| `hypothesis` | H-id, or "new" |
| `attribution` | #301 / #302 / #305 / #306 / #304-Limits / exception (record id) |

**Matrix pass rule (proposal):** each exact platform × width × text cell passes only with
physical-device evidence against trusted TLS completing J1–J12 for both roles and both input
modes, including actual served-story proof for admin and demonstrated stash recovery. Any
applicable unmet requirement keeps it failed/open until fixed and re-verified. An owner exception
is recorded as **accepted with exception**, never relabelled as an observed pass. Missing native
scenarios remain open; supplemental/emulated runs never fill them. Child desktop, permissions
and automated coverage (§5.4) are separate gates. #299 may close only after #301/#302 satisfy
their acceptance and every required cell is passed or explicitly accepted with a scoped exception.

## 10. D2: acceptance harness, automation dependency versus documented manual run

| Option | Pros | Cons |
|---|---|---|
| **A. Documented manual run (recommended)** | No new dependency. Real devices are required anyway for H1, H2, H4, H5, H6, H9 and H13, none of which emulation reproduces. The evidence fields above make runs repeatable. | Human time per run. No CI regression signal for layout. |
| B. Add `@playwright/test` as an uploader dev dependency (Chromium mobile emulation + Playwright's WebKit build in CI) | Catches layout overflow, target-size and focus-order regressions at 320/390 on every PR. | A large new dev dependency with browser binary downloads in CI (Dependency Integrity review: provenance, lockfile, CI time). Playwright's WebKit is not iOS Safari. It needs a Postgres-backed app in CI. It still cannot close any tier-A gate. |
| C. Manual now, automation on a trigger | Defers cost until it is justified. | Needs a written trigger. |

**Recommendation: A, with C's trigger:** revisit B if a phone-layout regression reaches `dev`
after #301/#302 have passed the matrix, or if the matrix is run more than about quarterly. Tier B
emulation smoke from a managed browser (no repo dependency) is an optional pre-check before each
tier-A run.

**Not proposed for this harness:** Appium/custom WebDriver infrastructure (a separate capability,
maintenance and dependency decision). Cloud real-device testing remains the optional authorized
choice in §3, not a production-policy violation. Committed binary screenshot goldens remain
prohibited by Golden Rule 5; evidence attaches to the issue.

## 11. Tier-B pre-check the parent agent can run (no repo change; results labelled `[EMULATED]`)

1. A disposable instance per §8 option 1 or 2 (or loopback for a managed browser on the same
   host), with the two audit accounts.
2. Emulate 320×640 @2x and 390×844 @3x, touch enabled, a mobile Safari UA, then repeat with an
   Android Chrome UA (the UA changes EasyMDE's branch).
3. On Login, Desk, Posts, Editor (both tabs, drawer open), Media (grid, detail, upload queue),
   media picker and gallery picker, check `document.documentElement.scrollWidth > innerWidth` and
   every scroll container for horizontal overflow.
4. List every visible interactive element whose bounding box is under 24×24 CSS px (SC 2.5.8) or
   under 44×44 (the coarse-pointer token).
5. Tab through each page and screenshot the focus at each stop. Record the order and any
   invisible focus.
6. Repeat 3–5 with the default font size doubled (§4 T200 tier-B column).
7. Preview: click once normally and once with the save throttled to over 10 s. Record whether
   Chromium blocks the popup. This says nothing about Safari.

Tier-B results can confirm layout-class hypotheses (H3 toolbar wrap, H15) as **candidates for
device confirmation**. They cannot close H1, H2, H4, H5, H6, H9, H10, H12, H13 or H14.

## 12. Compatibility and rollback

Documentation only: no route, slug, schema, `/data`, dependency or runtime change. Rollback is
reverting this file. After approval, a one-line pointer in `DESIGN.md` *Admin authoring* naming
the supported phone browsers and linking here is proposed. It is **not** applied before
approval. Behaviour documentation for #301/#302 fixes waits for their own device smoke.

## 13. Owner decisions (APPROVAL PENDING)

- **D1 Support matrix (owner decision).** Approve current stable iOS Safari plus Android Chrome
  with exact installed builds recorded per run, or name the supported range. Approve or change
  the proposed exclusions (iPad, Firefox, Samsung Internet, in-app/home-screen browsers) and
  non-gating landscape spot check. No vendor version above is asserted to be installed.
- **D2 Harness (owner decision).** Choose documented manual evidence (recommended A with C's
  revisit trigger), a reviewed automation dependency, or another named approach. Nothing here
  authorizes installing a dependency. If cloud hardware is desired, separately authorize the
  provider/account/cost/data handling and establish which real-device scenarios it supports.
- **D3 Measurement within D1.** Approve the exact measured 320/390 × normal/200% contract in §4
  and the proposed measurement method after device capabilities are established. Which effective
  text-enlargement control will be used on each platform? A page-zoom result at a different width
  is supplemental, not a pass. If documented attempts cannot establish a required combination,
  supply suitable access/methods or explicitly accept that specific gap with §7's exception fields.
  No unreachable combination is assumed, and no substitution is approved by this note.
- **D4 Execution prerequisites (not a new product design).** Arrange physical iOS/Android access,
  Bluetooth keyboard, human operator, remote inspection, disposable credentials/fixtures and a
  trusted-TLS disposable instance via staging or a local TLS proxy (§8). Establish an effective
  measured slow-save mechanism. A reachable test AI provider is needed only for configured AI
  coverage. No device/service/operator access or runtime verification is claimed here.
- **D5 Conditional exceptions only.** After a result demonstrates an unmet agreed requirement
  (or documents a required unavailable cell), decide fix/provide access versus a scoped exception.
  H10/H11/H12/H14 do not require pre-emptive approval or waivers. Preserve expected security
  behavior, passing layout and optional unconfigured features without inventing defects.

## 14. Mapping to #300's acceptance

| #300 acceptance item | Where it is satisfied |
|---|---|
| Findings name device, browser, viewport, text size and repro | §9 record. Filled **only** by the tier-A run, which has not happened. |
| Matrix written and approved; both decisions recorded in the issue and in-repo | §3/§4/§10 (written), §13 (pending). This file is the dated in-repo note. |
| Each finding assigned to #301, #302 or the resilience epic, or accepted | §6 proposed owners, §7 rules. "Accepted" means an owner exception record, never a default. |
