# WordPress Plugin vs Astro Rebuild: Pros & Cons for simonswanderlust

## The Bottom Line

| | Custom WordPress Plugin | Rebuild with Astro |
|---|---|---|
| **Dev time for travel map** | 20-40 hours (6-8 weeks full) | 5-10 hours (2-3 weeks full) |
| **Monthly cost** | $5-200/month | $0-20/month (often $0) |
| **Page speed (LCP)** | ~0.81s avg | ~0.44s avg (46% faster) |
| **Core Web Vitals pass rate** | 38% of WP sites | 60% of Astro sites |
| **Maintenance burden** | High (PHP + WP updates + security) | Low (npm updates, no server) |
| **Security risk** | High (7,966 WP vulns in 2024) | Near zero (static HTML) |
| **Content workflow** | WordPress admin (visual editor) | Markdown in VS Code + Git |

---

## Option A: Custom WordPress Plugin

### Pros

- **Keep your existing site** -- no migration headache, all your content stays where it is
- **Visual editor** -- WordPress admin panel for non-technical editing (Gutenberg block editor)
- **Plugin ecosystem** -- 60,000+ plugins for comments, forms, SEO, newsletters, e-commerce
- **Multilingual** -- WPML ($39+/yr) or Polylang (free) for multi-language support out of the box
- **Familiar** -- you already know WordPress, no new framework to learn
- **Community** -- massive community, easy to find help or hire developers

### Cons

- **PHP + JavaScript** -- plugin dev requires both PHP (WordPress hooks, custom post types, REST API) and modern JS (Leaflet, Gutenberg blocks with React)
- **Two rendering contexts** -- Gutenberg blocks must render in both the editor (React iframe) and the frontend (vanilla DOM). This doubles the integration work for interactive maps
- **6-8 weeks development** -- custom post types, admin UI, asset enqueuing, shortcodes/blocks, REST API endpoints, database schema
- **WordPress update treadmill** -- WordPress 6.9 (Dec 2025) broke 40% of plugins at launch, including WooCommerce, Yoast SEO, and Elementor. Major releases 2-3x/year
- **Security burden** -- 7,966 new vulnerabilities in 2024 (34% increase). 96% in plugins. 43% exploitable without authentication. 35% remained unpatched
- **Performance ceiling** -- WordPress loads PHP + database on every page view. Heavy JS (maps) on top of that = slow. Only 38% pass Core Web Vitals
- **Hosting cost** -- $5-25/month shared, $50-200/month managed
- **Asset loading fights** -- WordPress's `wp_enqueue_script` system makes it tricky to properly load/optimize modern JS libraries. Conditional loading requires page/post checks
- **REST API limitations** -- no built-in relational queries (e.g., "get all stops for trip X" requires custom endpoint). Large GPX file handling needs custom upload endpoints

### What Plugin Development Actually Involves

**Tech stack**: PHP 8.0+, JavaScript/React (for Gutenberg blocks), @wordpress/scripts (webpack-based build), CSS, WordPress REST API, Custom Post Types + Post Meta

**Development timeline**:
- Week 1-2: Plugin scaffold, custom post types (Trip, Stop), admin meta boxes
- Week 2-3: Gutenberg block development with React (editor + frontend rendering)
- Week 3-4: Leaflet.js integration, GPX parsing, map rendering
- Week 4-5: Timeline UI, photo-map sync, animated routes
- Week 5-6: REST API endpoints, settings page, shortcodes
- Week 6-8: Testing, WordPress coding standards, cross-browser, mobile

