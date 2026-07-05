# AI Alt-Text, Editor-Integrated (Browser-Direct LM Studio) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore local-LM-Studio AI alt-text as a per-field "Suggest alt text" button in the post editor and photo uploader, with the model called directly from the browser.

**Architecture:** The browser reads read-only LM config from `GET /ai-config`, downscales the picked photo on a canvas, and POSTs it to the author's local LM Studio (`<baseUrl>/chat/completions`) — the server never contacts the model. The server only persists LM config in the JSON settings store and serves it. A tiny tested `caption.ts` holds the prompt + response parser as the canonical contract that the browser `llm.js` mirrors.

**Tech Stack:** Node 26, Fastify 5, TypeScript 6, Vitest 4 (uploader server); plain browser JS + HTML (admin pages). LM Studio's OpenAI-compatible API.

## Global Constraints

- **Node ≥ 26**, Fastify 5, strict TypeScript (`astro/tsconfigs/strict` for site; uploader `tsc --noEmit` must pass). No `any`, no `@ts-ignore`, no suppressions.
- **Tests Required** — uploader logic in `uploader/src/` is covered by Vitest in `uploader/test/`. `npm test` and `npm run typecheck` (both in `uploader/`) must pass before done.
- **Browser-direct only** — no server-side model call. Do NOT add `/suggest`, `/settings/models`, `/settings/test`, `docker-compose` LM env, `extra_hosts`, or `.env` LM vars. `safe-fetch.ts` is untouched.
- **Data Safety** — no schema/DB changes; no touching persistent data. Settings live in the JSON settings store (`uploader/src/settings.ts`), managed via the admin Settings page.
- **Least privilege** — configuring LM settings stays admin-only (`POST /settings`, `requireAdmin`); reading LM config for a suggestion is `requireAuth` (`GET /ai-config`), and returns ONLY the five LM fields (never backup settings).
- **AI output is `{altEn, altDe}` only** — no `slug`, no `slugify` (dropped vs. the pre-removal version).
- **Security** — model output is written to `input.value` / `textContent` only, never `innerHTML`.
- **Uploader test command:** `cd uploader` then `npm test` (all) or `npx vitest run test/<file>` (one file) / `npx vitest run test/<file> -t "<name>"` (one test). Typecheck: `npm run typecheck`.
- **Commits** — Conventional style `type(scope): description`; end every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Branch is `feature/ai-alt-text` (already created off `main`).

---

## File Structure

**Server (TypeScript, tested):**
- Create `uploader/src/caption.ts` — `DEFAULT_PROMPT`, `CaptionError`, `Caption`, `parseCaption`. Canonical parse contract; no network code.
- Create `uploader/test/caption.test.ts` — unit tests for `parseCaption`.
- Modify `uploader/src/settings.ts` — add five LM fields to `Settings` / `defaultSettings` / `validate` / the known-keys read allow-list; import `DEFAULT_PROMPT`.
- Modify `uploader/test/settings.test.ts` — LM validation + round-trip; fix the defaults + "stale keys" tests.
- Modify `uploader/src/server.ts` — parse LM fields in `POST /settings`; add `GET /ai-config`; add `/ai-config` to `ADMIN_PREFIXES`.
- Modify `uploader/test/server.test.ts` — `GET /ai-config` + `POST /settings` LM tests; fix the exact-shape `GET /settings` assertion.

**Browser (plain JS/HTML, manual verification):**
- Create `uploader/public/llm.js` — browser LM Studio client (`prepImage`, `caption`, `parseCaption`, `listModels`).
- Create `uploader/public/alt-suggest.js` — `AltSuggest.wire(...)` button-wiring helper.
- Modify `uploader/public/settings.html` — add the LM config card (+ browser model list / test), keep the backup card.
- Modify `uploader/public/editor.html` — four "Suggest alt text" buttons + wiring + script tags.
- Modify `uploader/public/index.html` — one "Suggest alt text" button + wiring + script tags.

**Docs / memory:**
- Modify `CLAUDE.md`, `ARCHITECTURE.md`, `uploader/README.md`.
- Update auto-memory files (outside the repo; not committed).

Task order matters: `caption.ts` (Task 1) before `settings.ts` (Task 2, imports `DEFAULT_PROMPT`) before `server.ts` (Task 3). `llm.js` (Task 4) before `alt-suggest.js` (Task 5) before the pages (Tasks 6–8) that load them.

---

### Task 1: `caption.ts` — prompt + response parser (server, tested)

**Files:**
- Create: `uploader/src/caption.ts`
- Test: `uploader/test/caption.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_PROMPT: string`; `class CaptionError extends Error`; `interface Caption { altEn: string; altDe: string }`; `parseCaption(content: string): Caption`.

- [ ] **Step 1: Write the failing test**

Create `uploader/test/caption.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseCaption, CaptionError, DEFAULT_PROMPT } from '../src/caption.js';

describe('parseCaption', () => {
  it('parses a clean JSON object', () => {
    expect(parseCaption('{"altEn":"A beach","altDe":"Ein Strand"}'))
      .toEqual({ altEn: 'A beach', altDe: 'Ein Strand' });
  });

  it('extracts JSON from a fenced/prose-wrapped reply', () => {
    expect(parseCaption('Here you go:\n```json\n{"altEn":"X","altDe":"Y"}\n```'))
      .toEqual({ altEn: 'X', altDe: 'Y' });
  });

  it('trims surrounding whitespace in fields', () => {
    expect(parseCaption('{"altEn":"  A  ","altDe":"  B  "}'))
      .toEqual({ altEn: 'A', altDe: 'B' });
  });

  it('throws CaptionError on a reply with no JSON object', () => {
    expect(() => parseCaption('no json here')).toThrow(CaptionError);
  });

  it('throws CaptionError on malformed JSON', () => {
    expect(() => parseCaption('{altEn: nope}')).toThrow(CaptionError);
  });

  it('throws CaptionError when altEn or altDe is missing/empty', () => {
    expect(() => parseCaption('{"altEn":"X","altDe":""}')).toThrow(CaptionError);
    expect(() => parseCaption('{"altEn":"X"}')).toThrow(CaptionError);
  });
});

describe('DEFAULT_PROMPT', () => {
  it('is non-empty and asks for altEn and altDe', () => {
    expect(DEFAULT_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_PROMPT).toContain('altEn');
    expect(DEFAULT_PROMPT).toContain('altDe');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd uploader && npx vitest run test/caption.test.ts`
