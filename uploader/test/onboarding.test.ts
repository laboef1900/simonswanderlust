import { describe, expect, it, vi } from 'vitest';
import { decodeOnboardingRow, memoryOnboardingStore, onboardingView, RETIRED_REASONS, type OnboardingProgress, type OnboardingState } from '../src/onboarding.js';

const evaluatedAt = '2026-10-27T12:00:00.000Z';
const eligible: OnboardingState = { schemaVersion: 1, state: 'eligible', reason: 'fresh', evaluatedAt, dismissedAt: null, retiredAt: null };
const empty: OnboardingProgress = { identity: false, ready: false, processing: false, attention: false, story: false, published: false, newest: null, newestDraft: null };
const row = { singleton: true, schema_version: 1, state: 'eligible', reason: 'fresh', evaluated_at: evaluatedAt, dismissed_at: null, retired_at: null };

describe('onboarding state decoding', () => {
  it('distinguishes eligible metadata and valid retired reasons without exposing diagnostics', () => {
    expect(decodeOnboardingRow(row)).toEqual(eligible);
    for (const reason of RETIRED_REASONS) {
      const state = decodeOnboardingRow({ ...row, state: 'retired', reason, retired_at: new Date(evaluatedAt) });
      expect(state).toMatchObject({ state: 'retired', reason, retiredAt: evaluatedAt });
      expect(onboardingView(state)).toEqual({ status: 'retired' });
    }
  });
  it.each([
    { singleton: false }, { schema_version: 2 }, { schema_version: '1' }, { state: 'unknown' },
    { reason: 'finished' }, { evaluated_at: null }, { evaluated_at: 'invalid' },
    { dismissed_at: 42 }, { retired_at: evaluatedAt },
    { state: 'retired', reason: 'fresh', retired_at: evaluatedAt },
    { state: 'retired', reason: 'finished', retired_at: null },
    { state: 'retired', reason: 'finished', retired_at: evaluatedAt, dismissed_at: evaluatedAt },
  ])('refuses malformed durable metadata %j', (patch) => {
    expect(() => decodeOnboardingRow({ ...row, ...patch })).toThrow();
  });
});

describe('snapshot-derived onboarding', () => {
  it.each([
    [{}, 'todo'], [{ attention: true }, 'attention'], [{ attention: true, processing: true }, 'in_progress'],
    [{ ready: true, processing: true, attention: true }, 'done'],
  ] as const)('uses photo precedence for %j', (patch, expected) => {
    const view = onboardingView(eligible, { ...empty, ...patch });
    expect(view.status).toBe('open');
    if (view.status === 'retired') throw new Error('expected eligible');
    expect(view.steps.find((step) => step.id === 'photo')?.state).toBe(expected);
    expect(view.steps.filter((step) => step.required).map((step) => step.id)).toEqual(['photo', 'story', 'publish']);
  });
  it('encodes a key as one query parameter and never includes source metadata', () => {
    const key = '<img src=x>&other=#evil/\u{1D11E}';
    const view = onboardingView(eligible, { ...empty, story: true, newest: key, newestDraft: key });
    if (view.status === 'retired') throw new Error('expected eligible');
    for (const id of ['story', 'publish']) {
      const href = view.steps.find((step) => step.id === id)!.href!;
      const url = new URL(href, 'https://studio.example');
      expect(url.pathname).toBe('/admin/editor.html');
      expect([...url.searchParams]).toEqual([['tk', key]]);
      expect(url.hash).toBe('');
    }
    expect(Object.keys(view).sort()).toEqual(['complete', 'status', 'steps']);
    expect(Object.keys(view.steps[0]!).sort()).toEqual(['href', 'id', 'required', 'state']);
  });
  it('hides install-wide, resumes idempotently, regresses live predicates and permanently finishes without identity', async () => {
    let progress = { ...empty };
    const store = memoryOnboardingStore({ state: eligible, progress: () => progress, now: () => new Date(evaluatedAt) });
    expect(await store.act('dismiss')).toMatchObject({ status: 'dismissed', complete: false });
    expect(await store.act('dismiss')).toEqual(await store.read());
    progress = { ...progress, ready: true, story: true, published: true, newest: 'a' };
    expect(await store.read()).toMatchObject({ status: 'dismissed', complete: true });
    progress.ready = false;
    await expect(store.act('finish')).rejects.toMatchObject({ code: 'onboarding_incomplete' });
    expect(await store.act('resume')).toMatchObject({ status: 'open', complete: false });
    expect(await store.act('resume')).toEqual(await store.read());
    progress.ready = true;
    const complete = await store.read();
    expect(complete).toMatchObject({ complete: true, steps: expect.arrayContaining([{ id: 'identity', state: 'todo', required: false, href: '/admin/settings.html#identity' }]) });
    expect(await store.act('finish')).toEqual({ status: 'retired' });
    progress = { ...empty };
    expect(await store.read()).toEqual({ status: 'retired' });
    for (const action of ['dismiss', 'resume', 'finish'] as const) await expect(store.act(action)).rejects.toMatchObject({ code: 'onboarding_retired' });
  });
  it.each(['ready', 'story', 'published'] as const)('rechecks required %s at finish', async (field) => {
    const progress = { ...empty, ready: true, story: true, published: true };
    const store = memoryOnboardingStore({ state: eligible, progress: () => progress });
    expect(await store.read()).toMatchObject({ complete: true });
    progress[field] = false;
    await expect(store.act('finish')).rejects.toMatchObject({ code: 'onboarding_incomplete' });
  });
  it('never reads progress for retired or absent state and never initializes missing state', async () => {
    const progress = vi.fn(() => empty);
    const retired = memoryOnboardingStore({ state: { schemaVersion: 1, state: 'retired', reason: 'finished', evaluatedAt, dismissedAt: null, retiredAt: evaluatedAt }, progress });
    expect(await retired.read()).toEqual({ status: 'retired' });
    await expect(retired.act('resume')).rejects.toMatchObject({ code: 'onboarding_retired' });
    const missing = memoryOnboardingStore({ state: null, progress });
    await expect(missing.read()).rejects.toThrow();
    await expect(missing.act('dismiss')).rejects.toThrow();
    expect(progress).not.toHaveBeenCalled();
  });
  it('does not mutate on owner loss or failed snapshot read', async () => {
    let writable = false;
    const progress = vi.fn(() => empty);
    const store = memoryOnboardingStore({ state: eligible, progress, isWritable: () => writable });
    await expect(store.act('dismiss')).rejects.toMatchObject({ code: 'storage_read_only' });
    expect(progress).not.toHaveBeenCalled();
    writable = true;
    progress.mockImplementationOnce(() => { throw new Error('snapshot unavailable'); });
    await expect(store.act('dismiss')).rejects.toThrow('snapshot unavailable');
    expect(await store.read()).toMatchObject({ status: 'open' });
  });
  it('does not resurrect when resume and finish race in memory', async () => {
    const store = memoryOnboardingStore({ state: eligible, progress: () => ({ ...empty, ready: true, story: true, published: true }) });
    const outcomes = await Promise.allSettled([store.act('finish'), store.act('resume')]);
    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: { status: 'retired' } });
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'onboarding_retired' } });
    expect(await store.read()).toEqual({ status: 'retired' });
  });
});
