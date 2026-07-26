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
  listQuery(state: Record<string, unknown>): string;
  makeClient(opts: Record<string, unknown>): Record<string, (...args: never[]) => Promise<unknown>>;
  createUploadQueue(client: unknown, opts?: Record<string, unknown>): {
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
  const windowStub: Record<string, unknown> = { fetch: () => {}, FormData: FakeFormData, XMLHttpRequest: class {} };
  vm.runInNewContext(src, { window: windowStub, FormData: FakeFormData, ...extraGlobals });
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
    send(): void {
      const step = script[call++] ?? { status: 200, body: {} };
      let settled = false;
      instances.push({
        resolve: () => {
          if (settled) return;   // idempotent: resolveAll() may be called again
          settled = true;
          this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
          if (step.fail) { this.onerror?.(); return; }
          this.status = step.status ?? 200;
          this.responseText = JSON.stringify(step.body ?? {});
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

  it('tracks failed UPLOADS separately and can retry just those', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([{ status: 503, body: { error: 'unavailable' } }, { status: 200, body: { key: 'k' } }]);
    const client = api.makeClient({ XMLHttpRequest: FakeXhr, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    const q = api.createUploadQueue(client, { concurrency: 1 });
    q.add([file('a.jpg')]);
    instances[0]!.resolve();
    await flush();
    expect(q.snapshot().failed).toBe(1);
    expect(q.snapshot().items[0]!.error).toBe('unavailable');

    // One laptop sleep in a 100-file batch must not leave the author guessing.
    q.retryFailed();
    expect(q.snapshot().failed).toBe(0);
    instances[1]!.resolve();
    await flush();
    expect(q.snapshot().done).toBe(1);
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
    q.add([file('a.jpg')]);
    instances[0]!.resolve();
    await flush();
    expect(unauthed).toBe(1);
  });

  it('clearFinished drops completed items but keeps failures visible', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([{ status: 200, body: {} }, { status: 500, body: { error: 'boom' } }]);
    const client = api.makeClient({ XMLHttpRequest: FakeXhr, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    const q = api.createUploadQueue(client, { concurrency: 2 });
    q.add([file('a.jpg'), file('b.jpg')]);
    instances.forEach((i) => i.resolve());
    await flush();
    q.clearFinished();
    expect(q.snapshot().items.map((i) => i.state)).toEqual(['failed']);
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
    await expect(client.list!({} as never)).rejects.toThrow('unauthorized');
    expect(unauthed).toBe(1);
    await expect(client.deleteFolder!('x' as never)).rejects.toThrow('folder is not empty');
  });

  it('sends JSON bodies and builds item URLs from the key', async () => {
    const api = load();
    const calls: { url: string; init: { method: string; body?: string } }[] = [];
    const client = api.makeClient({
      fetch: async (url: string, init: { method: string; body?: string }) => {
        calls.push({ url, init });
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      },
      XMLHttpRequest: class {},
    });
    await client.patch!('trips/x/hero' as never, { title: 'T' } as never);
    expect(calls[0]!.url).toBe('/media/items/trips/x/hero');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ title: 'T' });
  });
});

describe('media client DOM safety', () => {
  const browser = readFileSync('public/media-browser.js', 'utf8');
  const picker = readFileSync('public/media-picker.js', 'utf8');
  const page = readFileSync('public/media.html', 'utf8');

  // @ai-warning: these modules render attacker-influenced EXIF strings, folder
  // names, titles and captions. Every existing admin page already builds DOM
  // with textContent, but that was convention, not a written rule — this makes
  // it enforceable.
  it('never assigns innerHTML anything but the empty string', () => {
    for (const src of [browser, picker]) {
      for (const match of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)) {
        expect(match[1]?.trim()).toBe("''");
      }
    }
  });

  it('never builds markup with insertAdjacentHTML, outerHTML or document.write', () => {
    for (const src of [browser, picker]) {
      expect(src).not.toMatch(/insertAdjacentHTML|outerHTML|document\.write/);
    }
  });

  it('the page loads the split modules rather than inlining the logic', () => {
    expect(page).toContain('<script src="/admin/media-api.js"></script>');
    expect(page).toContain('<script src="/admin/media-browser.js"></script>');
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
