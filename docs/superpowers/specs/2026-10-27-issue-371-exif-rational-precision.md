# #371 — Preserve non-reciprocal sub-unit EXIF values

**Status: OWNER-APPROVED; implemented and locally verified. Independent PR review and exact-head CI remain required.**
**Risk: High by boundary** (public EXIF writer); the reported defect is numeric correctness, not a demonstrated privacy leak.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Evidence and existing contract

The issue's generated-JPEG → `processImage` → AVIF/WebP decoder reproduction is accepted, not rerun: ExposureTime 4/5 and FNumber 19/20 become 1 and 1. `uploader/src/exif.ts:toRational` uses `1 / round(1/v)` for every positive value below one. `allowedExif` applies that helper to ExposureTime, FNumber and FocalLength; `pipeline.ts` computes the allow-list once and passes it to every `encodeVariant` call, including responsive JPEG when conversion is disabled.

`2026-07-26-media-library-and-galleries-design.md` §D1 and `SECURITY.md`'s public-image EXIF allow-list remain authoritative. The approved #347 codec upgrade is independent: use sharp 0.35.5 / libvips package 1.3.4 and its required @emnapi/runtime 1.11.3 change when integrating. Do not duplicate dependency work or roll it back.

## Approved numeric contract

Change only `toRational`'s sub-unit selection and its explanatory comment:

1. Preserve rejection of non-number, non-finite and negative input; preserve zero as `0/1`.
2. For `0 < v < 1`, calculate `den = Math.round(1 / v)`. Preserve the existing supported reciprocal denominator range `1..4_000_000`; outside it return null, not zero or a fabricated value.
3. Use `1/den` **only when `Math.abs(1 / den - v) <= 0.01 * v`** (at most 1% relative error). Otherwise emit `Math.round(v * 1000)/1000`, using the existing fixed-denominator convention. A positive input must never emit a zero numerator. This corrects 0.4, 0.6, 0.8 and 0.95 without losing short reciprocal shutter speeds such as 1/8000.
4. Preserve the existing `v >= 1` fixed denominator and numerator cap of 4,000,000,000. Do not introduce a rational library, continued fractions, tag-specific exceptions, metadata expansion or a new precision setting.

The 1% test is an explicit representation tolerance, not a promise of exact preservation of arbitrary floating-point metadata. For non-reciprocal fallback the absolute quantization error is at most 0.0005. The named issue examples have exact /1000 representations. This chooses the issue's small-tolerance proposal rather than keeping unconditional reciprocal rounding or applying /1000 to tiny shutter speeds.

Affected implementation: `uploader/src/exif.ts`; tests in `uploader/test/exif.test.ts` and `uploader/test/pipeline.test.ts`; a short SECURITY.md reconfirmation. `allowedExif`, `parseExif`, GPS extraction/redaction, format selection, queue/storage paths and `encodeVariant`'s metadata policy do not change. No public UI copy is needed.

## Trust boundaries and invariants

Untrusted photo bytes are parsed into numbers, then converted into approved public metadata. Non-finite or out-of-range values remain omitted; no raw EXIF is copied through. Keep exactly the eight approved camera tags plus ICC; no GPS IFD, XMP, IPTC, source Orientation or arbitrary new tags. Keep private originals byte-identical and private media-library coordinates under their existing authorization/redaction. The Settings quality preview continues calling the encoder without allow-listed EXIF and remains entirely EXIF-free.

No corpus rewrite, new CLI, rescan/re-encode operation, URL/key change or photo edit is authorized. Existing encoded bytes and caches do not change merely by shipping this fix; newly encoded variants use the corrected conversion.

## Required verification after approval

