import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, defaultSettings, validate, SettingsError, type Settings, type BackupSchedule } from '../src/settings.js';
import {
  deriveFromLegacy, newProviderId, resolveProvider, slotFor, type AiProvider, type LegacyDerivation,
} from '../src/ai-providers.js';

const DEFAULTS: Settings = defaultSettings();

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'imgset-')); });

describe('defaultSettings', () => {
  it('includes LM defaults and off / 14 backups', () => {
    const d = defaultSettings();
    expect(d.aiProviders).toEqual([{ id: 'lm-studio', name: 'Local LM Studio', kind: 'lm-studio', baseUrl: 'http://localhost:1234/v1' }]);
    expect(d).toMatchObject({ aiDefaultProviderId: 'lm-studio', reviewProviderId: null, captionProviderId: null });
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

  it('upgrades older photo settings without changing the model, and retains a saved output budget after restart', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ captionProvider: 'deepseek', lmModel: 'deepseek-flash' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get()).toMatchObject({ captionMaxTokens: 8000, captionProviderId: 'deepseek', lmModel: 'deepseek-flash' });
    store.update({ captionMaxTokens: 4096 });
    expect(createSettingsStore({ path, defaults: DEFAULTS }).get()).toMatchObject({
      captionMaxTokens: 4096, captionProviderId: 'deepseek', lmModel: 'deepseek-flash',
    });
  });

  it('replaces an invalid on-disk output budget without losing other photo settings', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ captionMaxTokens: 0, lmModel: 'chosen-vision-model' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS, log: () => {} });
    expect(store.get()).toMatchObject({ captionMaxTokens: 8000, lmModel: 'chosen-vision-model' });
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
  it('rejects an empty model', () => {
    expect(() => validate({ ...DEFAULTS, lmModel: '  ' })).toThrow(SettingsError);
  });

  it('rejects timeout out of range or non-integer', () => {
    expect(() => validate({ ...DEFAULTS, captionTimeoutMs: 999 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionTimeoutMs: 600001 })).toThrow(SettingsError);
    expect(() => validate({ ...DEFAULTS, captionTimeoutMs: 1.5 })).toThrow(SettingsError);
  });

  it.each([255, 32769, 1.5, NaN, Infinity, '8000', null, true])('rejects invalid output budget %s', (captionMaxTokens) => {
    expect(() => validate({ ...DEFAULTS, captionMaxTokens } as Settings)).toThrow(SettingsError);
  });

  it.each([256, 32768])('accepts output budget boundary %i', (captionMaxTokens) => {
    expect(validate({ ...DEFAULTS, captionMaxTokens }).captionMaxTokens).toBe(captionMaxTokens);
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
    const updated = store.update({ lmModel: 'my/vlm', captionMaxEdge: 1024 });
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

/** A remote-looking provider fixture; names stay unique per id. */
const provider = (id: string, extra: Partial<AiProvider> = {}): AiProvider =>
  ({ id, name: `Provider ${id}`, kind: 'custom', baseUrl: 'https://ai.example/v1', ...extra });
const LOCAL: AiProvider = { id: 'lm-studio', name: 'Local LM Studio', kind: 'lm-studio', baseUrl: 'http://localhost:1234/v1' };

describe('AI provider registry validation', () => {
  const withProviders = (aiProviders: unknown, extra: Record<string, unknown> = {}) =>
    ({ ...DEFAULTS, aiProviders, ...extra }) as unknown as Settings;

  it('accepts 1 to 20 providers and refuses 0 or 21', () => {
    const many = (n: number) => [LOCAL, ...Array.from({ length: n - 1 }, (_, i) => provider(`p-${i}`))];
    expect(() => validate(withProviders(many(1)))).not.toThrow();
    expect(() => validate(withProviders(many(20)))).not.toThrow();
    expect(() => validate(withProviders(many(21)))).toThrow('between 1 and 20');
    for (const invalid of [[], {}, null, 'lm-studio']) {
      expect(() => validate(withProviders(invalid)), JSON.stringify(invalid)).toThrow(SettingsError);
    }
  });

  it('limits names to 60 trimmed characters without control characters, unique case-insensitively', () => {
    expect(() => validate(withProviders([LOCAL, provider('a', { name: 'x'.repeat(60) })]))).not.toThrow();
    for (const name of ['x'.repeat(61), '', '   ', ' padded', 'tab\there', 'bell\u0007', 42]) {
      expect(() => validate(withProviders([LOCAL, provider('a', { name: name as string })])), String(name)).toThrow(SettingsError);
    }
    expect(() => validate(withProviders([LOCAL, provider('a', { name: 'local LM studio' })]))).toThrow('names must be unique');
  });

  it('requires an absolute HTTP(S) base URL of at most 300 characters without credentials, query, or fragment', () => {
    const check = (baseUrl: unknown) => validate(withProviders([LOCAL, provider('a', { baseUrl: baseUrl as string })]));
    expect(() => check('http://192.168.1.5:1234/v1')).not.toThrow();
    const prefix = 'https://ai.example/';
    expect(() => check(prefix + 'x'.repeat(300 - prefix.length))).not.toThrow();
    for (const baseUrl of [
      '', 'relative/path', 'ftp://ai.example/v1', 'file:///private', 'https://user:pw@ai.example/v1',
      'https://ai.example/v1?key=fixture', 'https://ai.example/v1?', 'https://ai.example/v1#frag', 'https://ai.example/v1#',
      ' https://ai.example/v1', 'https://ai.example/a b', prefix + 'x'.repeat(301 - prefix.length), null,
    ]) {
      expect(() => check(baseUrl), String(baseUrl)).toThrow(SettingsError);
    }
  });

  it('accepts only server-shaped, unique ids and known kinds', () => {
    expect(() => validate(withProviders([LOCAL, provider('a'.repeat(40))]))).not.toThrow();
    for (const id of ['a'.repeat(41), '-lead', 'Upper', 'ai_provider_key:x', '../x', '', 7]) {
      expect(() => validate(withProviders([LOCAL, provider(id as string)])), String(id)).toThrow(SettingsError);
    }
    expect(() => validate(withProviders([LOCAL, provider('lm-studio')]))).toThrow('ids must be unique');
    expect(() => validate(withProviders([LOCAL, provider('a', { kind: 'ollama' as AiProvider['kind'] })]))).toThrow(SettingsError);
  });

  it('requires the default and both assignments to name configured providers', () => {
    const aiProviders = [LOCAL, provider('remote', { kind: 'openrouter' })];
    const ok = validate(withProviders(aiProviders, { aiDefaultProviderId: 'remote', reviewProviderId: 'lm-studio', captionProviderId: null }));
    expect(ok).toMatchObject({ aiDefaultProviderId: 'remote', reviewProviderId: 'lm-studio', captionProviderId: null });
    for (const extra of [
      { aiDefaultProviderId: 'gone' }, { reviewProviderId: 'gone' }, { captionProviderId: 'gone' },
      { aiDefaultProviderId: null }, { reviewProviderId: '' }, { captionProviderId: 'Bad Id' },
    ]) {
      expect(() => validate(withProviders(aiProviders, extra)), JSON.stringify(extra)).toThrow(SettingsError);
    }
  });

  it('update() refuses an invalid registry without touching memory or disk', async () => {
    const path = join(dir, 'settings.json');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    store.update({ aiProviders: [LOCAL, provider('remote')], captionProviderId: 'remote' });
    const before = await readFile(path, 'utf8');
    for (const partial of [{ aiProviders: [provider('remote')] }, { captionProviderId: 'gone' }, { aiProviders: [] }]) {
      expect(() => store.update(partial as Partial<Settings>)).toThrow(SettingsError);
    }
    expect(store.get().captionProviderId).toBe('remote');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('hands out copies, so a caller cannot mutate the cached registry', () => {
    const store = createSettingsStore({ path: join(dir, 'settings.json'), defaults: DEFAULTS });
    store.get().aiProviders[0]!.baseUrl = 'https://mutated.example/v1';
    store.get().aiProviders.push(provider('x'));
    expect(store.get().aiProviders).toEqual([LOCAL]);
  });
});

describe('AI provider helpers', () => {
  it('builds a secret slot name only from a valid id', () => {
    expect(slotFor('p-0a1b2c3d')).toBe('ai_provider_key:p-0a1b2c3d');
    for (const id of ['../x', 'A', '', 'x:y']) expect(() => slotFor(id), id).toThrow();
  });

  it('resolves an explicit assignment, follows the default for null, and never substitutes on a miss', () => {
    const s = { aiProviders: [LOCAL, provider('remote')], aiDefaultProviderId: 'lm-studio' };
    expect(resolveProvider(s, null).id).toBe('lm-studio');
    expect(resolveProvider(s, 'remote').id).toBe('remote');
    expect(() => resolveProvider(s, 'gone')).toThrow();
    expect(() => resolveProvider({ ...s, aiDefaultProviderId: 'gone' }, null)).toThrow();
  });

  it('mints p-<8 hex> ids that are valid slot ids', () => {
    for (let i = 0; i < 20; i++) {
      const id = newProviderId([LOCAL]);
      expect(id).toMatch(/^p-[0-9a-f]{8}$/);
      expect(slotFor(id)).toBe(`ai_provider_key:${id}`);
    }
  });
});

describe('AI registry load repair', () => {
  it('repairs dangling references by field name, never by value', async () => {
    const path = join(dir, 'settings.json');
    const remote = provider('remote', { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' });
    await writeFile(path, JSON.stringify({
      aiProviders: [remote, LOCAL], aiDefaultProviderId: 'removed-default',
      reviewProviderId: 'removed-review', captionProviderId: 'remote', backupSchedule: 'daily',
    }));
    const log = vi.fn();
    const s = createSettingsStore({ path, defaults: DEFAULTS, log }).get();
    expect(s).toMatchObject({ aiDefaultProviderId: 'remote', reviewProviderId: null, captionProviderId: 'remote', backupSchedule: 'daily' });
    expect(s.aiProviders).toEqual([remote, LOCAL]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([expect.stringContaining('"aiDefaultProviderId"'), expect.stringContaining('"reviewProviderId"')]);
    expect(lines.join(' ')).not.toMatch(/removed-default|removed-review/);
    expect(() => validate(s)).not.toThrow();
  });

  it('an invalid provider list falls back to the local default and repairs what referenced it', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({
      aiProviders: [{ id: 'remote', name: 'X', kind: 'openrouter', baseUrl: 'https://user:pw@x.example/v1' }],
      aiDefaultProviderId: 'remote', captionProviderId: 'remote', backupSchedule: 'daily',
    }));
    const log = vi.fn();
    const s = createSettingsStore({ path, defaults: DEFAULTS, log }).get();
    expect(s).toMatchObject({ aiProviders: [LOCAL], aiDefaultProviderId: 'lm-studio', captionProviderId: null, backupSchedule: 'daily' });
    expect(log.mock.calls.flat().join(' ')).not.toContain('user:pw');
  });

  it('drops extra keys inside provider entries so they are never re-persisted', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ aiProviders: [{ ...LOCAL, hasApiKey: true, apiKey: 'must-not-persist' }] }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get().aiProviders).toEqual([LOCAL]);
    store.update({ backupRetention: 5 });
    expect(await readFile(path, 'utf8')).not.toContain('must-not-persist');
  });
});

describe('legacy AI settings derivation', () => {
  const OPENROUTER: AiProvider = { id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' };
  const DEEPSEEK: AiProvider = { id: 'deepseek', name: 'DeepSeek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' };
  const custom = (id: 'custom' | 'custom-2', baseUrl: string): AiProvider =>
    ({ id, name: id === 'custom' ? 'Custom' : 'Custom 2', kind: 'custom', baseUrl });
  const assigned = (review: string, caption: string, keyedProviderIds: string[]) =>
    ({ aiDefaultProviderId: review, reviewProviderId: review, captionProviderId: caption, keyedProviderIds });
  const cases: [string, Record<string, unknown>, LegacyDerivation][] = [
    ['local only', { lmBaseUrl: 'http://lm.lan:1234/v1', aiProvider: 'lm-studio', captionProvider: 'lm-studio' },
      { aiProviders: [{ ...LOCAL, baseUrl: 'http://lm.lan:1234/v1' }], ...assigned('lm-studio', 'lm-studio', []) }],
    ['review openrouter, caption local', { aiProvider: 'openrouter', captionProvider: 'lm-studio' },
      { aiProviders: [LOCAL, OPENROUTER], ...assigned('openrouter', 'lm-studio', ['openrouter']) }],
    ['both deepseek share one provider', { aiProvider: 'deepseek', captionProvider: 'deepseek' },
      { aiProviders: [LOCAL, DEEPSEEK], ...assigned('deepseek', 'deepseek', ['deepseek']) }],
    ['review deepseek, caption openrouter: two keyed', { aiProvider: 'deepseek', captionProvider: 'openrouter' },
      { aiProviders: [LOCAL, DEEPSEEK, OPENROUTER], ...assigned('deepseek', 'openrouter', ['deepseek', 'openrouter']) }],
    ['selected review custom, unselected caption custom kept but never keyed', {
      aiProvider: 'custom', aiCustomBaseUrl: 'https://review.example/v1',
      captionProvider: 'lm-studio', captionCustomBaseUrl: 'https://vision.example/v1',
    }, {
      aiProviders: [LOCAL, custom('custom', 'https://review.example/v1'), custom('custom-2', 'https://vision.example/v1')],
      ...assigned('custom', 'lm-studio', ['custom']),
    }],
    ['selected caption custom, unselected review custom kept but never keyed', {
      aiProvider: 'openrouter', aiCustomBaseUrl: 'https://review.example/v1',
      captionProvider: 'custom', captionCustomBaseUrl: 'https://vision.example/v1',
    }, {
      aiProviders: [LOCAL, OPENROUTER, custom('custom', 'https://review.example/v1'), custom('custom-2', 'https://vision.example/v1')],
      ...assigned('openrouter', 'custom-2', ['openrouter', 'custom-2']),
    }],
    ['one custom URL used by both features', {
      aiProvider: 'custom', aiCustomBaseUrl: 'https://same.example/v1',
      captionProvider: 'custom', captionCustomBaseUrl: ' https://same.example/v1 ',
    }, { aiProviders: [LOCAL, custom('custom', 'https://same.example/v1')], ...assigned('custom', 'custom', ['custom']) }],
    ['selected custom with an empty URL lands on the local provider', { aiProvider: 'custom', aiCustomBaseUrl: '', captionProvider: 'openrouter' },
      { aiProviders: [LOCAL, OPENROUTER], ...assigned('lm-studio', 'openrouter', ['openrouter']) }],
    ['invalid legacy values recover to defaults', {
      lmBaseUrl: 'ftp://lm.lan/v1', aiProvider: 'other', captionProvider: ['custom'],
      aiCustomBaseUrl: 'https://review.example/v1?key=fixture', captionCustomBaseUrl: 42,
    }, { aiProviders: [LOCAL], ...assigned('lm-studio', 'lm-studio', []) }],
    ['selected custom with a credential-bearing URL is dropped, not keyed', { aiProvider: 'custom', aiCustomBaseUrl: 'https://user:pw@review.example/v1' },
      { aiProviders: [LOCAL], ...assigned('lm-studio', 'lm-studio', []) }],
  ];

  it.each(cases)('%s', (_name, raw, expected) => {
    const derived = deriveFromLegacy(raw);
    expect(derived).toEqual(expected);
    // Deterministic ids: a rerun after a crash derives the same slots.
    expect(deriveFromLegacy(raw)).toEqual(derived);
    const { keyedProviderIds: _keyed, ...registry } = derived;
    expect(() => validate({ ...DEFAULTS, ...registry })).not.toThrow();
  });
});

describe('legacy settings migration through the store', () => {
  const legacyFile = JSON.stringify({
    lmBaseUrl: 'http://lm.lan:1234/v1', lmModel: 'legacy-vision', captionProvider: 'openrouter', captionCustomBaseUrl: '',
    aiProvider: 'deepseek', aiCustomBaseUrl: '', aiModel: 'legacy-review', backupSchedule: 'daily',
  }, null, 4);

  it('derives the registry on load, keeps every other field, and writes nothing before completion', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, legacyFile);
    const store = createSettingsStore({ path, defaults: DEFAULTS, log: () => {} });
    expect(store.get()).toMatchObject({
      aiDefaultProviderId: 'deepseek', reviewProviderId: 'deepseek', captionProviderId: 'openrouter',
      lmModel: 'legacy-vision', aiModel: 'legacy-review', backupSchedule: 'daily',
    });
    expect(store.get().aiProviders.map((p) => [p.id, p.baseUrl])).toEqual([
      ['lm-studio', 'http://lm.lan:1234/v1'], ['deepseek', 'https://api.deepseek.com/v1'], ['openrouter', 'https://openrouter.ai/api/v1'],
    ]);
    expect(store.get()).not.toHaveProperty('aiProvider');
    expect(store.pendingAiMigration()).toEqual({ keyedProviderIds: ['deepseek', 'openrouter'] });
    expect(await readFile(path, 'utf8')).toBe(legacyFile);
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  it('completion keeps the original bytes once, persists the registry shape and clears the pending state', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, legacyFile);
    const store = createSettingsStore({ path, defaults: DEFAULTS, log: () => {} });
    store.completeAiMigration();
    expect(await readFile(`${path}.pre-ai-registry`, 'utf8')).toBe(legacyFile);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    expect(onDisk).toMatchObject({ aiDefaultProviderId: 'deepseek', reviewProviderId: 'deepseek', captionProviderId: 'openrouter' });
    for (const field of ['lmBaseUrl', 'captionProvider', 'captionCustomBaseUrl', 'aiProvider', 'aiCustomBaseUrl']) {
      expect(onDisk).not.toHaveProperty(field);
    }
    expect(store.pendingAiMigration()).toBeNull();
    expect((await readdir(dir)).sort()).toEqual(['settings.json', 'settings.json.pre-ai-registry']);
    const reloaded = createSettingsStore({ path, defaults: DEFAULTS });
    expect(reloaded.pendingAiMigration()).toBeNull();
    expect(reloaded.get()).toEqual(store.get());
    store.completeAiMigration();
    expect(await readFile(`${path}.pre-ai-registry`, 'utf8')).toBe(legacyFile);
  });

  it('never clobbers an existing .pre-ai-registry copy (a rerun after a crash)', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, legacyFile);
    await writeFile(`${path}.pre-ai-registry`, 'first-run copy');
    const store = createSettingsStore({ path, defaults: DEFAULTS, log: () => {} });
    store.completeAiMigration();
    expect(await readFile(`${path}.pre-ai-registry`, 'utf8')).toBe('first-run copy');
    expect(JSON.parse(await readFile(path, 'utf8')).aiProviders).toHaveLength(3);
    expect((await readdir(dir)).sort()).toEqual(['settings.json', 'settings.json.pre-ai-registry']);
  });

  it('a file without legacy AI fields, or one already on the registry, migrates nothing', async () => {
    const path = join(dir, 'settings.json');
    for (const content of [{ backupSchedule: 'daily', aiApiKey: 'x' }, { aiProviders: [LOCAL], aiProvider: 'openrouter' }]) {
      await writeFile(path, JSON.stringify(content));
      const store = createSettingsStore({ path, defaults: DEFAULTS, log: () => {} });
      expect(store.pendingAiMigration()).toBeNull();
      expect(store.get()).toMatchObject({ aiProviders: [LOCAL], aiDefaultProviderId: 'lm-studio' });
      store.completeAiMigration();
    }
    expect(await readdir(dir)).toEqual(['settings.json']);
  });
});

