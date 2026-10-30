import { describe, expect, it, vi } from 'vitest';
import { parseDefaultGateway, resolveTrustPolicy } from '../src/trusted-proxy.js';
import { ROUTES } from './trusted-proxy-fixture.js';

describe('parseDefaultGateway', () => {
  it('decodes the little-endian gateway and allows duplicate agreeing defaults', () => {
    expect(parseDefaultGateway(ROUTES)).toBe('172.18.0.1');
    expect(parseDefaultGateway(ROUTES + 'eth1 00000000 010012AC 0003 0 0 0 00000000\n')).toBe('172.18.0.1');
  });
  it.each([
    '', 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT',
    ROUTES.replace('00000000 010012AC', '000012AC 010012AC'),
    ROUTES.replace('010012AC 0003', '010012AC 0002'),
    ROUTES.replace('010012AC 0003', '010012AC 0001'),
    ROUTES.replace('010012AC', 'invalid!'),
    ROUTES.replace('010012AC', '010012A'),
    ROUTES + 'eth1 00000000 010013AC 0003 0 0 0 00000000\n',
    ROUTES + 'eth1 00000000 broken 0003 0 0 0 00000000\n',
  ])('refuses an absent, ambiguous or malformed default (%s)', (routes) => {
    expect(parseDefaultGateway(routes)).toBeNull();
  });
});

describe('resolveTrustPolicy', () => {
  it.each([undefined, 'loopback'])('uses loopback without route discovery for %s', (mode) => {
    const readRoute = vi.fn(() => ROUTES);
    const policy = resolveTrustPolicy(mode, readRoute);
    expect(readRoute).not.toHaveBeenCalled();
    expect(policy.describe).toBe('loopback');
    expect(policy.trust('127.0.0.5', 0)).toBe(true);
    expect(policy.trust('::1', 0)).toBe(true);
    expect(policy.trust('::ffff:127.0.0.1', 0)).toBe(true);
    expect(policy.trust('172.18.0.1', 0)).toBe(false);
  });
  it.each(['', '1', 'true', 'bogus', '172.18.0.0/16'])('rejects explicit invalid mode %j', (mode) => {
    expect(() => resolveTrustPolicy(mode, () => ROUTES)).toThrow('TRUSTED_PROXY');
  });
  it('refuses unreadable and ambiguous gateway discovery without leaking the raw failure', () => {
    expect(() => resolveTrustPolicy('docker-gateway', () => '')).toThrow('TRUSTED_PROXY');
    expect(() => resolveTrustPolicy('docker-gateway', () => { throw new Error('private detail'); }))
      .toThrow('TRUSTED_PROXY=docker-gateway cannot read /proc/net/route.');
  });
  it('trusts only immediate loopback and gateway peers, including mapped IPv4', () => {
    const policy = resolveTrustPolicy('docker-gateway', () => ROUTES);
    expect(policy.describe).toBe('loopback, 172.18.0.1 (container default gateway)');
    const trusted = ['127.0.0.5', '::1', '::ffff:127.0.0.1', '172.18.0.1', '::ffff:172.18.0.1'];
    const untrusted = ['172.18.0.3', '203.0.113.9', undefined, 'not-an-ip'];
    for (const address of trusted) expect(policy.trust(address, 0)).toBe(true);
    for (const address of untrusted) expect(policy.trust(address, 0)).toBe(false);
    for (const address of [...trusted, ...untrusted]) {
      for (const hop of [1, 2, 10]) expect(policy.trust(address, hop)).toBe(false);
    }
  });
});
