import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ui } from '../../site/src/i18n/ui.js';

const authSource = readFileSync('public/auth.js', 'utf8');

type BrowserEvent = {
  key?: string;
  shiftKey?: boolean;
  matches?: boolean;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
};
type Listener = (event: BrowserEvent) => void;

interface StubElement {
  id: string;
  className: string;
  textContent: string;
  hidden: boolean;
  inert: boolean;
  focused: boolean;
  /** Ancestor whose `inert` blocks focus, as a browser would. */
  inertRoot: StubElement | null;
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
  addEventListener(type: string, listener: Listener): void;
  querySelector(selector: string): StubElement | null;
  querySelectorAll(selector: string): StubElement[];
  focus(): void;
  remove(): void;
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
}

function shellSandbox(pathname: string, options: SandboxOptions = {}) {
  const { isAdmin = true, pageActions = false } = options;
  const ids = new Map<string, StubElement>();
  const documentListeners = new Map<string, Listener[]>();
  let activeElement: StubElement | null = null;
  let renderedShell: StubElement | null = null;
  let shellHtml = '';
  const selectorsOf = new Map<StubElement, Map<string, StubElement>>();

  const makeElement = (id = ''): StubElement => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const listeners = new Map<string, Listener[]>();
    const selectors = new Map<string, StubElement>();
    let focusables: StubElement[] = [];
    const element: StubElement = {
      id,
      className: '',
      textContent: '',
      hidden: false,
      inert: false,
      focused: false,
      inertRoot: null,
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
      addEventListener(type, listener) {
        const registered = listeners.get(type);
        if (registered) registered.push(listener);
        else listeners.set(type, [listener]);
      },
      querySelector(selector) { return selectors.get(selector) ?? null; },
      querySelectorAll() { return focusables; },
      focus() {
        if (element.inertRoot?.inert) return;
        if (activeElement) activeElement.focused = false;
        activeElement = element;
        element.focused = true;
      },
      remove() {},
      fire(type, event = {}) {
        const fired: BrowserEvent = { ...event, defaultPrevented: false };
        fired.preventDefault = () => { fired.defaultPrevented = true; };
        for (const listener of listeners.get(type) ?? []) listener(fired);
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
          const close = makeElement('cmsNavClose');
          const logout = makeElement('cmsLogoutBtn');
          sidebar.setFocusables([close, logout]);
          shell.setSelectors({
            '.cms-masthead': masthead,
            '.cms-brand-mark': makeElement(),
            '.cms-brand-title': makeElement(),
            '.cms-masthead-right > .cms-brand-sub': makeElement(),
            '.cms-workspace-nav': makeElement(),
            '.cms-journal-title': makeElement(),
            '.cms-sidebar-header .cms-brand-sub': makeElement(),
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
  const context: Record<string, unknown> = {
    EditorCopy: { en: copy },
    document: documentStub,
    location: { pathname, search: '', href: '' },
    fetch: async () => ({ json: async () => ({}) }),
    matchMedia: () => media,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(authSource, context);
  const Auth = context.Auth as { renderHeader(session: { username: string; isAdmin: boolean }): void };
  Auth.renderHeader({ username: 'simon', isAdmin });

  const shell = ((): StubElement | null => renderedShell)();
  if (!shell) throw new Error('auth.js did not render the shell');
  const part = (selector: string) => {
    const found = selectorsOf.get(shell)?.get(selector);
    if (!found) throw new Error('shell is missing ' + selector);
    return found;
  };
  const sidebar = part('#cmsSidebar');
  const focusables = sidebar.querySelectorAll('a, button');

  return {
    copy,
    main,
    heading,
    lede,
    actions,
    part,
    sidebar,
    menu: part('#cmsMenuBtn'),
    scrim: part('#cmsNavScrim'),
    masthead: part('.cms-masthead'),
    workspace: part('.cms-workspace'),
    first: focusables[0]!,
    last: focusables.at(-1)!,
    html: shellHtml,
    get renders() { return renders; },
    renderAgain() { Auth.renderHeader({ username: 'simon', isAdmin }); },
    key(key: string, shiftKey = false) {
      const event: BrowserEvent = { key, shiftKey, defaultPrevented: false };
      event.preventDefault = () => { event.defaultPrevented = true; };
      for (const listener of documentListeners.get('keydown') ?? []) listener(event);
      return event;
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

const workspaceLinks = (html: string) =>
  [...html.matchAll(/href="([^"]+)" class="cms-workspace-link( is-active)?"/g)]
    .map(([, href, active]) => ({ href, active: Boolean(active) }));

describe('Auth navigation shell', () => {
  it('marks the logical current page, including editor as part of Posts', () => {
    const desk = shellSandbox('/admin/index.html');
    expect(desk.html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(desk.html).toMatch(/href="\/admin\/" class="cms-nav-item" aria-current="page"/);

    const editor = shellSandbox('/admin/editor.html');
    expect(editor.html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(editor.html).toMatch(/href="\/admin\/posts\.html" class="cms-nav-item" aria-current="page"/);
  });

  it('highlights the masthead workspace that owns the current page', () => {
    const active = (pathname: string) =>
      workspaceLinks(shellSandbox(pathname).html).filter((link) => link.active).map((link) => link.href);
    expect(active('/admin/editor.html')).toEqual(['/admin/posts.html']);
    expect(active('/admin/')).toEqual(['/admin/posts.html']);
    expect(active('/admin/media.html')).toEqual(['/admin/media.html']);
    expect(active('/admin/users.html')).toEqual(['/admin/settings.html']);
  });

  it('offers Manage and the admin pages to admins only', () => {
    const admin = shellSandbox('/admin/', { isAdmin: true });
    expect(workspaceLinks(admin.html).map((link) => link.href))
      .toEqual(['/admin/posts.html', '/admin/media.html', '/admin/settings.html']);

    const author = shellSandbox('/admin/', { isAdmin: false });
    expect(workspaceLinks(author.html).map((link) => link.href))
      .toEqual(['/admin/posts.html', '/admin/media.html']);
    for (const page of ['about', 'comments', 'import', 'settings', 'users']) {
      expect(author.html).not.toContain('href="/admin/' + page + '.html"');
    }
    expect(author.part('.cms-user-role').textContent).toBe('Author');
  });

  it('keeps the page heading as the workspace h1 and moves page commands into the title row', () => {
    const shell = shellSandbox('/admin/posts.html', { pageActions: true });
    expect(shell.part('.cms-title-block').children).toEqual([shell.heading, shell.lede]);
    expect(shell.heading.className).toBe('cms-page-title');
    expect(shell.part('.cms-topbar-right').children).toEqual([shell.actions]);
    expect(shell.part('.cms-content').children).toEqual([shell.main]);
  });

  it('labels the workspace nav and sets the username as text', () => {
    const shell = shellSandbox('/admin/');
    expect(shell.part('.cms-workspace-nav').getAttribute('aria-label')).toBe(shell.copy.shellWorkspaceNav);
    expect(shell.part('.cms-journal-title').textContent).toBe(shell.copy.shellJournal);
    expect(shell.part('.cms-user-name').textContent).toBe('simon');
    expect(shell.html).not.toContain('simon');
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
