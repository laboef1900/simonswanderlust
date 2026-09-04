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
}
interface Guard {
  markDirty(): void;
  markClean(token?: number): void;
  snapshot(): number;
  stashNow(): void;
  tryRestore(): Stash | null;
  dismissRestore(stash: Stash | null): void;
  wasDismissed(stash: Stash | null): boolean;
  setKey(newKey: string): void;
  redirectToLogin(): void;
}
interface DraftGuardApi {
  safeNextPath(raw: string | null): string;
  createDraftGuard(opts: { storageKey: string; collect: () => unknown; debounceMs?: number }): Guard;
}
interface StubEvent {
  defaultPrevented: boolean;
  returnValue: string | undefined;
  preventDefault: () => void;
}

function makeSandbox(opts: { throwStorage?: boolean } = {}) {
  const beforeUnload: Array<(e: StubEvent) => void> = [];
  const store = new Map<string, string>();
  const timers = new Map<number, () => void>();
  let nextId = 1;

  const localStorageStub = opts.throwStorage
    ? {
        getItem: (): string | null => { throw new Error('quota exceeded'); },
        setItem: (): void => { throw new Error('quota exceeded'); },
        removeItem: (): void => { throw new Error('quota exceeded'); },
      }
    : {
        getItem: (k: string): string | null => store.get(k) ?? null,
        setItem: (k: string, v: string): void => { store.set(k, String(v)); },
        removeItem: (k: string): void => { store.delete(k); },
      };

  // sessionStorage-backed dismissal marker (per-tab; separate from localStorage).
  const session = new Map<string, string>();
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
    localStorage: localStorageStub,
    sessionStorage: sessionStorageStub,
    location,
    setTimeout: (fn: () => void): number => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimeout: (id: number): void => { timers.delete(id); },
  });

  const api = windowStub.DraftGuard;
  if (!api) throw new Error('draft-guard.js did not assign window.DraftGuard');

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
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ a: 1 }) });

    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);

    guard.markDirty();
    const e = sb.fireBeforeUnload();
    expect(e.defaultPrevented).toBe(true);
    expect(e.returnValue).toBe('');
    expect(sb.store.has(KEY)).toBe(true); // stashed even if the user leaves anyway

    guard.markClean();
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('markDirty schedules one debounced stash of the collected payload', () => {
    const sb = makeSandbox();
    let collectCalls = 0;
    const guard = sb.api.createDraftGuard({
      storageKey: KEY,
      collect: () => { collectCalls += 1; return { title: 'Rhodos', de: { slug: 'rhodos' } }; },
    });

    guard.markDirty();
    guard.markDirty();
    guard.markDirty();
    expect(sb.pendingTimers()).toBe(1); // debounced: earlier timers cancelled
    expect(sb.store.has(KEY)).toBe(false);

    sb.flushTimers();
    expect(collectCalls).toBe(1);
    const stash = JSON.parse(sb.store.get(KEY) ?? '') as Stash;
    expect(typeof stash.savedAt).toBe('string');
    expect(stash.payload).toEqual({ title: 'Rhodos', de: { slug: 'rhodos' } });
  });

  it('stashNow writes synchronously and tryRestore round-trips it', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ b: 2 }) });
    guard.stashNow();
    const restored = guard.tryRestore();
    expect(restored).not.toBeNull();
    expect(restored?.payload).toEqual({ b: 2 });
  });

  it('tryRestore returns null for absent, corrupt, or misshapen stashes', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({}) });
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
    // Tokenless = unconditional: used by the restore-declined path, NOT by the
    // save handlers (those must pass a snapshot() token — see the race tests).
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ c: 3 }) });
    guard.stashNow();
    guard.markDirty();
    guard.markClean();
    expect(sb.store.has(KEY)).toBe(false);
    expect(sb.pendingTimers()).toBe(0);
    sb.flushTimers();
    expect(sb.store.has(KEY)).toBe(false);
  });

  it('dismissRestore keeps the stash but disarms the warning (a misclicked Cancel loses nothing)', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ h: 8 }) });
    guard.stashNow();
    guard.markDirty();
    const stash = guard.tryRestore();
    guard.dismissRestore(stash);
    expect(sb.store.has(KEY)).toBe(true);                       // stash preserved (recoverable)
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false); // dirty disarmed
    expect(sb.pendingTimers()).toBe(0);                         // debounced stash cancelled
    // Restoring the still-present stash on a later load round-trips the payload.
    expect(guard.tryRestore()?.payload).toEqual({ h: 8 });
  });

  it('wasDismissed suppresses a re-prompt for the same stash but not a newer one', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ i: 9 }) });
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
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ j: 10 }) });
    const stash = { savedAt: 'now', payload: { j: 10 } };
    expect(() => guard.dismissRestore(stash)).not.toThrow();
    expect(guard.wasDismissed(stash)).toBe(false); // can't record → treated as not dismissed
  });

  it('markClean with a current snapshot token cleans normally after a save', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ c: 3 }) });
    guard.markDirty();
    const snap = guard.snapshot(); // taken just before the save fetch
    guard.markClean(snap);         // response landed, nothing typed meanwhile
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);
    expect(sb.pendingTimers()).toBe(0);
    expect(sb.store.has(KEY)).toBe(false);
  });

  it('markClean with a stale token keeps mid-save edits dirty and stashed', () => {
    // Race from the review: payload snapshotted at t0, user keeps typing while
    // the request is in flight (the About save runs a full astro rebuild), the
    // response lands and must NOT wipe the newer on-screen edits' protection.
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ c: 3 }) });
    guard.markDirty();
    const snap = guard.snapshot(); // save fetch starts here
    guard.markDirty();             // user typed while the save was in flight
    guard.markClean(snap);         // save response lands
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(true); // warning still armed
    expect(sb.pendingTimers()).toBe(1);                        // debounced stash still pending
    sb.flushTimers();
    expect(sb.store.has(KEY)).toBe(true);                      // newer edits get stashed
  });

  it('setKey moves an existing stash to the new key', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: 'swl:draft:new', collect: () => ({ d: 4 }) });
    guard.stashNow();
    guard.setKey('swl:draft:tk-123');
    expect(sb.store.has('swl:draft:new')).toBe(false);
    const moved = JSON.parse(sb.store.get('swl:draft:tk-123') ?? '') as Stash;
    expect(moved.payload).toEqual({ d: 4 });
    guard.markClean(); // now operates on the new key
    expect(sb.store.has('swl:draft:tk-123')).toBe(false);
  });

  it('redirectToLogin stashes dirty work, disarms the prompt, and carries ?next=', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ e: 5 }) });
    guard.markDirty();
    guard.redirectToLogin();
    expect(sb.store.has(KEY)).toBe(true);
    expect(sb.location.href).toBe('/login?next=%2Fadmin%2Feditor.html%3Ftk%3Dabc');
    // the intentional navigation must not trigger the leave-page dialog
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('redirectToLogin does not stash a pristine form (nothing worth restoring)', () => {
    const sb = makeSandbox();
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ f: 6 }) });
    guard.redirectToLogin();
    expect(sb.store.has(KEY)).toBe(false);
    expect(sb.location.href).toBe('/login?next=%2Fadmin%2Feditor.html%3Ftk%3Dabc');
  });

  it('degrades to warning-only when localStorage throws (quota / private mode)', () => {
    const sb = makeSandbox({ throwStorage: true });
    const guard = sb.api.createDraftGuard({ storageKey: KEY, collect: () => ({ g: 7 }) });
    expect(() => { guard.markDirty(); sb.flushTimers(); }).not.toThrow();
    expect(() => guard.stashNow()).not.toThrow();
    expect(guard.tryRestore()).toBeNull();
    expect(() => guard.setKey('swl:draft:other')).not.toThrow();
    // still dirty → the beforeunload warning must keep working
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(true);
    expect(() => guard.markClean()).not.toThrow();
    expect(sb.fireBeforeUnload().defaultPrevented).toBe(false);
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

  it('every fetch path surfaces a visible error on network failure', () => {
    expect(editor).toContain("'Upload failed: ' + e");
    expect(editor).toContain("'Save failed: ' + e");
    expect(editor).toContain("'Publish failed: ' + e");
    expect(editor).toContain("'Could not load post: ' + e");
    expect(about).toContain("'Upload failed: ' + e");
    expect(about).toContain("'Save failed: ' + e");
    expect(about).toContain("'Could not load: ' + e");
    expect(login).toContain("'Error: ' + e");
  });

  it('populateForm applies restore payloads deterministically (no field resurrection)', () => {
    // buildPayload() omits cleared/empty fields from the stash, so populateForm
    // must write every shared/hero field unconditionally with a fallback — an
    // `if (shared.route)`-style guard resurrects server values the user deleted
    // when a stash is restored over an already-loaded post.
    expect(editor).toContain("$('fmDate').value = shared.date || ''");
    expect(editor).toContain("$('fmCountryCode').value = shared.countryCode || ''");
    expect(editor).toContain("$('fmRegion').value = shared.region || ''");
    expect(editor).toContain("$('fmRoute').value = shared.route || ''");
    expect(editor).toContain('const coords = shared.coordinates || {}');
    expect(editor).toContain('const hero = data.heroImage || {}');
    // country and keyFacts moved per-locale (issue #87) — same unconditional-write
    // contract applies to populateLocale as to populateForm.
    expect(editor).toContain("$(loc + 'Country').value = data.country || ''");
    expect(editor).toContain('populateKeyFacts(loc, data.keyFacts)');
    expect(editor).not.toMatch(/if \(shared\.(date|countryCode|region|route|coordinates)\)/);
    expect(editor).not.toMatch(/if \(data\.(heroImage|country|keyFacts)\)/);
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

  it('save handlers pass a pre-fetch snapshot token to markClean (mid-save edits survive)', () => {
    for (const page of [editor, about]) {
      expect(page).toContain('const snap = guard.snapshot()');
      expect(page).toContain('guard.markClean(snap)');
      // the unconditional form must not be used on the save path
      expect(page.match(/guard\.markClean\(\)/g) ?? []).toHaveLength(1); // restore-declined only
    }
  });

  it('login honors a validated ?next= return URL', () => {
    expect(login).toContain('DraftGuard.safeNextPath(');
    expect(login).toContain('location.href = nextPath');
    expect(login).not.toMatch(/location\.href = '\/admin\/'/);
  });

  it('ensureAuthed sends the current page as the return URL', () => {
    expect(auth).toContain("'/login?next=' + encodeURIComponent(location.pathname + location.search)");
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

describe('import.html recovery copy', () => {
  const html = readFileSync('public/import.html', 'utf8');

  // After #85 this IS the user-facing recovery story: the request usually
  // outlives the browser's patience, and re-running resumes from disk.
  it('tells the author the import survives a browser timeout and that re-running resumes', () => {
    expect(html).toMatch(/continues on the server/i);
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