describe('editorial review settings', () => {
  it('enforces model, prompt and integer timeout boundaries', () => {
    const invalid: Record<string, unknown>[] = [
      { aiModel: 'x'.repeat(101) }, { aiModel: {} },
      { reviewTimeoutMs: 4999 }, { reviewTimeoutMs: 300001 }, { reviewTimeoutMs: 5000.5 }, { reviewTimeoutMs: '60000' },
      { reviewPrompt: null },
    ];
    for (const partial of invalid) expect(() => validate({ ...DEFAULTS, ...partial })).toThrow(SettingsError);
    expect(validate({ ...DEFAULTS, aiModel: 'x'.repeat(100), reviewTimeoutMs: 5000 }).reviewTimeoutMs).toBe(5000);
    expect(validate({ ...DEFAULTS, reviewTimeoutMs: 300000 }).reviewTimeoutMs).toBe(300000);
  });

  it('keeps prior caption and backup configuration while new review fields roundtrip without a secret', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ lmModel: 'local-caption', backupSchedule: 'daily', aiApiKey: 'must-not-persist' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get()).toMatchObject({ lmModel: 'local-caption', backupSchedule: 'daily', aiDefaultProviderId: 'lm-studio', reviewProviderId: null });
    store.update({ aiModel: 'review-model', reviewTimeoutMs: 300000, reviewPrompt: 'Review this story.' });
    const loaded = createSettingsStore({ path, defaults: DEFAULTS }).get();
    expect(loaded).toMatchObject({ aiModel: 'review-model', lmModel: 'local-caption', backupSchedule: 'daily', reviewTimeoutMs: 300000 });
    expect(await readFile(path, 'utf8')).not.toContain('must-not-persist');
    expect(loaded).not.toHaveProperty('aiApiKey');
  });

  it('does not quote a malformed settings file into logs', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, '{ \"aiApiKey\": \"private-fixture\" BROKEN');
    const log = vi.fn();
    createSettingsStore({ path, defaults: DEFAULTS, log });
    expect(log.mock.calls.flat().join(' ')).not.toContain('private-fixture');
  });
});

