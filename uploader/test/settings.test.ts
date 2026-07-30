import { describe, expect, it, beforeEach } from 'vitest';
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

  it('falls back to defaults on a corrupt file', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, 'not json{');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get()).toEqual(DEFAULTS);
  });

  it('falls back to defaults when an on-disk value is out of range', async () => {
    // A hand-edited/partially-written settings.json must not serve invalid values
    // (e.g. a negative timeout reaching the browser abort timer) — validate on load.
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ captionTimeoutMs: -100, lmModel: 'my/vlm' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get()).toEqual(DEFAULTS); // whole file rejected, not partially trusted
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

  // @ai-warning validate() runs on LOAD too, and one bad value rejects the WHOLE
  // file back to defaults — a default that failed its own validator would
  // silently wipe the owner's LM and backup config.
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
