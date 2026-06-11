import { describe, expect, it } from 'vitest';
import { dateLabel } from './format';

describe('dateLabel', () => {
  it('formats uppercase month + year per locale', () => {
    const d = new Date('2024-10-03');
    expect(dateLabel(d, 'en')).toBe('OCT 2024');
    expect(dateLabel(d, 'de')).toBe('OKT 2024');
  });
});
