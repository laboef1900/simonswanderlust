import { randomUUID, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { editorDocument, EditorEvent } from './editor-dom-harness.js';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(fields: Record<string, string>) {
  const owner = randomUUID(); let signedIn = owner; let paused = false;
  const dom = editorDocument('<main><p id="status"></p><button id="send">Upload</button></main>');
  const status = dom.document.getElementById('status')!, button = dom.document.getElementById('send')!;
  const sends: Record<string, unknown>[] = []; const reads: string[] = [];
  let upload: (fields: Record<string, unknown>) => Promise<unknown> = async () => { throw new Error('response lost'); };
  let receipt: (id: string) => Promise<unknown> = async () => { throw Object.assign(new Error('missing'), { status: 404 }); };
  const client = {
    uploadOne: async (_file: File, value: Record<string, unknown>) => { sends.push(value); return upload(value); },
    receipt: async (id: string) => { reads.push(id); return receipt(id); },
    me: async () => ({ userId: signedIn }),
  };
  const context: Record<string, unknown> = { document: dom.document, crypto: webcrypto,
    addEventListener: dom.document.addEventListener, setTimeout, clearTimeout,
    localStorage: { setItem() { throw new Error('Files must not be persisted'); } } };
  context.window = context; vm.createContext(context);
  vm.runInContext(readFileSync('public/media-api.js', 'utf8'), context);
  (context.MediaApi as { makeClient: () => typeof client }).makeClient = () => client;
  vm.runInContext(readFileSync('public/upload-recovery.js', 'utf8'), context);
  const recovery = { canAdopt: (id: string) => id === owner && !paused,
    observeOwner: (id: string | null) => { if (id !== owner) paused = true; },
    resumeOwner: (id: string) => { paused = id !== owner; return !paused; } };
  const result = (context.UploadRecovery as { run(options: object): Promise<unknown> }).run({
    file: new File(['photo'], 'photo.jpg'), fields, ownerId: owner, recovery, status, button,
    copy: new Proxy({}, { get: (_target, key) => String(key) }), onUnauthed() {},
  });
  const check = () => dom.created.find(element => element.tagName === 'BUTTON' && element !== button)!;
  return { owner, result, sends, reads, status, button, dom, check,
    setOwner: (id: string) => { signedIn = id; recovery.observeOwner(id); },
    setUpload: (fn: typeof upload) => { upload = fn; }, setReceipt: (fn: typeof receipt) => { receipt = fn; } };
}
const image = { key: 'trips/photo-12345678', src: 'https://images.test/trips/photo-12345678', width: 8, height: 6, status: 'processing' };

describe('shared inline upload recovery', () => {
  it.each(['trips/story/hero', 'trips/story/body', 'trips/story/title', 'pages/about/photo'])('keeps %s unknown until an explicit read finds acceptance, without resending', async key => {
    const f = fixture({ key, alt: 'Captured alt' }); await settle();
    expect(f.sends).toHaveLength(1); expect(f.reads).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ key, alt: 'Captured alt', expectedOwnerId: f.owner, uploadId: expect.any(String), retryGeneration: 0 });
    expect(f.status.textContent).toContain('uploadUnknown'); expect(f.button.disabled).toBe(true);
    const before = new EditorEvent('beforeunload', { bubbles: true, cancelable: true }); f.button.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    f.setReceipt(async id => ({ state: 'accepted', ownerUserId: f.owner, uploadId: id, result: image }));
    f.check().click(); expect(await f.result).toEqual(image);
    expect(f.sends).toHaveLength(1); expect(f.reads).toHaveLength(2); expect(f.button.disabled).toBe(false);
    const after = new EditorEvent('beforeunload', { bubbles: true, cancelable: true }); f.button.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
  it('never sends or adopts an unresolved file as a different account', async () => {
    const f = fixture({ key: 'pages/about/photo' }); await settle();
    f.setOwner(randomUUID()); f.check().click(); await settle();
    expect(f.status.textContent).toContain('uploadOwnerChanged');
    expect(f.reads).toHaveLength(1); expect(f.sends).toHaveLength(1);
    f.setOwner(f.owner); await settle(); // sign-in/focus is not a retry or a probe
    expect(f.reads).toHaveLength(1);
    f.setReceipt(async id => ({ state: 'accepted', ownerUserId: f.owner, uploadId: id, result: image }));
    f.check().click(); expect(await f.result).toEqual(image); expect(f.sends).toHaveLength(1);
  });
  it('retransmits only after explicit confirmation of a new server retry generation', async () => {
    const f = fixture({ key: 'trips/story/hero' });
    f.setReceipt(async id => ({ state: 'retryable', ownerUserId: f.owner, uploadId: id, retryGeneration: 1 }));
    await settle(); expect(f.sends).toHaveLength(1); expect(f.check().textContent).toBe('uploadRetry');
    f.setUpload(async fields => ({ ...image, state: 'accepted', ownerUserId: f.owner, uploadId: fields.uploadId }));
    f.check().click(); expect(await f.result).toMatchObject(image);
    expect(f.sends).toHaveLength(2);
    expect(f.sends[1]).toEqual({ ...f.sends[0], retryGeneration: 1 });
  });
});
