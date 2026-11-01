// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { MARKDOWN_OPTIONS } from './src/lib/render-markdown.js';
import { loadEnv } from 'vite';
import { resolveBuildLanguage } from './src/lib/build-language.js';

const databaseUrl = process.env.DATABASE_URL || loadEnv(process.env.NODE_ENV || 'development', process.cwd(), 'DATABASE_URL').DATABASE_URL;
const language = await resolveBuildLanguage(databaseUrl);
process.env.DATABASE_URL = databaseUrl;
process.env.SITE_LANGUAGE_JSON = JSON.stringify(language);

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
    defaultLocale: language.primary,
    locales: [...language.locales],
    routing: { prefixDefaultLocale: false },
  },
  // Share the preview's options directly: gallery markers and class-based
  // highlighting must survive the same sanitizer in previews and builds.
  markdown: MARKDOWN_OPTIONS,
  integrations: [mdx(), sitemap()],
  vite: { plugins: [tailwindcss()] },
});
