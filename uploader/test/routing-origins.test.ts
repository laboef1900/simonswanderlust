import { describe, expect, it } from 'vitest';
import { parseRoutingInternalOrigins, routingEndpointUsable } from '../src/routing-origins.js';

describe('parseRoutingInternalOrigins', () => {
  it('treats unset or blank as no exemption', () => {
    expect(parseRoutingInternalOrigins(undefined).entries).toEqual([]);
    expect(parseRoutingInternalOrigins('  ').has('http://osrm:5100')).toBe(false);
  });

  it('normalizes each entry to its exact origin', () => {
    expect(parseRoutingInternalOrigins(' http://osrm-car:5000 ,http://OSRM-Bike:5000/,https://osrm.lan:443').entries)
      .toEqual(['http://osrm-car:5000', 'http://osrm-bike:5000', 'https://osrm.lan']);
  });

  it('admits a port range on exactly one host and scheme, inclusive at both ends', () => {
    const internal = parseRoutingInternalOrigins('http://OSRM:5100-5999');
    expect(internal.entries).toEqual(['http://osrm:5100-5999']);
    for (const origin of ['http://osrm:5100', 'http://osrm:5555', 'http://osrm:5999']) expect(internal.has(origin), origin).toBe(true);
    for (const origin of ['http://osrm:5099', 'http://osrm:6000', 'https://osrm:5100', 'http://osrm2:5100', 'http://db:5432', 'http://osrm'])
      expect(internal.has(origin), origin).toBe(false);
  });

  it.each([
    'http://osrm-car:5000/route', 'http://osrm-car:5000?x=1', 'http://osrm-car:5000#f', 'http://u:p@osrm-car:5000',
    'ftp://osrm-car', 'osrm-car:5000', 'http://osrm-car:5000,', 'not a url',
    'http://osrm:5999-5100', 'http://osrm:0-80', 'http://osrm:5100-70000', 'http://*:5100-5999', 'http://osrm:5100-5999/x',
  ])('refuses to start on %s, naming the entry without echoing it', (raw) => {
    expect(() => parseRoutingInternalOrigins(raw)).toThrow(/^ROUTING_INTERNAL_ORIGINS entry \d+ must be an http\(s\) origin/);
  });
});

describe('routingEndpointUsable', () => {
  const internal = parseRoutingInternalOrigins('http://osrm-car:5000,http://osrm:5100-5999');
  it.each([
    ['https://routing.example/routed-car', true],
    ['http://osrm-car:5000', true],
    ['http://osrm-car:5000/prefix', true],
    ['http://osrm-car:5001', false],
    ['http://routing.example', false],
    ['http://osrm:5103', true],
    ['http://osrm:6000', false],
    ['', false],
  ])('%s → %s', (url, usable) => {
    expect(routingEndpointUsable(url, internal)).toBe(usable);
  });
});