Expected: FAIL — cannot resolve `../src/caption.js` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `uploader/src/caption.ts`:

```typescript
// Prompt + response parser for browser-direct AI alt text. This module holds NO
// network code — the model is called from the browser (see public/llm.js); this
// is the canonical, unit-tested parse contract that llm.js mirrors, and the
// source of the default caption prompt used by settings.ts.

export const DEFAULT_PROMPT = [
  'You are writing alt text for a photo on a travel blog.',
  'Look at the image and respond with ONLY a JSON object, no prose, no code fences:',
  '{"altEn": "...", "altDe": "..."}',
  '- altEn: concise, factual English alt text (max ~120 chars). Do NOT start with "image of" or "photo of".',
  '- altDe: the same scene described natively in German (write it directly, do not translate word-for-word).',
].join('\n');

export class CaptionError extends Error {}

export interface Caption {
  altEn: string;
  altDe: string;
}

/** Extract the first {…} JSON object from a model reply and require non-empty
 *  altEn + altDe. Tolerates prose/code-fence wrapping around the object. */
export function parseCaption(content: string): Caption {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new CaptionError('no JSON object in caption response');
  let obj: { altEn?: unknown; altDe?: unknown };
  try {
    obj = JSON.parse(match[0]) as { altEn?: unknown; altDe?: unknown };
  } catch {
    throw new CaptionError('invalid JSON in caption response');
  }
  const altEn = String(obj.altEn ?? '').trim();
  const altDe = String(obj.altDe ?? '').trim();
  if (!altEn || !altDe) throw new CaptionError('caption response missing required fields');
  return { altEn, altDe };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd uploader && npx vitest run test/caption.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run: `cd uploader && npm run typecheck`
Expected: no errors.

```bash
git add uploader/src/caption.ts uploader/test/caption.test.ts
git commit -m "feat(uploader): add caption.ts — alt-text prompt + response parser

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `settings.ts` — restore the five LM fields

**Files:**
- Modify: `uploader/src/settings.ts`
- Test: `uploader/test/settings.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PROMPT` from `./caption.js` (Task 1).
- Produces: `Settings` now has `lmBaseUrl: string; lmModel: string; captionTimeoutMs: number; captionMaxEdge: number; captionPrompt: string` (plus the existing `backupSchedule`, `backupRetention`). `defaultSettings()`, `validate()`, `createSettingsStore()` signatures unchanged.

- [ ] **Step 1: Update the tests (they will fail)**

In `uploader/test/settings.test.ts`, replace the hardcoded defaults constant on line 7:

```typescript
const DEFAULTS: Settings = { backupSchedule: 'off', backupRetention: 14 };
```

