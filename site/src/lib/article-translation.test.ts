import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { visit } from 'unist-util-visit';
import type { Element } from 'hast';
import { prepareTranslation, validateTranslation, TranslationError } from './article-translation.js';
import { analyzeGallerySource } from './gallery-source.js';
import { parsePhotoLine } from '../../../uploader/public/gallery-photo-line.js';
import { normalizeGalleryFences } from '../../../uploader/src/body-content.js';
import { normalizeBodyImages } from '../../../uploader/src/posts.js';
import { renderMarkdown } from './render-markdown.js';
import { analyzeRenderedBody, STORY_BODY_SIZES, transformBodyImagesWithUses, type ImageDims } from './body-images.js';
import { textOf } from './gallery-identity.js';

const origin = 'https://images.example';
const first = `${origin}/journey/first`;
const second = `${origin}/journey/second`;
const inline = `${origin}/journey/inline`;
const unused = `${origin}/unrelated/photo`;
interface Article { title: string; excerpt: string; bodyMarkdown: string; images: Record<string, ImageDims> }
interface Fixture { sourceLocale: 'de' | 'en'; targetLocale: 'de' | 'en'; source: Article }
interface Response { translations: { id: string; text: string }[] }

function fixture(bodyMarkdown = 'Ein Weg', source: Partial<Article> = {}): Fixture {
  return { sourceLocale: 'de', targetLocale: 'en', source: { title: '', excerpt: '', bodyMarkdown, images: {}, ...source } };
}

async function translate(input: Fixture, convert: (text: string) => string = (text) => `Translated ${text}`) {
  const prepared = await prepareTranslation(input);
  const output = { translations: prepared.slots.map(({ id, text }) => ({ id, text: convert(text) })) };
  return { ...prepared, output, result: await validateTranslation(input, output) };
}

