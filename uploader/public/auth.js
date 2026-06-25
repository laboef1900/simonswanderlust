// Shared admin-auth helpers. Pages call ensureAuthed() on load; on 401 anywhere,
// redirect to /login. The session cookie is sent automatically (same-origin).
window.Auth = (function () {
  async function status() {
    const r = await fetch('/auth/status');
    return r.json();
  }
  async function ensureAuthed(opts) {
    const want = opts || {};
    const s = await status();
    if (!s.authenticated) { location.href = '/login'; return null; }
    if (want.admin && !s.isAdmin) { location.href = '/admin/'; return null; }
    return s;
  }
  async function logout() {
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  }
  // Single source of truth for the admin main menu (admin-only items gated below).
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
    const p = location.pathname;
    if (p === '/admin' || p === '/admin/index.html') return '/admin/';
    if (p === '/admin/editor.html') return '/admin/posts.html';
    return p;
  }

  // Renders the role-aware main menu into #mainnav, marking the active page.
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
  return { status, ensureAuthed, logout, renderHeader };
})();