with (derive from source, so the prompt string isn't duplicated):

```typescript
const DEFAULTS: Settings = defaultSettings();
```

Replace the `describe('defaultSettings', …)` block (lines 12–16) with:

```typescript
describe('defaultSettings', () => {
  it('includes LM defaults and off / 14 backups', () => {
    const d = defaultSettings();
    expect(d.lmBaseUrl).toBe('http://localhost:1234/v1');
    expect(d.lmModel).toBe('qwen/qwen3-vl-4b');
    expect(d.captionTimeoutMs).toBe(60000);
    expect(d.captionMaxEdge).toBe(768);
    expect(d.captionPrompt.length).toBeGreaterThan(0);
    expect(d.backupSchedule).toBe('off');
    expect(d.backupRetention).toBe(14);
  });
});
```

Replace the `it('drops stale unknown fields from an older settings.json', …)` test (lines 32–42) with — `lmModel` is a KNOWN key again, so it must now be KEPT; a genuinely-unknown key must still be dropped:

```typescript
  it('keeps known LM keys but drops truly unknown fields from an older settings.json', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ lmModel: 'my/local-vlm', legacyRemovedKey: 'x', backupSchedule: 'weekly' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get().lmModel).toBe('my/local-vlm');   // known key → kept
    expect(store.get().backupSchedule).toBe('weekly');
    expect(store.get()).not.toHaveProperty('legacyRemovedKey');
    store.update({ backupRetention: 5 });
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.legacyRemovedKey).toBeUndefined();     // unknown key → not re-persisted
    expect(onDisk.lmModel).toBe('my/local-vlm');
  });
```

Add a new `describe` block after the existing `describe('backup settings validation', …)` block (after line 84):

```typescript
describe('LM settings validation', () => {
  it('accepts a valid http/https base URL', () => {
    expect(validate({ ...DEFAULTS, lmBaseUrl: 'http://localhost:1234/v1' }).lmBaseUrl).toBe('http://localhost:1234/v1');
    expect(validate({ ...DEFAULTS, lmBaseUrl: 'https://lm.example.com/v1' }).lmBaseUrl).toBe('https://lm.example.com/v1');
  });

  it('rejects a non-URL or non-http(s) base URL', () => {
    expect(() => validate({ ...DEFAULTS, lmBaseUrl: 'not a url' })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, lmBaseUrl: 'ftp://host/v1' })).toThrow(SettingsError);
  });

  it('rejects an empty model', () => {
    expect(() => validate({ ...DEFAULTS, lmModel: '  ' })).toThrow(SettingsError);
  });

  it('rejects timeout out of range or non-integer', () => {
    expect(() => validate({ ...DEFAULTS, captionTimeoutMs: 999 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionTimeoutMs: 600001 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionTimeoutMs: 1.5 })).toThrow(SettingsError);
  });

  it('rejects maxEdge out of range or non-integer', () => {
    expect(() => validate({ ...DEFAULTS, captionMaxEdge: 255 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionMaxEdge: 4097 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionMaxEdge: 300.5 })).toThrow(SettingsError);
  });

  it('rejects an empty prompt', () => {
    expect(() => validate({ ...DEFAULTS, captionPrompt: '   ' })).toThrow(SettingsError);
  });

  it('round-trips LM fields through update()', async () => {
    const path = join(dir, 'settings.json');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    const updated = store.update({ lmBaseUrl: 'http://localhost:9999/v1', lmModel: 'my/vlm', captionMaxEdge: 1024 });
    expect(updated.lmBaseUrl).toBe('http://localhost:9999/v1');
    expect(updated.lmModel).toBe('my/vlm');
    expect(updated.captionMaxEdge).toBe(1024);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.lmModel).toBe('my/vlm');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd uploader && npx vitest run test/settings.test.ts`
Expected: FAIL — `defaultSettings()` lacks the LM fields, `validate` doesn't reject LM values, etc.

- [ ] **Step 3: Implement — edit `uploader/src/settings.ts`**

Add the import at the top (after line 2):

```typescript
import { DEFAULT_PROMPT } from './caption.js';
```

Replace the `Settings` interface (lines 6–9) with:

```typescript
export interface Settings {
  lmBaseUrl: string;
  lmModel: string;
  captionTimeoutMs: number;
  captionMaxEdge: number;
  captionPrompt: string;
  backupSchedule: BackupSchedule;
  backupRetention: number;
}
```

Replace `defaultSettings()` (lines 18–23) with:

```typescript
export function defaultSettings(): Settings {
  return {
    lmBaseUrl: 'http://localhost:1234/v1',
    lmModel: 'qwen/qwen3-vl-4b',
    captionTimeoutMs: 60000,
    captionMaxEdge: 768,
    captionPrompt: DEFAULT_PROMPT,
    backupSchedule: 'off',
    backupRetention: 14,
  };
}
```

Replace `validate()` (lines 25–33) with:

```typescript
export function validate(s: Settings): Settings {
  let url: URL;
  try {
    url = new URL(s.lmBaseUrl);
  } catch {
    throw new SettingsError('Base URL is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SettingsError('Base URL must start with http:// or https://.');
  }
  if (!s.lmModel.trim()) throw new SettingsError('Model is required.');
  if (!Number.isInteger(s.captionTimeoutMs) || s.captionTimeoutMs < 1000 || s.captionTimeoutMs > 600000) {
    throw new SettingsError('Timeout must be a whole number of milliseconds between 1000 and 600000.');
  }
  if (!Number.isInteger(s.captionMaxEdge) || s.captionMaxEdge < 256 || s.captionMaxEdge > 4096) {
    throw new SettingsError('Max edge must be a whole number between 256 and 4096 pixels.');
  }
  if (!s.captionPrompt.trim()) throw new SettingsError('Prompt is required.');
  if (!['off', 'daily', 'weekly'].includes(s.backupSchedule)) {
    throw new SettingsError('Backup schedule must be off, daily, or weekly.');
  }
  if (!Number.isInteger(s.backupRetention) || s.backupRetention < 1 || s.backupRetention > 100) {
    throw new SettingsError('Backup retention must be a whole number between 1 and 100.');
  }
  return s;
}
```

In `createSettingsStore()`, replace the known-keys read block (lines 40–42) with the full known-key list:

```typescript
    const fromFile = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    if (fromFile.lmBaseUrl !== undefined) current.lmBaseUrl = fromFile.lmBaseUrl;
    if (fromFile.lmModel !== undefined) current.lmModel = fromFile.lmModel;
    if (fromFile.captionTimeoutMs !== undefined) current.captionTimeoutMs = fromFile.captionTimeoutMs;
    if (fromFile.captionMaxEdge !== undefined) current.captionMaxEdge = fromFile.captionMaxEdge;
    if (fromFile.captionPrompt !== undefined) current.captionPrompt = fromFile.captionPrompt;
    if (fromFile.backupSchedule !== undefined) current.backupSchedule = fromFile.backupSchedule;
    if (fromFile.backupRetention !== undefined) current.backupRetention = fromFile.backupRetention;
```

(Update the comment on line 38–39 to read: `// Pick known keys only, so truly unknown fields in an older settings.json are` / `// dropped instead of re-persisted forever.`)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd uploader && npx vitest run test/settings.test.ts`
Expected: PASS (all cases, including the rewritten defaults + stale-keys tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd uploader && npm run typecheck`
Expected: no errors.

```bash
git add uploader/src/settings.ts uploader/test/settings.test.ts
git commit -m "feat(uploader): restore LM Studio config in the settings store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `server.ts` — parse LM fields in POST /settings + add GET /ai-config

**Files:**
- Modify: `uploader/src/server.ts` (`ADMIN_PREFIXES` ~line 62; `POST /settings` ~lines 248–259; add `GET /ai-config` right after)
- Test: `uploader/test/server.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `requireAdmin` (already imported), `cfg.settings` (`SettingsStore`), `SettingsError` (already imported).
- Produces: `GET /ai-config` → `{ lmBaseUrl, lmModel, captionPrompt, captionTimeoutMs, captionMaxEdge }` (requireAuth). `POST /settings` additionally accepts the five LM fields (requireAdmin).

- [ ] **Step 1: Update/add the tests (they will fail)**

In `uploader/test/server.test.ts`, find the existing assertion (line ~368):

```typescript
    expect(res.json()).toEqual({ backupSchedule: 'off', backupRetention: 14 });
```

Change `toEqual` → `toMatchObject` (the response now also carries LM fields):

```typescript
    expect(res.json()).toMatchObject({ backupSchedule: 'off', backupRetention: 14 });
```

Then add these two `describe` blocks (place them next to the existing `/settings` tests, e.g. after the `POST /settings 400 on invalid backup retention` test around line 405):

```typescript
describe('GET /ai-config', () => {
  it('401 without auth', async () => {
    const res = await build().app.inject({ method: 'GET', url: '/ai-config' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the LM config for a non-admin author (no backup fields)', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false });
    const res = await b.app.inject({ method: 'GET', url: '/ai-config', cookies: cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      lmBaseUrl: 'http://localhost:1234/v1',
      lmModel: 'qwen/qwen3-vl-4b',
      captionTimeoutMs: 60000,
      captionMaxEdge: 768,
    });
    expect(body.captionPrompt).toBeTruthy();
    expect(body).not.toHaveProperty('backupSchedule');
    expect(body).not.toHaveProperty('backupRetention');
  });
});

describe('POST /settings (LM fields)', () => {
  it('admin can update LM fields', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { lmModel: 'my/vlm', captionMaxEdge: 1024 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lmModel: 'my/vlm', captionMaxEdge: 1024 });
  });

  it('400 on an invalid lmBaseUrl', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { lmBaseUrl: 'not a url' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 for a non-admin', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false });
    const res = await b.app.inject({
      method: 'POST', url: '/settings',
      headers: { 'content-type': 'application/json' }, cookies: cookie,
      payload: { lmModel: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd uploader && npx vitest run test/server.test.ts`
Expected: FAIL — `GET /ai-config` 404 (not registered), and `POST /settings` ignores `lmModel`.

- [ ] **Step 3: Implement — edit `uploader/src/server.ts`**

Add `'/ai-config'` to the `ADMIN_PREFIXES` array (lines 62–65) so it gets the admin security headers:

```typescript
  const ADMIN_PREFIXES = [
    '/admin', '/login', '/logout', '/auth', '/setup', '/settings', '/users',
    '/posts', '/upload', '/import', '/export', '/backups', '/rebuild', '/health', '/pages', '/images',
    '/ai-config',
  ];
```

Replace the body of `POST /settings` (lines 249–252, the `const b` + two `partial` assignments) so it also parses the five LM fields:

```typescript
  app.post('/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const partial: Record<string, unknown> = {};
    if (b.lmBaseUrl !== undefined) partial.lmBaseUrl = String(b.lmBaseUrl).trim();
    if (b.lmModel !== undefined) partial.lmModel = String(b.lmModel).trim();
    if (b.captionTimeoutMs !== undefined) partial.captionTimeoutMs = Number(b.captionTimeoutMs);
    if (b.captionMaxEdge !== undefined) partial.captionMaxEdge = Number(b.captionMaxEdge);
    if (b.captionPrompt !== undefined) partial.captionPrompt = String(b.captionPrompt);
    if (b.backupSchedule !== undefined) partial.backupSchedule = String(b.backupSchedule);
    if (b.backupRetention !== undefined) partial.backupRetention = Number(b.backupRetention);
    try {
      return reply.send(cfg.settings.update(partial));
    } catch (e) {
      if (e instanceof SettingsError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
```

Immediately after that `POST /settings` handler (before `app.get('/login', …)`), add the read-only AI-config route:

```typescript
  // Read-only LM config for the browser-direct alt-text suggester. Any signed-in
  // author may READ it (to run a suggestion); CHANGING it stays admin-only via
  // POST /settings. Deliberately excludes backup settings.
  app.get('/ai-config', { preHandler: requireAuth }, async (_req, reply) => {
    const s = cfg.settings.get();
    return reply.send({
      lmBaseUrl: s.lmBaseUrl,
      lmModel: s.lmModel,
      captionPrompt: s.captionPrompt,
      captionTimeoutMs: s.captionTimeoutMs,
      captionMaxEdge: s.captionMaxEdge,
    });
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd uploader && npx vitest run test/server.test.ts`
Expected: PASS (new `/ai-config` + `POST /settings` LM tests, and the amended `GET /settings` assertion).

- [ ] **Step 5: Full suite + typecheck + commit**

Run: `cd uploader && npm test && npm run typecheck`
Expected: entire uploader suite PASS, no type errors. (This confirms `routing.test.ts` and the other `/settings` tests still pass with the widened `Settings` shape.)

```bash
git add uploader/src/server.ts uploader/test/server.test.ts
git commit -m "feat(uploader): parse LM fields in POST /settings; add GET /ai-config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `public/llm.js` — browser LM Studio client

**Files:**
- Create: `uploader/public/llm.js`

**Interfaces:**
- Consumes: nothing (browser global, loaded via `<script>`).
- Produces: `window.LLM = { parseCaption(content) → {altEn, altDe}, listModels(baseUrl) → string[], prepImage(file, maxEdge) → Promise<{dataUrl, width, height}>, caption(baseUrl, model, prompt, dataUrl, timeoutMs) → Promise<{altEn, altDe}> }`.

- [ ] **Step 1: Create the file**

Create `uploader/public/llm.js` (this is the pre-removal client, trimmed: no `slugify`, and `parseCaption` returns `{altEn, altDe}` only):

```javascript
/*
 * Browser-side LM Studio helpers. The admin pages call LM Studio DIRECTLY from
 * the browser (the model runs on the same machine you author from), so the
 * server never needs to reach it. LM Studio sends `Access-Control-Allow-Origin: *`,
 * so cross-origin calls work; on an https admin page, browsers treat http://localhost
 * as a secure origin (use Chrome if a browser blocks it).
 */
window.LLM = (function () {
  const base = (u) => String(u).replace(/\/+$/, '');

  function parseCaption(content) {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON object in model response');
    const o = JSON.parse(m[0]);
    const altEn = String(o.altEn ?? '').trim();
    const altDe = String(o.altDe ?? '').trim();
    if (!altEn || !altDe) throw new Error('model response missing fields');
    return { altEn, altDe };
  }

  async function listModels(baseUrl) {
    const res = await fetch(base(baseUrl) + '/models');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    return (body.data || []).map((m) => m.id).filter(Boolean);
  }

  /** Load a File, downscale its longest edge to maxEdge, return a JPEG data URL
   *  plus the ORIGINAL intrinsic dimensions. The original file is never re-encoded
   *  here — upload still sends the untouched file to /upload. */
  function prepImage(file, maxEdge) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const scale = Math.min(1, (maxEdge || 768) / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.8), width: w, height: h });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not a decodable image')); };
      img.src = url;
    });
  }

  async function caption(baseUrl, model, prompt, dataUrl, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
    try {
      const res = await fetch(base(baseUrl) + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 300,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      return parseCaption(body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : '');
    } finally {
      clearTimeout(timer);
    }
  }

  return { parseCaption, listModels, prepImage, caption };
})();
```

- [ ] **Step 2: Verify it parses (syntax check)**

Run: `node --check uploader/public/llm.js`
Expected: no output (exit 0). (Note: `window`/`Image` are browser globals; `--check` only validates syntax, not execution — this is fine.)

- [ ] **Step 3: Commit**

```bash
git add uploader/public/llm.js
git commit -m "feat(uploader): browser LM Studio client (llm.js), alt-text only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `public/alt-suggest.js` — "Suggest alt text" wiring helper

