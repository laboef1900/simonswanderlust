import { linkSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_PROMPT } from './caption.js';
import { DEFAULT_REVIEW_PROMPT } from './editorial-review.js';
import { DEFAULT_PROCESS_OPTIONS } from './variants.js';
import {
  cleanProviders, defaultProviders, deriveFromLegacy, isLegacyAiSettings, isProviderId, validateProviders,
  type AiProvider,
} from './ai-providers.js';

export type BackupSchedule = 'off' | 'daily' | 'weekly';

export interface Settings {
  /** Nominatim-compatible HTTPS endpoint; empty disables editor lookup. */
  geocodingSearchUrl: string;
  /** Non-sensitive AI destinations; keys live per provider in `app_secrets`. */
  aiProviders: AiProvider[];
  aiDefaultProviderId: string;
  /** Story review & excerpts; `null` follows the default provider. */
  reviewProviderId: string | null;
  /** Photo descriptions (alt text, media details); `null` follows the default provider. */
  captionProviderId: string | null;
  lmModel: string;
  captionTimeoutMs: number;
  /** Shared output ceiling for alt text and media details, including model reasoning. */
  captionMaxTokens: number;
  captionMaxEdge: number;
  captionPrompt: string;
  aiModel: string;
  reviewPrompt: string;
  reviewTimeoutMs: number;
  backupSchedule: BackupSchedule;
  backupRetention: number;
  convertJpeg: boolean;
  webpQuality: number;
  avifQuality: number;
  /**
   * WordPress-import pacing (issue #85). `importDelayMs: 0` restores pre-#85
   * behaviour and is a legitimate choice for a source host on the LAN — blast
   * radius is bounded by wp-import's retry budget and per-host breaker, not by
   * this lower bound.
   */
  importDelayMs: number;
  importRetries: number;
  /**
   * Site-wide reader-comments switch (SPEC-FLAG-002). Admin-only via
   * POST /settings; defaults OFF (fail closed). Toggling it persists the flag
   * only — it never enqueues a build and never takes workLock.
   */
  commentsEnabled: boolean;
}

export class SettingsError extends Error {}

export interface SettingsStore {
  get(): Settings;
  update(partial: Partial<Settings>): Settings;
}

/**
 * The file-backed store also carries the one-time registry migration (spec §5).
 * The server only needs `SettingsStore`; `main.ts` drives the migration.
 */
export interface FileSettingsStore extends SettingsStore {
  /** Non-null only when THIS load derived the registry from a legacy file. */
  pendingAiMigration(): { keyedProviderIds: string[] } | null;
  /** Writes `<path>.pre-ai-registry` once (no clobber), persists the registry shape, clears the pending state. */
  completeAiMigration(): void;
  /** Preserve an upgrade's old prompt only when the loaded file was valid and lacked the key. */
  preserveLegacyReviewPrompt(prompt: string): void;
}

export function defaultSettings(): Settings {
  return {
    geocodingSearchUrl: 'https://nominatim.openstreetmap.org/search',
    aiProviders: defaultProviders(),
    aiDefaultProviderId: 'lm-studio',
    reviewProviderId: null,
    captionProviderId: null,
    lmModel: 'qwen/qwen3-vl-4b',
    captionTimeoutMs: 60000,
    captionMaxTokens: 8000,
    captionMaxEdge: 768,
    captionPrompt: DEFAULT_PROMPT,
    aiModel: 'qwen2.5-7b-instruct',
    reviewPrompt: DEFAULT_REVIEW_PROMPT,
    reviewTimeoutMs: 60000,
    backupSchedule: 'off',
    backupRetention: 14,
    ...DEFAULT_PROCESS_OPTIONS,
    // The spacing and retry count the 2026-07-29 migration actually completed
    // 665 photos with; at zero spacing the source host cut us off after 37.
    importDelayMs: 1200,
    importRetries: 3,
    commentsEnabled: false,
  };
}

/**
 * One validator per field, each accepting `unknown` — a hand-edited
 * settings.json can hold any JSON type, so the type check is part of the rule.
 * Returns the user-facing reason, or `null` when the value is acceptable.
 * The key order is the order `validate()` reports errors in.
 */
