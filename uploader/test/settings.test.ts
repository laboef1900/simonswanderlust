import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, defaultSettings, validate, SettingsError, type Settings, type BackupSchedule } from '../src/settings.js';

const DEFAULTS: Settings = defaultSettings();

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'imgset-')); });

describe('defaultSettings', () => {
  it('includes LM defaults and off / 14 backups', () => {
    const d = defaultSettings();
    expect(d.lmBaseUrl).toBe('http://localhost:1234/v1');
    expect(d.lmModel).toBe('qwen/qwen3-vl-4b');
    expect(d.captionTimeoutMs).toBe(60000);
    expect(d.captionMaxEdge).toBe(768);
    expect(d.captionPrompt.length).toBeGreaterThan(0);
    expect(d.backupSchedule).toBe('off');
    expect(d.backupRetention).toBe(14);
  });
});

describe('createSettingsStore', () => {
  it('returns defaults when no file exists', () => {
    const store = createSettingsStore({ path: join(dir, 'settings.json'), defaults: DEFAULTS });
    expect(store.get()).toEqual(DEFAULTS);
  });

  it('merges a file over defaults', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ backupSchedule: 'daily' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get().backupSchedule).toBe('daily');
    expect(store.get().backupRetention).toBe(DEFAULTS.backupRetention);
  });

  it('keeps known LM keys but drops truly unknown fields from an older settings.json', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ lmModel: 'my/local-vlm', legacyRemovedKey: 'x', backupSchedule: 'weekly' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get().lmModel).toBe('my/local-vlm');   // known key → kept
    expect(store.get().backupSchedule).toBe('weekly');
    expect(store.get()).not.toHaveProperty('legacyRemovedKey');
    store.update({ backupRetention: 5 });
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.legacyRemovedKey).toBeUndefined();     // unknown key → not re-persisted
    expect(onDisk.lmModel).toBe('my/local-vlm');
  });

  it('falls back to defaults on a corrupt file and says so', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, 'not json{');
    const log = vi.fn();
    const store = createSettingsStore({ path, defaults: DEFAULTS, log });
    expect(store.get()).toEqual(DEFAULTS);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/));
  });

  it('falls back to defaults when the file is JSON but not an object', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, '[1,2]');
    const log = vi.fn();
    expect(createSettingsStore({ path, defaults: DEFAULTS, log }).get()).toEqual(DEFAULTS);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does not log when the file simply does not exist yet', () => {
    const log = vi.fn();
    createSettingsStore({ path: join(dir, 'settings.json'), defaults: DEFAULTS, log });
    expect(log).not.toHaveBeenCalled();
  });

  // Issue #112: one out-of-range LM field used to reject the WHOLE file back to
  // defaults — flipping `backupSchedule` to 'off' with no log line, so daily
  // backups silently stopped until someone opened the Settings page.
  it('keeps every valid field when one on-disk value is invalid, and logs which one', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({
      captionTimeoutMs: -100,          // invalid → its own default
      lmModel: 'my/vlm',
      backupSchedule: 'daily',
      backupRetention: 30,
      importDelayMs: 0,
    }));
    const log = vi.fn();
    const store = createSettingsStore({ path, defaults: DEFAULTS, log });
    const s = store.get();
    expect(s.captionTimeoutMs).toBe(DEFAULTS.captionTimeoutMs); // the bad one is not served
    expect(s.lmModel).toBe('my/vlm');
    expect(s.backupSchedule).toBe('daily');
    expect(s.backupRetention).toBe(30);
    expect(s.importDelayMs).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"captionTimeoutMs"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('between 1000 and 600000'));
  });

  it('rejects a wrong JSON type per field rather than trusting the type annotation', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({
      lmModel: 42,                     // number where a string is expected
      backupRetention: '7',            // string where a number is expected
      captionPrompt: null,
      backupSchedule: 'weekly',
    }));
    const log = vi.fn();
    const s = createSettingsStore({ path, defaults: DEFAULTS, log }).get();
    expect(s.lmModel).toBe(DEFAULTS.lmModel);
    expect(s.backupRetention).toBe(DEFAULTS.backupRetention);
    expect(s.captionPrompt).toBe(DEFAULTS.captionPrompt);
    expect(s.backupSchedule).toBe('weekly');
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      expect.stringContaining('"lmModel"'),
      expect.stringContaining('"captionPrompt"'),
      expect.stringContaining('"backupRetention"'),
    ]);
  });

  it('logs to console.error by default', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ importRetries: 99 }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(createSettingsStore({ path, defaults: DEFAULTS }).get().importRetries).toBe(DEFAULTS.importRetries);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('"importRetries"'));
    } finally {
      spy.mockRestore();
    }
  });

  it('update validates, persists, and updates the cache', async () => {
    const path = join(dir, 'settings.json');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    const updated = store.update({ backupSchedule: 'daily', backupRetention: 7 });
    expect(updated.backupSchedule).toBe('daily');
    expect(store.get().backupRetention).toBe(7);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.backupSchedule).toBe('daily');
  });

  it('update rejects bad values with SettingsError (nothing persisted)', () => {
    const store = createSettingsStore({ path: join(dir, 'settings.json'), defaults: DEFAULTS });
    expect(() => store.update({ backupSchedule: 'hourly' as BackupSchedule })).toThrow(SettingsError);
    expect(() => store.update({ backupRetention: 0 })).toThrow(SettingsError);
    expect(store.get()).toEqual(DEFAULTS); // unchanged
  });
});

