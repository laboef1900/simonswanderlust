import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_PROMPT } from './caption.js';

export type BackupSchedule = 'off' | 'daily' | 'weekly';

export interface Settings {
  lmBaseUrl: string;
  lmModel: string;
  captionTimeoutMs: number;
  captionMaxEdge: number;
  captionPrompt: string;
  backupSchedule: BackupSchedule;
  backupRetention: number;
}

export class SettingsError extends Error {}

export interface SettingsStore {
  get(): Settings;
  update(partial: Partial<Settings>): Settings;
}

export function defaultSettings(): Settings {
  return {
    lmBaseUrl: 'http://localhost:1234/v1',
    lmModel: 'qwen/qwen3-vl-4b',
    captionTimeoutMs: 60000,
    captionMaxEdge: 768,
    captionPrompt: DEFAULT_PROMPT,
    backupSchedule: 'off',
    backupRetention: 14,
  };
}

export function validate(s: Settings): Settings {
  let url: URL;
  try {
    url = new URL(s.lmBaseUrl);
  } catch {
    throw new SettingsError('Base URL is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SettingsError('Base URL must start with http:// or https://.');
  }
  if (!s.lmModel.trim()) throw new SettingsError('Model is required.');
  if (!Number.isInteger(s.captionTimeoutMs) || s.captionTimeoutMs < 1000 || s.captionTimeoutMs > 600000) {
    throw new SettingsError('Timeout must be a whole number of milliseconds between 1000 and 600000.');
  }
  if (!Number.isInteger(s.captionMaxEdge) || s.captionMaxEdge < 256 || s.captionMaxEdge > 4096) {
    throw new SettingsError('Max edge must be a whole number between 256 and 4096 pixels.');
  }
  if (!s.captionPrompt.trim()) throw new SettingsError('Prompt is required.');
  if (!['off', 'daily', 'weekly'].includes(s.backupSchedule)) {
    throw new SettingsError('Backup schedule must be off, daily, or weekly.');
  }
  if (!Number.isInteger(s.backupRetention) || s.backupRetention < 1 || s.backupRetention > 100) {
    throw new SettingsError('Backup retention must be a whole number between 1 and 100.');
  }
  return s;
}

export function createSettingsStore({ path, defaults }: { path: string; defaults: Settings }): SettingsStore {
  let current: Settings = { ...defaults };
  try {
    // Pick known keys only, so truly unknown fields in an older settings.json are
    // dropped instead of re-persisted forever.
    const fromFile = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    if (fromFile.lmBaseUrl !== undefined) current.lmBaseUrl = fromFile.lmBaseUrl;
    if (fromFile.lmModel !== undefined) current.lmModel = fromFile.lmModel;
    if (fromFile.captionTimeoutMs !== undefined) current.captionTimeoutMs = fromFile.captionTimeoutMs;
    if (fromFile.captionMaxEdge !== undefined) current.captionMaxEdge = fromFile.captionMaxEdge;
    if (fromFile.captionPrompt !== undefined) current.captionPrompt = fromFile.captionPrompt;
    if (fromFile.backupSchedule !== undefined) current.backupSchedule = fromFile.backupSchedule;
    if (fromFile.backupRetention !== undefined) current.backupRetention = fromFile.backupRetention;
  } catch {
    // No file yet, or unreadable/corrupt — keep defaults.
  }

  return {
    get: () => ({ ...current }),
    update: (partial) => {
      const merged = validate({ ...current, ...partial });
      mkdirSync(dirname(path), { recursive: true });
      // Atomic write: a crash mid-write must not corrupt the live file. Write a
      // sibling temp (same dir → same filesystem) then rename over the target.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2));
      renameSync(tmp, path);
      current = merged;
      return { ...current };
    },
  };
}
