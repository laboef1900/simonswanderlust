# LLM Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runtime-editable, persisted LLM (LM Studio) settings page in the uploader admin panel — base URL, model, caption timeout, max edge, and caption prompt — with a model dropdown and a connection test.

**Architecture:** A file-backed settings store (`settings.ts`) seeds from the existing env vars and persists to `/data/settings.json`; `/suggest` reads it fresh per request. New auth'd endpoints `GET/POST /settings`, `GET /settings/models`, `POST /settings/test` back a brand-styled `/admin/settings.html`. `captionImage` gains an optional `prompt`.

**Tech Stack:** Node 22 (global `fetch`), TypeScript (NodeNext, `tsx`), Fastify 5, sharp, Vitest. LM Studio (OpenAI-compatible).

**Repo:** All paths are relative to `uploader/` (i.e. `/Users/simon/Documents/localGIT/blog/uploader/`). Spec: `docs/superpowers/specs/2026-06-23-llm-settings-page-design.md` (in the blog repo).

## Global Constraints

- **Node** `>=22.12.0`; global `fetch`/`AbortController`; no `node-fetch`.
- **TypeScript NodeNext**: every relative import uses an explicit `.js` extension; `strict` + `noUncheckedIndexedAccess`; no `any` in committed code except narrowly-cast test doubles; `tsc --noEmit` stays clean.
- **Auth:** every new endpoint requires the same bearer token as `/upload` (`isAuthorized(req.headers.authorization, cfg.authToken)`); 401 otherwise.
- **Settings fields & bounds:** `lmBaseUrl` (http/https URL), `lmModel` (non-empty), `captionTimeoutMs` (integer 1000–600000), `captionMaxEdge` (integer 256–4096), `captionPrompt` (non-empty).
- **Persistence:** `SETTINGS_PATH` env, default `join(dirname(STORAGE_DIR), 'settings.json')`. Missing/corrupt file → defaults, never throws on read.
- **Graceful degradation:** LM Studio failures never 500 — `/suggest` rows degrade to `captionError: true`; `/settings/models` and `/settings/test` return `{ error }`.
- **Tests:** no test depends on a live LM Studio or real network; use temp files + injected fakes. Commit after each green task.

---

### Task 1: Editable caption prompt (`caption.ts`)

**Files:**
- Modify: `src/caption.ts`
- Test: `test/caption.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const DEFAULT_PROMPT: string`; `CaptionConfig` gains `prompt?: string`; `captionImage` sends `cfg.prompt ?? DEFAULT_PROMPT`.

- [ ] **Step 1: Add failing tests**

Append to `test/caption.test.ts` (it already imports from `../src/caption.js`; add `DEFAULT_PROMPT` to that import and add this block):

```ts
import { DEFAULT_PROMPT } from '../src/caption.js';

describe('captionImage prompt', () => {
  const ok = {
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"altEn":"A","altDe":"B","slug":"c-d"}' } }] }),
  };
  function capture() {
    const calls: any[] = [];
    const fetchImpl = (async (_url: string, init: any) => { calls.push(JSON.parse(init.body)); return ok; }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  it('sends DEFAULT_PROMPT when no prompt is given', async () => {
    const { calls, fetchImpl } = capture();
    await captionImage(Buffer.from('x'), { baseUrl: 'http://h/v1', model: 'm', fetchImpl });
    expect(calls[0].messages[0].content[0].text).toBe(DEFAULT_PROMPT);
  });
  it('sends a custom prompt when provided', async () => {
    const { calls, fetchImpl } = capture();
    await captionImage(Buffer.from('x'), { baseUrl: 'http://h/v1', model: 'm', prompt: 'CUSTOM', fetchImpl });
    expect(calls[0].messages[0].content[0].text).toBe('CUSTOM');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- caption`
Expected: FAIL — `DEFAULT_PROMPT` is not exported (and custom prompt not used).

- [ ] **Step 3: Implement**