describe('backup settings validation', () => {
  it('accepts daily and weekly', () => {
    expect(validate({ ...DEFAULTS, backupSchedule: 'daily' }).backupSchedule).toBe('daily');
    expect(validate({ ...DEFAULTS, backupSchedule: 'weekly' }).backupSchedule).toBe('weekly');
  });

  it('rejects an unknown schedule', () => {
    expect(() => validate({ ...DEFAULTS, backupSchedule: 'hourly' as BackupSchedule })).toThrow(SettingsError);
  });

  it('rejects retention out of range or non-integer', () => {
    expect(() => validate({ ...DEFAULTS, backupRetention: 0 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, backupRetention: 101 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, backupRetention: 1.5 })).toThrow(SettingsError);
  });
});

describe('LM settings validation', () => {
  it('accepts a valid http/https base URL', () => {
    expect(validate({ ...DEFAULTS, lmBaseUrl: 'http://localhost:1234/v1' }).lmBaseUrl).toBe('http://localhost:1234/v1');
    expect(validate({ ...DEFAULTS, lmBaseUrl: 'https://lm.example.com/v1' }).lmBaseUrl).toBe('https://lm.example.com/v1');
  });

  it('rejects a non-URL or non-http(s) base URL', () => {
    expect(() => validate({ ...DEFAULTS, lmBaseUrl: 'not a url' })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, lmBaseUrl: 'ftp://host/v1' })).toThrow(SettingsError);
  });

  it('rejects an empty model', () => {
    expect(() => validate({ ...DEFAULTS, lmModel: '  ' })).toThrow(SettingsError);
  });

  it('rejects timeout out of range or non-integer', () => {
    expect(() => validate({ ...DEFAULTS, captionTimeoutMs: 999 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionTimeoutMs: 600001 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionTimeoutMs: 1.5 })).toThrow(SettingsError);
  });

  it('rejects maxEdge out of range or non-integer', () => {
    expect(() => validate({ ...DEFAULTS, captionMaxEdge: 255 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionMaxEdge: 4097 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionMaxEdge: 300.5 })).toThrow(SettingsError);
  });

  it('rejects an empty prompt', () => {
    expect(() => validate({ ...DEFAULTS, captionPrompt: '   ' })).toThrow(SettingsError);
  });

  it('round-trips LM fields through update()', async () => {
    const path = join(dir, 'settings.json');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    const updated = store.update({ lmBaseUrl: 'http://localhost:9999/v1', lmModel: 'my/vlm', captionMaxEdge: 1024 });
    expect(updated.lmBaseUrl).toBe('http://localhost:9999/v1');
    expect(updated.lmModel).toBe('my/vlm');
    expect(updated.captionMaxEdge).toBe(1024);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.lmModel).toBe('my/vlm');
  });
});

/**
 * Issue #85: the WordPress importer's pacing knobs. Not `.env` — CLAUDE.md
 * reserves that for bootstrap values and puts app settings here.
 */
describe('import settings', () => {
  it('defaults to the spacing the 2026-07-29 migration actually completed with', () => {
    const d = defaultSettings();
    expect(d.importDelayMs).toBe(1200);
    expect(d.importRetries).toBe(3);
  });

  // @ai-warning A default that failed its own validator would make every
  // update() that leaves that field untouched throw, so the owner could never
  // save the Settings page again.
  it('has defaults that pass its own validator', () => {
    expect(() => validate(defaultSettings())).not.toThrow();
  });

  it('accepts both ends of each range', () => {
    for (const importDelayMs of [0, 10000]) {
      expect(() => validate({ ...DEFAULTS, importDelayMs })).not.toThrow();
    }
    for (const importRetries of [0, 5]) {
      expect(() => validate({ ...DEFAULTS, importRetries })).not.toThrow();
    }
  });

  it('rejects out-of-range, fractional, and non-numeric values', () => {
    for (const bad of [-1, 10001, 1.5, Number.NaN]) {
      expect(() => validate({ ...DEFAULTS, importDelayMs: bad }), `delay ${bad}`).toThrow(SettingsError);
    }
    for (const bad of [-1, 6, 1.5, Number.NaN]) {
      expect(() => validate({ ...DEFAULTS, importRetries: bad }), `retries ${bad}`).toThrow(SettingsError);
    }
  });

  // 0 restores pre-#85 behaviour on purpose: importing from a WordPress on the
  // LAN has no reason to pace. Blast radius is bounded by the retry budget and
  // the per-host breaker, not by this lower bound.
  it('allows a zero delay, which disables pacing', () => {
    const store = createSettingsStore({ path: join(dir, 'settings.json'), defaults: DEFAULTS });
    expect(store.update({ importDelayMs: 0 }).importDelayMs).toBe(0);
  });

  it('round-trips through the file and survives an older settings.json without the keys', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ backupSchedule: 'daily', lmModel: 'my/vlm' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get().importDelayMs).toBe(1200);        // merged from defaults
    expect(store.get().backupSchedule).toBe('daily');    // and nothing else was lost
    store.update({ importDelayMs: 2500, importRetries: 1 });
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk.importDelayMs).toBe(2500);
    expect(onDisk.importRetries).toBe(1);
    expect(createSettingsStore({ path, defaults: DEFAULTS }).get().importDelayMs).toBe(2500);
  });
});
