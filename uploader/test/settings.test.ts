import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, defaultSettings, validate, SettingsError, type Settings, type BackupSchedule } from '../src/settings.js';

const DEFAULTS: Settings = { backupSchedule: 'off', backupRetention: 14 };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'imgset-')); });

describe('defaultSettings', () => {
  it('defaults to off / 14', () => {
    expect(defaultSettings()).toEqual(DEFAULTS);
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

  it('drops stale unknown fields from an older settings.json', async () => {
    // A pre-AI-removal settings.json still carries LM Studio keys; they must
    // neither surface via get() nor be re-persisted by the next update().
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ lmModel: 'qwen/qwen3-vl-4b', backupSchedule: 'weekly' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get()).toEqual({ backupSchedule: 'weekly', backupRetention: 14 });
    store.update({ backupRetention: 5 });
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk).toEqual({ backupSchedule: 'weekly', backupRetention: 5 });
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
