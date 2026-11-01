# #301 phone photo upload in Media — audit, change and emulation evidence (2026-11-01)

Baseline `dev` `3a7c3ea`. Risk: **normal** (client files only; the `/upload` contract, encode
settings and EXIF allow-list are unchanged). Hypotheses are those of the mobile acceptance
matrix (#300, PR #471, §6/§15). Labels: `[STATIC]` read in code, `[HOST]` run on the dev host,
`[EMULATED]` Chromium device emulation. Nothing here is a `[DEVICE]` result; gate G5 is open.

## Audit of #301 against `dev`

| #301 item | Before this change | Evidence |
| --- | --- | --- |
| File input for library and camera | Exists: `accept="image/*" multiple`, no `capture` (so phones offer library **and** camera; `capture` would force the camera on Android) | `[STATIC]` `uploader/public/media.html` |
| Per-file outcome with a reason | Partial: queued/uploading %/done/failed/unknown per row (#305); "done" claimed completion while encoding was still pending | `[STATIC]` `media-api.js` `createUploadAttempt`, `media-browser.js` `renderQueue` |
| Refuse > 25 MiB before transfer (H7) | **Missing**: transferred fully, then 413 | `[STATIC]` no `file.size` check; server cap `fileSize: 25 * 1024 * 1024` |
| HEIC/HEIF (H6) | **Missing**: accepted, then terminal `failed` / `encode_failed` | `[HOST]` below |
| Async decode failure is terminal and visible | Exists: grid badge "failed: encode_failed", never stranded in processing | `[HOST]` below |
| "Keep the tab open while uploading, not while encoding" | Partial: one transient English status line only | `[STATIC]` `media-browser.js` `bindUpload` |
| DE/EN alt + caption by touch and keyboard, #123 dirty guard | Exists | `[EMULATED]` below; `detailDirty` guard unchanged |
| Authors cannot delete media/folders | Exists (admin-only routes unchanged) | `[STATIC]` `server.ts` `requireAdmin` on `DELETE /media/items/*`, folder routes |
| Desktop drag-and-drop / multi-select | Exists; unchanged code path (`accept()` is shared) | DOM suite |

## Change

- `media-api.js` `uploadRefusal(file)`: **HEIC/HEIF** (type `image/heic|heif[-sequence]` or a
  `.heic`/`.heif` name), a **non-image** type, or **> 25 MiB** → the file is queued as
  `refused` with that reason and **never transmitted**. A missing type or size is never a reason;
  the server stays authoritative. Refusals count separately, are final for Retry, and are
  removed by Clear finished / Clear waiting files.
- `media-browser.js`: each refused row states "Not sent: …" plus what to do instead; a
  transferred row reads "Transferred; image processing may still be running" (encoding is the
  grid badge's job); while any transfer is unsettled a warn-toned **keep this tab open** note is
  shown, and it disappears when every file has a result. All copy is in `ui.ts` (DE/EN).
- `admin.css`: queue rows wrap; a refusal/failure reason gets its own full-width line under the
  name, red repeating the words. The native file picker no longer overhangs the drop zone's
  dashed border at 320 px (measured 289 px wide in a 237 px content box; now fits).

## Evidence

- `[HOST]` H6 reproduced with the shipped sharp build: a real HEVC `.heic` (6016×6016) passes
  `metadata()` (`format: heif`, `compression: hevc`) but decoding fails ("bad seek"). Sent
  directly to `POST /upload` (bypassing the browser check) it is accepted (200, `processing`)
  and ends `failed` / `encode_failed` within 20 s — terminal and visible, as #301 requires.
- `[EMULATED]` Real app, fresh database, Chromium as a 390 px Android phone (touch, mobile UA)
  with **200 % root text** and throttled network (150 ms, 750 kbit/s up): 11 files picked at
  once — 1 HEIC, 1 PNG of 28.8 MB, 9 JPEGs. The HEIC and the PNG were refused before any
  transfer with their reasons; 9 transferred ("9 of 11 uploaded · 2 not sent"); the keep-open
  note showed during transfer and disappeared afterwards; all 9 reached `ready`. No horizontal
  overflow. At 390 and 320 px (iPhone UA, touch): a photo opened by tap, DE/EN alt and the DE
  caption typed with the keyboard and saved with Enter on Save; values persisted; focus ring
  visible (accent border + outline). Screenshots retained locally.
- Observed, not changed here: at 200 % text the masthead's **View site** button is clipped at
  the right edge on 390 px (shell, owned by #302); the detail panel's inline "Refresh" text
  button is 52×21 px — below 24 px but alone on its line, so the 2.5.8 spacing exception
  applies `[INFERENCE]`; record on device (H15).

## Device rows for G5 (from the #300 script, Media part)

On each matrix phone at 320 and 390 CSS px, normal and 200 % text, both roles:
1. Pick 10 photos (library) + 1 camera shot; every row ends Transferred / Not sent / failed
   with words; none stays "uploading" after the keep-open note disappears.
2. Pick an original HEIC (iOS "High Efficiency") — record whether the browser hands over HEIC
   (row says Not sent: HEIC/HEIF) or a JPEG (row transfers).
3. Pick a > 25 MB file (e.g. a panorama or ProRAW export) — Not sent before any progress.
4. Background the browser mid-upload, return — rows reconcile (#305) or stay Unknown; none lost.
5. Edit DE/EN alt + caption by touch and with the Bluetooth keyboard; Save; reload; values kept.
6. As author: no delete controls for photos or folders.
