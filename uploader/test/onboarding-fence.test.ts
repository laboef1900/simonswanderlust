import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import { publishRestoreFence, readRestoreFence, RESTORE_FENCE_PAYLOAD, restoreFencePath, validateDataRoot } from '../src/onboarding-fence.js';

// Inject failures at real filesystem boundaries, not a simulated fence store. All
// successful opens, reads, flushes, links and unlinks still reach the filesystem.
const hooks = vi.hoisted(() => ({
  events: [] as string[],
  beforeOpen: undefined as ((path: string) => void) | undefined,
  beforeSync: undefined as ((path: string) => void) | undefined,
  afterSync: undefined as ((path: string) => void) | undefined,
  beforeLink: undefined as ((from: string, to: string) => Promise<void>) | undefined,
  afterLink: undefined as (() => void) | undefined,
  beforeUnlink: undefined as (() => void) | undefined,
  readError: undefined as Error | undefined,
  statError: undefined as Error | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const path = String(args[0]);
      hooks.beforeOpen?.(path);
      const handle = await fs.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        hooks.events.push(`sync:start:${path}`);
        hooks.beforeSync?.(path);
        await sync();
        hooks.afterSync?.(path);
        hooks.events.push(`sync:done:${path}`);
      });
      if (hooks.readError) vi.spyOn(handle, 'read').mockRejectedValueOnce(hooks.readError);
      if (hooks.statError) vi.spyOn(handle, 'stat').mockRejectedValueOnce(hooks.statError);
      return handle;
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      await hooks.beforeLink?.(String(args[0]), String(args[1]));
      hooks.events.push('link:start');
      await fs.link(...args);
      hooks.afterLink?.();
      hooks.events.push('link:done');
    },
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      hooks.beforeUnlink?.();
      await fs.unlink(...args);
      hooks.events.push('unlink:done');
    },
  };
});

const PAYLOAD = 'swl-onboarding-restore-retired-v1\n';
const NAME = 'onboarding.restore-retired';
let root: string;
let storage: string;
let final: string;

