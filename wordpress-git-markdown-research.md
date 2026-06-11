# Research: WordPress + Git + Markdown Workflow

**Short answer: Yes, it's possible. But there are better options.**

## Can WordPress Pull Markdown from Git?

Yes, through several approaches -- but none are seamless out of the box.

---

## Option 1: Git it Write Plugin (Simplest WordPress Solution)

**[vaakash/git-it-write](https://github.com/vaakash/git-it-write)** -- Rating 4.7/5, last updated Aug 2024

- One-way sync: GitHub repo → WordPress posts
- Converts Markdown to HTML automatically
- Supports YAML frontmatter (title, categories, tags, status)
- Images must go in an `_images` folder at repo root
- Triggers via GitHub webhook

**Gotchas**: ~100 active installs (small community), rigid image folder structure, one-way only.

## Option 2: GitHub Actions + WordPress REST API (Most Robust)

Build a pipeline: push `.md` files → GitHub Action converts to HTML → posts to WordPress via REST API.

- Uses WordPress Application Passwords (built into core since 5.6+)
- Full control over Markdown conversion (use `marked`, `markdown-it`, etc.)
- Handle images by uploading to `/wp/v2/media` first, then rewriting URLs
- **[stefanbuck/wordpress-publish](https://github.com/stefanbuck/wordpress-publish)** is a ready-made GitHub Action for this

**Gotchas**: More setup effort, you build the pipeline yourself, image upload workflow adds complexity.

## Option 3: Documents from Git Plugin (Live Embed)

Uses shortcodes like `[git-github-markdown url="..."]` to fetch and render Markdown at display time. But you must create each WordPress post manually and insert the shortcode -- no auto-creation.

---

## Abandoned Solutions (Avoid)

| Plugin | Last Updated | Status |
|--------|-------------|--------|
| wordpress-github-sync | 2017 | Abandoned |
| VersionPress | ~2019 | Abandoned |
| WP Pusher | Active | Themes/plugins only, NOT content |

---

## Key Limitations With All WordPress Approaches

1. **Image handling is complex** -- Git uses relative paths, WordPress needs Media Library URLs. Every solution requires upload + URL rewriting.
2. **Two-way sync doesn't work** -- Git must be the single source of truth. Never edit synced posts in WordPress admin.
3. **Plugin abandonment risk** -- 3 of 4 major sync plugins are already dead.
4. **SEO gotchas** -- Changing filenames/slugs creates 404s without manual redirect management.
5. **Maintenance overhead** -- WordPress updates, PHP updates, plugin updates, hosting costs ($5-25/month).

---

## The Honest Recommendation: Consider Static Site Generators

If your workflow is "write Markdown → push to Git → website updates," that's *exactly* what static site generators do **natively** -- no plugins, no sync, no complexity:

| Tool | Build Speed | Hosting Cost | Markdown Support |
|------|------------|-------------|-----------------|
| **[Astro](https://astro.build)** | 3-15s | Free (Vercel/Netlify) | Native |
| **[Eleventy](https://www.11ty.dev)** | 3-15s | Free | Native |
| **[Hugo](https://gohugo.io)** | Sub-second | Free | Native |
| **[Jekyll](https://jekyllrb.com)** | Slower | Free (GitHub Pages) | Native |

With these, your Markdown files *are* the website. Push to Git → site rebuilds automatically. No WordPress middleman needed.

If you need a visual editor for non-technical users, **[Decap CMS](https://decapcms.org)** (free, open-source) adds a UI on top of any static site generator and commits directly to Git.

---

## Summary

| Approach | Complexity | Cost | Reliability |
|----------|-----------|------|-------------|
| Git it Write plugin | Low | $5-25/mo hosting | Medium (small plugin) |
| GitHub Actions + REST API | High (custom) | $5-25/mo hosting | High (core WP API) |
| Static site generator (Astro/Hugo) | Low | Free | High |

**If you must use WordPress**: Go with GitHub Actions + REST API (most stable long-term) or Git it Write (easiest setup).

**If you're open to alternatives**: Astro or Hugo will give you the exact workflow you described (write in MD, push to Git, site updates) with zero friction and zero cost.

---

## Detailed Plugin Comparison

| Solution | Status | Direction | Markdown→HTML | Frontmatter | Images | Auto-Sync | Setup Effort |
|---|---|---|---|---|---|---|---|
| wordpress-github-sync | Abandoned (2017) | Bidirectional | Via separate plugin | YAML (basic) | No upload | Webhook | Medium |
| WP REST API + GH Actions | Core WP (stable) | One-way (push) | You choose library | Full control | Manual upload via API | On push | High (custom) |
| wp-post-action | Active | One-way (push) | Gutenberg-compatible | Yes | Auto-upload | On push | Low-Medium |
| Git it Write | Active (Aug 2024) | One-way (pull) | Built-in | Yes (standard fields) | Auto-upload (_images/) | Webhook | Low |
| Documents from Git | Moderate | Embed (live fetch) | On-the-fly render | None | Raw Git URLs | Live | Low |
| Postmark (dirtsimple) | Low activity | One-way (push) | Built-in | Full YAML + custom | Not documented | Manual (WP-CLI) | Medium-High |

---

## Implementation Checklist (If Going WordPress Route)

### Option A: Git it Write (simplest)
- [ ] Install Git it Write plugin from WordPress.org
- [ ] Configure GitHub repository URL and branch in Settings
- [ ] Create `_images` folder in repository root for all images
- [ ] Set up GitHub webhook pointing to WordPress site
- [ ] Add frontmatter to Markdown files (title, status, categories, tags)
- [ ] Test with a single post push
- [ ] Verify image upload to media library

### Option B: Custom REST API + GitHub Actions (most control)
- [ ] Enable HTTPS on WordPress site
- [ ] Generate Application Password in wp-admin (Users → Your Profile)
- [ ] Store `WP_URL`, `WP_USER`, `WP_APP_PASSWORD` as GitHub Secrets
- [ ] Write GitHub Actions workflow that triggers on push to content directory
- [ ] Add Markdown-to-HTML conversion step (using `marked`, `markdown-it`, or similar)
- [ ] Add frontmatter parsing step (using `gray-matter` or similar)
- [ ] Add image upload step via `wp/v2/media` endpoint
- [ ] Add post create/update step via `wp/v2/posts` endpoint (match by slug)
- [ ] Handle featured image via `featured_media` field
- [ ] Add error handling and logging

### Edge Cases to Handle
- [ ] What happens when a Markdown file is deleted from the repo? (Most solutions do NOT delete the WordPress post)
- [ ] How to handle draft vs. published status? (Use frontmatter `status: draft` or `status: publish`)
- [ ] What about post revisions and WordPress edit history?
- [ ] How to handle bulk initial import of existing content?
- [ ] What if WordPress is temporarily unreachable when the webhook/action fires?

---

## Sources

- [WordPress REST API Handbook](https://developer.wordpress.org/rest-api/)
- [Application Passwords (WordPress Core)](https://developer.wordpress.org/rest-api/reference/application-passwords/)
- [wordpress-github-sync](https://github.com/mAAdhaTTah/wordpress-github-sync)
- [wp-post-action (GitHub Marketplace)](https://github.com/marketplace/actions/wp-post-action)
- [Git it Write](https://github.com/vaakash/git-it-write)
- [WP Pusher](https://wppusher.com/)
- [wordpress-markdown-git](https://github.com/nilsnolde/wordpress-markdown-git)
- [Postmark](https://github.com/dirtsimple/postmark)
- [stefanbuck/wordpress-publish](https://github.com/stefanbuck/wordpress-publish)
- [Astro](https://astro.build)
- [Eleventy](https://www.11ty.dev)
- [Hugo](https://gohugo.io)
- [Decap CMS](https://decapcms.org)