describe('comments switch (#207)', () => {
  it('defaults off — fail closed', () => {
    expect(defaultSettings().commentsEnabled).toBe(false);
  });

  it('round-trips through update() and the file, and survives an older settings.json without the key', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ backupSchedule: 'daily' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get().commentsEnabled).toBe(false);
    expect(store.update({ commentsEnabled: true }).commentsEnabled).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).commentsEnabled).toBe(true);
    expect(createSettingsStore({ path, defaults: DEFAULTS }).get()).toMatchObject({ commentsEnabled: true, backupSchedule: 'daily' });
  });

  it('rejects a non-boolean in update() without touching backupSchedule (#112)', async () => {
    const path = join(dir, 'settings.json');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    store.update({ backupSchedule: 'daily' });
    for (const bad of ['true', 1, null]) {
      expect(() => store.update({ commentsEnabled: bad as unknown as boolean })).toThrow(SettingsError);
    }
    expect(store.get()).toMatchObject({ backupSchedule: 'daily', commentsEnabled: false });
  });

  it('an invalid on-disk value falls back to off and keeps the other fields', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ commentsEnabled: 'yes', backupSchedule: 'weekly' }));
    const log = vi.fn();
    expect(createSettingsStore({ path, defaults: DEFAULTS, log }).get()).toMatchObject({ commentsEnabled: false, backupSchedule: 'weekly' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"commentsEnabled"'));
  });
});

