import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { loaderPool } from './loader-pool';

// A "Postgres" that accepts the TCP connection and then never says a word —
// the dropped-packets shape of #110, which a refused connection does not
// reproduce (pg fails that one immediately on its own).
let server: Server | undefined;
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  if (server) { server.close(); await once(server, 'close'); }
  server = undefined;
});

describe('loaderPool', () => {
  it('fails fast against a Postgres that accepts the connection and never answers', async () => {
    server = createServer((socket) => { sockets.add(socket); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    // Real clock on purpose: pg's connection timer runs against a real socket.
    const pool = loaderPool(`postgres://u:p@127.0.0.1:${address.port}/db`, { connectTimeoutMs: 200, queryTimeoutMs: 200 });
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
    } finally {
      await pool.end();
    }
  });
});
