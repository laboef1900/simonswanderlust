# G5 physical-device test script — mobile acceptance matrix (#300, #301, #302)

Date: 2026-11-01. Companion to
[`docs/superpowers/specs/2026-10-27-mobile-acceptance-matrix-design.md`](../specs/2026-10-27-mobile-acceptance-matrix-design.md)
(the spec defines the matrix, the measurement rules, the hypotheses and the evidence record; this
file is the operator's run sheet). Gate **G5** of the held-PR plan: the owner supplies the
devices, keyboard, operator and TLS instance; nothing here can be executed by an agent.

Status: **NOT EXECUTED.** No row below has a result. Nothing in this document is a device
observation.

## 0. Prerequisites the owner must supply (the G5 request)

| Item | Requirement | Record in the run log |
|---|---|---|
| iPhone | Current stable iOS major (27 at writing), Safari. Any model whose controls can reach the §4 widths; a notch/Dynamic-Island model preferred for the safe-area probe. | Model, `Settings → General → About → iOS Version` (full build), Safari build from `about:` is not shown on iOS: record the iOS build. |
| Android phone | **Waived until 2027-05-01 (spec §13.1, E1).** When available: owner-approved OS version, current stable Chrome. | Model, `Settings → About phone → Build number`, Chrome `chrome://version` (full version string). |
| Bluetooth keyboard | Any; must pair with both phones. | Make/model. |
| USB cables + the Mac | Safari Web Inspector (iPhone: `Settings → Safari → Advanced → Web Inspector` on; Mac Safari `Develop` menu). Android: `chrome://inspect#devices` in desktop Chrome with USB debugging on. | — |
| Disposable instance behind **trusted TLS** | Spec §8 option 1 (staging hostname) or option 2 (LAN proxy + a CA both phones trust). Plain HTTP is ruled out (spec §15). | Hostname, the environment option used, the app build (`git rev-parse HEAD` of the checkout or the image tag). |
| The build under test | Whichever `dev` or feature build the owner names — for the implementation checks, the heads of PR #500 (#301 Media) and PR #501 (#302 editor), or `dev` once they merge. The run is valid against any build but **the SHA goes into every evidence record** (`app_build`). The PRs' audit notes (`docs/superpowers/specs/2026-11-01-phone-media-upload-audit.md`, `2026-11-01-phone-compose-audit.md`) list their own device rows. | SHA / tag. |
| Two audit accounts | `audit-admin` (admin) and `audit-author` (non-admin). Generated passwords ≥ 12 chars, never the owner's, never typed where a camera records. | Usernames only. |
| Time | Roughly 2.5 h per gating cell (J1–J12 × 2 roles × 2 input modes), 8 gating cells, plus probes and the DT run. Plan two sessions per platform. | Dates. |

If any prerequisite is missing, stop and record the gap: a missing prerequisite keeps every
dependent cell **open** (spec §4, D4). Never substitute emulation, an iPad, or a width "close to"
320/390.

## 1. Bring up the disposable instance

Run from a checkout of the build under test, on a host that the TLS proxy forwards to. All
directories are a fresh `mktemp -d`; the database is a fresh, empty one that you create for the
run and drop afterwards. **Never** point `DATABASE_URL` at the production database and never
restore a production dump.

```bash
# 1. Fresh Postgres database (any Postgres 18; name it for the run)
createdb audit300_<date>

# 2. Native addon + vendored assets (gitignored, needed by the runtime)
cd uploader && npm ci && npm run build:native \
  && node scripts/copy-fonts.mjs && node scripts/copy-easymde.mjs \
  && node scripts/copy-vendor.mjs && node scripts/copy-legal.mjs uploader
cd ../site && npm ci && cd ../uploader

# 3. Runtime (loopback only; the proxy is the sole ingress)
RUN=$(mktemp -d)
DATABASE_URL='postgres://…/audit300_<date>' \
PUBLIC_BASE_URL='https://<test-image-hostname>' IMG_HOST='<test-image-hostname>' \
STORAGE_DIR="$RUN/images" SETTINGS_PATH="$RUN/settings.json" \
SITE_DIR="$RUN/site" BACKUP_DIR="$RUN/backup" SITE_APP_DIR="$(pwd)/../site" \
PORT=14300 HOST=127.0.0.1 TRUSTED_PROXY=loopback \
node --import tsx src/main.ts
```

- A public test instance needs **two names**: the app serves the blog on the image host only
  for loopback (`server.ts` `imgHostServesBlog`), so with one public name the blog would 404.
  Set `PUBLIC_BASE_URL`/`IMG_HOST` to the image name and open the blog/admin on the other name;
  both are proxied to the same port. The owner's names are in §1a.
- `TRUSTED_PROXY=loopback` means the TLS proxy must run on the same host and forward to
  `127.0.0.1:14300` with `X-Forwarded-Proto: https`, replacing any client-supplied forwarded
  headers. (Option 1 via the compose stack uses `docker-gateway` instead; do not edit
  `docker-compose.yml`.)
- Wait for `GET /health` → 200 **through the proxy** from the Mac, then from one phone.
- Verify the secure context from the phone (remote inspector console): `isSecureContext === true`
  and `typeof crypto.randomUUID === 'function'`. Record both. Without them the run is invalid.
- Create the accounts (from the Mac, through the proxy):

  ```bash
  curl -sS https://<test-blog-hostname>/setup -H 'content-type: application/json' \
    -d '{"username":"audit-admin","password":"<generated>"}'
  # then, signed in as audit-admin (cookie jar):
  curl -sS -b jar -c jar https://<test-blog-hostname>/login -H 'content-type: application/json' \
    -d '{"username":"audit-admin","password":"<generated>"}'
  curl -sS -b jar https://<test-blog-hostname>/users -H 'content-type: application/json' \
    -d '{"username":"audit-author","password":"<generated>","isAdmin":false}'
  ```

- Check the session cookie on the phone after J1 has the `Secure` attribute (inspector →
  Storage/Application → Cookies). Record it.
- At the end: stop the proxy and the app, `dropdb audit300_<date>`, `rm -rf "$RUN"`, remove any
  temporary CA from both phones.

## 1a. Disposable instance on the owner's server (decided 2026-11-01)

Blog/admin `https://new.simonswanderlust.com`, images `https://img.new.simonswanderlust.com`,
both with certificates the iPhone trusts, both proxied by the server's existing reverse proxy to
a **separate** loopback port. Production's project, `uploader/data`, `pgdata`, port 3000 and
`.env` are never touched. Images are built on the Mac and copied over, not built on the server.

```bash
# On the Mac, from a checkout of the build under test (dev after #500/#501, or #490's head for G3):
SHA=$(git rev-parse --short HEAD)
docker build --platform linux/<amd64|arm64 = the server's arch> -t ghcr.io/laboef1900/wanderlust-studio:g5-$SHA .
docker save ghcr.io/laboef1900/wanderlust-studio:g5-$SHA | ssh <server> docker load
scp docker-compose.yml <server>:/srv/swl-g5/docker-compose.yml   # a NEW directory

# On the server:
cd /srv/swl-g5 && mkdir -p uploader/data && sudo chown -R 1000:1000 uploader/data
sed -i 's/127.0.0.1:3000:3000/127.0.0.1:14300:3000/' docker-compose.yml   # never production's port
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
PUBLIC_BASE_URL=https://img.new.simonswanderlust.com
IMG_HOST=img.new.simonswanderlust.com
IMAGE_TAG=g5-<sha>
EOF
chmod 600 .env
docker compose -p swl-g5 config --quiet && docker compose -p swl-g5 up -d
curl -fsS http://127.0.0.1:14300/health
```

Proxy: add `new.simonswanderlust.com` and `img.new.simonswanderlust.com` → `127.0.0.1:14300`
with the same headers as production (Host preserved, `X-Forwarded-Proto`/`X-Forwarded-For`
overwritten, 25 MB bodies, read timeout above 900 s). Leave Settings → Site identity → Public
domain **unset**, so the instance is `noindex` with `Disallow: /`. Then continue with the account
creation above, using `https://new.simonswanderlust.com`.

Teardown after the runs: `docker compose -p swl-g5 down -v` **inside `/srv/swl-g5` only** (the
`-p swl-g5` project owns that test volume), `rm -rf /srv/swl-g5`, remove both proxy routes and
DNS names. Never run `down -v` in production's directory.

## 2. Fixtures

### FX-300 photos (spec §5.1)

Assemble on each phone **before** the run; location services off for the camera, or a
non-sensitive place. Record every item's client-side `name`, `type`, `size` (from the
inspector: `document.querySelector('#fileInput').files` after selection) in the run log.

