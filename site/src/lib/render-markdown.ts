import { satteri } from '@astrojs/markdown-satteri';

/**
 * Standalone Markdown → HTML renderer that reproduces what the Astro Content
 * Layer loader produces at build time (`renderMarkdown` in
 * `postgres-loader.ts` → `markdown.processor.createRenderer(...)`).
 *
 * @ai-context Used by the uploader's draft preview (`uploader/src/preview.ts`)
 * so a preview renders through the SAME pipeline as `astro build`. The options
 * below are Astro 7's config defaults (see `markdownConfigDefaults` in
 * `@astrojs/internal-helpers/markdown` and the `satteri()` processor default in
 * astro's config schema). `astro.config.mjs` currently sets no `markdown`
 * config — if it ever does, mirror those options here to keep build/preview
 * parity.
 */
type Renderer = Awaited<ReturnType<ReturnType<typeof satteri>['createRenderer']>>;

let rendererPromise: Promise<Renderer> | undefined;

function getRenderer(): Promise<Renderer> {
  // Lazy module-level cache: the first call pays the one-time Shiki setup;
  // subsequent calls reuse the same renderer.
  rendererPromise ??= satteri().createRenderer({
    syntaxHighlight: { type: 'shiki', excludeLangs: ['math'] },
    shikiConfig: { theme: 'github-dark' },
  });
  return rendererPromise;
}

/** Render post-body Markdown to the same HTML the site build emits. */
export async function renderMarkdown(markdown: string): Promise<string> {
  const renderer = await getRenderer();
  const { code } = await renderer.render(markdown);
  return code;
}
