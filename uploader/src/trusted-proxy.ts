import { BlockList, isIP } from 'node:net';

export interface TrustPolicy {
  trust: (address: string | undefined, hop: number) => boolean;
  describe: string;
}

/** Linux exposes IPv4 route addresses as little-endian hexadecimal words. */
export function parseDefaultGateway(procNetRoute: string): string | null {
  let gateway: string | null = null;
  for (const line of procNetRoute.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== '00000000' || fields[7] !== '00000000') continue;
    const flags = fields[3];
    if (!flags || !/^[0-9a-f]+$/i.test(flags) || (Number.parseInt(flags, 16) & 3) !== 3) continue;
    const hex = fields[2];
    if (!hex || !/^[0-9a-f]{8}$/i.test(hex)) return null;
    const address = [6, 4, 2, 0].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join('.');
    if (gateway !== null && gateway !== address) return null;
    gateway = address;
  }
  return gateway;
}

/** Explicit topology only: never infer Docker from the presence of a route table. */
export function resolveTrustPolicy(mode: string | undefined, readRoute: () => string): TrustPolicy {
  if (mode !== undefined && mode !== 'loopback' && mode !== 'docker-gateway') {
    throw new Error('TRUSTED_PROXY must be loopback or docker-gateway when set.');
  }
  const list = new BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addAddress('::1', 'ipv6');
  let describe = 'loopback';
  if (mode === 'docker-gateway') {
    let routes: string;
    try {
      routes = readRoute();
    } catch {
      throw new Error('TRUSTED_PROXY=docker-gateway cannot read /proc/net/route.');
    }
    const gateway = parseDefaultGateway(routes);
    if (gateway === null) {
      throw new Error('TRUSTED_PROXY=docker-gateway requires one unambiguous default gateway.');
    }
    list.addAddress(gateway, 'ipv4');
    describe += `, ${gateway} (container default gateway)`;
  }
  return {
    describe,
    trust(address, hop) {
      if (hop !== 0 || address === undefined) return false;
      const family = isIP(address);
      return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}
