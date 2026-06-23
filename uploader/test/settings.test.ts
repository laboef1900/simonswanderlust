import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, defaultsFromEnv, SettingsError, type Settings } from '../src/settings.js';

const DEFAULTS: Settings = {
  lmBaseUrl: 'http://host.docker.internal:1234/v1',
  lmModel: 'qwen/qwen3-vl-4b',
  captionTimeoutMs: 60000,
  captionMaxEdge: 768,
  captionPrompt: 'PROMPT',
};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'imgset-')); });

describe('defaultsFromEnv', () => {
  it('reads env with fallbacks', () => {
    const s = defaultsFromEnv({ LMSTUDIO_MODEL: 'foo' } as NodeJS.ProcessEnv);
    expect(s.lmModel).toBe('foo');
    expect(s.lmBaseUrl).toBe('http://host.docker.internal:1234/v1');
    expect(s.captionTimeoutMs).toBe(60000);
    expect(s.captionMaxEdge).toBe(768);
    expect(s.captionPrompt.length).toBeGreaterThan(0);
  });
});

describe('createSettingsStore', () => {
  it('returns defaults when no file exists', () => {
    const store = createSettingsStore({ path: join(dir, 'settings.json'), defaults: DEFAULTS });
    expect(store.get()).toEqual(DEFAULTS);
  });

  it('merges a file over defaults', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ lmModel: 'saved-model', captionMaxEdge: 1024 }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get().lmModel).toBe('saved-model');
    expect(store.get().captionMaxEdge).toBe(1024);
    expect(store.get().lmBaseUrl).toBe(DEFAULTS.lmBaseUrl);
  });

  it('falls back to defaults on a corrupt file', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, 'not json{');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get()).toEqual(DEFAULTS);
  });

  it('update validates, persists, and updates the cache', async () => {
    const path = join(dir, 'settings.json');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    const updated = store.update({ lmModel: 'new', captionTimeoutMs: 5000 });
    expect(updated.lmModel).toBe('new');
    expect(store.get().captionTimeoutMs).toBe(5000);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.lmModel).toBe('new');
  });

  it('update rejects bad values with SettingsError (nothing persisted)', () => {
    const store = createSettingsStore({ path: join(dir, 'settings.json'), defaults: DEFAULTS });
    expect(() => store.update({ lmBaseUrl: 'ftp://nope' })).toThrow(SettingsError);
    expect(() => store.update({ captionTimeoutMs: 10 })).toThrow(SettingsError);
    expect(() => store.update({ captionMaxEdge: 99999 })).toThrow(SettingsError);
    expect(() => store.update({ captionPrompt: '   ' })).toThrow(SettingsError);
    expect(store.get()).toEqual(DEFAULTS); // unchanged
  });
});
