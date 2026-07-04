import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export type BackupSchedule = 'off' | 'daily' | 'weekly';

export interface Settings {
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
    backupSchedule: 'off',
    backupRetention: 14,
  };
}

export function validate(s: Settings): Settings {
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
    // Pick known keys only, so stale fields in an older settings.json (e.g. the
    // removed LM Studio config) are dropped instead of re-persisted forever.
    const fromFile = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
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
