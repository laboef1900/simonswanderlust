import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ui } from '../../site/src/i18n/ui.js';

const authSource = readFileSync('public/auth.js', 'utf8');

type BrowserEvent = {
  key?: string;
  shiftKey?: boolean;
  matches?: boolean;
  target?: StubElement;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
};
type Listener = (event: BrowserEvent) => void;

interface StubElement {
  id: string;
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  inert: boolean;
  /** A `<details>` element's open state. */
  open: boolean;
  focused: boolean;
  /** Ancestor whose `inert` blocks focus, as a browser would. */
  inertRoot: StubElement | null;
  /** Nearest modelled ancestor: key events bubble through it, `closest` walks it. */
  parent: StubElement | null;
  children: StubElement[];
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  appendChild(child: StubElement): void;
  prepend(child: StubElement): void;
  addEventListener(type: string, listener: Listener): void;
  querySelector(selector: string): StubElement | null;
  querySelectorAll(selector: string): StubElement[];
  /** Tag-name selectors only (`closest('details')`). */
  closest(selector: string): StubElement | null;
  contains(other: StubElement | null | undefined): boolean;
  focus(): void;
  remove(): void;
  dispatch(type: string, event: BrowserEvent): void;
  fire(type: string, event?: BrowserEvent): BrowserEvent;
}

type SelectorHost = StubElement & {
  setSelectors(map: Record<string, StubElement>): void;
  setFocusables(items: StubElement[]): void;
};

interface SandboxOptions {
  isAdmin?: boolean;
  /** Render a page that declares a `.cms-page-actions` command group. */
  pageActions?: boolean;
  identity?: { siteName: string; studioDescriptor: { de?: string; en?: string }; canonicalOrigin: string | null };
  search?: string;
  response?: () => Promise<Response>;
}

