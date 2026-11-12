import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from '../../site/node_modules/happy-dom/lib/index.js';
import type {
  Element, HTMLElement, HTMLOptionElement, HTMLSelectElement, IKeyboardEventInit, MutationRecord, Text,
} from '../../site/node_modules/happy-dom/lib/index.js';

// The real browser script, evaluated in a happy-dom window per test. happy-dom
// has no layout, so the cases that depend on geometry stub it explicitly.
const source = readFileSync('public/admin-select.js', 'utf8');

interface Rect { top: number; bottom: number; left: number; right: number }
interface Placement { above: boolean; maxHeight: number; alignEnd: boolean; minWidth: number; maxWidth: number }
interface Menu { sync(): void; close(): void; trigger: HTMLElement }
interface AdminSelectApi {
  enhance(select: HTMLSelectElement, opts?: { label?: string }): Menu;
  typeahead(labels: string[], enabled: boolean[], start: number, query: string): number;
  place(input: {
    trigger: Rect; boundary: Rect; panelHeight: number; panelWidth: number;
    cap?: number; gap?: number; margin?: number; minHeight?: number; widthCap?: number;
  }): Placement;
}
/** The generated nodes a geometry stub or a placement check needs. */
interface Parts { box: HTMLElement; wrapper: HTMLElement; panel: HTMLElement; options(): HTMLElement[] }

const opt = (value: string, text: string, attrs = '') => `<option value="${value}" ${attrs}>${text}</option>`;
const field = (id: string, label: string, options: string[], attrs = '') =>
  `<div class="filter-field filter-field--menu"><select id="${id}" aria-label="${label}" ${attrs}>${options.join('')}</select></div>`;

// Posts' status filter in a single-language install: the missing-translation option is hidden and disabled.
const STATUS = field('fStatus', 'Status', [
  opt('', 'All'), opt('draft', 'Draft'), opt('published', 'Published'), opt('unpublished', 'Unpublished changes'),
  opt('missing-secondary', 'Missing translation', 'id="missing" hidden disabled'),
]);
const SORT = field('fSort', 'Sort', [opt('updated', 'Updated'), opt('date', 'Trip date'), opt('title', 'Title')]);
const COUNTRY = field('fCountry', 'Country', [opt('', 'All'), opt('Chile', 'Chile'), opt('Peru', 'Peru'), opt('Uruguay', 'Uruguay')]);
// Disabled options at both ends and in the middle, and a hidden one: only Base camp, Exit and Ferry can be reached.
const MIXED = field('fStop', 'Stop', [
  opt('a', 'Arrival', 'disabled'), opt('b', 'Base camp'), opt('c', 'Col', 'disabled'), opt('d', 'Descent', 'hidden'),
  opt('e', 'Exit'), opt('f', 'Ferry'), opt('g', 'Gate', 'disabled'),
]);
// "All" and Country 01 … 24, with 03 disabled and 07 hidden.
const PAGED = field('fCountry', 'Country', [opt('', 'All'), ...Array.from({ length: 24 }, (_, at) => {
  const name = 'Country ' + String(at + 1).padStart(2, '0');
  return opt(name, name, at === 2 ? 'disabled' : at === 6 ? 'hidden' : '');
})]);
const NAMES = ['All', 'Germany', 'Namibia', 'Nauru', 'Nepal', 'New Caledonia', 'New Zealand', 'Norway', 'North Macedonia', 'Oman'];
const TYPED = field('fCountry', 'Country', NAMES.map((name) => opt(name === 'All' ? '' : name, name, name === 'Nauru' ? 'disabled' : '')));

