# Uploader Username/Password Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the uploader's single shared `AUTH_TOKEN` with named username/password accounts (login page + HttpOnly session cookie, admin/author roles), backed by Postgres.

**Architecture:** Auth is split into focused modules behind interfaces — `users.ts` (scrypt hashing + `UserStore`), `sessions.ts` (`SessionStore`), `authn.ts` (cookie + Fastify hooks), `db.ts` (pg pool + schema). Each store has a Postgres implementation (prod) and an in-memory implementation (tests), so unit tests need no live DB. `server.ts` gains login/logout/setup/users routes and switches existing routes from bearer to session auth.

**Tech Stack:** Node 22, Fastify 5, `@fastify/cookie`, `pg` (node-postgres), Postgres 17, Node built-in `crypto` (scrypt), Vitest.

## Global Constraints

- Node `>=22.12.0`; ESM (`"type": "module"`), import local files with `.js` extension.
- Strict TypeScript: no `any`, no `@ts-ignore`. Prefer named exports.
- Tests must pass with **no live services** (no Postgres, no LM Studio) — use in-memory stores. A Postgres-backed integration test is **guarded** by `TEST_DATABASE_URL` and skipped otherwise.
- Passwords stored **only** as scrypt hashes, format `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`. Compare with `crypto.timingSafeEqual`.
- Session cookie name `sid`; value = 32 random bytes hex; DB stores `sha256(token)` as the row id. Cookie flags: `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=2592000` (30 days), `Secure` only when `req.protocol === 'https'`.
- `AUTH_TOKEN` is removed entirely from code, compose, env, and docs.
- Login failures return generic `401 {error:'invalid username or password'}` (no user enumeration). Non-admin on an admin route → `403 {error:'forbidden'}`. Anonymous on a protected route → `401 {error:'unauthorized'}`.
- Static admin HTML/CSS/JS/fonts are public (no secrets); the gate is on data/action endpoints. `GET /auth/status` and `GET /login` are public.
- Run `npm run typecheck` and `npm test` from `uploader/` before each commit. Commit messages: `type(scope): desc`.

---

### Task 1: Dependencies, Postgres container, env

**Files:**
- Modify: `uploader/package.json` (deps)
- Modify: `docker-compose.yml` (root — add `db`, wire `DATABASE_URL`, drop `AUTH_TOKEN`)
- Modify: `uploader/docker-compose.yml` (same, standalone)
- Modify: `uploader/.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `pg`, `@fastify/cookie` importable; `DATABASE_URL` available to the container.

- [ ] **Step 1: Install dependencies**

Run (from `uploader/`):
```bash
npm install pg @fastify/cookie
npm install -D @types/pg
```
Expected: `package.json` now lists `pg` and `@fastify/cookie` under dependencies and `@types/pg` under devDependencies; `npm install` exits 0.

- [ ] **Step 2: Add the `db` service to the root compose**

In `docker-compose.yml`, add a `db` service and a `pgdata` volume, and wire the `images` service. Replace the `images` `environment:` block's `AUTH_TOKEN` line with `DATABASE_URL`, and add `depends_on`:

```yaml
  images:
    build: ./uploader
    ports:
      - "3000:3000"
    environment:
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-https://img.simonswanderlust.com}
      DATABASE_URL: ${DATABASE_URL:-postgres://images:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@db:5432/images}
      LMSTUDIO_BASE_URL: ${LMSTUDIO_BASE_URL:-http://localhost:1234/v1}
      LMSTUDIO_MODEL: ${LMSTUDIO_MODEL:-qwen/qwen3-vl-4b}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./uploader/data:/data
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-images}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: ${POSTGRES_DB:-images}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-images} -d ${POSTGRES_DB:-images}"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

volumes:
  pgdata:
```
(Keep the existing `blog` service unchanged.)

- [ ] **Step 3: Mirror in the standalone uploader compose**

In `uploader/docker-compose.yml`, apply the same `db` service, `pgdata` volume, `depends_on`, and the `AUTH_TOKEN`→`DATABASE_URL` swap (the `db` host is `db`, the images volume is `./data:/data`).

- [ ] **Step 4: Update `.env.example`**

Replace the `AUTH_TOKEN` line with Postgres settings:
```bash
# Postgres (the db container). Set a strong password.
POSTGRES_USER=images
POSTGRES_PASSWORD=change-me-to-a-long-random-string
POSTGRES_DB=images
# Connection string the uploader uses. In Docker the host is "db"; for local
# `npm run dev` against a local Postgres use 127.0.0.1.
DATABASE_URL=postgres://images:change-me-to-a-long-random-string@db:5432/images
# Public base URL where images are served (your img. subdomain).
PUBLIC_BASE_URL=https://img.simonswanderlust.com
# ... (leave STORAGE_DIR/PORT/LMSTUDIO_* lines unchanged)
```

- [ ] **Step 5: Validate compose + typecheck**

Run:
```bash
docker compose -f ../docker-compose.yml config >/dev/null && echo COMPOSE_OK
npm run typecheck
```
Expected: `COMPOSE_OK`; typecheck passes (no code changed yet).

- [ ] **Step 6: Commit**

```bash
git add uploader/package.json uploader/package-lock.json docker-compose.yml uploader/docker-compose.yml uploader/.env.example
git commit -m "build(uploader): add pg + cookie deps and Postgres container, drop AUTH_TOKEN from config"
```

---

### Task 2: Password hashing (scrypt)

**Files:**
- Create: `uploader/src/users.ts`
- Test: `uploader/test/users.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `hashPassword(password: string): string`, `verifyPassword(password: string, stored: string): boolean`.

- [ ] **Step 1: Write the failing test**

`uploader/test/users.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/users.js';

describe('password hashing', () => {
  it('produces a scrypt string that is not the plaintext', () => {
    const h = hashPassword('hunter2');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('hunter2');
  });
  it('verifies the correct password and rejects a wrong one', () => {
    const h = hashPassword('hunter2');
    expect(verifyPassword('hunter2', h)).toBe(true);
    expect(verifyPassword('nope', h)).toBe(false);
  });
  it('rejects a malformed stored hash', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/users.test.ts`
Expected: FAIL — cannot import `hashPassword` from `../src/users.js`.

- [ ] **Step 3: Write minimal implementation**

`uploader/src/users.ts`:
```ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, ns, rs, ps, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = scryptSync(password, salt, expected.length, { N: Number(ns), r: Number(rs), p: Number(ps) });
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/users.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add uploader/src/users.ts uploader/test/users.test.ts
git commit -m "feat(uploader): scrypt password hashing helpers"
```

---

### Task 3: UserStore interface + in-memory implementation

**Files:**
- Modify: `uploader/src/users.ts`
- Test: `uploader/test/users.test.ts`

