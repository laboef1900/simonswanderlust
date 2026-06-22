# AI-Assisted Batch Image Uploader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web batch uploader for a post's non-hero photos that uses a local vision model (qwen3-vl via LM Studio) to suggest German + English alt text and a key slug per photo, reviewed before commit, returning paste-ready inline `<RemoteImage>` snippets.

**Architecture:** Two-phase (suggest → review → commit) in the existing `simonswanderlust-images` service. A new isolated `caption.ts` calls LM Studio's OpenAI-compatible API; a new `POST /suggest` endpoint captions + probes dimensions and stores nothing; a new `/admin/batch.html` page renders editable rows and, on commit, stores each photo through the **existing** `POST /upload` and builds the snippets client-side. The hero flow and the `pipeline`/`storage`/`variants` modules are untouched.

**Tech Stack:** Node 22 (global `fetch`/`AbortController`), TypeScript (NodeNext, `tsx`), Fastify 5, `@fastify/multipart`, `sharp`, Vitest. LM Studio (OpenAI-compatible) for inference.

**Repo:** All paths are relative to the **`simonswanderlust-images`** repo root (`/Users/simon/Documents/localGIT/simonswanderlust-images`), NOT the blog repo, unless a task says "blog repo". Spec: `docs/superpowers/specs/2026-06-22-ai-batch-image-uploader-design.md` (in the blog repo).

## Global Constraints

- **Node:** `>=22.12.0`. Use global `fetch` and `AbortController` — do NOT add `node-fetch`.
- **TypeScript:** NodeNext module resolution — **all relative imports use explicit `.js` extensions** (e.g. `./caption.js`), in both `src` and `test`. `strict` + `noUncheckedIndexedAccess` are on. No `any` in committed code except narrowly-cast test doubles. `tsc --noEmit` must stay clean.
- **Contract (unchanged):** widths `[640,1280,1920]` + intrinsic, formats `avif`+`webp`, filenames `{key}-{w}.{fmt}`, key rule `^[a-z0-9][a-z0-9/_-]*$`. `/upload` and `storage.ts` are NOT modified by this plan.
- **Auth:** every new endpoint requires the same bearer token as `/upload` (`isAuthorized(req.headers.authorization, cfg.authToken)`).
- **Graceful degradation:** AI failures must never 500 a batch — degrade to empty suggestions + a flag.
- **Tests:** no automated test may depend on a running LM Studio or Docker daemon. Commit after every green task.

---

### Task 1: Caption module (`caption.ts`)

**Files:**
- Create: `src/caption.ts`
- Test: `test/caption.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface Caption { altEn: string; altDe: string; slug: string }`
  - `interface CaptionConfig { baseUrl: string; model: string; timeoutMs?: number; fetchImpl?: typeof fetch }`
  - `class CaptionError extends Error`
  - `function slugify(s: string): string`
  - `function parseCaption(content: string): Caption`
  - `async function captionImage(jpeg: Buffer, cfg: CaptionConfig): Promise<Caption>`

- [ ] **Step 1: Write the failing test**

