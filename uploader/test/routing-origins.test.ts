import { describe, expect, it } from 'vitest';
import { parseRoutingInternalOrigins, routingEndpointUsable } from '../src/routing-origins.js';

describe('parseRoutingInternalOrigins', () => {
  it('treats unset or blank as no exemption', () => {
    expect(parseRoutingInternalOrigins(undefined).size).toBe(0);
    expect(parseRoutingInternalOrigins('  ').size).toBe(0);
  });

  it('normalizes each entry to its exact origin', () => {
    expect([...parseRoutingInternalOrigins(' http://osrm-car:5000 ,http://OSRM-Bike:5000/,https://osrm.lan:443')])
      .toEqual(['http://osrm-car:5000', 'http://osrm-bike:5000', 'https://osrm.lan']);
  });

  it.each([
    'http://osrm-car:5000/route', 'http://osrm-car:5000?x=1', 'http://osrm-car:5000#f', 'http://u:p@osrm-car:5000',
    'ftp://osrm-car', 'osrm-car:5000', 'http://osrm-car:5000,', 'not a url',
  ])('refuses to start on %s, naming the entry without echoing it', (raw) => {
    expect(() => parseRoutingInternalOrigins(raw)).toThrow(/^ROUTING_INTERNAL_ORIGINS entry \d+ must be an http\(s\) origin/);
  });
});

describe('routingEndpointUsable', () => {
  const internal = new Set(['http://osrm-car:5000']);
  it.each([
    ['https://routing.example/routed-car', true],
    ['http://osrm-car:5000', true],
    ['http://osrm-car:5000/prefix', true],
    ['http://osrm-car:5001', false],
    ['http://routing.example', false],
    ['', false],
  ])('%s → %s', (url, usable) => {
    expect(routingEndpointUsable(url, internal)).toBe(usable);
  });
});