describe('image conversion settings', () => {
  it('loads legacy settings without changing image behavior and persists an independent image update', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ backupSchedule: 'daily', lmModel: 'local-caption' }));
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    expect(store.get()).toMatchObject({ convertJpeg: true, webpQuality: 75, avifQuality: 55 });
    store.update({ convertJpeg: false, webpQuality: 100, avifQuality: 1 });
    expect(createSettingsStore({ path, defaults: DEFAULTS }).get()).toMatchObject({
      convertJpeg: false, webpQuality: 100, avifQuality: 1,
      backupSchedule: 'daily', lmModel: 'local-caption',
    });
  });

  it('rejects malformed image settings without changing memory or disk', async () => {
    const path = join(dir, 'settings.json');
    const store = createSettingsStore({ path, defaults: DEFAULTS });
    store.update({ convertJpeg: false, webpQuality: 80, avifQuality: 60 });
    const before = await readFile(path, 'utf8');
    const invalid: Record<string, unknown>[] = [
      { convertJpeg: 'false' }, { convertJpeg: 0 }, { convertJpeg: null },
      { webpQuality: 0 }, { avifQuality: 101 }, { webpQuality: 75.5 },
      { avifQuality: '55' }, { webpQuality: Number.NaN },
    ];
    for (const partial of invalid) {
      expect(() => store.update(partial)).toThrow(SettingsError);
      expect(store.get()).toMatchObject({ convertJpeg: false, webpQuality: 80, avifQuality: 60 });
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  });

  it('recovers invalid on-disk quality without re-enabling a disabled conversion preference', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({ convertJpeg: false, webpQuality: 0, avifQuality: 64 }));
    const log = vi.fn();
    expect(createSettingsStore({ path, defaults: DEFAULTS, log }).get()).toMatchObject({
      convertJpeg: false, webpQuality: 75, avifQuality: 64,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"webpQuality"'));
  });
});