const windows: Window[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

/** A page with `markup` and one more control in its body, and admin-select.js loaded. */
function page(markup: string, viewport: { width?: number; height?: number } = {}) {
  const window = new Window({ url: 'https://admin.example/admin/posts.html', ...viewport });
  windows.push(window);
  // happy-dom has no HTMLOptionElement.label. This is the HTML definition: the
  // label attribute when there is one, else the option's text, white space collapsed.
  Object.defineProperty(window.HTMLOptionElement.prototype, 'label', {
    configurable: true,
    get(this: HTMLOptionElement): string {
      return this.getAttribute('label') ?? this.textContent.trim().replace(/\s+/g, ' ');
    },
  });
  window.document.body.innerHTML = markup + '<button id="next" type="button">Next control</button>';
  window.eval(source);
  return { window, document: window.document, api: window.eval('AdminSelect') as AdminSelectApi };
}

/** `page(markup)` with the select `id` enhanced, plus what a test presses and reads. */
function mount(markup = STATUS, id = 'fStatus', viewport: { width?: number; height?: number } = {}) {
  const { window, document, api } = page(markup, viewport);
  const select = document.getElementById(id) as HTMLSelectElement;
  // What the page hears, in order: the select's own listeners, then the document's (the events bubble).
  const events: string[] = [];
  for (const type of ['input', 'change']) {
    select.addEventListener(type, () => events.push(type));
    document.addEventListener(type, () => events.push('document ' + type));
  }
  const menu = api.enhance(select);
  // `menu.trigger` is the role="combobox" control; it sits beside the caption in the visible .admin-select__trigger box.
  const control = menu.trigger;
  const box = control.parentElement as HTMLElement;
  const wrapper = box.parentElement as HTMLElement;
  const caption = box.querySelector('.admin-select__label') as HTMLElement;
  const panel = wrapper.querySelector('.admin-select__panel') as HTMLElement;
  const value = wrapper.querySelector('.admin-select__value') as HTMLElement;
  const next = document.getElementById('next') as HTMLElement;
  const options = () => Array.from(panel.children) as HTMLElement[];
  const labels = () => options().map((node) => node.textContent);
  const option = (label: string) => {
    const node = options().find((candidate) => candidate.textContent === label);
    if (!node) throw new Error('No option labelled ' + label);
    return node;
  };
  const key = (name: string, init: IKeyboardEventInit = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
    control.dispatchEvent(event);
    return event;
  };
  const pointer = (type: string, target: Element) => {
    const event = new window.PointerEvent(type, { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  /** Open or closed — with every signal of that state agreeing. */
  const isOpen = () => {
    const open = control.getAttribute('aria-expanded') === 'true';
    expect(control.getAttribute('aria-expanded')).toBe(String(open));
    expect(panel.hidden).toBe(!open);
    expect(wrapper.classList.contains('is-open')).toBe(open);
    expect(control.hasAttribute('aria-activedescendant')).toBe(open);
    return open;
  };
  /** The label of the active option: the one aria-activedescendant names, which is the only `.is-active` one. */
  const active = () => {
    const named = control.getAttribute('aria-activedescendant');
    const marked = options().filter((node) => node.classList.contains('is-active'));
    expect(marked.map((node) => node.id)).toEqual(named === null ? [] : [named]);
    return marked[0]?.textContent ?? null;
  };
  /** The labels of the selected options: every option says aria-selected, and `.is-selected` agrees with it. */
  const selected = () => {
    const marks = options().map((node) => node.getAttribute('aria-selected'));
    expect(marks).toEqual(options().map((node) => String(node.classList.contains('is-selected'))));
    return labels().filter((_, at) => marks[at] === 'true');
  };
  const isSet = () => wrapper.classList.contains('is-set');
  const focused = () => document.activeElement.id;
  return { window, document, api, select, menu, control, box, caption, wrapper, panel, value, next, events, options, labels, option, key, pointer, isOpen, active, selected, isSet, focused };
}

const COMMITTED = ['input', 'document input', 'change', 'document change'];
const microtask = () => Promise.resolve();

/** What posts.html's fillOptions does: keep the leading option, replace the rest, keep a still-valid choice. */
function refill(select: HTMLSelectElement, names: string[]) {
  const previous = select.value;
  while (select.options.length > 1) select.remove(1);
  for (const name of names) {
    const option = select.ownerDocument.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = names.includes(previous) ? previous : '';
}

/** Every DOM change under `target` from now on. */
function watch(window: Window, target: Element) {
  const seen: { type: string; added: number; removed: number }[] = [];
  const note = (records: MutationRecord[]) => {
    for (const record of records) seen.push({ type: record.type, added: record.addedNodes.length, removed: record.removedNodes.length });
  };
  const observer = new window.MutationObserver(note);
  observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
  return () => {
    note(observer.takeRecords());
    return seen;
  };
}

/** happy-dom binds the real timers when it is imported; hand the page Vitest's fake ones. */
function fakeClock(window: Window) {
  vi.useFakeTimers();
  Object.assign(window, { setTimeout, clearTimeout });
}

const rect = (top: number, left: number, width: number, height: number) =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top });
/** Gives a node the geometry happy-dom cannot compute. */
function stub(node: object, values: Record<string, unknown>) {
  for (const [name, value] of Object.entries(values)) Object.defineProperty(node, name, { configurable: true, value });
}
/**
 * A layout for one test, as happy-dom has none: the panel's content box starts
 * 100px down the viewport, under a 1px border, and shows `rows` 30px options at
 * a time. Options drawn later are laid out too.
 */
function layOut(window: Window, panel: HTMLElement, rows: number) {
  stub(panel, { clientTop: 1, clientHeight: rows * 30 });
  vi.spyOn(window.Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === panel) return new window.DOMRect(0, 99, 202, rows * 30 + 2);
    const at = Array.from(panel.children).indexOf(this);
    return at < 0 ? new window.DOMRect() : new window.DOMRect(0, 100 + at * 30 - panel.scrollTop, 200, 30);
  });
}

describe('AdminSelect.enhance: structure and accessible name', () => {
  it('keeps the select as the hidden source of truth and inserts the menu right after it', () => {
    const h = mount(STATUS.replace('</div>', '<p id="hint">Shown under the control</p></div>'));
    expect(h.select.isConnected).toBe(true);
    expect(h.select.id).toBe('fStatus');
    expect(h.select.hidden).toBe(true);
    expect(h.select.value).toBe('');
    expect(h.select.nextElementSibling === h.wrapper).toBe(true);
    expect(h.wrapper.parentElement === h.select.parentElement).toBe(true);
    expect(h.wrapper.nextElementSibling?.id).toBe('hint');
    expect(h.wrapper.tagName).toBe('DIV');
    expect(h.wrapper.className).toBe('admin-select');
    expect(Array.from(h.wrapper.children).map((node) => node.className)).toEqual(['admin-select__trigger', 'admin-select__panel']);
    expect(h.events).toEqual([]);
  });

  it('puts a closed combobox in a plain box, controlling a hidden listbox', () => {
    const h = mount();
    // The visible box is no control itself: it has no role, no tab stop and no ARIA state.
    expect(h.box === h.wrapper.firstElementChild).toBe(true);
    expect(h.box.tagName).toBe('DIV');
    expect(Array.from(h.box.attributes).map((attr) => attr.name)).toEqual(['class']);
    expect(Array.from(h.box.children).map((node) => node.className)).toEqual(['admin-select__label', 'admin-select__control']);

    expect(h.menu.trigger === h.box.lastElementChild).toBe(true);
    expect(h.control.tagName).toBe('DIV');
    expect(h.control.id).toBe('fStatus-combo');
    expect(h.control.getAttribute('role')).toBe('combobox');
    expect(h.control.getAttribute('tabindex')).toBe('0');
    expect(h.control.getAttribute('aria-haspopup')).toBe('listbox');
    expect(h.control.getAttribute('aria-controls')).toBe('fStatus-listbox');
    expect(h.control.hasAttribute('aria-disabled')).toBe(false);
    expect(h.isOpen()).toBe(false);

    expect(h.panel.tagName).toBe('UL');
    expect(h.panel.id).toBe('fStatus-listbox');
    expect(h.panel.getAttribute('role')).toBe('listbox');
    expect(h.panel.getAttribute('tabindex')).toBe('-1');
  });

  it('names the combobox and the listbox with exactly the label', () => {
    const h = mount();
    const name = h.document.getElementById('fStatus-label') as HTMLElement;
    expect(h.control.getAttribute('aria-labelledby')).toBe('fStatus-label');
    expect(h.panel.getAttribute('aria-labelledby')).toBe('fStatus-label');
    expect(name.textContent).toBe('Status');
    expect(h.control.hasAttribute('aria-label')).toBe(false);

    // The visible caption is hidden from assistive technology, and its colon
    // sits outside the node that names the control.
    expect(h.caption.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(h.caption.children).map((node) => node.textContent)).toEqual(['Status', ':']);
    expect(h.caption.firstElementChild === name).toBe(true);
    expect(h.box.textContent).toBe('Status:All');
  });

  it('holds nothing but the value in the combobox, so its value is never read with the caption', () => {
    const h = mount();
    expect(h.control.textContent).toBe('All');
    expect(Array.from(h.control.children).map((node) => node.className)).toEqual(['admin-select__value']);
    expect(h.control.contains(h.caption)).toBe(false);
    expect(h.control.closest('[aria-hidden]')).toBeNull();
    h.select.value = 'published';
    h.menu.sync();
    expect(h.control.textContent).toBe('Published');
  });

  it('renders one option per visible select option, with ids from the select id and a position', () => {
    const h = mount();
    expect(h.options().map((node) => [node.tagName, node.className, node.getAttribute('role'), node.id, node.textContent])).toEqual([
      ['LI', 'admin-select__option is-selected', 'option', 'fStatus-opt-0', 'All'],
      ['LI', 'admin-select__option', 'option', 'fStatus-opt-1', 'Draft'],
      ['LI', 'admin-select__option', 'option', 'fStatus-opt-2', 'Published'],
      ['LI', 'admin-select__option', 'option', 'fStatus-opt-3', 'Unpublished changes'],
    ]);
    expect(h.selected()).toEqual(['All']);
    expect(h.isSet()).toBe(false);
  });

  it('omits hidden options and marks disabled ones', () => {
    const h = mount(MIXED, 'fStop');
    expect(h.labels()).toEqual(['Arrival', 'Base camp', 'Col', 'Exit', 'Ferry', 'Gate']);
    expect(h.options().map((node) => node.getAttribute('aria-disabled'))).toEqual(['true', null, 'true', null, null, 'true']);
    expect(h.value.textContent).toBe('Base camp');
    expect(h.selected()).toEqual(['Base camp']);
  });

  it('writes option text as text, never as markup', () => {
    const text = '<img src=x onerror="alert(1)"> & "Peru"';
    const h = mount(field('fCountry', 'Country', [opt('', 'All')]), 'fCountry');
    const option = h.document.createElement('option');
    option.value = '"><script>alert(1)</script>';
    option.textContent = text;
    h.select.appendChild(option);
    h.select.value = option.value;
    h.menu.sync();
    expect(h.labels()).toEqual(['All', text]);
    expect(h.options().map((node) => node.id)).toEqual(['fCountry-opt-0', 'fCountry-opt-1']);
    expect(h.value.textContent).toBe(text);
    expect(h.wrapper.querySelectorAll('img, script')).toHaveLength(0);
  });

  it('takes its label from opts.label before the aria-label', () => {
    const { document, api } = page(SORT);
    const menu = api.enhance(document.getElementById('fSort') as HTMLSelectElement, { label: 'Sort by' });
    expect(document.getElementById(menu.trigger.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Sort by');
  });

  it.each<[string, string, { label: string } | undefined]>([
    ['has neither opts.label nor an aria-label', '<select id="plain"><option>One</option></select>', undefined],
    ['is given a blank label', '<select id="plain" aria-label="Plain"><option>One</option></select>', { label: '  ' }],
    ['has no id', '<select aria-label="Plain"><option>One</option></select>', undefined],
  ])('throws, and leaves the select alone, when it %s', (_case, markup, opts) => {
    const { document, api } = page(markup);
    const select = document.querySelector('select') as HTMLSelectElement;
    expect(() => api.enhance(select, opts)).toThrow(/AdminSelect\.enhance/);
    expect(select.hidden).toBe(false);
    expect(document.querySelector('.admin-select')).toBeNull();
  });

  it('keeps two menus apart: their own ids, and a press on one closes the other', () => {
    const { window, document, api } = page(STATUS + SORT);
    const status = api.enhance(document.getElementById('fStatus') as HTMLSelectElement);
    const sort = api.enhance(document.getElementById('fSort') as HTMLSelectElement);
    const ids = Array.from(document.querySelectorAll('[id]')).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sort.trigger.getAttribute('aria-controls')).toBe('fSort-listbox');

    status.trigger.click();
    expect(status.trigger.getAttribute('aria-expanded')).toBe('true');
    sort.trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    sort.trigger.click();
    expect(status.trigger.getAttribute('aria-expanded')).toBe('false');
    expect(sort.trigger.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('opening', () => {
  it.each<[string, string, IKeyboardEventInit]>([
    ['ArrowDown', 'ArrowDown', {}],
    ['ArrowUp', 'ArrowUp', {}],
    ['Enter', 'Enter', {}],
    ['Space', ' ', {}],
    ['Alt+ArrowDown', 'ArrowDown', { altKey: true }],
  ])('%s opens on the selected option without committing', (_name, name, init) => {
    const h = mount();
    h.select.value = 'published';
    h.menu.sync();
    const event = h.key(name, init);
    expect(h.isOpen()).toBe(true);
    expect(h.active()).toBe('Published');
    expect(h.control.getAttribute('aria-activedescendant')).toBe('fStatus-opt-2');
    expect(event.defaultPrevented).toBe(true);
    expect(h.select.value).toBe('published');
    expect(h.events).toEqual([]);
  });

  it('Home and End open on the first and last enabled option', () => {
    const h = mount(MIXED, 'fStop');
    h.select.value = 'e';
    h.menu.sync();
    expect(h.key('Home').defaultPrevented).toBe(true);
    expect(h.isOpen()).toBe(true);
    expect(h.active()).toBe('Base camp');
    h.menu.close();
    expect(h.key('End').defaultPrevented).toBe(true);
    expect(h.isOpen()).toBe(true);
    expect(h.active()).toBe('Ferry');
    expect(h.select.value).toBe('e');
  });

  it('starts on the first enabled option when the selected one cannot be active', () => {
    const hidden = mount(field('fStop', 'Stop', [opt('a', 'Arrival', 'hidden'), opt('b', 'Base camp'), opt('c', 'Col')]), 'fStop');
    hidden.select.value = 'a';
    hidden.menu.sync();
    expect(hidden.value.textContent).toBe('Arrival');
    hidden.key('ArrowDown');
    expect(hidden.active()).toBe('Base camp');

    const disabled = mount(field('fStop', 'Stop', [opt('a', 'Arrival'), opt('b', 'Base camp'), opt('c', 'Col', 'disabled')]), 'fStop');
    disabled.select.value = 'c';
    disabled.menu.sync();
    expect(disabled.selected()).toEqual(['Col']);
    disabled.key('ArrowDown');
    expect(disabled.active()).toBe('Arrival');
  });

  it('leaves Escape and Tab to the page while closed', () => {
    const h = mount();
    let heard = 0;
    h.document.addEventListener('keydown', () => { heard += 1; });
    for (const name of ['Escape', 'Tab']) {
      expect(h.key(name).defaultPrevented).toBe(false);
      expect(h.isOpen()).toBe(false);
    }
    expect(heard).toBe(2);
  });

  it.each(['control', 'caption', 'box'] as const)('toggles on a click on the %s and leaves focus on the control', (part) => {
    const h = mount();
    const target = { control: h.control, caption: h.caption, box: h.box }[part];
    h.select.value = 'published';
    h.menu.sync();
    h.next.focus();
    target.click();
    expect(h.isOpen()).toBe(true);
    expect(h.active()).toBe('Published');
    expect(h.focused()).toBe('fStatus-combo');
    target.click();
    expect(h.isOpen()).toBe(false);
    expect(h.focused()).toBe('fStatus-combo');
    expect(h.select.value).toBe('published');
    expect(h.events).toEqual([]);
  });
});

describe('moving the active option', () => {
  it('steps over disabled and hidden options with the arrows and stops at either end', () => {
    const h = mount(MIXED, 'fStop');
    h.key('ArrowDown');
    expect(h.active()).toBe('Base camp');
    const walked = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp'].map((name) => {
      expect(h.key(name).defaultPrevented).toBe(true);
      return h.active();
    });
    expect(walked).toEqual(['Exit', 'Ferry', 'Ferry', 'Exit', 'Base camp', 'Base camp']);
    expect(h.isOpen()).toBe(true);
    expect(h.select.value).toBe('b');
    expect(h.events).toEqual([]);
  });

  it('jumps to the first and last enabled option with Home and End', () => {
    const h = mount(MIXED, 'fStop');
    h.key('ArrowDown');
    h.key('End');
    expect(h.active()).toBe('Ferry');
    h.key('Home');
    expect(h.active()).toBe('Base camp');
  });

  it('moves ten enabled options with PageDown and PageUp, stopping at either end', () => {
    const h = mount(PAGED, 'fCountry');
    h.key('ArrowDown');
    expect(h.active()).toBe('All');
    const walked = ['PageDown', 'PageDown', 'PageDown', 'PageUp', 'PageUp', 'PageUp'].map((name) => {
      expect(h.key(name).defaultPrevented).toBe(true);
      return h.active();
    });
    // Country 03 is disabled and Country 07 is hidden: neither counts.
    expect(walked).toEqual(['Country 12', 'Country 22', 'Country 24', 'Country 14', 'Country 02', 'All']);
  });

  it('does not move on Alt+ArrowDown, which only opens', () => {
    const h = mount();
    h.key('ArrowDown', { altKey: true });
    h.key('ArrowDown', { altKey: true });
    expect(h.isOpen()).toBe(true);
    expect(h.active()).toBe('All');
  });
});

describe('keeping the active option in view', () => {
  it('moves the panel scrollTop — never scrollIntoView — as the keys move', () => {
    const h = mount(PAGED, 'fCountry');
    const scrollIntoView = vi.spyOn(h.window.Element.prototype, 'scrollIntoView');
    layOut(h.window, h.panel, 3);
    const row = () => h.options().findIndex((node) => node.classList.contains('is-active'));

    h.key('ArrowDown');
    h.key('ArrowDown');
    h.key('ArrowDown');
    expect([row(), h.panel.scrollTop]).toEqual([2, 0]);
    // Row 3 is the disabled Country 03.
    h.key('ArrowDown');
    expect([row(), h.panel.scrollTop]).toEqual([4, 60]);
    h.key('End');
    expect([row(), h.panel.scrollTop]).toEqual([23, 630]);
    h.key('ArrowUp');
    expect([row(), h.panel.scrollTop]).toEqual([22, 630]);
    h.key('Home');
    expect([row(), h.panel.scrollTop]).toEqual([0, 0]);
    for (const name of ['PageDown', 'PageDown', 'PageUp', 'End', 'PageUp', 'ArrowUp', 'Home']) {
      h.key(name);
      const top = row() * 30;
      expect(top >= h.panel.scrollTop && top + 30 <= h.panel.scrollTop + 90).toBe(true);
    }

    // Hovering a row at the edge must not move the list under the pointer.
    h.panel.scrollTop = 45;
    h.pointer('pointermove', h.option('Country 01'));
    expect([h.active(), h.panel.scrollTop]).toEqual(['Country 01', 45]);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls to the selected option on open, and to a type-ahead match', () => {
    const h = mount(PAGED, 'fCountry');
    layOut(h.window, h.panel, 3);
    h.select.value = 'Country 20';
    h.menu.sync();
    h.control.click();
    // Country 20 is row 19 (07 is hidden): its bottom edge comes to rest on the panel's.
    expect([h.active(), h.panel.scrollTop]).toEqual(['Country 20', 510]);
    for (const char of 'country 05') h.key(char);
    // Row 5, reached from above: again resting on the bottom edge.
    expect([h.active(), h.panel.scrollTop]).toEqual(['Country 05', 90]);
  });

  it('scrolls to the active option again when the list is rebuilt under it', async () => {
    const h = mount(COUNTRY, 'fCountry');
    layOut(h.window, h.panel, 3);
    h.key('End');
    expect([h.active(), h.panel.scrollTop]).toEqual(['Uruguay', 30]);
    // Twelve countries arrive ahead of it: Uruguay is now row 13.
    refill(h.select, [...Array.from({ length: 12 }, (_, at) => 'Country ' + (at + 1)), 'Uruguay']);
    await microtask();
    expect([h.active(), h.panel.scrollTop]).toEqual(['Uruguay', 330]);
  });
});

describe('committing', () => {
  it.each<[string, string, IKeyboardEventInit]>([
    ['Enter', 'Enter', {}],
    ['Space', ' ', {}],
    ['Alt+ArrowUp', 'ArrowUp', { altKey: true }],
  ])('%s picks the active option, fires input then change, closes and keeps focus on the control', (_name, name, init) => {
    const h = mount();
    h.control.focus();
    h.key('ArrowDown');
    h.key('ArrowDown');
    expect(h.active()).toBe('Draft');
    const event = h.key(name, init);
    expect(event.defaultPrevented).toBe(true);
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('draft');
    expect(h.events).toEqual(COMMITTED);
    expect(h.value.textContent).toBe('Draft');
    expect(h.isSet()).toBe(true);
    expect(h.selected()).toEqual(['Draft']);
    expect(h.focused()).toBe('fStatus-combo');
  });

  it.each<[string, IKeyboardEventInit]>([
    ['Tab', {}],
    ['Shift+Tab', { shiftKey: true }],
  ])('%s picks the active option and lets focus move on', (_name, init) => {
    const h = mount();
    h.control.focus();
    h.key('ArrowDown');
    h.key('ArrowDown');
    const event = h.key('Tab', init);
    expect(event.defaultPrevented).toBe(false);
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('draft');
    expect(h.events).toEqual(COMMITTED);
    // The browser's default then moves focus; the blur that follows changes nothing.
    h.next.focus();
    expect(h.select.value).toBe('draft');
    expect(h.events).toEqual(COMMITTED);
  });

  it('fires nothing when the current value is picked', () => {
    const h = mount();
    h.key('ArrowDown');
    h.key('Enter');
    expect(h.isOpen()).toBe(false);
    h.control.click();
    h.option('All').click();
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('');
    expect(h.events).toEqual([]);
  });

  it('changes nothing when the current option is picked, even if another option shares its value', () => {
    const h = mount(field('fStop', 'Stop', [opt('x', 'First'), opt('x', 'Second'), opt('y', 'Other')]), 'fStop');
    h.select.selectedIndex = 1;
    h.menu.sync();
    h.key('ArrowDown');
    expect(h.active()).toBe('Second');
    h.key('Enter');
    expect(h.value.textContent).toBe('Second');
    expect(h.selected()).toEqual(['Second']);
    expect(h.events).toEqual([]);
  });

  it('does not take the Space that opened the menu for type-ahead: the next Space picks', () => {
    const h = mount();
    h.key(' ');
    h.key('ArrowDown');
    h.key(' ');
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('draft');
    expect(h.events).toEqual(COMMITTED);
  });

  it('has already set the value, redrawn and closed when the page hears the events', () => {
    const h = mount();
    const heard: string[] = [];
    for (const type of ['input', 'change']) {
      h.select.addEventListener(type, () => heard.push([type, h.select.value, h.value.textContent, h.control.getAttribute('aria-expanded'), h.isSet()].join(' | ')));
    }
    h.key('End');
    h.key('Enter');
    expect(heard).toEqual([
      'input | unpublished | Unpublished changes | false | true',
      'change | unpublished | Unpublished changes | false | true',
    ]);
  });

  it('commits and closes on a click on an enabled option', () => {
    const h = mount();
    h.control.focus();
    h.control.click();
    h.option('Published').click();
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('published');
    expect(h.events).toEqual(COMMITTED);
    expect(h.value.textContent).toBe('Published');
    expect(h.selected()).toEqual(['Published']);
    expect(h.focused()).toBe('fStatus-combo');
  });

  it('ignores clicks on a disabled option and on the panel itself', () => {
    const h = mount(MIXED, 'fStop');
    h.control.click();
    h.option('Col').click();
    h.panel.click();
    expect(h.isOpen()).toBe(true);
    expect(h.active()).toBe('Base camp');
    expect(h.select.value).toBe('b');
    expect(h.events).toEqual([]);
  });

  it('moves the active option with the pointer, never onto a disabled one, so Enter picks what is hovered', () => {
    const h = mount(MIXED, 'fStop');
    h.key('ArrowDown');
    h.pointer('pointermove', h.option('Ferry'));
    expect(h.active()).toBe('Ferry');
    h.pointer('pointermove', h.option('Gate'));
    expect(h.active()).toBe('Ferry');
    h.key('ArrowUp');
    expect(h.active()).toBe('Exit');
    h.pointer('pointermove', h.option('Ferry'));
    h.key('Enter');
    expect(h.select.value).toBe('f');
    expect(h.events).toEqual(COMMITTED);
  });
});

describe('closing without a commit', () => {
  it('Escape closes, keeps focus on the control and is consumed', () => {
    const h = mount();
    let heard = 0;
    h.document.addEventListener('keydown', () => { heard += 1; });
    h.control.focus();
    h.key('ArrowDown');
    h.key('ArrowDown');
    expect(heard).toBe(2);
    const escape = h.key('Escape');
    expect(h.isOpen()).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    expect(heard).toBe(2);
    expect(h.focused()).toBe('fStatus-combo');
    expect(h.select.value).toBe('');
    expect(h.value.textContent).toBe('All');
    expect(h.events).toEqual([]);

    // Closed again, Escape belongs to the page (the bulk bar, a dialog).
    expect(h.key('Escape').defaultPrevented).toBe(false);
    expect(heard).toBe(3);
  });

  it('closes on a press outside the component, and only outside', () => {
    const h = mount();
    h.control.focus();
    h.key('ArrowDown');
    h.key('ArrowDown');
    h.pointer('pointerdown', h.control);
    h.pointer('pointerdown', h.option('Published'));
    expect(h.isOpen()).toBe(true);
    h.pointer('pointerdown', h.next);
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('');
    expect(h.events).toEqual([]);
  });

  it('closes on an outside press that another handler stops', () => {
    const h = mount();
    h.next.addEventListener('pointerdown', (event) => event.stopPropagation());
    h.control.click();
    h.pointer('pointerdown', h.next);
    expect(h.isOpen()).toBe(false);
  });

  it('listens on the document only while it is open', () => {
    const { document, api } = page(STATUS);
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const menu = api.enhance(document.getElementById('fStatus') as HTMLSelectElement);
    expect(add).not.toHaveBeenCalled();
    menu.trigger.click();
    expect(add.mock.calls.map(([type]) => type)).toEqual(['pointerdown']);
    expect(remove).not.toHaveBeenCalled();
    menu.close();
    expect(remove.mock.calls).toEqual(add.mock.calls);
    expect(remove.mock.calls[0]?.[1] === add.mock.calls[0]?.[1]).toBe(true);
  });

  it('keeps focus on the control while the pointer works on the caption or in the panel', () => {
    const h = mount();
    h.control.click();
    expect(h.pointer('pointerdown', h.option('Draft')).defaultPrevented).toBe(true);
    expect(h.pointer('pointerdown', h.panel).defaultPrevented).toBe(true);
    // A press on the caption would blur the control and close the panel before the click toggles it.
    expect(h.pointer('pointerdown', h.caption.firstElementChild as HTMLElement).defaultPrevented).toBe(true);
    expect(h.pointer('pointerdown', h.box).defaultPrevented).toBe(true);
    // A press on the control itself is the browser's to handle: it focuses it.
    expect(h.pointer('pointerdown', h.control).defaultPrevented).toBe(false);
    expect(h.pointer('pointerdown', h.value).defaultPrevented).toBe(false);
    expect(h.isOpen()).toBe(true);
    h.caption.click();
    expect(h.isOpen()).toBe(false);
  });

  it('closes when focus leaves the component', () => {
    const h = mount();
    h.control.focus();
    h.key('ArrowDown');
    h.key('ArrowDown');
    h.next.focus();
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('');
    expect(h.events).toEqual([]);
  });

  it('stays open when focus moves within the component', () => {
    const h = mount();
    h.control.focus();
    h.key('ArrowDown');
    h.control.dispatchEvent(new h.window.FocusEvent('blur', { relatedTarget: h.panel }));
    expect(h.isOpen()).toBe(true);
  });

  it('close() closes, and is harmless on a closed menu', () => {
    const h = mount();
    h.key('ArrowDown');
    h.key('ArrowDown');
    h.menu.close();
    expect(h.isOpen()).toBe(false);
    h.menu.close();
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('');
    expect(h.events).toEqual([]);
  });
});

describe('keys that are not for the menu', () => {
  it.each<[string, IKeyboardEventInit]>([
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['an IME composition in progress', { isComposing: true }],
  ])('ignores keys pressed with %s', (_name, init) => {
    const h = mount();
    for (const name of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End', 'd']) {
      expect(h.key(name, init).defaultPrevented).toBe(false);
      expect(h.isOpen()).toBe(false);
    }
    h.key('ArrowDown');
    h.key('ArrowDown');
    for (const name of ['ArrowDown', 'ArrowUp', 'PageDown', 'Home', 'End', 'p', ' ', 'Enter', 'Tab', 'Escape']) {
      expect(h.key(name, init).defaultPrevented).toBe(false);
      expect(h.isOpen()).toBe(true);
      expect(h.active()).toBe('Draft');
    }
    expect(h.select.value).toBe('');
    expect(h.events).toEqual([]);
  });

  it('ignores Alt with anything but the arrows', () => {
    const h = mount();
    for (const name of ['Enter', ' ', 'Home', 'End', 'd']) {
      expect(h.key(name, { altKey: true }).defaultPrevented).toBe(false);
      expect(h.isOpen()).toBe(false);
    }
    h.key('ArrowDown');
    h.key('ArrowDown');
    for (const name of ['PageDown', 'Home', 'End', 'p', ' ', 'Enter', 'Tab', 'Escape']) {
      expect(h.key(name, { altKey: true }).defaultPrevented).toBe(false);
      expect(h.isOpen()).toBe(true);
      expect(h.active()).toBe('Draft');
    }
    expect(h.events).toEqual([]);
  });
});

describe('type-ahead', () => {
  it('opens on a printable key and searches from the selected option', () => {
    const h = mount(TYPED, 'fCountry');
    const event = h.key('n');
    expect(event.defaultPrevented).toBe(true);
    expect(h.isOpen()).toBe(true);
    expect(h.active()).toBe('Namibia');
    h.menu.close();

    h.select.value = 'Norway';
    h.menu.sync();
    h.key('N', { shiftKey: true });
    expect(h.active()).toBe('North Macedonia');
    expect(h.select.value).toBe('Norway');
    expect(h.events).toEqual([]);
  });

  it('cycles through one initial when a letter is repeated, skipping disabled options and wrapping', () => {
    const h = mount(TYPED, 'fCountry');
    const walked = Array.from('nnnnnnn', (char) => {
      h.key(char);
      return h.active();
    });
    expect(walked).toEqual(['Namibia', 'Nepal', 'New Caledonia', 'New Zealand', 'Norway', 'North Macedonia', 'Namibia']);
  });

  it('stays on the current option while a longer prefix still matches it', () => {
    const h = mount(TYPED, 'fCountry');
    const walked = Array.from('NoRt', (char) => {
      h.key(char);
      return h.active();
    });
    expect(walked).toEqual(['Namibia', 'Norway', 'Norway', 'North Macedonia']);
  });

  it('leaves the active option alone when nothing matches', () => {
    const h = mount(TYPED, 'fCountry');
    h.key('ArrowDown');
    h.key('ArrowDown');
    expect(h.active()).toBe('Germany');
    expect(h.key('x').defaultPrevented).toBe(true);
    expect(h.active()).toBe('Germany');
    // The buffer is now "xn": still no match.
    h.key('n');
    expect(h.active()).toBe('Germany');
    expect(h.isOpen()).toBe(true);
  });

  it('forgets the buffer 500 ms after the last key', () => {
    const h = mount(TYPED, 'fCountry');
    fakeClock(h.window);
    h.key('n');
    vi.advanceTimersByTime(499);
    h.key('e');
    expect(h.active()).toBe('Nepal');
    // Each key restarts the wait: "new" is still one buffer 998 ms after its first letter.
    vi.advanceTimersByTime(499);
    h.key('w');
    expect(h.active()).toBe('New Caledonia');
    vi.advanceTimersByTime(500);
    h.key('o');
    expect(h.active()).toBe('Oman');
  });

  it('takes Space into a buffer in progress, and commits with it otherwise', () => {
    const h = mount(TYPED, 'fCountry');
    fakeClock(h.window);
    for (const char of 'new') h.key(char);
    expect(h.active()).toBe('New Caledonia');
    expect(h.key(' ').defaultPrevented).toBe(true);
    expect(h.isOpen()).toBe(true);
    expect(h.events).toEqual([]);
    h.key('z');
    expect(h.active()).toBe('New Zealand');

    vi.advanceTimersByTime(500);
    h.key(' ');
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('New Zealand');
    expect(h.events).toEqual(COMMITTED);
  });

  it('starts a fresh buffer after the menu closed', () => {
    const h = mount(TYPED, 'fCountry');
    h.key('n');
    h.key('Escape');
    // Not "no" → Norway: the "n" went with the closed menu.
    h.key('o');
    expect(h.active()).toBe('Oman');
  });
});

describe('AdminSelect.typeahead', () => {
  const labels = ['All', 'Namibia', 'Nauru', 'Nepal', 'Norway', 'North Macedonia', 'Oman'];
  const enabled = labels.map((label) => label !== 'Nauru');

  it.each<[string, number, string, number]>([
    ['a single character starts after the current option', 0, 'n', 1],
    ['a single character skips a disabled match', 1, 'n', 3],
    ['a single character wraps past the end', 5, 'n', 1],
    ['a single character can come back to the only match', 6, 'o', 6],
    ['a repeated character is that one character', 3, 'nnn', 4],
    ['a longer prefix starts at the current option', 1, 'no', 4],
    ['a longer prefix keeps the current option while it matches', 4, 'nor', 4],
    ['a longer prefix moves on when the current option stops matching', 4, 'nort', 5],
    ['a longer prefix wraps', 5, 'na', 1],
    ['matching ignores case', 4, 'NORT', 5],
    ['a prefix only a disabled option has matches nothing', 0, 'nau', -1],
    ['no match is -1', 0, 'x', -1],
    ['an empty buffer is -1', 0, '', -1],
    ['no current option searches from the top', -1, 'a', 0],
    ['no current option searches a longer prefix from the top', -1, 'al', 0],
    ['no current option still reaches the last one', -1, 'om', 6],
  ])('%s', (_case, start, query, expected) => {
    expect(page('').api.typeahead(labels, enabled, start, query)).toBe(expected);
  });

  it('finds nothing in an empty list', () => {
    expect(page('').api.typeahead([], [], 0, 'a')).toBe(-1);
  });
});

describe('following the select', () => {
  it('shows a value written by the page after sync(), without firing events', () => {
    const h = mount();
    h.select.value = 'published';
    h.menu.sync();
    expect(h.value.textContent).toBe('Published');
    expect(h.isSet()).toBe(true);
    expect(h.selected()).toEqual(['Published']);
    h.select.value = '';
    h.menu.sync();
    expect(h.value.textContent).toBe('All');
    expect(h.isSet()).toBe(false);
    expect(h.selected()).toEqual(['All']);
    expect(h.events).toEqual([]);
  });

  it('is "set" whenever the value differs from the first option, whatever that value is', () => {
    const h = mount(SORT, 'fSort');
    expect([h.value.textContent, h.isSet()]).toEqual(['Updated', false]);
    h.select.value = 'title';
    h.menu.sync();
    expect([h.value.textContent, h.isSet()]).toEqual(['Title', true]);
    h.key('Home');
    h.key('Enter');
    expect([h.value.textContent, h.isSet()]).toEqual(['Updated', false]);
  });

  it('shows nothing for a value no option has', () => {
    const h = mount();
    h.select.value = 'no-such-status';
    h.menu.sync();
    expect(h.value.textContent).toBe('');
    expect(h.selected()).toEqual([]);
    // Picking the first option from there selects it; the value was and stays '', so nothing fires.
    h.key('ArrowDown');
    expect(h.active()).toBe('All');
    h.key('Enter');
    expect(h.value.textContent).toBe('All');
    expect(h.selected()).toEqual(['All']);
    expect(h.events).toEqual([]);
  });

  it('redraws by itself, a microtask later, when the options are replaced', async () => {
    const h = mount(COUNTRY, 'fCountry');
    h.select.value = 'Peru';
    h.menu.sync();
    const changes = watch(h.window, h.panel);
    refill(h.select, ['Bolivia', 'Peru', 'Suriname']);
    await microtask();
    expect(h.labels()).toEqual(['All', 'Bolivia', 'Peru', 'Suriname']);
    expect(h.options().map((node) => node.id)).toEqual(['fCountry-opt-0', 'fCountry-opt-1', 'fCountry-opt-2', 'fCountry-opt-3']);
    expect(h.value.textContent).toBe('Peru');
    expect(h.selected()).toEqual(['Peru']);
    expect(changes().length).toBeGreaterThan(0);

    // A choice that is gone falls back to the page's "All".
    refill(h.select, ['Bolivia']);
    await microtask();
    expect(h.labels()).toEqual(['All', 'Bolivia']);
    expect(h.value.textContent).toBe('All');
    expect(h.isSet()).toBe(false);
    expect(h.events).toEqual([]);
  });

  it('redraws at once on sync(), before the observer has run', () => {
    const h = mount(COUNTRY, 'fCountry');
    refill(h.select, ['Bolivia']);
    h.menu.sync();
    expect(h.labels()).toEqual(['All', 'Bolivia']);
  });

  it('leaves the DOM untouched when the options are replaced by identical ones', async () => {
    const h = mount(COUNTRY, 'fCountry');
    h.select.value = 'Peru';
    h.menu.sync();
    const before = h.options();
    const changes = watch(h.window, h.wrapper);
    refill(h.select, ['Chile', 'Peru', 'Uruguay']);
    await microtask();
    h.menu.sync();
    await microtask();
    expect(changes()).toEqual([]);
    expect(h.options()).toHaveLength(before.length);
    expect(h.options().every((node, at) => node === before[at])).toBe(true);
    expect(h.value.textContent).toBe('Peru');
  });

  it('draws each option once for a burst of changes', async () => {
    const h = mount(COUNTRY, 'fCountry');
    const changes = watch(h.window, h.panel);
    refill(h.select, ['Bolivia', 'Peru', 'Suriname']);
    h.select.options[1]!.textContent = 'Bolivia (Plurinational State of)';
    await microtask();
    expect(h.labels()).toEqual(['All', 'Bolivia (Plurinational State of)', 'Peru', 'Suriname']);
    expect(changes().reduce((sum, change) => sum + change.added, 0)).toBe(4);
  });

  it('follows an option that is shown, renamed, relabelled, disabled or hidden', async () => {
    const h = mount();
    const missing = h.document.getElementById('missing') as HTMLOptionElement;
    missing.hidden = false;
    missing.disabled = false;
    await microtask();
    expect(h.labels()).toEqual(['All', 'Draft', 'Published', 'Unpublished changes', 'Missing translation']);
    expect(h.option('Missing translation').hasAttribute('aria-disabled')).toBe(false);

    missing.textContent = 'No English text';
    await microtask();
    expect(h.labels()[4]).toBe('No English text');

    const text = missing.firstChild as Text;
    text.data = 'English text is empty';
    await microtask();
    expect(h.labels()[4]).toBe('English text is empty');

    missing.setAttribute('label', 'Missing EN');
    await microtask();
    expect(h.labels()[4]).toBe('Missing EN');

    missing.disabled = true;
    await microtask();
    expect(h.option('Missing EN').getAttribute('aria-disabled')).toBe('true');

    missing.value = 'missing-en';
    h.select.value = 'missing-en';
    await microtask();
    expect(h.value.textContent).toBe('Missing EN');
    expect(h.selected()).toEqual(['Missing EN']);

    missing.hidden = true;
    await microtask();
    expect(h.labels()).toEqual(['All', 'Draft', 'Published', 'Unpublished changes']);
    expect(h.events).toEqual([]);
  });

  it('follows a selected attribute put on an option', async () => {
    const h = mount();
    h.document.querySelector('option[value="draft"]')!.setAttribute('selected', '');
    await microtask();
    expect(h.value.textContent).toBe('Draft');
    expect(h.selected()).toEqual(['Draft']);
    expect(h.isSet()).toBe(true);
    expect(h.events).toEqual([]);
  });

  it('keeps an open list on its active option by value, else on the selected one', async () => {
    const h = mount(COUNTRY, 'fCountry');
    h.select.value = 'Peru';
    h.menu.sync();
    h.key('End');
    expect(h.active()).toBe('Uruguay');
    expect(h.control.getAttribute('aria-activedescendant')).toBe('fCountry-opt-3');

    refill(h.select, ['Peru', 'Uruguay']);
    await microtask();
    expect(h.isOpen()).toBe(true);
    expect(h.active()).toBe('Uruguay');
    expect(h.control.getAttribute('aria-activedescendant')).toBe('fCountry-opt-2');

    refill(h.select, ['Argentina', 'Peru']);
    await microtask();
    expect(h.isOpen()).toBe(true);
    expect(h.active()).toBe('Peru');
    h.key('ArrowUp');
    expect(h.active()).toBe('Argentina');
  });

  it('closes an open list that has no enabled option left', async () => {
    const h = mount(COUNTRY, 'fCountry');
    h.key('ArrowDown');
    for (const option of Array.from(h.select.options)) option.disabled = true;
    await microtask();
    expect(h.isOpen()).toBe(false);
    expect(h.options().map((node) => node.getAttribute('aria-disabled'))).toEqual(['true', 'true', 'true', 'true']);
  });
});

describe('disabled and empty selects', () => {
  it('marks a disabled select and never opens it', () => {
    const h = mount(field('fOrder', 'Order', [opt('desc', 'Descending'), opt('asc', 'Ascending')], 'disabled'), 'fOrder');
    expect(h.control.getAttribute('aria-disabled')).toBe('true');
    expect(h.value.textContent).toBe('Descending');
    for (const name of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End', 'a']) {
      expect(h.key(name).defaultPrevented).toBe(false);
      expect(h.isOpen()).toBe(false);
    }
    h.next.focus();
    h.control.click();
    h.caption.click();
    expect(h.isOpen()).toBe(false);
    expect(h.focused()).toBe('next');
    expect(h.events).toEqual([]);
  });

  it('follows the select being disabled and enabled again', async () => {
    const h = mount();
    h.key('ArrowDown');
    h.key('ArrowDown');
    h.select.disabled = true;
    await microtask();
    expect(h.isOpen()).toBe(false);
    expect(h.control.getAttribute('aria-disabled')).toBe('true');
    h.key('ArrowDown');
    expect(h.isOpen()).toBe(false);
    expect(h.select.value).toBe('');

    h.select.disabled = false;
    await microtask();
    expect(h.control.hasAttribute('aria-disabled')).toBe(false);
    h.key('ArrowDown');
    expect(h.isOpen()).toBe(true);
    expect(h.events).toEqual([]);
  });

  it.each<[string, string[]]>([
    ['no options', []],
    ['only disabled options', [opt('a', 'Arrival', 'disabled'), opt('b', 'Base camp', 'disabled')]],
  ])('renders an empty value for a select with %s, and opening is a no-op', (_case, options) => {
    const h = mount(field('fStop', 'Stop', options), 'fStop');
    expect(h.value.textContent).toBe('');
    expect(h.options()).toHaveLength(options.length);
    for (const name of ['ArrowDown', 'Enter', ' ', 'Home', 'a']) {
      h.key(name);
      expect(h.isOpen()).toBe(false);
    }
    h.control.click();
    expect(h.isOpen()).toBe(false);
    expect(h.events).toEqual([]);
  });
});

describe('AdminSelect.place', () => {
  const view = { top: 0, left: 0, bottom: 800, right: 1200 };
  const short = { top: 0, left: 0, bottom: 256, right: 320 };
  const at = (top: number, left = 20, width = 160) => ({ top, bottom: top + 36, left, right: left + width });

  it('opens below, start-aligned and capped at 20rem, when the panel fits there', () => {
    const { place } = page('').api;
    expect(place({ trigger: at(100), boundary: view, panelHeight: 500, panelWidth: 150 })).toEqual({
      above: false, maxHeight: 320, alignEnd: false, minWidth: 160, maxWidth: 352,
    });
    // Only 20rem of a taller panel has to fit. Below: 800 − 436 − 12 = 352; above (388) is larger, and beside the point.
    expect(place({ trigger: at(400), boundary: view, panelHeight: 500, panelWidth: 150 })).toMatchObject({ above: false, maxHeight: 320 });
  });

  it('flips above when it does not fit below and there is more room above', () => {
    const { place } = page('').api;
    // Below: 800 − 736 − 4 − 8 = 52. Above: 700 − 4 − 8 = 688.
    expect(place({ trigger: at(700), boundary: view, panelHeight: 200, panelWidth: 150 })).toMatchObject({ above: true, maxHeight: 320 });
    // A short panel that still fits below stays there.
    expect(place({ trigger: at(700), boundary: view, panelHeight: 52, panelWidth: 150 })).toMatchObject({ above: false, maxHeight: 52 });
    // Below: 800 − 436 − 12 = 352, above: 388. Exactly what is wanted fits; one pixel more does not.
    expect(place({ trigger: at(400), boundary: view, panelHeight: 352, panelWidth: 150, cap: 400 }).above).toBe(false);
    expect(place({ trigger: at(400), boundary: view, panelHeight: 353, panelWidth: 150, cap: 400 }).above).toBe(true);
  });

  it('clamps to the chosen side when neither fits: above only when that side is larger', () => {
    const { place } = page('').api;
    // Below: 256 − 186 − 12 = 58. Above: 150 − 12 = 138.
    expect(place({ trigger: at(150), boundary: short, panelHeight: 300, panelWidth: 150 })).toMatchObject({ above: true, maxHeight: 138 });
    // Below: 256 − 96 − 12 = 148. Above: 60 − 12 = 48.
    expect(place({ trigger: at(60), boundary: short, panelHeight: 300, panelWidth: 150 })).toMatchObject({ above: false, maxHeight: 148 });
    // Equal room on both sides (98): below.
    expect(place({ trigger: at(110), boundary: short, panelHeight: 300, panelWidth: 150 })).toMatchObject({ above: false, maxHeight: 98 });
  });

  it('measures from the boundary, not the viewport', () => {
    const { place } = page('').api;
    // A scroller from 200 to 500: below 500 − 456 − 12 = 32, above 420 − 200 − 12 = 208.
    const scroller = { top: 200, left: 0, bottom: 500, right: 1200 };
    expect(place({ trigger: at(420), boundary: scroller, panelHeight: 300, panelWidth: 150 })).toMatchObject({ above: true, maxHeight: 208 });
  });

  it('never clamps below the minimum height, nor below zero', () => {
    const { place } = page('').api;
    const tiny = { top: 0, left: 0, bottom: 120, right: 320 };
    // Below: 120 − 76 − 12 = 32. Above: 40 − 12 = 28.
    expect(place({ trigger: at(40), boundary: tiny, panelHeight: 300, panelWidth: 150, minHeight: 64 })).toMatchObject({ above: false, maxHeight: 64 });
    expect(place({ trigger: at(40), boundary: tiny, panelHeight: 300, panelWidth: 150 })).toMatchObject({ above: false, maxHeight: 32 });
    // Below: 40 − 36 − 12 = −8. Above: −12.
    expect(place({ trigger: at(0), boundary: { ...tiny, bottom: 40 }, panelHeight: 300, panelWidth: 150 })).toMatchObject({ above: false, maxHeight: 0 });
  });

  it('takes the cap, the gap and the margin from its input', () => {
    const { place } = page('').api;
    expect(place({ trigger: at(100), boundary: view, panelHeight: 500, panelWidth: 150, cap: 400 }).maxHeight).toBe(400);
    // Below: 256 − 96 − 10 − 20 = 130. Width: 320 − 2 × 20 = 280.
    expect(place({ trigger: at(60), boundary: short, panelHeight: 300, panelWidth: 150, gap: 10, margin: 20 }))
      .toMatchObject({ above: false, maxHeight: 130, maxWidth: 280 });
  });

  it('is at least as wide as the trigger and at most min(22rem, boundary − 16px)', () => {
    const { place } = page('').api;
    expect(place({ trigger: at(100, 20, 160), boundary: view, panelHeight: 100, panelWidth: 500 })).toMatchObject({ minWidth: 160, maxWidth: 352 });
    expect(place({ trigger: at(100, 16, 288), boundary: short, panelHeight: 100, panelWidth: 500 }))
      .toMatchObject({ minWidth: 288, maxWidth: 304, alignEnd: false });
    expect(place({ trigger: at(100, 20, 160), boundary: view, panelHeight: 100, panelWidth: 500, widthCap: 440 }).maxWidth).toBe(440);
    // A trigger wider than the cap wins: the panel is never narrower than it …
    expect(place({ trigger: at(100, 20, 500), boundary: view, panelHeight: 100, panelWidth: 100 })).toMatchObject({ minWidth: 500, maxWidth: 500 });
    // … unless that is wider than the boundary less its margins.
    expect(place({ trigger: at(100, 5, 310), boundary: short, panelHeight: 100, panelWidth: 100 })).toMatchObject({ minWidth: 304, maxWidth: 304 });
  });

  it('aligns to the end edge when the start edge would cross the boundary on the right', () => {
    const { place } = page('').api;
    const narrow = { top: 0, left: 0, bottom: 800, right: 900 };
    // 700 + 300 = 1000 crosses 900; from the end edge the panel spans 560 … 860.
    expect(place({ trigger: at(100, 700, 160), boundary: narrow, panelHeight: 100, panelWidth: 300 }).alignEnd).toBe(true);
    // Touching the edge is not crossing it.
    expect(place({ trigger: at(100, 600, 160), boundary: narrow, panelHeight: 100, panelWidth: 300 }).alignEnd).toBe(false);
    // The width that decides is the one the panel will have: a 500px panel is cut to 352.
    expect(place({ trigger: at(100, 548, 160), boundary: narrow, panelHeight: 100, panelWidth: 500 }).alignEnd).toBe(false);
    expect(place({ trigger: at(100, 549, 160), boundary: narrow, panelHeight: 100, panelWidth: 500 }).alignEnd).toBe(true);
    // A narrow panel is widened to the trigger, and that is what must fit.
    expect(place({ trigger: at(100, 760, 160), boundary: narrow, panelHeight: 100, panelWidth: 80 }).alignEnd).toBe(true);
  });

  it('stays start-aligned when the end edge would cross the boundary by as much or more', () => {
    const { place } = page('').api;
    const phone = { top: 0, left: 0, bottom: 800, right: 390 };
    // Start: 100 + 352 − 390 = 62 past the right. End: 290 − 352 = 62 past the left.
    expect(place({ trigger: at(100, 100, 190), boundary: phone, panelHeight: 100, panelWidth: 352 }).alignEnd).toBe(false);
    // Start: 112 past the right. End: 12 past the left.
    expect(place({ trigger: at(100, 150, 190), boundary: phone, panelHeight: 100, panelWidth: 352 }).alignEnd).toBe(true);
  });
});

describe('placing the panel on open', () => {
  // The panel is placed against the visible box, caption included — not against the control inside it.
  function measured(parts: Parts, box: Rect, panel: { scrollHeight: number; offsetWidth: number }, row: number) {
    stub(parts.box, { getBoundingClientRect: () => box });
    stub(parts.panel, panel);
    for (const node of parts.options()) stub(node, { offsetHeight: row });
  }
  const placed = (parts: Parts) => ({
    above: parts.wrapper.classList.contains('is-above'),
    end: parts.wrapper.classList.contains('is-end'),
    maxHeight: parts.panel.style.maxHeight,
    minWidth: parts.panel.style.minWidth,
    maxWidth: parts.panel.style.maxWidth,
  });

  it('flips and clamps inside a 320 × 256 viewport, and measures again on the next open', () => {
    const h = mount(STATUS, 'fStatus', { width: 320, height: 256 });
    // Below: 256 − 226 − 12 = 18. Above: 190 − 12 = 178.
    measured(h, rect(190, 16, 288, 36), { scrollHeight: 300, offsetWidth: 288 }, 32);
    h.control.click();
    expect(placed(h)).toEqual({ above: true, end: false, maxHeight: '178px', minWidth: '288px', maxWidth: '304px' });

    h.menu.close();
    expect(placed(h)).toEqual({ above: false, end: false, maxHeight: '', minWidth: '', maxWidth: '' });

    // Scrolled so the box is near the top. Below: 256 − 56 − 12 = 188.
    measured(h, rect(20, 16, 288, 36), { scrollHeight: 300, offsetWidth: 288 }, 32);
    h.key('ArrowDown');
    expect(placed(h)).toEqual({ above: false, end: false, maxHeight: '188px', minWidth: '288px', maxWidth: '304px' });
  });

  it('keeps room for two options however little space there is', () => {
    const h = mount(STATUS, 'fStatus', { width: 320, height: 150 });
    // Below: 150 − 86 − 12 = 52. Above: 50 − 12 = 38. Two 32px options need 64.
    measured(h, rect(50, 16, 288, 36), { scrollHeight: 300, offsetWidth: 288 }, 32);
    h.control.click();
    expect(placed(h)).toMatchObject({ above: false, maxHeight: '64px' });
  });

  it.each(['overflow-y: auto', 'overflow-x: hidden'])('stays inside the nearest ancestor that clips (%s), not just the viewport', (overflow) => {
    const h = mount(`<div id="workspace" style="${overflow}"><div class="card">${STATUS}</div></div>`);
    // The workspace's padding box, inside a 2px border and a 15px scrollbar, is 208 … 993 across and 60 … 460 down,
    // in a 1024 × 768 viewport.
    stub(h.document.getElementById('workspace') as HTMLElement, {
      getBoundingClientRect: () => rect(58, 206, 804, 404), clientTop: 2, clientLeft: 2, clientWidth: 785, clientHeight: 400,
    });
    // Below: 460 − 336 − 12 = 112 (the viewport alone would leave 420). Above: 300 − 60 − 12 = 228.
    // Start-aligned the 240px panel would end at 1000: inside the viewport, past the workspace's 993.
    measured(h, rect(300, 760, 160, 36), { scrollHeight: 300, offsetWidth: 240 }, 30);
    h.control.click();
    expect(placed(h)).toEqual({ above: true, end: true, maxHeight: '228px', minWidth: '160px', maxWidth: '352px' });
  });

  it('scales the 20rem and 22rem caps with the root font size', () => {
    const h = mount();
    h.document.documentElement.style.fontSize = '20px';
    // Plenty of room below for a panel that is taller and wider than both caps.
    measured(h, rect(20, 16, 160, 36), { scrollHeight: 900, offsetWidth: 600 }, 30);
    h.control.click();
    expect(placed(h)).toMatchObject({ above: false, maxHeight: '400px', maxWidth: '440px' });
  });
});