**Files:**
- Create: `uploader/public/alt-suggest.js`

**Interfaces:**
- Consumes: `window.LLM` (Task 4); `GET /ai-config` (Task 3).
- Produces: `window.AltSuggest = { wire(opts) }` where `opts = { button, fileInput, altInput, statusEl, lang: 'de'|'en', hintEl? }` (all except `lang`/`hintEl` are DOM elements).

- [ ] **Step 1: Create the file**

Create `uploader/public/alt-suggest.js`:

```javascript
/*
 * Wires a "Suggest alt text" button to browser-direct LM Studio captioning.
 * On click: read the picked file, fetch read-only LM config from GET /ai-config,
 * caption locally via LLM (llm.js), and fill the alt input with the matching
 * language ('de' → altDe, 'en' → altEn). The model is reached from THIS browser
 * (see llm.js); nothing hits the server. Failures degrade to an inline message —
 * the manual alt field always stays usable.
 */
window.AltSuggest = (function () {
  async function loadConfig() {
    const res = await fetch('/ai-config');
    if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function wire(opts) {
    const { button, fileInput, altInput, statusEl, lang, hintEl } = opts;
    if (!button) return;
    const say = (msg) => { if (statusEl) statusEl.textContent = msg; };
    button.addEventListener('click', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) { say('Pick a photo first.'); return; }
      let cfg;
      try {
        cfg = await loadConfig();
      } catch (e) {
        say('Could not load AI settings: ' + e.message);
        return;
      }
      say('Asking the local model…');
      try {
        const prep = await LLM.prepImage(file, cfg.captionMaxEdge);
        const c = await LLM.caption(cfg.lmBaseUrl, cfg.lmModel, cfg.captionPrompt, prep.dataUrl, cfg.captionTimeoutMs);
        altInput.value = lang === 'de' ? c.altDe : c.altEn;
        // Programmatic .value assignment fires no input event — dispatch one so
        // the editor's DraftGuard marks the form dirty.
        altInput.dispatchEvent(new Event('input', { bubbles: true }));
        if (hintEl) hintEl.textContent = lang === 'de' ? 'EN: ' + c.altEn : 'DE: ' + c.altDe;
        say('Suggested — review and edit as needed.');
      } catch (e) {
        say('Couldn\'t reach LM Studio at ' + cfg.lmBaseUrl + ' (' + e.message +
          '). Is it running? Fill in the alt text manually.');
      }
    });
  }

  return { wire };
})();
```

