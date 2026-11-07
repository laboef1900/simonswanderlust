# Issue #550 — AI article translation

High risk. Baseline: origin/dev `171fdbb`. Worktree: `simonswanderlust-550`, branch `feature/550-ai-article-translation`. Scope is the current issue and its review comment, not historical general AI authoring.

## Sequence and ownership

Design → independent design/security approval → parallel assignment and protected-source implementation → editor integration → isolated automated/browser checks → one PR to dev → independent PR review/fixes → required CI. No merge, deployment or publication.

Integration owner owns AI transport, docs, isolated environment and verification. Assignment owner owns settings/provider lifecycle, Settings UI and its tests, plus source-analysis route integration. Source owner owns the pure translation compiler/validator and preservation tests. Editor owner owns translation controller, editor/bridge integration, localized dictionary and editor tests. Assignment copy additions are handed to the editor owner rather than concurrently editing the dictionary. All owners follow the design's fixed API contracts; no overlapping edits. No intermediate builds/tests/formatters; integration owner runs verification after changes settle.

## Acceptance checklist

| ID | Acceptance criterion | Implementation | Verification |
|---|---|---|---|
| A1 | Independent translation assignment, validation/defaults/deletion/resolution | settings, provider API, Settings UI | persisted reload, dangling recovery, independent defaults, deletion, isolated credentials and settings browser |
| A2 | Latest unsaved DE→EN and EN→DE title/excerpt/prose/local descriptions; every gallery/image retained | protected source compiler, text-only model request, draft patch | both directions, multiple/repeated images, layouts/order/positions, exact references/dimensions, actual browser save/reopen/preview |
| A3 | Source/shared/target slug/identity/publication/unrelated fields untouched | strict target patch allowlist, no title input event | full pair invariants, empty/manual/published slugs |
| A4 | Explicit review, replacement consent, discard, dirty/undo/recovery/save | translation dialog, guarded atomic patch, dedicated guarded undo, existing draft guard | overwrite/discard/cancel, undo, recovery and save-conflict tests |
| A5 | Visual/Markdown and locale switches share canonical draft | existing body bridge and normal save path | both modes/directions, switch/save/reopen/preview with galleries |
| A6 | Enabled/non-omitted locale restriction | existing language/coverage state, explicit enablement first | single-language and omitted source/target regressions/browser |
| A7 | Actionable atomic errors; no automatic paid retry | bounded transport and strict complete output validation | missing config/key, HTTP/network/timeout/truncation/malformed/structural mismatch, no partial mutation |
| A8 | No stale application after any draft/context change | epoch plus whole-draft equality checks at every async boundary | source/target edits, locale/coverage/reload/article changes, save conflict |
| A9 | Explicit disclosed inference; refreshed destination/model renews consent | fresh request-local config, secret-free disclosure | zero inference on open, changed config requires another click |
| A10 | Endpoint-bound ephemeral keys; no binaries/EXIF/GPS/global Media changes | purpose-specific config, only text slots sent, sanitized output | credential isolation, payload allowlist, hostile output, unchanged Media integration |
| A11 | DE/EN copy; accessible responsive action/progress/review/errors | existing dictionary and native dialog/controls | dictionary tests, keyboard/focus/Escape, desktop/mobile screenshots |
| R1 | Metadata ownership and nonstandard source preservation from review comment | library-backed fallback disclosure, occurrence caption overrides, opaque unsupported/code/raw source | repeated URL distinct/empty overrides, hidden captions, library/unresolved photos, supported/nonstandard blocks |

All A1–A11 and R1 have local implementation and behavioral evidence in the design's
**Local implementation evidence** section. Full-suite runs were followed by focused
correction checks, including real database suites. The final PR carries independent
implementation/security review findings and required-CI status; neither local approval
nor this checklist authorizes merging or deployment.

## Verification environment

Node 26 native build; dedicated disposable content database and separate integration database; absolute isolated storage/settings/site paths; SITE_APP_DIR points to this worktree; unused loopback app/provider ports. Controlled provider fixture only, never paid requests. Run uploader full npm test with TEST_DATABASE_URL and tsc, site npm test and astro check against initialized DATABASE_URL. Browser exercises the real app and actual persistence/preview, never Publish. Record evidence and resolved review findings in the design/PR, without credentials.
