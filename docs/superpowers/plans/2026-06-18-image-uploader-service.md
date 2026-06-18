# Image Uploader Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small Dockerized service that accepts a photo upload, generates responsive AVIF/WebP variants with `sharp` (preserving EXIF/GPS), stores them on the user's server, and returns a ready-to-paste `heroImage` YAML snippet. The same pipeline is exposed as a batch CLI for Phase 2 migration.

**Architecture:** Fastify HTTP server + `sharp`. Core logic is split into pure, testable modules (`variants`, `pipeline`, `storage`, `auth`); `server.ts` wires them into routes; `main.ts` boots it; `cli.ts` reuses the pipeline for batch runs. Files are written to a mounted volume and served with immutable cache headers; the user's reverse proxy maps `img.simonswanderlust.com` → the container with TLS.

**Tech Stack:** Node 22, TypeScript (run directly via `tsx`), Fastify 5, `@fastify/multipart`, `@fastify/static`, `sharp`, Vitest, Docker.

**Repo:** This is a **new, separate repository** (suggested name `simonswanderlust-images`). All paths below are relative to that new repo's root — NOT the blog repo. Create it with `git init` first.

**Contract (MUST match the blog-side plan):** widths `[640, 1280, 1920]`, formats `avif` + `webp`, filename pattern `{key}-{width}.{format}`, and `variantWidths()` returning standard widths below the source plus the intrinsic width (never upscaling). Source of truth: `docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md` (in the blog repo).

---

## File Structure

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.dockerignore`, `.env.example` — project scaffold.
- `src/variants.ts` — `WIDTHS`, `FORMATS`, `ImageFormat`, `variantWidths()`. The contract, mirrored from the blog.
- `src/pipeline.ts` — `processImage(buffer)` → `{width, height, variants[]}` using `sharp` (rotate + preserve metadata + resize + encode).
- `src/storage.ts` — `storeVariants(key, alt, result, opts)` → writes files, builds the `heroImage` snippet.
- `src/auth.ts` — `isAuthorized(header, token)` bearer-token check.
- `src/server.ts` — `buildServer(config)` Fastify app: `POST /upload`, static image serving, admin page.
- `src/main.ts` — boot entrypoint (reads env, listens).
- `src/cli.ts` — batch entrypoint reusing the pipeline + storage.
- `public/admin.html` — drag-drop upload UI.
- `test/*.test.ts` — unit/integration tests per module.
- `Dockerfile`, `docker-compose.yml`, `README.md` — packaging + deploy.

---

## Task 0: Scaffold the repository

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.dockerignore`, `.env.example`

- [ ] **Step 1: Initialize the repo**

Run: `git init && node --version`
Expected: empty git repo; Node ≥ 22 printed.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "simonswanderlust-images",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "start": "tsx src/main.ts",
    "dev": "tsx watch src/main.ts",
    "upload": "tsx src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/multipart": "^9.0.3",
    "@fastify/static": "^8.1.1",
    "fastify": "^5.2.1",
    "sharp": "^0.34.1",
    "tsx": "^4.19.2"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "form-data": "^4.0.1",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
data/
.env
*.log
```

- [ ] **Step 6: Create `.dockerignore`**

```
node_modules
data
.git
.env
```

- [ ] **Step 7: Create `.env.example`**

```
# Bearer token required for uploads. Generate a long random value.
AUTH_TOKEN=change-me-to-a-long-random-string
# Public base URL where images are served (your img. subdomain).
PUBLIC_BASE_URL=https://img.simonswanderlust.com
# Where variants are written inside the container (mounted volume).
STORAGE_DIR=/data/images
PORT=3000
```

- [ ] **Step 8: Install and commit**

Run: `npm install`
Expected: dependencies install (sharp downloads its prebuilt binary).

```bash
git add -A
git commit -m "chore: scaffold image uploader service

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: The width contract (`variants.ts`)

**Files:**
- Create: `src/variants.ts`
- Test: `test/variants.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/variants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { variantWidths, WIDTHS, FORMATS } from '../src/variants';

describe('variantWidths', () => {
  it('keeps standard widths below the source and appends the intrinsic width', () => {
    expect(variantWidths(2560)).toEqual([640, 1280, 1920, 2560]);
  });
  it('never upscales (drops standards >= source)', () => {
    expect(variantWidths(768)).toEqual([640, 768]);
  });
  it('returns only the intrinsic width when smaller than all standards', () => {
    expect(variantWidths(500)).toEqual([500]);
  });
});

describe('contract constants', () => {
  it('matches the blog-side contract', () => {
    expect(WIDTHS).toEqual([640, 1280, 1920]);
    expect(FORMATS).toEqual(['avif', 'webp']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- variants`
Expected: FAIL — cannot find module `../src/variants`.

- [ ] **Step 3: Write minimal implementation**

Create `src/variants.ts`:

```ts
/**
 * Image variant contract. MUST stay identical to the blog's
 * site/src/lib/images.ts so generated filenames and the srcset match.
 * Spec: docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md
 */
