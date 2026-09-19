import { describe, expect, it } from 'vitest';
import { cardMetaLabel, coordsLabel, dateLabel, entryLabel } from './format';

describe('dateLabel', () => {
  it('formats uppercase month + year per locale', () => {
    const d = new Date('2024-10-03');
    expect(dateLabel(d, 'en')).toBe('OCT 2024');
    expect(dateLabel(d, 'de')).toBe('OKT 2024');
  });
});

describe('coordsLabel', () => {
  it('formats N/E coordinates', () => {
    expect(coordsLabel({ lat: 44.4268, lng: 26.1025 })).toBe('44.4268° N · 26.1025° E');
  });
  it('formats S/W coordinates (Galápagos)', () => {
    expect(coordsLabel({ lat: -0.7393, lng: -90.3273 })).toBe('0.7393° S · 90.3273° W');
  });
});

describe('entryLabel', () => {
  it('zero-pads the entry number', () => {
    expect(entryLabel(7)).toBe('N°07');
    expect(entryLabel(12)).toBe('N°12');
  });
});

describe('cardMetaLabel', () => {
  const oct = new Date('2024-10-03');

  it('drops a country the title already names', () => {
    expect(cardMetaLabel(oct, 'Ungarn', 'Ungarn: Sehenswürdigkeiten in Budapest', 'de')).toBe('OKT 2024');
    // Mid-title and differently cased both count as already named.
    expect(cardMetaLabel(oct, 'ecuador', 'Ecuador Cuyabeno: Jungleabenteuer', 'de')).toBe('OKT 2024');
  });

  it('keeps a country the title leaves out', () => {
    expect(cardMetaLabel(oct, 'Rumänien', 'Bukarest in 4 Tagen', 'de')).toBe('OKT 2024 · Rumänien');
    expect(cardMetaLabel(oct, 'Romania', 'Bucharest in 4 Days', 'en')).toBe('OCT 2024 · Romania');
  });

  it('never renders a dangling separator for a post without a country', () => {
    expect(cardMetaLabel(oct, '', 'Bukarest in 4 Tagen', 'de')).toBe('OKT 2024');
    expect(cardMetaLabel(oct, '   ', 'Bukarest in 4 Tagen', 'de')).toBe('OKT 2024');
  });
});
