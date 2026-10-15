import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

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

function shellSandbox(pathname: string) {
  const ids = new Map<string, StubElement>();
  const documentListeners = new Map<string, Listener[]>();
  let activeElement: StubElement | null = null;
  let renderedShell: StubElement | null = null;
  let shellHtml = '';

  const makeElement = (id = ''): StubElement => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const listeners = new Map<string, Listener[]>();
    const children: StubElement[] = [];
    const selectors = new Map<string, StubElement>();
    let focusables: StubElement[] = [];
    const element: StubElement = {
      id,
      className: '',
      textContent: '',
      hidden: false,
      inert: false,
      focused: false,
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name) ?? null; },
      hasAttribute(name) { return attrs.has(name); },
      appendChild(child) { children.push(child); },
      addEventListener(type, listener) {
        const registered = listeners.get(type);
        if (registered) registered.push(listener);
        else listeners.set(type, [listener]);
      },
      querySelector(selector) { return selectors.get(selector) ?? null; },
      querySelectorAll() { return focusables; },
      focus() {
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
  heading.textContent = 'Desk';
  const lede = makeElement();
  lede.textContent = 'Publishing overview';
  const meta = makeElement();
  (meta as StubElement & { setSelectors(map: Record<string, StubElement>): void }).setSelectors({ h1: heading, '.lede': lede });

  const body = makeElement();
  body.appendChild = (child) => { renderedShell = child; };

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
      return null;
    },
    createElement() {
      const shell = makeElement();
      Object.defineProperty(shell, 'innerHTML', {
        set(value: string) {
          shellHtml = value;
          const sidebar = makeElement('cmsSidebar');
          const menu = makeElement('cmsMenuBtn');
          menu.setAttribute('aria-expanded', 'false');
          menu.setAttribute('aria-label', 'Open menu');
          const scrim = makeElement('cmsNavScrim');
          scrim.hidden = true;
          const workspace = makeElement();
          const titleBlock = makeElement();
          const content = makeElement();
          const avatar = makeElement();
          const userName = makeElement();
          const userRole = makeElement();
          const close = makeElement('cmsNavClose');
          const logout = makeElement('cmsLogoutBtn');
          (sidebar as StubElement & { setFocusables(items: StubElement[]): void }).setFocusables([close, logout]);
          (shell as StubElement & { setSelectors(map: Record<string, StubElement>): void }).setSelectors({
            '#cmsSidebar': sidebar,
            '#cmsMenuBtn': menu,
            '#cmsNavScrim': scrim,
            '.cms-workspace': workspace,
            '.cms-title-block': titleBlock,
            '.cms-content': content,
            '.cms-avatar': avatar,
            '.cms-user-name': userName,
            '.cms-user-role': userRole,
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

  const context: Record<string, unknown> = {
    document: documentStub,
    location: { pathname, search: '', href: '' },
    fetch: async () => ({ json: async () => ({}) }),
    matchMedia: () => media,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(authSource, context);
  const Auth = context.Auth as { renderHeader(session: { username: string; isAdmin: boolean }): void };
  Auth.renderHeader({ username: 'simon', isAdmin: true });

  const shell = ((): StubElement | null => renderedShell)();
  if (!shell) throw new Error('auth.js did not render the shell');
  const sidebar = shell.querySelector('#cmsSidebar')!;
  const menu = shell.querySelector('#cmsMenuBtn')!;
  const scrim = shell.querySelector('#cmsNavScrim')!;
  const workspace = shell.querySelector('.cms-workspace')!;
  const focusables = sidebar.querySelectorAll('a, button');

  return {
    main,
    sidebar,
    menu,
    scrim,
    workspace,
    first: focusables[0]!,
    last: focusables.at(-1)!,
    html: shellHtml,
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

describe('Auth navigation shell', () => {
  it('marks the logical current page, including editor as part of Posts', () => {
    const desk = shellSandbox('/admin/index.html');
    expect(desk.html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(desk.html).toMatch(/href="\/admin\/" class="cms-nav-item" aria-current="page"/);

    const editor = shellSandbox('/admin/editor.html');
    expect(editor.html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(editor.html).toMatch(/href="\/admin\/posts\.html" class="cms-nav-item" aria-current="page"/);
  });

  it('opens into the drawer, traps Tab, and Escape returns focus to the trigger', () => {
    const shell = shellSandbox('/admin/');
    shell.menu.fire('click');
    expect(shell.sidebar.classList.contains('is-open')).toBe(true);
    expect(shell.menu.getAttribute('aria-expanded')).toBe('true');
    expect(shell.scrim.hidden).toBe(false);
    expect(shell.workspace.inert).toBe(true);
    expect(shell.first.focused).toBe(true);

    shell.last.focus();
    expect(shell.key('Tab').defaultPrevented).toBe(true);
    expect(shell.first.focused).toBe(true);
    expect(shell.key('Tab', true).defaultPrevented).toBe(true);
    expect(shell.last.focused).toBe(true);

    expect(shell.key('Escape').defaultPrevented).toBe(true);
    expect(shell.sidebar.classList.contains('is-open')).toBe(false);
    expect(shell.menu.getAttribute('aria-expanded')).toBe('false');
    expect(shell.scrim.hidden).toBe(true);
    expect(shell.workspace.inert).toBe(false);
    expect(shell.menu.focused).toBe(true);
  });

  it('offers an in-drawer close control and restores the menu trigger', () => {
    const shell = shellSandbox('/admin/');
    shell.menu.fire('click');
    shell.first.fire('click');
    expect(shell.sidebar.classList.contains('is-open')).toBe(false);
    expect(shell.workspace.inert).toBe(false);
    expect(shell.menu.focused).toBe(true);
  });

  it('closes stale mobile state when the layout crosses to desktop', () => {
    const shell = shellSandbox('/admin/');
    shell.menu.fire('click');
    shell.resizeToDesktop();
    expect(shell.sidebar.classList.contains('is-open')).toBe(false);
    expect(shell.menu.getAttribute('aria-expanded')).toBe('false');
    expect(shell.scrim.hidden).toBe(true);
    expect(shell.workspace.inert).toBe(false);
  });

  it('makes the skip-link target programmatically focusable', () => {
    const shell = shellSandbox('/admin/');
    expect(shell.main.id).toBe('cms-main');
    expect(shell.main.getAttribute('tabindex')).toBe('-1');
    expect(shell.html).toContain('class="skip-link" href="#cms-main"');
  });
});
