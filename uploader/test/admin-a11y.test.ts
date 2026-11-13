import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { computeAccessibleName } from 'dom-accessibility-api';

// The admin targets WCAG 2.2 AA (CLAUDE.md). These are the contracts an
// assistive-technology user relies on and that a markup edit can silently
// break: every field has a name, outcome messages are announced, and the
// locale switchers are real tabs. tabs.js is exercised in a vm sandbox like the
// other browser IIFEs (media-api.test.ts, admin-pages.test.ts).

const PAGES = ['editor', 'about', 'settings', 'posts', 'media', 'login', 'users', 'import', 'index'] as const;
const html = Object.fromEntries(PAGES.map((p) => [p, readFileSync(`public/${p}.html`, 'utf8')])) as Record<typeof PAGES[number], string>;
const markupOf = (page: string): string => page.slice(0, page.indexOf('<script'));

const windows: Window[] = [];
afterEach(async () => { await Promise.all(windows.splice(0).map(window => window.happyDOM.close())); });
function documentOf(markup: string) {
  const window = new Window();
  windows.push(window);
  return new window.DOMParser().parseFromString(markup, 'text/html');
}
function controlNames(markup: string) {
  return [...documentOf(markup).querySelectorAll('input:not([type="hidden"]), textarea, select')]
    .map(control => ({ id: control.id, name: computeAccessibleName(control as unknown as Element) }));
}

describe('accessible form names', () => {
  // Other admin pages populate translated labels at runtime. Their actual visible
  // controls are checked in e2e/studio.spec.ts, rather than accepting empty markup.
  it('names the real sign-in fields', () => {
    expect(controlNames(markupOf(html.login))).toEqual([
      { id: 'username', name: 'Username' }, { id: 'password', name: 'Password' },
    ]);
  });
  it.each([
    '<input id="field">',
    '<label>Earlier label</label><input id="field">',
    '<label for="different">Wrong field</label><input id="field">',
    '<input id="field" aria-label="">',
    '<input id="field" aria-labelledby="missing">',
    '<span id="empty"></span><input id="field" aria-labelledby="empty">',
  ])('rejects missing, empty and dangling names: %s', markup => {
    expect(controlNames(markup)).toEqual([{ id: 'field', name: '' }]);
  });
  it.each([
    '<label for="field">Photo title</label><input id="field">',
    '<label>Photo title<input id="field"></label>',
    '<input id="field" aria-label="Photo title">',
    '<span id="title">Photo</span><span id="kind">title</span><input id="field" aria-labelledby="title kind">',
  ])('resolves explicit, wrapped and ARIA names: %s', markup => {
    expect(controlNames(markup)).toEqual([{ id: 'field', name: 'Photo title' }]);
  });
});

describe('admin outcome messages are announced (SC 4.1.3)', () => {
  const liveRoles = /^(status|alert)$/;
  const cases: [typeof PAGES[number], string[]][] = [
    ['posts', ['out']], ['media', ['out']], ['import', ['out']], ['login', ['out', 'err']],
    ['users', ['out', 'pwout']],
    ['settings', ['out', 'backupStatus', 'reviewModelStatus', 'captionModelStatus', 'previewOut']],
    // Audit and draft-state announcements are exercised with editor interactions
    // in editor-dom.test.ts rather than pinned to a particular HTML tag.
    ['editor', ['actionStatus', 'actionError', 'deHeroStatus', 'enHeroStatus', 'deBodyImgStatus', 'enBodyImgStatus']],
    ['about', ['actionStatus', 'actionError', 'deBodyImgStatus', 'enBodyImgStatus']],
    // Desk loading/error announcements are exercised through the real page's
    // DOM and async auth retry in onboarding-dom.test.ts, not an HTML tag regex.
  ];
  for (const [page, ids] of cases) {
    it(`${page}.html`, () => {
      for (const id of ids) {
        const node = documentOf(html[page]).getElementById(id);
        expect(node, `#${id} exists`).not.toBeNull();
        expect(node?.getAttribute('role'), `#${id} is a live region`).toMatch(liveRoles);
      }
    });
  }
  it('error lines interrupt, status lines do not (editor and login)', () => {
    const roleOf = (page: string, id: string) => documentOf(page).getElementById(id)?.getAttribute('role');
    expect(roleOf(html.editor, 'actionError')).toBe('alert');
    expect(roleOf(html.editor, 'actionStatus')).toBe('status');
    expect(roleOf(html.login, 'err')).toBe('alert');
    expect(roleOf(html.login, 'out')).toBe('status');
  });
});

// ---- tabs.js behaviour ----------------------------------------------------

interface TabNode {
  id: string;
  dataset: { tab: string };
  tabIndex: number;
  attrs: Record<string, string>;
  classes: Set<string>;
  focused: boolean;
  listeners: Record<string, ((ev: Record<string, unknown>) => void)[]>;
  classList: { toggle(c: string, on: boolean): void };
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, fn: (ev: Record<string, unknown>) => void): void;
  focus(): void;
  fire(t: string, ev?: Record<string, unknown>): void;
}
interface Panel { id: string; hidden: boolean }

