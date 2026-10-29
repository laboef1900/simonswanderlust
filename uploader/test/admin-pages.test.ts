import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GALLERY_MODES } from '../../site/src/lib/gallery-layout.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// draft-guard.js is a plain browser IIFE (window.DraftGuard). Run it inside a
// vm sandbox with stubbed window/localStorage/location/timers so its behavior
// (dirty tracking, debounced stash, 401 redirect, open-redirect guard) is
// testable without a browser.
const guardSrc = readFileSync('public/draft-guard.js', 'utf8');

interface Stash {
  savedAt: string;
  payload: Record<string, unknown>;
  key?: string;
}
interface Guard {
  initialize(owner: string): boolean;
  markDirty(): void;
  markClean(token?: number): void;
  snapshot(): number;
  stashNow(): void;
  tryRestore(): Stash | null;
  adopt(stash: Stash | null): void;
  dismissRestore(stash: Stash | null): void;
  wasDismissed(stash: Stash | null): boolean;
  setResource(resource: string): void;
  redirectToLogin(): void;
}
interface DraftGuardApi {
  safeNextPath(raw: string | null): string;
  createDraftGuard(opts: { resource: string; collect: () => unknown; debounceMs?: number }): Guard;
}
interface StubEvent {
  defaultPrevented: boolean;
  returnValue: string | undefined;
  preventDefault: () => void;
}

// `store`/`session` may be shared across sandboxes to model two tabs: every
// tab sees one localStorage, each has its own sessionStorage.
function makeSandbox(opts: { throwStorage?: boolean; store?: Map<string, string>; session?: Map<string, string> } = {}) {
  const beforeUnload: Array<(e: StubEvent) => void> = [];
  const store = opts.store ?? new Map<string, string>();
  const timers = new Map<number, () => void>();
  let nextId = 1;

  const localStorageStub = opts.throwStorage
    ? {
        getItem: (): string | null => { throw new Error('quota exceeded'); },
        setItem: (): void => { throw new Error('quota exceeded'); },
        removeItem: (): void => { throw new Error('quota exceeded'); },
        get length(): number { throw new Error('quota exceeded'); },
        key: (): string | null => { throw new Error('quota exceeded'); },
      }
    : {
        getItem: (k: string): string | null => store.get(k) ?? null,
        setItem: (k: string, v: string): void => { store.set(k, String(v)); },
        removeItem: (k: string): void => { store.delete(k); },
        get length(): number { return store.size; },
        key: (i: number): string | null => [...store.keys()][i] ?? null,
      };

  // sessionStorage-backed dismissal marker (per-tab; separate from localStorage).
  const session = opts.session ?? new Map<string, string>();
  const sessionStorageStub = opts.throwStorage
    ? {
        getItem: (): string | null => { throw new Error('quota exceeded'); },
        setItem: (): void => { throw new Error('quota exceeded'); },
        removeItem: (): void => { throw new Error('quota exceeded'); },
      }
    : {
        getItem: (k: string): string | null => session.get(k) ?? null,
        setItem: (k: string, v: string): void => { session.set(k, String(v)); },
        removeItem: (k: string): void => { session.delete(k); },
      };

  const location = { pathname: '/admin/editor.html', search: '?tk=abc', href: '' };
  const windowStub: {
    addEventListener: (type: string, fn: (e: StubEvent) => void) => void;
    DraftGuard?: DraftGuardApi;
  } = {
    addEventListener: (type, fn) => { if (type === 'beforeunload') beforeUnload.push(fn); },
  };

  vm.runInNewContext(guardSrc, {
    window: windowStub,
    crypto: webcrypto,
    localStorage: localStorageStub,
    sessionStorage: sessionStorageStub,
    location,
    setTimeout: (fn: () => void): number => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimeout: (id: number): void => { timers.delete(id); },
  });

  const api = windowStub.DraftGuard;
  if (!api) throw new Error('draft-guard.js did not assign window.DraftGuard');
  const createGuard = api.createDraftGuard;
  api.createDraftGuard = (options) => {
    const guard = createGuard(options);
    guard.initialize('11111111-1111-4111-8111-111111111111');
    return guard;
  };

  return {
    api,
    store,
    session,
    location,
    pendingTimers: () => timers.size,
    flushTimers: () => {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((fn) => fn());
    },
    fireBeforeUnload: (): StubEvent => {
      const e: StubEvent = {
        defaultPrevented: false,
        returnValue: undefined,
        preventDefault() { this.defaultPrevented = true; },
      };
      beforeUnload.forEach((fn) => fn(e));
      return e;
    },
  };
}