const FIELD_CHECKS: { [K in keyof Settings]: (v: unknown) => string | null } = {
  geocodingSearchUrl: (v) => {
    if (v === '') return null;
    if (typeof v === 'string' && !/[\p{C}\s]/u.test(v)) {
      try {
        const url = new URL(v);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return null;
      } catch { /* Fixed error below: never echo a supplied URL. */ }
    }
    return 'Geocoding endpoint must be an HTTPS URL without credentials, query, or fragment; leave empty to disable.';
  },
  aiProviders: validateProviders,
  aiDefaultProviderId: (v) => (isProviderId(v) ? null : 'Default AI provider must be a provider id.'),
  reviewProviderId: (v) => (v === null || isProviderId(v)
    ? null : 'Story review provider must be a provider id, or empty to follow the default.'),
  captionProviderId: (v) => (v === null || isProviderId(v)
    ? null : 'Photo description provider must be a provider id, or empty to follow the default.'),
  lmModel: (v) => (typeof v === 'string' && v.trim() !== '' ? null : 'Model is required.'),
  captionTimeoutMs: (v) =>
    intInRange(v, 1000, 600000) ? null : 'Timeout must be a whole number of milliseconds between 1000 and 600000.',
  captionMaxTokens: (v) =>
    intInRange(v, 256, 32768) ? null : 'Maximum output tokens must be a whole number between 256 and 32768.',
  captionMaxEdge: (v) =>
    intInRange(v, 256, 4096) ? null : 'Max edge must be a whole number between 256 and 4096 pixels.',
  captionPrompt: (v) => (typeof v === 'string' && v.trim() !== '' ? null : 'Prompt is required.'),
  aiModel: (v) => typeof v === 'string' && v.length <= 100 ? null : 'Review model must be a string of at most 100 characters.',
  reviewPrompt: (v) => typeof v === 'string' ? null : 'Review prompt must be a string.',
  reviewTimeoutMs: (v) =>
    intInRange(v, 5000, 300000) ? null : 'Review timeout must be a whole number of milliseconds between 5000 and 300000.',
  backupSchedule: (v) =>
    v === 'off' || v === 'daily' || v === 'weekly' ? null : 'Backup schedule must be off, daily, or weekly.',
  backupRetention: (v) =>
    intInRange(v, 1, 100) ? null : 'Backup retention must be a whole number between 1 and 100.',
  convertJpeg: (v) => typeof v === 'boolean' ? null : 'JPEG conversion must be on or off.',
  webpQuality: (v) =>
    intInRange(v, 1, 100) ? null : 'WebP quality must be a whole number between 1 and 100.',
  avifQuality: (v) =>
    intInRange(v, 1, 100) ? null : 'AVIF quality must be a whole number between 1 and 100.',
  importDelayMs: (v) =>
    intInRange(v, 0, 10000) ? null : 'Import delay must be a whole number of milliseconds between 0 and 10000.',
  importRetries: (v) =>
    intInRange(v, 0, 5) ? null : 'Import retries must be a whole number between 0 and 5.',
  commentsEnabled: (v) => typeof v === 'boolean' ? null : 'Comments must be on or off.',
};

const SETTINGS_KEYS = Object.keys(FIELD_CHECKS) as (keyof Settings)[];

function intInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Shallow copy with a private provider array, so no caller can mutate the cache. */
function copySettings(s: Settings): Settings {
  return { ...s, aiProviders: cleanProviders(s.aiProviders) };
}

export function validate(s: Settings): Settings {
  for (const key of SETTINGS_KEYS) {
    const reason = FIELD_CHECKS[key](s[key]);
    if (reason) throw new SettingsError(reason);
  }
  // Cross-field: every reference names an existing provider, so resolution
  // (ai-providers.ts resolveProvider) can treat a miss as an invariant failure.
  const ids = new Set(s.aiProviders.map((p) => p.id));
  if (!ids.has(s.aiDefaultProviderId)) throw new SettingsError('Default AI provider must be one of the configured providers.');
  if (s.reviewProviderId !== null && !ids.has(s.reviewProviderId)) {
    throw new SettingsError('Story review provider must be one of the configured providers.');
  }
  if (s.captionProviderId !== null && !ids.has(s.captionProviderId)) {
    throw new SettingsError('Photo description provider must be one of the configured providers.');
  }
  return s;
}

interface LoadedSettings {
  settings: Settings;
  /** Set only when the registry was derived from a legacy file this load. */
  legacy: { original: Buffer; keyedProviderIds: string[] } | null;
  reviewPromptState: 'missing' | 'present' | 'unreadable';
}

/**
 * Read settings.json and merge it over the defaults FIELD BY FIELD. A field the
 * validator rejects falls back to its own default and is logged by name; every
 * other field is kept. Whole-file rejection (issue #112) would silently flip
 * `backupSchedule` back to `off` because an unrelated LM field went out of
 * range — and nothing would notice until someone opened the Settings page.
 * Unknown keys are dropped so they are not re-persisted forever.
 *
 * A pre-registry file (no `aiProviders`, some legacy AI field) is DERIVED into
 * the registry here; the original bytes are kept for `.pre-ai-registry`, and
 * nothing is written until `completeAiMigration()` after the key copy.
 */