export const WIDTHS = [640, 1280, 1920] as const;
export const FORMATS = ['avif', 'webp'] as const;
export type ImageFormat = (typeof FORMATS)[number];

/** Standard widths smaller than the source, plus the source's own width. Never upscales. */
export function variantWidths(
  intrinsicWidth: number,
  widths: readonly number[] = WIDTHS,
): number[] {
  const smaller = widths.filter((w) => w < intrinsicWidth);
  return [...smaller, intrinsicWidth];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- variants`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/variants.ts test/variants.test.ts
git commit -m "feat: width/format contract

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The sharp pipeline (`pipeline.ts`)

**Files:**
- Create: `src/pipeline.ts`
- Test: `test/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/pipeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { processImage } from '../src/pipeline';

async function fixture(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } },
  })
    .withExif({ IFD0: { ImageDescription: 'fixture' }, GPS: { GPSLatitudeRef: 'N' } })
    .jpeg()
    .toBuffer();
}

describe('processImage', () => {
  it('reports intrinsic dimensions', async () => {
    const result = await processImage(await fixture(2000, 1000));
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1000);
  });

  it('produces avif+webp at each contract width, no upscaling', async () => {
    const result = await processImage(await fixture(2000, 1000));
    const widths = [...new Set(result.variants.map((v) => v.width))].sort((a, b) => a - b);
    expect(widths).toEqual([640, 1280, 1920, 2000]);
    expect(result.variants.filter((v) => v.format === 'avif')).toHaveLength(4);
    expect(result.variants.filter((v) => v.format === 'webp')).toHaveLength(4);
    expect(Math.max(...widths)).toBe(2000); // never exceeds source
  });

  it('only emits the intrinsic width for tiny sources', async () => {
    const result = await processImage(await fixture(500, 400));
    expect([...new Set(result.variants.map((v) => v.width))]).toEqual([500]);
  });

  it('preserves EXIF metadata (incl. GPS) in output variants', async () => {
    const result = await processImage(await fixture(2000, 1000));
    const v = result.variants.find((x) => x.format === 'webp' && x.width === 640)!;
    const meta = await sharp(v.data).metadata();
    expect(meta.exif).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pipeline`
Expected: FAIL — cannot find module `../src/pipeline`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pipeline.ts`:

```ts
import sharp from 'sharp';
import { variantWidths, FORMATS, type ImageFormat } from './variants.js';

export interface Variant {
  width: number;
  format: ImageFormat;
  data: Buffer;
}

export interface ProcessResult {
  width: number;
  height: number;
  variants: Variant[];
}

export interface ProcessOptions {
  avifQuality?: number;
  webpQuality?: number;
}

/**
 * Auto-orients via EXIF, preserves all metadata (incl. GPS), and encodes
 * AVIF + WebP at each contract width without upscaling.
 */
export async function processImage(
  input: Buffer,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const { avifQuality = 55, webpQuality = 75 } = opts;

  // Read orientation-corrected intrinsic size from a probe.
  const probe = await sharp(input, { failOn: 'none' })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const width = probe.info.width;
  const height = probe.info.height;

  const variants: Variant[] = [];
  for (const w of variantWidths(width)) {
    for (const format of FORMATS) {
      const base = sharp(input, { failOn: 'none' })
        .rotate()
        .withMetadata() // keep EXIF (GPS), capture time, ICC
        .resize({ width: w, withoutEnlargement: true });
      const data =
        format === 'avif'
          ? await base.avif({ quality: avifQuality }).toBuffer()
          : await base.webp({ quality: webpQuality }).toBuffer();
      variants.push({ width: w, format, data });
    }
  }

  return { width, height, variants };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pipeline`
Expected: PASS (4 tests). Note: requires libvips with AVIF/WebP+EXIF support — the prebuilt `sharp` binary used here includes it.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "feat: sharp pipeline (responsive avif/webp, metadata preserved)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Storage + snippet (`storage.ts`)

**Files:**
- Create: `src/storage.ts`
- Test: `test/storage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/storage.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeVariants } from '../src/storage';
import type { ProcessResult } from '../src/pipeline';

const result: ProcessResult = {
  width: 2000,
  height: 1000,
  variants: [
    { width: 640, format: 'avif', data: Buffer.from('a') },
    { width: 640, format: 'webp', data: Buffer.from('b') },
    { width: 2000, format: 'avif', data: Buffer.from('c') },
    { width: 2000, format: 'webp', data: Buffer.from('d') },
  ],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgstore-'));
});

describe('storeVariants', () => {
  it('writes one file per variant under the key path', async () => {
    await storeVariants('trips/bucharest-2024/hero', 'Old town', result, {
      storageDir: dir,
      baseUrl: 'https://img.simonswanderlust.com',
    });
    const files = await readdir(join(dir, 'trips', 'bucharest-2024'));
    expect(files.sort()).toEqual([
      'hero-2000.avif',
      'hero-2000.webp',
      'hero-640.avif',
      'hero-640.webp',
    ]);
  });

  it('returns the heroImage YAML snippet', async () => {
    const stored = await storeVariants('trips/x/hero', "O'Brien's view", result, {
      storageDir: dir,
      baseUrl: 'https://img.simonswanderlust.com/',
    });
    expect(stored.src).toBe('https://img.simonswanderlust.com/trips/x/hero');
    expect(stored.snippet).toBe(
      [
        'heroImage:',
        "  src: 'https://img.simonswanderlust.com/trips/x/hero'",
        '  width: 2000',
        '  height: 1000',
        "  alt: 'O''Brien''s view'",
      ].join('\n'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- storage`
Expected: FAIL — cannot find module `../src/storage`.

- [ ] **Step 3: Write minimal implementation**

Create `src/storage.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProcessResult } from './pipeline.js';

export interface StorageOptions {
  storageDir: string;
  baseUrl: string;
}

export interface StoredImage {
  src: string;
  width: number;
  height: number;
  files: string[];
  snippet: string;
}

export async function storeVariants(
  key: string,
  alt: string,
  result: ProcessResult,
  { storageDir, baseUrl }: StorageOptions,
): Promise<StoredImage> {
  const files: string[] = [];
  for (const v of result.variants) {
    const rel = `${key}-${v.width}.${v.format}`;
    const abs = join(storageDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, v.data);
    files.push(rel);
  }

  const src = `${baseUrl.replace(/\/+$/, '')}/${key}`;
  const snippet = [
    'heroImage:',
    `  src: '${src}'`,
    `  width: ${result.width}`,
    `  height: ${result.height}`,
    `  alt: '${alt.replace(/'/g, "''")}'`, // YAML single-quote escaping
  ].join('\n');

  return { src, width: result.width, height: result.height, files, snippet };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- storage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts test/storage.test.ts
