# Unified Admin Header Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the six+one drifted, hand-maintained admin `<nav>`s with one role-aware menu rendered from `auth.js`, with the active page highlighted.

**Architecture:** `auth.js` owns a single ordered nav model and renders it into a `#mainnav` container on every admin page (admin-only items hidden for authors, current page marked `aria-current="page"`). Each page swaps its hardcoded `<nav>` for an empty `<nav id="mainnav">`. No server-side change; styling already exists in `admin.css`.

**Tech Stack:** Static HTML + vanilla JS (`uploader/public/`), `admin.css`. No build step, no framework.

## Global Constraints

- **XSS-safe DOM only** — build links with `createElement`/`textContent`, never `innerHTML` with data.
- Menu order (flat): **Hero upload · Batch uploader · Posts · Import · LLM settings\* · Users\*** (\* admin-only, hidden for non-admins).
- Routes: `/admin/` · `/admin/batch.html` · `/admin/posts.html` · `/admin/import.html` · `/admin/settings.html` · `/admin/users.html`. `editor.html` shows the header and highlights **Posts** (no own menu item).
- Keep each page's existing masthead chrome (eyebrow/h1/lede, `#whoami`). `login.html` is untouched.
- The Posts page keeps a **+ New post** action — as a page action, NOT in the centralized nav.
- No automated tests (static client UI) — verify in the browser as both an admin and an author.

---

### Task 1: Centralize the nav in `auth.js`

**Files:**
- Modify: `uploader/public/auth.js`

**Interfaces:**
- Produces: `Auth.renderHeader(s)` now fills BOTH `#mainnav` (the menu) and `#whoami` (user + Logout). The Users link is removed from `#whoami` (it becomes a nav item). No signature change — pages already call `Auth.renderHeader(s)`.

- [ ] **Step 1: Add the nav model + `renderNav`, and update `renderHeader`.**

In `auth.js`, inside the IIFE, add the model near the top of the returned helpers and a `renderNav`, then update `renderHeader` to call it and drop the Users link. Replace the existing `renderHeader` function with:

```js
  const NAV = [
    { label: 'Hero upload',    href: '/admin/' },
    { label: 'Batch uploader', href: '/admin/batch.html' },
    { label: 'Posts',          href: '/admin/posts.html' },
    { label: 'Import',         href: '/admin/import.html' },
    { label: 'LLM settings',   href: '/admin/settings.html', admin: true },
    { label: 'Users',          href: '/admin/users.html',    admin: true },
  ];

  // The nav href that represents the current page (editor belongs to Posts).
  function currentNavHref() {
    let p = location.pathname;
    if (p === '/admin' || p === '/admin/index.html') return '/admin/';
    if (p === '/admin/editor.html') return '/admin/posts.html';
    return p;
  }

  function renderNav(s) {
    const nav = document.getElementById('mainnav');
    if (!nav) return;
    nav.textContent = '';
    const here = currentNavHref();
    for (const item of NAV) {
      if (item.admin && !s.isAdmin) continue;
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      if (item.href === here) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    }
  }

  // Renders the main menu (#mainnav) and "Logged in as X · Logout" (#whoami).
  function renderHeader(s) {
    renderNav(s);
    const el = document.getElementById('whoami');
    if (!el) return;
    el.textContent = '';
    el.appendChild(document.createTextNode('Logged in as '));
    const strong = document.createElement('strong');
    strong.textContent = s.username;
    el.appendChild(strong);
    el.appendChild(document.createTextNode(' · '));
    const logoutLink = document.createElement('a');
    logoutLink.href = '#';
    logoutLink.id = 'logoutLink';
    logoutLink.textContent = 'Logout';
    logoutLink.addEventListener('click', (e) => { e.preventDefault(); logout(); });
    el.appendChild(logoutLink);
  }
```

Keep the existing `status`, `ensureAuthed`, `logout` functions and the `return { status, ensureAuthed, logout, renderHeader };` line unchanged.

- [ ] **Step 2: Sanity-check the file parses.**

Run: `node --check uploader/public/auth.js`
Expected: no output (valid JS).

- [ ] **Step 3: Commit.**