beforeEach(async () => {
  // macOS tmpdir can have a symlink ancestor; the tested root must be real.
  root = await realpath(await mkdtemp(join(tmpdir(), 'onboarding-fence-')));
  storage = join(root, 'images');
  final = join(root, NAME);
});
afterEach(async () => {
  hooks.beforeOpen = undefined;
  hooks.beforeSync = undefined;
  hooks.afterSync = undefined;
  hooks.beforeLink = undefined;
  hooks.afterLink = undefined;
  hooks.beforeUnlink = undefined;
  hooks.readError = undefined;
  hooks.statError = undefined;
  hooks.events.length = 0;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function owner() { return vi.fn(async () => {}); }
function ioError() { return Object.assign(new Error('injected filesystem failure'), { code: 'EIO' }); }
async function temporary(): Promise<string> {
  const names = (await readdir(root)).filter(name => name.startsWith(`${NAME}.part-`));
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^onboarding\.restore-retired\.part-[a-f0-9]{32}$/);
  return join(root, names[0]!);
}

// No authentication, database, content or process lifecycle is mocked here.
describe('restore fence format and validation', () => {
  it('derives the fixed sibling path from resolved storage, without a separate configured path', () => {
    expect(RESTORE_FENCE_PAYLOAD).toBe(PAYLOAD);
    expect(restoreFencePath(storage)).toBe(final);
    expect(restoreFencePath(join(root, 'unused', '..', 'images'))).toBe(final);
    expect(restoreFencePath(relative(process.cwd(), storage))).toBe(final);
    expect(restoreFencePath(join(root, 'nested', 'photos'))).toBe(join(root, 'nested', NAME));
  });

  it('distinguishes missing root and missing final from a valid fence without creating anything', async () => {
    await expect(readRestoreFence(join(root, 'missing', 'images'))).resolves.toBe(false);
    await expect(readRestoreFence(storage)).resolves.toBe(false);
    expect(await readdir(root)).toEqual([]);
    await writeFile(final, PAYLOAD);
    await expect(readRestoreFence(storage)).resolves.toBe(true);
    expect(hooks.events).toEqual([]);
  });

  it.each(['', 'swl-onboarding-restore-retired-v1', 'swl-onboarding-restore-retired-v2\n', `${PAYLOAD}\n`, 'x'.repeat(PAYLOAD.length)])(
    'rejects malformed payload %j and preserves its exact bytes on read and publish', async payload => {
      await writeFile(final, payload);
      const before = await lstat(final);
      await expect(readRestoreFence(storage)).rejects.toThrow(/Invalid onboarding retirement fence/);
      await expect(publishRestoreFence(storage, owner())).rejects.toThrow(/Invalid onboarding retirement fence/);
      expect(await readFile(final, 'utf8')).toBe(payload);
      expect((await lstat(final)).ino).toBe(before.ino);
      expect(await readdir(root)).toEqual([NAME]);
    },
  );

  it('refuses a directory final and preserves its diagnostic contents', async () => {
    await mkdir(final);
    await writeFile(join(final, 'evidence'), 'do not replace');
    await expect(readRestoreFence(storage)).rejects.toThrow();
    await expect(publishRestoreFence(storage, owner())).rejects.toThrow();
    expect(await readFile(join(final, 'evidence'), 'utf8')).toBe('do not replace');
  });

  it.each([false, true])('refuses a symlink final, including dangling=%s, without following or replacing it', async dangling => {
    const target = join(root, 'target');
    if (!dangling) await writeFile(target, PAYLOAD);
    await symlink(target, final);
    await expect(readRestoreFence(storage)).rejects.toThrow();
    await expect(publishRestoreFence(storage, owner())).rejects.toThrow();
    expect((await lstat(final)).isSymbolicLink()).toBe(true);
    expect(await readlink(final)).toBe(target);
    if (!dangling) expect(await readFile(target, 'utf8')).toBe(PAYLOAD);
    else await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a valid-payload hardlinked final without removing either name', async () => {
    const alias = join(root, 'original-marker');
    await writeFile(alias, PAYLOAD);
    await link(alias, final);
    await expect(readRestoreFence(storage)).rejects.toThrow(/Invalid onboarding retirement fence/);
    await expect(publishRestoreFence(storage, owner())).rejects.toThrow(/Invalid onboarding retirement fence/);
    expect((await lstat(final)).nlink).toBe(2);
    expect(await readFile(alias, 'utf8')).toBe(PAYLOAD);
    expect(await readdir(root)).toEqual(expect.arrayContaining([NAME, 'original-marker']));
  });

  it.each(['open', 'stat', 'read'] as const)('propagates %s errors rather than interpreting them as absence', async phase => {
    await writeFile(final, PAYLOAD);
    const error = ioError();
    if (phase === 'open') hooks.beforeOpen = path => { if (path === final) throw error; };
    if (phase === 'stat') hooks.statError = error;
    if (phase === 'read') hooks.readError = error;
    await expect(readRestoreFence(storage)).rejects.toBe(error);
    await expect(publishRestoreFence(storage, owner())).rejects.toBe(error);
    expect(await readFile(final, 'utf8')).toBe(PAYLOAD);
    expect(await readdir(root)).toEqual([NAME]);
  });

  it('does not treat even a complete temporary file as retirement', async () => {
    const abandoned = `${final}.part-${'a'.repeat(32)}`;
    await writeFile(abandoned, PAYLOAD, { mode: 0o600 });
    await expect(readRestoreFence(storage)).resolves.toBe(false);
    await publishRestoreFence(storage, owner());
    await expect(readRestoreFence(storage)).resolves.toBe(true);
    expect(await readFile(abandoned, 'utf8')).toBe(PAYLOAD);
    expect(await readFile(final, 'utf8')).toBe(PAYLOAD);
    expect((await lstat(final)).nlink).toBe(1);
  });
});

describe('restore fence durable publication', () => {
  it('flushes a private complete temp before no-clobber publication and flushes final plus directory before success', async () => {
    let temp = '';
    hooks.beforeLink = async (from, to) => {
      temp = from;
      expect(to).toBe(final);
      expect(await readFile(from, 'utf8')).toBe(PAYLOAD);
      expect((await lstat(from)).mode & 0o777).toBe(0o600);
      expect(hooks.events).toEqual([`sync:start:${from}`, `sync:done:${from}`]);
      await expect(lstat(final)).rejects.toMatchObject({ code: 'ENOENT' });
    };
    await expect(publishRestoreFence(storage, owner())).resolves.toBeUndefined();
    expect(hooks.events).toEqual([
      `sync:start:${temp}`, `sync:done:${temp}`, 'link:start', 'link:done', 'unlink:done',
      `sync:start:${final}`, `sync:done:${final}`, `sync:start:${root}`, `sync:done:${root}`,
    ]);
    expect(await readdir(root)).toEqual([NAME]);
    expect(await readFile(final, 'utf8')).toBe(PAYLOAD);
    expect((await lstat(final)).mode & 0o777).toBe(0o600);
    expect((await lstat(final)).nlink).toBe(1);
  });

  it('revalidates and reflushes an existing final on every retry without replacing it', async () => {
    await writeFile(final, PAYLOAD, { mode: 0o600 });
    const inode = (await lstat(final)).ino;
    for (let attempt = 0; attempt < 2; attempt++) {
      hooks.events.length = 0;
      await publishRestoreFence(storage, owner());
      expect(hooks.events).toEqual([
        `sync:start:${final}`, `sync:done:${final}`, `sync:start:${root}`, `sync:done:${root}`,
      ]);
      expect((await lstat(final)).ino).toBe(inode);
      expect(await readdir(root)).toEqual([NAME]);
    }
  });

  it.each(['before', 'after'] as const)('does not report success when temp file sync fails %s its actual flush', async timing => {
    const error = ioError();
    const fail = (path: string) => { if (path.startsWith(`${final}.part-`)) throw error; };
    if (timing === 'before') hooks.beforeSync = fail;
    else hooks.afterSync = fail;
    await expect(publishRestoreFence(storage, owner())).rejects.toBe(error);
    expect(await readFile(await temporary(), 'utf8')).toBe(PAYLOAD);
    await expect(readRestoreFence(storage)).resolves.toBe(false);
    expect(hooks.events).not.toContain('link:start');
    hooks.beforeSync = undefined;
    hooks.afterSync = undefined;
    await publishRestoreFence(storage, owner());
    await expect(readRestoreFence(storage)).resolves.toBe(true);
  });

  it.each([
    ['final', 'before'], ['final', 'after'], ['directory', 'before'], ['directory', 'after'],
  ] as const)('rejects uncertain %s durability %s flush, retains the final, and retries both flushes', async (target, timing) => {
    const error = ioError();
    const fail = (path: string) => { if (path === (target === 'final' ? final : root)) throw error; };
    if (timing === 'before') hooks.beforeSync = fail;
    else hooks.afterSync = fail;
    await expect(publishRestoreFence(storage, owner())).rejects.toBe(error);
    expect(await readFile(final, 'utf8')).toBe(PAYLOAD);
    expect((await lstat(final)).nlink).toBe(1);
    const inode = (await lstat(final)).ino;
    hooks.beforeSync = undefined;
    hooks.afterSync = undefined;
    hooks.events.length = 0;
    await publishRestoreFence(storage, owner());
    expect(hooks.events).toEqual([
      `sync:start:${final}`, `sync:done:${final}`, `sync:start:${root}`, `sync:done:${root}`,
    ]);
    expect((await lstat(final)).ino).toBe(inode);
  });

  it('refuses an existing final whose directory cannot be opened for durability', async () => {
    await writeFile(final, PAYLOAD);
    const error = ioError();
    hooks.beforeOpen = path => { if (path === root) throw error; };
    await expect(publishRestoreFence(storage, owner())).rejects.toBe(error);
    expect(await readFile(final, 'utf8')).toBe(PAYLOAD);
    hooks.beforeOpen = undefined;
    await expect(publishRestoreFence(storage, owner())).resolves.toBeUndefined();
  });

  it.each(['link acknowledgement', 'temporary unlink'] as const)('preserves both names and fails closed after uncertain %s', async boundary => {
    const error = ioError();
    if (boundary === 'link acknowledgement') hooks.afterLink = () => { throw error; };
    else hooks.beforeUnlink = () => { throw error; };
    await expect(publishRestoreFence(storage, owner())).rejects.toBe(error);
    const temp = await temporary();
    expect(await readFile(temp, 'utf8')).toBe(PAYLOAD);
    expect(await readFile(final, 'utf8')).toBe(PAYLOAD);
    expect((await lstat(temp)).ino).toBe((await lstat(final)).ino);
    expect((await lstat(final)).nlink).toBe(2);
    hooks.afterLink = undefined;
    hooks.beforeUnlink = undefined;
    // A two-link final requires operator repair, not automatic evidence deletion.
    await expect(readRestoreFence(storage)).rejects.toThrow(/Invalid onboarding retirement fence/);
    await expect(publishRestoreFence(storage, owner())).rejects.toThrow(/Invalid onboarding retirement fence/);
    expect((await lstat(final)).nlink).toBe(2);
    expect(await readFile(temp, 'utf8')).toBe(PAYLOAD);
  });

  it.each([PAYLOAD, 'corrupt concurrent marker'])('never clobbers a final published between inspection and link: %j', async payload => {
    let inode: number | undefined;
    hooks.beforeLink = async (_from, to) => {
      await writeFile(to, payload, { flag: 'wx', mode: 0o600 });
      inode = (await lstat(to)).ino;
    };
    const publication = publishRestoreFence(storage, owner());
    if (payload === PAYLOAD) await expect(publication).resolves.toBeUndefined();
    else await expect(publication).rejects.toThrow(/Invalid onboarding retirement fence/);
    expect(await readFile(final, 'utf8')).toBe(payload);
    expect((await lstat(final)).ino).toBe(inode);
    expect((await lstat(final)).nlink).toBe(1);
  });
});

describe('restore fence ownership and data root', () => {
  it('refuses initial owner loss without creating a missing data root', async () => {
    const error = new Error('storage_read_only');
    await expect(publishRestoreFence(join(root, 'absent', 'images'), async () => { throw error; })).rejects.toBe(error);
    expect(await readdir(root)).toEqual([]);
  });

  it('rechecks ownership after flushing the temp and before final publication', async () => {
    const error = new Error('storage_read_only');
    const assertOwner = owner().mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw error; });
    await expect(publishRestoreFence(storage, assertOwner)).rejects.toBe(error);
    expect(await readFile(await temporary(), 'utf8')).toBe(PAYLOAD);
    await expect(readRestoreFence(storage)).resolves.toBe(false);
    expect(hooks.events).not.toContain('link:start');
  });

  it.each([false, true])('retains durable retirement but reports failure on final owner loss (existing=%s)', async existing => {
    if (existing) await writeFile(final, PAYLOAD);
    const error = new Error('storage_read_only');
    const assertOwner = vi.fn(async () => {
      if (hooks.events.includes(`sync:done:${root}`)) throw error;
    });
    await expect(publishRestoreFence(storage, assertOwner)).rejects.toBe(error);
    await expect(readRestoreFence(storage)).resolves.toBe(true);
    expect(await readFile(final, 'utf8')).toBe(PAYLOAD);
  });

  it('creates only the configured data-root ancestors and flushes their parents before publication', async () => {
    const nested = join(root, 'new', 'data');
    await publishRestoreFence(join(nested, 'photos'), owner());
    expect((await lstat(nested)).isDirectory()).toBe(true);
    expect(await readdir(nested)).toEqual([NAME]);
    expect(hooks.events.indexOf(`sync:done:${root}`)).toBeLessThan(hooks.events.indexOf('link:start'));
    expect(hooks.events.indexOf(`sync:done:${join(root, 'new')}`)).toBeLessThan(hooks.events.indexOf('link:start'));
    expect(hooks.events.at(-1)).toBe(`sync:done:${nested}`);
  });

  it('refuses an uncertain parent flush while creating the data root without publishing a fence', async () => {
    const error = ioError();
    const nested = join(root, 'new');
    hooks.beforeSync = path => { if (path === root) throw error; };
    await expect(publishRestoreFence(join(nested, 'images'), owner())).rejects.toBe(error);
    expect(await readdir(nested)).toEqual([]);
    expect(hooks.events).not.toContain('link:start');
  });

  it.each(['root', 'ancestor'] as const)('refuses a symlink %s and never touches its destination', async level => {
    const target = join(root, 'real');
    await mkdir(join(target, 'nested'), { recursive: true });
    const linked = join(root, 'linked');
    await symlink(target, linked);
    const unsafeStorage = join(linked, ...(level === 'ancestor' ? ['nested', 'images'] : ['images']));
    await expect(validateDataRoot(unsafeStorage, true)).rejects.toThrow(/Unsafe recovery data root/);
    await expect(readRestoreFence(unsafeStorage)).rejects.toThrow(/Unsafe recovery data root/);
    await expect(publishRestoreFence(unsafeStorage, owner())).rejects.toThrow(/Unsafe recovery data root/);
    expect(await readdir(target)).toEqual(['nested']);
    expect(await readdir(join(target, 'nested'))).toEqual([]);
    expect(await readlink(linked)).toBe(target);
  });

  it('refuses a regular file as data root without changing its bytes', async () => {
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'preserved');
    await expect(validateDataRoot(join(file, 'images'), true)).rejects.toThrow(/Unsafe recovery data root/);
    await expect(readRestoreFence(join(file, 'images'))).rejects.toThrow(/Unsafe recovery data root/);
    await expect(publishRestoreFence(join(file, 'images'), owner())).rejects.toThrow(/Unsafe recovery data root/);
    expect(await readFile(file, 'utf8')).toBe('preserved');
  });

  it('refuses filesystem root as the data root before any file operation', async () => {
    const unsafeStorage = resolve('/', 'images');
    await expect(validateDataRoot(unsafeStorage, true)).rejects.toThrow(/Refusing filesystem root/);
    await expect(readRestoreFence(unsafeStorage)).rejects.toThrow(/Refusing filesystem root/);
    await expect(publishRestoreFence(unsafeStorage, owner())).rejects.toThrow(/Refusing filesystem root/);
    expect(hooks.events).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });
});
