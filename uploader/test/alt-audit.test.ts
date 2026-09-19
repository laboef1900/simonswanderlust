import { describe, expect, it } from 'vitest';
import { auditAltText } from '../src/alt-audit.js';
import type { ImageDims, PostLocale } from '../src/posts.js';

// The alt-text audit is what tells an author that a photo reaches a reader
// undescribed. Its rule has to agree with `heroAltOf` in
// site/src/lib/trips.ts, which emits `alt=""` for an alt that only repeats the
// title — so "the alt field is filled in" is NOT the same question as "the
// photo is described", and every case below is one an author can actually hit
// (the WordPress import stores the post title as every hero's alt).

const IMG = 'https://img.simonswanderlust.com';

function locale(over: Partial<PostLocale> & { locale: 'de' | 'en' }): PostLocale {
  return {
    slug: over.locale === 'de' ? 'rhodos' : 'rhodes',
    title: '', excerpt: 'e', country: 'Griechenland',
    heroImage: { src: '', width: 0, height: 0, alt: '' },
    bodyMarkdown: '', images: {},
    ...over,
  };
}

/** A post whose DE locale is the interesting one; EN stays untouched/blank. */
function post(de: Partial<PostLocale>, en: Partial<PostLocale> = {}) {
  return { de: locale({ locale: 'de', ...de }), en: locale({ locale: 'en', ...en }) };
}

const hero = (alt: string) => ({ heroImage: { src: `${IMG}/trips/rhodos/hero`, width: 3000, height: 2000, alt } });
const dims: ImageDims = { width: 3000, height: 2000 };

describe('auditAltText — hero', () => {
  it('reports a hero whose alt only repeats the title, and passes a real description', () => {
    const repeated = auditAltText(post({ title: 'Rhodos', ...hero('Rhodos') }));
    expect(repeated.count).toBe(1);
    expect(repeated.images).toEqual([
      { locale: 'de', kind: 'hero', src: `${IMG}/trips/rhodos/hero`, reason: 'repeats-title' },
    ]);
    expect(auditAltText(post({ title: 'Rhodos', ...hero('Fischerboote im Hafen von Lindos') })).count).toBe(0);
  });

  it('reports an alt that is empty or only whitespace', () => {
    expect(auditAltText(post({ title: 'Rhodos', ...hero('') })).images[0]?.reason).toBe('empty');
    expect(auditAltText(post({ title: 'Rhodos', ...hero('   \t ') })).images[0]?.reason).toBe('empty');
  });

  it('ignores case and surrounding whitespace on both sides of the comparison', () => {
    expect(auditAltText(post({ title: 'Rhodos', ...hero('  rHODOS ') })).count).toBe(1);
    expect(auditAltText(post({ title: '  Rhodos  ', ...hero('RHODOS') })).count).toBe(1);
  });

  it('says nothing about a locale that has no hero photo at all', () => {
    expect(auditAltText(post({ title: 'Rhodos', bodyMarkdown: 'Text' })).count).toBe(0);
  });
});

describe('auditAltText — body and gallery photos', () => {
  it('audits a gallery photo against the images-map alt the renderer reads', () => {
    const body = '```gallery\n' + `${IMG}/trips/rhodos/g1\n` + `${IMG}/trips/rhodos/g2\n` + '```';
    const audit = auditAltText(post({
      title: 'Rhodos',
      bodyMarkdown: body,
      images: {
        [`${IMG}/trips/rhodos/g1`]: { ...dims, alt: 'Rhodos' },
        [`${IMG}/trips/rhodos/g2`]: { ...dims, alt: 'Ziegen auf der Küstenstraße' },
      },
    }));
    expect(audit.images).toEqual([
      { locale: 'de', kind: 'gallery', src: `${IMG}/trips/rhodos/g1`, reason: 'repeats-title' },
    ]);
  });

  it('reports a gallery photo the map carries no alt for', () => {
    const body = '```gallery\n' + `${IMG}/trips/rhodos/g1\n` + '```';
    const audit = auditAltText(post({
      title: 'Rhodos', bodyMarkdown: body, images: { [`${IMG}/trips/rhodos/g1`]: dims },
    }));
    expect(audit.images).toEqual([
      { locale: 'de', kind: 'gallery', src: `${IMG}/trips/rhodos/g1`, reason: 'empty' },
    ]);
  });

  it('reads an inline body image\'s alt from the Markdown label, not from the images map', () => {
    // The trap: an `images` entry for an inline photo holds only width/height,
    // so treating a missing `images[src].alt` as "undescribed" would report
    // every properly described body photo in the corpus.
    const described = auditAltText(post({
      title: 'Rhodos',
      bodyMarkdown: `![Blick über die Altstadt](${IMG}/trips/rhodos/b1)`,
      images: { [`${IMG}/trips/rhodos/b1`]: dims },
    }));
    expect(described.count).toBe(0);

    const repeated = auditAltText(post({
      title: 'Rhodos',
      bodyMarkdown: `![Rhodos](${IMG}/trips/rhodos/b1)\n\n![](${IMG}/trips/rhodos/b2)`,
      images: { [`${IMG}/trips/rhodos/b1`]: dims, [`${IMG}/trips/rhodos/b2`]: dims },
    }));
    expect(repeated.images).toEqual([
      { locale: 'de', kind: 'body', src: `${IMG}/trips/rhodos/b1`, reason: 'repeats-title' },
      { locale: 'de', kind: 'body', src: `${IMG}/trips/rhodos/b2`, reason: 'empty' },
    ]);
  });

  it('says nothing about an images-map entry the body no longer references', () => {
    // The map is never pruned (#91), so a stale key is normal — and it puts no
    // photo on the page to describe.
    expect(auditAltText(post({
      title: 'Rhodos', bodyMarkdown: 'Nur Text.', images: { [`${IMG}/trips/rhodos/old`]: dims },
    })).count).toBe(0);
  });
});

describe('auditAltText — locales', () => {
  it('judges each locale against its own title', () => {
    // The EN hero alt is the DE title: different words to an English reader,
    // and the EN page's heading never says them — a real description.
    const audit = auditAltText(post(
      { title: 'Rhodos', ...hero('Rhodos') },
      { title: 'Rhodes', heroImage: { src: `${IMG}/trips/rhodes/hero`, width: 3000, height: 2000, alt: 'Rhodos' } },
    ));
    expect(audit.images).toEqual([
      { locale: 'de', kind: 'hero', src: `${IMG}/trips/rhodos/hero`, reason: 'repeats-title' },
    ]);
  });

  it('contributes nothing for a locale nobody has written yet', () => {
    // Write-DE-first: EN is a blank title, a blank body and the placeholder
    // hero. Its images map may still hold entries from a duplicate/import.
    const audit = auditAltText(post(
      { title: 'Rhodos', ...hero('Fischerboote im Hafen') },
      { images: { [`${IMG}/trips/rhodes/g1`]: dims } },
    ));
    expect(audit).toEqual({ count: 0, images: [] });
  });

  it('reports both locales when both are written', () => {
    const audit = auditAltText(post(
      { title: 'Rhodos', ...hero('') },
      { title: 'Rhodes', heroImage: { src: `${IMG}/trips/rhodes/hero`, width: 10, height: 10, alt: 'rhodes' } },
    ));
    expect(audit.count).toBe(2);
    expect(audit.images.map((i) => `${i.locale}:${i.reason}`)).toEqual(['de:empty', 'en:repeats-title']);
  });
});