describe('DraftGuard.safeNextPath', () => {
  it('accepts same-origin admin paths', () => {
    const { api } = makeSandbox();
    expect(api.safeNextPath('/admin/editor.html?tk=abc')).toBe('/admin/editor.html?tk=abc');
    expect(api.safeNextPath('/admin/about.html')).toBe('/admin/about.html');
    expect(api.safeNextPath('/admin/')).toBe('/admin/');
  });

  it('falls back to /admin/ for anything else (open-redirect guard)', () => {
    const { api } = makeSandbox();
    expect(api.safeNextPath(null)).toBe('/admin/');
    expect(api.safeNextPath('')).toBe('/admin/');
    expect(api.safeNextPath('https://evil.com/admin/')).toBe('/admin/');
    expect(api.safeNextPath('//evil.com/x')).toBe('/admin/');
    expect(api.safeNextPath('/\\evil.com')).toBe('/admin/');
    expect(api.safeNextPath('/admin/\\evil.com')).toBe('/admin/');
    expect(api.safeNextPath('/admin//..//x')).toBe('/admin/');
    expect(api.safeNextPath('javascript:alert(1)')).toBe('/admin/');
    expect(api.safeNextPath('/etc/passwd')).toBe('/admin/');
  });
});

describe('DraftGuard.createDraftGuard', () => {
  const KEY = 'swl:draft:test';

  it('warns on beforeunload only while dirty, and takes a last-chance stash', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ a: 1 }) });

    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);

    guard.markDirty();
    const e = sb.fireBeforeUnload();
    expect(e.defaultPrevented).toBe(true);
    expect(e.returnValue).toBe('');
    expect(guard.tryRestore()).not.toBeNull(); // stashed even if the user leaves anyway

    guard.markClean();
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('markDirty schedules one debounced stash of the collected payload', () => {
    const sb = makeSandbox();
    let collectCalls = 0;
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => { collectCalls += 1; return { title: 'Rhodos', de: { slug: 'rhodos' } }; }, });

    guard.markDirty();
    guard.markDirty();
    guard.markDirty();
    expect(sb.pendingTimers()).toBe(1); // debounced: earlier timers cancelled
    expect(guard.tryRestore()).toBeNull();

    sb.flushTimers();
    expect(collectCalls).toBe(1);
    const stash = guard.tryRestore()!;
    expect(typeof stash.savedAt).toBe('string');
    expect(stash.payload).toEqual({ title: 'Rhodos', de: { slug: 'rhodos' } });
  });

  it('stashNow writes synchronously and tryRestore round-trips it', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ b: 2 }) });
    guard.stashNow();
    const restored = guard.tryRestore();
    expect(restored).not.toBeNull();
    expect(restored?.payload).toEqual({ b: 2 });
  });

  it('tryRestore returns null for absent, corrupt, or misshapen stashes', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({}) });
    expect(guard.tryRestore()).toBeNull();

    sb.store.set(KEY, '{not json');
    expect(guard.tryRestore()).toBeNull();

    sb.store.set(KEY, '42');
    expect(guard.tryRestore()).toBeNull();

    sb.store.set(KEY, JSON.stringify({ savedAt: 'now' })); // no payload
    expect(guard.tryRestore()).toBeNull();

    sb.store.set(KEY, JSON.stringify({ payload: { a: 1 } })); // no savedAt
    expect(guard.tryRestore()).toBeNull();
  });

  it('tokenless markClean removes the stash and cancels a pending debounced stash', () => {
    // Tokenless cleanup is for an explicit stored-version adoption, never
    // declining a restore; save handlers pass their captured generation.
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ c: 3 }) });
    guard.stashNow();
    guard.markDirty();
    guard.markClean();
    expect(guard.tryRestore()).toBeNull();
    expect(sb.pendingTimers()).toBe(0);
    sb.flushTimers();
    expect(guard.tryRestore()).toBeNull();
  });

  it('dismissRestore keeps the stash but disarms the warning (a misclicked Cancel loses nothing)', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ h: 8 }) });
    guard.stashNow();
    guard.markDirty();
    const stash = guard.tryRestore();
    guard.dismissRestore(stash);
    expect(guard.tryRestore()).not.toBeNull(); // preserved and recoverable
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false); // dirty disarmed
    expect(sb.pendingTimers()).toBe(0);                         // debounced stash cancelled
    // Restoring the still-present stash on a later load round-trips the payload.
    expect(guard.tryRestore()?.payload).toEqual({ h: 8 });
  });

  it('wasDismissed suppresses a re-prompt for the same stash but not a newer one', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ i: 9 }) });
    guard.stashNow();
    const first = guard.tryRestore();
    expect(guard.wasDismissed(first)).toBe(false);
    guard.dismissRestore(first);
    expect(guard.wasDismissed(first)).toBe(true);               // same stash: don't re-offer
    // A newer stash (different savedAt) must still be offered.
    const newer = { savedAt: 'a-later-timestamp', payload: { i: 9 } };
    expect(guard.wasDismissed(newer)).toBe(false);
    expect(guard.wasDismissed(null)).toBe(false);
  });

  it('dismissRestore degrades safely when sessionStorage throws', () => {
    const sb = makeSandbox({ throwStorage: true });
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ j: 10 }) });
    const stash = { savedAt: 'now', payload: { j: 10 } };
    expect(() => guard.dismissRestore(stash)).not.toThrow();
    expect(guard.wasDismissed(stash)).toBe(false); // can't record → treated as not dismissed
  });

  it('markClean with a current snapshot token cleans normally after a save', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ c: 3 }) });
    guard.markDirty();
    const snap = guard.snapshot(); // taken just before the save fetch
    guard.markClean(snap);         // response landed, nothing typed meanwhile
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);
    expect(sb.pendingTimers()).toBe(0);
    expect(guard.tryRestore()).toBeNull();
  });

  it('markClean with a stale token keeps mid-save edits dirty and stashed', () => {
    // Race from the review: payload snapshotted at t0, user keeps typing while
    // the request is in flight (the About save runs a full astro rebuild), the
    // response lands and must NOT wipe the newer on-screen edits' protection.
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ c: 3 }) });
    guard.markDirty();
    const snap = guard.snapshot(); // save fetch starts here
    guard.markDirty();             // user typed while the save was in flight
    guard.markClean(snap);         // save response lands
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(true); // warning still armed
    expect(sb.pendingTimers()).toBe(1);                        // debounced stash still pending
    sb.flushTimers();
    expect(guard.tryRestore()).not.toBeNull(); // newer edits get stashed
  });

  it('setResource moves only its own record to the saved resource', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: 'swl:draft:new', collect: () => ({ d: 4 }) });
    guard.stashNow();
    const previous = guard.tryRestore()!.key!;
    guard.setResource('swl:draft:tk-123');
    expect(sb.store.has(previous)).toBe(false);
    const moved = guard.tryRestore()!;
    expect(moved.payload).toEqual({ d: 4 });
    guard.markClean(); // now operates on the new key
    expect(guard.tryRestore()).toBeNull();
  });

  it('redirectToLogin stashes dirty work, disarms the prompt, and carries ?next=', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ e: 5 }) });
    guard.markDirty();
    guard.redirectToLogin();
    expect(guard.tryRestore()).not.toBeNull();
    expect(sb.location.href).toBe('/login?next=%2Fadmin%2Feditor.html%3Ftk%3Dabc');
    // the intentional navigation must not trigger the leave-page dialog
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('redirectToLogin does not stash a pristine form (nothing worth restoring)', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ f: 6 }) });
    guard.redirectToLogin();
    expect(guard.tryRestore()).toBeNull();
    expect(sb.location.href).toBe('/login?next=%2Fadmin%2Feditor.html%3Ftk%3Dabc');
  });

  it('degrades to warning-only when localStorage throws (quota / private mode)', () => {
    const sb = makeSandbox({ throwStorage: true });
    const guard = sb.api.createDraftGuard({ resource: KEY, collect: () => ({ g: 7 }) });
    expect(() => { guard.markDirty(); sb.flushTimers(); }).not.toThrow();
    expect(() => guard.stashNow()).not.toThrow();
    expect(guard.tryRestore()).toBeNull();
    expect(() => guard.setResource('swl:draft:other')).not.toThrow();
    // still dirty → the beforeunload warning must keep working
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(true);
    expect(() => guard.markClean()).not.toThrow();
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);
  });
});

