// Shared admin-auth helpers. Pages call ensureAuthed() on load; on 401 anywhere,
// redirect to /login (carrying a ?next= return URL back to the current page).
// The session cookie is sent automatically (same-origin).
window.Auth = (function () {
  async function status() {
    const r = await fetch('/auth/status');
    return r.json();
  }
  async function ensureAuthed(opts) {
    const want = opts || {};
    const s = await status();
    if (!s.authenticated) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      return null;
    }
    if (want.admin && !s.isAdmin) { location.href = '/admin/'; return null; }
    return s;
  }
  async function logout() {
    await fetch('/logout', { method: 'POST' });
    location.href = '/login';
  }
  // Single source of truth for the admin main menu.
  const NAV = [
    {
      label: 'Dashboard',
      href: '/admin/',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>'
    },
    {
      label: 'Posts & Content',
      href: '/admin/posts.html',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>'
    },
    {
      label: 'Media Library',
      href: '/admin/media.html',
      admin: true,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
    },
    {
      label: 'About Page',
      href: '/admin/about.html',
      admin: true,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>'
    },
    {
      label: 'Import WXR',
      href: '/admin/import.html',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
    },
    {
      label: 'Site Settings',
      href: '/admin/settings.html',
      admin: true,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
    },
    {
      label: 'Users',
      href: '/admin/users.html',
      admin: true,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
    },
  ];

  function currentNavHref() {
    const p = location.pathname;
    if (p === '/admin' || p === '/admin/index.html') return '/admin/';
    if (p === '/admin/editor.html') return '/admin/posts.html';
    return p;
  }

  function renderHeader(s) {
    // Check if modern shell already injected
    if (document.querySelector('.cms-app-shell')) return;

    // Traditional nav element fallback if present
    const legacyNav = document.getElementById('mainnav');
    if (legacyNav) {
      legacyNav.textContent = '';
      const here = currentNavHref();
      for (const item of NAV) {
        if (item.admin && !s.isAdmin) continue;
        const a = document.createElement('a');
        a.href = item.href;
        a.textContent = item.label;
        if (item.href === here) a.setAttribute('aria-current', 'page');
        legacyNav.appendChild(a);
      }
    }

    const legacyWhoami = document.getElementById('whoami');
    if (legacyWhoami) {
      legacyWhoami.textContent = 'Logged in as ' + s.username;
    }

    // Build modern CMS layout container dynamically
    const body = document.body;
    const masthead = document.querySelector('.masthead');
    const main = document.querySelector('main');
    if (!masthead || !main) return;

    const pageTitle = masthead.querySelector('h1')?.textContent || 'CMS Studio';
    const pageLede = masthead.querySelector('.lede')?.textContent || '';
    masthead.style.display = 'none';

    // Wrap body content into CMS Studio Shell
    const shell = document.createElement('div');
    shell.className = 'cms-app-shell';

    const here = currentNavHref();

    shell.innerHTML = `
      <aside class="cms-sidebar">
        <div class="cms-sidebar-header">
          <div class="cms-brand-badge">W</div>
          <div class="cms-brand-text">
            <span class="cms-brand-title">Wanderlust CMS</span>
            <span class="cms-brand-sub">Expedition Studio</span>
          </div>
        </div>
        <div class="cms-sidebar-action">
          <a href="/admin/editor.html" class="cms-btn-new">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Post
          </a>
        </div>
        <nav class="cms-nav-group">
          <div class="cms-nav-heading">Content Management</div>
          ${NAV.map(item => {
            if (item.admin && !s.isAdmin) return '';
            const isActive = item.href === here;
            return `
              <a href="${item.href}" class="cms-nav-item" ${isActive ? 'aria-current="page"' : ''}>
                ${item.icon}
                <span>${item.label}</span>
              </a>
            `;
          }).join('')}
        </nav>

        <div class="cms-sidebar-footer">
          <div class="cms-user-badge">
            <div class="cms-avatar">${s.username[0].toUpperCase()}</div>
            <div class="cms-user-info">
              <span class="cms-user-name">${s.username}</span>
              <span class="cms-user-role">${s.isAdmin ? 'Administrator' : 'Author'}</span>
            </div>
          </div>
          <button id="cmsLogoutBtn" class="cms-logout-btn" title="Logout">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </aside>

      <div class="cms-workspace">
        <header class="cms-topbar">
          <div class="cms-topbar-left">
            <div class="cms-breadcrumbs">
              <span class="cms-crumb">Studio</span>
              <span class="cms-crumb-sep">/</span>
              <span class="cms-crumb-active">${pageTitle}</span>
            </div>
            ${pageLede ? `<p class="cms-page-lede">${pageLede}</p>` : ''}
          </div>
          <div class="cms-topbar-right">
            <div class="cms-status-indicator">
              <span class="cms-pulse-dot"></span>
              <span>System Live</span>
            </div>
            <a href="/" target="_blank" class="cms-btn-ghost" title="View Live Blog">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              View Site
            </a>
          </div>
        </header>
        <div class="cms-content"></div>
      </div>
    `;

    // Move main element into .cms-content
    const contentArea = shell.querySelector('.cms-content');
    if (contentArea) {
      contentArea.appendChild(main);
    }

    body.appendChild(shell);

    document.getElementById('cmsLogoutBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });
  }

  return { status, ensureAuthed, logout, renderHeader };
})();

