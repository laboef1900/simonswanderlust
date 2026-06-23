import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_PROMPT } from './caption.js';

export interface Settings {
  lmBaseUrl: string;
  lmModel: string;
  captionTimeoutMs: number;
  captionMaxEdge: number;
  captionPrompt: string;
}

export class SettingsError extends Error {}

export interface SettingsStore {
  get(): Settings;
  update(partial: Partial<Settings>): Settings;
}

export function defaultsFromEnv(env: NodeJS.ProcessEnv): Settings {
  return {
    lmBaseUrl: env.LMSTUDIO_BASE_URL ?? 'http://host.docker.internal:1234/v1',
    lmModel: env.LMSTUDIO_MODEL ?? 'qwen/qwen3-vl-4b',
    captionTimeoutMs: Number(env.CAPTION_TIMEOUT_MS ?? 60000),
    captionMaxEdge: Number(env.CAPTION_MAX_EDGE ?? 768),
    captionPrompt: DEFAULT_PROMPT,
  };
}

function validate(s: Settings): Settings {
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
  return s;
}

export function createSettingsStore({ path, defaults }: { path: string; defaults: Settings }): SettingsStore {
  let current: Settings = { ...defaults };
  try {
    const fromFile = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    current = { ...defaults, ...fromFile };
  } catch {
    // No file yet, or unreadable/corrupt — keep defaults.
  }

  return {
    get: () => ({ ...current }),
    update: (partial) => {
      const merged = validate({ ...current, ...partial });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(merged, null, 2));
      current = merged;
      return { ...current };
    },
  };
}
