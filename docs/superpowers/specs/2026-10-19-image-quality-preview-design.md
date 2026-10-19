# Image quality preview in Settings

**Date:** 2026-10-19
**Risk:** Normal — a new admin-only route that decodes an uploaded image in memory. It touches
resource limits (sharp memory under `mem_limit`) and photo metadata, so both are pinned below.
**Status:** Requested by the owner on 2026-10-19 ("upload a photo in the image settings to test
the quality settings, original and new side by side").

## 1. Why

The WebP and AVIF quality numbers (`webpQuality`, `avifQuality`) are chosen blind today. The owner
wants to try a value on a real photo and compare it with the original before saving it.

## 2. Contract

`POST /settings/image-preview` — `requireAdmin`.

- **Request:** multipart with exactly one file part `file`, plus the fields `format` (`webp` |
  `avif`) and `quality` (an integer 1–100, the same bounds as the settings). It reuses `/upload`'s
  multipart setup and per-file size limit; a second file part → 413.
- **Encoding:** `probeImage` supplies the orientation-corrected size, and the preview width is
  `min(intrinsicWidth, 1920)` — the largest standard variant width. It uses the same per-variant
  encoder as `processImage` (a shared helper in `pipeline.ts`: rotate, keep the ICC profile,
  resize without enlargement, quality), so the preview cannot drift from what Publish ships.
- **Response 200:** the encoded bytes with `Content-Type: image/webp|image/avif`,
  `Cache-Control: no-store`, `X-Preview-Width`, `X-Preview-Height`, `X-Original-Width` and
  `X-Original-Height`.
- **Errors:** an undecodable image → 400 "Could not read that image."; an invalid format or
  quality → 400 with a fixed message; a concurrent preview → 429.

## 3. Invariants

- **No persistence:** nothing is written to `/data` or Postgres, and no filename is logged.
- **No metadata out:** the preview carries no EXIF at all (no `withExif`/`withMetadata`). An
  uploaded original's GPS never leaves the request.
- **Memory:** the encode runs under `workLock.runShared`, so a site build preempts it exactly as
  it preempts the encode queue and imports (#95). It is also single-flight per process, so at
  most one preview's pixels are live.
- **Scope:** admin-only, like the image settings it serves.

## 4. UI

The Images tab gets a **Compare quality** section: a photo picker, a WebP/AVIF choice, and
**Preview**, which sends the current, possibly unsaved, quality for that format. The original
(a local object URL) and the result are shown side by side in equal boxes. Each is captioned with
format, pixel size and file size; the result also shows the saving against the original. A
**1:1 pixels** toggle shows both at natural size, scrolling together, with the original drawn at
the preview width. Nothing is saved; the existing **Save image settings** still decides.
