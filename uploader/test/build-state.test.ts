import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFailureMessage, createBuildState, observeLiveRelease } from '../src/build-state.js';

let root: string;
const attemptId = '1790000000000-123-0001';
const startedAt = new Date(1790000000000).toISOString();
const finishedAt = new Date(1790000001000).toISOString();
function completed() {
  return { schema: 1, running: null, last: {
    attemptId, startedAt, finishedAt, result: 'failed', release: null,
    failure: { code: 'build_failed', message: 'untrusted persisted text' }, triggers: ['publish'],
  } };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'build-state-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('bounded strict build record reader', () => {
  it('derives failure copy from the code, preserves optional absence, and never rewrites on boot', async () => {
    const contents = JSON.stringify(completed());
    await writeFile(join(root, 'build-state.json'), contents);
    const state = createBuildState(root, {});
    const status = await state.status(false);
    expect(status).toMatchObject({ record: 'ok', last: { beforeBoot: true, failure: { code: 'build_failed', message: buildFailureMessage('build_failed') } } });
    expect(status.last).not.toHaveProperty('liveReleaseAfter');
    expect(await readFile(join(root, 'build-state.json'), 'utf8')).toBe(contents);
    status.last!.triggers.push('delete');
    expect((await state.status(false)).last!.triggers).toEqual(['publish']);
  });

  it.each([
    ['malformed JSON', '{'],
    ['oversized', ' '.repeat(64 * 1024 + 1)],
    ['unknown schema', JSON.stringify({ ...completed(), schema: 2 })],
    ['unknown top-level key', JSON.stringify({ ...completed(), diagnostics: 'private' })],
    ['unknown attempt key', JSON.stringify({ ...completed(), last: { ...completed().last, stderr: 'private' } })],
    ['invalid result', JSON.stringify({ ...completed(), last: { ...completed().last, result: 'done' } })],
    ['inconsistent success', JSON.stringify({ ...completed(), last: { ...completed().last, result: 'succeeded' } })],
    ['invalid failure code', JSON.stringify({ ...completed(), last: { ...completed().last, failure: { code: 'oops', message: 'unsafe' } } })],
    ['invalid failure type', JSON.stringify({ ...completed(), last: { ...completed().last, failure: { code: 'internal', message: {} } } })],
    ['invalid optional live', JSON.stringify({ ...completed(), last: { ...completed().last, liveReleaseAfter: '../outside' } })],
    ['invalid time', JSON.stringify({ ...completed(), last: { ...completed().last, startedAt: '2026-02-30' } })],
    ['mismatched stamp time', JSON.stringify({ ...completed(), last: { ...completed().last, startedAt: finishedAt } })],
    ['finish precedes start', JSON.stringify({ ...completed(), last: { ...completed().last, finishedAt: new Date(0).toISOString() } })],
    ['invalid trigger', JSON.stringify({ ...completed(), last: { ...completed().last, triggers: ['identity'] } })],
    ['duplicate triggers', JSON.stringify({ ...completed(), last: { ...completed().last, triggers: ['publish', 'publish'] } })],
    ['unsorted triggers', JSON.stringify({ ...completed(), last: { ...completed().last, triggers: ['publish', 'bulk'] } })],
    ['empty triggers', JSON.stringify({ ...completed(), last: { ...completed().last, triggers: [] } })],
    ['persisted beforeBoot', JSON.stringify({ ...completed(), last: { ...completed().last, beforeBoot: false } })],
    ['invalid running', JSON.stringify({ ...completed(), running: { attemptId, startedAt, triggers: ['publish'], queued: true } })],
  ])('rejects %s without substituting live success for missing history', async (_name, contents) => {
    await writeFile(join(root, 'build-state.json'), contents);
    await symlink(join(root, 'releases', attemptId), join(root, 'current'));
    const state = createBuildState(root, {});
    expect(await state.status(false)).toEqual({ live: { release: attemptId, stampedAt: startedAt }, running: null, last: null, record: 'unreadable' });
    await state.status(false);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('refuses a symlink record rather than reading another file', async () => {
    await writeFile(join(root, 'target'), JSON.stringify(completed()));
    await symlink(join(root, 'target'), join(root, 'build-state.json'));
    expect(await createBuildState(root, {}).status(false)).toMatchObject({ record: 'unreadable', last: null });
  });

  it('refuses a directory as a record', async () => {
    await mkdir(join(root, 'build-state.json'));
    expect(await createBuildState(root, {}).status(false)).toMatchObject({ record: 'unreadable', last: null });
  });

  it('sweeps only record temporary files at the next owned start', async () => {
    await writeFile(join(root, 'build-state.json.42.tmp'), 'partial');
    await writeFile(join(root, 'build-state.json.keep.tmp'), 'not ours');
    await mkdir(join(root, 'manifests'));
    await writeFile(join(root, 'manifests', 'evidence.json'), 'future independent evidence');
    const state = createBuildState(root, {});
    await state.start({ attemptId, startedAt, triggers: ['boot'] });
    expect(await readdir(root)).not.toContain('build-state.json.42.tmp');
    expect(await readFile(join(root, 'build-state.json.keep.tmp'), 'utf8')).toBe('not ours');
    expect(await readFile(join(root, 'manifests', 'evidence.json'), 'utf8')).toBe('future independent evidence');
    expect(JSON.parse(await readFile(join(root, 'build-state.json'), 'utf8')).running.attemptId).toBe(attemptId);
  });

  it('does not clean stale temporary files or replace state after ownership is lost', async () => {
    await writeFile(join(root, 'build-state.json.42.tmp'), 'partial');
    const contents = JSON.stringify(completed());
    await writeFile(join(root, 'build-state.json'), contents);
    let writable = true;
    const state = createBuildState(root, { isWritable: () => writable });
    await state.initialize();
    writable = false;
    await state.start({ attemptId, startedAt, triggers: ['boot'] });
    expect(await state.status(false)).toMatchObject({ record: 'not_persisted' });
    expect(await readFile(join(root, 'build-state.json'), 'utf8')).toBe(contents);
    expect(await readFile(join(root, 'build-state.json.42.tmp'), 'utf8')).toBe('partial');
  });
});

describe('independent live observation', () => {
  it('observes every change rather than deriving current from attempt history', async () => {
    const state = createBuildState(root, {});
    expect((await state.status(false)).live).toBeNull();
    await symlink(`releases/${attemptId}`, join(root, 'current'));
    expect((await state.status(false)).live).toEqual({ release: attemptId, stampedAt: startedAt });
    await unlink(join(root, 'current'));
    const rolledBack = '1780000000000-456-0000';
    await symlink(join(root, 'releases', rolledBack), join(root, 'current'));
    expect(await state.status(false)).toMatchObject({ live: { release: rolledBack }, last: null, record: 'missing' });
    await unlink(join(root, 'current'));
    await writeFile(join(root, 'current'), 'not a link');
    expect(await observeLiveRelease(root)).toBeUndefined();
    expect(await state.status(false)).not.toHaveProperty('live');
  });

  it.each(['../elsewhere/1790000000000-123-0001', 'releases/not-a-stamp', '/tmp/1790000000000-123-0001'])('rejects invalid target %s', async (target) => {
    await symlink(target, join(root, 'current'));
    expect(await observeLiveRelease(root)).toBeUndefined();
  });
});