| Id | What | How to make it |
|---|---|---|
| FX-01…08 | Ordinary camera JPEGs | Shoot 8 photos. iPhone: `Settings → Camera → Formats → Most Compatible` for these. |
| FX-09 | HEIC | iPhone: switch to `High Efficiency`, shoot one. Android: transfer FX-09 from the iPhone (AirDrop/USB) into the Gallery **and** into Files. |
| FX-10 | > 25 MiB | A large panorama, or on the Mac: `sips -s format jpeg -s formatOptions 100 <big.tif> --out fx10.jpg` until `ls -l` shows > 26 214 400 bytes; transfer to both phones' Files **and** Photos. Confirm the on-device size before the run. |
| FX-11 (Android only) | HEIF from the Android camera if offered; "Ultra HDR" JPEG if the device produces one | Record whether the camera offers either. If not, mark the row not available (not failed). |

### ST-300 story

Prepare the text on the Mac and keep it in a plain note on each phone for copy/paste checks; the
typing steps still require actually typing. Per run choose **unique** slugs
(`audit-300-<date>-<cell>` DE, `audit-300-<date>-<cell>-en` EN) and record the translation key
once created. Fields per locale: title, slug, excerpt, country name, three short paragraphs; one
hero (FX-01) with locale-specific alt; two inline photos (FX-02, FX-03) and one gallery (FX-04,
FX-05, FX-06) with locale-specific alt and captions. Shared fields: a valid date, ISO country
code, a supported region, finite coordinates of a public landmark, key facts in both locales. If
the build under test runs a single-language mode, complete the locales that mode requires and
record the mode (spec §5.1); a bilingual run is still required for #300's DE/EN coverage.