**Scaffolding tools**:
- [WPPB.me](https://wppb.me/) -- web form, generates ZIP with OOP plugin structure
- WP-CLI `scaffold plugin` -- basic CLI scaffold with test scaffolding
- [wp-plugin-init](https://dev.to/ruman_ahmed/scaffold-wordpress-plugins-instantly-using-wp-plugin-init-nodejs-cli-28o7) -- modern scaffold with Vue.js + Vite

---

## Option B: Rebuild with Astro

### Pros

- **5-10 hours for the map feature** -- npm install Leaflet, create a React/Svelte component, embed with `client:visible`. Done
- **Islands architecture** -- map loads JavaScript only when scrolled into view. Rest of site = zero JS, pure static HTML
- **Built for your exact workflow** -- write Markdown, push to Git, site rebuilds. This IS Astro's core design
- **Image optimization built in** -- `astro:assets` handles WebP conversion, lazy loading, responsive sizes automatically. Critical for photo-heavy travel blog
- **Content Collections** -- type-safe data modeling for trips/stops with Zod schemas. Define coordinates, dates, GPX files in frontmatter with TypeScript autocompletion
- **Free hosting** -- Cloudflare Pages (unlimited bandwidth!), Vercel (100GB), Netlify (100GB). Perfect for photo-heavy content
- **46% faster LCP** than WordPress (0.44s vs 0.81s)
- **72% smaller HTML, 60% less JavaScript**
- **Zero security vulnerabilities** -- static HTML has no attack surface. No database, no admin panel, no PHP
- **Git = your CMS** -- every change tracked, instant rollback to any version, branch for drafts
- **MDX support** -- embed interactive map components directly inside your blog posts
- **Modern deployment** -- push to GitHub -> Cloudflare/Vercel/Netlify rebuilds automatically
- **One rendering context** -- map component renders the same way everywhere (vs WordPress's editor iframe + frontend DOM)
- **Infinite scalability at zero cost** -- CDN-served static files. 10 visitors or 10 million = same performance, same cost

### Cons

- **Migration effort** -- exporting WordPress content to Markdown takes work. Budget 1-2 hours per 20 posts for cleanup
- **SEO risk during migration** -- must preserve URL structure and set up 301 redirects for changed URLs
- **No visual editor** -- you edit Markdown files in VS Code (or add Front Matter CMS / Decap CMS for a visual UI)
- **Comments need replacement** -- WordPress native comments gone. Use Giscus (GitHub-based, free) or Disqus
- **Contact forms need replacement** -- use Formspree (50 free/month) or Netlify Forms (100 free/month)
- **Search needs replacement** -- use Pagefind (static search, works great with Astro, used by Astro's own docs)
- **Learning curve** -- Astro's syntax, content collections, island hydration are new concepts
- **No built-in i18n plugin** -- multilingual requires file-based routing (manual folder structure per language)
- **Build time with many images** -- 1000+ photos can make builds take 5-10 minutes (but only on deploy, not page views)

### What Astro Development Looks Like

**Content Collections for travel data**:

```typescript
// src/content/config.ts
const trips = defineCollection({
  schema: z.object({
    title: z.string(),
    startDate: z.date(),
    endDate: z.date(),
    countries: z.array(z.string()),
    gpxFile: z.string().optional(),
    coverImage: z.string(),
  }),
});

const stops = defineCollection({
  schema: z.object({
    tripSlug: z.string(),
    name: z.string(),
    lat: z.number(),
    lng: z.number(),
    date: z.date(),
    photos: z.array(z.string()).optional(),
  }),
});
```

**Map component with island hydration**:

```astro
---
import TravelMap from '../components/TravelMap.jsx';
import { getCollection } from 'astro:content';
const stops = await getCollection('stops');
---

<h1>My Paris Trip</h1>

<!-- Map loads ONLY when scrolled into view -->
<TravelMap client:visible
  stops={stops.map(s => ({
    title: s.data.name,
    lat: s.data.lat,
    lng: s.data.lng
  }))}
  gpxUrl="/gpx/paris-2023.gpx"
/>
```

The equivalent in WordPress requires: custom post type registration, REST API endpoint, `wp_enqueue_script` for Leaflet, shortcode or Gutenberg block definition, PHP template rendering, and JavaScript initialization. Roughly 5x more code.

**Development timeline**:
- Day 1-3: Astro project setup, content collections schema, basic layouts
- Day 3-5: WordPress export, markdown cleanup, URL structure matching
- Day 5-8: Leaflet map component, GPX parsing, island hydration
- Day 8-10: Timeline component, photo gallery, animated routes
- Day 10-12: Search (Pagefind), comments (Giscus), contact form (Formspree)
- Day 12-15: Polish, deploy to Cloudflare Pages, DNS, SEO verification

---

## Option C: Hybrid -- Headless WordPress + Astro Frontend

Keep WordPress as your content backend, use Astro for the frontend.

**How it works**: WordPress REST API serves content -> Astro fetches at build time -> generates static HTML. WordPress admin runs on a subdomain (e.g., `admin.simonswanderlust.com`).

Astro has a [dedicated WordPress CMS guide](https://docs.astro.build/en/guides/cms/wordpress/).

**Pros**: Keep WordPress visual editor, get Astro's performance, add custom map components freely

**Cons**: Still running a WordPress instance (hosting cost, updates, security), two systems to maintain, preview workflow is complex

**Cost**: WordPress hosting ($3-18/mo) + Astro hosting ($0) = $3-18/mo minimum

**Verdict**: Makes sense if there are multiple non-technical content editors. For a solo developer blog, adds complexity without sufficient benefit.

---

## Option D: Keep WordPress + Standalone Map Page (Stepping Stone)

Build the Polarsteps-like map as a separate app, keep WordPress as-is.

**How it works**: Keep existing WordPress blog entirely untouched. Build a standalone interactive map with Astro/Leaflet. Host on a subdomain (`map.simonswanderlust.com`). Link from WordPress posts to map and vice versa.

**Pros**: Zero disruption to existing blog, map built with modern tooling, free hosting, can evolve independently, validates concept before committing to full migration

**Cons**: Two separate sites (different tech stacks), no deep integration, duplicate shared elements (nav, footer, styling), SEO split across subdomains

**Verdict**: Good as a temporary stepping stone. Build the map standalone first, validate the concept, then decide on full migration later.

---

## Hosting Comparison (Free Tiers)

| Feature | Cloudflare Pages | Netlify | Vercel |
|---------|-----------------|---------|--------|
| **Bandwidth** | **Unlimited** | 100 GB/month | 100 GB/month |
| **Build minutes** | 500/month | 300/month | 6,000/month |
| **Serverless functions** | 100K req/day | 125K invocations/month | 100 GB-hours/month |
| **Sites** | Unlimited | Unlimited | Unlimited |
| **Custom domains** | Unlimited | 1 per site | 1 per site |
| **SSL** | Automatic | Automatic | Automatic |
| **Preview deploys** | Yes (PRs) | Yes (PRs) | Yes (PRs) |
| **Best for travel blog** | **Yes** (unlimited BW for photos) | Good | Overkill |

**Recommendation**: Cloudflare Pages. Unlimited bandwidth is decisive for an image-heavy travel blog.

---

## What You Lose Leaving WordPress (and Replacements)

| WordPress Feature | Replacement | Cost | Quality |
|-------------------|-------------|------|---------|
| Visual editor | [Front Matter CMS](https://frontmatter.codes/) (VS Code extension) or [Decap CMS](https://decapcms.org/) | Free | Good |
| Comments | [Giscus](https://giscus.app/) (GitHub Discussions-based) | Free | Excellent |
| Contact forms | [Formspree](https://formspree.io/) (50/month free) or Netlify Forms | Free tier | Good |
| Search | [Pagefind](https://pagefind.app/) (static search) | Free | Excellent |
| SEO plugin (Yoast) | Built-in meta tags, sitemap (`@astrojs/sitemap`), RSS (`@astrojs/rss`) | Free | Equivalent |
| Analytics | [Umami](https://umami.is/) (100K events/mo free) or [Plausible](https://plausible.io/) ($9/mo) | Free-$9/mo | Better (privacy-friendly) |
| Newsletter | ConvertKit/Mailchimp/Buttondown via API form | Varies | Same |
| Multilingual | File-based i18n routing (`/en/`, `/de/` folders) | Free | More manual |

---

## Cost Comparison (Annual)

| Item | WordPress | Astro |
|------|-----------|-------|
| Hosting | $60-2,400 | $0 (Cloudflare Pages free) |
| Domain | $15 | $15 |
| SSL | $0 (included) | $0 (automatic) |
| Backups | $0-120 | $0 (Git) |
| Security | $0-120 (plugins) | $0 (static = no attack surface) |
| CDN/Caching | $0-200 (plugins) | $0 (built-in) |
| **Total** | **$75-2,855/year** | **$15/year** |

---

## Migration Tools (If You Choose Astro)

| Tool | Type | Notes |
|------|------|-------|
| **[wordpress-export-to-markdown](https://github.com/lonekorean/wordpress-export-to-markdown)** | Node.js CLI | Best option, converts WP XML export to MD with frontmatter |
| **[wordpress-to-astro](https://github.com/okTurtles/wordpress-to-astro)** | Node.js | Purpose-built for Astro migration |
| **[Markdown Exporter for WordPress](https://github.com/robertdevore/markdown-exporter-for-wordpress)** | WP Plugin | ACF/Pods support, runs inside WP |
| **[Simple Export to Markdown](https://wordpress.org/plugins/simple-export-md/)** | WP Plugin | Gutenberg panel, YAML frontmatter |

Budget 1-2 hours per 20 posts for cleanup (shortcodes, media paths, formatting).

---

## Head-to-Head Summary

| Factor | Winner | Margin |
|--------|--------|--------|
| Development time | **Astro** | 2-3 weeks vs 6-8 weeks |
| Hosting cost | **Astro** | $0/month vs $3-200/month |
| Performance | **Astro** | 60% vs 38% CWV pass rate |
| Security | **Astro** | Near-zero vs 7,966 vulns/year ecosystem |
| Map integration | **Astro** | 1 rendering context vs 2 |
| Maintenance | **Astro** | npm packages vs WP core/PHP/Gutenberg compat |
| Backup/versioning | **Astro** | Git-native vs database backups |
| Image handling | **Astro** | Built-in optimization vs plugin-dependent |
| Scalability | **Astro** | Infinite (CDN) vs server-limited |
| Content editing (non-technical) | **WordPress** | Visual editor wins for non-developers |
| Existing plugin ecosystem | **WordPress** | 60,000+ plugins |
| Learning curve (if you know WP) | **WordPress** | Familiar vs new framework |

**WordPress plugin wins only on content editing workflow for non-technical users and existing ecosystem.** If the content author is a developer comfortable with Markdown and Git, those advantages evaporate.

---

## Recommendation for simonswanderlust

**Astro wins on every dimension that matters for a developer-run travel blog wanting Polarsteps-like maps.**

**Suggested path**:

1. **Quick test** (30 min): Run `npm create astro@latest`, pick a blog template, see if you like the workflow
2. **Build the map** (1-2 days): Create a Leaflet component with `client:visible`, test with sample GPX data
3. **Migrate content** (1 weekend): Export WordPress to Markdown, clean up, set up content collections
4. **Deploy** (10 min): Push to GitHub, connect Cloudflare Pages, point DNS
5. **Verify SEO** (1 hour): Check redirects, submit sitemap, verify in Google Search Console

**Or if you want zero disruption first**: Go with Option D -- build the map as a standalone Astro app on `map.simonswanderlust.com`, keep WordPress running, and migrate later when you're confident.

---

## Sources

### WordPress Development
- [WordPress Block Editor Handbook](https://developer.wordpress.org/block-editor/)
- [WordPress REST API Handbook](https://developer.wordpress.org/rest-api/)
- [WordPress Plugin Boilerplate](https://wppb.me/)
- [Unit Testing WP Plugins 2025](https://blog.nateweller.com/2025/05/09/unit-testing-wordpress-plugins-in-2025-with-wordpress-env-and-phpunit/)
- [WordPress 6.9 Broke 40% of Plugins](https://editorialge.com/wordpress-6-9-beta-plugin-breakage/)
- [WordPress 6.9 Broke 3 Major Plugins](https://www.365i.co.uk/blog/2025/12/02/wordpress-6-9-broke-3-plugins-fix/)
- [Patchstack Security Report 2025](https://patchstack.com/whitepaper/state-of-wordpress-security-in-2025/)
- [8,000 New WordPress Vulnerabilities in 2024](https://www.securityweek.com/8000-new-wordpress-vulnerabilities-reported-in-2024/)

### Astro
- [Astro Content Collections](https://docs.astro.build/en/guides/content-collections/)
- [Astro Island Architecture](https://docs.astro.build/en/concepts/islands/)
- [Astro Images Guide](https://docs.astro.build/en/guides/images/)
- [Astro MDX Integration](https://docs.astro.build/en/guides/integrations-guide/mdx/)
- [Astro Headless WordPress Guide](https://docs.astro.build/en/guides/cms/wordpress/)
- [Astro Deploy to Cloudflare](https://docs.astro.build/en/guides/deploy/cloudflare/)
- [Migrating from WordPress to Astro](https://docs.astro.build/en/guides/migrate-to-astro/from-wordpress/)
- [100 Lighthouse Score After WP-to-Astro Migration](https://kashifaziz.me/blog/wordpress-to-astro-migration-journey/)
- [Why We Chose Astro Over WordPress](https://www.bourne.law/blog/why-we-chose-astro-over-wordpress/)

### Maps
- [Leaflet.js](https://leafletjs.com/) (39 KB gzipped)
- [maps-withastro](https://github.com/roblabs/maps-withastro) -- Leaflet + MapLibre in Astro
- [leaflet-gpx](https://github.com/mpetazzoni/leaflet-gpx)
- [Leaflet.Polyline.SnakeAnim](https://github.com/IvanSanchez/Leaflet.Polyline.SnakeAnim)

### Migration Tools
- [wordpress-export-to-markdown](https://github.com/lonekorean/wordpress-export-to-markdown)
- [wordpress-to-astro](https://github.com/okTurtles/wordpress-to-astro)
- [Giscus](https://giscus.app/) (comments)
- [Pagefind](https://pagefind.app/) (search)
- [Formspree](https://formspree.io/) (contact forms)

### Hosting
- [Vercel vs Netlify vs Cloudflare Pages 2025](https://www.digitalapplied.com/blog/vercel-vs-netlify-vs-cloudflare-pages-comparison)
- [Cloudflare vs Vercel vs Netlify Edge Performance 2026](https://dev.to/dataformathub/cloudflare-vs-vercel-vs-netlify-the-truth-about-edge-performance-2026-50h0)
