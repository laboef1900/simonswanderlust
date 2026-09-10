import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The admin targets WCAG 2.2 AA (CLAUDE.md). These are the contracts an
// assistive-technology user relies on and that a markup edit can silently
// break: every field has a name, outcome messages are announced, and the
// locale switchers are real tabs. tabs.js is exercised in a vm sandbox like the
// other browser IIFEs (media-api.test.ts, admin-pages.test.ts).

const PAGES = ['editor', 'about', 'settings', 'posts', 'media', 'login', 'users', 'import', 'index'] as const;
const html = Object.fromEntries(PAGES.map((p) => [p, readFileSync(`public/${p}.html`, 'utf8')])) as Record<typeof PAGES[number], string>;
const markupOf = (page: string): string => page.slice(0, page.indexOf('<script'));

describe('admin form fields have accessible names', () => {
  for (const name of PAGES) {
    it(`${name}.html`, () => {
      const markup = markupOf(html[name]);
      const labelled = new Set([...markup.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
      const controls = [...markup.matchAll(/<(input|textarea|select)\b([^>]*)>/g)];
      const unnamed = controls
        .filter((m) => !/type="hidden"/.test(m[2]!))
        .filter((m) => !/\baria-label(ledby)?="/.test(m[2]!))
        .filter((m) => {
          const id = /\bid="([^"]+)"/.exec(m[2]!)?.[1];
          if (id && labelled.has(id)) return false;
          // Wrapped in a <label> that is still open at the control's position.
          const before = markup.slice(0, m.index!);
          return before.lastIndexOf('<label') < before.lastIndexOf('</label>');
        })
        .map((m) => m[0]);
      expect(unnamed).toEqual([]);
    });
  }
});

describe('admin outcome messages are announced (SC 4.1.3)', () => {
  const liveRoles = /role="(status|alert)"/;
  const cases: [typeof PAGES[number], string[]][] = [
    ['posts', ['out']], ['media', ['out']], ['import', ['out']], ['login', ['out', 'err']],
    ['users', ['out', 'pwout']], ['settings', ['out', 'backupStatus']],
    ['editor', ['actionStatus', 'actionError', 'deHeroStatus', 'enHeroStatus', 'deBodyImgStatus', 'enBodyImgStatus']],
    ['about', ['actionStatus', 'actionError', 'deBodyImgStatus', 'enBodyImgStatus']],
    ['index', ['deskStatus', 'deskError']],
  ];
  for (const [page, ids] of cases) {
    it(`${page}.html`, () => {
      for (const id of ids) {
        const tag = new RegExp(`<(pre|p)\\b[^>]*\\bid="${id}"[^>]*>`).exec(html[page])?.[0];
        expect(tag, `#${id} exists`).toBeDefined();
        expect(tag, `#${id} is a live region`).toMatch(liveRoles);
      }
    });
  }
  it('error lines interrupt, status lines do not (editor and login)', () => {
    const roleOf = (page: string, id: string) => new RegExp(`<(pre|p)\\b[^>]*\\bid="${id}"[^>]*>`).exec(page)?.[0];
    expect(roleOf(html.editor, 'actionError')).toMatch(/role="alert"/);
    expect(roleOf(html.editor, 'actionStatus')).toMatch(/role="status"/);
    expect(roleOf(html.login, 'err')).toMatch(/role="alert"/);
    expect(roleOf(html.login, 'out')).toMatch(/role="status"/);
  });
});

describe('locale switchers are ARIA tabs', () => {
  for (const page of ['editor', 'about'] as const) {
    it(`${page}.html wires tablist, tabs and panels together`, () => {
      const markup = markupOf(html[page]);
      expect(markup).toMatch(/role="tablist"[^>]*aria-label="/);
      const tabs = [...markup.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
      expect(tabs).toHaveLength(2);
      const selected = tabs.filter((t) => /aria-selected="true"/.test(t));
      expect(selected).toHaveLength(1);
      for (const tab of tabs) {
        const id = /\bid="([^"]+)"/.exec(tab)![1]!;
        const controls = /aria-controls="([^"]+)"/.exec(tab)![1]!;
        const panel = new RegExp(`<section\\b[^>]*\\bid="${controls}"[^>]*>`).exec(markup)?.[0];
        expect(panel, `panel #${controls}`).toBeDefined();
        expect(panel).toMatch(/role="tabpanel"/);
        expect(panel).toContain(`aria-labelledby="${id}"`);
        // Only the selected tab is in the Tab order; the other panel starts hidden.
        if (/aria-selected="true"/.test(tab)) expect(panel).not.toMatch(/\bhidden\b/);
        else { expect(tab).toMatch(/tabindex="-1"/); expect(panel).toMatch(/\bhidden\b/); }
      }
      expect(html[page]).toContain('<script src="/admin/tabs.js"></script>');
    });
  }
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

function loadTabs(): { de: TabNode; en: TabNode; panels: Record<string, Panel>; changes: string[]; api: { active(): string | null } } {
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
  const api = Tabs.wire({ querySelectorAll: () => [de, en] }, { onChange: (name: string) => changes.push(name) });
  return { de, en, panels, changes, api };
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
});