// #138: two "new post" tabs used to stash under one key, so the first save
// re-keyed and deleted the other tab's work. Model two tabs as two sandboxes
// over ONE localStorage, each with its own sessionStorage.
describe('DraftGuard owner/resource/context stash keys (#138/#305)', () => {
  const tab = (store: Map<string, string>, resource = 'post:new') => {
    const sb = makeSandbox({ store });
    let title = 'draft';
    const guard = sb.api.createDraftGuard({ resource, collect: () => ({ title }) });
    return { sb, guard, edit(value: string) { title = value; guard.markDirty(); sb.flushTimers(); } };
  };
  it.each(['post:new', 'post:existing', 'page:about'])('keeps duplicated-tab contexts independent for %s', resource => {
    const store = new Map<string, string>();
    const a = tab(store, resource); const b = tab(store, resource);
    a.edit('A'); b.edit('B');
    expect(store.size).toBe(2);
    a.guard.markClean();
    expect(b.guard.tryRestore()?.payload).toEqual({ title: 'B' });
  });
  it('offers scoped work after reload without overwriting its source on adoption', () => {
    const store = new Map<string, string>();
    const first = tab(store); first.edit('typed');
    const source = first.guard.tryRestore()!;
    const reloaded = tab(store); expect(reloaded.guard.tryRestore()?.payload).toEqual({ title: 'typed' });
    reloaded.guard.adopt(source); reloaded.edit('edited');
    expect(store.get(source.key!)).toContain('typed');
    expect(store.size).toBe(2);
    reloaded.guard.markClean();
    expect(store.size).toBe(0);
  });
  it('never offers unknown-owner legacy bytes and leaves them untouched', () => {
    const store = new Map<string, string>([['swl:draft:new', '{"payload":{"title":"legacy"}}']]);
    const fresh = tab(store);
    expect(fresh.guard.tryRestore()).toBeNull();
    fresh.guard.markClean();
    expect(store.get('swl:draft:new')).toBe('{"payload":{"title":"legacy"}}');
  });
  it('declining another context keeps its record and dismissal is exact', () => {
    const store = new Map<string, string>();
    const a = tab(store); a.edit('theirs'); const source = a.guard.tryRestore()!;
    const b = tab(store); b.guard.dismissRestore(source);
    expect(b.guard.wasDismissed(source)).toBe(true);
    b.edit('mine');
    expect(store.get(source.key!)).toContain('theirs');
    expect(store.size).toBe(2);
  });
  it('never exposes a different resource and skips corrupt scoped records', () => {
    const store = new Map<string, string>();
    const a = tab(store); a.edit('good');
    const source = a.guard.tryRestore()!;
    const badKey = source.key!.replace(/record:[^:]+$/, 'record:22222222-2222-4222-8222-222222222222');
    store.set(badKey, '{not json');
    expect(tab(store).guard.tryRestore()?.payload).toEqual({ title: 'good' });
    expect(tab(store, 'post:existing').guard.tryRestore()).toBeNull();
  });
});