- [ ] **Step 2: Verify it parses (syntax check)**

Run: `node --check uploader/public/alt-suggest.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add uploader/public/alt-suggest.js
git commit -m "feat(uploader): AltSuggest.wire helper for Suggest-alt-text buttons

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `public/settings.html` — LM config card

**Files:**
- Modify (full rewrite): `uploader/public/settings.html`

**Interfaces:**
- Consumes: `window.LLM.listModels` (Task 4); `GET`/`POST /settings` (Task 3, admin-only page).
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Replace the whole file**

Overwrite `uploader/public/settings.html` with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Settings · Simon's Wanderlust</title>
    <link rel="stylesheet" href="/admin/admin.css" />
  </head>
  <body>
    <header class="masthead">
      <div class="masthead-inner">
        <nav id="mainnav" aria-label="Admin"></nav>
        <p class="eyebrow">Expedition Log · Image Station</p>
        <h1>Settings</h1>
        <p class="lede">
          Configure the local vision model for alt-text suggestions, schedule database
          backups, and rebuild the public site. Saved settings apply immediately; no redeploy.
        </p>
        <p class="muted" id="whoami"></p>
      </div>
    </header>

    <main>
      <section class="card">
        <h2 class="card-heading">AI alt-text (local LM Studio)</h2>
        <p class="muted">
          Suggestions run in <em>this browser</em> against the base URL below (your machine's
          LM Studio) — the server never contacts the model. Set it to where LM Studio listens
          here, usually <code>http://localhost:1234/v1</code>.
        </p>

        <label for="baseUrl">LM Studio base URL (as this browser reaches it)</label>
        <input id="baseUrl" type="text" placeholder="http://localhost:1234/v1" />

        <label for="model">Model</label>
        <select id="model"></select>
        <input id="modelManual" type="text" placeholder="…or type a model id" />

        <label for="timeout">Caption timeout (ms)</label>
        <input id="timeout" type="number" min="1000" max="600000" />

        <label for="maxEdge">Max image edge (px)</label>
        <input id="maxEdge" type="number" min="256" max="4096" />

        <label for="prompt">Caption prompt</label>
        <textarea id="prompt" rows="8"></textarea>

        <button id="test">Test connection</button>
      </section>

      <section class="card">
        <h2 class="card-heading">Site &amp; database</h2>

        <label for="backupSchedule">Database backup schedule</label>
        <select id="backupSchedule">
          <option value="off">Off</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>

        <label for="backupRetention">Backups to keep</label>
        <input id="backupRetention" type="number" min="1" max="100" />

        <button id="backupNow">Back up now</button>
        <button id="rebuild">Rebuild site now</button>

        <p class="section-label">Last backup</p>
        <pre id="backupStatus">—</pre>
        <p class="section-label">Backup files</p>
        <ul id="backupFiles"></ul>
        <p class="section-label">Image archives</p>
        <ul id="imageArchives"></ul>
        <p class="muted">
          Note: DB dumps and image archives are written to <code>/data/backup/db</code> —
          the same server disk as the live data. They are not offsite copies; keep a
          host-level backup (e.g. restic/rsync cron) of <code>/data</code>
          (host: <code>./uploader/data</code>).
        </p>
      </section>

      <button id="save">Save settings</button>

      <div class="route" aria-hidden="true">
        <span class="dot"></span><span class="seg"></span>
        <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 14 L14 2 M14 2 h-5 M14 2 v5" stroke="currentColor" stroke-width="1.5" fill="none" /></svg>
        <span class="seg"></span><span class="ring"></span>
      </div>

      <p class="section-label">Status</p>
      <pre id="out">—</pre>
    </main>

    <script src="/admin/auth.js"></script>
    <script src="/admin/llm.js"></script>
    <script>
      const $ = (id) => document.getElementById(id);

      function fill(s) {
        $('baseUrl').value = s.lmBaseUrl || '';
        $('timeout').value = s.captionTimeoutMs ?? '';
        $('maxEdge').value = s.captionMaxEdge ?? '';
        $('prompt').value = s.captionPrompt || '';
        $('backupSchedule').value = s.backupSchedule || 'off';
        $('backupRetention').value = s.backupRetention ?? 14;
        const sel = $('model');
        if (s.lmModel && ![...sel.options].some((o) => o.value === s.lmModel)) {
          sel.add(new Option(s.lmModel, s.lmModel));
        }
        if (s.lmModel) sel.value = s.lmModel;
      }

      // Repopulate the dropdown from a live model list, preserving the current
      // selection even if LM Studio isn't serving it (so a saved/manual id survives).
      function populateModels(models) {
        const sel = $('model');
        const keep = sel.value;
        sel.innerHTML = '';
        for (const m of models) sel.add(new Option(m, m));
        if (keep && ![...sel.options].some((o) => o.value === keep)) sel.add(new Option(keep, keep));
        if (keep) sel.value = keep;
      }

      async function loadModels() {
        try {
          populateModels(await LLM.listModels($('baseUrl').value.trim()));
        } catch { /* LM Studio not reachable from here — leave the manual field */ }
      }

      function chosenModel() { return $('modelManual').value.trim() || $('model').value; }

      async function init() {
        try {
          const res = await fetch('/settings');
          if (res.status === 401) { location.href = '/login'; return; }
          if (!res.ok) { $('out').textContent = 'Could not load settings: ' + res.status; return; }
          fill(await res.json());
          await loadModels();
          $('out').textContent = 'Loaded.';
        } catch (e) { $('out').textContent = 'Error: ' + e; }
      }

      $('test').addEventListener('click', async () => {
        $('out').textContent = 'Testing from this browser…';
        try {
          const models = await LLM.listModels($('baseUrl').value.trim());
          populateModels(models);
          const model = chosenModel();
          if (models.includes(model)) {
            $('out').textContent = 'Reachable from this browser. Model "' + model + '" is available ✓';
          } else if (models.length) {
            $('out').textContent = 'Reachable, but "' + (model || '(none selected)') +
              '" is not being served. Available now: ' + models.join(', ');
          } else {
            $('out').textContent = 'Reachable, but no models are loaded in LM Studio.';
          }
        } catch (e) {
          $('out').textContent = 'Not reachable from this browser (' + e.message +
            '). Is LM Studio running and serving on ' + $('baseUrl').value.trim() + '?';
        }
      });

      $('save').addEventListener('click', async () => {
        $('out').textContent = 'Saving…';
        let res;
        try {
          res = await fetch('/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              lmBaseUrl: $('baseUrl').value.trim(),
              lmModel: chosenModel(),
              captionTimeoutMs: Number($('timeout').value),
              captionMaxEdge: Number($('maxEdge').value),
              captionPrompt: $('prompt').value,
              backupSchedule: $('backupSchedule').value,
              backupRetention: Number($('backupRetention').value),
            }),
          });
        } catch (e) {
          $('out').textContent = 'Could not send the save request (' + e + ').';
          return;
        }
        if (res.status === 401) { location.href = '/login'; return; }
        const r = await res.json().catch(() => ({}));
        if (!res.ok) { $('out').textContent = 'Not saved: ' + (r.error || res.status); return; }
        fill(r);
        $('out').textContent = 'Saved.';
      });

      function renderBackups(data) {
        const st = data.state || {};
        $('backupStatus').textContent = st.lastError
          ? 'FAILED at ' + st.lastAttemptAt + ': ' + st.lastError
          : st.lastSuccessAt ? 'OK at ' + st.lastSuccessAt : 'No backup yet.';
        renderFileList($('backupFiles'), data.files || []);
        renderFileList($('imageArchives'), data.imageArchives || []);
      }

      function renderFileList(ul, files) {
        ul.innerHTML = '';
        for (const f of files) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = '/backups/' + encodeURIComponent(f.name);
          a.textContent = f.name + ' (' + Math.round(f.size / 1024) + ' kB)';
          li.appendChild(a);
          ul.appendChild(li);
        }
      }

      async function loadBackups() {
        const res = await fetch('/backups');
        if (res.ok) renderBackups(await res.json());
      }

      $('backupNow').addEventListener('click', async () => {
        $('backupStatus').textContent = 'Backing up…';
        const res = await fetch('/backups', { method: 'POST' });
        if (!res.ok) { $('backupStatus').textContent = 'Backup failed: HTTP ' + res.status; return; }
        await loadBackups();
      });

      $('rebuild').addEventListener('click', async () => {
        $('out').textContent = 'Rebuilding the site — this takes a minute…';
        const res = await fetch('/rebuild', { method: 'POST' });
        const r = await res.json().catch(() => ({}));
        $('out').textContent = r.ok ? 'Rebuilt: release ' + r.release : 'Rebuild failed: ' + (r.error || res.status);
      });

      (async () => {
        // The whole page is admin-only (matches the admin-gated /settings API);
        // non-admins are bounced back to the hero-upload page.
        const s = await Auth.ensureAuthed({ admin: true });
        if (!s) return;
        Auth.renderHeader(s);
        await loadBackups();
        await init();
      })();
    </script>
  </body>
</html>
```

