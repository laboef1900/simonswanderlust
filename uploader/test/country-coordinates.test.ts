import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Behaviour of the editor's offline country → coordinates helper, run against
// the real bundled Natural Earth table. Status copy is a set of state markers,
// so the assertions name the state the author sees, not the prose.

const data = readFileSync('public/country-centers.js', 'utf8');
const script = readFileSync('public/country-coordinates.js', 'utf8');

type Lookup = { kind: 'found'; iso: string } | { kind: 'empty' | 'unknown' | 'ambiguous' };
type Row = [string, number, number, ...string[]];
interface Wired { reset(): void; setCopy(copy: Record<string, string>, lang?: string): void }
interface Api {
  lookup(text: string): Lookup;
  center(iso: string): { lat: number; lng: number } | null;
  wire(options: Record<string, unknown>): Wired;
}

class FakeInput extends EventTarget {
  value = '';
  hidden = false;
  textContent = '';
  type = '';
  click() { this.dispatchEvent(new Event('click')); }
}

const copy = {
  countryUseCenter: 'use',
  countryCenterFilled: 'filled {country}',
  countryCenterFromCode: 'fromCode {country} {code}',
  countryCoordsKept: 'kept',
  countryCoordsPartial: 'partial',
  countryUnknown: 'unknown {name}',
  countryAmbiguous: 'ambiguous {name}',
  countryConflict: 'conflict',
  countryCodeMismatch: 'mismatch {code}',
  countryCodeUnknown: 'codeUnknown {code}',
};

function load(rows?: Row[]): Api {
  const window: Record<string, unknown> = {};
  const ctx = vm.createContext({ window, Intl, Event });
  if (rows) window.CountryCenters = rows;
  else vm.runInContext(data, ctx);
  vm.runInContext(script, ctx);
  return window.CountryCoordinates as Api;
}

type Field = 'de' | 'en' | 'code' | 'lat' | 'lng';

function editor(values: Partial<Record<Field, string>> = {}, rows?: Row[]) {
  const api = load(rows);
  const fields = { de: new FakeInput(), en: new FakeInput(), code: new FakeInput(), lat: new FakeInput(), lng: new FakeInput() };
  for (const [name, value] of Object.entries(values)) fields[name as Field].value = value ?? '';
  const status = new FakeInput();
  const button = new FakeInput();
  const written: Field[] = [];
  let typing = false;
  for (const [name, input] of Object.entries(fields)) {
    input.addEventListener('input', () => { if (!typing) written.push(name as Field); });
  }
  const wired = api.wire({
    countries: [fields.de, fields.en], codeInput: fields.code, latInput: fields.lat, lngInput: fields.lng,
    status, useButton: button, copy, lang: 'en',
  });
  return {
    api, wired, status, button, written, ...fields,
    // A committed edit: the author typed and left the field.
    commit(field: Field, value: string) {
      const input = fields[field];
      typing = true;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      typing = false;
      input.dispatchEvent(new Event('change'));
    },
    type(field: Field, value: string) {
      typing = true;
      fields[field].value = value;
      fields[field].dispatchEvent(new Event('input', { bubbles: true }));
      typing = false;
    },
    coords() { return [fields.lat.value, fields.lng.value]; },
  };
}

function centerOf(api: Api, iso: string) {
  const point = api.center(iso);
  if (!point) throw new Error('no centre for ' + iso);
  return [String(point.lat), String(point.lng)];
}