**Interfaces:**
- Consumes: `hashPassword` (Task 2).
- Produces:
  - `interface User { id: string; username: string; passwordHash: string; isAdmin: boolean; createdAt: Date }`
  - `interface NewUser { username: string; password: string; isAdmin: boolean }`
  - `class UserExistsError extends Error`
  - `interface UserStore { count(): Promise<number>; countAdmins(): Promise<number>; findByUsername(u: string): Promise<User|null>; findById(id: string): Promise<User|null>; list(): Promise<User[]>; create(u: NewUser): Promise<User>; remove(id: string): Promise<void> }`
  - `function memoryUserStore(): UserStore`

- [ ] **Step 1: Write the failing test (append to `users.test.ts`)**

```ts
import { memoryUserStore, UserExistsError } from '../src/users.js';

describe('memoryUserStore', () => {
  it('creates, counts, finds (case-insensitive) and lists', async () => {
    const s = memoryUserStore();
    expect(await s.count()).toBe(0);
    const u = await s.create({ username: 'Simon', password: 'pw', isAdmin: true });
    expect(u.isAdmin).toBe(true);
    expect(await s.count()).toBe(1);
    expect(await s.countAdmins()).toBe(1);
    expect((await s.findByUsername('simon'))?.id).toBe(u.id);
    expect((await s.findById(u.id))?.username).toBe('Simon');
    expect(await s.list()).toHaveLength(1);
  });
  it('rejects a duplicate username case-insensitively', async () => {
    const s = memoryUserStore();
    await s.create({ username: 'Simon', password: 'pw', isAdmin: false });
    await expect(s.create({ username: 'simon', password: 'x', isAdmin: false })).rejects.toBeInstanceOf(UserExistsError);
  });
  it('removes a user', async () => {
    const s = memoryUserStore();
    const u = await s.create({ username: 'a', password: 'pw', isAdmin: false });
    await s.remove(u.id);
    expect(await s.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/users.test.ts`
Expected: FAIL — `memoryUserStore`/`UserExistsError` not exported.

- [ ] **Step 3: Write minimal implementation (append to `users.ts`)**

```ts
import { randomUUID } from 'node:crypto';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: Date;
}
export interface NewUser {
  username: string;
  password: string;
  isAdmin: boolean;
}
export class UserExistsError extends Error {}

export interface UserStore {
  count(): Promise<number>;
  countAdmins(): Promise<number>;
  findByUsername(username: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  list(): Promise<User[]>;
  create(u: NewUser): Promise<User>;
  remove(id: string): Promise<void>;
}

export function memoryUserStore(): UserStore {
  const byId = new Map<string, User>();
  const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return {
    async count() { return byId.size; },
    async countAdmins() { return [...byId.values()].filter((u) => u.isAdmin).length; },
    async findByUsername(username) {
      return [...byId.values()].find((u) => sameName(u.username, username)) ?? null;
    },
    async findById(id) { return byId.get(id) ?? null; },
    async list() {
      return [...byId.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async create({ username, password, isAdmin }) {
      if ([...byId.values()].some((u) => sameName(u.username, username))) {
        throw new UserExistsError('username already exists');
      }
      const user: User = { id: randomUUID(), username, passwordHash: hashPassword(password), isAdmin, createdAt: new Date() };
      byId.set(user.id, user);
      return user;
    },
    async remove(id) { byId.delete(id); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/users.test.ts`
Expected: PASS (all users tests).

- [ ] **Step 5: Commit**

```bash
git add uploader/src/users.ts uploader/test/users.test.ts
git commit -m "feat(uploader): UserStore interface + in-memory store"
```

---

### Task 4: SessionStore interface + in-memory implementation

**Files:**
- Create: `uploader/src/sessions.ts`
- Test: `uploader/test/sessions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function hashToken(raw: string): string` (sha256 hex)
  - `interface Session { id: string; userId: string; expiresAt: Date }`
  - `interface SessionStore { create(userId: string, ttlMs: number): Promise<string>; find(rawToken: string): Promise<Session|null>; destroy(rawToken: string): Promise<void>; sweepExpired(): Promise<void> }`
  - `function memorySessionStore(): SessionStore`

- [ ] **Step 1: Write the failing test**

`uploader/test/sessions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { memorySessionStore, hashToken } from '../src/sessions.js';

describe('memorySessionStore', () => {
  it('creates a token and finds the session by the raw token', async () => {
    const s = memorySessionStore();
    const token = await s.create('user-1', 60_000);
    expect(typeof token).toBe('string');
    const found = await s.find(token);
    expect(found?.userId).toBe('user-1');
  });
  it('returns null for an unknown or empty token', async () => {
    const s = memorySessionStore();
    expect(await s.find('nope')).toBeNull();
    expect(await s.find('')).toBeNull();
  });
  it('treats an expired session as not found', async () => {
    const s = memorySessionStore();
    const token = await s.create('user-1', -1); // already expired
    expect(await s.find(token)).toBeNull();
  });
  it('destroys a session', async () => {
    const s = memorySessionStore();
    const token = await s.create('user-1', 60_000);
    await s.destroy(token);
    expect(await s.find(token)).toBeNull();
  });
  it('hashToken is deterministic and not the raw token', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe('abc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`uploader/src/sessions.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface SessionStore {
  create(userId: string, ttlMs: number): Promise<string>;
  find(rawToken: string): Promise<Session | null>;
  destroy(rawToken: string): Promise<void>;
  sweepExpired(): Promise<void>;
}

