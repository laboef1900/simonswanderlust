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
  /**
   * WordPress-import pacing (issue #85). `importDelayMs: 0` restores pre-#85
   * behaviour and is a legitimate choice for a source host on the LAN — blast
   * radius is bounded by wp-import's retry budget and per-host breaker, not by
   * this lower bound.
   */
  importDelayMs: number;
  importRetries: number;
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
    // The spacing and retry count the 2026-07-29 migration actually completed
    // 665 photos with; at zero spacing the source host cut us off after 37.
    importDelayMs: 1200,
    importRetries: 3,
  };
}

/**
 * One validator per field, each accepting `unknown` — a hand-edited
 * settings.json can hold any JSON type, so the type check is part of the rule.
 * Returns the user-facing reason, or `null` when the value is acceptable.
 * The key order is the order `validate()` reports errors in.
 */
const FIELD_CHECKS: { [K in keyof Settings]: (v: unknown) => string | null } = {
  lmBaseUrl: (v) => {
    let url: URL;
    try {
      url = new URL(typeof v === 'string' ? v : '');
    } catch {
      return 'Base URL is not a valid URL.';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Base URL must start with http:// or https://.';
    }
    return null;
  },
  lmModel: (v) => (typeof v === 'string' && v.trim() !== '' ? null : 'Model is required.'),
  captionTimeoutMs: (v) =>
    intInRange(v, 1000, 600000) ? null : 'Timeout must be a whole number of milliseconds between 1000 and 600000.',
  captionMaxEdge: (v) =>
    intInRange(v, 256, 4096) ? null : 'Max edge must be a whole number between 256 and 4096 pixels.',
  captionPrompt: (v) => (typeof v === 'string' && v.trim() !== '' ? null : 'Prompt is required.'),
  backupSchedule: (v) =>
    v === 'off' || v === 'daily' || v === 'weekly' ? null : 'Backup schedule must be off, daily, or weekly.',
  backupRetention: (v) =>
    intInRange(v, 1, 100) ? null : 'Backup retention must be a whole number between 1 and 100.',
  importDelayMs: (v) =>
    intInRange(v, 0, 10000) ? null : 'Import delay must be a whole number of milliseconds between 0 and 10000.',
  importRetries: (v) =>
    intInRange(v, 0, 5) ? null : 'Import retries must be a whole number between 0 and 5.',
};

const SETTINGS_KEYS = Object.keys(FIELD_CHECKS) as (keyof Settings)[];

function intInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export function validate(s: Settings): Settings {
  for (const key of SETTINGS_KEYS) {
    const reason = FIELD_CHECKS[key](s[key]);
    if (reason) throw new SettingsError(reason);
  }
  return s;
}

/**
 * Read settings.json and merge it over the defaults FIELD BY FIELD. A field the
 * validator rejects falls back to its own default and is logged by name; every
 * other field is kept. Whole-file rejection (issue #112) would silently flip
 * `backupSchedule` back to `off` because an unrelated LM field went out of
 * range — and nothing would notice until someone opened the Settings page.
 * Unknown keys are dropped so they are not re-persisted forever.
 */
function loadSettings(path: string, defaults: Settings, log: (msg: string) => void): Settings {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    // No file yet is the normal first-boot state; anything else is worth a line.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`settings: cannot read ${path}, using defaults: ${(e as Error).message}`);
    return { ...defaults };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log(`settings: ${path} is not valid JSON, using defaults: ${(e as Error).message}`);
    return { ...defaults };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log(`settings: ${path} is not a JSON object, using defaults`);
    return { ...defaults };
  }
  const fromFile = parsed as Record<string, unknown>;
  const loaded: Record<keyof Settings, unknown> = { ...defaults };
  for (const key of SETTINGS_KEYS) {
    const value = fromFile[key];
    if (value === undefined) continue;
    const reason = FIELD_CHECKS[key](value);
    if (reason) {
      log(`settings: ignoring invalid "${key}" in ${path} (${reason}); using default ${JSON.stringify(defaults[key])}`);
      continue;
    }
    loaded[key] = value;
  }
  // Every key was either copied from `defaults` or passed its own type check.
  return loaded as Settings;
}

export function createSettingsStore({
  path,
  defaults,
  log = console.error,
}: {
  path: string;
  defaults: Settings;
  log?: (msg: string) => void;
}): SettingsStore {
  let current = loadSettings(path, defaults, log);

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
