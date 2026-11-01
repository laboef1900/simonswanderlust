import { describe, expect, it } from 'vitest';
import { escapeMeta, galleryWarnings, MAX_GALLERY_TEXT, parsePhotoLine, readCaptionOverride } from '../public/gallery-photo-line.js';
import { analyzeGallerySource } from '../../site/src/lib/gallery-source.js';
import { galleryFencesToMdx, normalizeGalleryFences, type ImageMeta } from '../src/body-content.js';

const src = 'https://img.example.test/trips/🦋/a';
const probes = [
  String.raw`caption="The \"Old\" Bridge"`,
  'caption="Rom | Tag 2"',
  'capton="Tippfehler"',
  'alt = "Blick mit Leerzeichen"',
  "alt='Blick'",
  'caption-override="Broken',
  'caption-override="fine" | capton="bad"',
  'caption="raw | alt="valid-looking suffix"',
  '0x2000', '3000x0', '3000000x2000', '3000 x 2000', 'format="png"',
];
const fence = (line: string, newline: string) => `~~~gallery extra${newline}${line}${newline}~~~${newline}`;

describe('complete photo-line recognition', () => {
  for (const probe of probes) {
    it(`exposes no partial metadata for ${probe}`, () => {
      const raw = ` ${src} | 3000x2000 | alt="🗺️ valid" | ${probe}  \r`;
      const record = parsePhotoLine(raw);
      expect(record).toMatchObject({ valid: false, src, raw });
      expect(Object.keys(record).sort()).toEqual(['diagnostic', 'raw', 'src', 'valid']);
      expect(readCaptionOverride(raw)).toBeUndefined();
    });
    for (const newline of ['\n', '\r\n']) for (const existing of [false, true]) {
      it(`preserves ${probe}, ${JSON.stringify(newline)}, existing=${existing}`, async () => {
        const raw = `  ${src} | 3000x2000 | alt="🗺️ valid" | ${probe}  `;
        const body = fence(raw, newline);
        const images: Record<string, ImageMeta> = existing
          ? { [src]: { width: 30, height: 20, alt: 'original', caption: 'original', format: 'jpeg' } } : {};
        const before = structuredClone(images);
        const saved = await normalizeGalleryFences(body, images);
        expect(saved.bodyMarkdown).toBe(body);
        expect(saved.images).toEqual(before);
        expect(images).toEqual(before);
        expect(saved.galleryWarnings).toHaveLength(1);
        const record = parsePhotoLine(raw);
        if (record.valid) throw new Error('Expected invalid fixture');
        expect(saved.galleryWarnings[0]).toEqual({ code: 'invalid_gallery_metadata', line: 2,
          column: record.diagnostic.offset + 1, field: record.diagnostic.field, reason: record.diagnostic.reason });
        expect(await galleryFencesToMdx(saved.bodyMarkdown, saved.images)).toBe(body);
        expect(await normalizeGalleryFences(body, saved.images)).toEqual(saved);
      });
    }
  }

  it('retains valid entities, empty values, duplicate last-wins, JPEG and caps', () => {
    const text = 'quote " pipe | literal &quot; newline\n';
    const raw = `${src} | 20x10 | 40x30 | alt="old" | alt="" | caption="${escapeMeta(text)}" | caption-override="" | format="jpeg" | `;
    const record = parsePhotoLine(raw);
    expect(record).toMatchObject({ valid: true, width: 40, height: 30, alt: '', caption: text, captionOverride: '', format: 'jpeg' });
    if (!record.valid) throw new Error('Expected valid fixture');
    expect(record.fields.map((field) => raw.slice(field.start, field.end))).toEqual([
      '20x10', '40x30', 'alt="old"', 'alt=""', `caption="${escapeMeta(text)}"`, 'caption-override=""', 'format="jpeg"', ' ',
    ]);
    expect(parsePhotoLine(`${src} | alt="${'a'.repeat(1100)}"`)).toMatchObject({ valid: true, alt: 'a'.repeat(MAX_GALLERY_TEXT) });
    expect(readCaptionOverride(`${src} | caption-override="one" | caption-override="two"`)).toBe('two');
  });

  it('keeps the existing normalization and export treatment of empty fields', async () => {
    const body = fence(`${src} | `, '\n');
    const images = { [src]: { width: 30, height: 20, alt: 'Kept' } };
    expect(await galleryFencesToMdx(body, images)).toBe(body);
    const saved = await normalizeGalleryFences(body, images);
    expect(saved.bodyMarkdown).toBe(fence(src, '\n'));
    expect(saved.images).toEqual(images);
    expect(saved.galleryWarnings).toEqual([]);
  });

  it('keeps unresolved dimensions, then normalizes a syntax-only repair without leaking local captions', async () => {
    const raw = `${src} | alt = "Blick" | caption-override="Only here"`;
    const invalid = fence(raw, '\n');
    const unresolved = await normalizeGalleryFences(invalid.replace('alt = ', 'alt='), {});
    expect(unresolved.bodyMarkdown).toBe(invalid.replace('alt = ', 'alt='));
    expect(unresolved.images).toEqual({});
    expect(unresolved.galleryWarnings).toEqual([]);
    const repaired = await normalizeGalleryFences(invalid.replace('alt = ', 'alt='), { [src]: { width: 30, height: 20 } });
    expect(repaired.galleryWarnings).toEqual([]);
    expect(repaired.bodyMarkdown).toBe(fence(`${src} | caption-override="Only here"`, '\n'));
    expect(repaired.images[src]).toEqual({ width: 30, height: 20, alt: 'Blick' });
  });

  it('normalizes unrelated valid lines and lets only valid duplicate occurrences change shared metadata', async () => {
    const invalid = ` ${src} | 999x777 | alt="ignored" | capton="keep bytes"  `;
    const body = fence(invalid, '\n') + '\n' + fence(`${src} | 30x20 | alt="valid" | caption-override="local"`, '\n');
    const untouched = { width: 1, height: 2, alt: 'other' };
    const saved = await normalizeGalleryFences(body, { other: untouched });
    expect(saved.bodyMarkdown).toBe(fence(invalid, '\n') + '\n' + fence(`${src} | caption-override="local"`, '\n'));
    expect(saved.images).toEqual({ other: untouched, [src]: { width: 30, height: 20, alt: 'valid' } });
    expect(await normalizeGalleryFences(saved.bodyMarkdown, saved.images)).toEqual(saved);
  });

  it('maps the first bad field through original source provenance, not normalized line numbers', async () => {
    const body = '<BodyImage\n src="https://img/inline"\n width={20}\n height={10}\n/>\n\n'
      + '> - ~~~gallery extra\r\n>   ' + src + ' | alt="🦋" | capton="first" | alt=\'second\'\r\n>   ~~~';
    const analysis = await analyzeGallerySource(body);
    const offset = body.indexOf('capton=');
    const prefix = body.slice(0, offset).split(/\r\n|\r|\n/);
    expect(galleryWarnings(analysis, 'en')).toEqual([{ code: 'invalid_gallery_metadata', locale: 'en',
      line: prefix.length, column: prefix.at(-1)!.length + 1, field: 'unknown', reason: 'unknown_field' }]);
  });

  it('maps raw HTML entity and inline-tag provenance while preserving all invalid source bytes', async () => {
    const body = '<pre><code class="language-gallery"><span>' + src + '</span> &#124; alt=&quot;🦋&quot; &#124; capton=&quot;bad&quot;\n</code></pre>';
    const saved = await normalizeGalleryFences(body, { [src]: { width: 30, height: 20 } });
    expect(saved.bodyMarkdown).toBe(body);
    expect(saved.galleryWarnings).toEqual([{ code: 'invalid_gallery_metadata', line: 1,
      column: body.indexOf('capton=') + 1, field: 'unknown', reason: 'unknown_field' }]);
  });
});
