import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Stamp from './Stamp.astro';
import { rowToEntryInput } from '../lib/postgres-loader';
import { dateLabel } from '../lib/format';
import { isoDate } from '../lib/seo';

// #400: the loader hands every date-only trip date over as LOCAL midnight on
// the build host, so the stamp must read local calendar fields like dateLabel
// and isoDate do. UTC CI alone cannot catch a UTC-getter regression — each
// case below is rendered under a zone east of, at and west of UTC.
const ZONES = [
  // January offsets (minutes, as getTimezoneOffset reports them) prove the
  // zone switch actually took effect, so no case can pass vacuously in UTC.
  { tz: 'UTC', januaryOffset: 0 },
  { tz: 'Europe/Zurich', januaryOffset: -60 },
  { tz: 'America/Los_Angeles', januaryOffset: 480 },
] as const;

const CASES = [
  { date: '2024-10-03', stamp: '03 10 2024' },
  { date: '2024-01-01', stamp: '01 01 2024' }, // year + month boundary (east of UTC)
  { date: '2024-12-31', stamp: '31 12 2024' }, // year + month boundary (west of UTC)
  { date: '2024-03-01', stamp: '01 03 2024' }, // month boundary after a leap day
] as const;

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function useZone(tz: string, januaryOffset: number) {
  process.env.TZ = tz;
  expect(new Date(2024, 0, 1).getTimezoneOffset()).toBe(januaryOffset);
}

// The published-snapshot shape: date-only 'YYYY-MM-DD' text, parsed by the
// real loader mapping in whichever zone is active.
function loadedDate(date: string): Date {
  const row = {
    translation_key: 't', locale: 'de' as const, slug: 's', title: 'T', date,
    country: 'Deutschland', country_code: 'DE', region: 'europe', excerpt: 'E',
    hero_image: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
    coordinates: { lat: 0, lng: 0 }, stops: null, route: null, key_facts: null,
    body_markdown: '', images: {},
  };
  return rowToEntryInput(row, 'https://img').data.date;
}

async function stampText(date: Date, region: string): Promise<string> {
  const renderer = await AstroContainer.create();
  const html = await renderer.renderToString(Stamp, {
    props: { countryCode: 'DE', country: 'Germany', date, region, locale: 'en' },
  });
  const window = new Window();
  const root = window.document.createElement('div');
  root.innerHTML = html;
  const text = root.querySelector('svg.stamp')?.textContent ?? '';
  await window.happyDOM.close();
  const dates = text.match(/\d{2} \d{2} \d{4}/g) ?? [];
  expect(dates).toHaveLength(1);
  return dates[0]!;
}

describe('arrival stamp date', () => {
  for (const { tz, januaryOffset } of ZONES) {
    describe(tz, () => {
      it.each(CASES)('stamps $date as $stamp on both stamp shapes', async ({ date, stamp }) => {
        useZone(tz, januaryOffset);
        const loaded = loadedDate(date);
        expect(await stampText(loaded, 'europe')).toBe(stamp); // Schengen rectangle
        expect(await stampText(loaded, 'asia')).toBe(stamp); // circular stamp
        // Same calendar day the page's other date surfaces print.
        expect(isoDate(loaded)).toBe(date);
        const [y, m] = date.split('-').map(Number) as [number, number];
        expect(dateLabel(loaded, 'en')).toBe(dateLabel(new Date(y, m - 1, 15), 'en'));
      });

      it('stamps a live pg `date` row (local midnight) the same way', async () => {
        useZone(tz, januaryOffset);
        expect(await stampText(new Date(2024, 0, 1), 'europe')).toBe('01 01 2024');
      });
    });
  }
});
