// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://simonswanderlust.com',
  // Explicit, though it is Astro's default: the SEO slug contract and the
  // uploader's release/serve pipeline both assume a fully static dist/.
  output: 'static',
  // Astro 7 defaults to 'jsx', which collapses whitespace between inline
  // elements ("hello <em>world</em>" can render as "helloworld") — keep the
  // HTML-aware v6 behavior for this text-heavy editorial site.
  compressHTML: true,
  trailingSlash: 'always',
  i18n: {
    defaultLocale: 'de',
    locales: ['de', 'en'],
    routing: { prefixDefaultLocale: false },
  },
  // @ai-warning: keep in lockstep with MARKDOWN_OPTIONS in
  // src/lib/render-markdown.ts (the uploader's draft preview renders through
  // that module) — render-markdown.test.ts asserts the two agree.
  // 'gallery' must stay excluded from syntax highlighting: it is how the
  // ```gallery fence keeps its `language-gallery` class through
  // rehype-sanitize so body-images.ts can turn it into a photo grid.
  markdown: {
    syntaxHighlight: { type: 'shiki', excludeLangs: ['math', 'gallery'] },
    shikiConfig: { theme: 'github-dark' },
  },
  integrations: [mdx(), sitemap()],
  vite: { plugins: [tailwindcss()] },
});
