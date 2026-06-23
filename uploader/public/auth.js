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
  // Renders "Logged in as X · [Users] · Logout" into #whoami, if present.
  function renderHeader(s) {
    const el = document.getElementById('whoami');
    if (!el) return;
    el.textContent = '';
    el.appendChild(document.createTextNode('Logged in as '));
    const strong = document.createElement('strong');
    strong.textContent = s.username;
    el.appendChild(strong);
    if (s.isAdmin) {
      el.appendChild(document.createTextNode(' · '));
      const usersLink = document.createElement('a');
      usersLink.href = '/admin/users.html';
      usersLink.textContent = 'Users';
      el.appendChild(usersLink);
    }
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
