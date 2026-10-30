import { resolveTrustPolicy } from '../src/trusted-proxy.js';

// Linux bridge route-table format; no dependency on the test host's network.
export const ROUTES = `Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
eth0 00000000 010012AC 0003 0 0 0 00000000 0 0 0
eth0 000012AC 00000000 0001 0 0 0 0000FFFF 0 0 0
`;
export const TEST_TRUST = resolveTrustPolicy(undefined, () => { throw new Error('Loopback must not read routes'); }).trust;
export const GATEWAY_TRUST = resolveTrustPolicy('docker-gateway', () => ROUTES).trust;