describe('country lookup', () => {
  const api = load();

  it.each([
    ['Griechenland', 'GR'], ['Greece', 'GR'], ['Rumänien', 'RO'], ['Romania', 'RO'],
    ['Österreich', 'AT'], ['Oesterreich', 'AT'], ['osterreich', 'AT'], ['ÖSTERREICH', 'AT'],
    ['Elfenbeinküste', 'CI'], ['Côte d’Ivoire', 'CI'], ['São Tomé und Príncipe', 'ST'],
    ['die Schweiz', 'CH'], ['  Ecuador ', 'EC'], ['Vereinigte Staaten', 'US'], ['U.S.A.', 'US'],
    ['USA', 'US'], ['UK', 'GB'], ['Tschechien', 'CZ'], ['Česko', 'CZ'], ['St. Lucia', 'LC'],
  ])('resolves %s to %s', (name, iso) => {
    expect(api.lookup(name)).toEqual({ kind: 'found', iso });
  });

  it('reports unknown and empty names instead of guessing a neighbour', () => {
    expect(api.lookup('Atlantis').kind).toBe('unknown');
    expect(api.lookup('Korea').kind).toBe('unknown');
    expect(api.lookup('   ').kind).toBe('empty');
  });

  it('accepts a bare ISO code typed as the country name', () => {
    expect(api.lookup('GR')).toEqual({ kind: 'found', iso: 'GR' });
    expect(api.lookup(' gr ')).toEqual({ kind: 'found', iso: 'GR' });
    expect(api.lookup('ZZ').kind).toBe('unknown');
  });

  it('reports a name shared by two countries as ambiguous', () => {
    const fixture = load([['AA', 1, 2, 'Testland'], ['BB', 3, 4, 'Testland', 'Bravo']]);
    expect(fixture.lookup('Testland').kind).toBe('ambiguous');
    expect(fixture.lookup('Bravo')).toEqual({ kind: 'found', iso: 'BB' });
  });

  it('returns centres by ISO code, case-insensitively, and null for unknown codes', () => {
    const point = api.center('gr');
    expect(point && point.lat).toBeGreaterThan(34);
    expect(point && point.lat).toBeLessThan(42);
    expect(point && point.lng).toBeGreaterThan(19);
    expect(point && point.lng).toBeLessThan(30);
    expect(api.center('ZZ')).toBeNull();
  });

  it('carries a two-letter code and finite coordinates on every bundled row', () => {
    const window: Record<string, unknown> = {};
    vm.runInContext(data, vm.createContext({ window }));
    const rows = window.CountryCenters as Row[];
    for (const [iso, lat, lng] of rows) {
      expect(iso).toMatch(/^[A-Z]{2}$/);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lng)).toBeLessThanOrEqual(180);
    }
  });
});

