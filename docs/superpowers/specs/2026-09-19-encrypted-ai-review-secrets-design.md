# Encrypted AI review secrets, settings, and backup v6 — #214

**Date:** 2026-09-19  
**Risk:** HIGH — schema, credentials, authorization exposure, and backup/restore.  
**Status:** **Human implementation approval APPROVED on 2026-09-19**; #213 dependency merged, implementation under verification.
**Final-HEAD human merge approval:** **PENDING**, separately required after implementation, verification, and independent security review.  
**Branch:** `feature/214-encrypted-ai-secrets`  
**Scope:** #214 implementation follows this approved contract. Verification and independent security review are required before the separate final-HEAD human merge decision.

## 1. Authority, dependency, and approval gate

Requirements are [#214](https://github.com/laboef1900/simonswanderlust/issues/214), its [latest specification refinement](https://github.com/laboef1900/simonswanderlust/issues/214#issuecomment-5736515545), and epic [#211](https://github.com/laboef1900/simonswanderlust/issues/211). Both current issue comments were inspected on 2026-09-19. Their `ApprovedByAI`/“Execution: Unblocked” statements are AI specification review, **not human high-risk authorization**, even though posted through the owner's account.

`DEFAULT_REVIEW_PROMPT` belongs to #213, at `uploader/src/editorial-review.ts`. #214 implementation must be integrated **after #213 merges into `dev`**, importing that export directly with the repository's `.js` import convention. Do not copy its value, introduce a fallback, or add a stub to make an independent branch compile. Recheck the contract on the merged base. #215 remains blocked until #212, #213, and #214 merge.

The July 2026 local-alt-text design remains authoritative for captions. The separate July 2026 #67 agent-sidecar authoring proposal is not implemented by this issue: no sidecar, server inference, automatic authoring, or CMS write capability is added.

### Exact question for the human owner

> Do you approve implementation of issue #214 according to this specification, including (1) disclosure of the shared provider API key to every authenticated author's browser in memory, (2) one portable key whose destination can be changed by an admin, including a custom HTTP(S) endpoint, (3) the explicitly non-atomic settings.json/Postgres save, where a committed new key can remain associated with the old endpoint if settings persistence fails or the process stops between writes, and (4) encrypted credential backups that require the separately retained master key? The server will make no AI requests; local captions remain independent. Recovery is described below. This approval permits implementation only, not merge or deployment; final-HEAD human merge approval remains separate.

Record the owner's explicit answer, evidence URL or conversation reference, date, approved spec revision/commit, and any conditions **before code starts**. A refusal or material change requires revising this design, not treating the old AI approval as an override. After implementation, record a second human decision naming the exact final PR HEAD SHA; changes after that decision require renewed approval.

### Recorded implementation approval

- **Approver:** repository owner, through the parent session's explicit approval prompt.
- **Decision and date:** owner selected **“Approve implementation”**, 2026-09-19.
- **Conversation evidence:** Main relayed the decision to `Secrets214Design` in the active epic #211 session on 2026-09-19: “Owner explicitly selected 'Approve implementation' via ask in this session,” after naming author plaintext-in-memory access, portable destination, cross-store partial failure, separate key escrow, and the separate final-HEAD merge gate.
- **Approved design revision:** the pre-approval-record version of this file, SHA-256 `f50543c5b23ec8badb057f9fe29d406a795bc3e04e954d611d488a436ea6b292` (uncommitted design delivered for approval). This record updates approval status only, not the approved technical contracts.
- **Conditions:** no application code until Main confirms #213 has merged into `dev`; consume its canonical prompt without a stub/duplicate. Independent security review and verification remain required. This approval is not authorization to merge, deploy, or bypass the separate final-HEAD human approval.
- **Dependency satisfied / start authorization:** Main confirmed #213 merged through PR #222 at `c776e9f9f90aa7120105dac540daef7f96943d1f` and advanced this issue worktree to that commit before explicitly authorizing application work on 2026-09-19. The implementation imports the real `DEFAULT_REVIEW_PROMPT`.

## 2. Baseline and scope

Source inspection establishes these integration seams:

- `main.ts` creates the settings store, opens Postgres, and calls `ensureSchema` before building the server. The new master-key parser must run before schema work.
- `settings.ts` persists non-sensitive configuration in a sibling-temp/atomic-rename JSON file. It validates a merged candidate before writing and updates its in-memory value only after rename succeeds. There is no transaction shared with Postgres.
- `server.ts` currently has admin-only `GET/POST /settings`; authenticated `GET /ai-config` exposes precisely the five caption fields. Its global error handler prints raw unexpected errors; secret-path failures must be sanitized before reaching it.
- `alt-suggest.js` currently fetches full `/ai-config`; changing that caller is required to isolate captions from remote credential failures.
- `backup.ts` writes version 5, reads versions 1–5, captures five tables in one `REPEATABLE READ READ ONLY` transaction, and publishes a dump with no-clobber hard-link semantics. Restore is one transaction; the CLI confirms scope and writes an undo dump first.
- `docker-compose.yml` has an explicit app environment map. Merely documenting a root `.env` variable does not forward it into the container.
- `cli.ts` names five tables in its restore summary; it must accurately name the sixth table's replacement or preservation.

Implementation-owned files: new `uploader/src/secrets.ts`; existing `db.ts`, `main.ts`, `settings.ts`, `server.ts`, `backup.ts`, `cli.ts`; `public/settings.html`, `public/alt-suggest.js`; `.env.example`, root `docker-compose.yml`; affected tests; and the current-state documentation named in §12. #213 owns the prompt and browser review client.

No new public route or slug, no site content/rendering change, no model proxy, no `safeFetch` integration, no credential table beyond `app_secrets`, no provider-account keyring, no automatic key-rotation service, and no new dependencies are in scope.

## 3. Trust boundaries and explicit residual risks

| Boundary | Contract |
|---|---|
| Unauthenticated browser → app | Existing authentication runs before settings or secret access. Neither config query grants anonymous access. |
| Author → app | An author may read caption config and full review config, including the API key when used remotely; an author may not change provider settings, secrets, or backups. |
| Admin → app | Admin chooses the provider/destination, creates/replaces/removes the shared key, and can download encrypted backups. Validate all inputs; admin status is not a reason to log payloads. |
| App → Postgres / backup files | Only AES-GCM ciphertext, IV, authentication tag, key name, and timestamp are persisted. The master key and plaintext provider key are never part of a logical dump. |
| App → authenticated browser | TLS through the existing reverse proxy protects transit. Full review responses are `Cache-Control: no-store`; no credential localStorage/sessionStorage, URL, DOM display, analytics, console, or draft backup. |
| Browser → provider | Browser-direct inference, using #213's bounded request and cancellation contract. The chosen endpoint receives the key and draft content; server egress stays zero. |
| Host/operator → process | The master key is a privileged bootstrap secret. A host/container/process compromise is outside encryption-at-rest protection. |

Encryption protects a database/dump stolen **without** the master key; it does not protect against a compromised app, browser extension, authenticated author, administrator, provider, or host. Any author who receives the key can copy it and use it outside this application. Revoking an author session cannot retract an already copied key: revoke/rotate at the provider and replace the stored key. Provider spend limits remain an operator responsibility.

A single `ai_api_key` is intentionally portable, not provider-bound. Saving a new remote destination while omitting `aiApiKey` retains the old key by contract. The UI must explicitly warn that the existing key will be sent to the new endpoint, naming old/new destinations without secret values, and offer replace/remove guidance. Do not add binding metadata or silently delete the key. An authorized admin can make this change via the API as well.

Custom HTTP is allowed by #214. For a non-loopback custom destination it can expose a bearer credential on the network, and HTTPS admin pages may block it as mixed content. Warn clearly; recommend HTTPS; never silently proxy or downgrade security to make it work. CORS support is a provider/browser requirement, not a reason to add server egress.

The app already passes `process.env` to its Astro build child (`build.ts`). Therefore a new environment secret inherits that existing same-container process trust boundary; this design does **not** claim the key is isolated from the build process, Docker-inspection privileges, memory dumps, or host backups. No new secret should appear in build output. Independent security review must consider this residual explicitly, not certify host-compromise resistance.

## 4. Crypto and storage contract

### 4.1 Master key and boot

`secrets.ts` exports a parser such as `parseEncryptionKey(value: string | undefined): Buffer | undefined`.

- Only `undefined` means absent. Report one informational warning that encrypted remote review credentials are unavailable, then start normally. No generated fallback, plaintext store, or memory-store production fallback.
- A supplied value, including empty string or whitespace, must match `^[0-9a-fA-F]{64}$` exactly. Do not trim, truncate, hash a password, or accept base64. Decode to exactly 32 bytes. Invalid input fails boot with a fixed configuration message, without printing the supplied value, before opening the pool/running `ensureSchema`.
- A correctly shaped but wrong key cannot be detected from syntax. Boot does not decrypt every row or crash over optional remote review. The next applicable config request fails closed with a sanitized error.
- Parse once; pass the resulting buffer explicitly to the production secrets store. No key reads in route handlers and no response field exposing the master key.
- `ServerConfig` gains an explicit `secrets: SecretsStore` dependency. All test/server factory callers migrate; production `main.ts` always supplies the Postgres-backed implementation, even when encryption is unavailable.

Missing-key errors exposed at the secret operation boundary use **`ENCRYPTION_KEY not configured in .env`**, without system paths or values. A non-secret settings save, settings presence read, caption request, backup, or restore does not require decryption.

### 4.2 Functions and wire representation

Use only `node:crypto`:

- `encryptSecret(plaintext: string, key: Buffer): { ciphertext: string; iv: string; tag: string }`.
- AES-256-GCM; a **fresh `randomBytes(12)` IV for every encryption**, including identical replacements; `authTagLength: 16`; UTF-8 plaintext.
- Persist all three binary values as canonical lowercase hexadecimal strings. IV is 24 hex characters; tag is 32; ciphertext is an even-length hex string (empty plaintext is supported by the low-level primitive). No concatenation format, delimiter guessing, or lossy text conversion.
- `decryptSecret(ciphertext: string, iv: string, tag: string, key: Buffer): string` validates key size, input types/hex encoding, IV length and tag length before decrypting. Node's permissive `Buffer.from(..., 'hex')` is not validation.
- Set the authentication tag and call `decipher.final()` before converting/returning plaintext. Never return bytes from `update()` alone. Altered IV, ciphertext, tag, or wrong key must throw a typed, sanitized secret-unavailable error; no unauthenticated fallback.
- No AAD or key-version column is introduced: the required helper signatures and the single current slot do not bind rows to a provider. This is not replay protection; a database writer can restore an older valid ciphertext under the same key. Extending to multiple independently scoped credentials requires a new reviewed design.

### 4.3 Store contract

```ts
interface SecretsStore {
  get(key: string): Promise<string | null>;
  set(key: string, plaintext: string): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}
```

`pgSecretsStore(pool, encryptionKey)` accepts the validated key or `undefined`:

- `get` requires a configured encryption key, selects the requested row via a parameterized query, returns `null` for no row, or decrypts it. A present invalid row never masquerades as `null`.
- `set` requires a configured key, encrypts before issuing SQL, and performs a single parameterized `INSERT ... ON CONFLICT (key) DO UPDATE` replacing ciphertext/IV/tag and `updated_at = now()` together. No delete-then-insert gap. Replacement does not need to decrypt the old value, so an admin can replace an unreadable credential.
- `delete` requires a configured key as a policy check, then performs one parameterized DELETE, idempotent for an absent row. It never decrypts the old row, so deletion still repairs a corrupt record when a syntactically valid master key is configured. This makes every `POST /settings` secret mutation fail closed through the store itself without adding a second route-only capability flag.
- `has` checks row existence only, without decryption; it works with a missing/wrong master key. “Configured” means stored, not verified or usable.
- Expected crypto failures and database failures touching this table are wrapped without row contents, SQL parameters, raw driver `detail`, or error `cause` that would print sensitive material through the global error handler. Fixed error categories suffice; no new logging framework.

`memorySecretsStore()` is a per-instance in-memory map for tests, with the same missing/read/replace/delete/presence semantics and asynchronous interface. It needs no crypto key or Postgres. Crypto authentication failures are verified against crypto/the Postgres implementation, not falsely simulated as memory-store encryption. A missing production key is **never** replaced with this test implementation. Test seams must separately cover the production-disabled mode.

### 4.4 Schema

Append this idempotent new-table creation inside `ensureSchema`, preserving existing migration ordering:

```sql
CREATE TABLE IF NOT EXISTS app_secrets (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

This is a new empty table, not a NOT NULL column added to existing rows; no plaintext defaults or destructive migration is necessary. No seed secret. The only application slot in #214 is `ai_api_key`; clients cannot select an arbitrary secret name through the settings API. No plaintext migration from settings.json or browser storage is introduced because those are not the current credential source of truth.

## 5. Non-sensitive settings and provider resolution

Extend the existing `Settings`, `defaultSettings()`, and `FIELD_CHECKS` together. Preserve field-by-field recovery when loading older/partly invalid settings files; existing caption/backup/import values must survive. Unknown file keys, including any accidental `aiApiKey`, stay excluded from the settings object and subsequent writes.

| Field | Default | Validation |
|---|---|---|
| `aiProvider` | `lm-studio` | Exactly `lm-studio`, `openrouter`, `deepseek`, or `custom`. |
| `aiModel` | `qwen2.5-7b-instruct` | String of at most 100 characters. Empty string is accepted by the stated storage contract; review UI must explain that a model is required before inference. Do not silently reuse `lmModel`. |
| `aiCustomBaseUrl` | empty string | String; empty is allowed. Otherwise a parseable absolute HTTP(S) URL. Reject URL userinfo, query, or fragment: this is a non-sensitive API base, not a credential carrier or a full completion URL. |
| `reviewPrompt` | imported `DEFAULT_REVIEW_PROMPT` from #213 | String; preserve entered text, never execute it or use it for authorization. No separate duplicate prompt constant. |
| `reviewTimeoutMs` | `60000` | Integer in inclusive range 5,000–300,000. |

New-field API validation must examine actual JSON types rather than coercing objects/arrays to strings or numeric strings to numbers. The existing Fastify JSON body limit remains; no unbounded new input channel. `aiApiKey` is excluded from `Settings`, `FIELD_CHECKS`, and `settings.update` entirely. Its accepted request values are `null` or a string; reject control characters in nonempty values (the eventual value is an HTTP bearer credential). Preserve valid key bytes, do not trim/rewrite them.

Resolved `aiBaseUrl` is response-only, never another persisted setting:

| Provider | `aiBaseUrl` |
|---|---|
| `lm-studio` | Existing `lmBaseUrl` |
| `openrouter` | `https://openrouter.ai/api/v1` |
| `deepseek` | `https://api.deepseek.com/v1` |
| `custom` | `aiCustomBaseUrl` |

The provider selection never changes `lmBaseUrl`, `lmModel`, or the caption prompt/timeout/image limits. Full review config for selected `custom` with an empty base refuses with a fixed invalid-review-configuration error; storing an unused empty custom URL remains valid.

## 6. HTTP contracts and compatibility

All response objects are constructed explicitly. Do not spread rows, request bodies, or store internals into responses. Existing auth error conventions remain 401 anonymous / 403 authenticated non-admin for admin endpoints. Set `Cache-Control: no-store` on settings and AI-config responses, including their errors.

### `GET /settings` — `requireAdmin`

Return all non-sensitive settings plus `hasAiApiKey: boolean`. Never return plaintext, ciphertext, IV, tag, master key, or secret timestamp. Presence does not decrypt; wrong or missing master key must not prevent the admin from seeing/remediating configuration. A database lookup failure is an explicit sanitized 503, not a false `hasAiApiKey: false`.

### `POST /settings` — `requireAdmin`

Validate the complete candidate non-secret settings and optional secret value before any write. Detect key presence via an own-property check:

| Payload | Secret action |
|---|---|
| `aiApiKey` omitted | Leave existing row untouched; no secret mutation. |
| Nonempty string | Encrypt and upsert `ai_api_key`. |
| Empty string or `null` | Delete `ai_api_key`. |
| Any other JSON type | 400 invalid input, no mutation. |

Success returns the same redacted shape as GET, never the submitted key. Missing encryption capability on any request with `aiApiKey` returns 503 `{ error: 'ENCRYPTION_KEY not configured in .env', code: 'encryption_key_unconfigured' }` before changing settings or secrets. Crypto/storage errors use fixed sanitized errors; validation errors do not include rejected values. Do not include the full request body in logs or errors.

#### Failure atomicity: deliberately bounded, not transactional

The existing JSON settings store and Postgres cannot form one atomic transaction. This explicit residual was accepted for implementation in the human decision recorded in §1; it is not a claim of all-or-nothing request semantics.

Serialize settings POST operations with one per-server promise queue; acquire before reading the candidate/current settings, and release on both success and failure. Full settings/config reads wait for the current mutation to settle so they do not observe the between-write interval. Caption-only reads do not wait on crypto/DB work and continue using the existing caption settings. This is single-process coordination matching the deployment; it does not coordinate a separate restore CLI or a hand-edited settings file. Run restore in an operator maintenance window without settings edits/inference.

For a request with a secret change: (1) validate all fields and confirm encryption availability; (2) perform the secret operation; (3) persist non-secret settings with the existing atomic rename; (4) return redacted state. If no non-secret settings were submitted, do not rewrite the file merely to acknowledge a secret-only mutation. Resolve presence before mutation or derive it from the successful explicit secret action to avoid an unnecessary fallible read after both writes.

| Failure point | Durable result and response |
|---|---|
| Validation/encryption before SQL | Neither store changed; 400 or configured 503. |
| Secret SQL error | Settings not written; return sanitized 503. A lost commit acknowledgment can make the secret outcome unknown; say to reload/re-enter, never promise rollback. |
| Secret confirmed, settings write/rename fails | Secret change remains committed; settings store remains old. Return 500 `{ code: 'settings_partial_failure', error: 'API key change saved, but settings were not saved. Reload settings before retrying.' }`. |
| Crash after secret commit before settings rename/response | Same possible mixed state; no response can guarantee the outcome. On reconnect, reload settings/presence and deliberately re-enter/remove a key if uncertain. |
| Response lost after both succeed | Both may be saved; refresh before retry. Repeating the same replacement or deletion is semantically idempotent (encryption uses a new IV). |

Do not attempt a fallible compensating rollback using a decrypted old key, retry writes behind the admin's back, or emit “nothing changed” after a partial/uncertain commit. **A replaced key can remain paired with the old provider/base URL**, and another author may subsequently retrieve that combination. The UI warning and recovery instructions must disclose this. Settings save never triggers inference or an automatic authenticated provider test.

### `GET /ai-config?purpose=caption` — `requireAuth`

Explicitly return only:

```ts
{ lmBaseUrl, lmModel, captionPrompt, captionTimeoutMs, captionMaxEdge }
```

Branch before any secret lookup, decryption, remote-provider validation, or full-config mutation wait. No key, presence flag, review prompt, or remote provider fields. It must work when encryption is missing, ciphertext is corrupt, or the secrets store fails, provided the existing session authentication itself succeeds. This does not promise operation during a session-store outage.

Update `AltSuggest.loadConfig` to fetch this query, preserving the existing 401 callback/DraftGuard behavior, image preparation, `LLM.caption` arguments, local connection test, input events, and manual-alt fallback. Do not attach `aiApiKey` to captions or to `LLM.listModels`.

### Default `GET /ai-config` — `requireAuth`

Return the five existing caption fields plus:

```ts
{ aiProvider, aiBaseUrl, aiModel, reviewPrompt, reviewTimeoutMs,
  hasAiApiKey, aiApiKey: string | null }
```

- No `purpose` means full review config; `purpose=caption` means the strict subset. Reject any other/repeated purpose value with 400 rather than accidentally disclosing full config.
- Local `lm-studio`: never decrypt the stored remote key; `aiApiKey: null`. `hasAiApiKey` still reports existence (not usability); a presence lookup failure is not silently turned into absence. Caption-only mode avoids this dependency entirely.
- Remote providers, including `custom`: a missing master key fails closed with the exact 503 configuration error above, even if no key row exists. With a valid master key, a missing row produces `hasAiApiKey: false, aiApiKey: null`; the browser may use a keyless custom endpoint or explain a preset provider's authentication requirement. It must not invent a key or fall back to local review.
- A present unreadable row returns sanitized 503 `{ code: 'ai_secret_unavailable', error: 'AI API key is unavailable. Ask an administrator to check or replace it.' }`; no partial config/plaintext, raw crypto error, or process crash. Do not pretend the row is absent.
- A failed store operation uses a fixed 503 category; no raw database error object is logged. The server never fetches the resolved URL, discovers models, checks CORS, or verifies credentials with a provider.

## 7. Settings UI contract (implementation later)

Read the `impeccable` skill before actual UI work and follow the existing admin design conventions. Keep local captions visibly separate from editorial-review settings.

- Provider presets: Local LM Studio, OpenRouter, DeepSeek, Custom. Show the resolved destination; enable custom base input only when appropriate without losing its saved value. Review model/prompt/timeout are independent from caption fields.
- API key input is `type=password`, empty on load, never populated from GET, with autocomplete disabled as appropriate. A text status chip says “Configured” or “Not configured”; masking is not encryption and the chip is not a connectivity test.
- An untouched blank field means omission/preserve. Explicit removal is a separate confirmed action that sends `null`; it must not occur accidentally on a normal blank-form save. Replacement sends only the typed nonempty value.
- Removal confirmation states that future remote requests lose the shared key but already-copied keys and encrypted backups are not revoked/deleted. Local captions are unaffected.
- Explain that Postgres stores the key encrypted, all signed-in authors receive it in browser memory for direct provider calls, and the server never calls a model. Explain that the selected provider receives review content; do not describe encryption at rest as hiding the key from authors.
- Warn on destination changes when a stored key exists, naming endpoints and explaining retain/replace/remove semantics. Warn on non-HTTPS custom endpoints; no automatic test request using the secret.
- After success or any partial/ambiguous save failure, clear the typed secret input and reload settings plus presence. Display partial-failure/unknown-outcome instructions using text content; retain a clear error if reload itself fails. Never report “Not saved” as though neither store changed.
- Preserve keyboard access, labels/descriptions, visible focus, live status announcements, and the existing local caption connection test. No key/review content in screenshots or saved browser traces.

## 8. Backup v6 and restore contract

### Dump

`DUMP_VERSION = 6`; `readDump` allows exactly `[1, 2, 3, 4, 5, 6]`. Add optional `tables.app_secrets` to the parsed `Dump` type for backwards compatibility. The current writer **always includes the array**, even when empty or when the master key is absent. “Optional secrets capture” here means an optional field in older/external compatible dumps, not a new backup checkbox or an undocumented omission on errors.

Execute `SELECT key, ciphertext, iv, tag, updated_at FROM app_secrets ORDER BY key` on the same checked-out client, inside the existing `REPEATABLE READ READ ONLY` transaction and before COMMIT. Never call `SecretsStore.get`, decrypt/re-encrypt, or include `ENCRYPTION_KEY`. Failure to read the table aborts the dump; do not silently emit an apparently complete v6 backup without it. Preserve gzip, atomic no-clobber publication, retention, transaction cleanup, and all existing table fidelity.

### Restore

- Before mutation, validate that a present `app_secrets` is an array of objects with string key/ciphertext/IV/tag and valid timestamp; validate encodings/lengths using the same envelope checks as crypto, reject duplicate secret names. Malformed present values (`null`, non-array, invalid fields) are not equivalent to absent. Error messages name only the invalid structure, never values.
- `app_secrets === undefined`: do not DELETE or INSERT this table. This covers every legacy v1–v5 dump and optional absent v6 field; preserve the live secrets byte-for-byte.
- Present `[]`: DELETE existing secrets and insert nothing — an intentional empty snapshot, not preserve.
- Present rows: DELETE then parameterized INSERT restoring key, ciphertext, IV, tag, and `updated_at` inside the **same existing restore transaction** as all other table mutations. An insert failure rolls back both secrets and all other restored tables.
- Restore requires no master key and does not authenticate ciphertext: restoring data is not proving decryptability. The operator must pair it with the original master key or re-enter new provider credentials afterward. An authentication failure on subsequent review config stays contained; captions remain usable.
- `cli.ts` names `app_secrets` live/dump counts when replacement is applicable, or explicitly “app_secrets preserved: absent from dump.” Do not label omitted secrets as “0 rows to replace.” Extend the restore result/summary consistently so it reports replaced count versus preserved state, never row values.
- Keep filename/version refusal, exact confirmation/`--yes`, target-without-password display, pre-restore dump before DELETE, session invalidation, and rebuild reminder. The pre-restore dump now includes the live encrypted secrets and remains subject to existing retention; copy it offsite before retention can prune it.

A logical dump still excludes settings.json. Thus a restored key may meet a newer/different provider setting on the data volume. Pause AI use/settings writes during restore, compare the provider configuration before resuming, and restore matching settings from the host backup or deliberately reconfigure. A separate CLI restore is not serialized by the server's in-process queue.

## 9. Operator setup, rotation, and recovery

1. Local-only installations leave `ENCRYPTION_KEY` **unset**, not `ENCRYPTION_KEY=`. No master key is needed for existing local captions or local review; missing-key warning is informational.
2. For encrypted remote credentials, the human operator generates 32 random bytes using `openssl rand -hex 32` in their private terminal and stores the result in the untracked deployment `.env`. Never include its output in an issue, PR, chat, screenshot, shell command argument, or application log. Do not run this command during design preparation.
3. Add optional app environment passthrough `ENCRYPTION_KEY:` to Compose's existing environment map, with no default empty-string interpolation. Compose's [environment specification](https://docs.docker.com/reference/compose-file/services/#environment) removes unresolved single-key variables. The implementation must verify with disposable values that its supported Compose version resolves a configured project `.env` key and leaves an omitted key absent; do not publish `docker compose config`/inspect output containing real secrets. Bare development must load the private env into the process through its existing launch mechanism.
4. Recreate the app container after changing its injected environment; a process restart that retains the old container environment is insufficient. Malformed values must stop before schema work; correct values allow normal startup and additive table creation.
5. Independently escrow the master key with access controls and offsite recovery protection, separated from exported DB dumps. `settings.json` and `/data` backups alone do not recover it. Record which protected master-key version belongs to retained backup generations without recording the key in app data.
6. Enter provider settings/key through authenticated admin Settings over HTTPS. Use a least-privilege provider credential and provider-side budget controls. Verify presence without displaying the key; perform a deliberate browser-direct review only with non-sensitive sample content and the intended destination.

**Provider-key rotation:** replace via settings with the current master key, then revoke the old provider key. Removing the DB row does not remove old encrypted copies in backups or revoke external use.

**Master-key rotation:** no transparent keyring/re-encryption CLI is added. Retain the old key for historical dumps; schedule a maintenance window with no inference/settings edits; back up DB plus settings and escrow the old master key; install the newly generated master key and recreate the app; replace the single stored provider key through the UI (replacement does not decrypt the old row); verify with a deliberate sample; take a new v6 backup. During this window full remote config refuses until replacement, while caption-only config continues. Do not claim changing the environment alone rotates existing ciphertext.

**Lost master key:** existing encrypted secrets cannot be recovered from dumps alone. Obtain/revoke/reissue the provider credential externally, install a new master key, and replace the stored slot. Content, photos, local captions, and unrelated settings remain intact. Do not weaken crypto or discard content to regain optional AI functionality.

**Wrong master key/tampered row:** switch editorial review to local or stop requesting remote review; captions still use their isolated path. Recover the correct key from escrow, restore a known-good matched snapshot using the guarded restore flow, or replace the provider credential. Do not log ciphertext or raw crypto failures as diagnostic evidence.

**Partial settings save:** reload first; the chip establishes only row presence, not which key was committed. Confirm the currently saved destination, deliberately replace/remove the key as needed, then save the desired non-sensitive configuration. No inference until the admin has reconciled both. A new key with the old endpoint is a real possibility, not just a cosmetic error.

**Mistaken DB restore:** use the CLI's pre-restore dump to undo, retain the corresponding master key, reconcile settings.json, and rebuild per existing instructions. Restore failure must leave prior DB state intact through transaction rollback.

## 10. Rollback and containment

- Before upgrading, retain the existing v5 dump, settings.json host backup, and old app image reference. Before restoring anything, retain a current v6 dump and its separately escrowed master key. Never delete persistent volumes or drop tables as rollback.
- Containment does not require a downgrade: select local review or refrain from remote calls, and use caption-only config. A remote-provider crypto outage is not a reason to disable the app or publish pipeline.
- Application downgrade leaves the additive `app_secrets` table in place. The prior binary ignores it, but its v5 writer does **not** preserve secrets in newly created dumps and its restore reader rejects v6. Keep a v6-capable image/tool available for recovery; never relabel a v6 file as v5.
- The old settings loader drops unknown review fields on its next write. Preserve settings.json separately before downgrade and reapply review settings deliberately on re-upgrade. Downgrade is not a guaranteed transparent review-config roundtrip.
- A key suspected exposed to a wrong endpoint, author, browser, or log must be revoked at the provider; deleting a database row or changing the master key cannot retract it.

## 11. Misuse cases and critic self-review

Self-review used the `critic` skill: challenge the confident claims first, then resolve against repository evidence rather than inventing an atomicity or secrecy guarantee.

| Challenge / misuse | Resolution or explicitly pending acceptance |
|---|---|
| “Encrypted at rest means authors cannot steal it.” Who sees it on the wire? | False. #214 explicitly returns it to authenticated authors. §3 and the human gate name this risk; no browser persistence, no-store, session gating, TLS, and provider rotation limit exposure but do not revoke copied secrets. |
| “Saving settings is atomic.” Which transaction commits both disk and Postgres? | None exists. Prevalidation, serialization, secret-first ordering, explicit partial/uncertain errors, and no automatic inference are specified. Cross-store crash/partial state is a human approval item, not hidden behind rollback code. |
| Switch OpenRouter → custom while leaving masked input blank. | Blank untouched means omission/preserve. Warn that the existing key follows the destination; no hidden provider binding outside the required single-slot schema. Human approval explicitly covers endpoint portability. |
| A remote key fails authentication; why should local alt text stop? | It must not. Caption query branches before any secret work; migrate `alt-suggest.js`; test missing/corrupt/throwing store with successful local caption workflow. |
| Is documenting `.env` enough for Docker? | No: current Compose forwards an explicit allow-list. Add optional passthrough and prove omission/supply behavior with disposable configuration during implementation. |
| Is an empty master key “missing”? | No under this design: only undefined is absent; empty supplied value is malformed. No `:-` empty default in Compose. This makes boot behavior precise and testable. |
| Restoring a legacy dump clears secrets by default. | Forbidden. Undefined preserves; empty array intentionally clears; present rows replace atomically. CLI displays which operation will occur. |
| Correct backup but wrong master key or unmatched settings. | Restore never claims decryptability. Key escrow and settings reconciliation are part of recovery; full remote config fails safely, caption path remains separate. |
| Wrong key or attacker-edited tag causes raw crypto/SQL errors in logs. | Envelope validation plus typed/sanitized store failures; bypass raw global logging for secret-path details. Tests include log/output non-disclosure without real credentials. |
| Database writer replays an older valid encrypted row. | AES-GCM does not provide freshness. This issue adds no replay ledger/key version; DB write integrity is an existing privileged boundary. Independent review must acknowledge the limitation. |
| Is the master key isolated from the builder/host? | No: existing child env inheritance and same-container trust are explicit. At-rest protection is not process isolation. |
| Does a future UI save implicitly send a draft or test key? | No. Settings only persists configuration. Intentional review is browser-direct and belongs to #215 integration after prerequisites. |

These are resolved implementation choices or named residual risks covered by the implementation approval recorded in §1; no approval is inferred from this self-review. Independent security review has **not** yet occurred, and final-HEAD human merge approval remains **PENDING**.

## 12. Required verification and documentation before merge

The original design-only assignment ran no tests, formatters, linters, build, or smoke checks. After explicit implementation approval and dependency integration, regression coverage was added; the integration owner schedules execution after editing is stable. The matrix below is required proof, not a claim that checks have passed.

| Issue acceptance / invariant | Required automated proof |
|---|---|
| AES-GCM functions | `secrets.test.ts`: Unicode roundtrip, fresh IV across identical plaintext, key/IV/tag lengths and strict encoding; altered ciphertext/IV/tag and wrong key reject without plaintext; malformed envelope rejects rather than partial decode. |
| Boot resilience | Missing env permits local boot; empty/whitespace/nonhex/wrong length fail before schema work; wrong but shaped key does not crash boot; production missing-key mode never uses the memory store. |
| Store lifecycle/parity | Memory and real Postgres missing/get/set/replace/delete/has contract, per-instance memory isolation; `has` does not need decryption; replacement repairs an unreadable old row; failed writes do not corrupt the previous encrypted row. |
| Settings validation | `settings.test.ts`: provider allow-list; model bound at 100/101; non-string values; URL syntax/protocol/credential-bearing components; timeout inclusive bounds and fractional/type rejection; old settings file preserves caption/backup/import fields while gaining defaults. |
| Auth/redaction/lifecycle | `server.test.ts` plus existing routing fixtures: unauthenticated/author/admin matrix; GET/POST settings contains presence only; omitted/empty/null/nonempty key semantics; invalid non-secret field prevents key mutation; no-store on all config paths; sanitized crypto/DB errors and no secret in logs. |
| Failure semantics | Secret failure leaves settings unchanged; settings-write failure after confirmed secret write returns exact partial category and preserves committed secret; subsequent POST can proceed after failure; config read does not observe an in-flight mixed write; caption-only request avoids that wait. Simulate ambiguous failures without promising unmodified state. |
| Full review config | All four provider resolutions; separate review/caption models; local response never decrypts/returns remote key; remote missing env refuses; missing row returns null; corrupt row refuses without plaintext; custom optional key supported with valid encryption setup; invalid purpose refuses. |
| Caption regression | Actual `AltSuggest` requests `?purpose=caption`, then captions using the same five fields, dispatches input, and preserves 401/DraftGuard behavior. Corrupt/missing remote crypto or a throwing secret store cannot break this path. |
| Backup v6 | `backup.test.ts` with `TEST_DATABASE_URL`: six-table repeatable-read snapshot; encrypted rows and timestamps roundtrip with same master key after restore; absent v1, v2, v3, v4, v5 fields preserve live secrets; absent v6 preserves; empty clears; malformed/duplicate rows reject; insert failure rolls back all tables; dump fails rather than silently omitting secrets; unsupported future version rejects. |
| Restore operator contract | CLI tests: secrets replaced-count versus preserved summary; no values printed; pre-restore dump includes current encrypted secrets; pre-dump failure prevents deletion; existing no-clobber undo guarantee remains. |
| UI compatibility/security | Existing DOM suite plus browser verification: provider controls, masked empty key, meaningful chip, omission/preserve, confirmed removal, destination warning, partial-failure reload and cleared input, independent local connection test, keyboard/status behavior. Use disposable fake keys/non-private content only. |

After all concurrent work is stable, the integration owner runs `npm test` and `npx tsc --noEmit` in `uploader/`, with real Postgres integration coverage enabled, not silently skipped. Follow repository-required site checks/CI on the integrated branch; no site changes are planned, but a skipped DB-backed loader check is not a passing one. Use disposable DB/data paths. Browser smoke must exercise the real settings surface and caption-only response while remote crypto is broken. No production secrets/drafts or provider spend in automated evidence.

**Independent security review:** before final human merge authorization, a reviewer other than the implementation author inspects the actual diff and exercised evidence: auth/response shapes, crypto encoding and authenticated finalization, nonce creation, missing-key boot, raw-error leakage, full/caption query isolation, cross-store failure/crash state, provider portability/HTTP exposure, Compose injection, SQL restore transaction, legacy preservation, and key/backup recovery. Findings must be resolved or explicitly accepted by the human with compensating controls. A test-only review or `ApprovedByAI` label does not replace this gate.

**Documentation cutover with implementation:** update `SECURITY.md` (AI secret disclosure, author trust, no egress, backup sensitivity, partial failure and recovery), `ARCHITECTURE.md` (schema, six-table v6 backup, separate key escrow, env forwarding, config split), `uploader/README.md` and `.env.example` (operator setup/rotation), and relevant root guidance/current-state AI statements. Keep historical #67 sidecar scope distinguished. Reconfirm public routes/slugs, auth, session handling, data paths, and backup deletion guards as unchanged. This specification records proposed behavior only; current-state docs must not prematurely claim it is shipped.