function shellSandbox(pathname: string, options: SandboxOptions = {}) {
  const { isAdmin = true, pageActions = false } = options;
  const ids = new Map<string, StubElement>();
  const documentListeners = new Map<string, Listener[]>();
  let activeElement: StubElement | null = null;
  let renderedShell: StubElement | null = null;
  let shellHtml = '';
  const selectorsOf = new Map<StubElement, Map<string, StubElement>>();

  const makeElement = (id = '', tagName = 'DIV'): StubElement => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const listeners = new Map<string, Listener[]>();
    const selectors = new Map<string, StubElement>();
    let focusables: StubElement[] = [];
    const element: StubElement = {
      id,
      tagName,
      className: '',
      textContent: '',
      hidden: false,
      inert: false,
      open: false,
      focused: false,
      inertRoot: null,
      parent: null,
      children: [],
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name) ?? null; },
      hasAttribute(name) { return attrs.has(name); },
      appendChild(child) { element.children.push(child); },
      prepend(child) { element.children.unshift(child); },
      addEventListener(type, listener) {
        const registered = listeners.get(type);
        if (registered) registered.push(listener);
        else listeners.set(type, [listener]);
      },
      querySelector(selector) { return selectors.get(selector) ?? null; },
      querySelectorAll() { return focusables; },
      closest(selector) {
        for (let node: StubElement | null = element; node; node = node.parent) {
          if (node.tagName.toLowerCase() === selector) return node;
        }
        return null;
      },
      contains(other) {
        for (let node = other ?? null; node; node = node.parent) if (node === element) return true;
        return false;
      },
      focus() {
        if (element.inertRoot?.inert) return;
        if (activeElement) activeElement.focused = false;
        activeElement = element;
        element.focused = true;
      },
      remove() {},
      dispatch(type, event) {
        for (const listener of listeners.get(type) ?? []) listener(event);
      },
      fire(type, event = {}) {
        const fired: BrowserEvent = { ...event, defaultPrevented: false };
        fired.preventDefault = () => { fired.defaultPrevented = true; };
        element.dispatch(type, fired);
        return fired;
      },
    };
    selectorsOf.set(element, selectors);
    Object.assign(element, {
      setSelectors(map: Record<string, StubElement>) {
        for (const [selector, child] of Object.entries(map)) selectors.set(selector, child);
      },
      setFocusables(items: StubElement[]) { focusables = items; },
    });
    if (id) ids.set(id, element);
    return element;
  };

  const main = makeElement();
  const heading = makeElement();
  const lede = makeElement();
  const meta = makeElement() as SelectorHost;
  meta.setSelectors({ h1: heading, '.lede': lede });
  const actions = pageActions ? makeElement() : null;

  const body = makeElement();
  let renders = 0;
  body.appendChild = (child) => { renderedShell = child; renders += 1; };

  const mediaListeners: Listener[] = [];
  const media = {
    matches: true,
    addEventListener(type: string, listener: Listener) {
      if (type === 'change') mediaListeners.push(listener);
    },
  };

  const documentStub = {
    title: 'Posts',
    body,
    get activeElement() { return activeElement; },
    querySelector(selector: string) {
      if (selector === '.cms-app-shell') return renderedShell;
      if (selector === 'main') return main;
      if (selector === '.cms-page-meta') return meta;
      if (selector === '.cms-page-actions') return actions;
      return null;
    },
    createElement() {
      const shell = makeElement() as SelectorHost;
      Object.defineProperty(shell, 'innerHTML', {
        set(value: string) {
          shellHtml = value;
          const masthead = makeElement();
          const menu = makeElement('cmsMenuBtn');
          menu.inertRoot = masthead;
          menu.setAttribute('aria-expanded', 'false');
          menu.setAttribute('aria-label', 'Open menu');
          const sidebar = makeElement('cmsSidebar') as SelectorHost;
          const scrim = makeElement('cmsNavScrim');
          scrim.hidden = true;
          const workspace = makeElement();
          const close = makeElement('cmsNavClose', 'BUTTON');
          const accountMenu = makeElement('cmsAccountMenu', 'DETAILS');
          const accountTrigger = makeElement('', 'SUMMARY');
          accountTrigger.parent = accountMenu;
          const logout = makeElement('cmsLogoutBtn', 'BUTTON');
          logout.parent = accountMenu;
          sidebar.setFocusables([close, accountTrigger, logout]);
          shell.setSelectors({
            '.cms-masthead': masthead,
            '.cms-brand-mark': makeElement(),
            '.cms-brand-title': makeElement(),
            '.cms-masthead-right > .cms-brand-sub': makeElement(),
            '#cmsAccountMenu': accountMenu,
            '.cms-account-menu__trigger': accountTrigger,
            '.cms-sidebar-footer': makeElement(),
            '#cmsSidebar': sidebar,
            '#cmsMenuBtn': menu,
            '#cmsNavScrim': scrim,
            '.cms-workspace': workspace,
            '.cms-title-block': makeElement(),
            '.cms-topbar-right': makeElement(),
            '.cms-content': makeElement(),
            '.cms-avatar': makeElement(),
            '.cms-user-name': makeElement(),
            '.cms-user-role': makeElement(),
          });
        },
      });
      return shell;
    },
    getElementById(id: string) { return ids.get(id) ?? null; },
    addEventListener(type: string, listener: Listener) {
      const registered = documentListeners.get(type);
      if (registered) registered.push(listener);
      else documentListeners.set(type, [listener]);
    },
  };

  const copy = Object.fromEntries(Object.entries(ui.en)
    .filter(([key]) => key.startsWith('editor.chrome.'))
    .map(([key, value]) => [key.slice('editor.chrome.'.length), value]));
  copy.siteTitleFallback = ui.en['site.titleFallback'];
  const navigation = Promise.withResolvers<string>();
  let href = '';
  const location = {
    pathname,
    search: options.search ?? '',
    get href() { return href; },
    set href(next: string) { href = next; navigation.resolve(next); },
  };
  const requests: { url: string; method: string | undefined }[] = [];
  const requestOptions: (RequestInit | undefined)[] = [];
  const context: Record<string, unknown> = {
    SiteIdentity: options.identity,
    EditorCopy: { en: copy },
    document: documentStub,
    location,
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method });
      requestOptions.push(init);
      return options.response ? options.response() : Response.json({});
    },
    matchMedia: () => media,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(authSource, context);
  const Auth = context.Auth as {
    renderHeader(session: { username: string; isAdmin: boolean }): void;
    ensureAuthed(options?: { admin?: boolean }): Promise<{
      authenticated: true; userId: string; username: string; isAdmin: boolean; needsSetup: false;
    } | null>;
    status(): Promise<unknown>;
  };
  Auth.renderHeader({ username: 'simon', isAdmin });

  const shell = ((): StubElement | null => renderedShell)();
  if (!shell) throw new Error('auth.js did not render the shell');
  const part = (selector: string) => {
    const found = selectorsOf.get(shell)?.get(selector);
    if (!found) throw new Error('shell is missing ' + selector);
    return found;
  };
  const sidebar = part('#cmsSidebar');
  const accountTrigger = part('.cms-account-menu__trigger');

  return {
    Auth,
    location,
    requestOptions,
    get title() { return documentStub.title; },
    main,
    heading,
    lede,
    actions,
    part,
    sidebar,
    navigated: navigation.promise,
    requests,
    menu: part('#cmsMenuBtn'),
    scrim: part('#cmsNavScrim'),
    masthead: part('.cms-masthead'),
    workspace: part('.cms-workspace'),
    accountMenu: part('#cmsAccountMenu'),
    accountTrigger,
    logout: ids.get('cmsLogoutBtn')!,
    first: sidebar.querySelectorAll('a, button')[0]!,
    /** The drawer's last focusable while the account menu is closed. */
    last: accountTrigger,
    html: shellHtml,
    get renders() { return renders; },
    renderAgain() { Auth.renderHeader({ username: 'simon', isAdmin }); },
    /** A keydown on the focused element, bubbling through its ancestors to the document. */
    key(key: string, shiftKey = false) {
      const event: BrowserEvent = { key, shiftKey, defaultPrevented: false };
      event.preventDefault = () => { event.defaultPrevented = true; };
      for (let node = activeElement; node; node = node.parent) node.dispatch('keydown', event);
      for (const listener of documentListeners.get('keydown') ?? []) listener(event);
      return event;
    },
    click(target: StubElement) {
      for (const listener of documentListeners.get('click') ?? []) listener({ target });
    },
    resizeToDesktop() {
      media.matches = false;
      for (const listener of mediaListeners) listener({ matches: false });
    },
  };
}

