import { describe, expect, it } from 'vitest';
import { locales, ui, useTranslations } from './ui';

describe('ui dictionaries', () => {
  it('defines every key in every locale (no leak like the old WP footer)', () => {
    const deKeys = Object.keys(ui.de).sort();
    for (const locale of locales) {
      expect(Object.keys(ui[locale]).sort(), `locale ${locale}`).toEqual(deKeys);
    }
  });

  it('returns locale-specific strings', () => {
    expect(useTranslations('de')('nav.about')).toBe('Über mich');
    expect(useTranslations('en')('nav.about')).toBe('About me');
    expect(useTranslations('en')('footer.latest')).toBe('Latest stories');
  });
});