- [ ] **Step 2: Syntax-check the inline script**

Run: `node -e "const h=require('fs').readFileSync('uploader/public/settings.html','utf8'); const m=h.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/); new Function(m[1]); console.log('inline script parses OK')"`
Expected: `inline script parses OK`.

- [ ] **Step 3: Commit**

```bash
git add uploader/public/settings.html
git commit -m "feat(uploader): restore the LM Studio config card on the Settings page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `public/editor.html` — four "Suggest alt text" buttons

**Files:**
- Modify: `uploader/public/editor.html`

**Interfaces:**
- Consumes: `window.AltSuggest.wire` (Task 5), `window.LLM` (Task 4).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the four buttons**

In the DE hero picker, after `<button type="button" id="deHeroUpload" class="btn-secondary">Upload hero</button>` (line 102), add:

```html
          <button type="button" id="deHeroSuggest" class="btn-secondary">Suggest alt text</button>
```

In the EN hero picker, after `<button type="button" id="enHeroUpload" class="btn-secondary">Upload hero</button>` (line 134), add:

```html
          <button type="button" id="enHeroSuggest" class="btn-secondary">Suggest alt text</button>
```

In the DE body-img row, after `<button type="button" id="deBodyImgUpload" class="btn-secondary">Insert body image</button>` (line 115), add:

```html
          <button type="button" id="deBodyImgSuggest" class="btn-secondary">Suggest alt text</button>
