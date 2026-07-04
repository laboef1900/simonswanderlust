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
  integrations: [mdx(), sitemap()],
  vite: { plugins: [tailwindcss()] },
});