- Unit table: parsed rational values for 0.3, 0.4, 0.6, 0.8, 0.95 match those numbers; 0.5 remains `1/2`; 0.004 remains `1/250`; 1/8000 remains exactly `1/8000`. Test a non-integer decimal such as 0.71234 against the /1000 absolute-error bound.
- Pin the actual selection criterion: 0.4975 is within 1% of 1/2 and may emit `1/2`; 0.49 is outside and must emit `490/1000`. Include cases on both sides of the tolerance threshold to prevent a broad “approximately equal” assertion masking the original defect.
- Preserve tests for zero, negative, NaN, infinities, strings/undefined, 2.8 and 28. Pin supported tiny denominator boundary (1/4,000,000 accepted; 1/4,000,001 rejected) and the existing large numerator limit. Never encode a positive supported input as zero.
- Extend the real generated fixture pattern in `pipeline.test.ts`: JPEG with ExposureTime `4/5`, FNumber `19/20`, camera tags and GPS. Decode the input first and prove those values and GPS actually exist, avoiding a vacuous fixture. Process once with modern formats and once with `convertJpeg:false`; decode **every resulting format/width** and assert 0.8 and 0.95 numerically, GPS absent, Orientation absent/normal, and originals unchanged. Add 0.4/0.6 exposure cases and a 1/8000 round trip. Keep existing eight-tag, ICC and non-allow-listed-tag checks.
- Actual-runtime acceptance: run the decoder/encoder round-trip in the built app image on each supported Linux platform after #347, recording loaded codec versions and numeric metadata results, not image/location contents. Exercise an isolated upload/encode-queue fixture and fetch/decode its served variants to confirm the production path uses the corrected helper. No production corpus or EXIF credential/private-data reads. Existing image-preview privacy tests must remain green.
- Main implementer runs affected uploader Vitest suites and typecheck, then the full affected suite/CI. Recorded execution follows below; CI remains a separate gate.

## Recovery and owner decision

No native blocker is recorded. Merge/deployment ordering must preserve #347's approved patched codec floor; #371 is a helper/test change, not another upgrade. Coordinate shared pipeline tests when stacking.

Rollback may revert only this numeric helper change while retaining patched codecs; that restores the known cosmetic metadata error for future encodes, not a privacy permission. Prefer a forward numeric correction if verification discovers a precision regression. Never downgrade the #347 image or automatically re-encode existing originals as rollback. If malformed output appears, pause affected encoding until corrected; leave already served releases and original files intact.

## Owner approval record

- Approver/date: repository owner, interactive implementation session, 2026-10-27.
- Exact answer: **“Approve numeric correction”**.
- Approved: reciprocal notation only within 1% relative error, the existing /1000 fallback,
  decoded-output verification on both Linux architectures, and the unchanged metadata/privacy/
  format policy above while retaining #347's patched codecs.
- Not authorized: bulk metadata remediation/re-encoding, safety waivers, merge or deployment.

## Recorded verification — 2026-10-27

- Focused numeric regressions, complete uploader suite with isolated PostgreSQL, uploader
  typecheck, complete site suite, `astro check` and the site build passed.
- The unchanged production Dockerfile built for Linux arm64 and amd64. Both running apps
  loaded sharp 0.35.5, libvips 8.18.7, libheif 1.23.5 and librsvg 2.63.2.
- Each platform accepted eight synthetic JPEG uploads: four exposure values (0.4, 0.6,
  0.8, 1/8000), each with aperture 0.95, through modern and JPEG-only settings. All 24
  served variants per platform decoded with the expected numbers, dimensions and pixels.
  Camera tags remained; GPS, XMP, IPTC and the private description did not. Original bytes
  matched their inputs and original HTTP requests returned 404.
- These were Docker Desktop Linux containers, not fresh independent Linux hosts. Initial
  empty test-volume ownership caused EACCES before the smoke; setting only those synthetic
  volumes to the documented UID 1000 resolved it. No production corpus was accessed.
- Existing JavaScript dependency advisories remain assigned to #369; successful image
  builds do not assert a zero-advisory audit. #347's patched codec floor remains intact.