```

In the EN body-img row, after `<button type="button" id="enBodyImgUpload" class="btn-secondary">Insert body image</button>` (line 147), add:

```html
          <button type="button" id="enBodyImgSuggest" class="btn-secondary">Suggest alt text</button>
```

- [ ] **Step 2: Load the two browser scripts**

After `<script src="/admin/vendor/easymde.min.js"></script>` (line 178) and before the opening `<script>` of the inline module (line 179), add:

```html
    <script src="/admin/llm.js"></script>
    <script src="/admin/alt-suggest.js"></script>
```

- [ ] **Step 3: Wire the buttons**

In the inline script, immediately after the body-image wiring lines (after `$('enBodyImgUpload').addEventListener('click', () => uploadBodyImg('en'));` on line 459), add:

```javascript
      // ---- AI alt-text suggestions (browser-direct LM Studio; see alt-suggest.js) ----
      AltSuggest.wire({ button: $('deHeroSuggest'), fileInput: $('deHeroFile'), altInput: $('deHeroAlt'), statusEl: $('deHeroStatus'), lang: 'de' });
      AltSuggest.wire({ button: $('enHeroSuggest'), fileInput: $('enHeroFile'), altInput: $('enHeroAlt'), statusEl: $('enHeroStatus'), lang: 'en' });
      AltSuggest.wire({ button: $('deBodyImgSuggest'), fileInput: $('deBodyImgFile'), altInput: $('deBodyImgAlt'), statusEl: $('deBodyImgStatus'), lang: 'de' });
      AltSuggest.wire({ button: $('enBodyImgSuggest'), fileInput: $('enBodyImgFile'), altInput: $('enBodyImgAlt'), statusEl: $('enBodyImgStatus'), lang: 'en' });
```

- [ ] **Step 4: Manual verification (see the shared procedure at the end)**

Confirm: the editor loads without console errors; clicking "Suggest alt text" with no file shows "Pick a photo first."; with a file + LM Studio running, the matching alt field fills and the form goes dirty (the beforeunload guard arms); with LM Studio stopped, an inline "Couldn't reach LM Studio…" message appears and the field stays editable.

- [ ] **Step 5: Commit**

```bash
git add uploader/public/editor.html
git commit -m "feat(uploader): Suggest-alt-text buttons in the post editor (DE/EN hero + body)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: `public/index.html` — one "Suggest alt text" button

**Files:**
- Modify: `uploader/public/index.html`

**Interfaces:**
- Consumes: `window.AltSuggest.wire` (Task 5), `window.LLM` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Add the button + hint**

Replace the alt block (lines 32–33):

```html
        <label for="alt">Alt text</label>
        <input id="alt" type="text" />
```

with:

```html
        <label for="alt">Alt text</label>
        <input id="alt" type="text" />
        <button type="button" id="suggestAlt" class="btn-secondary">Suggest alt text</button>
        <p class="muted" id="altHint"></p>
```

- [ ] **Step 2: Load the two browser scripts + wire**

Replace the script tag line 56 (`<script src="/admin/auth.js"></script>`) with:

```html
    <script src="/admin/auth.js"></script>
    <script src="/admin/llm.js"></script>
    <script src="/admin/alt-suggest.js"></script>
```

Then, inside the existing inline `<script>` block, immediately after the `document.getElementById('go').addEventListener(…)` handler closes (after line 93, before the `(async () => { const s = await Auth.ensureAuthed()…` line 94), add:

