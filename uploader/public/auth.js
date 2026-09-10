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

  const ICON = {
    desk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
    posts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    media: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    about: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  };

  // Single source of truth for the admin main menu.
  const NAV = [
    { group: 'Journal', label: 'Desk', href: '/admin/', icon: ICON.desk },
    { group: 'Journal', label: 'Posts', href: '/admin/posts.html', icon: ICON.posts },
    { group: 'Journal', label: 'Media', href: '/admin/media.html', icon: ICON.media },
    { group: 'Journal', label: 'About', href: '/admin/about.html', admin: true, icon: ICON.about },
    { group: 'Site', label: 'Import', href: '/admin/import.html', admin: true, icon: ICON.import },
    { group: 'Site', label: 'Settings', href: '/admin/settings.html', admin: true, icon: ICON.settings },
    { group: 'Site', label: 'Users', href: '/admin/users.html', admin: true, icon: ICON.users },
  ];

  function currentNavHref() {
    const p = location.pathname;
    if (p === '/admin' || p === '/admin/index.html') return '/admin/';
    if (p === '/admin/editor.html') return '/admin/posts.html';
    return p;
  }

  function navMarkup(s, here) {
    const visible = NAV.filter((item) => !item.admin || s.isAdmin);
    let html = '';
    let lastGroup = '';
    for (const item of visible) {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        html += '<p class="cms-nav-heading">' + item.group + '</p>';
      }
      const current = item.href === here ? ' aria-current="page"' : '';
      html += '<a href="' + item.href + '" class="cms-nav-item"' + current + '>' +
        item.icon + '<span>' + item.label + '</span></a>';
    }
    return html;
  }

  function closeNav(shell) {
    const sidebar = shell.querySelector('#cmsSidebar');
    const btn = shell.querySelector('#cmsMenuBtn');
    const scrim = shell.querySelector('#cmsNavScrim');
    sidebar.classList.remove('is-open');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Open menu');
    }
    if (scrim) scrim.hidden = true;
  }

  function openNav(shell) {
    const sidebar = shell.querySelector('#cmsSidebar');
    const btn = shell.querySelector('#cmsMenuBtn');
    const scrim = shell.querySelector('#cmsNavScrim');
    sidebar.classList.add('is-open');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Close menu');
    }
    if (scrim) scrim.hidden = false;
  }

  function renderHeader(s) {
    if (document.querySelector('.cms-app-shell')) return;

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

    const body = document.body;
    const masthead = document.querySelector('.masthead');
    const main = document.querySelector('main');
    if (!masthead || !main) return;

    const pageTitle = masthead.querySelector('h1')?.textContent || 'Image Station';
    const pageLede = masthead.querySelector('.lede')?.textContent || '';
    masthead.hidden = true;

    if (!main.id) main.id = 'cms-main';

    const here = currentNavHref();
    const shell = document.createElement('div');
    shell.className = 'cms-app-shell';
    shell.innerHTML =
      '<a class="skip-link" href="#' + main.id + '">Skip to content</a>' +
      '<div class="cms-nav-scrim" id="cmsNavScrim" hidden></div>' +
      '<aside class="cms-sidebar" id="cmsSidebar">' +
        '<div class="cms-sidebar-header">' +
          '<div class="cms-brand-text">' +
            '<span class="cms-brand-title">Image Station</span>' +
            '<span class="cms-brand-sub">Expedition Log</span>' +
          '</div>' +
        '</div>' +
        '<div class="cms-sidebar-action">' +
          '<a href="/admin/editor.html" class="cms-btn-new">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
            'New trip' +
          '</a>' +
        '</div>' +
        '<nav class="cms-nav-group" aria-label="Admin">' +
          navMarkup(s, here) +
        '</nav>' +
        '<div class="cms-sidebar-footer">' +
          '<div class="cms-user-badge">' +
            '<div class="cms-avatar" aria-hidden="true"></div>' +
            '<div class="cms-user-info">' +
              '<span class="cms-user-name"></span>' +
              '<span class="cms-user-role"></span>' +
            '</div>' +
          '</div>' +
          '<button type="button" id="cmsLogoutBtn" class="cms-logout-btn" aria-label="Log out">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
          '</button>' +
        '</div>' +
      '</aside>' +
      '<div class="cms-workspace">' +
        '<header class="cms-topbar">' +
          '<div class="cms-topbar-left">' +
            '<button type="button" class="cms-menu-btn" id="cmsMenuBtn" aria-expanded="false" aria-controls="cmsSidebar" aria-label="Open menu">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
            '</button>' +
            '<div class="cms-title-block">' +
              '<h1 class="cms-page-title"></h1>' +
              '<p class="cms-page-lede" hidden></p>' +
            '</div>' +
          '</div>' +
          '<div class="cms-topbar-right">' +
            '<a href="/" target="_blank" rel="noopener" class="cms-btn-ghost">View site</a>' +
          '</div>' +
        '</header>' +
        '<div class="cms-content"></div>' +
      '</div>';

    // The username is the one user-controlled string in this shell; it is set
    // as text AFTER the parse so it can never be markup (#131).
    shell.querySelector('.cms-avatar').textContent = (s.username[0] || '?').toUpperCase();
    shell.querySelector('.cms-user-name').textContent = s.username;
    shell.querySelector('.cms-user-role').textContent = s.isAdmin ? 'Admin' : 'Author';
    shell.querySelector('.cms-page-title').textContent = pageTitle;
    const ledeEl = shell.querySelector('.cms-page-lede');
    if (pageLede) {
      ledeEl.textContent = pageLede;
      ledeEl.hidden = false;
    }

    const contentArea = shell.querySelector('.cms-content');
    contentArea.appendChild(main);
    body.appendChild(shell);

    document.getElementById('cmsLogoutBtn').addEventListener('click', (e) => {
      e.preventDefault();
      logout();
    });

    const menuBtn = document.getElementById('cmsMenuBtn');
    const scrim = document.getElementById('cmsNavScrim');
    menuBtn.addEventListener('click', () => {
      if (shell.querySelector('#cmsSidebar').classList.contains('is-open')) closeNav(shell);
      else openNav(shell);
    });
    scrim.addEventListener('click', () => closeNav(shell));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeNav(shell);
    });
  }

  return { status, ensureAuthed, logout, renderHeader };
})();
