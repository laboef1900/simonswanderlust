import { describe, expect, it } from 'vitest';
import { createShutdown, type ShutdownHooks } from '../src/shutdown.js';

function harness(opts: { close?: () => Promise<unknown>; end?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const hooks: ShutdownHooks = {
    close: async () => { calls.push('close'); if (opts.close) await opts.close(); },
    end: async () => { calls.push('end'); if (opts.end) await opts.end(); },
    exit: (code) => { calls.push(`exit(${code})`); resolveExit(code); },
    log: (msg) => { logs.push(msg); },
    error: (msg, err) => { errors.push(`${msg} ${String(err)}`); },
  };
  return { calls, logs, errors, exited, onSignal: createShutdown(hooks) };
}

describe('createShutdown', () => {
  it('closes the server, ends the pool, then exits 0 — in that order', async () => {
    const h = harness();
    h.onSignal('SIGTERM');
    expect(await h.exited).toBe(0);
    expect(h.calls).toEqual(['close', 'end', 'exit(0)']);
    expect(h.logs).toEqual(['received SIGTERM, shutting down']);
    expect(h.errors).toEqual([]);
  });

  it('exits 1 without ending the pool when close() rejects', async () => {
    const h = harness({ close: async () => { throw new Error('close failed'); } });
    h.onSignal('SIGTERM');
    expect(await h.exited).toBe(1);
    expect(h.calls).toEqual(['close', 'exit(1)']);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('close failed');
  });

  it('exits 1 when end() rejects', async () => {
    const h = harness({ end: async () => { throw new Error('pool end failed'); } });
    h.onSignal('SIGINT');
    expect(await h.exited).toBe(1);
    expect(h.calls).toEqual(['close', 'end', 'exit(1)']);
    expect(h.errors).toHaveLength(1);
  });

  it('is idempotent: repeat signals never re-run the sequence', async () => {
    const h = harness();
    h.onSignal('SIGTERM');
    h.onSignal('SIGINT'); // second signal while shutdown is in flight
    expect(await h.exited).toBe(0);
    h.onSignal('SIGTERM'); // and one more after it finished
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(h.calls).toEqual(['close', 'end', 'exit(0)']);
    expect(h.logs).toHaveLength(1);
  });
});
