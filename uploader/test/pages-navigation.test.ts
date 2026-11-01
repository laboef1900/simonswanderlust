import { describe, expect, it } from 'vitest';
import { DEFAULT_NAVIGATION, validateNavigation, pageNavReferences, withoutPageNavigation } from '../../site/src/lib/navigation.js';
import { isPageKind, PAGE_KINDS } from '../../site/src/lib/page-kinds.js';

describe('shared pages/navigation contract', () => {
  it('preserves the About identity and has only the four approved kinds', () => {
    expect(Object.keys(PAGE_KINDS)).toEqual(['about', 'contact', 'privacy', 'legal']);
    expect(isPageKind('__proto__')).toBe(false); expect(isPageKind('constructor')).toBe(false);
    expect(PAGE_KINDS.about).toMatchObject({ deletable: false, unpublishable: false, slugs: { de: 'uber-mich', en: 'about-me' } });
    expect(validateNavigation(DEFAULT_NAVIGATION)).toEqual(DEFAULT_NAVIGATION);
  });
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '\tjavascript:alert(1)', 'data:text/html,x', 'http://example.test', 'mailto:test@example.test', 'https://user:pw@example.test', 'https://example.test/a b'])('refuses unsafe external destination %s', (href) => {
    expect(() => validateNavigation({ version: 1, header: [{ kind: 'external', href: { en: href }, label: { en: 'Visit' } }], footer: [], legal: [] })).toThrow();
  });
  it.each(['//evil.test/', '/\\evil.test/', '/bad space', '/\nunsafe', '/a'.repeat(300)])('refuses unsafe site-relative destination %s', (href) => {
    expect(() => validateNavigation({ version: 1, header: [], footer: [{ kind: 'path', href: { en: href }, label: { en: 'Visit' } }], legal: [] })).toThrow();
  });
  it('normalizes labels and HTTPS, enforces limits, and removes only exact page references', () => {
    const nav = validateNavigation({ version: 1, header: [{ kind: 'page', target: 'contact', label: { en: ' \u0000Contact\u202e ' } }],
      footer: [{ kind: 'external', href: { en: 'https://EXAMPLE.test' }, label: { en: 'Visit' } }, { kind: 'page', target: 'contact' }], legal: [{ kind: 'page', target: 'privacy' }] });
    expect(nav.header[0]).toEqual({ kind: 'page', target: 'contact', label: { en: 'Contact' } });
    expect(nav.footer[0]).toMatchObject({ href: { en: 'https://example.test/' } });
    expect(pageNavReferences(nav, 'contact')).toHaveLength(2);
    const removed = withoutPageNavigation(nav, 'contact'); expect(removed.header).toEqual([]); expect(removed.footer).toEqual([nav.footer[0]]); expect(removed.legal).toEqual(nav.legal);
    expect(nav.header).toHaveLength(1);
    expect(() => validateNavigation({ ...nav, header: Array(6).fill({ kind: 'page', target: 'about' }) })).toThrow();
    expect(() => validateNavigation({ ...nav, header: [{ kind: 'page', target: 'unknown' }] })).toThrow();
    expect(() => validateNavigation({ ...nav, header: [{ kind: 'page', target: 'about', label: { en: 'x'.repeat(41) } }] })).toThrow();
  });
});