In `src/caption.ts`: rename the `PROMPT` const to an exported `DEFAULT_PROMPT`, add `prompt?` to `CaptionConfig`, and use it. Exact changes:

Change the interface:
```ts
export interface CaptionConfig {
  baseUrl: string;            // e.g. http://host.docker.internal:1234/v1
  model: string;              // e.g. qwen/qwen3-vl-4b
  timeoutMs?: number;         // default 60000
  prompt?: string;            // default DEFAULT_PROMPT
  fetchImpl?: typeof fetch;   // injected in tests
}
```

Change `const PROMPT = [` to `export const DEFAULT_PROMPT = [` (leave the array contents unchanged).

In `captionImage`, change the text part from `text: PROMPT` to:
```ts
              { type: 'text', text: cfg.prompt ?? DEFAULT_PROMPT },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- caption` → PASS. Then `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/caption.ts test/caption.test.ts
git commit -m "feat: make the caption prompt configurable (DEFAULT_PROMPT)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Settings store (`settings.ts`)

**Files:**
- Create: `src/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PROMPT` from `./caption.js`.
- Produces:
  - `interface Settings { lmBaseUrl: string; lmModel: string; captionTimeoutMs: number; captionMaxEdge: number; captionPrompt: string }`
  - `class SettingsError extends Error`
  - `interface SettingsStore { get(): Settings; update(partial: Partial<Settings>): Settings }`
  - `function defaultsFromEnv(env: NodeJS.ProcessEnv): Settings`
  - `function createSettingsStore(opts: { path: string; defaults: Settings }): SettingsStore`

- [ ] **Step 1: Write the failing test**

Create `test/settings.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, defaultsFromEnv, SettingsError, type Settings } from '../src/settings.js';

const DEFAULTS: Settings = {
  lmBaseUrl: 'http://host.docker.internal:1234/v1',
  lmModel: 'qwen/qwen3-vl-4b',
  captionTimeoutMs: 60000,
  captionMaxEdge: 768,
  captionPrompt: 'PROMPT',
};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'imgset-')); });

describe('defaultsFromEnv', () => {
  it('reads env with fallbacks', () => {
    const s = defaultsFromEnv({ LMSTUDIO_MODEL: 'foo' } as NodeJS.ProcessEnv);
    expect(s.lmModel).toBe('foo');
    expect(s.lmBaseUrl).toBe('http://host.docker.internal:1234/v1');
    expect(s.captionTimeoutMs).toBe(60000);
    expect(s.captionMaxEdge).toBe(768);
    expect(s.captionPrompt.length).toBeGreaterThan(0);
  });
});