export function memorySessionStore(): SessionStore {
  const byHash = new Map<string, Session>();
  return {
    async create(userId, ttlMs) {
      const raw = randomBytes(32).toString('hex');
      const id = hashToken(raw);
      byHash.set(id, { id, userId, expiresAt: new Date(Date.now() + ttlMs) });
      return raw;
    },
    async find(rawToken) {
      if (!rawToken) return null;
      const id = hashToken(rawToken);
      const s = byHash.get(id);
      if (!s) return null;
      if (s.expiresAt.getTime() <= Date.now()) { byHash.delete(id); return null; }
      return s;
    },
    async destroy(rawToken) {
      if (rawToken) byHash.delete(hashToken(rawToken));
    },
    async sweepExpired() {
      const now = Date.now();
      for (const [k, v] of byHash) if (v.expiresAt.getTime() <= now) byHash.delete(k);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sessions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add uploader/src/sessions.ts uploader/test/sessions.test.ts
git commit -m "feat(uploader): SessionStore interface + in-memory store"
```

---

### Task 5: Auth hooks, cookie helpers, status

**Files:**
- Create: `uploader/src/authn.ts`
- Test: `uploader/test/authn.test.ts`

**Interfaces:**
- Consumes: `UserStore`, `User` (Task 3); `SessionStore` (Task 4).
- Produces:
  - `const SESSION_COOKIE = 'sid'`, `const SESSION_TTL_MS = 2_592_000_000`
  - `interface AuthUser { id: string; username: string; isAdmin: boolean }`
  - `function isSecureRequest(req: FastifyRequest): boolean`
  - `function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void`
  - `function clearSessionCookie(reply: FastifyReply): void`
  - `function loadUser(req: FastifyRequest, users: UserStore, sessions: SessionStore): Promise<AuthUser|null>`
  - `function requireAuth(req: FastifyRequest, reply: FastifyReply): void`
  - `function requireAdmin(req: FastifyRequest, reply: FastifyReply): void`
  - Module augmentation adding `authUser: AuthUser | null` to `FastifyRequest`.

- [ ] **Step 1: Write the failing test**

`uploader/test/authn.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { loadUser, requireAuth, requireAdmin, setSessionCookie, SESSION_COOKIE } from '../src/authn.js';

async function tinyApp() {
  const users = memoryUserStore();
  const sessions = memorySessionStore();
  const app = Fastify();
  await app.register(cookie);
  app.decorateRequest('authUser', null);
  app.addHook('onRequest', async (req) => { req.authUser = await loadUser(req, users, sessions); });
  app.get('/auth-only', { preHandler: requireAuth }, async () => ({ ok: true }));
  app.get('/admin-only', { preHandler: requireAdmin }, async () => ({ ok: true }));
  return { app, users, sessions };
}

describe('auth hooks', () => {
  it('loadUser returns null without a cookie and the user with a valid one', async () => {
    const { users, sessions } = await tinyApp();
    const u = await users.create({ username: 'a', password: 'pw', isAdmin: false });
    const token = await sessions.create(u.id, 60_000);
    expect(await loadUser({ cookies: {} } as never, users, sessions)).toBeNull();
    const got = await loadUser({ cookies: { [SESSION_COOKIE]: token } } as never, users, sessions);
    expect(got).toMatchObject({ username: 'a', isAdmin: false });
  });

  it('requireAuth: 401 anonymous, 200 with session', async () => {
    const { app, users, sessions } = await tinyApp();
    expect((await app.inject({ method: 'GET', url: '/auth-only' })).statusCode).toBe(401);
    const u = await users.create({ username: 'a', password: 'pw', isAdmin: false });
    const token = await sessions.create(u.id, 60_000);
    const res = await app.inject({ method: 'GET', url: '/auth-only', cookies: { sid: token } });
    expect(res.statusCode).toBe(200);
  });

  it('requireAdmin: 401 anonymous, 403 author, 200 admin', async () => {
    const { app, users, sessions } = await tinyApp();
    expect((await app.inject({ method: 'GET', url: '/admin-only' })).statusCode).toBe(401);
    const author = await users.create({ username: 'author', password: 'pw', isAdmin: false });
    const at = await sessions.create(author.id, 60_000);
    expect((await app.inject({ method: 'GET', url: '/admin-only', cookies: { sid: at } })).statusCode).toBe(403);
    const admin = await users.create({ username: 'admin', password: 'pw', isAdmin: true });
    const adt = await sessions.create(admin.id, 60_000);
    expect((await app.inject({ method: 'GET', url: '/admin-only', cookies: { sid: adt } })).statusCode).toBe(200);
  });

  it('setSessionCookie sets HttpOnly SameSite=Strict with Secure only when asked', async () => {
    const app = Fastify();
    await app.register(cookie);
    app.get('/s', async (_req, reply) => { setSessionCookie(reply, 'tok', true); return 'ok'; });
    app.get('/i', async (_req, reply) => { setSessionCookie(reply, 'tok', false); return 'ok'; });
    const secure = await app.inject({ method: 'GET', url: '/s' });
    const insecure = await app.inject({ method: 'GET', url: '/i' });
    expect(secure.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(secure.headers['set-cookie']).toMatch(/SameSite=Strict/i);
    expect(secure.headers['set-cookie']).toMatch(/Secure/i);
    expect(insecure.headers['set-cookie']).not.toMatch(/Secure/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/authn.test.ts`
Expected: FAIL — `../src/authn.js` not found.

- [ ] **Step 3: Write minimal implementation**

`uploader/src/authn.ts`:
```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserStore } from './users.js';
import type { SessionStore } from './sessions.js';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 2_592_000_000; // 30 days

export interface AuthUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

export function isSecureRequest(req: FastifyRequest): boolean {
  return req.protocol === 'https';
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function loadUser(req: FastifyRequest, users: UserStore, sessions: SessionStore): Promise<AuthUser | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = await sessions.find(token);
  if (!session) return null;
  const user = await users.findById(session.userId);
  if (!user) return null;
  return { id: user.id, username: user.username, isAdmin: user.isAdmin };
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply): void {
  if (!req.authUser) reply.code(401).send({ error: 'unauthorized' });
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): void {
  if (!req.authUser) { reply.code(401).send({ error: 'unauthorized' }); return; }
  if (!req.authUser.isAdmin) reply.code(403).send({ error: 'forbidden' });
}
```
Note: a Fastify `preHandler` that calls `reply.send()` short-circuits the route. `requireAuth`/`requireAdmin` are sync and rely on `req.authUser` being populated by the global `onRequest` hook (wired in Task 6 and in the test's `tinyApp`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/authn.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add uploader/src/authn.ts uploader/test/authn.test.ts
git commit -m "feat(uploader): cookie helpers + requireAuth/requireAdmin hooks"
```

---

### Task 6: Server routes — login/logout/setup/users + switch existing routes to session auth

**Files:**
- Modify: `uploader/src/server.ts`
- Modify: `uploader/test/server.test.ts` (rewrite auth wiring)
- Delete: `uploader/src/auth.ts`, `uploader/test/auth.test.ts`

**Interfaces:**
- Consumes: `UserStore`, `UserExistsError`, `User` (Task 3); `SessionStore` (Task 4); `authn` exports (Task 5); `verifyPassword` (Task 2).
- Produces: updated `ServerConfig` (no `authToken`; adds `users: UserStore`, `sessions: SessionStore`); routes `GET /auth/status`, `POST /setup`, `POST /login`, `POST /logout`, `GET /users`, `POST /users`, `DELETE /users/:id`, `GET /login`.

- [ ] **Step 1: Rewrite the auth wiring in `server.test.ts`**

Replace the imports and the `build`/`app` helpers at the top of `uploader/test/server.test.ts`:
```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildServer, type ServerConfig } from '../src/server.js';
import type { Caption } from '../src/caption.js';
import { validate } from '../src/settings.js';
import type { Settings, SettingsStore } from '../src/settings.js';
import { memoryUserStore, type UserStore } from '../src/users.js';
import { memorySessionStore, type SessionStore } from '../src/sessions.js';

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
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
}

interface Built { app: ReturnType<typeof buildServer>; users: UserStore; sessions: SessionStore; }
function build(extra: Partial<ServerConfig> = {}): Built {
  const users = (extra.users as UserStore) ?? memoryUserStore();
  const sessions = (extra.sessions as SessionStore) ?? memorySessionStore();
  const app = buildServer({
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    users, sessions, settings: fakeStore(), ...extra,
  });
  return { app, users, sessions };
}

// Seed a user and return a Cookie header value for an authenticated session.
async function authed(b: Built, opts: { isAdmin?: boolean; username?: string } = {}) {
  const u = await b.users.create({ username: opts.username ?? 'simon', password: 'pw', isAdmin: opts.isAdmin ?? true });
  const token = await b.sessions.create(u.id, 60_000);
  return { user: u, cookie: { sid: token } };
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 1000, height: 800, channels: 3, background: '#444' } }).jpeg().toBuffer();
}
```

- [ ] **Step 2: Convert the existing route tests from bearer to cookie**

In every existing `describe` block (`POST /upload`, `POST /suggest`, `settings endpoints`, and `buildServer config`), apply this mechanical conversion. For each test:
- Replace `const res = await app().inject(...)` with `const b = build(); const { cookie } = await authed(b); const res = await b.app.inject(...)`.
- In injects that previously had `headers: { ...form.getHeaders(), authorization: 'Bearer secret' }`, drop the `authorization` and add `cookies: cookie` as a sibling option: `headers: { ...form.getHeaders() }, cookies: cookie`.
- In injects that previously had `headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }`, change to `headers: { 'content-type': 'application/json' }, cookies: cookie`.
- "401 without auth" tests stay as-is but call `build().app.inject(...)` with **no** cookie and still expect `401`.
- For `build({ captionImpl })` / `build({ fetchImpl })` variants, destructure: `const b = build({ captionImpl: okCaption }); const { cookie } = await authed(b); ... b.app.inject({ ..., cookies: cookie })`.

Concrete example — the "200 + snippet" upload test becomes:
```ts
it('200 + snippet for a valid upload', async () => {
  const b = build();
  const { cookie } = await authed(b);
  const form = new FormData();
  form.append('key', 'trips/bucharest-2024/hero');
  form.append('alt', 'Old town');
  form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
  const res = await b.app.inject({
    method: 'POST', url: '/upload',
    headers: { ...form.getHeaders() }, cookies: cookie, payload: form,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.src).toBe('https://img.simonswanderlust.com/trips/bucharest-2024/hero');
  expect(body.snippet).toContain("alt: 'Old town'");
});
```
And the `buildServer config` boot test:
```ts
it('boots with a relative storageDir (resolves it to absolute)', async () => {
  const rel = relative(process.cwd(), dir);
  const srv = buildServer({ storageDir: rel, baseUrl: 'https://img.simonswanderlust.com', users: memoryUserStore(), sessions: memorySessionStore(), settings: fakeStore() });
  await expect(srv.ready()).resolves.toBeDefined();
  await srv.close();
});
```

- [ ] **Step 3: Add new auth-endpoint tests (append to `server.test.ts`)**

```ts
describe('auth endpoints', () => {
  it('GET /auth/status reports needsSetup on an empty store', async () => {
    const b = build();
    const res = await b.app.inject({ method: 'GET', url: '/auth/status' });
    expect(res.json()).toMatchObject({ authenticated: false, needsSetup: true });
  });

  it('POST /setup creates the first admin and sets a cookie; second call 409s', async () => {
    const b = build();
    const res = await b.app.inject({
      method: 'POST', url: '/setup',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'simon', password: 'pw' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: 'simon', isAdmin: true });
    expect(res.headers['set-cookie']).toMatch(/sid=/);
    const again = await b.app.inject({
      method: 'POST', url: '/setup',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'x', password: 'y' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('POST /login succeeds with correct creds, generic 401 otherwise', async () => {
    const b = build();
    await b.users.create({ username: 'simon', password: 'pw', isAdmin: false });
    const ok = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'Simon', password: 'pw' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toMatch(/sid=/);
    const wrong = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'simon', password: 'bad' } });
    expect(wrong.statusCode).toBe(401);
    const unknown = await b.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'ghost', password: 'pw' } });
    expect(unknown.statusCode).toBe(401);
  });

  it('GET /auth/status returns the logged-in user', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true, username: 'simon' });
    const res = await b.app.inject({ method: 'GET', url: '/auth/status', cookies: cookie });
    expect(res.json()).toMatchObject({ authenticated: true, username: 'simon', isAdmin: true });
  });

  it('POST /logout clears the session', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const out = await b.app.inject({ method: 'POST', url: '/logout', cookies: cookie });
    expect(out.statusCode).toBe(200);
    const after = await b.app.inject({ method: 'GET', url: '/settings', cookies: cookie });
    expect(after.statusCode).toBe(401);
  });
});

describe('user management', () => {
  it('GET /users requires admin (403 for author)', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false, username: 'author' });
    expect((await b.app.inject({ method: 'GET', url: '/users', cookies: cookie })).statusCode).toBe(403);
  });

  it('admin can list, add and remove users', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true, username: 'admin' });
    const add = await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'bob', password: 'pw', isAdmin: false } });
    expect(add.statusCode).toBe(200);
    const list = await b.app.inject({ method: 'GET', url: '/users', cookies: cookie });
    expect(list.json().map((u: { username: string }) => u.username)).toContain('bob');
    const bobId = list.json().find((u: { username: string; id: string }) => u.username === 'bob').id;
    expect((await b.app.inject({ method: 'DELETE', url: `/users/${bobId}`, cookies: cookie })).statusCode).toBe(200);
  });

  it('rejects deleting yourself and the last admin', async () => {
    const b = build();
    const me = await b.users.create({ username: 'admin', password: 'pw', isAdmin: true });
    const token = await b.sessions.create(me.id, 60_000);
    const res = await b.app.inject({ method: 'DELETE', url: `/users/${me.id}`, cookies: { sid: token } });
    expect(res.statusCode).toBe(409);
  });

  it('POST /users 409 on duplicate username', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: true, username: 'admin' });
    await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'bob', password: 'pw', isAdmin: false } });
    const dup = await b.app.inject({ method: 'POST', url: '/users', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: { username: 'BOB', password: 'pw', isAdmin: false } });
    expect(dup.statusCode).toBe(409);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — `buildServer` still expects `authToken`; new routes 404; type errors on `ServerConfig`.

- [ ] **Step 5: Update `server.ts` — config, plugin, hook, hooks-imports**

Edit imports at the top of `uploader/src/server.ts`: remove `import { isAuthorized } from './auth.js';` and add:
```ts
import cookie from '@fastify/cookie';
import { verifyPassword, type UserStore, UserExistsError } from './users.js';
import type { SessionStore } from './sessions.js';
import {
  SESSION_TTL_MS, loadUser, requireAuth, requireAdmin,
  setSessionCookie, clearSessionCookie, isSecureRequest, SESSION_COOKIE,
} from './authn.js';
```
Change `ServerConfig`:
```ts
export interface ServerConfig {
  storageDir: string;
  baseUrl: string;
  users: UserStore;
  sessions: SessionStore;
  settings: SettingsStore;
  captionImpl?: (jpeg: Buffer, cfg: CaptionConfig) => Promise<Caption>;
  fetchImpl?: typeof fetch;
}
```
In `buildServer`, change the Fastify constructor and register cookie + the user-loading hook. Replace `const app = Fastify({ logger: false });` with:
```ts
const app = Fastify({ logger: false, trustProxy: true });
const { users, sessions } = cfg;
app.register(cookie);
app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
app.decorateRequest('authUser', null);
app.addHook('onRequest', async (req) => { req.authUser = await loadUser(req, users, sessions); });
```
(Remove the original standalone `app.register(multipart, …)` line so it isn't registered twice. Keep both `fastifyStatic` registrations as-is.)

- [ ] **Step 6: Update `server.ts` — switch existing routes to `requireAuth`**

For `/upload`, `/suggest`, `GET /settings`, `POST /settings`, `GET /settings/models`, `POST /settings/test`: add `{ preHandler: requireAuth }` as the second arg and delete the inline `if (!isAuthorized(req.headers.authorization, cfg.authToken)) return reply.code(401).send({ error: 'unauthorized' });` block from each. Example:
```ts
app.post('/upload', { preHandler: requireAuth }, async (req, reply) => {
  // (auth block removed)
  let key = '';
  // ...unchanged body...
});
```
Apply the same pattern to the other five routes (drop their auth blocks, add `{ preHandler: requireAuth }`).

- [ ] **Step 7: Update `server.ts` — add the new auth + user routes**

Add these routes inside `buildServer` (after the existing routes, before `return app;`). Keep `GET /` redirect as-is (public).
```ts
app.get('/login', (_req, reply) => reply.sendFile('login.html'));

app.get('/auth/status', async (req) => {
  if (req.authUser) {
    return { authenticated: true, username: req.authUser.username, isAdmin: req.authUser.isAdmin, needsSetup: false };
  }
  return { authenticated: false, needsSetup: (await users.count()) === 0 };
});

app.post('/setup', async (req, reply) => {
  if ((await users.count()) > 0) return reply.code(409).send({ error: 'setup already complete' });
  const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
  const username = String(b.username ?? '').trim();
  const password = String(b.password ?? '');
  if (!username || !password) return reply.code(400).send({ error: 'username and password are required' });
  const user = await users.create({ username, password, isAdmin: true });
  const token = await sessions.create(user.id, SESSION_TTL_MS);
  setSessionCookie(reply, token, isSecureRequest(req));
  return reply.send({ username: user.username, isAdmin: user.isAdmin });
});

app.post('/login', async (req, reply) => {
  const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
  const username = String(b.username ?? '').trim();
  const password = String(b.password ?? '');
  const user = await users.findByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return reply.code(401).send({ error: 'invalid username or password' });
  }
  const token = await sessions.create(user.id, SESSION_TTL_MS);
  setSessionCookie(reply, token, isSecureRequest(req));
  return reply.send({ username: user.username, isAdmin: user.isAdmin });
});

app.post('/logout', { preHandler: requireAuth }, async (req, reply) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await sessions.destroy(token);
  clearSessionCookie(reply);
  return reply.send({ ok: true });
});

app.get('/users', { preHandler: requireAdmin }, async () => {
  const list = await users.list();
  return list.map((u) => ({ id: u.id, username: u.username, isAdmin: u.isAdmin, createdAt: u.createdAt }));
});

app.post('/users', { preHandler: requireAdmin }, async (req, reply) => {
  const b = (req.body ?? {}) as { username?: unknown; password?: unknown; isAdmin?: unknown };
  const username = String(b.username ?? '').trim();
  const password = String(b.password ?? '');
  const isAdmin = Boolean(b.isAdmin);
  if (!username || !password) return reply.code(400).send({ error: 'username and password are required' });
  try {
    const user = await users.create({ username, password, isAdmin });
    return reply.send({ id: user.id, username: user.username, isAdmin: user.isAdmin, createdAt: user.createdAt });
  } catch (e) {
    if (e instanceof UserExistsError) return reply.code(409).send({ error: 'username already exists' });
    throw e;
  }
});

app.delete('/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (req.authUser && req.authUser.id === id) return reply.code(409).send({ error: 'you cannot delete your own account' });
  const target = await users.findById(id);
  if (!target) return reply.code(404).send({ error: 'user not found' });
  if (target.isAdmin && (await users.countAdmins()) <= 1) {
    return reply.code(409).send({ error: 'cannot remove the last admin' });
  }
  await users.remove(id);
  return reply.send({ ok: true });
});
```

- [ ] **Step 8: Delete the obsolete bearer module**

Run:
```bash
git rm uploader/src/auth.ts uploader/test/auth.test.ts
```

- [ ] **Step 9: Run the full suite + typecheck**

Run:
```bash
npm run typecheck
npm test
```
Expected: typecheck clean; all suites pass (server, users, sessions, authn, plus the unchanged variants/caption/storage/pipeline/cli).

- [ ] **Step 10: Commit**

```bash
git add uploader/src/server.ts uploader/test/server.test.ts
git commit -m "feat(uploader): session-cookie auth, login/logout/setup, user management; drop bearer token"
```

---

### Task 7: Postgres implementations (db.ts + pg stores)

**Files:**
- Create: `uploader/src/db.ts`
- Modify: `uploader/src/users.ts` (add `pgUserStore`)
- Modify: `uploader/src/sessions.ts` (add `pgSessionStore`)
- Test: `uploader/test/pg.integration.test.ts` (guarded by `TEST_DATABASE_URL`)

**Interfaces:**
- Consumes: `pg.Pool`; `UserStore`/`User`/`NewUser`/`UserExistsError`/`hashPassword` (Tasks 2–3); `SessionStore`/`Session`/`hashToken` (Task 4).
- Produces: `createPool(connectionString: string): Pool`, `ensureSchema(pool: Pool): Promise<void>`, `pgUserStore(pool: Pool): UserStore`, `pgSessionStore(pool: Pool): SessionStore`.

- [ ] **Step 1: Create `db.ts`**

`uploader/src/db.ts`:
```ts
import pg from 'pg';

const { Pool } = pg;
export type DbPool = pg.Pool;

export function createPool(connectionString: string): DbPool {
  return new Pool({ connectionString });
}

export async function ensureSchema(pool: DbPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            uuid PRIMARY KEY,
      username      text NOT NULL,
      password_hash text NOT NULL,
      is_admin      boolean NOT NULL DEFAULT false,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         text PRIMARY KEY,
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);`);
}
```

- [ ] **Step 2: Add `pgUserStore` to `users.ts`**

Append to `uploader/src/users.ts`:
```ts
import type { DbPool } from './db.js';

interface UserRow { id: string; username: string; password_hash: string; is_admin: boolean; created_at: Date }
function rowToUser(r: UserRow): User {
  return { id: r.id, username: r.username, passwordHash: r.password_hash, isAdmin: r.is_admin, createdAt: r.created_at };
}

export function pgUserStore(pool: DbPool): UserStore {
  return {
    async count() {
      const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
      return Number(rows[0].n);
    },
    async countAdmins() {
      const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users WHERE is_admin');
      return Number(rows[0].n);
    },
    async findByUsername(username) {
      const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE lower(username) = lower($1) LIMIT 1', [username]);
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async findById(id) {
      const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async list() {
      const { rows } = await pool.query<UserRow>('SELECT * FROM users ORDER BY created_at ASC');
      return rows.map(rowToUser);
    },
    async create({ username, password, isAdmin }) {
      const id = randomUUID();
      try {
        const { rows } = await pool.query<UserRow>(
          'INSERT INTO users (id, username, password_hash, is_admin) VALUES ($1,$2,$3,$4) RETURNING *',
          [id, username, hashPassword(password), isAdmin],
        );
        return rowToUser(rows[0]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new UserExistsError('username already exists');
        throw e;
      }
    },
    async remove(id) {
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    },
  };
}
```

- [ ] **Step 3: Add `pgSessionStore` to `sessions.ts`**

Append to `uploader/src/sessions.ts`:
```ts
import type { DbPool } from './db.js';

interface SessionRow { id: string; user_id: string; expires_at: Date }

export function pgSessionStore(pool: DbPool): SessionStore {
  return {
    async create(userId, ttlMs) {
      const raw = randomBytes(32).toString('hex');
      const id = hashToken(raw);
      const expiresAt = new Date(Date.now() + ttlMs);
      await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1,$2,$3)', [id, userId, expiresAt]);
      return raw;
    },
    async find(rawToken) {
      if (!rawToken) return null;
      const id = hashToken(rawToken);
      const { rows } = await pool.query<SessionRow>('SELECT id, user_id, expires_at FROM sessions WHERE id = $1', [id]);
      const row = rows[0];
      if (!row) return null;
      if (row.expires_at.getTime() <= Date.now()) {
        await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
        return null;
      }
      return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
    },
    async destroy(rawToken) {
      if (rawToken) await pool.query('DELETE FROM sessions WHERE id = $1', [hashToken(rawToken)]);
    },
    async sweepExpired() {
      await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    },
  };
}
```

- [ ] **Step 4: Write the guarded integration test**

`uploader/test/pg.integration.test.ts`:
```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgUserStore, UserExistsError } from '../src/users.js';
import { pgSessionStore } from '../src/sessions.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('postgres stores (integration)', () => {
  let pool: DbPool;
  beforeAll(async () => {
    pool = createPool(url!);
    await ensureSchema(pool);
    await pool.query('DELETE FROM sessions'); await pool.query('DELETE FROM users');
  });
  afterAll(async () => { await pool.end(); });

  it('round-trips a user and enforces unique username', async () => {
    const users = pgUserStore(pool);
    const u = await users.create({ username: 'Simon', password: 'pw', isAdmin: true });
    expect((await users.findByUsername('simon'))?.id).toBe(u.id);
    await expect(users.create({ username: 'simon', password: 'x', isAdmin: false })).rejects.toBeInstanceOf(UserExistsError);
  });

  it('creates and finds a session, and expires it', async () => {
    const users = pgUserStore(pool);
    const sessions = pgSessionStore(pool);
    const u = await users.create({ username: `u${Date.now()}`, password: 'pw', isAdmin: false });
    const token = await sessions.create(u.id, 60_000);
    expect((await sessions.find(token))?.userId).toBe(u.id);
    const expired = await sessions.create(u.id, -1);
    expect(await sessions.find(expired)).toBeNull();
  });
});
```

- [ ] **Step 5: Run typecheck + tests (integration auto-skips without a DB)**

Run:
```bash
npm run typecheck
npm test
```
Expected: typecheck clean; `pg.integration.test.ts` shows as **skipped**; everything else passes.

- [ ] **Step 6 (optional but recommended): Run the integration test against a throwaway DB**

Run:
```bash
docker run --rm -d --name pgtest -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=images -e POSTGRES_USER=images -p 55432:5432 postgres:17-alpine
sleep 4
TEST_DATABASE_URL=postgres://images:pw@127.0.0.1:55432/images npx vitest run test/pg.integration.test.ts
docker rm -f pgtest
```
Expected: the integration describe runs and passes.

- [ ] **Step 7: Commit**

```bash
git add uploader/src/db.ts uploader/src/users.ts uploader/src/sessions.ts uploader/test/pg.integration.test.ts
git commit -m "feat(uploader): Postgres pool, schema, and pg-backed user/session stores"
```

---

### Task 8: Wire `main.ts` to Postgres

**Files:**
- Modify: `uploader/src/main.ts`

**Interfaces:**
- Consumes: `createPool`, `ensureSchema` (Task 7); `pgUserStore` (Task 7); `pgSessionStore` (Task 7); `buildServer` (Task 6); `SESSION` sweep via `SessionStore.sweepExpired`.
- Produces: a running server backed by Postgres; fails fast without `DATABASE_URL`.

- [ ] **Step 1: Replace `main.ts`**

`uploader/src/main.ts`:
```ts
import { dirname, join } from 'node:path';
import { buildServer } from './server.js';
import { createSettingsStore, defaultsFromEnv } from './settings.js';
import { createPool, ensureSchema } from './db.js';
import { pgUserStore } from './users.js';
import { pgSessionStore } from './sessions.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required; refusing to start without it.');
  process.exit(1);
}

const storageDir = process.env.STORAGE_DIR ?? '/data/images';
const settingsPath = process.env.SETTINGS_PATH ?? join(dirname(storageDir), 'settings.json');
const settings = createSettingsStore({ path: settingsPath, defaults: defaultsFromEnv(process.env) });

const pool = createPool(databaseUrl);
await ensureSchema(pool);
const users = pgUserStore(pool);
const sessions = pgSessionStore(pool);

// Periodically drop expired session rows (best-effort).
setInterval(() => { void sessions.sweepExpired().catch(() => {}); }, 3_600_000).unref();

const app = buildServer({
  storageDir,
  baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  users,
  sessions,
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

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (top-level `await` is valid in this ESM module under tsx/Node 22).

- [ ] **Step 3: Commit**

```bash
git add uploader/src/main.ts
git commit -m "feat(uploader): boot with Postgres-backed stores; require DATABASE_URL"
```

---

### Task 9: Client — login page, user admin page, and de-token the existing pages

**Files:**
- Create: `uploader/public/login.html`
- Create: `uploader/public/users.html`
- Create: `uploader/public/auth.js`
- Modify: `uploader/public/index.html`, `uploader/public/batch.html`, `uploader/public/settings.html`
- Modify: `uploader/public/admin.css` (small additions)

**Interfaces:**
- Consumes: `GET /auth/status`, `POST /login`, `POST /setup`, `POST /logout`, `GET/POST/DELETE /users` (Task 6).
- Produces: browser auth UX. No automated tests (static assets); verified by serving the app.

- [ ] **Step 1: Create the shared client helper `auth.js`**

`uploader/public/auth.js`:
```js
// Shared admin-auth helpers. Pages call ensureAuthed() on load; on 401 anywhere,
// redirect to /login. The session cookie is sent automatically (same-origin).
window.Auth = (function () {
  async function status() {
    const r = await fetch('/auth/status');
    return r.json();
  }
  async function ensureAuthed(opts) {
    const want = opts || {};
    const s = await status();
    if (!s.authenticated) { location.href = '/login'; return null; }
    if (want.admin && !s.isAdmin) { location.href = '/admin/'; return null; }
    return s;
  }
  async function logout() {
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  }
  // Renders "Logged in as X · [Users] · Logout" into #whoami, if present.
  function renderHeader(s) {
    const el = document.getElementById('whoami');
    if (!el) return;
    const adminLink = s.isAdmin ? ' · <a href="/admin/users.html">Users</a>' : '';
    el.innerHTML = 'Logged in as <strong>' + s.username + '</strong>' + adminLink +
      ' · <a href="#" id="logoutLink">Logout</a>';
    document.getElementById('logoutLink').addEventListener('click', (e) => { e.preventDefault(); logout(); });
  }
  return { status, ensureAuthed, logout, renderHeader };
})();
```

- [ ] **Step 2: Create `login.html`**

`uploader/public/login.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in · Simon's Wanderlust</title>
    <link rel="stylesheet" href="/admin/admin.css" />
  </head>
  <body>
    <header class="masthead">
      <div class="masthead-inner">
        <p class="eyebrow">Expedition Log · Image Station</p>
        <h1 id="title">Sign in</h1>
        <p class="lede" id="lede">Enter your username and password.</p>
      </div>
    </header>
    <main>
      <section class="card">
        <label for="username">Username</label>
        <input id="username" type="text" autocomplete="username" />
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" />
        <button id="submit">Sign in</button>
        <p class="section-label">Status</p>
        <pre id="out">—</pre>
      </section>
    </main>
    <script src="/admin/auth.js"></script>
    <script>
      const $ = (id) => document.getElementById(id);
      let needsSetup = false;
      async function init() {
        const s = await Auth.status();
        if (s.authenticated) { location.href = '/admin/'; return; }
        needsSetup = !!s.needsSetup;
        if (needsSetup) {
          $('title').textContent = 'Create the first admin';
          $('lede').textContent = 'No accounts exist yet. Create the first administrator account.';
          $('submit').textContent = 'Create admin';
          $('password').setAttribute('autocomplete', 'new-password');
        }
      }
      $('submit').addEventListener('click', async () => {
        const username = $('username').value.trim();
        const password = $('password').value;
        if (!username || !password) { $('out').textContent = 'Enter a username and password.'; return; }
        $('out').textContent = needsSetup ? 'Creating…' : 'Signing in…';
        const res = await fetch(needsSetup ? '/setup' : '/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        if (res.ok) { location.href = '/admin/'; return; }
        const r = await res.json().catch(() => ({}));
        $('out').textContent = r.error || ('Failed: ' + res.status);
      });
      init();
    </script>
  </body>
</html>
```

- [ ] **Step 3: Create `users.html` (admin only)**

`uploader/public/users.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Users · Simon's Wanderlust</title>
    <link rel="stylesheet" href="/admin/admin.css" />
  </head>
  <body>
    <header class="masthead">
      <div class="masthead-inner">
        <p class="eyebrow">Expedition Log · Image Station</p>
        <h1>Users</h1>
        <p class="muted" id="whoami"></p>
        <nav>
          <a href="/admin/">Hero upload</a>
          <a href="/admin/batch.html">Batch uploader</a>
          <a href="/admin/settings.html">LLM settings</a>
          <a href="/admin/users.html" aria-current="page">Users</a>
        </nav>
      </div>
    </header>
    <main>
      <section class="card">
        <h2>Add a user</h2>
        <label for="username">Username</label>
        <input id="username" type="text" autocomplete="off" />
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="new-password" />
        <label><input id="isAdmin" type="checkbox" /> Administrator</label>
        <button id="add">Add user</button>
        <p class="section-label">Status</p>
        <pre id="out">—</pre>
      </section>
      <section class="card">
        <h2>Existing users</h2>
        <ul id="list"></ul>
      </section>
    </main>
    <script src="/admin/auth.js"></script>
    <script>
      const $ = (id) => document.getElementById(id);
      let me = null;
      async function load() {
        const res = await fetch('/users');
        if (res.status === 401) { location.href = '/login'; return; }
        if (res.status === 403) { location.href = '/admin/'; return; }
        const users = await res.json();
        const ul = $('list');
        ul.innerHTML = '';
        for (const u of users) {
          const li = document.createElement('li');
          const role = u.isAdmin ? 'admin' : 'author';
          li.textContent = u.username + ' (' + role + ') ';
          if (!(me && u.username === me.username)) {
            const btn = document.createElement('button');
            btn.textContent = 'Remove';
            btn.addEventListener('click', async () => {
              const d = await fetch('/users/' + u.id, { method: 'DELETE' });
              if (d.ok) { load(); } else { const r = await d.json().catch(() => ({})); $('out').textContent = r.error || ('Failed: ' + d.status); }
            });
            li.appendChild(btn);
          }
          ul.appendChild(li);
        }
      }
      $('add').addEventListener('click', async () => {
        const username = $('username').value.trim();
        const password = $('password').value;
        const isAdmin = $('isAdmin').checked;
        if (!username || !password) { $('out').textContent = 'Enter a username and password.'; return; }
        const res = await fetch('/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, isAdmin }) });
        if (res.ok) { $('out').textContent = 'Added ' + username + '.'; $('username').value = ''; $('password').value = ''; $('isAdmin').checked = false; load(); }
        else { const r = await res.json().catch(() => ({})); $('out').textContent = r.error || ('Failed: ' + res.status); }
      });
      (async () => {
        me = await Auth.ensureAuthed({ admin: true });
        if (!me) return;
        Auth.renderHeader(me);
        load();
      })();
    </script>
  </body>
</html>
```

- [ ] **Step 4: De-token `settings.html`**

In `uploader/public/settings.html`:
- Delete the token `<label>`/`<input id="token" …>` lines.
- Add a `<p class="muted" id="whoami"></p>` line inside `.masthead-inner` (after the `<nav>`), and add a `<a href="/admin/users.html">Users</a>` is **not** hardcoded here — `Auth.renderHeader` injects the Users link for admins.
- Add `<script src="/admin/auth.js"></script>` before the existing inline `<script>`.
- Replace `const authed = () => ({ authorization: 'Bearer ' + $('token').value.trim() });` and its uses: remove `authed()` entirely; change `fetch('/settings', { headers: authed() })` → `fetch('/settings')`, and the POST `headers: { ...authed(), 'content-type': 'application/json' }` → `headers: { 'content-type': 'application/json' }`.
- Remove the empty-token guard added earlier (no token field now).
- Change `init()` so it no longer keys off a token field. Replace the token-driven bootstrap with an auth gate at load:
```js
(async () => {
  const s = await Auth.ensureAuthed();
  if (!s) return;
  Auth.renderHeader(s);
  await init();
})();
```
and make `init()` start directly (drop the `if (!$('token')…)` line and the `$('token').addEventListener('change', init)` line).
- In the save handler's non-JSON / fetch-failure branches, on `res.status === 401` redirect: add at the top of the response handling `if (res.status === 401) { location.href = '/login'; return; }`.

- [ ] **Step 5: De-token `index.html`**

In `uploader/public/index.html`:
- Delete the token `<label>`/`<input id="token">`.
- Add `<p class="muted" id="whoami"></p>` to the masthead and `<script src="/admin/auth.js"></script>` before the inline script.
- Change `headers: { authorization: 'Bearer ' + document.getElementById('token').value }` (line ~66) to omit the header: `headers: {}` (or drop the `headers` key). After the fetch, add `if (res.status === 401) { location.href = '/login'; return; }`.
- Add an auth gate on load:
```js
(async () => { const s = await Auth.ensureAuthed(); if (s) Auth.renderHeader(s); })();
```

- [ ] **Step 6: De-token `batch.html`**

In `uploader/public/batch.html`:
- Delete the token `<label>`/`<input id="token">` and any `const token = …token….value` reads.
- Add `<p class="muted" id="whoami"></p>` and `<script src="/admin/auth.js"></script>`.
- Change `fetch('/settings', { headers: { authorization: 'Bearer ' + token } })` → `fetch('/settings')`; change `fetch('/upload', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd })` → `fetch('/upload', { method: 'POST', body: fd })`. After each, handle 401: `if (res.status === 401) { location.href = '/login'; return; }`.
- Add the same load-time auth gate as Step 5.

- [ ] **Step 7: Small CSS additions**

Append to `uploader/public/admin.css`:
```css
.muted { color: #6b7280; font-size: 0.9rem; margin-top: 0.5rem; }
#list { list-style: none; padding: 0; }
#list li { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0; border-bottom: 1px dashed #d1d5db; }
#list li button { margin-left: auto; }
```

- [ ] **Step 8: Manual verification (build the image, run the stack, exercise login)**

Run:
```bash
cd ..
docker compose up -d --build images db
# wait for healthy
curl -s -i http://localhost:3000/auth/status   # expect {"authenticated":false,"needsSetup":true}
```
Then in a browser at `http://localhost:3000/login`: confirm the "Create the first admin" form appears, create an admin, land on `/admin/`, see "Logged in as …", upload a hero image, open Users, add an author, log out, log back in as the author, confirm Users is hidden and `/admin/users.html` redirects away.

- [ ] **Step 9: Commit**

```bash
cd uploader
git add public/login.html public/users.html public/auth.js public/index.html public/batch.html public/settings.html public/admin.css
git commit -m "feat(uploader): login page, user management UI, cookie-session client (remove token fields)"
```

---

### Task 10: Documentation

**Files:**
- Modify: `uploader/README.md`
- Modify: `CLAUDE.md` (uploader description: token → accounts)

**Interfaces:**
- Consumes: nothing.
- Produces: accurate setup/auth docs.

- [ ] **Step 1: Update `README.md` auth/setup sections**

- Replace the "Generate a long random AUTH_TOKEN" setup with Postgres + first-run setup: set `POSTGRES_PASSWORD`/`DATABASE_URL` in `.env`, `docker compose up -d --build`, open `/login`, create the first admin.
- Replace the "log in with the token" / "paste it into the Auth token field" instructions with "sign in at `/login`".
- Rewrite the curl end-to-end check to authenticate via a cookie jar:
```bash
# Log in (stores the session cookie in cookies.txt), then upload with it.
curl -s -c cookies.txt -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"username":"simon","password":"YOUR_PASSWORD"}'
curl -s -b cookies.txt -X POST http://localhost:3000/upload \
  -F key=trips/test/hero -F alt=Test -F file=@some.jpg
```
- Update the local `npm run dev` section: set `DATABASE_URL` (e.g. a local Postgres) instead of `AUTH_TOKEN`.

- [ ] **Step 2: Update `CLAUDE.md`**

In the "Project Overview" uploader sentence and the `uploader/src` file list, change references to bearer-token auth to "username/password accounts (Postgres) with session cookies", and add `db · users · sessions · authn` to the `uploader/src/` component list. Remove any "auth" (bearer) mention that no longer applies.

- [ ] **Step 3: Commit**

```bash
git add uploader/README.md CLAUDE.md
git commit -m "docs(uploader): document username/password auth, Postgres setup, first-run admin"
```

---

## Self-Review

**Spec coverage:**
- Postgres container + `pg` dep → Task 1, Task 7. ✓
- Login page + HttpOnly/SameSite/Secure cookie → Task 5 (cookie), Task 6 (routes), Task 9 (page). ✓
- Server-side sessions table, sha256 token storage → Task 4 (memory), Task 7 (pg). ✓
- scrypt hashing → Task 2. ✓
- First-run setup page + `/setup` 409 guard → Task 6, Task 9. ✓
- Admin/author roles, `requireAdmin`, last-admin/self-delete guards → Task 5, Task 6. ✓
- Remove `AUTH_TOKEN` (code/compose/env/docs) → Task 1, Task 6 (delete auth.ts), Task 8, Task 10. ✓
- `GET /auth/status` drives first-run + header + redirects; static pages public → Task 6, Task 9. ✓
- Switch existing endpoints to session auth → Task 6. ✓
- Tests with no live services; guarded pg integration → Tasks 2–6 (memory), Task 7 (guarded). ✓
- `trustProxy` for Secure detection behind proxy → Task 6 (Fastify opts), Task 5 (`isSecureRequest`). ✓
- README curl rewrite → Task 10. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one "mechanical conversion" step (Task 6 Step 2) gives an explicit rule plus a full before/after example for each header shape, and the surrounding tasks define all referenced names.

**Type consistency:** `UserStore`/`SessionStore` method names and shapes are identical across memory (Tasks 3–4) and pg (Task 7) implementations and the consumers (Tasks 5–6, 8). `AuthUser`, `SESSION_COOKIE`, `SESSION_TTL_MS`, `setSessionCookie/clearSessionCookie/loadUser/requireAuth/requireAdmin/isSecureRequest` are defined in Task 5 and consumed with matching signatures in Task 6. `ServerConfig` change (drop `authToken`, add `users`/`sessions`) is applied in Task 6 and all call sites updated (Task 6 tests, Task 8 main). `DbPool` type defined in Task 7 `db.ts` and imported by the pg stores.

**Deferred (explicitly out of scope, per spec):** login rate-limiting, password-change UI, sliding sessions. A `@ai-note` for the rate-limit insertion point should be added at the `/login` handler during Task 6.
