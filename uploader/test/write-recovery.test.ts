import { randomUUID, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { editorDocument } from './editor-dom-harness.js';

interface Attempt { saveId: string; expectedOwnerId: string; resource: string; generation: number; sentPayload: Record<string, unknown> }
interface Recovery {
  initialize(owner: string): boolean; observeOwner(owner: string | null): void; resumeOwner(owner: string): boolean;
  save(payload: object, generation: number): Promise<boolean>; probe(): Promise<boolean>;
  exportState(): { attempts: Attempt[]; createKey: string }; restore(state: unknown): boolean;
}
interface Guard { initialize(owner: string): boolean; markDirty(): void; markClean(generation?: number): void;
  snapshot(): number; isDirty(): boolean; stashNow(): boolean; tryRestore(): { recovery: unknown; key: string; raw: string } | null;
  adopt(stash: unknown): boolean; freshContext(): void; redirectToLogin(): void }
function storage() {
  const map = new Map<string, string>();
  return { map, get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(options: { owner?: string; kind?: 'posts' | 'pages'; resource?: string; storage?: ReturnType<typeof storage> } = {}) {
  const owner = options.owner ?? randomUUID(); const kind = options.kind ?? 'posts';
  let resource = options.resource ?? ''; let base: string | null = resource ? '2026-10-01T00:00:00.000Z' : null;
  let payload = { de: { title: 'Local' }, en: { title: 'English' } };
  const local = options.storage ?? storage(); const dom = editorDocument('<main></main>');
  const calls: { url: string; init?: RequestInit }[] = [];
  let handle: (url: string, init?: RequestInit) => Promise<Response> = async () => response({}, 404);
  const context: Record<string, unknown> = { document: dom.document, crypto: webcrypto, structuredClone, AbortController,
    setTimeout: () => 0, clearTimeout() {}, localStorage: local, sessionStorage: storage(),
    location: { pathname: '/admin/editor.html', search: '', href: '' }, addEventListener: dom.document.addEventListener,
    fetch: (url: string, init?: RequestInit) => { calls.push({ url, init }); return handle(url, init); } };
  context.window = context; vm.createContext(context);
  vm.runInContext(readFileSync('public/draft-guard.js', 'utf8'), context);
  vm.runInContext(readFileSync('public/write-recovery.js', 'utf8'), context);
  let recovery: Recovery;
  const guard = (context.DraftGuard as { createDraftGuard(options: object): Guard }).createDraftGuard({
    resource: kind === 'pages' ? 'page:about' : resource ? `post:${resource}` : 'post:new',
    collect: () => payload, recovery: () => recovery?.exportState(),
  });
  const adoptions: unknown[] = [];
  recovery = (context.WriteRecovery as { create(options: object): Recovery }).create({ kind, guard,
    copy: new Proxy({}, { get: (_target, key) => String(key) }), resourceId: () => resource, base: () => base,
    collect: () => payload, restoreBase: (value: string | null) => { base = value; }, error() {},
    adopt: async (saved: { translationKey?: string; updatedAt: string }) => { adoptions.push(saved); resource = saved.translationKey ?? resource; base = saved.updatedAt; },
    useStored: async () => {},
  });
  recovery.initialize(owner);
  return { owner, recovery, guard, local, calls, adoptions, dom, context,
    handle: (fn: typeof handle) => { handle = fn; }, edit: (title: string) => { payload = { ...payload, de: { title } }; guard.markDirty(); },
    save: () => recovery.save(payload, guard.snapshot()), setBase: (value: string | null) => { base = value; } };
}

describe('write outcome reconciliation', () => {
  it('recognizes a lost create response without replay and keeps edits typed after sending dirty', async () => {
    const f = fixture(); f.edit('Sent');
    let sent: Record<string, unknown> = {};
    f.handle(async (_url, init) => {
      if (init?.method === 'POST') { sent = JSON.parse(String(init.body)); f.edit('Newer'); throw new Error('response dropped'); }
      return response({ ...sent, ownerUserId: f.owner, lastSaveId: sent.saveId, updatedAt: '2026-10-02T00:00:00.000Z' });
    });
    expect(await f.save()).toBe(true);
    expect(f.calls.map(c => c.init?.method ?? 'GET')).toEqual(['POST', 'GET']);
    expect(f.guard.isDirty()).toBe(true);
    expect(f.local.map.size).toBeGreaterThan(0);
    expect(JSON.stringify([...f.local.map.values()])).toContain('Newer');
  });
  it('retains an earlier attempt after a 404 and recognizes its late commit during a later 409 probe', async () => {
    const f = fixture(); f.edit('First');
    let original: Record<string, unknown> = {}; let writes = 0; let reads = 0;
    f.handle(async (_url, init) => {
      if (init?.method === 'POST') {
        writes++; if (writes === 1) { original = JSON.parse(String(init.body)); throw new Error('disconnected'); }
        return response({ code: 'already_exists' }, 409);
      }
      if (++reads === 1) return response({}, 404);
      return response({ ...original, ownerUserId: f.owner, lastSaveId: original.saveId, updatedAt: '2026-10-02T00:00:00.000Z' });
    });
    expect(await f.save()).toBe(false);
    const key = f.recovery.exportState().createKey;
    f.edit('Second'); expect(await f.save()).toBe(true);
    expect(writes).toBe(2); expect(reads).toBe(2);
    expect(f.guard.isDirty()).toBe(true);
    const sent = f.calls.filter(c => c.init?.method === 'POST').map(c => JSON.parse(String(c.init?.body)));
    expect(sent.map(p => p.translationKey)).toEqual([key, key]);
    expect(sent[0].saveId).not.toBe(sent[1].saveId);
  });
  it.each(['normal', 'probe'] as const)('never adopts an acknowledgement belonging to another account (%s)', async mode => {
    const f = fixture(); f.edit('A private draft'); const other = randomUUID();
    f.handle(async (_url, init) => {
      const attempt = f.recovery.exportState().attempts[0]!;
      if (init?.method === 'POST' && mode === 'probe') throw new Error('dropped');
      return response({ ...attempt.sentPayload, translationKey: attempt.resource, ownerUserId: other,
        saveId: attempt.saveId, lastSaveId: attempt.saveId, updatedAt: '2026-10-02T00:00:00.000Z' });
    });
    expect(await f.save()).toBe(false); expect(f.adoptions).toEqual([]); expect(f.guard.isDirty()).toBe(true);
    expect(await f.save()).toBe(false); expect(f.calls.filter(c => c.init?.method === 'POST')).toHaveLength(1);
    expect(f.recovery.resumeOwner(other)).toBe(false); expect(f.recovery.resumeOwner(f.owner)).toBe(true);
    expect([...f.local.map.keys()].every(key => key.includes(f.owner))).toBe(true);
  });
  it('does not adopt a late A response after detecting B, even when the response itself names A', async () => {
    const f = fixture(); f.edit('A');
    f.handle(async () => {
      const attempt = f.recovery.exportState().attempts[0]!;
      f.recovery.observeOwner(randomUUID());
      return response({ ...attempt.sentPayload, ownerUserId: f.owner, saveId: attempt.saveId, updatedAt: '2026-10-02T00:00:00.000Z' });
    });
    expect(await f.save()).toBe(false); expect(f.adoptions).toEqual([]); expect(f.guard.isDirty()).toBe(true);
    expect(f.calls).toHaveLength(1);
  });
  it('keeps both local text and foreign stored content visible without assigning its token', async () => {
    const f = fixture({ resource: randomUUID() }); f.edit('Local unsaved');
    f.handle(async (_url, init) => init?.method === 'PUT' ? response({ code: 'conflict' }, 409)
      : response({ translationKey: f.recovery.exportState().attempts[0]!.resource, ownerUserId: f.owner, lastSaveId: null,
        updatedAt: '2026-10-03T00:00:00.000Z', de: { title: 'Another writer' }, en: {} }));
    expect(await f.save()).toBe(false); expect(f.guard.isDirty()).toBe(true); expect(f.adoptions).toEqual([]);
    const comparison = f.dom.document.querySelector('details')!;
    expect(comparison.hidden).toBe(false);
    expect(comparison.textContent).toContain('Local unsaved'); expect(comparison.textContent).toContain('Another writer');
    expect(await f.save()).toBe(false); expect(f.calls).toHaveLength(2);
  });
  it('sends explicit null for initial generic-page preparation and never borrows a loaded base on restore', async () => {
    const f = fixture({ kind: 'pages', resource: 'about' }); f.setBase(null); f.edit('First page');
    f.handle(async () => response({}, 400)); await f.save();
    expect(JSON.parse(String(f.calls[0]!.init?.body)).updatedAt).toBeNull();
    const state = f.recovery.exportState();
    expect(f.recovery.restore({ ...state, expectedOwnerId: f.owner, kind: 'pages', resource: 'about', baseUpdatedAt: 'invalid' })).toBe(false);
  });
});

describe('scoped draft recovery', () => {
  it('keeps legacy bytes private and preserves them across logout or session expiry', () => {
    const local = storage(); local.setItem('swl:draft:new', '{"private":"legacy"}');
    const f = fixture({ storage: local }); f.edit('A'); f.guard.stashNow();
    const stranger = fixture({ storage: local });
    expect(stranger.guard.tryRestore()).toBeNull();
    f.guard.redirectToLogin(); expect(local.getItem('swl:draft:new')).toBe('{"private":"legacy"}');
    expect(local.map.size).toBeGreaterThan(1);
  });
  it('two same-owner contexts cannot clean each other’s newer or unadopted record', () => {
    const local = storage(); const owner = randomUUID();
    const a = fixture({ storage: local, owner }); a.edit('A'); a.guard.stashNow();
    const source = a.guard.tryRestore()!;
    const b = fixture({ storage: local, owner }); expect(b.guard.adopt(source)).toBe(true);
    a.edit('A newer'); a.guard.stashNow(); b.guard.markClean();
    expect([...local.map.values()].some(raw => raw.includes('A newer'))).toBe(true);
    const c = fixture({ storage: local, owner }); c.edit('C'); c.guard.markClean();
    expect([...local.map.values()].some(raw => raw.includes('A newer'))).toBe(true);
  });
  it('restores a new-post create identity and unresolved snapshots without performing a request', async () => {
    const local = storage(); const owner = randomUUID(); const a = fixture({ storage: local, owner });
    a.edit('Saved locally'); a.handle(async () => { throw new Error('offline'); }); await a.save(); a.guard.stashNow();
    const b = fixture({ storage: local, owner }); const stash = b.guard.tryRestore()!;
    expect(b.guard.adopt(stash)).toBe(true); expect(b.recovery.restore(stash.recovery)).toBe(true);
    expect(b.recovery.exportState()).toEqual(a.recovery.exportState()); expect(b.calls).toEqual([]);
  });
});
