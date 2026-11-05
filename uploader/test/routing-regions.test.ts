import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBundledRouting, parseStatus, resolveExtracts, wantedBody, GEOFABRIK_INDEX_URL } from '../src/routing-regions.js';
import type { safeFetch } from '../src/safe-fetch.js';

const feature = (id: string, codes: string[], url = `https://download.geofabrik.de/x/${id}-latest.osm.pbf`) =>
  ({ type: 'Feature', properties: { id, 'iso3166-1:alpha2': codes, urls: { pbf: url } } });
const INDEX = {
  features: [
    feature('costa-rica', ['CR']), feature('mexico', ['MX']),
    feature('israel-and-palestine', ['PS', 'IL']),
    feature('vanuatu', ['VU']), feature('tokelau', ['VU']),
    feature('evil', ['EV'], 'https://evil.example/evil-latest.osm.pbf'),
    feature('Bad_Id', ['BI']),
    { properties: { id: 'europe', urls: { pbf: 'https://download.geofabrik.de/europe-latest.osm.pbf' } } },
  ],
};

describe('resolveExtracts', () => {
  const extracts = resolveExtracts(INDEX);
  it('maps each ISO code to its one Geofabrik extract; a combined extract serves every code it lists', () => {
    expect(extracts.get('CR')).toEqual({ id: 'costa-rica', url: 'https://download.geofabrik.de/x/costa-rica-latest.osm.pbf' });
    expect(extracts.get('IL')?.id).toBe('israel-and-palestine');
    expect(extracts.get('PS')?.id).toBe('israel-and-palestine');
  });
  it('leaves ambiguous codes, foreign hosts and malformed ids out instead of guessing', () => {
    expect(extracts.has('VU')).toBe(false);
    expect(extracts.has('EV')).toBe(false);
    expect(extracts.has('BI')).toBe(false);
  });
  it('treats a non-index document as empty', () => {
    for (const junk of [null, 'x', { features: 'no' }, { features: [null, 1, { properties: null }] }]) expect(resolveExtracts(junk).size).toBe(0);
  });
});

describe('wantedBody', () => {
  it('lists each distinct extract once, sorted, skipping countries without one', () => {
    expect(wantedBody(['MX', 'cr', 'IL', 'PS', 'VU', 'XX'], resolveExtracts(INDEX))).toBe([
      'costa-rica https://download.geofabrik.de/x/costa-rica-latest.osm.pbf',
      'israel-and-palestine https://download.geofabrik.de/x/israel-and-palestine-latest.osm.pbf',
      'mexico https://download.geofabrik.de/x/mexico-latest.osm.pbf',
    ].map((line) => `${line}\n`).join(''));
  });
});

describe('parseStatus', () => {
  it('reads per-mode ports and drops every malformed or out-of-range line whole', () => {
    const statuses = parseStatus([
      'costa-rica ready 5100 5101 5102',
      'mexico building 5103 - -',
      'ecuador downloading - - -',
      'greece failed - - -',
      'evil ready 22 23 24',
      'high ready 6000 - -',
      'x unknown - - -',
      'Bad_Id ready 5100 5101 5102',
      'short ready 5100',
      '',
    ].join('\n'));
    expect([...statuses.keys()]).toEqual(['costa-rica', 'mexico', 'ecuador', 'greece']);
    expect(statuses.get('costa-rica')).toEqual({ state: 'ready', ports: { car: 5100, bike: 5101, foot: 5102 } });
    expect(statuses.get('mexico')).toEqual({ state: 'building', ports: { car: 5103 } });
  });
});

describe('createBundledRouting', () => {
  async function setup(countries: string[], index: unknown = INDEX) {
    const dir = await mkdtemp(join(tmpdir(), 'bundled-routing-'));
    let calls = 0;
    let fail = false;
    let clock = 1_000_000;
    const request = (async (url: string) => {
      calls++;
      expect(url).toBe(GEOFABRIK_INDEX_URL);
      if (fail) throw new Error('offline');
      return { buffer: Buffer.from(JSON.stringify(index)), contentType: 'application/json' };
    }) as typeof safeFetch;
    const list = [...countries];
    const routing = createBundledRouting({
      dir, host: 'osrm', countries: async () => list, request, now: () => clock, log: () => {},
    });
    const status = async (body: string) => { await mkdir(join(dir, 'control'), { recursive: true }); await writeFile(join(dir, 'control', 'status'), body); };
    return {
      dir, routing, status, list,
      calls: () => calls, failNext: (value: boolean) => { fail = value; }, advance: (ms: number) => { clock += ms; },
      wanted: () => readFile(join(dir, 'control', 'wanted'), 'utf8'),
    };
  }

  it('writes the wanted extracts from the story countries, and rewrites only when they change', async () => {
    const t = await setup(['CR']);
    await t.routing.sync();
    expect(await t.wanted()).toBe('costa-rica https://download.geofabrik.de/x/costa-rica-latest.osm.pbf\n');
    // Unchanged countries: the file is not rewritten (a sentinel survives the sync).
    await writeFile(join(t.dir, 'control', 'wanted'), 'sentinel\n');
    await t.routing.sync();
    expect(await t.wanted()).toBe('sentinel\n');
    t.list.push('MX');
    await t.routing.sync();
    expect((await t.wanted()).split('\n').filter(Boolean).map((line) => line.split(' ')[0])).toEqual(['costa-rica', 'mexico']);
    expect(t.calls()).toBe(1); // the index is cached between syncs
  });

  it('keeps the last good index when Geofabrik is unreachable later, and retries after the backoff', async () => {
    const t = await setup(['CR']);
    await t.routing.sync();
    t.failNext(true);
    t.advance(25 * 60 * 60 * 1000); // index expired
    t.list.push('MX');
    await t.routing.sync();
    expect(await t.wanted()).toContain('mexico'); // resolved with the cached index
    expect(t.calls()).toBe(2);
    await t.routing.sync();
    expect(t.calls()).toBe(2); // within the retry backoff: no new request
  });

  it('reports per-country state and serves only the modes that are ready', async () => {
    const t = await setup(['CR', 'MX']);
    expect(t.routing.view('CR')).toEqual({ state: 'preparing', region: null }); // no index yet
    await t.routing.sync();
    await t.status('costa-rica ready 5100 5101 5102\nmexico building 5103 - -\n');
    expect(t.routing.view('CR')).toEqual({ state: 'ready', region: 'costa-rica' });
    expect(t.routing.endpoints('cr')).toEqual({ car: 'http://osrm:5100', bike: 'http://osrm:5101', foot: 'http://osrm:5102' });
    expect(t.routing.view('MX')).toEqual({ state: 'preparing', region: 'mexico' });
    expect(t.routing.endpoints('MX')).toEqual({ car: 'http://osrm:5103' });
    expect(t.routing.view('VU')).toEqual({ state: 'unsupported', region: null });
    expect(t.routing.endpoints('VU')).toEqual({});
    await t.status('costa-rica failed - - -\n');
    expect(t.routing.view('CR')).toEqual({ state: 'failed', region: 'costa-rica' });
    expect(t.routing.endpoints('CR')).toEqual({});
  });

  it('does not write a wanted file before the index ever loaded', async () => {
    const t = await setup(['CR']);
    t.failNext(true);
    await t.routing.sync();
    await expect(t.wanted()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
