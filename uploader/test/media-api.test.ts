import { webcrypto, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// media-api.js is a plain browser IIFE (window.MediaApi) holding the library
// client's pure parts — selection math, formatting, query building and the
// upload queue's scheduling. Run it in a vm sandbox, the same precedent as
// draft-guard.js / posts-filter.js, so all of that is covered without a
// browser (Golden Rule 1).
const src = readFileSync('public/media-api.js', 'utf8');

interface QueueSnapshot {
  items: { id: number; name: string; state: string; progress: number; error: string | null; result: unknown }[];
  total: number; done: number; failed: number; active: number;
}
interface Api {
  UPLOAD_CONCURRENCY: number;
  formatBytes(n: unknown): string;
  formatTakenAt(iso: unknown): string;
  rangeBetween(keys: string[], anchor: string, target: string): string[];
  folderTree(paths: string[]): { path: string; name: string; depth: number }[];
  parentOf(path: string): string;
  statusLabel(item: unknown): string;
  queueState(item: Record<string, unknown>): string;
  listQuery(state: Record<string, unknown>): string;
  debounce(fn: (...args: unknown[]) => void, ms: number): (...args: unknown[]) => void;
  makeSequence(): { next(): number; isCurrent(ticket: number): boolean };
  makeClient(opts: Record<string, unknown>): Record<string, (...args: never[]) => Promise<unknown>>;
  createUploadQueue(client: unknown, opts?: Record<string, unknown>): {
    initialize(ownerId: string): void;
    observeOwner(ownerId: string | null): void;
    resume(): Promise<unknown>;
    check(id: number): Promise<void>;
    add(files: unknown[], fields?: Record<string, string>): void;
    retryFailed(): void;
    clearFinished(): void;
    snapshot(): QueueSnapshot;
  };
}

/** Minimal FormData — it needs a real `append`, or uploadOne throws before it
 *  ever reaches the XHR and every upload looks like a network failure. */
class FakeFormData {
  parts: [string, unknown][] = [];
  append(name: string, value: unknown): void { this.parts.push([name, value]); }
}

function load(extraGlobals: Record<string, unknown> = {}): Api {
  const windowStub: Record<string, unknown> = { fetch: () => {}, FormData: FakeFormData, XMLHttpRequest: class {}, crypto: webcrypto };
  vm.runInNewContext(src, { window: windowStub, FormData: FakeFormData, AbortController, setTimeout, clearTimeout, ...extraGlobals });
  return windowStub.MediaApi as Api;
}

describe('MediaApi pure helpers', () => {
  const api = load();

  it('formats byte sizes like the server does', () => {
    expect(api.formatBytes(0)).toBe('0 B');
    expect(api.formatBytes(1536)).toBe('1.5 kB');
    expect(api.formatBytes(10.7 * 1024 * 1024)).toBe('11 MB');
    expect(api.formatBytes('nope')).toBe('0 B');
    expect(api.formatBytes(-1)).toBe('0 B');
  });

  // @ai-warning: EXIF is naive wall-clock relabelled as UTC. A local-time
  // formatter double-shifts it and silently mislabels photos across timezones.
  it('formats a capture time with UTC accessors, not local time', () => {
    expect(api.formatTakenAt('2026-07-04T18:23:11.000Z')).toBe('2026-07-04 18:23');
    expect(api.formatTakenAt(null)).toBe('');
    expect(api.formatTakenAt('not a date')).toBe('');
  });

  it('computes an inclusive selection range in either direction', () => {
    const keys = ['a', 'b', 'c', 'd'];
    expect(api.rangeBetween(keys, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(api.rangeBetween(keys, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(api.rangeBetween(keys, 'b', 'b')).toEqual(['b']);
  });

  it('falls back to the target alone when the anchor is stale (e.g. after a filter change)', () => {
    expect(api.rangeBetween(['a', 'b'], 'gone', 'b')).toEqual(['b']);
    expect(api.rangeBetween(['a', 'b'], 'a', 'gone')).toEqual(['gone']);
  });

  it('builds a folder tree with depth, sorted', () => {
    expect(api.folderTree(['b', 'a/x', 'a'])).toEqual([
      { path: 'a', name: 'a', depth: 0 },
      { path: 'a/x', name: 'x', depth: 1 },
      { path: 'b', name: 'b', depth: 0 },
    ]);
  });

  it('finds a folder parent', () => {
    expect(api.parentOf('a/b/c')).toBe('a/b');
    expect(api.parentOf('a')).toBe('');
  });

  it('labels only non-ready statuses, and never shows a raw error string', () => {
    expect(api.statusLabel({ status: 'ready' })).toBe('');
    expect(api.statusLabel({ status: 'processing' })).toBe('processing');
    expect(api.statusLabel({ status: 'missing' })).toBe('file missing');
    // `error` is a fixed server-side enum, never a libvips message.
    expect(api.statusLabel({ status: 'failed', error: 'decode_failed' })).toBe('failed: decode_failed');
  });

  it('names the folder a duplicate already lives in instead of a bare "done"', () => {
    expect(api.queueState({ state: 'uploading', progress: 0.5 })).toBe('50%');
    expect(api.queueState({ state: 'failed', error: 'too large' })).toBe('too large');
    expect(api.queueState({ state: 'done', result: { duplicate: false } })).toBe('done');
    expect(api.queueState({ state: 'done', result: { duplicate: true, folder: 'Iceland/South' } })).toBe('already in Iceland/South');
    expect(api.queueState({ state: 'done', result: { duplicate: true, folder: '' } })).toBe('already in root');
  });

  it('builds a list query, omitting empty values but keeping an explicit root folder', () => {
    expect(api.listQuery({})).toBe('');
    // folder:'' is the ROOT filter and must survive; q:'' is just "no search".
    expect(api.listQuery({ folder: '', q: '' })).toBe('?folder=');
    expect(api.listQuery({ folder: 'Island Süd', recursive: true, q: 'a b', page: 2 }))
      .toBe('?folder=Island%20S%C3%BCd&recursive=1&q=a%20b&page=2');
  });

  it('URL-encodes a search term so it cannot break out of the query string', () => {
    expect(api.listQuery({ q: '&status=ready#x' })).toBe('?q=%26status%3Dready%23x');
  });
});

// A fake XHR good enough to drive the queue deterministically.
function fakeXhrClass(script: { status?: number; body?: unknown; fail?: boolean }[]) {
  let call = 0;
  const instances: { resolve: () => void }[] = [];
  class FakeXhr {
    upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    status = 200;
    responseText = '{}';
    open(): void {}
    send(form: FakeFormData): void {
      const step = script[call++] ?? { status: 200, body: {} };
      let settled = false;
      instances.push({
        resolve: () => {
          if (settled) return;   // idempotent: resolveAll() may be called again
          settled = true;
          this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
          if (step.fail) { this.onerror?.(); return; }
          this.status = step.status ?? 200;
          const fields = Object.fromEntries(form.parts);
          const accepted = { state: 'accepted', ownerUserId: fields.expectedOwnerId, uploadId: fields.uploadId,
            key: 'k', src: 'https://images.test/k', width: 800, height: 600 };
          this.responseText = JSON.stringify(this.status >= 200 && this.status < 300 ? { ...accepted, ...step.body as object } : step.body ?? {});
          this.onload?.();
        },
      });
    }
  }
  return { FakeXhr, instances };
}

/** Let the queue's promise chains (upload → settle → pump) run to quiescence. */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('MediaApi upload queue', () => {
  const file = (name: string) => ({ name });

  it('respects the concurrency limit and reports per-file state', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([]);
    const client = api.makeClient({ XMLHttpRequest: FakeXhr, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    const snaps: QueueSnapshot[] = [];
    const q = api.createUploadQueue(client, { concurrency: 2, onChange: (s: QueueSnapshot) => snaps.push(s) });
    q.initialize(randomUUID());
    q.add([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    // Browser uploads are transfer-bound, so 3 by default — but the cap is
    // honoured whatever it is set to.
    expect(q.snapshot().active).toBe(2);
    expect(q.snapshot().items.map((i) => i.state)).toEqual(['uploading', 'uploading', 'queued']);

    // Resolve repeatedly: each completion frees a slot and starts the next.
    for (let i = 0; i < 4; i++) { instances.forEach((x) => x.resolve()); await flush(2); }
    expect(q.snapshot().done).toBe(3);
    expect(snaps.length).toBeGreaterThan(0);
  });

  it('tracks definitely refused uploads separately and retries only those', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([{ status: 413, body: { error: 'too large' } }, { status: 200, body: { key: 'k' } }]);
    const client = api.makeClient({ XMLHttpRequest: FakeXhr, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    const q = api.createUploadQueue(client, { concurrency: 1 });
    q.initialize(randomUUID());
    q.add([file('a.jpg')]);
    instances[0]!.resolve();
    await flush();
    expect(q.snapshot().failed).toBe(1);
    expect(q.snapshot().items[0]!.error).toBe('too large');

    // Explicit retry is safe only for a refusal; network/5xx stay Unknown.
    q.retryFailed();
    expect(q.snapshot().failed).toBe(0);
    instances[1]!.resolve();
    await flush();
    expect(q.snapshot().done).toBe(1);
  });

  it('probes a 503 once and never resends its unknown file through Retry failed', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([{ status: 503, body: { error: 'unavailable' } }]);
    let probes = 0;
    const client = api.makeClient({ XMLHttpRequest: FakeXhr, fetch: async () => {
      probes++;
      return { status: 404, ok: false, json: async () => ({ error: 'not found' }) };
    } });
    const q = api.createUploadQueue(client, { concurrency: 1 });
    q.initialize(randomUUID());
    q.add([file('a.jpg')]);
    instances[0]!.resolve();
    await flush();
    expect(q.snapshot().items[0]!.state).toBe('unknown');
    expect(probes).toBe(1);
    q.retryFailed();
    await flush();
    expect(instances).toHaveLength(1);
    expect(probes).toBe(1);
    expect(q.snapshot().items[0]!.state).toBe('unknown');
  });

  // @ai-warning: XMLHttpRequest is the ONE admin request path that bypasses
  // Auth's shared fetch wrapper, so it needs its own 401 handling.
  it('routes a 401 from the XHR upload path through onUnauthed', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([{ status: 401, body: { error: 'unauthorized' } }]);
    let unauthed = 0;
    const client = api.makeClient({
      XMLHttpRequest: FakeXhr, onUnauthed: () => { unauthed++; },
      fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }),
    });
    const q = api.createUploadQueue(client, { concurrency: 1 });
    q.initialize(randomUUID());
    q.add([file('a.jpg')]);
    instances[0]!.resolve();
    await flush();
    expect(unauthed).toBe(1);
  });

  it('clearFinished drops completed items but keeps failures visible', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([{ status: 200, body: {} }, { status: 400, body: { error: 'invalid image' } }]);
    const client = api.makeClient({ XMLHttpRequest: FakeXhr, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    const q = api.createUploadQueue(client, { concurrency: 2 });
    q.initialize(randomUUID());
    q.add([file('a.jpg'), file('b.jpg')]);
    instances.forEach((i) => i.resolve());
    await flush();
    q.clearFinished();
    expect(q.snapshot().items.map((i) => i.state)).toEqual(['failed']);
  });

  it('never transmits a file it can already refuse, and retry/clear treat refusals as final', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([{ status: 200, body: {} }]);
    const client = api.makeClient({ XMLHttpRequest: FakeXhr, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    const q = api.createUploadQueue(client, { concurrency: 3 });
    q.initialize(randomUUID());
    q.add([
      { name: 'a.heic', size: 10 }, { name: 'b.jpg', type: 'image/heif', size: 10 },
      { name: 'c.jpg', type: 'image/jpeg', size: 25 * 1024 * 1024 + 1 }, { name: 'd.txt', type: 'text/plain', size: 10 },
      // At the limit, or with nothing known about it, the server decides.
      { name: 'e.jpg', type: 'image/jpeg', size: 25 * 1024 * 1024 }, { name: 'f.jpg' },
    ]);
    expect(q.snapshot().items.map((i) => [i.state, i.error])).toEqual([
      ['refused', 'heic'], ['refused', 'heic'], ['refused', 'too_large'], ['refused', 'not_image'],
      ['uploading', null], ['uploading', null],
    ]);
    expect(instances).toHaveLength(2);
    instances.forEach((x) => x.resolve());
    await flush();
    q.retryFailed();
    expect(instances).toHaveLength(2);
    q.clearFinished();
    expect(q.snapshot().items.filter((i) => i.state === 'refused')).toEqual([]);
  });

  it('pauses a mid-batch 401 in place and resumes only explicitly as its captured owner', async () => {
    const owner = randomUUID(); let signedIn = owner; let refused = false;
    const calls: { name: string; fields: Record<string, unknown> }[] = [];
    const client = {
      me: async () => ({ userId: signedIn }),
      uploadOne: async (file: { name: string }, fields: Record<string, unknown>) => {
        calls.push({ name: file.name, fields });
        if (file.name === 'b.jpg' && !refused) { refused = true; throw Object.assign(new Error('unauthorized'), { status: 401 }); }
        return { ownerUserId: fields.expectedOwnerId, uploadId: fields.uploadId, state: 'accepted',
          key: file.name, src: 'https://images.test/' + file.name, width: 8, height: 6 };
      },
      receipt: async () => { throw new Error('Unexpected automatic receipt read for a refusal'); },
    };
    const q = load().createUploadQueue(client, { concurrency: 1 });
    q.initialize(owner); q.add([file('a.jpg'), file('b.jpg'), file('c.jpg')]); await flush();
    expect(q.snapshot().items.map(item => item.state)).toEqual(['done', 'needs-auth', 'queued']);
    signedIn = randomUUID(); expect(await q.resume()).toBe(false);
    expect(calls.map(call => call.name)).toEqual(['a.jpg', 'b.jpg']);
    signedIn = owner; q.observeOwner(owner); await flush();
    expect(calls).toHaveLength(2); // focus/sign-in alone never resumes
    await q.resume(); await flush();
    expect(q.snapshot().done).toBe(3);
    expect(calls.map(call => call.name)).toEqual(['a.jpg', 'b.jpg', 'b.jpg', 'c.jpg']);
    expect(calls[1]!.fields).toEqual(calls[2]!.fields);
    expect(calls.every(call => call.fields.expectedOwnerId === owner)).toBe(true);
  });
});

describe('MediaApi fetch client', () => {
  it('routes a 401 through onUnauthed and surfaces a server error message', async () => {
    const api = load();
    let unauthed = 0;
    const responses = [
      { status: 401, ok: false, json: async () => ({}) },
      { status: 409, ok: false, json: async () => ({ error: 'folder is not empty' }) },
    ];
    let i = 0;
    const client = api.makeClient({
      onUnauthed: () => { unauthed++; },
      fetch: async () => responses[i++],
      XMLHttpRequest: class {},
    });
    await expect(client.list!({} as never)).rejects.toMatchObject({ message: 'unauthorized', status: 401 });
    expect(unauthed).toBe(1);
    // The status rides along so a caller can tell "no such row" from a failure
    // without parsing the server's message (gallery-library.js relies on 404).
    await expect(client.deleteFolder!('x' as never)).rejects.toMatchObject({ message: 'folder is not empty', status: 409 });
  });

});

describe('MediaApi search helpers', () => {
  it('debounce runs once per burst, with the last call\'s arguments', () => {
    // Timers are injected so the vm context shares the (fake) host clock.
    const timers: { fn: () => void; ms: number; id: number; cleared: boolean }[] = [];
    let nextId = 1;
    const api = load({
      setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.push({ fn, ms, id, cleared: false }); return id; },
      clearTimeout: (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
    });
    const calls: unknown[][] = [];
    const search = api.debounce((...args) => { calls.push(args); }, 200);
    search('n'); search('no'); search('nor'); search('norw');
    expect(calls).toEqual([]);
    const live = timers.filter((t) => !t.cleared);
    expect(live).toHaveLength(1);
    expect(live[0]!.ms).toBe(200);
    live[0]!.fn();
    expect(calls).toEqual([['norw']]);
  });

  it('makeSequence marks a ticket stale once a newer one is issued', () => {
    const api = load();
    const seq = api.makeSequence();
    const first = seq.next();
    expect(seq.isCurrent(first)).toBe(true);
    const second = seq.next();
    expect(seq.isCurrent(first)).toBe(false);
    expect(seq.isCurrent(second)).toBe(true);
  });
});

describe('media client DOM safety', () => {
  const browser = readFileSync('public/media-browser.js', 'utf8');
  const picker = readFileSync('public/media-picker.js', 'utf8');
  const aiDialog = readFileSync('public/media-ai-dialog.js', 'utf8');
  const page = readFileSync('public/media.html', 'utf8');

  // @ai-warning: these modules render attacker-influenced EXIF strings, folder
  // names, titles and captions — and the AI dialog renders model-derived
  // failure reasons. Every existing admin page already builds DOM with
  // textContent, but that was convention, not a written rule — this makes it
  // enforceable.
  it('never assigns innerHTML anything but the empty string', () => {
    for (const src of [browser, picker, aiDialog]) {
      for (const match of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)) {
        expect(match[1]?.trim()).toBe("''");
      }
    }
  });

  it('never builds markup with insertAdjacentHTML, outerHTML or document.write', () => {
    for (const src of [browser, picker, aiDialog]) {
      expect(src).not.toMatch(/insertAdjacentHTML|outerHTML|document\.write/);
    }
  });

  it('the page loads the split modules rather than inlining the logic', () => {
    expect(page).toContain('<script src="/admin/media-api.js"></script>');
    expect(page).toContain('<script type="module" src="/admin/media-conditional.js"></script>');
    expect(page).toContain('<script type="module" src="/admin/media-browser.js"></script>');
    // "No bundler" permits multiple <script> tags; it never required one file.
    expect(page).not.toMatch(/<script>[\s\S]{200,}<\/script>/);
  });

  it('keeps the multi-select grid keyboard-operable (WCAG 2.1 AA)', () => {
    expect(page).toContain('aria-multiselectable="true"');
    expect(browser).toContain('ArrowRight');
    expect(browser).toContain('ArrowDown');
    expect(browser).toMatch(/ev\.shiftKey/);
    expect(browser).toMatch(/ctrlKey \|\| ev\.metaKey/);
    // Drag-to-reorder has no keyboard equivalent and is deliberately absent.
    expect(browser).not.toMatch(/dragstart|draggable/);
  });

  it('offers a visible file input, so drag-and-drop stays an enhancement', () => {
    expect(page).toContain('<input id="fileInput" type="file"');
    expect(page).not.toMatch(/id="fileInput"[^>]*hidden/);
  });
});