/** The drawer's moving parts, as returned by `shellSandbox`. */
interface DrawerParts {
  sidebar: StubElement;
  menu: StubElement;
  scrim: StubElement;
  masthead: StubElement;
  workspace: StubElement;
}

function expectDrawerOpen(shell: DrawerParts) {
  expect(shell.sidebar.classList.contains('is-open')).toBe(true);
  expect(shell.menu.getAttribute('aria-expanded')).toBe('true');
  expect(shell.scrim.hidden).toBe(false);
  expect(shell.masthead.inert).toBe(true);
  expect(shell.workspace.inert).toBe(true);
}

function expectDrawerClosed(shell: DrawerParts) {
  expect(shell.sidebar.classList.contains('is-open')).toBe(false);
  expect(shell.menu.getAttribute('aria-expanded')).toBe('false');
  expect(shell.scrim.hidden).toBe(true);
  expect(shell.masthead.inert).toBe(false);
  expect(shell.workspace.inert).toBe(false);
}

describe('Auth navigation shell', () => {
  it.each(['/admin/', '/admin', '/admin/index.html'])('shows a neutral actionable domain notice on the admin Desk at %s', (path) => {
    const shell = shellSandbox(path, {
      identity: { siteName: '', studioDescriptor: {}, canonicalOrigin: null },
    });
    const [notice, main] = shell.part('.cms-content').children;
    expect(notice!.id).toBe('deskDomainNotice');
    expect(notice!.className).toBe('muted');
    expect(notice!.getAttribute('role')).toBe('status');
    expect(notice!.textContent).toBe(ui.en['editor.chrome.identityDomainUnset'] + ' ');
    expect(notice!.children[0]!.textContent).toBe(ui.en['editor.chrome.identityDomainConfigure']);
    expect(notice!.children[0]!.getAttribute('href')).toBe('/admin/settings.html#identity');
    expect(main).toBe(shell.main);
  });

  it('does not show the domain notice on configured sites, author Desks or unrelated pages', () => {
    for (const shell of [
      shellSandbox('/admin/', { identity: { siteName: '', studioDescriptor: {}, canonicalOrigin: 'https://blog.example' } }),
      shellSandbox('/admin/', { isAdmin: false }),
      shellSandbox('/admin/editor.html'),
    ]) {
      expect(shell.part('.cms-content').children).toEqual([shell.main]);
    }
  });

  it('paints configured identity as text, never as shell markup', () => {
    const hostile = '</title><img src=x onerror=alert(1)>';
    const shell = shellSandbox('/admin/posts.html', {
      identity: { siteName: hostile, studioDescriptor: { en: '<script>descriptor()</script>' }, canonicalOrigin: null },
    });
    expect(shell.title).toBe('Posts · ' + hostile);
    expect(shell.part('.cms-masthead-right > .cms-brand-sub').textContent).toBe('<script>descriptor()</script>');
    expect(shell.html).not.toContain(hostile);
    expect(shell.html).not.toContain('<script>descriptor()');
  });

  it('falls back from an empty descriptor to site name, then localized neutral name', () => {
    const named = shellSandbox('/admin/posts.html', { identity: { siteName: 'Field notes', studioDescriptor: { de: 'Inactive text' }, canonicalOrigin: null } });
    expect(named.part('.cms-masthead-right > .cms-brand-sub').textContent).toBe('Field notes');
    const neutral = shellSandbox('/admin/posts.html');
    expect(neutral.part('.cms-masthead-right > .cms-brand-sub').textContent).toBe(ui.en['site.titleFallback']);
    expect(neutral.title).toBe('Posts · ' + ui.en['site.titleFallback']);
  });

  it('marks the logical current page, including editor as part of Posts', () => {
    const desk = shellSandbox('/admin/index.html');
    expect(desk.html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(desk.html).toMatch(/href="\/admin\/" class="cms-nav-item" aria-current="page"/);

    const editor = shellSandbox('/admin/editor.html');
    expect(editor.html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(editor.html).toMatch(/href="\/admin\/posts\.html" class="cms-nav-item" aria-current="page"/);

    for (const path of ['/admin/pages.html', '/admin/about.html']) {
      const pages = shellSandbox(path);
      expect(pages.html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(pages.html).toMatch(/href="\/admin\/pages\.html" class="cms-nav-item" aria-current="page"/);
    }
  });

  it('offers the admin pages in the sidebar to admins only', () => {
    const adminOnly = ['pages', 'comments', 'import', 'settings', 'users']
      .map((page) => '/admin/' + page + '.html');
    const [admin, author] = [true, false].map((isAdmin) => shellSandbox('/admin/', { isAdmin }));
    const [adminLinks, authorLinks] = [admin!, author!].map((shell) =>
      [...shell.html.matchAll(/href="([^"]+)" class="cms-nav-item"/g)].map(([, href]) => href));

    expect(adminLinks).toEqual(expect.arrayContaining(adminOnly));
    expect(admin!.part('.cms-user-role').textContent).toBe('Admin');

    expect(authorLinks).toEqual(['/admin/', '/admin/posts.html', '/admin/media.html']);
    for (const href of adminOnly) expect(author!.html).not.toContain('href="' + href + '"');
    expect(author!.part('.cms-user-role').textContent).toBe('Author');
  });

  it('keeps the page heading as the workspace h1 and moves page commands into the title row', () => {
    const shell = shellSandbox('/admin/posts.html', { pageActions: true });
    expect(shell.part('.cms-title-block').children).toEqual([shell.heading, shell.lede]);
    expect(shell.heading.className).toBe('cms-page-title');
    expect(shell.part('.cms-topbar-right').children).toEqual([shell.actions]);
    expect(shell.part('.cms-content').children).toEqual([shell.main]);
  });

  it('sets the username as text and names the account menu after it', () => {
    const shell = shellSandbox('/admin/');
    expect(shell.part('.cms-user-name').textContent).toBe('simon');
    expect(shell.accountTrigger.getAttribute('aria-label')).toBe('Account menu for simon');
    expect(shell.html).not.toContain('simon');
  });

  it('puts the open account menu in the drawer Tab trap, and Escape closes it before the drawer', () => {
    const shell = shellSandbox('/admin/');
    shell.menu.fire('click');
    // The <summary> toggles the <details> natively.
    shell.accountMenu.open = true;

    shell.logout.focus();
    expect(shell.key('Tab').defaultPrevented).toBe(true);
    expect(shell.first.focused).toBe(true);
    expect(shell.key('Tab', true).defaultPrevented).toBe(true);
    expect(shell.logout.focused).toBe(true);

    expect(shell.key('Escape').defaultPrevented).toBe(true);
    expect(shell.accountMenu.open).toBe(false);
    expect(shell.accountTrigger.focused).toBe(true);
    expectDrawerOpen(shell);

    shell.key('Escape');
    expectDrawerClosed(shell);
    expect(shell.menu.focused).toBe(true);
  });

  it('closes the account menu on Escape and on a click outside it on desktop', () => {
    const shell = shellSandbox('/admin/');
    shell.resizeToDesktop();
    shell.accountMenu.open = true;
    shell.click(shell.logout);
    expect(shell.accountMenu.open).toBe(true);
    shell.click(shell.main);
    expect(shell.accountMenu.open).toBe(false);

    shell.accountMenu.open = true;
    shell.accountTrigger.focus();
    expect(shell.key('Escape').defaultPrevented).toBe(true);
    expect(shell.accountMenu.open).toBe(false);
    expect(shell.accountTrigger.focused).toBe(true);
  });

  it('logs out from the account menu', async () => {
    const shell = shellSandbox('/admin/');
    shell.accountMenu.open = true;
    expect(shell.logout.fire('click').defaultPrevented).toBe(true);
    expect(await shell.navigated).toBe('/login');
    expect(shell.requests).toEqual([{ url: '/logout', method: 'POST' }]);
  });

  it('renders the shell only once', () => {
    const shell = shellSandbox('/admin/');
    expect(shell.renders).toBe(1);
    shell.renderAgain();
    expect(shell.renders).toBe(1);
  });

  it('opens into the drawer, traps Tab, and Escape returns focus to the trigger', () => {
    const shell = shellSandbox('/admin/');
    shell.menu.fire('click');
    expectDrawerOpen(shell);
    expect(shell.first.focused).toBe(true);

    shell.last.focus();
    expect(shell.key('Tab').defaultPrevented).toBe(true);
    expect(shell.first.focused).toBe(true);
    expect(shell.key('Tab', true).defaultPrevented).toBe(true);
    expect(shell.last.focused).toBe(true);

    expect(shell.key('Escape').defaultPrevented).toBe(true);
    expectDrawerClosed(shell);
    expect(shell.menu.focused).toBe(true);
  });

  it('pulls focus that is outside the drawer back into it', () => {
    const shell = shellSandbox('/admin/');
    shell.menu.fire('click');
    shell.main.focus();
    expect(shell.key('Tab').defaultPrevented).toBe(true);
    expect(shell.first.focused).toBe(true);
    shell.main.focus();
    expect(shell.key('Tab', true).defaultPrevented).toBe(true);
    expect(shell.last.focused).toBe(true);
  });

  it('offers an in-drawer close control and restores the menu trigger', () => {
    const shell = shellSandbox('/admin/');
    shell.menu.fire('click');
    shell.first.fire('click');
    expectDrawerClosed(shell);
    expect(shell.menu.focused).toBe(true);
  });

  it('closes on the scrim and releases the masthead before refocusing its trigger', () => {
    const shell = shellSandbox('/admin/');
    shell.menu.fire('click');
    expectDrawerOpen(shell);
    shell.scrim.fire('click');
    expectDrawerClosed(shell);
    // The stub refuses focus inside an inert masthead, so this also pins the order.
    expect(shell.menu.focused).toBe(true);
  });

  it('closes stale mobile state when the layout crosses to desktop', () => {
    const shell = shellSandbox('/admin/');
    shell.menu.fire('click');
    shell.resizeToDesktop();
    expectDrawerClosed(shell);
  });

  it('makes the skip-link target programmatically focusable', () => {
    const shell = shellSandbox('/admin/');
    expect(shell.main.id).toBe('cms-main');
    expect(shell.main.getAttribute('tabindex')).toBe('-1');
    expect(shell.html).toContain('class="skip-link" href="#cms-main"');
  });
});

describe('Auth protected-page context', () => {
  const context = (isAdmin: boolean) => ({
    authenticated: true, userId: 'user-1', username: 'author', isAdmin, needsSetup: false,
  });

  it.each([true, false])('retains identity and roles from the non-cacheable context, admin=%s', async (isAdmin) => {
    const shell = shellSandbox('/admin/', { response: async () => Response.json(context(isAdmin)) });
    expect(await shell.Auth.ensureAuthed()).toEqual(context(isAdmin));
    expect(shell.requests).toEqual([{ url: '/auth/me', method: undefined }]);
    expect(shell.requestOptions).toEqual([{ cache: 'no-store' }]);
    expect(shell.location.href).toBe('');
  });

  it('preserves the admin gate without redirecting an ordinary author page', async () => {
    const shell = shellSandbox('/admin/settings.html', { response: async () => Response.json(context(false)) });
    expect(await shell.Auth.ensureAuthed({ admin: true })).toBeNull();
    expect(shell.location.href).toBe('/admin/');
    const admin = shellSandbox('/admin/settings.html', { response: async () => Response.json(context(true)) });
    expect(await admin.Auth.ensureAuthed({ admin: true })).toEqual(context(true));
    expect(admin.location.href).toBe('');
  });

  it('redirects only a 401 to a safely encoded local return path including the query', async () => {
    const shell = shellSandbox('/admin/editor.html', {
      search: '?tk=abc&next=https://untrusted.example/',
      response: async () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    });
    expect(await shell.Auth.ensureAuthed()).toBeNull();
    expect(shell.location.href).toBe('/login?next=' + encodeURIComponent('/admin/editor.html?tk=abc&next=https://untrusted.example/'));
  });

  it.each([403, 429, 500, 503])('retains HTTP %s as unavailable, never logged out', async (status) => {
    const shell = shellSandbox('/admin/', { response: async () => Response.json({ error: 'unavailable' }, { status }) });
    await expect(shell.Auth.ensureAuthed()).rejects.toThrow('auth_context_unavailable');
    expect(shell.location.href).toBe('');
  });

  it.each([
    async () => { throw new TypeError('network unavailable'); },
    async () => new Response('{'),
    async () => Response.json({ authenticated: false, needsSetup: true }),
    async () => Response.json({ ...context(true), isAdmin: 'true' }),
    async () => Response.json({ ...context(true), userId: undefined }),
  ])('retains a network or malformed context failure without granting access or navigating', async (response) => {
    const shell = shellSandbox('/admin/', { response });
    await expect(shell.Auth.ensureAuthed()).rejects.toThrow();
    expect(shell.location.href).toBe('');
  });

  it('keeps the login/setup status helper on its existing public contract', async () => {
    const status = { authenticated: false, needsSetup: true };
    const shell = shellSandbox('/login', { response: async () => Response.json(status) });
    expect(await shell.Auth.status()).toEqual(status);
    expect(shell.requests).toEqual([{ url: '/auth/status', method: undefined }]);
    expect(shell.requestOptions).toEqual([undefined]);
    expect(shell.location.href).toBe('');
  });
});
