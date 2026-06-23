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
    const adminLink = s.isAdmin ? ' · <a href="/admin/users.html">Users</a>' : '';
    el.innerHTML = 'Logged in as <strong>' + s.username + '</strong>' + adminLink +
      ' · <a href="#" id="logoutLink">Logout</a>';
    document.getElementById('logoutLink').addEventListener('click', (e) => { e.preventDefault(); logout(); });
  }
  return { status, ensureAuthed, logout, renderHeader };
})();
