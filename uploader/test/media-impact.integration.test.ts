import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mediaImpact } from '../src/media-impact.js';
import { memoryPostStore, pgPostStore, type PostPair } from '../src/posts.js';
import { memoryLanguageStore } from '../src/language.js';
import { createPool, ensureSchema } from '../src/db.js';
import { publishTokens } from './publish-tokens.js';

const origin = 'https://images.example';
const src = `${origin}/photo`;
const gallery = `\`\`\`gallery\n${src}\n\`\`\``;
const zero = { gallery: 0, galleryCaptionFollowsLibrary: 0, heroTitle: false, inline: 0 };
function pair(body = gallery): PostPair {
  const tk = randomUUID();
  return { translationKey: tk, status: 'draft', shared: { date: '2026-10-29', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: `impact-de-${tk}`, title: 'Reise', excerpt: 'Intro', country: 'Land', heroImage: { src: `${origin}/hero`, width: 800, height: 600, alt: 'View' }, bodyMarkdown: body, images: { [src]: { width: 800, height: 600, alt: '', caption: '' } } },
    en: { locale: 'en', slug: `impact-en-${tk}`, title: 'Trip', excerpt: 'Intro', country: 'Country', heroImage: { src: `${origin}/hero`, width: 800, height: 600, alt: 'View' }, bodyMarkdown: body, images: { [src]: { width: 800, height: 600, alt: '', caption: '' } } } };
}

describe('Media story impact through the real renderer', () => {
  it('counts two published stories and a draft separately, retaining locale occurrence and inheritance counts', async () => {
    const posts = memoryPostStore();
    for (let n = 0; n < 3; n++) {
      const saved = await posts.upsertDraft(pair(`${gallery}\n\n${gallery}\n\n\`\`\`gallery\n${src} | caption-override=""\n\`\`\`\n\n\`\`\`gallery\n#captions: hidden\n${src}\n\`\`\``));
      if (n < 2) await posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey));
    }
    const result = await mediaImpact(await posts.mediaImpactCorpus(), 'photo', origin);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') throw new Error('unavailable');
    expect(result.published).toHaveLength(2); expect(result.drafts).toHaveLength(1); expect(result.newerDrafts).toEqual([]);
    for (const story of [...result.published, ...result.drafts]) {
      expect(story.locales.de).toEqual({ ...zero, gallery: 4, galleryCaptionFollowsLibrary: 2 });
      expect(story.locales.en).toEqual(story.locales.de);
    }
  });

  it('does not count hero/title and inline uses as gallery effects, rejects dropped lines and retargets portable origins', async () => {
    const posts = memoryPostStore();
    const input = pair(`![Inline](${src}-640.jpeg)\n\n\`\`\`gallery\n${origin}/unregistered\nhttps://foreign.example/photo\n\`\`\``);
    input.de.heroImage.src = src;
    input.en.titleImage = { src, width: 800, height: 600, alt: 'Title' };
    await posts.upsertDraft(input);
    expect(await mediaImpact(await posts.mediaImpactCorpus(), 'photo', 'https://new.example')).toMatchObject({ drafts: [{ locales: {
      de: { ...zero, heroTitle: true, inline: 1 }, en: { ...zero, heroTitle: true, inline: 1 },
    } }] });
  });

  it('excludes retained disabled and omitted working locales without changing deletion guards', async () => {
    const language = memoryLanguageStore();
    const posts = memoryPostStore({ language });
    const input = pair(); input.en.omitted = true; input.de.bodyMarkdown = 'No photo';
    await posts.upsertDraft(input);
    expect(await mediaImpact(await posts.mediaImpactCorpus(), 'photo', origin)).toEqual({ availability: 'available', published: [], drafts: [], newerDrafts: [] });
    expect((await posts.usageRows()).find((row) => row.locale === 'en')?.bodyMarkdown).toContain(src);
    await language.update({ primary: 'de', locales: ['de'] });
    expect((await posts.mediaImpactCorpus())[0]?.rows.map((row) => row.locale)).toEqual(['de']);
  });

  it('keeps a requested secondary awaiting first publication in drafts, not published reach', async () => {
    const posts = memoryPostStore();
    const input = pair(); input.en.omitted = true;
    await posts.upsertDraft(input);
    await posts.publish(input.translationKey, await publishTokens(posts, input.translationKey));
    const saved = (await posts.get(input.translationKey))!;
    await posts.upsertDraft({ ...saved, en: { ...saved.en, omitted: false } });
    const impact = await mediaImpact(await posts.mediaImpactCorpus(), 'photo', origin);
    expect(impact).toEqual({ availability: 'available',
      published: [{ translationKey: input.translationKey, title: input.de.title,
        locales: { de: { ...zero, gallery: 1, galleryCaptionFollowsLibrary: 1 }, en: zero } }],
      drafts: [{ translationKey: input.translationKey, title: input.de.title,
        locales: { de: zero, en: { ...zero, gallery: 1, galleryCaptionFollowsLibrary: 1 } } }], newerDrafts: [] });
  });

  it('does not swallow a renderer failure into empty reach', async () => {
    const posts = memoryPostStore(); await posts.upsertDraft(pair());
    const corpus = await posts.mediaImpactCorpus();
    corpus[0]!.rows[0]!.working.body_markdown = null as unknown as string;
    await expect(mediaImpact(corpus, 'photo', origin)).rejects.toThrow();
  });
});