function elements(html: string, name: string): Element[] {
  const found: Element[] = [];
  visit(unified().use(rehypeParse, { fragment: true }).parse(html), 'element', (node) => {
    if (node.tagName === name) found.push(node);
  });
  return found;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

async function rejectInput(input: unknown, code = 'translation_invalid_input') {
  await expect(prepareTranslation(input)).rejects.toMatchObject({ name: 'TranslationError', code, message: code });
}

async function rejectOutput(input: Fixture, output: unknown, code = 'translation_invalid_output') {
  const original = structuredClone(input);
  await expect(validateTranslation(input, output)).rejects.toMatchObject({ name: 'TranslationError', code, message: code });
  expect(input).toEqual(original);
}

describe('article translation protected source compiler', () => {
  it.each(['de', 'en'] as const)('translates the latest %s source with exact image identities, order, layout and non-text bytes', async (locale) => {
    const words = locale === 'de'
      ? { title: 'Reisetag', excerpt: 'Unterwegs', heading: 'Ankunft', before: 'Vorher', strong: 'Berg', label: 'Karte', middle: 'Danach', alt: 'Gipfel', imageTitle: 'Morgen', caption: 'Erster Blick' }
      : { title: 'Travel day', excerpt: 'On the road', heading: 'Arrival', before: 'Before', strong: 'Mountain', label: 'Map', middle: 'After', alt: 'Summit', imageTitle: 'Morning', caption: 'First view' };
    const body = [
      `## ${words.heading}`, '', `${words.before} **${words.strong}** [${words.label}](https://example.test/map?a=1#north "Unchanged link title")`, '',
      `![${words.alt}](<${inline}> "${words.imageTitle}")`, '',
      '~~~gallery extra-information', '#layout: slider', '#future-directive: keep exactly',
      `${first} | 1600x1000 | format="jpeg" | alt="Stored line" | caption="Line caption" | caption-override="${words.caption}"`,
      `${second} | caption-override=""`, `${first} | caption-override="Second occurrence"`, '~~~', '',
      words.middle, '', '```gallery', '#layout: column', '#captions: hidden', `${second} | caption-override="Hidden caption"`, '```', '',
      '[Fixed reference]: https://example.test/reference "Unchanged definition"',
    ].join('\r\n');
    const input = deepFreeze({ ...fixture(body, {
      title: words.title, excerpt: words.excerpt,
      images: {
        [first]: { width: 1600, height: 1000, format: 'jpeg', alt: 'Stored first alt', caption: 'Stored first caption' },
        [second]: { width: 1200, height: 1800, alt: 'Stored second alt', caption: 'Stored second caption' },
        [inline]: { width: 800, height: 600 },
        [unused]: { width: 400, height: 300, alt: 'PRIVATE unrelated metadata', caption: 'Unrelated fallback' },
      },
    }), sourceLocale: locale, targetLocale: locale === 'de' ? 'en' as const : 'de' as const });
    const original = structuredClone(input);
    const { result, slots, warnings } = await translate(input);
    expect(input).toEqual(original);
    expect(result.title).toBe(`Translated ${words.title}`);
    expect(result.excerpt).toBe(`Translated ${words.excerpt}`);
    let expected = body;
    for (const word of [words.heading, words.before, words.strong, words.label, words.alt, words.imageTitle, words.caption,
      words.middle, 'Stored line', 'Line caption', 'Second occurrence', 'Hidden caption']) expected = expected.replace(word, `Translated ${word}`);
    expect(result.bodyMarkdown).toBe(expected);
    expect(result.images).toEqual({
      [first]: { ...original.source.images[first], alt: 'Translated Stored first alt', caption: 'Translated Stored first caption' },
      [second]: { ...original.source.images[second], alt: 'Translated Stored second alt', caption: 'Translated Stored second caption' },
      [inline]: original.source.images[inline],
    });
    expect(warnings).toContain('library-metadata-authoritative');
    expect(warnings).not.toContain('headings-retained-for-fragments');
    expect(slots.every((slot) => Object.keys(slot).sort().join() === 'id,text')).toBe(true);
    expect(new Set(slots.map((slot) => slot.id)).size).toBe(slots.length);
    expect(slots.every((slot) => /^s[\da-z]{4}$/.test(slot.id))).toBe(true);
    expect(JSON.stringify(slots)).not.toMatch(/https:|PRIVATE|1600|future-directive|format=/);
    const galleries = (await analyzeGallerySource(result.bodyMarkdown)).blocks.filter((block) => block.isGallery);
    expect(galleries.map((block) => block.lines.filter((line) => !line.text.startsWith('#')).map((line) => parsePhotoLine(line.text).src)))
      .toEqual([[first, second, first], [second]]);
    expect(result.bodyMarkdown).toContain('caption-override=""');
    expect(result.bodyMarkdown).toContain('#captions: hidden');
    expect(result.bodyMarkdown).toContain('[Fixed reference]: https://example.test/reference "Unchanged definition"');
  });

  it('keeps every source byte when a complete identity translation is returned', async () => {
    const body = [
      '🗺️ "Café" -- Japan...', '', '> - Ein &amp; zwei', '>   nächste Zeile', '',
      '- [x] Erledigt', '- [ ] Später', '', '| Spalte | Wert |', '| :--- | ---: |', '| Straße | Überall |', '',
      `![Berg \\[Norwegen\\]](${inline} 'Ein &quot;Titel&quot;')`, '',
      '> ~~~gallery extra', `> ${first}  |  1600x1000 | alt="Alt &amp; mehr" | caption-override=""`, '> ~~~', '',
      '<aside data-private="keep">Raw &copy; text</aside>', '', '```js', 'const untouched = "all bytes";', '```', '',
    ].join('\r\n');
    const input = fixture(body, { title: '  Titel  ', excerpt: '  Kurztext\n', images: { [first]: { width: 1600, height: 1000, alt: '' } } });
    const { result } = await translate(input, (value) => value);
    expect(result).toEqual(input.source);
  });

  it('retains CRLF, indentation, list markers, quote prefixes, tasks, tables and emphasis while translating text', async () => {
    const body = '> - Zeile eins\r\n>   Zeile zwei **stark**\r\n\r\n- [x] Fertig\r\n- [ ] Offen\r\n\r\n| Links | Rechts |\r\n| :--- | ---: |\r\n| Oben | Unten |';
    const { result } = await translate(fixture(body));
    expect(result.bodyMarkdown).toBe('> - Translated Zeile eins\r\n>   Translated Zeile zwei **Translated stark**\r\n\r\n- [x] Translated Fertig\r\n- [ ] Translated Offen\r\n\r\n| Translated Links | Translated Rechts |\r\n| :--- | ---: |\r\n| Translated Oben | Translated Unten |');
  });

  it('preserves raw HTML gallery wrappers, entities, nested galleries, unknown directives and repeated photo occurrences', async () => {
    const body = [
      'Vorher', '', '<pre>literal before',
      `<pre id="keep"><code class="language-gallery">#layout: column\n#unknown: exact\n<b>${first}</b> | caption-override=&quot;Erste &amp;amp; zweite &#x1F5FA; &NotEqualTilde;&quot;\n${first} | caption-override=&quot;Andere&quot;</code></pre>`,
      'literal after</pre>', '',
      `> - <pre data-extra="unchanged"><code class="language-gallery">${second} | caption-override=&quot;Dritte&quot;</code></pre>`, '', 'Nachher',
    ].join('\n');
    const { result, warnings } = await translate(fixture(body, { images: {
      [first]: { width: 1600, height: 1000 }, [second]: { width: 1200, height: 900 },
    } }));
    expect(warnings).toContain('opaque-source-retained');
    expect(result.bodyMarkdown).toContain('<pre>literal before\n<pre id="keep"><code class="language-gallery">#layout: column\n#unknown: exact\n<b>');
    expect(result.bodyMarkdown).toContain('</code></pre>\nliteral after</pre>');
    expect(result.bodyMarkdown).toContain('> - <pre data-extra="unchanged"><code class="language-gallery">');
    const analysis = await analyzeGallerySource(result.bodyMarkdown);
    const lines = analysis.blocks.filter((block) => block.isGallery).flatMap((block) => block.lines).filter((line) => !line.text.startsWith('#'));
    expect(lines.map((line) => parsePhotoLine(line.text))).toMatchObject([
      { src: first, captionOverride: 'Translated Erste & zweite 🗺 ≂̸' },
      { src: first, captionOverride: 'Translated Andere' },
      { src: second, captionOverride: 'Translated Dritte' },
    ]);
    expect(analyzeRenderedBody(await renderMarkdown(result.bodyMarkdown)).galleryLines).toEqual([first, first, second]);
  });

  it('preserves HTML tags between segments of one occurrence-local caption', async () => {
    const body = `<pre><code class="language-gallery">${first} | caption-override=&quot;Eine <b>andere</b> Sicht&quot;</code></pre>`;
    const { result } = await translate(fixture(body));
    expect(result.bodyMarkdown).toContain('<b>');
    expect(result.bodyMarkdown).toContain('</b>');
    const gallery = (await analyzeGallerySource(result.bodyMarkdown)).blocks.find((block) => block.isGallery)!;
    expect(parsePhotoLine(gallery.lines[0]!.text)).toMatchObject({ src: first, captionOverride: 'Translated Eine andere Sicht' });
  });

  it('keeps invalid gallery metadata wholly opaque while preserving its renderer-visible photo and fallback', async () => {
    const malformed = `${first} | caption-override="Do not translate" | future="opaque"`;
    const { result, slots, warnings } = await translate(fixture(`Vorher\n\n~~~gallery\n${malformed}\n~~~\n\nNachher`, {
      images: { [first]: { width: 100, height: 50, alt: 'Fallback' } },
    }));
    expect(result.bodyMarkdown).toContain(malformed);
    expect(slots.map((slot) => slot.text)).not.toContain('Do not translate');
    expect(result.images[first]?.alt).toBe('Translated Fallback');
    expect(warnings).toContain('opaque-source-retained');
  });

  it('translates supported Markdown and raw image descriptions without rewriting destinations, attributes or dimensions', async () => {
    const body = [
      `![Inline](<${inline}?size=large> "Image title")`, '',
      `![Referenced][PHOTO]`, '', `[PHOTO]: <${second}> "Preserved reference title"`, '',
      `<BodyImage src="${first}" width={1600} height={1000} format="jpeg" alt="Body &amp; image" />`, '',
      `<img data-keep="exact" src='${second}' width="1200" height="900" alt='Raw alt' title="Raw title">`, '',
      `![Shortcut]`, '', `[Shortcut]: ${inline}`, '',
    ].join('\n');
    const input = fixture(body, { images: {
      [first]: { width: 1600, height: 1000, format: 'jpeg' },
      [second]: { width: 1200, height: 900 },
      [inline]: { width: 800, height: 600 },
      [`${inline}?size=large`]: { width: 800, height: 600 },
    } });
    const { result, warnings, slots } = await translate(input);
    expect(result.bodyMarkdown).toBe(body.replace('![Inline]', '![Translated Inline]').replace('"Image title"', '"Translated Image title"')
      .replace('![Referenced]', '![Translated Referenced]').replace('alt="Body &amp; image"', 'alt="Translated Body &amp;#38; image"')
      .replace("alt='Raw alt'", "alt='Translated Raw alt'").replace('title="Raw title"', 'title="Translated Raw title"'));
    expect(result.images).toEqual(input.source.images);
    expect(slots.map((slot) => slot.text)).not.toContain('Preserved reference title');
    expect(slots.map((slot) => slot.text)).not.toContain('Shortcut');
    expect(warnings).toContain('opaque-source-retained');
  });

  it('supports multiline BodyImage attributes inside quote/list containers without changing attribute ownership', async () => {
    const body = `> - <BodyImage\n>   src="${first}"\n>   width={1600} height={1000}\n>   alt="Blick &amp; Berg" />`;
    const { result } = await translate(fixture(body), (value) => value === 'Blick & Berg' ? 'View & mountain' : value);
    expect(result.bodyMarkdown).toBe(body.replace('Blick &amp; Berg', 'View &amp;#38; mountain'));
  });

  it('round-trips BodyImage text through the actual save normalizer and renderer without changing dimensions or assets', async () => {
    const body = `> - <BodyImage src="${first}" width={1600} height={1000} format="jpeg" alt="Vorher" />`;
    const converted = 'View & "quote" <mountain>\nSecond line [place]';
    const { result } = await translate(fixture(body), () => converted);
    expect(result.bodyMarkdown).toContain(`src="${first}" width={1600} height={1000} format="jpeg"`);
    expect(result.bodyMarkdown).toContain('&amp;#10;Second line');
    const saved = await normalizeBodyImages(result.bodyMarkdown, result.images);
    expect(saved.images).toEqual({ [first]: { width: 1600, height: 1000, format: 'jpeg' } });
    expect(analyzeRenderedBody(await renderMarkdown(saved.bodyMarkdown)).sources).toEqual([first]);
    expect(elements(await renderMarkdown(saved.bodyMarkdown), 'img')[0]?.properties.alt).toBe(converted);
    expect((await prepareTranslation({ ...fixture(result.bodyMarkdown), sourceLocale: 'en', targetLocale: 'de' })).slots[0]?.text).toBe(converted);
  });

  it('retains code, math, frontmatter, unsupported directives and raw blocks, translating prose around them only', async () => {
    const opaque = [
      '```ts\nconst privateCode = "DO NOT SEND";\n```',
      '$$\nE = mc^2\n$$',
      ':::warning\nOpaque directive body\n:::',
      '<section data-internal="private"><p>Raw body text</p><!-- keep --></section>',
      '    indented code body',
    ];
    const body = `---\nprivate: frontmatter\n---\n\nVorher\n\n${opaque.join('\n\n')}\n\nNachher mit \`literal code\` und $a+b$ weiter`;
    const { result, slots, warnings } = await translate(fixture(body));
    for (const block of opaque) expect(result.bodyMarkdown).toContain(block);
    expect(result.bodyMarkdown).toContain('---\nprivate: frontmatter\n---');
    expect(result.bodyMarkdown).toContain('`literal code`');
    expect(result.bodyMarkdown).toContain('$a+b$');
    expect(result.bodyMarkdown).toContain('Translated Vorher');
    expect(result.bodyMarkdown).toContain('Translated Nachher mit');
    expect(result.bodyMarkdown).toContain('Translated weiter');
    expect(JSON.stringify(slots)).not.toMatch(/DO NOT SEND|mc\^2|directive body|Raw body text|private:|literal code|indented code/);
    expect(warnings).toContain('opaque-source-retained');
  });

  it('never turns automatic URLs or shortcut/collapsed reference identities into translation slots', async () => {
    const body = 'Siehe <https://example.test/secret?x=1> und https://example.test/automatic\n\n[Beschreibung][ref] [ref][] [ref]\n\n[ref]: https://example.test/fixed';
    const { result, slots, warnings } = await translate(fixture(body));
    expect(JSON.stringify(slots)).not.toContain('https:');
    expect(slots.map((slot) => slot.text)).toContain('Beschreibung');
    expect(slots.map((slot) => slot.text)).not.toContain('ref');
    expect(result.bodyMarkdown).toContain('[Translated Beschreibung][ref] [ref][] [ref]');
    expect(result.bodyMarkdown).toContain('<https://example.test/secret?x=1>');
    expect(result.bodyMarkdown).toContain('https://example.test/automatic');
    expect(warnings).toContain('opaque-source-retained');
  });

  it('discloses malformed unsupported images instead of repairing or dropping author source', async () => {
    const raw = '<BodyImage src="missing" alt="Retain" width={100}>opaque</BodyImage>';
    const { result, slots, warnings } = await translate(fixture(`Vorher\n\n${raw}\n\nNachher`));
    expect(result.bodyMarkdown).toContain(raw);
    expect(slots.map((slot) => slot.text)).not.toContain('Retain');
    expect(slots.map((slot) => slot.text)).not.toContain('opaque');
    expect(warnings).toContain('opaque-source-retained');
  });

  it('retains nested and unclosed unsupported component contents as one opaque source region', async () => {
    for (const raw of [
      '<BodyImage src="outer"><BodyImage src="inner">Keep **this**</BodyImage> and that</BodyImage>',
      '<BodyImage src="unclosed">Keep **all** remaining text',
    ]) {
      const { result, slots, warnings } = await translate(fixture(`Vorher ${raw}`));
      expect(result.bodyMarkdown).toBe(`Translated Vorher ${raw}`);
      expect(slots.map((slot) => slot.text)).toEqual(['Vorher']);
      expect(warnings).toContain('opaque-source-retained');
    }
  });

  it.each([
    `~~~gallery\n${first} | caption-override="Unclosed"`,
    `<pre><code class="language-gallery">${first} | caption-override="Unclosed"`,
  ])('rejects unsafe gallery closure provenance before producing any slots', async (body) => {
    await rejectInput(fixture(body), 'translation_unsupported_source');
  });

  it('keeps intentionally empty and whitespace-only fields without requesting or inventing text', async () => {
    const source = fixture(`![ ](${inline} "")\n\n~~~gallery\n${first} | alt="" | caption="  " | caption-override=""\n~~~`, {
      title: '  ', excerpt: '', images: { [first]: { width: 100, height: 50, alt: '', caption: '  ' }, [inline]: { width: 20, height: 10 } },
    });
    const prepared = await prepareTranslation(source);
    expect(prepared.slots).toEqual([]);
    expect(await validateTranslation(source, { translations: [] })).toEqual(source.source);
  });
});

describe('article translation renderer-backed metadata authority and fragments', () => {
  it.each(['column', 'breakout', 'slider'])('retains library authority, empty overrides, hidden captions and repeated occurrences in %s', async (layout) => {
    const body = [
      '~~~gallery', `#layout: ${layout}`, first, second, `${first} | caption-override="Local one"`,
      `${first} | caption-override=""`, `${first} | caption-override="Local two"`, '~~~', '',
      '```gallery', '#captions: hidden', `${first} | caption-override="Hidden local"`, second, '```', '',
      `![Inline local](${first})`,
    ].join('\n');
    const input = fixture(body, { images: {
      [first]: { width: 1600, height: 1000, alt: 'Stored alt', caption: 'Stored caption' },
      [second]: { width: 1200, height: 900, alt: 'Unresolved alt', caption: 'Unresolved caption', format: 'jpeg' },
    } });
    const library = new Map([[first, { alt: '', caption: '' }]]);
    const originalLibrary = structuredClone(library);
    const { result } = await translate(input);
    const normalized = await normalizeGalleryFences(result.bodyMarkdown, result.images);
    expect(normalized.images[first]).toEqual({ width: 1600, height: 1000, alt: 'Translated Stored alt', caption: 'Translated Stored caption' });
    expect(normalized.images[first]?.caption).not.toContain('Local');
    const rendered = await transformBodyImagesWithUses(await renderMarkdown(normalized.bodyMarkdown), normalized.images, origin,
      { locale: 'en', inlineSizes: STORY_BODY_SIZES }, library);
    expect(library).toEqual(originalLibrary);
    expect(rendered.gallery).toEqual([
      { src: first, alt: '', caption: '', captionFollowsLibrary: true },
      { src: second, alt: 'Translated Unresolved alt', caption: 'Translated Unresolved caption', captionFollowsLibrary: true },
      { src: first, alt: '', caption: null, captionFollowsLibrary: false },
      { src: first, alt: '', caption: null, captionFollowsLibrary: false },
      { src: first, alt: '', caption: null, captionFollowsLibrary: false },
      { src: first, alt: '', caption: null, captionFollowsLibrary: false },
      { src: second, alt: 'Translated Unresolved alt', caption: null, captionFollowsLibrary: false },
    ]);
    expect(elements(rendered.html, 'figcaption').map(textOf)).toEqual(['Translated Unresolved caption', 'Translated Local one', 'Translated Local two']);
    expect(elements(rendered.html, 'img').at(-1)?.properties.alt).toBe('Translated Inline local');
    expect(result.bodyMarkdown).toContain('caption-override="Translated Hidden local"');
    expect(result.bodyMarkdown).toContain('caption-override=""');
  });

  it.each(['[Zum Ziel](#ziel)', '[Zum Ziel][anchor]\n\n[anchor]: #ziel', '<a href="#ziel">Zum Ziel</a>'])('retains the entire heading set and real renderer IDs for local fragment form %s', async (link) => {
    const body = ['# Ziel', '', '# Ziel', '', '# Other', '', '## Noch ein Ziel', '', link, '', 'Weiter'].join('\n');
    const input = fixture(body, { title: 'Translated title' });
    const before = await renderMarkdown(body);
    const { result, slots, warnings } = await translate(input, (value) => value === 'Other' ? 'Ziel' : `Changed ${value}`);
    expect(warnings).toContain('headings-retained-for-fragments');
    for (const title of ['Ziel', 'Other', 'Noch ein Ziel']) expect(slots.map((slot) => slot.text)).not.toContain(title);
    expect(result.bodyMarkdown).toContain('# Ziel\n\n# Ziel\n\n# Other\n\n## Noch ein Ziel');
    const after = await renderMarkdown(result.bodyMarkdown);
    const headingIds = (html: string) => ['h1', 'h2'].flatMap((tag) => elements(html, tag).map((node) => node.properties.id));
    expect(headingIds(after)).toEqual(headingIds(before));
    expect(elements(after, 'a').some((node) => node.properties.href === '#ziel')).toBe(true);
    expect(headingIds(after)).toContain('ziel');
    expect(headingIds(after)).toContain('ziel-1');
  });

  it('allows heading translation when no local fragment identity depends on it', async () => {
    const { result, warnings } = await translate(fixture('# Ankunft\n\n[Link](https://example.test/#arrival)'), (value) => value === 'Ankunft' ? 'Arrival' : value);
    expect(result.bodyMarkdown).toContain('# Arrival');
    expect(warnings).not.toContain('headings-retained-for-fragments');
    expect(elements(await renderMarkdown(result.bodyMarkdown), 'h1')[0]?.properties.id).toBe('arrival');
  });
});

describe('article translation strict, atomic untrusted boundaries', () => {
  it('uses complete opaque IDs rather than trusting model array order, ranges or returned structure', async () => {
    const input = fixture('Ein **Berg**', { title: 'Titel', excerpt: 'Kurztext' });
    const { slots } = await prepareTranslation(input);
    const output = { translations: slots.map(({ id, text }) => ({ id, text: `New ${text}` })).reverse() };
    expect(await validateTranslation(input, output)).toEqual({ title: 'New Titel', excerpt: 'New Kurztext', bodyMarkdown: 'New Ein **New Berg**', images: {} });
    await rejectOutput(input, { ...output, bodyMarkdown: '<script>attack</script>' });
    await rejectOutput(input, { translations: output.translations.map((entry) => ({ ...entry, start: 0, end: 100 })) });
  });

  it('entity-escapes hostile punctuation as literal text without introducing links, galleries, HTML or changed image identities', async () => {
    const body = `Vorher **Berg** [Karte](https://example.test/keep)\n\n![Blick](${inline} "Titel")\n\n~~~gallery\n${first} | caption-override="Lokal"\n~~~`;
    const input = fixture(body, { images: { [first]: { width: 200, height: 100, alt: 'Fallback' }, [inline]: { width: 100, height: 100 } } });
    const hostile = '<img src="x" onerror="alert(1)"> & [new](javascript:bad) | **bold** `code`\n```gallery\nuntrusted-image\n```';
    const { result } = await translate(input, () => hostile);
    const rendered = await renderMarkdown(result.bodyMarkdown);
    expect(analyzeRenderedBody(rendered).sources).toEqual([inline]);
    expect(analyzeRenderedBody(rendered).galleryLines).toEqual([first]);
    expect(elements(rendered, 'a').map((node) => node.properties.href)).toEqual(['https://example.test/keep']);
    expect(elements(rendered, 'img')).toHaveLength(1);
    expect(elements(rendered, 'script')).toHaveLength(0);
    expect(elements(rendered, 'img')[0]?.properties.alt).toBe(hostile);
    const normalized = await normalizeGalleryFences(result.bodyMarkdown, result.images);
    const final = await transformBodyImagesWithUses(rendered, normalized.images, origin, { locale: 'en', inlineSizes: STORY_BODY_SIZES });
    expect(elements(final.html, 'figcaption').map(textOf)).toEqual([hostile]);
    expect(final.gallery.map((photo) => photo.src)).toEqual([first]);
  });

  it('atomically refuses text which the canonical GFM parser autolinks even after entity escaping', async () => {
    const input = fixture(`Vorher **Berg** [Karte](https://example.test/keep)\n\n![Blick](${inline} "Titel")\n\n~~~gallery\n${first} | caption-override="Lokal"\n~~~`, {
      images: { [first]: { width: 200, height: 100, alt: 'Fallback' }, [inline]: { width: 100, height: 100 } },
    });
    const hostile = '<img src="https://evil.test/x" onerror="alert(1)"> & [new](javascript:bad) | **bold** `code`\n```gallery\nhttps://evil.test/injected\n```';
    const { slots } = await prepareTranslation(input);
    for (const value of [hostile, 'https://evil.test/new', 'www.evil.test', 'name@evil.test']) {
      await rejectOutput(input, { translations: slots.map(({ id }) => ({ id, text: value })) }, 'translation_structure_mismatch');
    }
  });

  it('rejects missing, duplicate, extra, malformed, prototype and incomplete translations without mutation', async () => {
    const input = fixture('Weg', { title: 'Titel', excerpt: 'Kurztext' });
    const { slots } = await prepareTranslation(input);
    const translations = slots.map(({ id, text }) => ({ id, text: `New ${text}` }));
    const bad: unknown[] = [null, [], {}, { translations: null }, { translations: {} },
      { translations: translations.slice(1) }, { translations: [...translations, { id: 'other', text: 'extra' }] },
      { translations: translations.map((item, index) => index === 1 ? translations[0] : item) },
      { translations: translations.map((item, index) => index === 0 ? { id: 'szzzz', text: 'unknown' } : item) },
      { translations: translations.map((item, index) => index === 0 ? { ...item, extra: true } : item) },
      { translations: translations.map((item, index) => index === 0 ? { ...item, text: { type: 'raw', value: '<script>' } } : item) },
      JSON.parse('{"translations":[],"__proto__":{"polluted":true}}') as unknown,
      Object.assign(Object.create({ translations }), {}),
      { translations: Object.assign([...translations], { bodyMarkdown: 'attack' }) },
      Object.defineProperty({ translations }, 'hidden', { value: 'attack' }),
    ];
    for (const output of bad) await rejectOutput(input, output);
    expect({}).not.toHaveProperty('polluted');
  });

  it('requires non-whitespace translation for every title, excerpt, prose, inline description, local override and stored fallback slot', async () => {
    const input = fixture(`Weg\n\n![Blick](${inline} "Titeltext")\n\n~~~gallery\n${first} | alt="Alttext" | caption="Captiontext" | caption-override="Override"\n~~~`, {
      title: 'Titel', excerpt: 'Kurztext', images: { [first]: { width: 100, height: 50, alt: 'Stored alt', caption: 'Stored caption' } },
    });
    const { slots } = await prepareTranslation(input);
    expect(slots.map((slot) => slot.text)).toEqual(expect.arrayContaining(['Titel', 'Kurztext', 'Weg', 'Blick', 'Titeltext', 'Alttext', 'Captiontext', 'Override', 'Stored alt', 'Stored caption']));
    for (let index = 0; index < slots.length; index++) {
      for (const empty of ['', ' \t\r\n ']) {
        const output = { translations: slots.map(({ id, text }, offset) => ({ id, text: offset === index ? empty : text })) };
        await rejectOutput(input, output);
      }
    }
  });

  it.each(['\0', '\u000b', '\u001b', '\u007f', '\u0085', '\u202e', '\u2066', '\ud800', '\udfff'])('rejects control or malformed Unicode %j in input and output with fixed source-free errors', async (character) => {
    const input = fixture('SECRET source');
    await rejectInput(fixture(`SECRET ${character}`));
    await rejectInput(fixture('Body', { title: `SECRET ${character}` }));
    const { slots } = await prepareTranslation(input);
    await rejectOutput(input, { translations: slots.map(({ id }) => ({ id, text: `SECRET ${character}` })) });
  });

  it('rejects invalid source shapes, direction, dimensions and unallowlisted metadata', async () => {
    const base = fixture('SECRET');
    for (const input of [undefined, null, [], {}, { ...base, sourceLocale: 'fr' }, { ...base, targetLocale: 'de' },
      { ...base, extra: 'shared' }, { ...base, source: { ...base.source, slug: 'must-not-change' } },
      { ...base, source: { ...base.source, title: 42 } }, { ...base, source: { ...base.source, images: [] } },
      fixture('', { images: { [first]: { width: 0, height: 1 } } }),
      fixture('', { images: { [first]: { width: 1.5, height: 1 } } }),
      fixture('', { images: { [first]: { width: 1, height: Infinity } } }),
      { ...base, source: { ...base.source, images: { [first]: { width: 1, height: 1, format: 'png' } } } },
      { ...base, source: { ...base.source, images: { [first]: { width: 1, height: 1, alt: { type: 'raw' } } } } },
      { ...base, source: { ...base.source, images: { [first]: { width: 1, height: 1, gps: 'private' } } } },
      { ...base, source: { ...base.source, images: JSON.parse('{"__proto__":{"width":1,"height":1}}') as unknown } },
    ]) await rejectInput(input);
    expect(new TranslationError('translation_invalid_input').message).toBe('translation_invalid_input');
  });
});

describe('article translation bounded inputs and complete outputs', () => {
  it.each([
    ['title', 1000], ['excerpt', 4000], ['bodyMarkdown', 100_000],
  ] as const)('accepts the exact %s input limit and rejects excess without truncation', async (field, max) => {
    const input = fixture('', { [field]: 'a'.repeat(max) });
    expect((await prepareTranslation(input)).slots[0]?.text).toHaveLength(max);
    await rejectInput(fixture('', { [field]: 'a'.repeat(max + 1) }), 'translation_input_limit');
  });

  it('counts UTF-16 code units, including astral characters', async () => {
    expect((await prepareTranslation(fixture('', { title: '🗺'.repeat(500) }))).slots[0]?.text).toHaveLength(1000);
    await rejectInput(fixture('', { title: '🗺'.repeat(501) }), 'translation_input_limit');
  });

  it('caps image-map entries before selecting only body references', async () => {
    const images = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`${origin}/${index}`, { width: 1, height: 1 }]));
    const accepted = fixture('', { images });
    expect(await validateTranslation(accepted, { translations: [] })).toEqual({ ...accepted.source, images: {} });
    await rejectInput(fixture('', { images: { ...images, [`${origin}/excess`]: { width: 1, height: 1 } } }), 'translation_input_limit');
  });

  it('caps every source image description, including unrelated map text and encoded photo-line fields', async () => {
    for (const field of ['alt', 'caption'] as const) {
      const valid = fixture(`~~~gallery\n${first}\n~~~`, { images: { [first]: { width: 1, height: 1, [field]: 'a'.repeat(1000) } } });
      expect((await prepareTranslation(valid)).slots[0]?.text).toHaveLength(1000);
      await rejectInput(fixture('', { images: { [unused]: { width: 1, height: 1, [field]: 'a'.repeat(1001) } } }), 'translation_input_limit');
    }
    for (const field of ['alt', 'caption', 'caption-override']) {
      await rejectInput(fixture(`~~~gallery\n${first} | ${field}="${'a'.repeat(1001)}"\n~~~`), 'translation_input_limit');
      const valid = fixture(`~~~gallery\n${first} | ${field}="${'&amp;'.repeat(1000)}"\n~~~`);
      expect((await prepareTranslation(valid)).slots[0]?.text).toHaveLength(1000);
    }
    await rejectInput(fixture(`![${'a'.repeat(1001)}](${inline})`), 'translation_input_limit');
    await rejectInput(fixture(`<img src="${inline}" alt="${'a'.repeat(1001)}">`), 'translation_input_limit');
    await rejectInput(fixture(`<BodyImage src="${inline}" width={1} height={1} alt="${'a'.repeat(1001)}" />`), 'translation_input_limit');
  });

  it('caps slots across all fields without dropping the final paragraph', async () => {
    const body = Array.from({ length: 2000 }, () => 'a').join('\n\n');
    expect((await prepareTranslation(fixture(body))).slots).toHaveLength(2000);
    await rejectInput(fixture(body, { title: 'one more' }), 'translation_input_limit');
  });

  it('caps aggregate source text separately from individual field/body limits', async () => {
    const accepted = fixture('b'.repeat(99_000), { title: 't'.repeat(1000) });
    expect((await prepareTranslation(accepted)).slots.reduce((total, slot) => total + slot.text.length, 0)).toBe(100_000);
    await rejectInput(fixture('b'.repeat(99_001), { title: 't'.repeat(1000) }), 'translation_input_limit');
  });

  it.each([
    ['title', 1000], ['excerpt', 4000], ['prose', 12_000], ['inline alt', 1000], ['inline title', 1000], ['caption', 1000], ['stored alt', 1000],
  ] as const)('enforces the %s output limit without truncation', async (kind, max) => {
    const input = kind === 'title' ? fixture('', { title: 'Text' })
      : kind === 'excerpt' ? fixture('', { excerpt: 'Text' })
      : kind === 'inline alt' ? fixture(`![Text](${inline})`)
      : kind === 'inline title' ? fixture(`![](${inline} "Text")`)
      : kind === 'caption' ? fixture(`~~~gallery\n${first} | caption-override="Text"\n~~~`)
      : kind === 'stored alt' ? fixture(`~~~gallery\n${first}\n~~~`, { images: { [first]: { width: 1, height: 1, alt: 'Text' } } })
      : fixture('Text');
    const { slots } = await prepareTranslation(input);
    expect(slots).toHaveLength(1);
    const output: Response = { translations: [{ id: slots[0]!.id, text: 'x'.repeat(max) }] };
    await expect(validateTranslation(input, output)).resolves.toBeDefined();
    await rejectOutput(input, { translations: [{ id: slots[0]!.id, text: 'x'.repeat(max + 1) }] });
  });

  it('enforces the aggregate translated text cap independently of the per-slot cap', async () => {
    const accepted = fixture(Array.from({ length: 25 }, () => 'a').join('\n\n'));
    const acceptedSlots = (await prepareTranslation(accepted)).slots;
    const result = await validateTranslation(accepted, { translations: acceptedSlots.map(({ id }) => ({ id, text: 'x'.repeat(12_000) })) });
    expect(result.bodyMarkdown.replace(/\n/g, '')).toHaveLength(300_000);
    const rejected = fixture(Array.from({ length: 26 }, () => 'a').join('\n\n'));
    const slots = (await prepareTranslation(rejected)).slots;
    await rejectOutput(rejected, { translations: slots.map(({ id }, index) => ({ id, text: 'x'.repeat(index < 25 ? 12_000 : 1) })) });
  });
});
