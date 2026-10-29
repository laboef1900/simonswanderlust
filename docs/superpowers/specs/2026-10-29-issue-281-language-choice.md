# First-run language choice: truthful state without inferred consent (#281)

Date: 2026-10-29. Status: OWNER APPROVED — option A; implemented in source, qualification pending.
Risk: high inherited language-write boundary; approved option A adds no schema or content policy.
Base: integrated #279/#280/#284/#285 on `feature/issue-280-empty-states` at `c23c2da`.

## Evidence and settled decision

Before this amendment, approved #278 §9 required #281 to define a real completion signal and said
that the seeded language default does not prove a choice. #283 §7 and §10 approve four modes,
publication-history locking and the shared admin-only `PUT /language`. Same-mode PUT is a no-op:
`LanguageStore.update` retains the original `updatedAt`; comparing timestamps cannot distinguish
an explicit acceptance of the default. The current onboarding schema intentionally has no per-step
completion flags. Its required Finish predicates are Photo, Story and Publish; Identity is optional.

#281's acceptance requires persisted language configuration, server-side change restrictions,
no step for existing installs and an accessible radio group at 320px. It does not require a new
persisted language-confirmation record. Claiming that the current mode was explicitly chosen would
invent evidence; adding a confirmation field would change the approved operational schema.

## Owner choice

**A — Approved: optional configuration section, no completion badge.** Add a Language section
inside the existing eligible-admin Desk checklist, after Account and before Identity. Show the
current stored mode and its URL consequences, not a remembered completion state. A successful
Save is acknowledged for that request; subsequent reads show only current configuration. Do not add
Language to the checklist's done/required counters or to Finish. This explicitly amends #278 §9:
the language section has no completion claim; the shared stored configuration is its state.

**B — Not selected: persist explicit choice.** This alternative would design and approve an additive confirmation record on
`onboarding_state`, recording the selected primary/enabled locales rather than inferring consent
from a seed or timestamp. `PUT /language` would atomically acknowledge the exact current selection
with the language transaction, including same-mode submission; completion would be derived by
comparing that record with the current mode. This requires a concrete schema/strict-bootstrap
migration, memory/PG parity, concurrency and restore treatment before implementation. No such
field, endpoint flag or migration is authorized by this proposal. Language would remain optional
for Finish unless the owner separately changes the approved three required predicates.

## Approved option A contract

### Eligibility and authorization

- Only an eligible onboarding row exposes the section. Existing-schema, existing-content,
  restored and finished installations remain retired and return only `{ status: 'retired' }`.
- Existing admin onboarding reads remain `requireAdmin` and `no-store`. Authors neither request
  nor see onboarding. Anonymous and author direct calls retain 401/403 respectively.
- Read the language configuration/history through the same read-only snapshot/client as eligible
  onboarding progress, not a second connection or inconsistent cached value. Serialize an explicit
  non-secret language projection. A missing/invalid language row remains an unavailable/error state.
- No new eligibility heuristic, fresh-install test, reset, restore exception or local-storage flag.
  Hiding/showing/finishing retains the approved install-wide semantics.

### Form and writes

- Native `fieldset`/`legend`, four mutually exclusive radio choices: DE only, EN only,
  DE-primary bilingual, EN-primary bilingual. Describe primary at `/`, secondary under `/en/` or
  `/de/`, and disabled-language absence using existing mode-aware path helpers.
- Copy lives in the existing DE/EN dictionary and follows the current admin shell. No walkthrough,
  sample story, automatically created post, separate wizard route or unrelated redesign.
- Only explicit Save calls the existing admin-only `PUT /language`; no second write path, new
  token scheme or automatic retry. Use its existing body/response and post-commit build behavior.
- No mode change on radio focus, arrow navigation or selection alone. Confirm URL consequences
  through the existing confirmation conventions before a changed mode is sent.
- While a write is pending, one in-flight action owns the form. Keep its selection on validation,
  authorization, network or rebuild errors. Re-read authoritative state after ambiguous outcomes;
  never claim rollback or replay automatically.
- A persisted mode with a failed build is reported distinctly: the old release remains served,
  and recovery uses the existing explicit Rebuild action, not another implicit configuration save.
- When publication history locks the install, render the current mode and lock explanation read-only
  in onboarding, as #283's #281 dependency rule requires. Existing Settings continues to own allowed
  post-lock secondary enablement; onboarding neither removes that capability nor adds a bypass.
- Server authorization, stored history and transactional language validation remain authoritative.
  A publish racing a selection must refuse any now-forbidden change without moving existing URLs.