## 3. Measuring the cell before every run (spec §4)

In the remote inspector console, with the login page open and the keyboard closed, then again
with a text field focused and the keyboard open:

```js
({ iw: innerWidth, ih: innerHeight, vw: visualViewport.width, vh: visualViewport.height,
   dpr: devicePixelRatio, root: getComputedStyle(document.documentElement).fontSize,
   body: getComputedStyle(document.body).fontSize,
   input: getComputedStyle(document.querySelector('input')).fontSize })
```

| Cell | How to reach it | Pass condition for the **measurement** |
|---|---|---|
| W390 | iPhone: a model whose Standard display zoom reports `innerWidth === 390`; Android: `Settings → Display → Display size` until `innerWidth === 390`. | `iw === 390` recorded. Any other width (375/384/393/402/412…) is a supplemental run, labelled as such. |
| W320 | iPhone: Display Zoom "Larger Text"/zoomed on a small model, or no path; Android: largest display size. | `iw === 320` recorded. If unreachable, **the cell stays open**; record every width you could reach. |
| T200 | iOS: `Settings → Accessibility → Display & Text Size → Larger Text` (with "Larger Accessibility Sizes"), and separately Safari page zoom (`AA` menu). Android: `Settings → Display → Font size` maximum, and separately Chrome `Settings → Accessibility → Text scaling 200%`. | Measured `body`/`input` font sizes **and** a representative rendered control (screenshot with a ruler overlay, or `getBoundingClientRect()` of the Save button text) reach 2× the W-cell baseline **while `iw` still equals 390 or 320**. A doubled root alone, or a 200% label, is not evidence. If zoom changed `iw`, record it as a supplemental zoom run. |
| DT (non-cell) | iOS Larger Text at the largest accessibility size; Android font size maximum. | Record what scaled, what did not, and whether J1–J12 remained usable. Informational. |

