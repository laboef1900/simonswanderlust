/// <reference types="vitest" />
import { getViteConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { configDefaults } from 'vitest/config';

export default getViteConfig({
  test: { exclude: [...configDefaults.exclude, 'test/built/**'] },
}, {
  // Unit/container tests inject content; only real Astro commands resolve the
  // database-owned language. The separate built-routes project checks releases.
  configFile: false,
  site: 'https://simonswanderlust.com',
  trailingSlash: 'always',
  compressHTML: true,
  vite: { plugins: [tailwindcss()] },
});