### Accessibility, focus and failure states

- Fit 320 CSS pixels without horizontal scrolling; wrap localized descriptions.
- Native keyboard radio behavior, visible focus, accessible labels and an associated description
  for each URL consequence. Announce pending/success/error using a polite live region.
- Focus stays on the actionable control after refusal. Locking after refresh must leave a sensible
  focus target and explain why editing is unavailable. Loading/unavailable is not an empty mode.
- A hidden or retired checklist cannot leave focus in hidden controls. No whole-page blocking tour.

## Trust boundaries and invariants

1. The authenticated server decides eligible versus retired; a browser cannot turn an existing
   install into a first-run install.
2. Current configuration is not proof of a past explicit choice. No completion badge or historical
   consent claim is derived from the default, a timestamp, or successful rendering.
3. All language mutation goes through #284's existing validation, publication locks, page preflight
   and commit-before-build behavior. Preserve the shared transaction-client and lock order.
4. No post/page slug, snapshot, publication state, auth policy, persisted onboarding schema,
   backup format, restore fence or required Finish predicate changes under option A.
5. No database/content mutation occurs merely by opening, refreshing or inspecting the section.
6. A malformed/error response never falls back to DE, anonymous state, or a success indication.

## Verification and containment

- Regression coverage: fresh eligible versus existing/retired/finished/restored state; role gating;
  all four choices via the real configuration boundary; seeded publication lock; same-mode save;
  publication/save race; validation and unavailable reads; acknowledged save/build failure;
  ambiguous response reconciliation without automatic write replay. No wording/source assertions.
- Run complete uploader PostgreSQL-enabled tests/typecheck and site tests/Astro check/build using
  separate synthetic development and integration databases, then actual main/browser at desktop
  and 320px in DE/EN. Verify keyboard actions, role-safe requests and persisted mode after restart.
- Preserve actual-route behavior and existing URLs in public builds. Reuse qualified #284/#285
  coverage; identify newly exercised scenarios rather than relabelling old evidence.
- Reconfirm SECURITY.md's language/onboarding sections and update the authoring/first-run guide
  after behavior is proven. No new endpoint, data-at-rest or backup boundary is claimed.
- Rollback removes the optional UI/projection together on a security-supported image. Stored mode
  and all content/history remain intact; existing Settings remains usable. Never revert mode or
  erase onboarding state to undo this UI.

## Approval record

Owner selected **“A — Optional configuration”** on 2026-10-29 after the actual PR #482
proposal received independent review (no findings, confidence 0.95) and green exact-head CI.
The decision is recorded in the ignored execution ledger's `issue-281-owner-decision.json`.
This approves the optional current-configuration section and the explicit amendment to
#278 §9: no completion badge, no persisted acknowledgement, unchanged Finish requirements.
Option B is not selected. Implementation and its automated/runtime verification remain
required; this decision authorizes no merge, deployment or owner-content operation.

## Source implementation; not qualification evidence

The eligible `/onboarding` projection now carries `language: { primary, locales, lockedAt,
updatedAt }` beside (not inside) its five progress steps. `readOnboardingProgress` reads the
existing language/history helper using the same checked-out repeatable-read transaction client;
the response explicitly serializes only these four fields. Retired reads still return only
`{ status: 'retired' }`. No persisted onboarding column, action or Finish predicate changes.

The Desk consumer validates that projection before rendering. Its optional native radio form sits
between Account and Identity and uses the existing mode-aware URL mirror and localized dictionary.
Save confirms the selected scope and sends only `{ primary, locales }` to the existing
`PUT /language`; publication locking and activation preflight remain owned by that boundary.
Publication-locked onboarding is read-only, with Settings retaining secondary activation.

After a language write attempt the consumer rereads onboarding rather than replaying the write.
Failed/ambiguous writes retain the candidate; a malformed/unavailable reread presents Retry rather
than assuming DE or exposing stale configuration controls. An acknowledged persisted 502 adopts
the stored mode, preserves its build-failure message and points to Settings' existing Rebuild.
Same-mode acknowledgement belongs only to the current request, never to progress or a later visit.

Source regression cases cover DOM interactions/reconciliation, same-snapshot PostgreSQL reads,
all four modes through the real shared API, publication winning a read/Save race, same-mode
idempotency, failed-build recovery and role-safe requests. These additions have **not** been run
by the implementing worker. The parent must perform §Verification and containment, qualify the
actual browser at desktop/320px in both copy locales, and only then update current-state security
and first-run operating guidance with exact-source evidence. Review, CI, merge and deployment
remain separate gates.
