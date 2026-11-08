# Direct Anthropic browser access

Date: 2026-11-04. Risk: HIGH (provider credential transport).
Owner approved “Fix direct Anthropic support” in the implementation session on this date.
Approval covers implementation, not production deployment or the final merge decision.

## Problem and evidence

An existing Custom provider at `https://api.anthropic.com/v1` cannot list models.
`LLM.listModels` sends a Bearer key but no Anthropic browser-access opt-in.
A credential-free live OPTIONS request with the production site's Origin and
`Access-Control-Request-Headers: authorization` returned 400 `Disallowed CORS origin`.
Adding `anthropic-dangerous-direct-browser-access` to that requested-header list returned
200 with `Access-Control-Allow-Origin: *`. The shipped browser client also reproduced
its generic discovery failure with a deliberately invalid diagnostic key.

## Contract and scope

Keep the existing Custom provider, stored key, base URL, use-case assignments and
OpenAI-compatible `/chat/completions` request/response contract. No registry migration,
new provider kind, native Messages adapter, server proxy or dependencies.
The 2026-11-07 Anthropic-kind addendum in
`2026-10-19-ai-provider-registry-design.md` subsequently adds an explicit registry preset;
it preserves this transport contract and existing Custom providers.

All three browser transport paths (model listing, review/excerpt JSON completions,
and caption/photo-detail vision completions) construct fresh request-local headers.
For parsed URL origin **exactly** `https://api.anthropic.com`, add:

- `anthropic-dangerous-direct-browser-access: true`
- `anthropic-version: 2023-06-01`

The existing `Authorization: Bearer <key>` remains request-local. No header is added
to HTTP, non-default ports, lookalike hosts, other providers or local LM Studio.
Existing endpoint validation, omission of cookies/referrers, redirect refusal,
timeouts/cancellation, sanitized errors and response parsers remain unchanged.
No extra automatic or paid requests are introduced. Callers and `/ai-config` stay unchanged.

References: [Anthropic compatibility API](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk),
[model listing](https://platform.claude.com/docs/en/api/http/models/list),
[versioning](https://platform.claude.com/docs/en/api/versioning).

## Trust boundaries, misuse cases and self-review

- Could this opt a different service into receiving a key? No: origin equality, not
  hostname suffix/prefix matching; the existing registry still binds each key to its URL.
  It does not make arbitrary Custom URLs safe: the administrator already chooses them.
- Does a successful preflight prove the key and every completion work? No. Invalid-key
  responses can themselves lack CORS headers. Live authenticated success is not claimed
  without a valid key; no production credentials are read or logged during development.
- Does this create a new server SSRF path or browser persistence? No: headers exist only
  for the current fetch, and no server/auth/storage code changes.
- Should the fix replace the whole client with native Messages? No: the reported defect
  is the browser gate, and Anthropic documents its OpenAI compatibility endpoint. Its
  broader feature limitations remain; existing unsupported-response-format handling is
  unchanged. Native tool use, thinking controls and account/workspace selection are not
  introduced by this change.

## Acceptance and verification

- Browser discovery and both inference transports include the opt-in/version only for
  the official HTTPS origin; local and other remote calls do not inherit them or a key.
- Boundary regressions cover lookalike origins, HTTP and non-default ports, plus sanitized
  failures and subsequent local requests. Existing behavioral suites cover all five public
  operations and their cancellation/parsing behavior.
- Exercise the shipped JavaScript in Chromium against a deterministic CORS-gated endpoint
  fixture, and check Anthropic's live credential-free preflight. Clearly distinguish fixture
  success from unverified live authenticated inference.
- Run the full uploader test suite and typecheck, plus `astro check`. Record unavailable
  infrastructure or skipped integration coverage rather than treating skips as passes.

### Observed results (2026-11-04)

- Full uploader `npm test`: 141 files / 4,152 tests passed; 35 files / 645 tests skipped
  without `TEST_DATABASE_URL`. No database/server behavior was changed.
- Uploader `npx tsc --noEmit` passed. Focused `llm-mirror.test.ts`: 35 tests passed,
  including seven new Anthropic transport/security cases.
- `npx astro check` passed against the existing local container database through a
  temporary loopback-only tunnel: 151 files, zero errors, warnings or hints. The initial
  host run lacked `DATABASE_URL`; the temporary tunnel was stopped after verification.
- Real Settings HTML and shipped scripts in Chromium: provider Test rendered
  “Reachable from this browser · 1 model listed” against a CORS-gated fixture.
  Browser requests for review, excerpt, caption and photo details returned parsed results
  through the same gate. The fixture used a non-secret diagnostic key, not a real provider.
- Live Anthropic model-list OPTIONS accepted the complete new header set with HTTP 200.
  No live authenticated inference, production change, CI run or deployment was performed.

## Recovery

Revert the client-header change or deploy the previous immutable image; no persisted
state changed and no database restore is needed. Alternatively assign an existing
working provider in Settings. Do not disable browser CORS or introduce a server proxy.