describe('createSettingsStore', () => {
  it('returns defaults when no file exists', () => {
    const store = createSettingsStore({ path: join(dir, 'settings.json'), defaults: DEFAULTS });
    expect(store.get()).toEqual(DEFAULTS);
  });

  it('merges a file over defaults', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ lmModel: 'saved-model', captionMaxEdge: 1024 }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get().lmModel).toBe('saved-model');
    expect(store.get().captionMaxEdge).toBe(1024);
    expect(store.get().lmBaseUrl).toBe(DEFAULTS.lmBaseUrl);
  });

  it('falls back to defaults on a corrupt file', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, 'not json{');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get()).toEqual(DEFAULTS);
  });

  it('update validates, persists, and updates the cache', async () => {
    const path = join(dir, 'settings.json');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    const updated = store.update({ lmModel: 'new', captionTimeoutMs: 5000 });
    expect(updated.lmModel).toBe('new');
    expect(store.get().captionTimeoutMs).toBe(5000);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.lmModel).toBe('new');
  });

  it('update rejects bad values with SettingsError (nothing persisted)', () => {
    const store = createSettingsStore({ path: join(dir, 'settings.json'), defaults: DEFAULTS });
    expect(() => store.update({ lmBaseUrl: 'ftp://nope' })).toThrow(SettingsError);
    expect(() => store.update({ captionTimeoutMs: 10 })).toThrow(SettingsError);
    expect(() => store.update({ captionMaxEdge: 99999 })).toThrow(SettingsError);
    expect(() => store.update({ captionPrompt: '   ' })).toThrow(SettingsError);
    expect(store.get()).toEqual(DEFAULTS); // unchanged
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- settings`
Expected: FAIL — cannot find module `../src/settings.js`.

- [ ] **Step 3: Write the implementation**

Create `src/settings.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_PROMPT } from './caption.js';

export interface Settings {
  lmBaseUrl: string;
  lmModel: string;
  captionTimeoutMs: number;
  captionMaxEdge: number;
  captionPrompt: string;
}

export class SettingsError extends Error {}

export interface SettingsStore {
  get(): Settings;
  update(partial: Partial<Settings>): Settings;
}

export function defaultsFromEnv(env: NodeJS.ProcessEnv): Settings {
  return {
    lmBaseUrl: env.LMSTUDIO_BASE_URL ?? 'http://host.docker.internal:1234/v1',
    lmModel: env.LMSTUDIO_MODEL ?? 'qwen/qwen3-vl-4b',
    captionTimeoutMs: Number(env.CAPTION_TIMEOUT_MS ?? 60000),
    captionMaxEdge: Number(env.CAPTION_MAX_EDGE ?? 768),
    captionPrompt: DEFAULT_PROMPT,
  };
}

function validate(s: Settings): Settings {
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
  return s;
}

export function createSettingsStore({ path, defaults }: { path: string; defaults: Settings }): SettingsStore {
  let current: Settings = { ...defaults };
  try {
    const fromFile = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    current = { ...defaults, ...fromFile };
  } catch {
    // No file yet, or unreadable/corrupt — keep defaults.
  }

  return {
    get: () => ({ ...current }),
    update: (partial) => {
      const merged = validate({ ...current, ...partial });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(merged, null, 2));
      current = merged;
      return { ...current };
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- settings` → PASS. Then `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts test/settings.test.ts
git commit -m "feat: file-backed LLM settings store (env defaults, validated, persisted)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Settings endpoints + `/suggest` rewiring (`server.ts`)

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `SettingsStore`, `SettingsError` from `./settings.js`; `captionImage`, `Caption`, `CaptionConfig` from `./caption.js`.
- Produces (changes to `ServerConfig`): replaces `captioner?`/`captionMaxEdge?` with:
  - `settings: SettingsStore` (required)
  - `captionImpl?: (jpeg: Buffer, cfg: CaptionConfig) => Promise<Caption>` (defaults to `captionImage`)
  - `fetchImpl?: typeof fetch` (for `/settings/models` + `/settings/test`; defaults to global `fetch`)
- New endpoints: `GET /settings`, `POST /settings`, `GET /settings/models`, `POST /settings/test`.

- [ ] **Step 1: Rewrite the test setup + add endpoint tests**

In `test/server.test.ts`, replace the imports + `app()`/`appWith()` helpers (top of file, lines ~7-17 and the `appWith` near the `/suggest` block) with a single in-memory-settings setup. Replace:

```ts
import { buildServer } from '../src/server.js';
import type { Caption } from '../src/caption.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgsrv-'));
});

function app() {
  return buildServer({ storageDir: dir, baseUrl: 'https://img.simonswanderlust.com', authToken: 'secret' });
}
```

with:

```ts
import { buildServer, type ServerConfig } from '../src/server.js';
import type { Caption, CaptionConfig } from '../src/caption.js';
import type { Settings, SettingsStore } from '../src/settings.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgsrv-'));
});

const SETTINGS: Settings = {
  lmBaseUrl: 'http://lm:1234/v1', lmModel: 'qwen/qwen3-vl-4b',
  captionTimeoutMs: 60000, captionMaxEdge: 768, captionPrompt: 'P',
};
function fakeStore(init: Settings = SETTINGS): SettingsStore {
  let cur = { ...init };
  return { get: () => ({ ...cur }), update: (p) => { cur = { ...cur, ...p }; return { ...cur }; } };
}
function build(extra: Partial<ServerConfig> = {}) {
  return buildServer({
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com', authToken: 'secret',
    settings: fakeStore(), ...extra,
  });
}
function app() { return build(); }
```

Then delete the old `appWith` helper and update the `/suggest` describe block to use `build({ captionImpl })`:

```ts
describe('POST /suggest', () => {
  const okCaption = async (): Promise<Caption> => ({ altEn: 'Old town', altDe: 'Altstadt', slug: 'old-town' });

  it('401 without auth', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await app().inject({ method: 'POST', url: '/suggest', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('returns suggestions + dimensions', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await build({ captionImpl: okCaption }).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ filename: 'a.jpg', slug: 'old-town', altEn: 'Old town', altDe: 'Altstadt', width: 1000, height: 800 });
  });

  it('degrades a row when captioning throws, keeping dimensions', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await build({ captionImpl: async () => { throw new Error('down'); } }).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ captionError: true, slug: '', width: 1000, height: 800 });
  });

  it('returns one row per file part even when a file is undecodable', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'good.jpg', contentType: 'image/jpeg' });
    form.append('file', Buffer.from('not a real image'), { filename: 'bad.jpg', contentType: 'image/jpeg' });
    const res = await build({ captionImpl: okCaption }).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    const rows = res.json().results;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ filename: 'good.jpg', slug: 'old-town' });
    expect(rows[1]).toMatchObject({ filename: 'bad.jpg', captionError: true, width: 0, height: 0 });
  });
});

describe('settings endpoints', () => {
  const modelsFetch = (ids: string[]) =>
    (async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) })) as unknown as typeof fetch;

  it('GET /settings 401 without auth, returns current with auth', async () => {
    expect((await app().inject({ method: 'GET', url: '/settings' })).statusCode).toBe(401);
    const res = await app().inject({ method: 'GET', url: '/settings', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lmModel: 'qwen/qwen3-vl-4b', captionMaxEdge: 768 });
  });

  it('POST /settings persists valid changes', async () => {
    const a = app();
    const res = await a.inject({
      method: 'POST', url: '/settings',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      payload: { lmModel: 'new-model', captionMaxEdge: 1024 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lmModel).toBe('new-model');
    const after = await a.inject({ method: 'GET', url: '/settings', headers: { authorization: 'Bearer secret' } });
    expect(after.json().captionMaxEdge).toBe(1024);
  });

  it('POST /settings 400 on invalid', async () => {
    const res = await app().inject({
      method: 'POST', url: '/settings',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      payload: { lmBaseUrl: 'ftp://nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it('GET /settings/models returns ids from LM Studio', async () => {
    const res = await build({ fetchImpl: modelsFetch(['a', 'b']) }).inject({
      method: 'GET', url: '/settings/models', headers: { authorization: 'Bearer secret' },
    });
    expect(res.json().models).toEqual(['a', 'b']);
  });

  it('GET /settings/models degrades to empty + error on failure', async () => {
    const failing = (async () => { throw new Error('econn'); }) as unknown as typeof fetch;
    const res = await build({ fetchImpl: failing }).inject({
      method: 'GET', url: '/settings/models', headers: { authorization: 'Bearer secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([]);
    expect(res.json().error).toBeTruthy();
  });

  it('POST /settings/test reports reachable + modelPresent', async () => {
    const res = await build({ fetchImpl: modelsFetch(['qwen/qwen3-vl-4b']) }).inject({
      method: 'POST', url: '/settings/test',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      payload: { model: 'qwen/qwen3-vl-4b' },
    });
    expect(res.json()).toMatchObject({ ok: true, reachable: true, modelPresent: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- server`
Expected: FAIL — `ServerConfig` has no `settings`/`captionImpl`/`fetchImpl`, and the settings routes 404.

- [ ] **Step 3: Update `server.ts`**

Replace the imports + `ServerConfig` + the captioner section. New top of `src/server.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import sharp from 'sharp';
import { processImage } from './pipeline.js';
import { storeVariants } from './storage.js';
import { isAuthorized } from './auth.js';
import { captionImage, type Caption, type CaptionConfig } from './caption.js';
import { SettingsError, type SettingsStore } from './settings.js';

export interface ServerConfig {
  storageDir: string;
  baseUrl: string;
  authToken: string;
  settings: SettingsStore;
  captionImpl?: (jpeg: Buffer, cfg: CaptionConfig) => Promise<Caption>;
  fetchImpl?: typeof fetch;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_-]*$/;

async function fetchModelIds(baseUrl: string, doFetch: typeof fetch): Promise<string[]> {
  const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/models`, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}
```

Replace the existing captioner section (`const captioner = cfg.captioner; const maxEdge = ...` and the `/suggest` handler body's caption call). The `/suggest` handler becomes (settings read per request, `captionImpl` default to `captionImage`):

```ts
  const captionImpl = cfg.captionImpl ?? captionImage;
  const doFetch = cfg.fetchImpl ?? fetch;

  app.post('/suggest', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const s = cfg.settings.get();
    const maxEdge = s.captionMaxEdge;
    const results: Array<{
      filename: string; slug: string; altEn: string; altDe: string;
      width: number; height: number; captionError?: boolean;
    }> = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const buf = await part.toBuffer();
      const row = { filename: part.filename, slug: '', altEn: '', altDe: '', width: 0, height: 0 } as {
        filename: string; slug: string; altEn: string; altDe: string; width: number; height: number; captionError?: boolean;
      };

      let decodable = part.mimetype.startsWith('image/');
      if (decodable) {
        try {
          const probe = await sharp(buf, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
          row.width = probe.info.width;
          row.height = probe.info.height;
        } catch {
          decodable = false;
        }
      }

      if (!decodable) {
        row.captionError = true;
      } else {
        try {
          const small = await sharp(buf, { failOn: 'none' })
            .rotate()
            .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
          const c = await captionImpl(small, {
            baseUrl: s.lmBaseUrl, model: s.lmModel, timeoutMs: s.captionTimeoutMs, prompt: s.captionPrompt,
          });
          row.slug = c.slug;
          row.altEn = c.altEn;
          row.altDe = c.altDe;
        } catch {
          row.captionError = true;
        }
      }
      results.push(row);
    }

    return reply.send({ results });
  });

  app.get('/settings', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(cfg.settings.get());
  });

  app.post('/settings', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) return reply.code(401).send({ error: 'unauthorized' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const partial: Record<string, unknown> = {};
    if (b.lmBaseUrl !== undefined) partial.lmBaseUrl = String(b.lmBaseUrl).trim();
    if (b.lmModel !== undefined) partial.lmModel = String(b.lmModel).trim();
    if (b.captionTimeoutMs !== undefined) partial.captionTimeoutMs = Number(b.captionTimeoutMs);
    if (b.captionMaxEdge !== undefined) partial.captionMaxEdge = Number(b.captionMaxEdge);
    if (b.captionPrompt !== undefined) partial.captionPrompt = String(b.captionPrompt);
    try {
      return reply.send(cfg.settings.update(partial));
    } catch (e) {
      if (e instanceof SettingsError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get('/settings/models', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) return reply.code(401).send({ error: 'unauthorized' });
    const q = (req.query ?? {}) as { baseUrl?: string };
    const baseUrl = q.baseUrl?.trim() || cfg.settings.get().lmBaseUrl;
    try {
      return reply.send({ models: await fetchModelIds(baseUrl, doFetch) });
    } catch (e) {
      return reply.send({ models: [], error: (e as Error).message });
    }
  });

  app.post('/settings/test', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) return reply.code(401).send({ error: 'unauthorized' });
    const b = (req.body ?? {}) as { baseUrl?: string; model?: string };
    const s = cfg.settings.get();
    const baseUrl = b.baseUrl?.trim() || s.lmBaseUrl;
    const model = b.model?.trim() || s.lmModel;
    try {
      const ids = await fetchModelIds(baseUrl, doFetch);
      const modelPresent = ids.includes(model);
      return reply.send({ ok: modelPresent, reachable: true, modelPresent });
    } catch (e) {
      return reply.send({ ok: false, reachable: false, modelPresent: false, error: (e as Error).message });
    }
  });

  return app;
}
```

(Delete the old `const captioner = cfg.captioner;` / `const maxEdge = cfg.captionMaxEdge ?? 768;` lines and the old `/suggest` body — they are fully replaced above. `/upload`, the static registrations, the `/` redirect, and `KEY_RE` are unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- server` → PASS. Then full `npm test` and `npx tsc --noEmit`.
Expected: all suites pass (note: `main.ts` still references the old config and will fail tsc — that's fixed in Task 4; if `tsc` errors only in `main.ts`, proceed to Task 4 and re-run).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: settings endpoints + read LLM config from the store per request

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Boot wiring + env/compose (`main.ts`)

**Files:**
- Modify: `src/main.ts`
- Modify: `.env.example` (repo root) and `docker-compose.yml` (repo root) — document `SETTINGS_PATH`.

**Interfaces:**
- Consumes: `defaultsFromEnv`, `createSettingsStore` from `./settings.js`; `buildServer` from `./server.js`.

- [ ] **Step 1: Rewrite `src/main.ts`**

```ts
import { dirname, join } from 'node:path';
import { buildServer } from './server.js';
import { createSettingsStore, defaultsFromEnv } from './settings.js';

const authToken = process.env.AUTH_TOKEN ?? '';
if (!authToken) {
  console.error('AUTH_TOKEN is required; refusing to start without it.');
  process.exit(1);
}

const storageDir = process.env.STORAGE_DIR ?? '/data/images';
const settingsPath = process.env.SETTINGS_PATH ?? join(dirname(storageDir), 'settings.json');
const settings = createSettingsStore({ path: settingsPath, defaults: defaultsFromEnv(process.env) });

const app = buildServer({
  storageDir,
  baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  authToken,
  settings,
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`image uploader listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
```

- [ ] **Step 2: Typecheck + full tests**

Run: `npx tsc --noEmit` → exit 0. Then `npm test` → all green.

- [ ] **Step 3: Note `SETTINGS_PATH` in `.env.example` (repo root)**

Append to `/Users/simon/Documents/localGIT/blog/.env.example`:

```
# Where the uploader persists runtime LLM settings (defaults next to STORAGE_DIR).
# SETTINGS_PATH=/data/settings.json
```

The `/data/images` volume already persists `/data/settings.json` — no compose change needed. Verify: `AUTH_TOKEN=x docker compose config >/dev/null && echo OK`.

- [ ] **Step 4: Commit**

```bash
cd /Users/simon/Documents/localGIT/blog
git add uploader/src/main.ts .env.example
git commit -m "feat: wire the settings store at boot (env defaults + SETTINGS_PATH)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Settings page (`public/settings.html`) + nav links

**Files:**
- Create: `public/settings.html`
- Modify: `public/index.html`, `public/batch.html` (add a nav link to settings)

**Interfaces:**
- Consumes: `GET /settings`, `POST /settings`, `GET /settings/models`, `POST /settings/test`; `admin.css`.

- [ ] **Step 1: Create `public/settings.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LLM Settings · Simon's Wanderlust</title>
    <link rel="stylesheet" href="/admin/admin.css" />
  </head>
  <body>
    <header class="masthead">
      <div class="masthead-inner">
        <p class="eyebrow">Expedition Log · Image Station</p>
        <h1>LLM settings</h1>
        <p class="lede">
          Configure the local vision model used for alt-text suggestions. Saved here and applied
          immediately — no redeploy. Defaults come from the server's environment.
        </p>
        <nav><a href="/admin/">← Hero upload</a> <a href="/admin/batch.html">Batch uploader</a></nav>
      </div>
    </header>

    <main>
      <section class="card">
        <label for="token">Auth token</label>
        <input id="token" type="password" placeholder="Bearer token" />

        <label for="baseUrl">LM Studio base URL</label>
        <input id="baseUrl" type="text" placeholder="http://host.docker.internal:1234/v1" />

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
        <button id="save">Save</button>
      </section>

      <div class="route" aria-hidden="true">
        <span class="dot"></span><span class="seg"></span>
        <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 14 L14 2 M14 2 h-5 M14 2 v5" stroke="currentColor" stroke-width="1.5" fill="none" /></svg>
        <span class="seg"></span><span class="ring"></span>
      </div>

      <p class="section-label">Status</p>
      <pre id="out">—</pre>
    </main>

    <script>
      const $ = (id) => document.getElementById(id);
      const authed = () => ({ authorization: 'Bearer ' + $('token').value.trim() });

      function fill(s) {
        $('baseUrl').value = s.lmBaseUrl || '';
        $('timeout').value = s.captionTimeoutMs ?? '';
        $('maxEdge').value = s.captionMaxEdge ?? '';
        $('prompt').value = s.captionPrompt || '';
        const sel = $('model');
        if (![...sel.options].some((o) => o.value === s.lmModel)) {
          sel.add(new Option(s.lmModel, s.lmModel));
        }
        sel.value = s.lmModel;
      }

      async function loadModels() {
        try {
          const res = await fetch('/settings/models?baseUrl=' + encodeURIComponent($('baseUrl').value.trim()), { headers: authed() });
          const { models } = await res.json();
          const sel = $('model');
          const keep = sel.value;
          sel.innerHTML = '';
          for (const m of models) sel.add(new Option(m, m));
          if (keep && ![...sel.options].some((o) => o.value === keep)) sel.add(new Option(keep, keep));
          if (keep) sel.value = keep;
        } catch { /* leave the manual field */ }
      }

      async function init() {
        if (!$('token').value.trim()) { $('out').textContent = 'Enter your auth token to load settings.'; return; }
        try {
          const res = await fetch('/settings', { headers: authed() });
          if (!res.ok) { $('out').textContent = 'Could not load settings: ' + res.status; return; }
          fill(await res.json());
          await loadModels();
          $('out').textContent = 'Loaded. Edit and Save, or Test connection.';
        } catch (e) { $('out').textContent = 'Error: ' + e; }
      }
      $('token').addEventListener('change', init);

      function chosenModel() { return $('modelManual').value.trim() || $('model').value; }

      $('test').addEventListener('click', async () => {
        $('out').textContent = 'Testing…';
        try {
          const res = await fetch('/settings/test', {
            method: 'POST', headers: { ...authed(), 'content-type': 'application/json' },
            body: JSON.stringify({ baseUrl: $('baseUrl').value.trim(), model: chosenModel() }),
          });
          const r = await res.json();
          $('out').textContent = r.reachable
            ? 'Reachable. Model ' + (r.modelPresent ? 'is available ✓' : 'NOT found — pick another') + '.'
            : 'Not reachable: ' + (r.error || 'unknown error');
        } catch (e) { $('out').textContent = 'Error: ' + e; }
      });

      $('save').addEventListener('click', async () => {
        $('out').textContent = 'Saving…';
        const payload = {
          lmBaseUrl: $('baseUrl').value.trim(),
          lmModel: chosenModel(),
          captionTimeoutMs: Number($('timeout').value),
          captionMaxEdge: Number($('maxEdge').value),
          captionPrompt: $('prompt').value,
        };
        try {
          const res = await fetch('/settings', {
            method: 'POST', headers: { ...authed(), 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const r = await res.json();
          if (!res.ok) { $('out').textContent = 'Not saved: ' + (r.error || res.status); return; }
          fill(r);
          $('out').textContent = 'Saved. New settings apply to the next suggestion.';
        } catch (e) { $('out').textContent = 'Error: ' + e; }
      });
    </script>
  </body>
</html>
```

- [ ] **Step 2: Link settings from the other admin pages**

In `public/index.html`, the nav line is `<nav><a href="/admin/batch.html">Batch uploader →</a></nav>`. Replace with:

```html
        <nav><a href="/admin/batch.html">Batch uploader →</a> <a href="/admin/settings.html">LLM settings →</a></nav>
```

In `public/batch.html`, the nav line is `<nav><a href="/admin/">← Hero upload</a></nav>`. Replace with:

```html
        <nav><a href="/admin/">← Hero upload</a> <a href="/admin/settings.html">LLM settings →</a></nav>
```

- [ ] **Step 3: Typecheck + tests still green**

Run: `npx tsc --noEmit && npm test` → clean / all green (static page adds no tests).

- [ ] **Step 4: Manual smoke (needs the running stack)**

If the stack is up (`docker compose up -d --build` from the repo root) with LM Studio running:
- Open `http://localhost:8090/admin/settings.html` (or `:3000/admin/settings.html`), enter the token → fields populate, model dropdown fills.
- Click **Test connection** → "Reachable. Model is available ✓".
- Change the prompt, **Save** → "Saved." Reload → persisted.
If LM Studio isn't running, the dropdown stays empty and Test reports "Not reachable" — fields still save. Skip if the stack isn't available; not a commit blocker.

- [ ] **Step 5: Commit**

```bash
git add public/settings.html public/index.html public/batch.html
git commit -m "feat: LLM settings admin page (model dropdown, test, prompt)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Docs

**Files:**
- Modify: `README.md` (uploader)

- [ ] **Step 1: Document the settings page**

Add after the "Convert" / "Batch uploader" section in `uploader/README.md`:

```markdown
## LLM settings

Open `/admin/settings.html`. Configure the LM Studio base URL, model (dropdown populated from
`/v1/models`, or type one), caption timeout, max image edge, and the caption prompt. **Test
connection** checks LM Studio is reachable and the model is present; **Save** persists to
`SETTINGS_PATH` (default `/data/settings.json`, on the volume) and applies immediately — no
restart. The `LMSTUDIO_*` / `CAPTION_*` env vars seed the defaults until you save.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: LLM settings page usage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- File-backed store seeded by env, persisted, hot-read → Task 2 (`settings.ts`), Task 3 (`/suggest` reads per request), Task 4 (boot wiring). ✓
- `GET/POST /settings`, `/settings/models`, `/settings/test` (auth'd) → Task 3 + tests. ✓
- Editable prompt via `captionImage` `prompt` + `DEFAULT_PROMPT` → Task 1. ✓
- Validation/bounds (http(s) URL, model, timeout 1000–600000, edge 256–4096, prompt non-empty) → Task 2 `validate` + test; 400 surfaced in Task 3 `POST /settings`. ✓
- Live model dropdown + manual fallback, Test button → Task 5 page. ✓
- Persistence path `SETTINGS_PATH` default `dirname(STORAGE_DIR)/settings.json` → Task 2 (path passed in) + Task 4 (computes it). ✓
- Graceful degradation (models/test return `{error}`, suggest rows `captionError`, never 500) → Task 3 + tests. ✓
- No live LM Studio / no real network in tests → Task 1 (fetchImpl), Task 2 (temp files), Task 3 (in-memory store + injected captionImpl/fetchImpl). ✓
- Security: http/https only (validate), auth on all endpoints → Task 2 + Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code/test block is complete. Task 5 step 4 (manual smoke) and the optional model smoke are intentionally manual and fully enumerated.

**Type consistency:** `Settings`/`SettingsStore`/`SettingsError`/`defaultsFromEnv`/`createSettingsStore` defined in Task 2, consumed in Tasks 3 + 4 with identical names. `ServerConfig` gains `settings`/`captionImpl`/`fetchImpl` in Task 3, set in Task 4 (`settings`) and tests (`captionImpl`/`fetchImpl`). `CaptionConfig.prompt` + `DEFAULT_PROMPT` from Task 1 used in Task 3's caption call. `/settings/test` returns `{ ok, reachable, modelPresent, error? }` consistently in handler + test. `fetchModelIds` defined and used in both `/settings/models` and `/settings/test`. ✓
