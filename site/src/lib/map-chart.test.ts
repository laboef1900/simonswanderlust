import { describe, expect, it } from 'vitest';
import { mapChart, TARGET_ASPECT, type ChartInput } from './map-chart';

const CORPUS: ChartInput[] = [
  { lng: 26.1025, lat: 44.4268, title: 'Bukarest' },
  { lng: 19.0402, lat: 47.4979, title: 'Budapest' },
  { lng: 12.5683, lat: 55.6761, title: 'Kopenhagen' },
  { lng: 5.1214, lat: 52.0907, title: 'Hausboot' },
  { lng: 28.2278, lat: 36.4349, title: 'Rhodos' },
  { lng: -84.0907, lat: 9.7489, title: 'Costa Rica' },
  { lng: -76.5, lat: -0.5, title: 'Cuyabeno' },
  { lng: -90.9656, lat: -0.7437, title: 'Galápagos' },
  { lng: -87.0739, lat: 20.6296, title: 'Yucatán' },
];

describe('mapChart', () => {
  it('has no chart without data', () => {
    expect(mapChart([])).toBeNull();
  });

  it('keeps every pin inside the viewBox', () => {
    const chart = mapChart(CORPUS)!;
    for (const pin of chart.pins) {
      expect(pin.x, pin.title).toBeGreaterThanOrEqual(0);
      expect(pin.x, pin.title).toBeLessThanOrEqual(chart.width);
      expect(pin.y, pin.title).toBeGreaterThanOrEqual(0);
      expect(pin.y, pin.title).toBeLessThanOrEqual(chart.height);
    }
  });

  it('pads, so no pin sits on the frame', () => {
    const chart = mapChart(CORPUS)!;
    const xs = chart.pins.map((p) => p.x);
    const ys = chart.pins.map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThan(10);
    expect(Math.max(...xs)).toBeLessThan(chart.width - 10);
    expect(Math.min(...ys)).toBeGreaterThan(10);
    expect(Math.max(...ys)).toBeLessThan(chart.height - 10);
  });

  it('preserves relative geography: east of, and north of, still hold', () => {
    const chart = mapChart(CORPUS)!;
    const at = (title: string) => chart.pins.find((p) => p.title === title)!;
    // Bucharest is east of Copenhagen, and Copenhagen north of it.
    expect(at('Bukarest').x).toBeGreaterThan(at('Kopenhagen').x);
    expect(at('Kopenhagen').y).toBeLessThan(at('Bukarest').y);
    // The Americas sit left of Europe; the Galápagos below the Yucatán.
    expect(at('Galápagos').x).toBeLessThan(at('Rhodos').x);
    expect(at('Galápagos').y).toBeGreaterThan(at('Yucatán').y);
  });

  it('fits the band aspect without cropping, even from a one-pin corpus', () => {
    for (const set of [CORPUS, CORPUS.slice(0, 1), CORPUS.slice(5)]) {
      const chart = mapChart(set)!;
      expect(chart.width / chart.height).toBeCloseTo(TARGET_ASPECT, 1);
      for (const pin of chart.pins) {
        expect(pin.x).toBeGreaterThan(0);
        expect(pin.x).toBeLessThan(chart.width);
      }
    }
  });

  it('labels the graticule in degrees, with the equator marked primary', () => {
    const chart = mapChart(CORPUS)!;
    expect(chart.meridians.length).toBeGreaterThan(1);
    expect(chart.meridians.length).toBeLessThanOrEqual(6);
    expect(chart.parallels.length).toBeGreaterThan(1);
    expect(chart.parallels.length).toBeLessThanOrEqual(6);
    for (const line of [...chart.meridians, ...chart.parallels]) {
      expect(line.label).toMatch(/^(0°|\d+(\.\d)?°[NSEW])$/);
    }
    // The corpus straddles the equator, so it must be drawn and emphasised.
    const equator = chart.parallels.find((p) => p.label === '0°');
    expect(equator?.primary).toBe(true);
    // Only the equator and the prime meridian are ever primary.
    expect(chart.parallels.filter((p) => p.primary)).toHaveLength(1);
  });

  /**
   * An SVG font-size is in viewBox units, so the stacked layout renders the
   * same label roughly twice as large — and the topmost parallel's label,
   * placed 8 units above its own line, went off the top of the frame on a
   * phone (the "6" of "60°N" was sliced). The clamp lives in the lib so this
   * holds for any corpus, not just the one that exposed it.
   */
  it('keeps every label baseline inside the frame at the largest label size', () => {
    const corpora = [CORPUS, CORPUS.slice(0, 1), CORPUS.slice(0, 2), CORPUS.slice(5)];
    for (const set of corpora) {
      const chart = mapChart(set)!;
      // Room for the cap height above the baseline and the descender below.
      expect(chart.labelBaseline).toBeLessThan(chart.height);
      expect(chart.labelBaseline).toBeGreaterThan(30);
      for (const p of chart.parallels) {
        expect(p.labelAt, `parallel ${p.label} clipped at the top`).toBeGreaterThanOrEqual(33);
        expect(p.labelAt, `parallel ${p.label} collides with the bottom row`).toBeLessThanOrEqual(
          chart.labelBaseline - 18,
        );
      }
      for (const m of chart.meridians) {
        expect(m.labelAt).toBe(m.at);
      }
    }
  });

  it('never projects outside real coordinates, even when padding would', () => {
    // A pin at the pole: padding must not invent a 98°N parallel.
    const chart = mapChart([{ lng: 0, lat: 89.5, title: 'pole' }])!;
    for (const line of chart.parallels) {
      const value = Number(line.label.replace(/[°NS]/g, ''));
      expect(value).toBeLessThanOrEqual(90);
    }
    expect(chart.pins[0]!.y).toBeGreaterThanOrEqual(0);
  });
});
