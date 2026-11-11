import { webcrypto, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as MediaConditional from '../public/media-conditional.js';

// media-api.js is a plain browser IIFE (window.MediaApi) holding the library
// client's pure parts — selection math, formatting, query building and the
// upload queue's scheduling. Run it in a vm sandbox, the same precedent as
// draft-guard.js / posts-filter.js, so all of that is covered without a
// browser (Golden Rule 1).
const src = readFileSync('public/media-api.js', 'utf8');

interface QueueSnapshot {
  items: { id: number; name: string; state: string; progress: number; error: string | null; result: unknown }[];
  total: number; done: number; failed: number; rejected: number; refused: number; waiting: number; active: number;
}
interface Api {
  UPLOAD_CONCURRENCY: number;
  formatBytes(n: unknown): string;
  sentence(text: unknown): string;
  folderNameRefusal(name: unknown, parent?: string): string;
  uploadRejection(error: { status?: number; code?: string }): string | null;
  rangeBetween(keys: string[], anchor: string, target: string): string[];
  folderTree(paths: string[]): { path: string; name: string; depth: number }[];
  parentOf(path: string): string;
  statusLabel(item: unknown): string;
  formatExposure(exif: unknown, equivalentLabel?: string): string;
  versionsOf(value: unknown): { availability: string; items?: unknown[] } | null;
  versionLabel(version: { format: string; width: number; height: number | null; bytes: number; src: string }): string;
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
  // The shared folder rules are an ES module the page loads beside this script.
  const windowStub: Record<string, unknown> = { fetch: () => {}, FormData: FakeFormData, XMLHttpRequest: class {}, crypto: webcrypto, MediaConditional };
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

  it('turns a server fragment into a sentence and leaves a sentence alone', () => {
    expect(api.sentence('invalid folder')).toBe('Invalid folder.');
    expect(api.sentence('Already a sentence.')).toBe('Already a sentence.');
    expect(api.sentence('  spaced  ')).toBe('Spaced.');
    expect(api.sentence('')).toBe('');
    expect(api.sentence(null)).toBe('');
  });

  it('refuses a folder name with a sentence for each rule the server enforces, and accepts the rest', () => {
    expect(api.folderNameRefusal('Iceland 2024', '')).toBe('');
    expect(api.folderNameRefusal('Süd-Insel_v.2', 'Trips/North')).toBe('');
    expect(api.folderNameRefusal('', '')).toBe('Enter a folder name.');
    expect(api.folderNameRefusal('a/b', '')).toBe('A folder name cannot contain a slash. Create one level at a time.');
    expect(api.folderNameRefusal('a\u200bb', '')).toBe('A folder name cannot contain control or invisible characters.');
    expect(api.folderNameRefusal('x'.repeat(65), '')).toBe('A folder name can be at most 64 characters.');
    expect(api.folderNameRefusal('-trips', '')).toBe('A folder name must start and end with a letter or a digit.');
    expect(api.folderNameRefusal('trips.', '')).toBe('A folder name must start and end with a letter or a digit.');
    expect(api.folderNameRefusal('a%b', '')).toBe('A folder name can contain only letters, digits, spaces, hyphens, underscores and dots.');
    expect(api.folderNameRefusal('deep', 'a/b/c/d/e/f')).toBe('Folders can be nested at most 6 levels deep.');
    expect(api.folderNameRefusal('leaf', 'p'.repeat(60) + '/' + 'q'.repeat(60) + '/' + 'r'.repeat(60) + '/' + 's'.repeat(30)))
      .toBe('The full folder path can be at most 200 characters.');
    // Decomposed input is accepted: the page normalizes it to NFC before sending.
    expect(api.folderNameRefusal('A\u0301lesund', '')).toBe('');
  });

  it('classifies a definitive refusal of the file itself, and nothing else, as a rejection', () => {
    expect(api.uploadRejection({ status: 400 })).toBe('unreadable');
    expect(api.uploadRejection({ status: 413, code: 'FST_REQ_FILE_TOO_LARGE' })).toBe('too_large');
    // A coded 400 is about the request's identity, not the image; 409/5xx/network are not rejections.
    expect(api.uploadRejection({ status: 400, code: 'invalid_upload_identity' })).toBeNull();
    expect(api.uploadRejection({ status: 409, code: 'upload_id_reused' })).toBeNull();
    expect(api.uploadRejection({ status: 503 })).toBeNull();
    expect(api.uploadRejection({})).toBeNull();
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

  describe('formatExposure', () => {
    const NOTHING = { focalLength: null, focalLength35mm: null, fNumber: null, iso: null, exposureTime: null };
    const line = (recorded: Record<string, unknown>): string => api.formatExposure({ ...NOTHING, ...recorded }, 'equiv.');

    it('joins the parts the camera recorded and leaves out the rest', () => {
      expect(line({ focalLength: 28, focalLength35mm: 28, fNumber: 2.8, iso: 200, exposureTime: 0.004 }))
        .toBe('28 mm · f/2.8 · 1/250 s · ISO 200');
      expect(line({ fNumber: 8, iso: 100 })).toBe('f/8 · ISO 100');
      expect(line({ iso: 12800 })).toBe('ISO 12800');
    });

    it('is empty for no EXIF at all and for EXIF without exposure values', () => {
      expect(api.formatExposure(null, 'equiv.')).toBe('');
      expect(api.formatExposure(undefined, 'equiv.')).toBe('');
      expect(api.formatExposure({}, 'equiv.')).toBe('');
      expect(line({})).toBe('');
      // The server stores numbers or null; anything else is not a measurement.
      expect(line({ focalLength: Number.NaN, focalLength35mm: Infinity, fNumber: '2.8', iso: 0, exposureTime: -1 })).toBe('');
    });

    it.each([
      [{ focalLength: 24 }, '24 mm'],
      [{ focalLength: 4.3, focalLength35mm: 24 }, '4.3 mm (24 mm equiv.)'],
      [{ focalLength: 50, focalLength35mm: 75 }, '50 mm (75 mm equiv.)'],
      [{ focalLength35mm: 24 }, '24 mm equiv.'],
      // The equivalent equals the rounded focal length: saying it twice adds nothing.
      [{ focalLength: 28, focalLength35mm: 28 }, '28 mm'],
      [{ focalLength: 23.8, focalLength35mm: 24 }, '24 mm'],
      // 10 mm and up are whole millimetres; below, one decimal, without a trailing .0.
      [{ focalLength: 85.4 }, '85 mm'],
      [{ focalLength: 10.4 }, '10 mm'],
      [{ focalLength: 9.96 }, '10 mm'],
      [{ focalLength: 6.86 }, '6.9 mm'],
      [{ focalLength: 9 }, '9 mm'],
    ])('focal length %j reads %s', (recorded, expected) => {
      expect(line(recorded)).toBe(expected);
    });

    it('takes the word for "equivalent" from the caller, so the module holds no copy', () => {
      expect(api.formatExposure({ ...NOTHING, focalLength: 4.3, focalLength35mm: 24 }, 'KB-äquiv.')).toBe('4.3 mm (24 mm KB-äquiv.)');
      expect(api.formatExposure({ ...NOTHING, focalLength35mm: 24 }, 'KB-äquiv.')).toBe('24 mm KB-äquiv.');
    });

    it.each([
      [2.8, 'f/2.8'], [8, 'f/8'], [0.95, 'f/0.95'], [1.25, 'f/1.25'], [2.8284, 'f/2.83'], [1.8000001, 'f/1.8'],
    ])('aperture %f reads %s', (fNumber, expected) => {
      expect(line({ fNumber })).toBe(expected);
    });

    it.each([
      [0.004, '1/250 s'],
      [1 / 8000, '1/8000 s'],
      [1 / 60, '1/60 s'],
      [0.5, '1/2 s'],
      // Within 1 % of 1/2 it is 1/2; outside, it is the decimal it was stored as (#371).
      [0.4975, '1/2 s'],
      [0.49, '0.49 s'],
      [0.3, '0.3 s'],
      [0.4, '0.4 s'],
      [0.6, '0.6 s'],
      [0.8, '0.8 s'],
      [0.71234, '0.71 s'],
      // Just under a second N would be 1: never "1/1 s".
      [0.99, '0.99 s'],
      [0.995, '0.99 s'],
      [0.999, '1 s'],
      // A second and longer: up to one decimal.
      [1, '1 s'],
      [1.5, '1.5 s'],
      [2, '2 s'],
      [30, '30 s'],
    ])('shutter time %f s reads %s', (exposureTime, expected) => {
      expect(line({ exposureTime })).toBe(expected);
    });
  });

  describe('stored versions', () => {
    const avif = { format: 'avif', width: 1920, height: 1280, bytes: 412 * 1024, src: 'https://img.example/a-1920.avif' };

    it('reads a version as format, pixels and size, with a dash for an unreadable height', () => {
      expect(api.versionLabel(avif)).toBe('AVIF · 1920 × 1280 · 412 kB');
      expect(api.versionLabel({ ...avif, format: 'webp', bytes: 3.4 * 1024 * 1024 })).toBe('WebP · 1920 × 1280 · 3.4 MB');
      expect(api.versionLabel({ ...avif, format: 'jpeg', width: 640, height: null, bytes: 38 * 1024 })).toBe('JPEG · 640 × — · 38 kB');
    });

    it('passes the three availabilities through and keeps only the fields it renders', () => {
      expect(api.versionsOf({ availability: 'available', items: [{ ...avif, path: '/data/a-1920.avif' }] }))
        .toEqual({ availability: 'available', items: [avif] });
      expect(api.versionsOf({ availability: 'available', items: [] })).toEqual({ availability: 'available', items: [] });
      expect(api.versionsOf({ availability: 'processing', items: [avif] })).toEqual({ availability: 'processing' });
      expect(api.versionsOf({ availability: 'unavailable' })).toEqual({ availability: 'unavailable' });
    });

    it('is null only when the payload carries no versions at all', () => {
      expect(api.versionsOf(undefined)).toBeNull();
      expect(api.versionsOf(null)).toBeNull();
    });

    it.each([
      ['an unknown availability', { availability: 'ready', items: [] }],
      ['no list', { availability: 'available' }],
      ['a format the pipeline never writes', { availability: 'available', items: [{ ...avif, format: 'png' }] }],
      ['a width of 0', { availability: 'available', items: [{ ...avif, width: 0 }] }],
      ['a width that is not a number', { availability: 'available', items: [{ ...avif, width: '1920' }] }],
      ['a negative size', { availability: 'available', items: [{ ...avif, bytes: -1 }] }],
      ['a missing height', { availability: 'available', items: [{ ...avif, height: undefined }] }],
      ['no URL', { availability: 'available', items: [{ ...avif, src: null }] }],
      ['an entry that is not an object', { availability: 'available', items: [null] }],
      ['a value that is not an object', 'available'],
    ])('reads %s as unavailable rather than as a shorter list', (_label, value) => {
      expect(api.versionsOf(value)).toEqual({ availability: 'unavailable' });
    });
  });

  it('names the folder a duplicate already lives in and words a definite failure as a sentence', () => {
    expect(api.queueState({ state: 'uploading', progress: 0.5 })).toBe('50%');
    expect(api.queueState({ state: 'failed', error: 'upload id reused' })).toBe('Could not upload: Upload id reused.');
    expect(api.queueState({ state: 'failed', error: null })).toBe('Could not upload: Unknown error.');
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
    expect(api.listQuery({ status: 'ready', alt: 'missing' })).toBe('?status=ready&alt=missing');
    expect(api.listQuery({ alt: '' })).toBe('');
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

  it('tracks definite non-file failures separately and retries only those', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([{ status: 409, body: { error: 'upload id reused', code: 'upload_id_reused' } }, { status: 200, body: { key: 'k' } }]);
    const client = api.makeClient({ XMLHttpRequest: FakeXhr, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    const q = api.createUploadQueue(client, { concurrency: 1 });
    q.initialize(randomUUID());
    q.add([file('a.jpg')]);
    instances[0]!.resolve();
    await flush();
    expect(q.snapshot().failed).toBe(1);
    expect(q.snapshot().items[0]!.error).toBe('upload id reused');

    // Explicit retry is safe only for a definite 4xx; network/5xx stay Unknown.
    q.retryFailed();
    expect(q.snapshot().failed).toBe(0);
    instances[1]!.resolve();
    await flush();
    expect(q.snapshot().done).toBe(1);
  });

  it('ends a file the server refused as rejected: never counted as failed, never resent, cleared with the finished', async () => {
    const api = load();
    const { FakeXhr, instances } = fakeXhrClass([
      { status: 400, body: { error: 'invalid key or image' } },
      { status: 413, body: { statusCode: 413, code: 'FST_REQ_FILE_TOO_LARGE', error: 'Payload Too Large' } },
      { status: 200, body: { key: 'k' } },
    ]);
    const client = api.makeClient({ XMLHttpRequest: FakeXhr, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) });
    const q = api.createUploadQueue(client, { concurrency: 3 });
    q.initialize(randomUUID());
    q.add([file('scan.jpg'), file('huge.jpg'), file('ok.jpg')]);
    instances.forEach((x) => x.resolve());
    await flush();
    expect(q.snapshot().items.map((i) => [i.state, i.error])).toEqual([
      ['rejected', 'unreadable'], ['rejected', 'too_large'], ['done', null],
    ]);
    expect(q.snapshot()).toMatchObject({ failed: 0, rejected: 2, done: 1, waiting: 0, refused: 0 });
    q.retryFailed();
    await flush();
    expect(instances).toHaveLength(3);
    q.clearFinished();
    expect(q.snapshot().items).toEqual([]);
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
    const { FakeXhr, instances } = fakeXhrClass([{ status: 200, body: {} }, { status: 409, body: { error: 'upload id reused', code: 'upload_id_reused' } }]);
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
      // A browser-transcoded JPEG that kept its HEIC name is sent: the type decides.
      { name: 'IMG_7.HEIC', type: 'image/jpeg', size: 10 },
    ]);
    expect(q.snapshot().items.map((i) => [i.state, i.error])).toEqual([
      ['refused', 'heic'], ['refused', 'heic'], ['refused', 'too_large'], ['refused', 'not_image'],
      ['uploading', null], ['uploading', null], ['uploading', null],
    ]);
    expect(instances).toHaveLength(3);
    instances.forEach((x) => x.resolve());
    await flush();
    q.retryFailed();
    expect(instances).toHaveLength(3);
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
