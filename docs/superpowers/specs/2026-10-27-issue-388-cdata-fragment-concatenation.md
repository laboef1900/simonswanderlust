# Concatenate WXR CDATA fragments literally — issue #388

**Date:** 2026-10-27  
**Status:** OWNER APPROVED 2026-10-28 — separator-free scalar CDATA fragment concatenation with unchanged parser policy. Implementation and verification remain required; no existing-content repair or deployment is authorized.
**Risk:** High — WXR parsing and persisted content.  
**Baseline:** `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Root cause and bounded change

WordPress escapes a literal `]]>` by closing and reopening CDATA. The issue's
supplied parser reproduction is accepted evidence: with the existing
`fast-xml-parser` configuration, split CDATA becomes an array in `__cdata`.
`uploader/src/wxr-parse.ts:10–14` currently calls `String()` on that array and
inserts commas between the fragments. The same `cd()` helper extracts title,
excerpt and content, as well as the other scalar WXR fields.

Keep the parser configuration and its object shape. In `cd()`, first select the
existing scalar payload (`__cdata ?? #text ?? ''` for an object; the value itself
otherwise), then concatenate an array payload's string fragments with **no added
separator**. Scalar coercion and null/missing-field behavior stay unchanged.
This is one private-helper fix, not a new XML parser or an export repair pass.

- Preserve literal commas, spaces, newlines, brackets and all other characters
  already present **inside** fragments. Never remove commas from reconstructed
  text or trim each fragment. Keep the current parser-level trimming settings;
  this patch does not promise a new XML whitespace policy.
- Preserve the existing `__cdata` versus `#text` fallback/precedence; do not
  concatenate unrelated properties, arrays of posts/categories, or duplicated
  XML elements as if they were text fragments.
- No parser option/dependency upgrade, heuristic replacement of `]],>`, HTML
  decoding change or mixed-content ordering redesign. This issue concerns
  WordPress's adjacent split-CDATA field encoding, not arbitrary interleaved
  XML element/text content.
- Feed reconstructed text through the existing HTML-to-Markdown, import and
  storage paths. Do not normalize unrelated prose or alter any slug deliberately.
  Existing valid single-section fields remain byte-identical at the parser output.

**Affected files:** `uploader/src/wxr-parse.ts`,
`uploader/test/wxr-parse.test.ts`, this spec, and the implementation's brief
`SECURITY.md` reconfirmation. `wp-import.ts` consumers of `ParsedWxr` and
`ParsedPost` need no shape changes. No runtime UI copy is added.

## Trust boundaries and regression contract

WXR remains untrusted input. This fixes field reconstruction, not validation:
`WxrParseError` still produces the fixed client message, entity/size safeguards
remain in place, attachment URLs still pass through `safeFetch`, slugs through
the import admission guard, and body HTML through existing conversion and render
sanitization. A literal sequence repaired in a URL must never bypass fetch or
storage guards. Keep #143's NUL/gallery-marker protections intact.

Use real XML fixtures through the configured `parseWxr`, not a mocked parser:

1. The issue's paired-post field
   `<content:encoded><![CDATA[<p>a[[x]]]]><![CDATA[>b</p>]]></content:encoded>`
   must yield exactly `<p>a[[x]]>b</p>`, with no invented comma.
2. Split-CDATA title and excerpt reconstruct a literal `]]>` identically. Include
   multiple split points in a field to prevent a one-boundary special case.
3. Include commas adjacent to the split and whitespace/newlines inside fragments;
   assert the exact decoded text so real separators survive. A literal comma
   must not disappear merely because the fix is described as “remove commas”.
4. Existing single CDATA, ordinary text, empty and missing fields retain their
   output. Cover the `#text` fallback through real parser-produced inputs where
   applicable; do not manufacture a parser shape the configured parser cannot emit.
5. Retain malformed/truncated XML, malformed DOCTYPE and entity-cap regression
   coverage with the fixed public error and private detail. Existing grouping,
   attachment extraction and thumbnail lookup tests must remain valid.

Before merge the implementing agent must run uploader typecheck and its full
affected tests, including parser/import suites and existing integration coverage
against disposable Postgres when applicable. The scalar fix, uploader typecheck and
parser regressions are complete. A real multipart import against isolated Postgres
returned 202 and persisted both locale titles, excerpts and converted bodies with
literal split-CDATA characters and actual commas intact. Full CI-equivalent checks
and independent final-head PR review remain required.

## Documentation, recovery and approval

Reconfirm `SECURITY.md`'s XML-error, SSRF and input/output-validation boundaries;
no new trust exception is introduced. The original WXR parser contract and
#85/#143 hardening remain authoritative except for array-to-string concatenation.
#387 touches adjacent parser admission code but is not a prerequisite: integrate
both without changing one another's field/cohort semantics.

Rollback is a code revert, with no schema or data migration. It reintroduces
corruption for the next split-CDATA import, so suspend affected imports until
fixed. Do not “repair” persisted commas globally: genuine commas cannot be
reliably distinguished from inserted ones. Existing corrupted content needs an
owner-reviewed comparison with the source export/revision and targeted normal
editing; this proposal authorizes no data writes or automatic re-import.

**Owner approval recorded 2026-10-28:** separator-free concatenation of the existing
parser's scalar fragment arrays, preserving actual fragment characters and all
current safety boundaries. Parser upgrades, bulk content repair, publication and
deployment are not authorized.