git commit -m "feat: variant storage + heroImage snippet

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Auth (`auth.ts`)

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../src/auth';

describe('isAuthorized', () => {
  it('accepts the correct bearer token', () => {
    expect(isAuthorized('Bearer secret', 'secret')).toBe(true);
  });
  it('rejects a wrong token', () => {
    expect(isAuthorized('Bearer nope', 'secret')).toBe(false);
  });
  it('rejects a missing header', () => {
    expect(isAuthorized(undefined, 'secret')).toBe(false);
  });
  it('rejects when no token is configured', () => {
    expect(isAuthorized('Bearer secret', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- auth`
Expected: FAIL — cannot find module `../src/auth`.

- [ ] **Step 3: Write minimal implementation**

Create `src/auth.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';

/** Constant-time bearer-token check. Returns false if no token is configured. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat: bearer-token auth

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: HTTP server (`server.ts`, `main.ts`, admin page)

**Files:**
- Create: `src/server.ts`
- Create: `src/main.ts`
- Create: `public/admin.html`
- Test: `test/server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/server.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildServer } from '../src/server';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgsrv-'));
});

function app() {
  return buildServer({ storageDir: dir, baseUrl: 'https://img.simonswanderlust.com', authToken: 'secret' });
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 1000, height: 800, channels: 3, background: '#444' } }).jpeg().toBuffer();
}

describe('POST /upload', () => {
  it('401 without auth', async () => {
    const form = new FormData();
    form.append('key', 'trips/t/hero');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await app().inject({ method: 'POST', url: '/upload', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('400 for a non-image', async () => {
    const form = new FormData();
    form.append('key', 'trips/t/hero');
    form.append('file', Buffer.from('not an image'), { filename: 't.txt', contentType: 'text/plain' });
    const res = await app().inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(400);
  });

  it('200 + snippet for a valid upload', async () => {
    const form = new FormData();
    form.append('key', 'trips/bucharest-2024/hero');
    form.append('alt', 'Old town');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await app().inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.src).toBe('https://img.simonswanderlust.com/trips/bucharest-2024/hero');
    expect(body.snippet).toContain("alt: 'Old town'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- server`
Expected: FAIL — cannot find module `../src/server`.

- [ ] **Step 3: Write the server**

Create `src/server.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { processImage } from './pipeline.js';
import { storeVariants } from './storage.js';
import { isAuthorized } from './auth.js';

export interface ServerConfig {
  storageDir: string;
  baseUrl: string;
  authToken: string;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_-]*$/;

export function buildServer(cfg: ServerConfig): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  const here = dirname(fileURLToPath(import.meta.url));
  app.register(fastifyStatic, { root: join(here, '..', 'public'), prefix: '/admin/' });
  app.register(fastifyStatic, {
    root: cfg.storageDir,
    prefix: '/',
    decorateReply: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'),
  });

  app.get('/', (_req, reply) => reply.redirect('/admin/'));

  app.post('/upload', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    let key = '';
    let alt = '';
    let buf: Buffer | undefined;
    let mimetype = '';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        mimetype = part.mimetype;
        buf = await part.toBuffer();
      } else if (part.fieldname === 'key') {
        key = String(part.value).trim();
      } else if (part.fieldname === 'alt') {
        alt = String(part.value).trim();
      }
    }
    if (!buf || !mimetype.startsWith('image/')) {
      return reply.code(400).send({ error: 'expected an image file' });
    }
    if (!KEY_RE.test(key)) {
      return reply.code(400).send({ error: 'invalid key (use lowercase a-z, 0-9, / _ -)' });
    }
    const result = await processImage(buf);
    const stored = await storeVariants(key, alt, result, cfg);
    return reply.send(stored);
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- server`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the boot entrypoint**

Create `src/main.ts`:

```ts
import { buildServer } from './server.js';

const authToken = process.env.AUTH_TOKEN ?? '';
if (!authToken) {
  console.error('AUTH_TOKEN is required; refusing to start without it.');
  process.exit(1);
}

const app = buildServer({
  storageDir: process.env.STORAGE_DIR ?? '/data/images',
  baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  authToken,
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

- [ ] **Step 6: Create the admin page**

Create `public/admin.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Image Uploader</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
      label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
      input { width: 100%; padding: 0.5rem; }
      button { margin-top: 1rem; padding: 0.6rem 1rem; font-weight: 600; }
      pre { background: #f4f4f6; padding: 1rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>Image Uploader</h1>
    <label for="token">Auth token</label>
    <input id="token" type="password" placeholder="Bearer token" />
    <label for="key">Key (e.g. trips/bucharest-2024/hero)</label>
    <input id="key" type="text" />
    <label for="alt">Alt text</label>
    <input id="alt" type="text" />
    <label for="file">Photo</label>
    <input id="file" type="file" accept="image/*" />
    <button id="go">Upload</button>
    <h2>heroImage snippet</h2>
    <pre id="out">—</pre>
    <script>
      document.getElementById('go').addEventListener('click', async () => {
        const out = document.getElementById('out');
        const file = document.getElementById('file').files[0];
        if (!file) { out.textContent = 'Pick a file first.'; return; }
        const fd = new FormData();
        fd.append('key', document.getElementById('key').value);
        fd.append('alt', document.getElementById('alt').value);
        fd.append('file', file);
        out.textContent = 'Uploading…';
        try {
          const res = await fetch('/upload', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + document.getElementById('token').value },
            body: fd,
          });
          const body = await res.json();
          out.textContent = res.ok ? body.snippet : 'Error: ' + (body.error || res.status);
        } catch (e) {
          out.textContent = 'Error: ' + e;
        }
      });
    </script>
  </body>
</html>
```

- [ ] **Step 7: Manual smoke check**

Run: `AUTH_TOKEN=secret STORAGE_DIR=./data/images PUBLIC_BASE_URL=http://localhost:3000 npm start` (background), then:

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/admin/`
Expected: `200` (admin page served). Stop the server.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/main.ts public/admin.html test/server.test.ts
git commit -m "feat: upload endpoint, boot entrypoint, admin UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Batch CLI (`cli.ts`)

The CLI reuses the same pipeline + storage so Phase 2 migration produces identical variants.

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.ts` (tests the reusable function the CLI wraps):

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { uploadFile } from '../src/cli';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgcli-'));
});

describe('uploadFile', () => {
  it('processes a buffer and writes variants, returning the snippet', async () => {
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#222' } })
      .jpeg().toBuffer();
    const stored = await uploadFile(img, 'trips/test/hero', 'A test', {
      storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    });
    const files = await readdir(join(dir, 'trips', 'test'));
    expect(files.sort()).toEqual(['hero-640.avif', 'hero-640.webp', 'hero-800.avif', 'hero-800.webp']);
    expect(stored.snippet).toContain("src: 'https://img.simonswanderlust.com/trips/test/hero'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- cli`
Expected: FAIL — cannot find module `../src/cli`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { processImage } from './pipeline.js';
import { storeVariants, type StorageOptions, type StoredImage } from './storage.js';

/** Reusable: process an in-memory image and store its variants. */
export async function uploadFile(
  input: Buffer,
  key: string,
  alt: string,
  opts: StorageOptions,
): Promise<StoredImage> {
  const result = await processImage(input);
  return storeVariants(key, alt, result, opts);
}

async function main(): Promise<void> {
  const [, , file, key, alt = ''] = process.argv;
  if (!file || !key) {
    console.error('usage: npm run upload -- <imageFile> <key> [alt]');
    process.exit(1);
  }
  const opts: StorageOptions = {
    storageDir: process.env.STORAGE_DIR ?? './data/images',
    baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  };
  const stored = await uploadFile(await readFile(file), key, alt, opts);
  console.log(stored.snippet);
}

// Run main only when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('cli.ts')) {
  await main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- cli`
Expected: PASS.

- [ ] **Step 5: Full test + typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites pass; `tsc --noEmit` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: batch CLI reusing the pipeline (Phase 2 migration)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Docker packaging

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `README.md`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV STORAGE_DIR=/data/images
ENV PORT=3000
VOLUME ["/data/images"]
EXPOSE 3000

CMD ["npm", "start"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  images:
    build: .
    ports:
      - "3000:3000"
    environment:
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-https://img.simonswanderlust.com}
      AUTH_TOKEN: ${AUTH_TOKEN:?set AUTH_TOKEN in .env}
    volumes:
      - ./data/images:/data/images
    restart: unless-stopped
```

- [ ] **Step 3: Create `README.md`**

```markdown
# simonswanderlust-images

Self-hosted image uploader for the Astro blog. Uploads a photo, generates
responsive AVIF/WebP variants (EXIF/GPS preserved), stores them on this
server, and returns a `heroImage` YAML snippet to paste into a post.

## Contract
Filenames: `{key}-{width}.{format}` at widths 640/1280/1920 (plus the source's
own width, never upscaled), formats `avif` + `webp`. Must match the blog's
`site/src/lib/images.ts`.

## Run (Docker)
1. `cp .env.example .env` and set a long random `AUTH_TOKEN`.
2. `docker compose up -d --build`
3. Put your reverse proxy in front: map `https://img.simonswanderlust.com` →
   this container's port 3000, terminate TLS there.
4. Open `https://img.simonswanderlust.com/admin/`, enter the token, upload.

## Batch (Phase 2 migration)
`STORAGE_DIR=./data/images PUBLIC_BASE_URL=https://img.simonswanderlust.com npm run upload -- ./photo.jpg trips/bucharest-2024/hero "Old town at dusk"`

## Develop
`npm install` · `npm test` · `npm run dev`
```

- [ ] **Step 4: Container smoke test**

Run:
```bash
docker compose build
AUTH_TOKEN=secret docker compose up -d
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/admin/
```
Expected: `200`.

- [ ] **Step 5: End-to-end upload through the container**

Run:
```bash
printf '\xff\xd8\xff' > /dev/null # (use a real jpg) ; \
curl -s -X POST http://localhost:3000/upload \
  -H "authorization: Bearer secret" \
  -F key=trips/smoke/hero -F alt=smoke \
  -F file=@test/fixtures/sample.jpg
```
First create the fixture: `mkdir -p test/fixtures && node -e "require('sharp')({create:{width:1200,height:800,channels:3,background:'#345'}}).jpeg().toFile('test/fixtures/sample.jpg')"`
Expected: JSON containing `"src":"https://img.simonswanderlust.com/trips/smoke/hero"` and a `snippet`. Then:

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/trips/smoke/hero-640.webp`
Expected: `200` (the served variant). Then `docker compose down`.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml README.md test/fixtures/sample.jpg
git commit -m "feat: docker packaging + deploy docs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Deploy + DNS (manual, on the user's server)

These steps run on the user's own server and depend on their reverse proxy; they are described, not automated.

- [ ] **Step 1: Provision the subdomain.** Create a DNS A/AAAA record for `img.simonswanderlust.com` pointing at the server.
- [ ] **Step 2: Deploy.** Copy the repo to the server, `cp .env.example .env`, set a long random `AUTH_TOKEN` and `PUBLIC_BASE_URL=https://img.simonswanderlust.com`, then `docker compose up -d --build`.
- [ ] **Step 3: Reverse proxy + TLS.** Configure the existing proxy (nginx/Caddy/Traefik) to route `img.simonswanderlust.com` → `127.0.0.1:3000` with TLS (e.g. Let's Encrypt). Confirm `https://img.simonswanderlust.com/admin/` loads.
- [ ] **Step 4: Seed the two sample images** so the blog's existing sample posts resolve:
  - `npm run upload -- <rhodos.jpg> trips/rhodes-2021/hero "Rhodes coastline in summer light"`
  - `npm run upload -- <bucharest.jpg> trips/bucharest-2024/hero "Bucharest old town at dusk"`
- [ ] **Step 5: Verify end-to-end.** Load the blog (built from the blog-side plan) and confirm hero images render from `img.simonswanderlust.com`.

---

## Self-Review

**Spec coverage:**
- "Node + sharp, single Docker container, mounted volume" → Tasks 0, 2, 7. ✓
- "auth-protected admin drag-drop page" → Task 5 (`/admin/` + auth on `/upload`). ✓
- "POST /upload: slug + alt; sharp rotate, preserve EXIF/GPS, AVIF+WebP 640/1280/1920, no upscale, intrinsic dims; return YAML snippet" → Tasks 2, 3, 5. ✓
- "serve with immutable cache headers" → Task 5 (`setHeaders`). ✓
- "config via env (storage, base URL, sizes, auth)" → Tasks 0, 5. ✓
- "idempotent re-upload (overwrite)" → Task 3 (`writeFile` overwrites same key). ✓
- "Phase-2 reuse: HTTP + batch CLI from one pipeline" → Task 6. ✓
- "EXIF/metadata incl. GPS preserved" → Task 2 (`withMetadata`) + test. ✓
- "tests: pipeline (variants/dims/metadata/no-upscale), auth, upload happy/reject, container smoke" → Tasks 1–7. ✓

**Placeholder scan:** No TBD/TODO; every code block is complete; deploy specifics in Task 8 are intentionally manual (server-dependent) and fully enumerated.

**Type consistency:** `ProcessResult {width,height,variants}` defined in Task 2, consumed identically in Tasks 3, 5, 6. `StorageOptions`/`StoredImage` defined in Task 3, reused in Tasks 5, 6. `variantWidths`/`WIDTHS`/`FORMATS` defined in Task 1, used in Task 2. `buildServer(ServerConfig)` defined in Task 5, used in its test and `main.ts`. `isAuthorized(header, token)` defined Task 4, used Task 5. ✓

**Cross-plan contract check:** `WIDTHS=[640,1280,1920]`, `FORMATS=['avif','webp']`, filename `{key}-{w}.{fmt}`, and `variantWidths` logic are byte-for-byte the same rule as the blog-side `images.ts` — so generated files match the blog's `srcset`. ✓
