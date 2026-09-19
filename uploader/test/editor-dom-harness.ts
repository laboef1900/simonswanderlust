// The editor integration tests need tree/event/focus semantics, not a browser
// renderer. Parse the actual static markup; keep dialog close events queued so
// a jump can reveal an accidental late focus restoration. Browser verification
// remains responsible for native layout, inertness, and assistive technology.
export class EditorEvent {
  target: EditorElement | null = null;
  currentTarget: EditorElement | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;

  constructor(readonly type: string, options: { bubbles?: boolean; cancelable?: boolean; key?: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) {
    this.bubbles = options.bubbles ?? false;
    this.cancelable = options.cancelable ?? false;
    this.key = options.key ?? '';
    this.shiftKey = options.shiftKey ?? false;
    this.ctrlKey = options.ctrlKey ?? false;
    this.metaKey = options.metaKey ?? false;
  }

  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

interface DomState {
  activeElement: EditorElement | null;
  closeEvents: (() => void)[];
}

const dataKey = (name: string) => name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const decode = (text: string) => text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, value: string) => {
  if (value.startsWith('#x')) return String.fromCodePoint(parseInt(value.slice(2), 16));
  if (value.startsWith('#')) return String.fromCodePoint(parseInt(value.slice(1), 10));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' } as Record<string, string>)[value] ?? value;
});
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class EditorElement {
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly childNodes: EditorElement[] = [];
  parentElement: EditorElement | null = null;
  private readonly listeners = new Map<string, ((event: EditorEvent) => void)[]>();
  private ownText = '';
  private inputValue = '';
  private previousFocus: EditorElement | null = null;
  checked = false;

  constructor(readonly tagName: string, private readonly state: DomState) {}

  get children() { return this.childNodes.filter((child) => child.tagName !== '#TEXT'); }
  get firstChild(): EditorElement | null { return this.childNodes[0] ?? null; }
  get parentNode() { return this.parentElement; }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value: string) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value: string) { this.setAttribute('class', value); }
  get value() { return this.inputValue; }
  set value(value: unknown) { this.inputValue = String(value); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value: boolean) { this.toggleAttribute('hidden', value); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value: boolean) { this.toggleAttribute('disabled', value); }
  get open() { return this.hasAttribute('open'); }
  set open(value: boolean) { this.toggleAttribute('open', value); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? (/^(BUTTON|INPUT|TEXTAREA|SELECT|A)$/.test(this.tagName) ? 0 : -1)); }
  set tabIndex(value: number) { this.setAttribute('tabindex', String(value)); }
  get href() { return this.getAttribute('href') ?? ''; }
  set href(value: string) { this.setAttribute('href', value); }
  get type() { return this.getAttribute('type') ?? ''; }
  set type(value: string) { this.setAttribute('type', value); }
  get title() { return this.getAttribute('title') ?? ''; }
  set title(value: string) { this.setAttribute('title', value); }
  get textContent(): string { return this.ownText + this.childNodes.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.ownText = String(value); }
  get innerHTML(): string { return escape(this.ownText) + this.childNodes.map((child) => child.outerHTML).join(''); }
  set innerHTML(value: string) { this.replaceChildren(); parseMarkup(String(value), this, this.state); }
  get outerHTML(): string {
    if (this.tagName === '#TEXT') return escape(this.textContent);
    const attrs = Object.entries(this.attrs).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  readonly classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(' '); },
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classList.contains(name);
      if (on) this.classList.add(name); else this.classList.remove(name);
      return on;
    },
  };

  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
    if (name === 'value') this.value = value;
  }
  getAttribute(name: string): string | null {
    return name.startsWith('data-') ? this.dataset[dataKey(name)] ?? null : this.attrs[name] ?? null;
  }
  hasAttribute(name: string) { return this.getAttribute(name) !== null; }
  removeAttribute(name: string) { delete this.attrs[name]; if (name.startsWith('data-')) delete this.dataset[dataKey(name)]; }
  toggleAttribute(name: string, on: boolean) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); }

  appendChild(child: EditorElement) { child.remove(); child.parentElement = this; this.childNodes.push(child); return child; }
  append(...children: (EditorElement | string)[]) {
    for (const child of children) {
      if (typeof child !== 'string') this.appendChild(child);
      else { const text = new EditorElement('#TEXT', this.state); text.textContent = child; this.appendChild(text); }
    }
  }
  replaceChildren(...children: EditorElement[]) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes.length = 0;
    this.ownText = '';
    for (const child of children) this.appendChild(child);
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(target: EditorElement | null): boolean { return target === this || this.childNodes.some((child) => child.contains(target)); }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      let rest = part.trim();
      const negatives = [...rest.matchAll(/:not\(([^)]+)\)/g)];
      if (negatives.some((match) => this.matches(match[1]!))) return false;
      rest = rest.replace(/:not\([^)]+\)/g, '');
      if (rest.includes(':disabled')) { if (!this.disabled) return false; rest = rest.replace(':disabled', ''); }
      const attributes = [...rest.matchAll(/\[([^\]=\s]+)(?:\s*=\s*["']?([^\]"']*)["']?)?\]/g)];
      if (attributes.some((match) => match[2] === undefined ? !this.hasAttribute(match[1]!) : this.getAttribute(match[1]!) !== match[2])) return false;
      rest = rest.replace(/\[[^\]]+\]/g, '');
      const id = rest.match(/#([\w-]+)/)?.[1];
      if (id && this.id !== id) return false;
      const classes = [...rest.matchAll(/\.([\w-]+)/g)].map((match) => match[1]!);
      if (classes.some((name) => !this.classList.contains(name))) return false;
      rest = rest.replace(/[#.][\w-]+/g, '');
      return rest === '' || rest === '*' || rest.toUpperCase() === this.tagName;
    });
  }
  closest(selector: string): EditorElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector: string): EditorElement[] {
    const found: EditorElement[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  getClientRects() { return this.closest('[hidden]') ? [] : [{}]; }
  get offsetParent(): EditorElement | null { return this.closest('[hidden]') ? null : this.parentElement; }
  focus() { if (!this.disabled && !this.closest('[hidden]')) this.state.activeElement = this; }
  addEventListener(type: string, callback: (event: EditorEvent) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], callback]);
  }
  removeEventListener(type: string, callback: (event: EditorEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((listener) => listener !== callback));
  }
  dispatchEvent(event: EditorEvent) {
    event.target ??= this;
    event.currentTarget = this;
    for (const callback of this.listeners.get(event.type) ?? []) callback(event);
    if (event.bubbles && !event.propagationStopped) this.parentElement?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  fire(type: string, options: { key?: string; shiftKey?: boolean } = {}) {
    const event = new EditorEvent(type, { bubbles: true, cancelable: true, ...options });
    this.dispatchEvent(event);
    if (type === 'keydown' && event.key === 'Escape' && !event.defaultPrevented) {
      const dialog = this.closest('dialog');
      if (dialog?.open && dialog.dispatchEvent(new EditorEvent('cancel', { cancelable: true }))) dialog.close();
    }
    return event;
  }
  click() { if (!this.disabled) this.fire('click'); }
  showModal() {
    this.previousFocus = this.state.activeElement;
    this.open = true;
    (this.querySelector('[autofocus]') ?? this.querySelector('button, input, a[href]') ?? this).focus();
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.previousFocus?.focus();
    this.state.closeEvents.push(() => this.dispatchEvent(new EditorEvent('close')));
  }
}