Create `test/caption.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { slugify, parseCaption, captionImage, CaptionError } from '../src/caption.js';

describe('slugify', () => {
  it('lowercases, strips diacritics, and dashes non-alphanumerics', () => {
    expect(slugify('Old Town at Dusk')).toBe('old-town-at-dusk');
    expect(slugify('  Café  Münster!! ')).toBe('cafe-munster');
    expect(slugify('a---b__c')).toBe('a-b__c'.replace('__', '-') === 'a-b-c' ? 'a-b-c' : slugify('a---b__c'));
  });
});

describe('parseCaption', () => {
  it('parses a clean JSON object', () => {
    const c = parseCaption('{"altEn":"A beach","altDe":"Ein Strand","slug":"A Beach"}');
    expect(c).toEqual({ altEn: 'A beach', altDe: 'Ein Strand', slug: 'a-beach' });
  });
  it('extracts JSON from a fenced/prose-wrapped reply', () => {
    const c = parseCaption('Here you go:\n```json\n{"altEn":"X","altDe":"Y","slug":"z-z"}\n```');
    expect(c).toEqual({ altEn: 'X', altDe: 'Y', slug: 'z-z' });
  });
  it('throws CaptionError on non-JSON', () => {
    expect(() => parseCaption('no json here')).toThrow(CaptionError);
  });
  it('throws CaptionError when a field is missing/empty', () => {
    expect(() => parseCaption('{"altEn":"X","altDe":"","slug":"z"}')).toThrow(CaptionError);
  });
});

describe('captionImage', () => {
  const ok = {
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"altEn":"A","altDe":"B","slug":"c-d"}' } }] }),
  };
  it('posts to /chat/completions and returns a parsed Caption', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => { calledUrl = url; return ok; }) as unknown as typeof fetch;
    const c = await captionImage(Buffer.from('x'), { baseUrl: 'http://h:1234/v1', model: 'm', fetchImpl });
    expect(calledUrl).toBe('http://h:1234/v1/chat/completions');
    expect(c).toEqual({ altEn: 'A', altDe: 'B', slug: 'c-d' });
  });
  it('throws CaptionError on a network failure', async () => {
    const fetchImpl = (async () => { throw new Error('econn'); }) as unknown as typeof fetch;
    await expect(captionImage(Buffer.from('x'), { baseUrl: 'http://h/v1', model: 'm', fetchImpl }))
      .rejects.toBeInstanceOf(CaptionError);
  });
  it('throws CaptionError on a non-OK response', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(captionImage(Buffer.from('x'), { baseUrl: 'http://h/v1', model: 'm', fetchImpl }))
      .rejects.toBeInstanceOf(CaptionError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- caption`
Expected: FAIL — cannot find module `../src/caption.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/caption.ts`:

