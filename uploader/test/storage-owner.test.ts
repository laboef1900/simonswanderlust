import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireStorageOwner, APP_SESSION_PREFIX, STORAGE_OWNER_LOCK_KEY, StorageReadOnlyError, type StorageOwner } from '../src/storage-owner.js';

const mock = vi.hoisted(() => ({
  construct: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(),
  clients: [] as EventEmitter[],
}));
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  // This mock factory is hoisted before static imports initialize; load the
  // EventEmitter here to exercise the pg module boundary without real sockets.
  return { default: { Client: class extends EventEmitter {
    constructor(config: unknown) { super(); mock.construct(config); mock.clients.push(this); }
    connect() { return mock.connect(); }
    query(...args: unknown[]) { return mock.query(...args); }
    async end() { await mock.end(); this.emit('end'); }
  } } };
});

const databaseUrl = 'postgres://synthetic:PRIVATE_PASSWORD@localhost/synthetic';
let owner: StorageOwner | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mock.clients.length = 0;
  mock.connect.mockResolvedValue(undefined);
  mock.query.mockResolvedValue({ rows: [{ acquired: true }] });
  mock.end.mockResolvedValue(undefined);
});
afterEach(async () => {
  await owner?.close().catch(() => {});
  owner = undefined;
  vi.useRealTimers();
});

