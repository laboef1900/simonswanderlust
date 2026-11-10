import type { EditorElement } from './editor-dom-harness.js';

export type Position = { line: number; ch: number };
export type MarkdownEditorSettings = { element: EditorElement; toolbar?: unknown; autosave?: { enabled?: boolean } };
type Host = { document: { createElement(tag: string): EditorElement }; editors?: MarkdownEditor[] };

/**
 * The page editor's EasyMDE/CodeMirror, reduced to what its scripts touch: one
 * text, a caret, change and cursor listeners and the few navigation calls. The
 * production rich bridge runs against it unchanged; with no RichTextEditor in
 * the harness it settles into the Markdown view, which is what these tests
 * exercise.
 */
export class MarkdownEditor {
  text = '';
  cursor = 0;
  selection: Position | null = null;
  /** Document-level undo entries; the bridge's whole-form fills clear history and never add any. */
  readonly undo: string[] = [];
  readonly input: EditorElement;
  readonly settings: MarkdownEditorSettings;
  private readonly changes: (() => void)[] = [];
  private readonly cursorChanges: (() => void)[] = [];
  readonly codemirror = {
    getInputField: () => this.input,
    on: (event: string, callback: () => void) => { (event === 'cursorActivity' ? this.cursorChanges : this.changes).push(callback); },
    off: (event: string, callback: () => void) => {
      const list = event === 'cursorActivity' ? this.cursorChanges : this.changes;
      const index = list.indexOf(callback);
      if (index !== -1) list.splice(index, 1);
    },
    setOption() {},
    refresh() {},
    clearHistory() {},
    scrollIntoView() {},
    focus: () => this.input.focus(),
    getValue: () => this.text,
    getLine: (line: number) => this.text.split('\n')[line] ?? '',
    posFromIndex: (index: number): Position => {
      const lines = this.text.slice(0, index).split('\n');
      return { line: lines.length - 1, ch: lines.at(-1)!.length };
    },
    indexFromPos: (position: Position): number =>
      this.text.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.ch,
    listSelections: () => { const at = this.codemirror.posFromIndex(this.cursor); return [{ anchor: at, head: at }]; },
    setCursor: (position: Position) => {
      this.cursor = this.codemirror.indexFromPos(position);
      this.selection = position;
      for (const callback of this.cursorChanges) callback();
    },
    setSelection: (from: Position) => {
      this.cursor = this.codemirror.indexFromPos(from);
      this.selection = from;
      for (const callback of this.cursorChanges) callback();
    },
    replaceSelection: (value: string) => {
      this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor);
      this.cursor += value.length;
      for (const callback of this.changes) callback();
    },
  };
  constructor(settings: MarkdownEditorSettings, host: Host) {
    this.settings = settings;
    this.input = host.document.createElement('textarea');
    settings.element.parentElement!.appendChild(this.input);
    host.editors?.push(this);
  }
  value(value?: string) {
    if (value !== undefined) {
      this.text = value;
      this.cursor = Math.min(this.cursor, value.length);
      for (const callback of this.changes) callback();
    }
    return this.text;
  }
}

/** The `EasyMDE` constructor a page harness installs: `new EasyMDE({ element })`, bound to its document; instances land in `editors` (DE, then EN). */
export function markdownEditorDouble(host: Host): new (settings: MarkdownEditorSettings) => MarkdownEditor {
  return class extends MarkdownEditor {
    constructor(settings: MarkdownEditorSettings) { super(settings, host); }
  };
}