```javascript
      // Single generic alt field → fill with English; show German as a copyable hint.
      AltSuggest.wire({
        button: document.getElementById('suggestAlt'),
        fileInput: document.getElementById('file'),
        altInput: document.getElementById('alt'),
        statusEl: document.getElementById('out'),
        lang: 'en',
        hintEl: document.getElementById('altHint'),
      });
```

- [ ] **Step 3: Manual verification**

Confirm on `/admin/`: no file → "Pick a photo first."; with a file + LM Studio running, `#alt` fills with English and `#altHint` shows `DE: …`; upload still works afterward.

- [ ] **Step 4: Commit**

```bash
git add uploader/public/index.html
git commit -m "feat(uploader): Suggest-alt-text button on the photo uploader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Docs (and auto-memory)

**Files:**
- Modify: `CLAUDE.md`, `ARCHITECTURE.md`, `uploader/README.md`
- (Outside the repo, not committed) auto-memory files.

**Interfaces:** none.

- [ ] **Step 1: `CLAUDE.md` — reframe the "no AI" statements**

Replace this sentence in the Project Overview (the one beginning "This project does not use LM Studio"):

> `**This project does not use LM Studio or any AI features** — the former AI caption/batch-uploader feature was removed in July 2026 (the 2026-06-22 spec is historical).`

with:

> `The blog has **one** small AI feature: **editor-integrated alt-text suggestions** via a local LM Studio vision model, called **directly from the browser** (the server never contacts the model; no new server SSRF surface). See docs/superpowers/specs/2026-07-05-ai-alt-text-editor-integration-design.md. (An earlier standalone batch-uploader variant was removed in July 2026 and restored in this slimmer, editor-integrated form; the 2026-06-22 spec is historical.)`

In the "3. AI Assistant Security Guidelines" section, replace:

> `The project deliberately contains no AI/LLM features.`

with:

> `The one AI feature (browser-direct alt-text via local LM Studio) adds no server→LLM call and no new outbound-fetch surface; keep it that way (do not proxy the model through the server or through safeFetch).`

In "Project Status & Remaining Phases", add a new `- **Done:**` bullet after the "AI feature removal + conformance hardening (July 2026)" bullet:

> `- **Done:** AI alt-text restored (2026-07-05) — editor-integrated "Suggest alt text" buttons (DE/EN hero + body) + photo uploader, browser-direct to local LM Studio; LM config in the JSON settings store; read-only GET /ai-config for non-admin authors. Slimmer replacement for the removed batch uploader (no server /suggest, no slug). See docs/superpowers/specs/2026-07-05-ai-alt-text-editor-integration-design.md (branch feature/ai-alt-text).`

- [ ] **Step 2: `ARCHITECTURE.md` + `uploader/README.md`**

Run: `grep -rn -i "lm studio\|no ai\|caption\|ai feature\|/suggest" ARCHITECTURE.md uploader/README.md`
For each hit that says the project has no AI / that the feature was removed, update it to describe the restored feature. Add a short subsection to each (place it near the uploader endpoints / features description you find):

> **AI alt-text (local LM Studio).** The post editor and photo uploader offer a "Suggest alt text" button per alt field. The browser downscales the picked photo and calls the author's local LM Studio (`<lmBaseUrl>/chat/completions`) directly — the app server never contacts the model. LM config (`lmBaseUrl`, `lmModel`, `captionTimeoutMs`, `captionMaxEdge`, `captionPrompt`) lives in the JSON settings store, edited on the admin-only Settings page; authors read it read-only via `GET /ai-config`. No `docker-compose`/`.env` LM variables are needed.

- [ ] **Step 3: Typecheck sanity + commit docs**

Run: `cd uploader && npm test && npm run typecheck`
Expected: full uploader suite PASS, no type errors (docs-only changes shouldn't affect this, but confirm nothing else drifted).

```bash
git add CLAUDE.md ARCHITECTURE.md uploader/README.md
git commit -m "docs: restore AI alt-text (editor-integrated, browser-direct LM Studio)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Update auto-memory (not committed — outside the repo)**

Rewrite `/Users/simon/.claude/projects/-Users-simon-Documents-localGIT-blog/memory/ai-batch-uploader.md` so it no longer says "don't reintroduce": record that AI alt-text was **restored 2026-07-05** as an editor-integrated, browser-direct feature (the standalone batch-uploader variant removed 2026-07-04 is gone; this is the slimmer replacement — no server `/suggest`, no slug). Update its one-line pointer in `memory/MEMORY.md` accordingly, and add a note to `memory/blog-rebuild-status.md`.

---

## Final verification (after all tasks)

- [ ] `cd uploader && npm test` — entire uploader Vitest suite passes.
- [ ] `cd uploader && npm run typecheck` — no type errors.
- [ ] Manual E2E with LM Studio running locally (see the shared procedure below): a suggestion fills the correct field in the editor and the uploader; an unreachable endpoint degrades gracefully; the Settings page loads the model list and "Test connection" reports status.
- [ ] `git log --oneline` shows the nine focused commits on `feature/ai-alt-text`.

## Shared manual-verification procedure (browser tasks 6–8)

The browser modules aren't in the Vitest scope; verify by running the app. Requires a reachable Postgres (`DATABASE_URL`) and, for a full check, LM Studio serving a vision model on `http://localhost:1234/v1`.

1. Start the uploader: `cd uploader && npm run dev` (or run the container stack). Log in at `/login`.
2. **Settings** (`/admin/settings.html`, admin): the AI card loads; the model dropdown fills if LM Studio is up; "Test connection" reports reachable/not; Save persists and reloads the values.
3. **Editor** (`/admin/editor.html`): set a slug, pick a hero photo, click "Suggest alt text" → the DE (or EN) alt fills; the unsaved-changes guard arms. Stop LM Studio and retry → inline "Couldn't reach LM Studio…" and the field stays editable.
4. **Uploader** (`/admin/`): pick a photo, "Suggest alt text" fills `#alt` (English) and shows a `DE: …` hint; Upload still returns a snippet.
5. Check the browser console for errors on each page (there should be none).