```bash
git add uploader/public/auth.js
git commit -m "feat(admin): central role-aware nav model + renderer in auth.js"
```

---

### Task 2: Swap each page's nav for the central container

**Files:**
- Modify: `uploader/public/index.html`, `batch.html`, `posts.html`, `import.html`, `settings.html`, `users.html`, `editor.html`
- Modify (only if active state is not visually distinct): `uploader/public/admin.css`

**Interfaces:**
- Consumes: `Auth.renderHeader(s)` from Task 1 (fills `#mainnav`). Each page already calls it in its load gate.

- [ ] **Step 1: Replace the hardcoded `<nav>` in every page.**

In each of the 7 files, find the `<nav> … hardcoded <a> links … </nav>` block inside `.masthead-inner` and replace the WHOLE block with:

```html
        <nav id="mainnav" aria-label="Admin"></nav>
```

(Match each file's existing indentation.) Do not touch the eyebrow/`h1`/`lede`/`#whoami` around it. Confirm each page still loads `auth.js` and calls `Auth.ensureAuthed()` + `Auth.renderHeader(s)` (they already do — no change needed).

- [ ] **Step 2: Preserve the Posts page's "+ New post" action.**

`posts.html`'s old nav contained `<a href="/admin/editor.html" class="btn-new">+ New post</a>`. It must NOT live in the centralized `#mainnav`. Add it back as a page action — place it in `.masthead-inner` right after the `#mainnav` line:

```html
        <nav id="mainnav" aria-label="Admin"></nav>
        <p class="masthead-action"><a href="/admin/editor.html" class="btn-new">+ New post</a></p>
```

(If `import.html` has an in-body "Go to Posts to review drafts" link in its result panel — NOT in the `<nav>` — leave it; only the masthead `<nav>` is replaced.)

- [ ] **Step 3: Verify the active-state styling reads as a menu.**

`admin.css` already styles `.masthead nav a` and `.masthead nav a[aria-current='page']`. Load a page (Step 4) and check the active item is visually distinct. ONLY if it isn't, add/strengthen in `admin.css`:

```css
.masthead nav a[aria-current='page'] { color: #fff; border-bottom: 2px solid var(--brand-red, #d23b30); }
.masthead-action { margin-top: 0.6rem; }
```

- [ ] **Step 4: Verify (static + browser).**

Static checks:
```bash
cd uploader/public
grep -L 'id="mainnav"' index.html batch.html posts.html import.html settings.html users.html editor.html   # expect: no files listed (all have it)
grep -c 'href="/admin/settings.html"' index.html batch.html posts.html import.html settings.html users.html editor.html   # expect 0 in each (no hardcoded nav links remain)
```
Browser (the real check): rebuild the images container and load each admin page —
```bash
cd ../.. && POSTGRES_PASSWORD=devpw BUILD_SECRET=devsecret docker compose up -d --build images
```
Then in the browser: every admin page shows the identical menu; the current page is highlighted; logged in as an **admin** shows LLM settings + Users, as an **author** they're hidden; `+ New post` still works on Posts; Logout works; `login.html` unaffected.

- [ ] **Step 5: Commit.**

```bash
git add uploader/public/*.html uploader/public/admin.css
git commit -m "feat(admin): use central #mainnav header menu on all admin pages"
```

---

## Self-Review

**Spec coverage:** central role-aware nav model + renderer → Task 1; `#mainnav` container on all 7 pages, Users moved out of `#whoami`, active marking, `+ New post` preserved as page action, admin.css active state → Task 2. Flat order, admin-only gating, editor→Posts highlight, login untouched — all covered. No tests (static UI) per spec.

**Placeholder scan:** No TBD/TODO. Task 1 carries the complete `auth.js` block; Task 2 the exact replacement markup. The admin.css step is conditional ("only if not distinct") with concrete CSS given — not a placeholder.

**Type consistency:** `#mainnav` (Task 1 renders into it; Task 2 creates it) and `#whoami` (unchanged) match. `renderHeader(s)` signature unchanged, so existing per-page `Auth.renderHeader(s)` calls keep working. `currentNavHref()`/`renderNav(s)` are internal to the IIFE; `NAV` hrefs match the routes in Global Constraints.
