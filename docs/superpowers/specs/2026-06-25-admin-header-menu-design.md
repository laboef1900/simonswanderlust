# Design — Unified Admin Header Menu

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — ready for implementation planning

## Problem

Each admin page (`index`, `batch`, `posts`, `import`, `settings`, `users`, `editor`) hand-maintains
its own `<nav>` in the masthead. They've **drifted**: `index`/`batch`/`settings` omit Users + Import,
`users` omits Import, only `posts` has the full set. The admin-only sections (LLM settings, Users)
are shown to everyone, so an author sees links that just redirect. There's no single source of truth,
so every new section means editing seven files (and forgetting some).

## Goal

One consistent, **role-aware** main menu rendered from a single place, on every admin page, with the
current page highlighted — eliminating the drift.

## Decisions (from brainstorming)

- **Flat menu**, in order: **Hero upload · Batch uploader · Posts · Import · LLM settings\* · Users\***
  (\* = admin-only; hidden entirely for non-admin authors).
- **Centralize in `auth.js`** (it already runs on every admin page via `ensureAuthed`/`renderHeader`
  and knows `username` + `isAdmin`). Pages keep the existing masthead chrome (eyebrow/title/lede,
  `#whoami`); only the `<nav>` becomes a centrally-filled container.
- Keep the existing masthead look — `admin.css` already styles `.masthead nav a` and the active state
  `[aria-current='page']`, so no visual redesign is needed, just correct + consistent content.

## Source facts (verified)

- Masthead shape (all 7 pages): `<header class="masthead"><div class="masthead-inner"> eyebrow · h1 ·
  lede · <nav>…</nav> · <p id="whoami"></p> </div></header>`.
- `auth.js` exposes `window.Auth` with `ensureAuthed`, `renderHeader(s)`, `logout`. `renderHeader`
  currently fills `#whoami` with "Logged in as X · [Users (admin)] · Logout" — the Users link is
  awkwardly in this line.
- `admin.css`: `.masthead nav`, `.masthead nav a`, `:hover`, and `nav a[aria-current='page']` already
  defined.
- Routes: `/admin/` (Hero), `/admin/batch.html`, `/admin/posts.html`, `/admin/import.html`,
  `/admin/settings.html` (admin), `/admin/users.html` (admin), `/admin/editor.html` (reached from
  Posts; shows the header but is not itself a top-level menu item).

## Architecture

### `auth.js` — the single nav model + renderer

Add a module-level ordered list:
```js
const NAV = [
  { label: 'Hero upload',    href: '/admin/' },
  { label: 'Batch uploader', href: '/admin/batch.html' },
  { label: 'Posts',          href: '/admin/posts.html' },
  { label: 'Import',         href: '/admin/import.html' },
  { label: 'LLM settings',   href: '/admin/settings.html', admin: true },
  { label: 'Users',          href: '/admin/users.html',    admin: true },
];
```
`renderHeader(s)` (called from each page's load gate after `ensureAuthed`) now fills **two** elements:
1. **`#mainnav`** (the menu): for each `NAV` item where `!item.admin || s.isAdmin`, append an `<a href>`
   built with `textContent` (no innerHTML). Mark the item whose href matches the current page as the
   active one — set `aria-current="page"` when `normalizePath(location.pathname) === item.href`
   (treat `/admin/` and `/admin/index.html` as equal; `/admin/editor.html` highlights Posts since it's
   the content section it belongs to). All links via DOM API — XSS-safe.
2. **`#whoami`** (unchanged purpose): "Logged in as **X** · Logout" — the **Users link is removed**
   from here (it now lives in the main nav, admin-gated).

`renderHeader` no-ops gracefully if `#mainnav`/`#whoami` are absent (e.g. `login.html`).

### Per-page change (7 admin pages)

Replace the hardcoded `<nav>…links…</nav>` inside `.masthead-inner` with an empty
`<nav id="mainnav" aria-label="Admin"></nav>`. Keep the page's eyebrow/h1/lede and `#whoami`. Each
page already calls `Auth.ensureAuthed()` + `Auth.renderHeader(s)` on load — no JS change per page
beyond ensuring that call happens (it already does on the auth'd pages).

`login.html` is unchanged (pre-auth, no masthead nav). The Posts page keeps its `+ New post` action
button (a page action, not a global menu item).

### `admin.css`

No redesign required — the active-state rule exists. Minor: ensure the nav reads as a proper menu bar
(it already uses `.masthead nav` flex/spacing); add a small refinement only if the active state isn't
visually distinct enough (e.g. a brand-red underline on `[aria-current='page']`).

## Error handling / edge cases

- A page without `#mainnav` (login) → `renderHeader` skips nav rendering (guarded).
- Author (non-admin): admin-only items omitted from the menu; if they deep-link to an admin page,
  the existing `ensureAuthed({admin:true})` gate still redirects them (unchanged).
- Brief render: the nav appears once `auth/status` resolves (same gate the page already waits on) —
  acceptable for an internal tool; no server-rendered flash of wrong links.

## Testing

Static client UI — no unit tests. Verify by loading each admin page (admin account AND an author
account): every page shows the identical menu, admin-only items appear only for admins, the current
page is highlighted, and Logout/whoami work. Confirm `login.html` is unaffected.

## Non-Goals (YAGNI)

- No hamburger/mobile drawer (desktop admin tool; the bar wraps).
- No grouping/sub-menus (flat list).
- No server-side rendering of the nav (centralizing in `auth.js` is the single source of truth).
- `editor.html` is not added as a top-level menu item (reached via Posts).
