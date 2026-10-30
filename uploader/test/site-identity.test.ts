import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeIdentityEdit, memorySiteIdentityStore } from '../src/site-identity.js';
import { LEGACY_IDENTITY, LEGACY_REVIEW_PROMPT } from '../src/site-identity-legacy.js';
import { createSettingsStore, defaultSettings } from '../src/settings.js';
import { neutralIdentity, toIdentitySnapshot } from '../../site/src/lib/site-identity.js';
import { DEFAULT_REVIEW_PROMPT } from '../src/editorial-review.js';

describe('identity edit storage boundary', () => {
  it.each(['de', 'en'] as const)('keeps inactive text through an active-only %s save and re-enabling projection', (active) => {
    const inactive = active === 'de' ? 'en' : 'de';
    const stored = { ...neutralIdentity(), tagline: { de: 'DE', en: 'EN' }, aboutGear: { de: 'Camera', en: 'Notebook' } };
    const { canonicalOrigin: _reserved, ...edit } = neutralIdentity();
    const next = mergeIdentityEdit(stored, { ...edit, tagline: { [active]: 'Edited' } }, [active]);
    expect(next.tagline).toEqual({ [inactive]: stored.tagline[inactive], [active]: 'Edited' });
    expect(next.aboutGear).toEqual({ [inactive]: stored.aboutGear[inactive] });
    expect(toIdentitySnapshot(next, [active]).aboutGear).toEqual({});
    expect(toIdentitySnapshot(next, ['de', 'en']).aboutGear).toEqual({ [inactive]: stored.aboutGear[inactive] });
    expect(() => mergeIdentityEdit(stored, { ...edit, tagline: { [inactive]: 'Overwrite' } }, [active])).toThrow();
    expect(() => mergeIdentityEdit({ ...stored, tagline: { [inactive]: 'x'.repeat(161) } }, edit, [active])).toThrow();
  });
  it('rejects stale memory writes and preserves reserved origin while normalizing text', async () => {
    const store = memorySiteIdentityStore(LEGACY_IDENTITY);
    const { canonicalOrigin: _reserved, ...edit } = store.get().identity;
    await expect(store.update(1, { ...edit, authorName: ' Ada\u200b ' })).rejects.toMatchObject({ code: 'invalid_identity', field: 'authorName' });
    expect(store.get().revision).toBe(1);
    expect(store.get().identity.authorName).toBe(LEGACY_IDENTITY.authorName);
    await store.update(1, { ...edit, authorName: ' Ada ' });
    expect(store.get().identity).toMatchObject({ canonicalOrigin: LEGACY_IDENTITY.canonicalOrigin, authorName: 'Ada' });
    await expect(store.update(1, edit)).rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(store.update(2, { ...edit, canonicalOrigin: null })).rejects.toMatchObject({ code: 'invalid_identity', field: 'canonicalOrigin' });
  });
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function settingsFile(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'identity-prompt-'));
  dirs.push(dir);
  const path = join(dir, 'settings.json');
  if (content !== undefined) await writeFile(path, content);
  return path;
}
describe('upgrade review prompt preservation', () => {
  it('uses a brand-neutral fresh default and retains the exact old prompt remainder', () => {
    expect(DEFAULT_REVIEW_PROMPT.split('\n')[0]).toBe('You are an editorial and SEO reviewer for a personal travel blog.');
    expect(DEFAULT_REVIEW_PROMPT).not.toMatch(/Simon|Wanderlust/);
    expect(LEGACY_REVIEW_PROMPT.split('\n').slice(1)).toEqual(DEFAULT_REVIEW_PROMPT.split('\n').slice(1));
    expect(LEGACY_REVIEW_PROMPT.split('\n')[0]).toBe("You are an editorial and SEO reviewer for Simon's Wanderlust, a personal travel blog.");
  });
  it('persists the legacy prompt once for a clean file without the key, preserving other settings', async () => {
    const path = await settingsFile(JSON.stringify({ backupSchedule: 'daily' }));
    const store = createSettingsStore({ path, defaults: defaultSettings() });
    store.preserveLegacyReviewPrompt(LEGACY_REVIEW_PROMPT);
    expect(store.get()).toMatchObject({ reviewPrompt: LEGACY_REVIEW_PROMPT, backupSchedule: 'daily' });
    const saved = await readFile(path, 'utf8');
    store.preserveLegacyReviewPrompt('Must not overwrite');
    expect(await readFile(path, 'utf8')).toBe(saved);
    expect(createSettingsStore({ path, defaults: defaultSettings() }).get().reviewPrompt).toBe(LEGACY_REVIEW_PROMPT);
  });
  it.each(['', 'Custom prompt', 'First line\n\tSecond line\n'])('does not replace an explicit saved prompt %j', async (reviewPrompt) => {
    const path = await settingsFile(JSON.stringify({ reviewPrompt }));
    const store = createSettingsStore({ path, defaults: defaultSettings() });
    const before = await readFile(path, 'utf8');
    store.preserveLegacyReviewPrompt(LEGACY_REVIEW_PROMPT);
    expect(store.get().reviewPrompt).toBe(reviewPrompt);
    expect(await readFile(path, 'utf8')).toBe(before);
  });
  it.each([undefined, '{invalid', 'null', '[]', '{"backupRetention":-1}'])('never overwrites missing or invalid settings %j', async (content) => {
    const path = await settingsFile(content);
    const log = vi.fn();
    const store = createSettingsStore({ path, defaults: defaultSettings(), log });
    store.preserveLegacyReviewPrompt(LEGACY_REVIEW_PROMPT);
    expect(store.get().reviewPrompt).toBe(DEFAULT_REVIEW_PROMPT);
    if (content === undefined) await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(path, 'utf8')).toBe(content);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reviewPrompt not migrated'));
  });
  it('publishes registry and preserved prompt together after retaining the pre-migration file', async () => {
    const original = JSON.stringify({ aiProvider: 'openrouter', lmBaseUrl: 'http://localhost:1234/v1' });
    const path = await settingsFile(original);
    const store = createSettingsStore({ path, defaults: defaultSettings() });
    expect(store.pendingAiMigration()).not.toBeNull();
    store.preserveLegacyReviewPrompt(LEGACY_REVIEW_PROMPT);
    expect(await readFile(path, 'utf8')).toBe(original);
    store.completeAiMigration();
    expect(await readFile(`${path}.pre-ai-registry`, 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ reviewPrompt: LEGACY_REVIEW_PROMPT, aiDefaultProviderId: 'openrouter' });
  });
});