Record the full object for each (platform × width × text × keyboard state) in the run log.

## 4. The journey, per gating cell

Order: for each platform, for each of W390, W390+T200, W320, W320+T200: run as **author**
(touch), as **author** (Bluetooth keyboard), as **admin** (touch), as **admin** (Bluetooth
keyboard). Admin runs include J12 publish; author runs confirm Publish is absent. Reuse the
same ST-300 draft across the four role/input runs of one cell; create a fresh one per cell.

For every row capture: one screenshot per step (named `<cell>-<role>-<input>-J<n>.png`), the
measured focus order for keyboard runs (list the `document.activeElement` summary at each Tab
stop from the inspector), and the bounding boxes of every control you touch
(`el.getBoundingClientRect()`; flag any under 24×24 CSS px, note any under 44×44). Screenshots
are attached to issue #300, never committed.

| Step | Action | Record | PASS iff |
|---|---|---|---|
| J1 | Open `/login`, sign in (try the password manager). | Layout zoom on focus? Horizontal scroll? Cookie `Secure`? | Signed in, no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`), no persistent focus zoom. |
| J2 | Open the navigation drawer, go to Media, close the drawer (Escape with keyboard, scrim by touch). | Focus trap, close methods, focus return; every control's box. | All controls reachable; all ≥ 24×24; drawer closes both ways and returns focus to its opener. |
| J3 | Media: select FX-01…10 from Photos/Gallery, then FX-09/10 again via Files and one shot via Take Photo. Keep the tab in the foreground. | Per file: client name/type/size, whether an `/upload` request started (inspector Network), HTTP status, final queue state and media status, the stored extension (admin: Media detail). | **Per-file outcome is visible and truthful:** FX-10 is refused with a reason (before any body transfer where the build pre-checks size; otherwise the 413 reason is shown and the row is terminal, not stuck); FX-09 reaches `ready` **or** a visible terminal failure with a reason; FX-01…08 reach `ready`; nothing stays `processing` or `unknown` after 2 min idle. Copy says the tab is kept open for transfer only. |
| J4 | Start a fresh 8-photo batch; lock the screen at ~3 files for 30 s; unlock. Repeat with an app switch for 60 s. | Which items settled, which reconciled after return, which stayed `unknown`/retryable; whether Retry re-sent files that the server had already stored (compare Media rows: duplicates?). | Recorded. (No pass/fail — #305 behaviour is observed; a duplicate stored photo after Retry is a finding for #301.) |
| J5 | Open FX-01's detail: title, DE alt, EN alt, DE caption, EN caption; Save; reopen. Do it once by touch, once by keyboard. If an AI provider is configured, tap Suggest once; otherwise mark "not exercised". | Keyboard covering fields? Save reachable? Focus visible? Values after reopen. | All five values re-read exactly; Save reachable with keyboard open; focus visible at every stop. |
| J6 | Posts → New post. Type title, slug, excerpt and three paragraphs in DE, then switch to EN and repeat. | Keyboard overlap with the active field and the command bar; selection handles; autocorrect damage; toolbar wrap at 320. | Text lands in the intended locale and field, by touch and by keyboard; no field is unreachable under the keyboard. |
| J7 | Per locale: pick the hero, enter alt; insert two inline photos; insert a three-photo gallery with captions; reorder in the gallery picker. | Picker operable by touch/keyboard; resulting fence text (inspector: the textarea value). | Order and captions saved match what was chosen; fence form identical to a desktop-authored one. |
| J8 | Story details drawer: date, ISO code, region, coordinates, per-locale country and key facts; close; use the gaps bar to find anything left. | Focus trap, Escape/scrim, focus return, fields under the keyboard. | No gap remains; every field reachable with the keyboard open. |
| J9 | Save draft; reload the page. | Status text; reloaded values. | Everything from J6–J8 is present after reload (not only a "Saved" label). |
| J10 | More actions → Preview, on the normal network. Then P1 (slow save). | Popup prompt? Fallback link offered? Preview content. | Preview opens without a blocked-popup prompt **or** the build's fallback link opens it; it shows the fixture text, hero, two inline photos and gallery for each required locale. |
| J11 | Type a unique marker (`MARK-<time>`) in the body; within 2 s background the app (P2 a/b/c). Return, and separately reopen after discard. | Whether the page was still live or a new document; whether a stash was offered; the restored text. | On the discarded/reopened path the build offers recovery and accepting it restores the marker. A still-live page keeping its text does not pass this row. |
| J12 | **Admin:** resolve gaps, Publish, confirm, wait; open the public story URL for each published locale (not Preview). **Author:** confirm no Publish control exists; do not attempt `/publish` by hand. | Confirmation/gaps bar operability; publish result; the served page's text, hero, inline photos, gallery order/captions; loaded variant URLs (inspector Network). | Admin: served page matches the fixture, variants load (200). Author: Publish absent. |

**Row verdicts:** `PASS`, `FAIL` (with an F-300-nn record per spec §9), or `OPEN` (not
exercisable: missing prerequisite, unreachable cell). A `FAIL` names the hypothesis (H-id or
"new") and the proposed owner from spec §7. Never relabel `OPEN` as a pass.

**Cell verdict:** PASS only when every J row is PASS for both roles and both input modes on
physical hardware against trusted TLS (spec §9 pass rule).

## 5. Probes (once per platform, at W390 normal text unless stated)

| Probe | Procedure | Record |
|---|---|---|
| P1 slow-save preview | Throttle the test LAN (an owner-provided conditioner on the proxy host, or the Mac's Network Link Conditioner if the proxy runs there) so a Save measurably exceeds 10 s (inspector Network timing). Tap Preview. If no throttling is available, mark **blocked**. | Save duration; popup blocked / fallback shown / preview opened. |
| P2 background/discard | With an unsaved marker typed < 2 s earlier: (a) switch apps 60 s; (b) lock 5 min; (c) background, then kill the browser (iOS: app switcher swipe-up; Android: `adb shell am force-stop com.android.chrome` — record which) and reopen the same URL. For each: was `pagehide` seen (inspector: add a one-off `addEventListener('pagehide', …)` console log beforehand — in the console only, never in the app)? Was a stash offered? | Lifecycle observed, stash offered, marker restored. |
| P3 keyboard geometry | Keyboard open: focus the last drawer field, the EN title, the body's last line. Is the command bar visible? Does the page pan? Repeat with the Bluetooth keyboard (no soft keyboard) and once in landscape (non-gating). | Screenshots; `visualViewport` numbers. |
| P4 hardware keyboard | Tab through J2–J12; try Cmd/Ctrl-B and -I in the body. | Full focus order; any trap or invisible focus; whether shortcuts work. |
| P5 session | (a) Log out in a second tab mid-edit, then Save. (b) Log out in a second tab mid-upload. (c) Open an admin URL from a Notes/Mail link. | (a) stash + `?next=` round trip; (b) paused queue + sign-in banner, and whether Resume settles without duplicates; (c) whether the session cookie was sent (signed-in page vs login). |
| P6 formats/limits | Covered by J3 for each special file × acquisition path (Photos, Files, Take Photo). | Per file: name/type/size, request started?, status, stored extension, final media status + reason. |
| P7 storage persistence (optional) | iOS: leave a stash, do not visit for 8 days, reopen. | Stash survived? |

## 6. Run log template

One Markdown file per platform, attached to issue #300 (not committed), with these headers
filled from spec §9: `device`, `os_build`, `browser_build`, `app_build`, `environment option`,
`keyboard`, then one table per cell with the measurement object from §3 and the J-row verdicts,
then the probe results, then an `F-300-nn` block per failure (`id, step, hypothesis, expected,
actual, repro, frequency, severity, wcag, attribution, artifacts`).

## 7. What this script does not do

- It does not pass anything by itself; it has not been run.
- It does not change the app, add dependencies, or edit `docker-compose.yml`.
- It does not authorise cloud device services, purchases, or waivers (spec §3, §13 D2/D5).
- It does not replace #301/#302's own desktop, permission and automated acceptance (spec §5.4).