```ts
export interface Caption {
  altEn: string;
  altDe: string;
  slug: string;
}

export interface CaptionConfig {
  baseUrl: string;            // e.g. http://host.docker.internal:1234/v1
  model: string;              // e.g. qwen/qwen3-vl-4b
  timeoutMs?: number;         // default 60000
  fetchImpl?: typeof fetch;   // injected in tests
}

export class CaptionError extends Error {}

const PROMPT = [
  'You are writing alt text for a photo on a travel blog.',
  'Look at the image and respond with ONLY a JSON object, no prose, no code fences:',
  '{"altEn": "...", "altDe": "...", "slug": "..."}',
  '- altEn: concise, factual English alt text (max ~120 chars). Do NOT start with "image of" or "photo of".',
  '- altDe: the same scene described natively in German (write it directly, do not translate word-for-word).',
  '- slug: 2-4 word English kebab-case identifier (lowercase, hyphens).',
].join('\n');

/** lowercase, strip diacritics, replace runs of non-alphanumerics with single dashes. */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseCaption(content: string): Caption {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new CaptionError('no JSON object in caption response');
  let obj: { altEn?: unknown; altDe?: unknown; slug?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    throw new CaptionError('invalid JSON in caption response');
  }
  const altEn = String(obj.altEn ?? '').trim();
  const altDe = String(obj.altDe ?? '').trim();
  const slug = slugify(String(obj.slug ?? ''));
  if (!altEn || !altDe || !slug) throw new CaptionError('caption response missing required fields');
  return { altEn, altDe, slug };
}

export async function captionImage(jpeg: Buffer, cfg: CaptionConfig): Promise<Caption> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 60000);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new CaptionError(`caption request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new CaptionError(`caption request returned HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content ?? '';
  return parseCaption(content);
}
```

- [ ] **Step 4: Simplify the slugify test's third assertion**

Replace the third `slugify` assertion (the convoluted one) with a clear case:

```ts
    expect(slugify('a---b c')).toBe('a-b-c');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- caption`
Expected: PASS (all cases).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/caption.ts test/caption.test.ts
git commit -m "feat: local vision-model caption module (alt DE/EN + slug)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Suggest endpoint (`server.ts`)

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `Caption`, `captionImage` from `./caption.js`; existing `isAuthorized`, `sharp`.
- Produces (added to `server.ts`):
  - `type Captioner = (jpeg: Buffer) => Promise<Caption>`
  - `ServerConfig` gains optional `captioner?: Captioner` and `captionMaxEdge?: number` (default 768).
  - `POST /suggest` → `{ results: Array<{ filename: string; slug: string; altEn: string; altDe: string; width: number; height: number; captionError?: boolean }> }`

- [ ] **Step 1: Write the failing test**

Add to `test/server.test.ts` (top-level, after the existing imports — `sharp`, `FormData`, `buildServer`, `mkdtemp`, etc. are already imported):

```ts
import type { Caption } from '../src/caption.js';

function appWith(captioner?: (jpeg: Buffer) => Promise<Caption>) {
  return buildServer({ storageDir: dir, baseUrl: 'https://img.simonswanderlust.com', authToken: 'secret', captioner });
}

describe('POST /suggest', () => {
  it('401 without auth', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await appWith().inject({ method: 'POST', url: '/suggest', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('returns suggestions + dimensions from the captioner', async () => {
    const captioner = async (): Promise<Caption> => ({ altEn: 'Old town', altDe: 'Altstadt', slug: 'old-town' });
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await appWith(captioner).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: 'a.jpg', slug: 'old-town', altEn: 'Old town', altDe: 'Altstadt', width: 1000, height: 800 });
  });

  it('degrades a row (captionError) when the captioner throws, keeping dimensions', async () => {
    const captioner = async (): Promise<Caption> => { throw new Error('lmstudio down'); };
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await appWith(captioner).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().results[0];
    expect(row).toMatchObject({ captionError: true, slug: '', altEn: '', altDe: '', width: 1000, height: 800 });
  });

  it('marks rows captionError when no captioner is configured', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await appWith().inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.json().results[0].captionError).toBe(true);
  });
});
```

(The existing file already defines `dir`, `jpeg()`, and imports `buildServer`/`sharp`/`FormData`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- server`
Expected: FAIL — `/suggest` returns 404 (route not defined) so status assertions fail.

- [ ] **Step 3: Add types + config to `server.ts`**

At the top of `src/server.ts`, add the caption import and types. Change the import block and `ServerConfig`:

```ts
import sharp from 'sharp';
import { captionImage, type Caption } from './caption.js';
```

(Add `import sharp from 'sharp';` if not present, and the caption import. Keep the existing fastify/multipart/static/pipeline/storage/auth imports.)

```ts
export type Captioner = (jpeg: Buffer) => Promise<Caption>;

export interface ServerConfig {
  storageDir: string;
  baseUrl: string;
  authToken: string;
  captioner?: Captioner;
  captionMaxEdge?: number;
}
```

- [ ] **Step 4: Add the `/suggest` route**

Inside `buildServer`, after the existing `app.post('/upload', ...)` handler, add:

```ts
  const captioner = cfg.captioner;
  const maxEdge = cfg.captionMaxEdge ?? 768;

  app.post('/suggest', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const results: Array<{
      filename: string; slug: string; altEn: string; altDe: string;
      width: number; height: number; captionError?: boolean;
    }> = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const buf = await part.toBuffer();
      if (!part.mimetype.startsWith('image/')) continue;

      let width = 0;
      let height = 0;
      try {
        const probe = await sharp(buf, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
        width = probe.info.width;
        height = probe.info.height;
      } catch {
        continue; // not a decodable image
      }

      const row = { filename: part.filename, slug: '', altEn: '', altDe: '', width, height } as {
        filename: string; slug: string; altEn: string; altDe: string; width: number; height: number; captionError?: boolean;
      };

      if (!captioner) {
        row.captionError = true;
      } else {
        try {
          const small = await sharp(buf, { failOn: 'none' })
            .rotate()
            .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
          const c = await captioner(small);
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- server`
Expected: PASS (existing 5 + 4 new = 9 tests).

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass; `tsc` exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: POST /suggest — caption batch + dimensions, graceful degradation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Boot wiring + compose (`main.ts`, `docker-compose.yml`)

**Files:**
- Modify: `src/main.ts`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `buildServer` (now accepts `captioner`/`captionMaxEdge`), `captionImage`.
- Produces: a real captioner wired from env into the running server.

- [ ] **Step 1: Wire the captioner in `main.ts`**

In `src/main.ts`, add the import and build a captioner from env, then pass it to `buildServer`:

```ts
import { buildServer } from './server.js';
import { captionImage } from './caption.js';

const authToken = process.env.AUTH_TOKEN ?? '';
if (!authToken) {
  console.error('AUTH_TOKEN is required; refusing to start without it.');
  process.exit(1);
}

const lmBaseUrl = process.env.LMSTUDIO_BASE_URL ?? 'http://host.docker.internal:1234/v1';
const lmModel = process.env.LMSTUDIO_MODEL ?? 'qwen/qwen3-vl-4b';
const captionTimeoutMs = Number(process.env.CAPTION_TIMEOUT_MS ?? 60000);
const captionMaxEdge = Number(process.env.CAPTION_MAX_EDGE ?? 768);

const app = buildServer({
  storageDir: process.env.STORAGE_DIR ?? '/data/images',
  baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  authToken,
  captionMaxEdge,
  captioner: (jpeg) => captionImage(jpeg, { baseUrl: lmBaseUrl, model: lmModel, timeoutMs: captionTimeoutMs }),
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

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Let the container reach the host's LM Studio**

In `docker-compose.yml`, add `extra_hosts` and pass the LM Studio env through. The `images` service block becomes:

```yaml
services:
  images:
    build: .
    ports:
      - "3000:3000"
    environment:
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-https://img.simonswanderlust.com}
      AUTH_TOKEN: ${AUTH_TOKEN:?set AUTH_TOKEN in .env}
      LMSTUDIO_BASE_URL: ${LMSTUDIO_BASE_URL:-http://host.docker.internal:1234/v1}
      LMSTUDIO_MODEL: ${LMSTUDIO_MODEL:-qwen/qwen3-vl-4b}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data/images:/data/images
    restart: unless-stopped
```

- [ ] **Step 4: Validate compose syntax (no daemon needed)**

Run: `AUTH_TOKEN=x docker compose config >/dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts docker-compose.yml
git commit -m "feat: wire LM Studio captioner from env; reach host from container

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Batch admin page (`public/batch.html`, link from `public/index.html`)

**Files:**
- Create: `public/batch.html`
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `POST /suggest` and `POST /upload` (existing). Builds `<RemoteImage>` snippets from `/upload`'s `{src,width,height}`.
- Produces: the reviewer-facing batch UI. (No unit test — static page; verified by manual smoke in Step 4.)

- [ ] **Step 1: Create `public/batch.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Batch Image Uploader</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
      label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
      input, textarea { width: 100%; padding: 0.4rem; box-sizing: border-box; }
      button { margin-top: 1rem; padding: 0.6rem 1rem; font-weight: 600; }
      .row { display: grid; grid-template-columns: 120px 1fr; gap: 0.75rem; border: 1px solid #ddd; padding: 0.75rem; margin: 0.75rem 0; }
      .row img { width: 120px; height: auto; border-radius: 4px; }
      .row .err { color: #b00; font-size: 0.85rem; }
      .fields { display: grid; gap: 0.4rem; }
      pre { background: #f4f4f6; padding: 1rem; white-space: pre-wrap; }
      .nav a { font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <p class="nav"><a href="/admin/">← Single hero upload</a></p>
    <h1>Batch Image Uploader</h1>
    <p>For a post's body photos. The hero image is uploaded separately on the main page.</p>

    <label for="token">Auth token</label>
    <input id="token" type="password" placeholder="Bearer token" />
    <label for="prefix">Shared key prefix (e.g. trips/rhodes-2021)</label>
    <input id="prefix" type="text" />
    <label for="files">Photos</label>
    <input id="files" type="file" accept="image/*" multiple />
    <button id="suggest">Suggest alt + slugs</button>

    <div id="rows"></div>
    <button id="upload" style="display:none">Upload all</button>

    <h2>Snippets</h2>
    <pre id="out">—</pre>

    <script>
      const KEY_RE = /^[a-z0-9][a-z0-9/_-]*$/;
      const $ = (id) => document.getElementById(id);
      let picked = []; // { file, slug, altEn, altDe, width, height, captionError }

      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const tag = (src, w, h, alt) => `<RemoteImage src="${esc(src)}" width={${w}} height={${h}} alt="${esc(alt)}" />`;

      $('suggest').addEventListener('click', async () => {
        const token = $('token').value;
        const files = [...$('files').files].filter((f) => f.type.startsWith('image/'));
        if (!files.length) { $('out').textContent = 'Pick at least one image.'; return; }
        const fd = new FormData();
        fd.append('prefix', $('prefix').value);
        for (const f of files) fd.append('file', f);
        $('out').textContent = 'Captioning…';
        let results = [];
        try {
          const res = await fetch('/suggest', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
          if (!res.ok) { $('out').textContent = 'Suggest failed: ' + res.status; return; }
          results = (await res.json()).results;
        } catch (e) { $('out').textContent = 'Suggest error: ' + e; return; }

        picked = files.map((file, i) => {
          const r = results[i] || {};
          return { file, slug: r.slug || '', altEn: r.altEn || '', altDe: r.altDe || '', width: r.width || 0, height: r.height || 0, captionError: !!r.captionError };
        });
        renderRows();
        $('upload').style.display = picked.length ? 'inline-block' : 'none';
        $('out').textContent = picked.some((p) => p.captionError) ? 'Some photos had no AI suggestion — fill them in manually.' : 'Review and edit, then Upload all.';
      });

      function renderRows() {
        const host = $('rows');
        host.innerHTML = '';
        picked.forEach((p, i) => {
          const div = document.createElement('div');
          div.className = 'row';
          const thumb = URL.createObjectURL(p.file);
          div.innerHTML =
            `<img src="${thumb}" alt="" />` +
            `<div class="fields">` +
            (p.captionError ? `<div class="err">No AI suggestion for this photo.</div>` : '') +
            `<label>Slug (key suffix)</label><input data-i="${i}" data-k="slug" value="${esc(p.slug)}" />` +
            `<label>Alt — German</label><textarea data-i="${i}" data-k="altDe" rows="2">${esc(p.altDe)}</textarea>` +
            `<label>Alt — English</label><textarea data-i="${i}" data-k="altEn" rows="2">${esc(p.altEn)}</textarea>` +
            `<small>${p.width}×${p.height}</small>` +
            `</div>`;
          host.appendChild(div);
        });
        host.querySelectorAll('[data-i]').forEach((el) => {
          el.addEventListener('input', () => { picked[+el.dataset.i][el.dataset.k] = el.value; });
        });
      }

      $('upload').addEventListener('click', async () => {
        const token = $('token').value;
        const prefix = $('prefix').value.trim().replace(/\/+$/, '');
        const keys = picked.map((p) => prefix + '/' + p.slug.trim());
        for (const k of keys) if (!KEY_RE.test(k)) { $('out').textContent = 'Invalid key: ' + k; return; }
        const dup = keys.find((k, i) => keys.indexOf(k) !== i);
        if (dup) { $('out').textContent = 'Duplicate key: ' + dup + ' — slugs must be unique.'; return; }

        const blocks = [];
        for (let i = 0; i < picked.length; i++) {
          const p = picked[i];
          const fd = new FormData();
          fd.append('key', keys[i]);
          fd.append('alt', p.altEn);
          fd.append('file', p.file);
          let body;
          try {
            const res = await fetch('/upload', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
            body = await res.json();
            if (!res.ok) { blocks.push(`# ${keys[i]} — ERROR: ${body.error || res.status}`); continue; }
          } catch (e) { blocks.push(`# ${keys[i]} — ERROR: ${e}`); continue; }
          blocks.push(
            `# ${keys[i]}\n` +
            `# DE:\n${tag(body.src, body.width, body.height, p.altDe)}\n` +
            `# EN:\n${tag(body.src, body.width, body.height, p.altEn)}`
          );
        }
        $('out').textContent = blocks.join('\n\n');
      });
    </script>
  </body>
</html>
```

- [ ] **Step 2: Link the batch page from the hero page**

In `public/index.html`, add a link just after the opening `<body>` tag's first heading. Find `<h1>Image Uploader</h1>` and insert immediately after it:

```html
    <p style="font-size:0.9rem"><a href="/admin/batch.html">Batch upload a post's body photos →</a></p>
```

- [ ] **Step 3: Typecheck + tests still green**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc` exit 0; all tests pass (static page adds no tests).

- [ ] **Step 4: Manual smoke (needs LM Studio + the container or `npm start`)**

This step requires LM Studio running on `:1234` with `qwen/qwen3-vl-4b`, and the service running. If neither is available, note it and skip — it is not a blocker for committing.

```bash
# start locally (bare node) pointing at the host's LM Studio:
AUTH_TOKEN=secret STORAGE_DIR=./data/images PUBLIC_BASE_URL=http://localhost:3000 \
  LMSTUDIO_BASE_URL=http://localhost:1234/v1 npm start &
# then open http://localhost:3000/admin/batch.html, paste token=secret,
# prefix=trips/smoke, pick 2 photos, Suggest, edit, Upload all.
# Confirm two <RemoteImage> snippets per photo appear, and:
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/trips/smoke/<your-slug>-640.webp   # -> 200
# stop: lsof -ti tcp:3000 | xargs kill -9 ; rm -rf ./data
```

- [ ] **Step 5: Commit**

```bash
git add public/batch.html public/index.html
git commit -m "feat: batch admin page (AI suggestions, review, RemoteImage snippets)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Documentation (`README.md`, `.env.example`)

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Document the new env in `.env.example`**

Append to `.env.example`:

```
# Local vision model (LM Studio, OpenAI-compatible) for AI alt/slug suggestions.
# From inside Docker, host.docker.internal reaches LM Studio on your machine.
LMSTUDIO_BASE_URL=http://host.docker.internal:1234/v1
LMSTUDIO_MODEL=qwen/qwen3-vl-4b
CAPTION_TIMEOUT_MS=60000
CAPTION_MAX_EDGE=768
```

- [ ] **Step 2: Document the batch flow in `README.md`**

Add a section after the "Install & run locally" section:

```markdown
## Batch uploader (a post's body photos)

The main `/admin/` page uploads one hero image. For a post's other photos, open
`/admin/batch.html`:

1. Make sure **LM Studio** is running with a vision model (e.g. `qwen/qwen3-vl-4b`)
   and its server is on `:1234`. (Optional — without it you can still fill fields by hand.)
2. Enter your token + a shared prefix (e.g. `trips/rhodes-2021`), pick several photos.
3. Click **Suggest** — the local model proposes a slug and German + English alt text per photo.
4. Review/edit each row, then **Upload all**.
5. Paste the returned `<RemoteImage>` snippets (DE into the German post, EN into the English post).

The model runs on your machine via LM Studio; nothing is sent to a cloud service.
Alt text is generated natively in each language, not machine-translated.
```

- [ ] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs: batch uploader usage + LM Studio env

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Follow-up (blog repo, separate — NOT part of this plan's tasks)

The `<RemoteImage>` snippets render in post bodies only once the blog can use that
component inside MDX. That work lives in the **blog repo** and **depends on PR #1
(remote images) merging first** (which is where `RemoteImage.astro` is defined). It is
intentionally excluded here so this plan stands alone and ships a working tool (storage +
snippet generation). Spec it as its own small blog-side plan after PR #1 merges: expose
`RemoteImage` to MDX (via the MDX `components` mapping or a documented import) accepting
`{ src, width, height, alt }`, with a rendering test.

---

## Self-Review

**Spec coverage:**
- "non-hero body photos, hero unchanged" → scope of all tasks; `/upload` & hero page untouched. ✓
- "web multi-file, new /admin/batch.html" → Task 4. ✓
- "local qwen3-vl via LM Studio, OpenAI endpoint" → Task 1 (`caption.ts`), Task 3 (env wiring). ✓
- "altEn + altDe native + slug, reviewed" → Task 1 (prompt + parse), Task 4 (editable rows). ✓
- "two-phase suggest→commit; slug locked before store" → Task 2 (`/suggest` stores nothing), Task 4 (commit via `/upload`). ✓
- "shared prefix + prefix/slug key; key rule" → Task 4 (`KEY_RE`, prefix join). ✓
- "inline <RemoteImage> DE+EN output" → Task 4 (`tag()`), follow-up note for rendering. ✓
- "graceful degradation, never 500 on AI" → Task 1 (`CaptionError`), Task 2 (per-row try/catch + no-captioner path) + test. ✓
- "config env (LMSTUDIO_BASE_URL/MODEL/timeout/maxEdge), host.docker.internal" → Task 3, Task 5. ✓
- "tests never need LM Studio/Docker" → Task 1 (`fetchImpl` stub), Task 2 (injected captioner). ✓

**Placeholder scan:** No TBD/TODO. The manual smoke (Task 4 Step 4) and blog follow-up are intentionally manual/out-of-scope and fully enumerated, not placeholders. The `<your-slug>` in the smoke curl is a user-supplied value, not a plan gap.

**Type consistency:** `Caption {altEn,altDe,slug}` defined in Task 1, consumed in Task 2's `Captioner` and Task 3's wiring. `ServerConfig` gains `captioner?`/`captionMaxEdge?` in Task 2, set in Task 3. `/suggest` row shape is identical in the Task 2 test and handler. `/upload` response `{src,width,height}` (from existing `storage.ts` `StoredImage`) consumed by Task 4's `tag()`. `KEY_RE` matches the server's existing rule. ✓