describe('dedicated storage ownership', () => {
  it('uses a reserved two-int nonwaiting lock and overrides URL session tags and deadlines', async () => {
    owner = await acquireStorageOwner(databaseUrl + '?application_name=hidden&query_timeout=0&statement_timeout=0', { role: 'app' });
    expect(owner.applicationName.startsWith(APP_SESSION_PREFIX)).toBe(true);
    expect(Buffer.byteLength(owner.applicationName + ':build')).toBeLessThanOrEqual(63);
    expect(mock.construct).toHaveBeenCalledOnce();
    const config = mock.construct.mock.calls[0]![0] as {
      connectionString: string; application_name: string; connectionTimeoutMillis: number;
      query_timeout: number; statement_timeout: number;
    };
    expect(config.application_name).toBe(owner.applicationName);
    const url = new URL(config.connectionString);
    expect(url.searchParams.get('application_name')).toBe(owner.applicationName);
    expect(config.query_timeout).toBe(5_000);
    expect(config.statement_timeout).toBe(5_000);
    expect(config.connectionTimeoutMillis).toBe(5_000);
    expect(url.searchParams.get('query_timeout')).toBe('5000');
    expect(url.searchParams.get('statement_timeout')).toBe('5000');
    expect(mock.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired', [...STORAGE_OWNER_LOCK_KEY],
    );
    expect(owner.isWritable()).toBe(true);
    expect(() => owner!.assertWritable()).not.toThrow();
  });

  it.each(['app', 'restore'] as const)('refuses a second %s owner immediately without retry', async (role) => {
    mock.query.mockResolvedValue({ rows: [{ acquired: false }] });
    await expect(acquireStorageOwner(databaseUrl, { role })).rejects.toMatchObject({
      name: 'StorageReadOnlyError', code: 'storage_read_only', statusCode: 503,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.query).toHaveBeenCalledOnce();
    expect(mock.connect).toHaveBeenCalledOnce();
    expect(mock.end).toHaveBeenCalledOnce();
  });

  it.each(['error', 'end'])('latches synchronously on %s and never reacquires', async (event) => {
    owner = await acquireStorageOwner(databaseUrl, { role: 'app' });
    const aborted = vi.fn();
    owner.signal.addEventListener('abort', aborted);
    mock.clients[0]!.emit(event, new Error('PRIVATE_PASSWORD raw failure'));
    expect(owner.isWritable()).toBe(false);
    expect(owner.signal.aborted).toBe(true);
    expect(owner.signal.reason).toBeInstanceOf(StorageReadOnlyError);
    expect(String(owner.signal.reason)).not.toContain('PRIVATE_PASSWORD');
    expect(() => owner!.assertWritable()).toThrow(StorageReadOnlyError);
    mock.clients[0]!.emit('error', new Error('second failure'));
    mock.clients[0]!.emit('end');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(aborted).toHaveBeenCalledOnce();
    expect(mock.query).toHaveBeenCalledOnce();
    expect(mock.connect).toHaveBeenCalledOnce();
    expect(mock.end).toHaveBeenCalledOnce();
  });

  it('never overlaps heartbeat probes and latches on a timed-out probe', async () => {
    owner = await acquireStorageOwner(databaseUrl, { role: 'app' });
    const probe = Promise.withResolvers<unknown>();
    mock.query.mockImplementationOnce(() => probe.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.query).toHaveBeenLastCalledWith('SELECT 1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mock.query).toHaveBeenCalledTimes(2);
    probe.reject(new Error('Query read timeout PRIVATE_PASSWORD'));
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.signal.aborted).toBe(true);
    expect(owner.isWritable()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.query).toHaveBeenCalledTimes(2);
    expect(mock.end).toHaveBeenCalledOnce();
  });

  it('schedules a later heartbeat only after the previous successful probe', async () => {
    owner = await acquireStorageOwner(databaseUrl, { role: 'app' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mock.query).toHaveBeenCalledTimes(4);
    expect(owner.isWritable()).toBe(true);
  });

  it('deliberate close releases once without reporting lease loss, including a late query failure', async () => {
    owner = await acquireStorageOwner(databaseUrl, { role: 'app' });
    const probe = Promise.withResolvers<unknown>();
    mock.query.mockImplementationOnce(() => probe.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    const close = owner.close();
    expect(owner.isWritable()).toBe(false);
    probe.reject(new Error('connection closed'));
    await Promise.all([close, owner.close()]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(owner.signal.aborted).toBe(false);
    expect(() => owner!.assertWritable()).toThrow(StorageReadOnlyError);
    expect(mock.end).toHaveBeenCalledOnce();
    expect(mock.query).toHaveBeenCalledTimes(2);
  });

  it('refuses draining app sessions without terminating them or losing restore ownership', async () => {
    owner = await acquireStorageOwner(databaseUrl, { role: 'restore' });
    expect(owner.applicationName.startsWith(APP_SESSION_PREFIX)).toBe(false);
    expect(Buffer.byteLength(owner.applicationName + ':backup')).toBeLessThanOrEqual(63);
    mock.query.mockResolvedValueOnce({ rows: [{ present: true }] });
    await expect(owner.assertNoAppSessions()).rejects.toBeInstanceOf(StorageReadOnlyError);
    expect(mock.query).toHaveBeenLastCalledWith(expect.stringContaining('datname = current_database()'), [APP_SESSION_PREFIX]);
    expect(mock.query).toHaveBeenLastCalledWith(expect.stringContaining('starts_with(application_name, $1)'), [APP_SESSION_PREFIX]);
    expect(owner.isWritable()).toBe(true);
    expect(owner.signal.aborted).toBe(false);
    mock.query.mockResolvedValueOnce({ rows: [{ present: false }] });
    await expect(owner.assertNoAppSessions()).resolves.toBeUndefined();
    expect(mock.query.mock.calls.some(([sql]) => String(sql).includes('pg_terminate_backend'))).toBe(false);
  });

  it('fails closed on a malformed session result and latches on a session-check query failure', async () => {
    owner = await acquireStorageOwner(databaseUrl, { role: 'restore' });
    mock.query.mockResolvedValueOnce({ rows: [] });
    await expect(owner.assertNoAppSessions()).rejects.toBeInstanceOf(StorageReadOnlyError);
    mock.query.mockRejectedValueOnce(new Error('PRIVATE_PASSWORD database detail'));
    await expect(owner.assertNoAppSessions()).rejects.toThrow(StorageReadOnlyError);
    expect(owner.signal.aborted).toBe(true);
    const calls = mock.query.mock.calls.length;
    await expect(owner.assertNoAppSessions()).rejects.toThrow(StorageReadOnlyError);
    expect(mock.query).toHaveBeenCalledTimes(calls);
  });

  it.each(['connect', 'query'] as const)('sanitizes %s failures and closes the dedicated session', async (method) => {
    mock[method].mockRejectedValueOnce(new Error('PRIVATE_PASSWORD database detail'));
    const error = await acquireStorageOwner(databaseUrl, { role: 'app' }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(StorageReadOnlyError);
    expect(String(error)).not.toContain('PRIVATE_PASSWORD');
    expect(error).not.toHaveProperty('cause');
    expect(mock.end).toHaveBeenCalledOnce();
  });

  it('cannot admit a lease lost while lock acquisition is completing', async () => {
    mock.query.mockImplementationOnce(async () => {
      mock.clients[0]!.emit('error', new Error('lost during acquisition'));
      return { rows: [{ acquired: true }] };
    });
    await expect(acquireStorageOwner(databaseUrl, { role: 'app' })).rejects.toThrow(StorageReadOnlyError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.query).toHaveBeenCalledOnce();
    expect(mock.end).toHaveBeenCalledOnce();
  });

  it('sanitizes invalid connection strings before constructing a client', async () => {
    await expect(acquireStorageOwner('PRIVATE_PASSWORD not a URL', { role: 'app' })).rejects.toThrow(StorageReadOnlyError);
    expect(mock.construct).not.toHaveBeenCalled();
  });
});