describe('automatic coordinates in the editor', () => {
  it('fills blank coordinates and a blank ISO code from a committed country, as normal input edits', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    expect(page.coords()).toEqual(centerOf(page.api, 'GR'));
    expect(page.code.value).toBe('GR');
    expect(page.written.sort()).toEqual(['code', 'lat', 'lng']);
    expect(page.status.textContent).toBe('filled Greece');
    expect(page.button.hidden).toBe(true);
  });

  it('fills from an ISO code typed into a country field', () => {
    const page = editor();
    page.commit('en', 'gr');
    expect(page.coords()).toEqual(centerOf(page.api, 'GR'));
    expect(page.code.value).toBe('GR');
    expect(page.status.textContent).toBe('filled Greece');
  });

  it('does not react to typing before the field is committed', () => {
    const page = editor();
    page.type('de', 'Griechenland');
    expect(page.coords()).toEqual(['', '']);
    expect(page.written).toEqual([]);
  });

  it('moves its own coordinates and ISO code when the country changes', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    page.commit('de', 'Italien');
    expect(page.coords()).toEqual(centerOf(page.api, 'IT'));
    expect(page.code.value).toBe('IT');
  });

  it('writes nothing when a matching translation is added', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    page.written.length = 0;
    page.commit('en', 'Greece');
    expect(page.written).toEqual([]);
    expect(page.coords()).toEqual(centerOf(page.api, 'GR'));
  });

  it('keeps loaded coordinates and a loaded ISO code, and reset never writes', () => {
    const page = editor({ de: 'Griechenland', code: 'GR', lat: '37.9755', lng: '23.7348' });
    page.wired.reset();
    page.commit('en', 'Greece');
    page.commit('de', 'Griechenland');
    expect(page.coords()).toEqual(['37.9755', '23.7348']);
    expect(page.written).toEqual([]);
    expect(page.status.textContent).toBe('kept');
    expect(page.button.hidden).toBe(false);
  });

  it('leaves loaded blank coordinates blank on reset but offers the explicit centre', () => {
    const page = editor({ de: 'Griechenland', en: 'Greece', code: 'GR' });
    page.wired.reset();
    expect(page.coords()).toEqual(['', '']);
    expect(page.written).toEqual([]);
    expect(page.button.hidden).toBe(false);
    page.button.click();
    expect(page.coords()).toEqual(centerOf(page.api, 'GR'));
    expect(page.written.sort()).toEqual(['lat', 'lng']);
    expect(page.button.hidden).toBe(true);
  });

  it('forgets ownership on reset, so values from an earlier post or a restored stash stay put', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    page.wired.reset();
    page.commit('de', 'Italien');
    expect(page.coords()).toEqual(centerOf(page.api, 'GR'));
    expect(page.code.value).toBe('GR');
    expect(page.status.textContent).toBe('kept mismatch GR');
  });

  it('replaces manual coordinates only through the explicit button, which then tracks them', () => {
    const page = editor({ lat: '10', lng: '20' });
    page.commit('de', 'Griechenland');
    expect(page.coords()).toEqual(['10', '20']);
    page.button.click();
    expect(page.coords()).toEqual(centerOf(page.api, 'GR'));
    page.commit('de', 'Italien');
    expect(page.coords()).toEqual(centerOf(page.api, 'IT'));
  });

  it('treats zero as a real coordinate', () => {
    const page = editor({ lat: '0', lng: '0' });
    page.commit('de', 'Griechenland');
    expect(page.coords()).toEqual(['0', '0']);
    expect(page.status.textContent).toBe('kept');
  });

  it('keeps a single entered coordinate and does not complete it', () => {
    const page = editor({ lat: '0' });
    page.commit('en', 'Greece');
    expect(page.coords()).toEqual(['0', '']);
    expect(page.status.textContent).toBe('partial');
    expect(page.button.hidden).toBe(false);
  });

  it('hands coordinates to the author as soon as one is edited', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    const [, lng] = centerOf(page.api, 'GR');
    page.type('lat', '38');
    expect(page.status.textContent).toBe('kept');
    page.commit('de', 'Italien');
    expect(page.coords()).toEqual(['38', lng]);
  });

  it('refills after the author clears both coordinates', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    page.type('lat', '');
    page.type('lng', '');
    page.commit('de', 'Italien');
    expect(page.coords()).toEqual(centerOf(page.api, 'IT'));
  });

  it('removes its own stale values when the country becomes unknown, but never the author’s', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    page.commit('de', 'Atlantis');
    expect(page.coords()).toEqual(['', '']);
    expect(page.code.value).toBe('');
    expect(page.status.textContent).toBe('unknown Atlantis');
    expect(page.button.hidden).toBe(true);

    const manual = editor({ code: 'GR', lat: '1', lng: '2' });
    manual.commit('de', 'Atlantis');
    expect(manual.coords()).toEqual(['1', '2']);
    expect(manual.code.value).toBe('GR');
  });

  it('removes its own values when the country is cleared', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    page.commit('de', '');
    expect(page.coords()).toEqual(['', '']);
    expect(page.code.value).toBe('');
    expect(page.status.textContent).toBe('');
  });

  it('refuses to choose when the German and English names disagree', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    page.commit('en', 'Italy');
    expect(page.coords()).toEqual(['', '']);
    expect(page.status.textContent).toBe('conflict');
  });

  it('refuses to choose between countries sharing a name', () => {
    const page = editor({}, [['AA', 1, 2, 'Testland'], ['BB', 3, 4, 'Testland']]);
    page.commit('de', 'Testland');
    expect(page.coords()).toEqual(['', '']);
    expect(page.code.value).toBe('');
    expect(page.status.textContent).toBe('ambiguous Testland');
  });

  it('uses an author-entered ISO code when no country name is given', () => {
    const page = editor();
    page.commit('code', 'gr');
    expect(page.coords()).toEqual(centerOf(page.api, 'GR'));
    expect(page.code.value).toBe('gr');
    expect(page.status.textContent).toBe('fromCode Greece GR');
  });

  it('uses an author-entered ISO code for a name the table does not know', () => {
    const page = editor({ code: 'ES' });
    page.commit('de', 'Kanaren');
    expect(page.coords()).toEqual(centerOf(page.api, 'ES'));
    expect(page.status.textContent).toBe('fromCode Spain ES');
  });

  it('lets a committed country name win over an author ISO code without rewriting the code', () => {
    const page = editor();
    page.commit('code', 'GR');
    page.commit('de', 'Italien');
    expect(page.coords()).toEqual(centerOf(page.api, 'IT'));
    expect(page.code.value).toBe('GR');
    expect(page.status.textContent).toBe('filled Italy mismatch GR');
  });

  it('stops tracking its ISO code once the author edits it', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    page.commit('code', 'IT');
    page.commit('de', 'Frankreich');
    expect(page.code.value).toBe('IT');
    expect(page.coords()).toEqual(centerOf(page.api, 'FR'));
  });

  it('reports an unknown ISO code without filling anything', () => {
    const page = editor();
    page.commit('code', 'ZZ');
    expect(page.coords()).toEqual(['', '']);
    expect(page.status.textContent).toBe('codeUnknown ZZ');
  });

  it('re-renders status and button in another admin language', () => {
    const page = editor();
    page.commit('de', 'Griechenland');
    page.wired.setCopy({ ...copy, countryUseCenter: 'nutzen', countryCenterFilled: 'gefüllt {country}' }, 'de');
    expect(page.status.textContent).toBe('gefüllt Griechenland');
    expect(page.button.textContent).toBe('nutzen');
  });
});