function loadSettings(path: string, defaults: Settings, log: (msg: string) => void): LoadedSettings {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    // No file yet is the normal first-boot state; anything else is worth a line.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`settings: cannot read ${path}, using defaults: ${(e as Error).message}`);
    return { settings: copySettings(defaults), legacy: null, reviewPromptState: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    // JSON parser messages can quote a pasted credential from the invalid file.
    log(`settings: ${path} is not valid JSON, using defaults`);
    return { settings: copySettings(defaults), legacy: null, reviewPromptState: 'unreadable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log(`settings: ${path} is not a JSON object, using defaults`);
    return { settings: copySettings(defaults), legacy: null, reviewPromptState: 'unreadable' };
  }
  const fromFile = parsed as Record<string, unknown>;
  const loaded: Settings = copySettings(defaults);
  const fields: Record<keyof Settings, unknown> = loaded;
  let clean = true;
  for (const key of SETTINGS_KEYS) {
    const value = fromFile[key];
    if (value === undefined) continue;
    const reason = FIELD_CHECKS[key](value);
    if (reason) {
      clean = false;
      log(`settings: ignoring invalid "${key}" in ${path} (${reason}); using default ${JSON.stringify(defaults[key])}`);
      continue;
    }
    fields[key] = value;
  }
  // Every key was either copied from `defaults` or passed its own type check;
  // drop any extra keys a hand edit put inside a provider entry.
  loaded.aiProviders = cleanProviders(loaded.aiProviders);

  let legacy: LoadedSettings['legacy'] = null;
  if (isLegacyAiSettings(fromFile)) {
    const { keyedProviderIds, ...registry } = deriveFromLegacy(fromFile);
    Object.assign(loaded, registry);
    legacy = { original: bytes, keyedProviderIds };
  }

  // Repair dangling references by field name only — never log the value.
  const ids = new Set(loaded.aiProviders.map((p) => p.id));
  if (!ids.has(loaded.aiDefaultProviderId)) {
    log(`settings: "aiDefaultProviderId" in ${path} names no configured provider; using the first provider`);
    loaded.aiDefaultProviderId = loaded.aiProviders[0]!.id;
  }
  for (const key of ['reviewProviderId', 'captionProviderId'] as const) {
    const id = loaded[key];
    if (id !== null && !ids.has(id)) {
      log(`settings: "${key}" in ${path} names no configured provider; following the default provider`);
      loaded[key] = null;
    }
  }
  return { settings: loaded, legacy, reviewPromptState: !clean ? 'unreadable' : Object.hasOwn(fromFile, 'reviewPrompt') ? 'present' : 'missing' };
}

export function createSettingsStore({
  path,
  defaults,
  log = console.error,
}: {
  path: string;
  defaults: Settings;
  log?: (msg: string) => void;
}): FileSettingsStore {
  const loaded = loadSettings(path, defaults, log);
  let current = loaded.settings;
  let pending = loaded.legacy;
  let reviewPromptState = loaded.reviewPromptState;

  function persist(next: Settings): void {
    mkdirSync(dirname(path), { recursive: true });
    // Atomic write: a crash mid-write must not corrupt the live file. Write a
    // sibling temp (same dir → same filesystem) then rename over the target.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
  }

  return {
    get: () => copySettings(current),
    update: (partial) => {
      const merged = copySettings(validate({ ...current, ...partial }));
      persist(merged);
      current = merged;
      if (Object.hasOwn(partial, 'reviewPrompt')) reviewPromptState = 'present';
      return copySettings(current);
    },
    preserveLegacyReviewPrompt: (prompt) => {
      if (reviewPromptState === 'present') return;
      if (reviewPromptState === 'unreadable') {
        log('settings: reviewPrompt not migrated because the settings file was unavailable or invalid; using the default.');
        return;
      }
      const next = copySettings(validate({ ...current, reviewPrompt: prompt }));
      // A pending registry migration must publish the preserved prompt and registry
      // together, only after its encrypted-key migration and rollback copy.
      if (!pending) persist(next);
      current = next;
      reviewPromptState = 'present';
    },
    pendingAiMigration: () => (pending ? { keyedProviderIds: [...pending.keyedProviderIds] } : null),
    completeAiMigration: () => {
      if (!pending) return;
      mkdirSync(dirname(path), { recursive: true });
      // @ai-warning The rollback copy is claimed with link(2), which fails with
      // EEXIST where rename(2) would clobber: a rerun after a crash between
      // this step and the persist below must never replace the first copy,
      // and a crash mid-write never leaves a truncated copy under the name.
      const backup = `${path}.pre-ai-registry`;
      const tmp = `${backup}.${process.pid}.tmp`;
      writeFileSync(tmp, pending.original);
      try {
        linkSync(tmp, backup);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      } finally {
        unlinkSync(tmp);
      }
      persist(current);
      pending = null;
    },
  };
}