function parseMarkup(markup: string, root: EditorElement, state: DomState) {
  const stack = [root];
  const clean = markup.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  for (const token of clean.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const tag = token.slice(2, -1).trim().toUpperCase();
      const index = stack.findLastIndex((element) => element.tagName === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const parent = stack.at(-1)!;
    if (!token.startsWith('<')) {
      const text = new EditorElement('#TEXT', state);
      text.textContent = decode(token);
      parent.appendChild(text);
      continue;
    }
    const tag = token.match(/^<([\w-]+)/)?.[1];
    if (!tag) continue;
    const element = new EditorElement(tag.toUpperCase(), state);
    const attributes = token.slice(tag.length + 1).replace(/\/?\s*>$/, '');
    for (const attr of attributes.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      element.setAttribute(attr[1]!, decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
    }
    parent.appendChild(element);
    if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag) && !token.endsWith('/>')) stack.push(element);
  }
}

export function editorDocument(markup: string) {
  const state: DomState = { activeElement: null, closeEvents: [] };
  const root = new EditorElement('#DOCUMENT', state);
  parseMarkup(markup, root, state);
  const created: EditorElement[] = [];
  return {
    document: {
      get activeElement() { return state.activeElement; },
      get body() { return root.querySelector('body'); },
      getElementById: (id: string) => root.querySelector('#' + id),
      querySelector: (selector: string) => root.querySelector(selector),
      querySelectorAll: (selector: string) => root.querySelectorAll(selector),
      addEventListener: root.addEventListener.bind(root),
      createElement: (tag: string) => { const element = new EditorElement(tag.toUpperCase(), state); created.push(element); return element; },
      createTextNode: (text: string) => { const element = new EditorElement('#TEXT', state); element.textContent = text; return element; },
    },
    created,
    flushDialogEvents() { for (const event of state.closeEvents.splice(0)) event(); },
  };
}