function tabNode(id: string, selected: boolean): TabNode {
  const node: TabNode = {
    id, dataset: { tab: id.replace('tabbtn-', '') }, tabIndex: selected ? 0 : -1,
    attrs: { 'aria-controls': 'tab-' + id.replace('tabbtn-', ''), 'aria-selected': String(selected) },
    classes: new Set(selected ? ['active'] : []), focused: false, listeners: {},
    classList: { toggle(c, on) { if (on) node.classes.add(c); else node.classes.delete(c); } },
    setAttribute(k, v) { node.attrs[k] = v; },
    getAttribute(k) { return node.attrs[k] ?? null; },
    addEventListener(t, fn) { (node.listeners[t] ??= []).push(fn); },
    focus() { node.focused = true; },
    fire(t, ev = {}) { for (const fn of node.listeners[t] ?? []) fn({ preventDefault() {}, ...ev }); },
  };
  return node;
}

function loadTabs(orientation: 'horizontal' | 'vertical' | null = null): {
  de: TabNode; en: TabNode; panels: Record<string, Panel>; changes: string[]; api: { active(): string | null };
  list: { attrs: Record<string, string> };
} {
  const de = tabNode('tabbtn-de', true);
  const en = tabNode('tabbtn-en', false);
  const panels: Record<string, Panel> = { 'tab-de': { id: 'tab-de', hidden: false }, 'tab-en': { id: 'tab-en', hidden: true } };
  const ctx: Record<string, unknown> = {
    document: { getElementById: (id: string) => panels[id] ?? null },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync('public/tabs.js', 'utf8'), ctx);
  const changes: string[] = [];
  const Tabs = ctx.Tabs as { wire(list: unknown, opts: unknown): { active(): string | null } };
  const list = {
    attrs: orientation ? { 'aria-orientation': orientation } as Record<string, string> : {},
    querySelectorAll: () => [de, en],
    getAttribute(k: string): string | null { return list.attrs[k] ?? null; },
  };
  const api = Tabs.wire(list, { onChange: (name: string) => changes.push(name) });
  return { de, en, panels, changes, api, list };
}

describe('Tabs.wire', () => {
  it('starts from the markup without firing onChange', () => {
    const t = loadTabs();
    expect(t.changes).toEqual([]);
    expect(t.api.active()).toBe('de');
    expect(t.panels['tab-en']!.hidden).toBe(true);
  });

  it('click selects, swaps aria-selected, the roving tabindex and the panels', () => {
    const t = loadTabs();
    t.en.fire('click');
    expect(t.changes).toEqual(['en']);
    expect(t.en.attrs['aria-selected']).toBe('true');
    expect(t.de.attrs['aria-selected']).toBe('false');
    expect([t.de.tabIndex, t.en.tabIndex]).toEqual([-1, 0]);
    expect(t.en.classes.has('active')).toBe(true);
    expect(t.de.classes.has('active')).toBe(false);
    expect(t.panels['tab-de']!.hidden).toBe(true);
    expect(t.panels['tab-en']!.hidden).toBe(false);
  });

  it('arrow keys move focus and selection together, wrapping; Home/End jump', () => {
    const t = loadTabs();
    t.de.fire('keydown', { key: 'ArrowRight' });
    expect(t.api.active()).toBe('en');
    expect(t.en.focused).toBe(true);
    t.en.fire('keydown', { key: 'ArrowRight' });
    expect(t.api.active()).toBe('de');
    t.de.fire('keydown', { key: 'ArrowLeft' });
    expect(t.api.active()).toBe('en');
    t.en.fire('keydown', { key: 'Home' });
    expect(t.api.active()).toBe('de');
    t.de.fire('keydown', { key: 'End' });
    expect(t.api.active()).toBe('en');
    expect(t.changes).toEqual(['en', 'de', 'en', 'de', 'en']);
  });

  it('ignores keys that are not tab navigation', () => {
    const t = loadTabs();
    t.de.fire('keydown', { key: 'Tab' });
    t.de.fire('keydown', { key: 'Enter' });
    expect(t.api.active()).toBe('de');
    expect(t.changes).toEqual([]);
  });

  it('a vertical list moves with Up/Down and ignores Left/Right', () => {
    const t = loadTabs('vertical');
    t.de.fire('keydown', { key: 'ArrowRight' });
    expect(t.api.active()).toBe('de');
    t.de.fire('keydown', { key: 'ArrowDown' });
    expect(t.api.active()).toBe('en');
    expect(t.en.focused).toBe(true);
    t.en.fire('keydown', { key: 'ArrowDown' });
    expect(t.api.active()).toBe('de');
    t.de.fire('keydown', { key: 'ArrowUp' });
    expect(t.api.active()).toBe('en');
    t.en.fire('keydown', { key: 'Home' });
    expect(t.api.active()).toBe('de');
    expect(t.changes).toEqual(['en', 'de', 'en', 'de']);
  });

  it('reads the orientation per key press, so a page can flip it at a breakpoint', () => {
    const t = loadTabs('vertical');
    t.list.attrs['aria-orientation'] = 'horizontal';
    t.de.fire('keydown', { key: 'ArrowDown' });
    expect(t.api.active()).toBe('de');
    t.de.fire('keydown', { key: 'ArrowRight' });
    expect(t.api.active()).toBe('en');
  });
});
