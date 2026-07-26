import { satteri } from '@astrojs/markdown-satteri';

/**
 * Standalone Markdown → HTML renderer that reproduces what the Astro Content
 * Layer loader produces at build time (`renderMarkdown` in
 * `postgres-loader.ts` → `markdown.processor.createRenderer(...)`).
 *
 * @ai-context Used by the uploader's draft preview (`uploader/src/preview.ts`)
 * so a preview renders through the SAME pipeline as `astro build`.
 */
type Renderer = Awaited<ReturnType<ReturnType<typeof satteri>['createRenderer']>>;
type MarkdownOptions = Parameters<ReturnType<typeof satteri>['createRenderer']>[0];

/**
 * The `markdown` options `astro build` runs with, exported so the draft
 * preview and a parity test can both read the SAME values.
 *
 * @ai-warning These MUST stay identical to the `markdown` block in
 * `astro.config.mjs` — the build reads the config, this module feeds the
 * uploader's draft preview, and a silent divergence means previews and the
 * live site disagree about what a gallery is. `render-markdown.test.ts`
 * asserts the two agree; do not "fix" a failure there by editing only one side.
 *
 * `excludeLangs` is what makes the ```gallery fence survive: without it Shiki
 * falls the unknown language back to plaintext and emits
 * `data-language="plaintext"`, which `rehype-sanitize` strips — so the marker
 * would survive nowhere and `body-images.ts` could never find the block.
 * Excluded languages bypass Shiki entirely and keep `class="language-gallery"`,
 * which the sanitizer allow-lists on `code`/`pre`.
 * (`math` is Astro's own default exclusion — repeating it here is for clarity,
 * not load-bearing: satteri ORs the configured list with its defaults.)
 */
export const MARKDOWN_OPTIONS: Pick<MarkdownOptions, 'syntaxHighlight' | 'shikiConfig'> = {
  syntaxHighlight: { type: 'shiki', excludeLangs: ['math', 'gallery'] },
  shikiConfig: { theme: 'github-dark' },
};

let rendererPromise: Promise<Renderer> | undefined;

function getRenderer(): Promise<Renderer> {
  // Lazy module-level cache: the first call pays the one-time Shiki setup;
  // subsequent calls reuse the same renderer.
  rendererPromise ??= satteri().createRenderer(MARKDOWN_OPTIONS);
  return rendererPromise;
}

/** Render post-body Markdown to the same HTML the site build emits. */
export async function renderMarkdown(markdown: string): Promise<string> {
  const renderer = await getRenderer();
  const { code } = await renderer.render(markdown);
  return code;
}