// Static regression assertions on the admin pages (same readFileSync precedent
// as the server.test.ts fixtures): the wiring below is what keeps issue #22's
// guarantees — every page loads the guard, every 401 carries a return URL, and
// every fetch path surfaces a visible error.
describe('admin page wiring', () => {
  const editor = readFileSync('public/editor.html', 'utf8');
  const about = readFileSync('public/about.html', 'utf8');
  const login = readFileSync('public/login.html', 'utf8');
  const auth = readFileSync('public/auth.js', 'utf8');

  it('editor, about, and login load the shared draft-guard script', () => {
    for (const page of [editor, about, login]) {
      expect(page).toContain('<script src="/admin/draft-guard.js"></script>');
    }
  });

  it('editor and about create a guard and route every 401 through it', () => {
    for (const page of [editor, about]) {
      expect(page).toContain('DraftGuard.createDraftGuard(');
      expect(page).toContain('guard.redirectToLogin()');
      // no bare login redirect may survive — it would drop the ?next= return URL
      expect(page).not.toMatch(/location\.href = '\/login/);
    }
  });

  it('the sidebar user badge never interpolates the username into innerHTML (#131)', () => {
    // The shell is one template assigned to innerHTML; user-controlled strings
    // (username, page title, lede) are set as text afterwards.
    const start = auth.indexOf('shell.innerHTML');
    const end = auth.indexOf("shell.querySelector('.cms-avatar')");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const shell = auth.slice(start, end);
    expect(shell).not.toMatch(/\$\{s\.username/);
    expect(shell).not.toMatch(/\$\{pageTitle/);
    expect(shell).not.toMatch(/\$\{pageLede/);
    expect(auth).toContain(".cms-user-name').textContent = s.username");
  });

  it('the desk is a publishing home, not a second uploader', () => {
    const index = readFileSync('public/index.html', 'utf8');
    expect(index).toContain('<h1>Desk</h1>');
    expect(index).toContain("fetch('/posts')");
    expect(index).toContain("fetch('/media/queue')");
    expect(index).not.toContain("fetch('/upload'");
    expect(index).not.toContain('/api/cms/stats');
    expect(index).not.toContain('id="key"');
  });

  it('the gallery picker offers exactly the layout modes the renderer accepts', () => {
    // A fourth label here, or a renamed value, would give the author a mode the
    // site silently falls back to break-out for — the failure is invisible in
    // the admin and only shows up on the published page.
    const block = editor.slice(editor.indexOf('const GALLERY_LAYOUTS'));
    const values = [...block.slice(0, block.indexOf('];')).matchAll(/value: '([a-z]+)'/g)].map((m) => m[1]);
    expect(values).toEqual([...GALLERY_MODES]);
    expect(editor).toContain('layouts: GALLERY_LAYOUTS');
    // Seeded from the fence and written back through withLayout, so editing a
    // gallery cannot silently reset the layout the author chose.
    expect(editor).toContain('GalleryFence.layoutOf(current.directives)');
    expect(editor).toContain('GalleryFence.withLayout(current.directives,');
  });

  it('declining the restore prompt keeps the stash (non-destructive) instead of wiping it', () => {
    // A misclicked Cancel must not destroy unsaved work: both editors gate the
    // prompt on wasDismissed() and, when a stash exists but is not restored,
    // call dismissRestore() (keeps the stash) rather than the stash-deleting
    // tokenless markClean(). markClean() stays only for the no-stash branch.
    for (const page of [editor, about]) {
      expect(page).toContain('guard.wasDismissed(stash)');
      expect(page).toContain('guard.dismissRestore(stash)');
    }
  });

  it('login honors a validated ?next= return URL', () => {
    expect(login).toContain('DraftGuard.safeNextPath(');
    expect(login).toContain('location.href = nextPath');
    expect(login).not.toMatch(/location\.href = '\/admin\/'/);
  });


  it('EasyMDE built-in autosave stays disabled (DraftGuard owns persistence)', () => {
    // @ai-warning do not re-enable EasyMDE autosave: it is body-only and would
    // fight the full-form DraftGuard stash (duplicate writes, partial restores).
    expect(editor.match(/autosave: \{ enabled: false \}/g)).toHaveLength(2);
    expect(about.match(/autosave: \{ enabled: false \}/g)).toHaveLength(2);
  });
});

/**
 * Issue #85's two settings fields, and the copy that explains the new recovery
 * behaviour. A settings field needs markup AND `fill()` AND the POST body —
 * miss one and it either never displays or never persists, and nothing else
 * catches it: the server tests exercise the API, not the page.
 */
describe('settings.html import pacing fields', () => {
  const html = readFileSync('public/settings.html', 'utf8');

  it('renders an input for each field, bounded to match the server', () => {
    // Bounds are duplicated in the server's validate() by necessity; keeping the
    // numbers here identical is what makes the client-side rejection agree.
    expect(html).toMatch(/<input id="importDelayMs"[^>]*min="0"[^>]*max="10000"/);
    expect(html).toMatch(/<input id="importRetries"[^>]*min="0"[^>]*max="5"/);
  });

  it('labels both inputs for screen readers', () => {
    expect(html).toMatch(/<label for="importDelayMs">/);
    expect(html).toMatch(/<label for="importRetries">/);
  });

  it('populates both from the loaded settings', () => {
    expect(html).toMatch(/\$\('importDelayMs'\)\.value = s\.importDelayMs/);
    expect(html).toMatch(/\$\('importRetries'\)\.value = s\.importRetries/);
  });

  it('sends both in the save payload', () => {
    expect(html).toMatch(/importDelayMs: Number\(\$\('importDelayMs'\)\.value\)/);
    expect(html).toMatch(/importRetries: Number\(\$\('importRetries'\)\.value\)/);
  });
});

/**
 * The AI provider registry (spec 2026-10-19 §6) replaced the single shared key.
 * The behaviour lives in admin-actions-dom.test.ts; these pin what a markup or
 * script edit could silently bring back or weaken.
 */
describe('settings.html AI provider registry', () => {
  const html = readFileSync('public/settings.html', 'utf8');
  const markup = html.slice(0, html.indexOf('<script'));

  it('has no legacy shared-key controls left', () => {
    for (const id of ['aiApiKey', 'removeAiKey', 'aiProvider', 'captionProvider', 'aiCustomBaseUrl', 'captionCustomBaseUrl', 'baseUrl', 'model', 'modelManual', 'aiKeyStatus', 'saveReview']) {
      expect(markup).not.toContain(`id="${id}"`);
    }
    expect(html).not.toMatch(/aiApiKey|hasAiApiKey|lmBaseUrl/);
  });

  it('takes a provider key only in a masked, never-autofilled field', () => {
    expect(markup).toMatch(/<input id="providerApiKey" type="password" autocomplete="new-password"/);
  });

  it('keeps keys out of storage and logs', () => {
    expect(html).not.toMatch(/localStorage|sessionStorage|console\./);
  });

  it('pairs each use case with a provider select, a model select, a bounded Other ID field and an announced model-list status', () => {
    for (const [provider, model, status] of [
      ['reviewProviderId', 'aiModel', 'reviewModelStatus'], ['captionProviderId', 'lmModel', 'captionModelStatus'],
    ] as const) {
      expect(markup).toMatch(new RegExp(`<select id="${provider}"`));
      expect(markup).toMatch(new RegExp(`<select id="${model}"[^>]*aria-describedby="${status}"`));
      // A typed model ID keeps the 100-character cap of the text field it replaced.
      expect(markup).toMatch(new RegExp(`<input id="${model}Other" type="text" maxlength="100"`));
      expect(markup).toMatch(new RegExp(`<p id="${status}"[^>]*role="status"`));
    }
    expect(markup).not.toMatch(/<datalist|list="/);
  });
});

describe('import.html recovery copy', () => {
  const html = readFileSync('public/import.html', 'utf8');

  // After #92 the recovery story is: the import runs on the server, the page
  // polls its progress, and re-running resumes from disk (#85).
  it('tells the author the import runs on the server, is polled, and that re-running resumes', () => {
    expect(html).toMatch(/runs on the server/i);
    expect(html).toMatch(/\/import\/status/);
    expect(html).toMatch(/again/i);
    expect(html).toMatch(/resum/i);
  });

  // The whole complaint in #85 is that `imported: 9, skipped: 0` read as a clean
  // success while 95% of the photos had silently kept their wp-content URL.
  it('shows the image tally alongside the post counts', () => {
    expect(html).toMatch(/data\.images/);
    // the counts line reports hosted-of-total, not just the post numbers
    expect(html).toMatch(/\$\('counts'\)[\s\S]{0,400}hosted/);
  });

  it('calls out un-hosted photos rather than leaving them to the warning list', () => {
    expect(html).toMatch(/\.failed > 0/);
    // a dedicated element, announced, not a colour-only cue
    expect(html).toMatch(/id="importPartial"[^>]*role="status"/);
  });

  // #100: `skipped` conflated "already published" (a success) with "rejected"
  // (an import-boundary refusal, i.e. the path-traversal defence firing) and
  // a thrown upsert. The tally must name each bucket, and the security signal
  // gets a callout — the same treatment #85 gave un-hosted photos.
  it('names each post bucket and calls out rejected groups', () => {
    expect(html).toMatch(/data\.skippedPublished/);
    expect(html).toMatch(/data\.rejected/);
    expect(html).toMatch(/data\.failed/);
    // a dedicated element, announced, not a colour-only cue
    expect(html).toMatch(/id="importRejected"[^>]*role="alert"/);
    expect(html).toMatch(/rejected > 0/);
  });
});