for (const backend of ['memory', 'postgres'] as const) {
  const suite = backend === 'postgres' && !process.env.TEST_DATABASE_URL ? describe.skip : describe;
  suite(`Media consistent corpus (${backend})`, () => {
    it('reads fresh drafts, removed uses, inheritance changes and prose-only/reverted saves without digest caching', async () => {
      const pool = backend === 'postgres' ? createPool(process.env.TEST_DATABASE_URL!) : null;
      if (pool) await ensureSchema(pool);
      const posts = pool ? pgPostStore(pool) : memoryPostStore();
      const input = pair();
      try {
        const mode = await posts.language.get();
        const locale = mode.primary;
        const saved = await posts.upsertDraft(input);
        let impact = await mediaImpact(await posts.mediaImpactCorpus(), 'photo', origin);
        expect(impact).toMatchObject({ drafts: [{ translationKey: input.translationKey }] });
        await posts.publish(input.translationKey, await publishTokens(posts, input.translationKey));
        const published = (await posts.get(input.translationKey))!;
        await posts.upsertDraft({ ...published, [locale]: { ...published[locale], bodyMarkdown: `Prose only\n\n${gallery}` } });
        impact = await mediaImpact(await posts.mediaImpactCorpus(), 'photo', origin);
        if (impact.availability !== 'available') throw new Error('unavailable');
        expect(impact.newerDrafts).toEqual([]);
        await posts.upsertDraft({ ...published, [locale]: { ...published[locale], bodyMarkdown: 'Removed' } });
        impact = await mediaImpact(await posts.mediaImpactCorpus(), 'photo', origin);
        if (impact.availability !== 'available') throw new Error('unavailable');
        expect(impact.newerDrafts.find((story) => story.translationKey === input.translationKey)?.locales[locale]).toEqual(zero);
        expect(impact.published.find((story) => story.translationKey === input.translationKey)?.locales[locale].gallery).toBe(1);
        await posts.upsertDraft({ ...published, [locale]: { ...published[locale], bodyMarkdown: `\`\`\`gallery\n${src} | caption-override="local"\n\`\`\`` } });
        impact = await mediaImpact(await posts.mediaImpactCorpus(), 'photo', origin);
        if (impact.availability !== 'available') throw new Error('unavailable');
        expect(impact.newerDrafts.find((story) => story.translationKey === input.translationKey)?.locales[locale]).toEqual({ ...zero, gallery: 1 });
        await posts.upsertDraft(saved);
        impact = await mediaImpact(await posts.mediaImpactCorpus(), 'photo', origin);
        if (impact.availability !== 'available') throw new Error('unavailable');
        expect(impact.newerDrafts.find((story) => story.translationKey === input.translationKey)).toBeUndefined();
      } finally { await posts.remove(input.translationKey); await pool?.end(); }
    });
  });
}
