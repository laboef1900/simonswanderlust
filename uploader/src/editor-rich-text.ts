import { Editor, Extension, Node as TiptapNode, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import CodeBlock from '@tiptap/extension-code-block';
import Link from '@tiptap/extension-link';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from '@tiptap/markdown';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { Marked, type marked } from 'marked';
import { decodeHTMLStrict } from 'entities';
import { parsePhotoLine } from '../public/gallery-photo-line.js';
import { editorPosition, RichSource, safeImageUrl, safeLink, sourcePosition } from './editor-rich-source.js';

export interface RichEditorCopy {
  bodyLabel: string;
  sourceLabel: string;
  sourceHelp: string;
  galleryLabel: string;
  editGallery: string;
  imageUnavailable: string;
  linkPrompt: string;
  linkInvalid: string;
  galleryChecking: string;
  galleryLookupFailed: string;
  galleryRetry: string;
}
export interface EditorImageMetadata {
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
  format?: 'jpeg';
}
interface MediaRow {
  alt?: Record<string, unknown>;
  caption?: Record<string, unknown>;
}
interface MediaEntry { row?: MediaRow; missing?: boolean; error?: unknown }
export interface RichGalleryLibrary {
  peek(src: string): MediaEntry | undefined;
  lookup(srcs: string[], options?: { fresh?: boolean }): Promise<Map<string, MediaEntry>>;
}
export interface RichEditorOptions {
  element: HTMLElement;
  markdown: string;
  locale: string;
  imageOrigin: string;
  copy: RichEditorCopy;
  galleryLibrary?: RichGalleryLibrary;
  images?: () => Record<string, EditorImageMetadata>;
  thumbnailUrl?: (photo: { heroSrc: string; heroWidth?: number; heroFormat?: 'jpeg' }) => string | null;
  onChange: (markdown: string) => void;
  onSelection?: () => void;
  onEditGallery?: (sourceStart: number) => void;
}
export interface MarkdownSelection { from: number; to: number }
export interface RichEditor {
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
  refreshImageMetadata(): void;
  focus(): void;
  destroy(): void;
  command(name: string): boolean;
  getSelection(): MarkdownSelection;
  setSelection(selection: MarkdownSelection): void;
  isActive(name: string): boolean;
  undo(): boolean;
  redo(): boolean;
}

interface Gallery { start: number; lines: string[] }

/** Only scan a block already classified as containing a gallery by the Markdown
 * lexer. Prefixes support galleries in blockquotes and list items as well as
 * ordinary top-level fences. Source is never interpreted as HTML. */
function galleriesIn(raw: string): Gallery[] {
  const lines = [...raw.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)]
    .filter((line) => line[0].length > 0);
  const galleries: Gallery[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const text = line[0].replace(/[\r\n]+$/, '');
    const opening = /^([ \t]*(?:(?:>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+)[ \t]*)*)(`{3,}|~{3,})[ \t]*gallery(?:[ \t]+[^\r\n]*)?$/.exec(text);
    if (!opening) continue;
    const fence = opening[2] ?? '';
    const body: string[] = [];
    for (i++; i < lines.length; i++) {
      const content = (lines[i]?.[0] ?? '').replace(/[\r\n]+$/, '').replace(/^[ \t]*(?:>[ \t]?[ \t]*)*/, '');
      const close = /^(`{3,}|~{3,})[ \t]*$/.exec(content)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) break;
      body.push(content);
    }
    if (i < lines.length) galleries.push({ start: (line.index ?? 0) + (opening[1]?.length ?? 0), lines: body });
  }
  return galleries;
}

function imageElement(src: string | null, alt: string, options: RichEditorOptions): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'rich-text-image';
  const safe = src && safeImageUrl(src, options.imageOrigin, window.location.href);
  if (safe) {
    const image = document.createElement('img');
    image.alt = alt;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => { wrapper.textContent = options.copy.imageUnavailable; });
    image.src = safe;
    wrapper.append(image);
  } else {
    wrapper.textContent = options.copy.imageUnavailable;
    if (src) wrapper.title = src;
  }
  return wrapper;
}

function galleryView(gallery: Gallery, options: RichEditorOptions, edit: () => void, imageViews: Set<() => void>) {
  const container = document.createElement('section');
  container.className = 'rich-text-gallery';
  const heading = document.createElement('div');
  heading.className = 'rich-text-gallery-heading';
  const label = document.createElement('strong');
  label.textContent = options.copy.galleryLabel;
  heading.append(label);
  if (options.onEditGallery) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rich-text-gallery-edit';
    button.textContent = options.copy.editGallery;
    button.addEventListener('click', (event) => { event.preventDefault(); edit(); });
    heading.append(button);
  }
  container.append(heading);
  const status = document.createElement('p');
  status.className = 'rich-text-gallery-status';
  status.setAttribute('role', 'status');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = options.copy.galleryRetry;
  retry.hidden = true;
  container.append(status, retry);
  const items = document.createElement('div');
  items.className = 'rich-text-gallery-items';
  const fields: { src: string; apply: (entry: MediaEntry | undefined) => void; refresh: () => void }[] = [];
  const directive = gallery.lines.map((line) => /^\s*#\s*captions\s*:\s*(\S*)\s*$/i.exec(line)).find(Boolean);
  const showCaptions = directive?.[1]?.toLowerCase() !== 'hidden';
  for (const line of gallery.lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const note = document.createElement('div');
      note.className = 'rich-text-gallery-directive';
      note.textContent = trimmed;
      items.append(note);
      continue;
    }
    const photo = parsePhotoLine(line);
    if (!photo.valid) {
      const invalid = document.createElement('div');
      invalid.className = 'rich-text-gallery-invalid';
      invalid.textContent = line;
      items.append(invalid);
      continue;
    }
    const figure = document.createElement('figure');
    let image = imageElement(null, '', options);
    let thumbnail: string | null = null;
    let currentEntry: MediaEntry | undefined;
    const caption = document.createElement('figcaption');
    figure.append(image, caption);
    items.append(figure);
    const apply = (entry: MediaEntry | undefined) => {
      currentEntry = entry;
      // Translation replaces map entries without necessarily changing Markdown.
      // Read current local metadata on every refresh; Media still owns its fields.
      const stored = options.images?.()[photo.src] ?? {};
      let alt = '';
      let inheritedCaption = '';
      if (entry?.row) {
        const libraryAlt = entry.row.alt?.[options.locale];
        const libraryCaption = entry.row.caption?.[options.locale];
        alt = typeof libraryAlt === 'string' ? libraryAlt : '';
        inheritedCaption = typeof libraryCaption === 'string' ? libraryCaption : '';
      } else if (entry?.missing) {
        alt = photo.alt ?? stored.alt ?? '';
        inheritedCaption = photo.caption ?? stored.caption ?? '';
      }
      const nextThumbnail = options.thumbnailUrl?.({
        heroSrc: photo.src, heroWidth: photo.width ?? stored.width, heroFormat: photo.format ?? stored.format,
      }) ?? null;
      if (nextThumbnail !== thumbnail) {
        const replacement = imageElement(nextThumbnail, alt, options);
        image.replaceWith(replacement);
        image = replacement;
        thumbnail = nextThumbnail;
      }
      const img = image.querySelector('img');
      if (img) img.alt = alt;
      caption.textContent = photo.captionOverride ?? inheritedCaption;
      caption.hidden = !showCaptions || !caption.textContent;
    };
    fields.push({ src: photo.src, apply, refresh: () => apply(currentEntry) });
    apply(options.galleryLibrary?.peek(photo.src));
  }
  container.append(items);
  let alive = true;
  let ticket = 0;
  const lookup = (fresh: boolean) => {
    const library = options.galleryLibrary;
    if (!library || !fields.length) return;
    const current = ++ticket;
    const pending = fields.filter((field) => fresh || !library.peek(field.src));
    if (!pending.length) return;
    status.textContent = options.copy.galleryChecking;
    retry.hidden = true;
    library.lookup(pending.map((field) => field.src), { fresh }).then((entries) => {
      if (!alive || current !== ticket) return;
      let failed = false;
      for (const field of pending) {
        const entry = entries.get(field.src);
        field.apply(entry);
        if (!entry || entry.error) failed = true;
      }
      status.textContent = failed ? options.copy.galleryLookupFailed : '';
      retry.hidden = !failed;
    }).catch(() => {
      if (!alive || current !== ticket) return;
      status.textContent = options.copy.galleryLookupFailed;
      retry.hidden = false;
    });
  };
  retry.addEventListener('click', () => lookup(true));
  lookup(false);
  const refresh = () => { fields.forEach((field) => field.refresh()); };
  imageViews.add(refresh);
  return { dom: container, destroy() { alive = false; ticket++; imageViews.delete(refresh); } };
}

function sourceNode(name: 'richSource' | 'richGallery', options: RichEditorOptions, sourceOffset: (position: number) => number, imageViews: Set<() => void>) {
  return TiptapNode.create({
    name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return { raw: { default: '', rendered: false }, galleries: { default: false, rendered: false } };
    },
    parseHTML() { return []; },
    // Clipboard/drag serialization is inert, even if the source contains HTML.
    renderHTML({ node }) { return ['pre', { class: 'rich-text-source' }, String(node.attrs.raw ?? '')]; },
    renderMarkdown(node) { return String(node.attrs?.raw ?? ''); },
    addNodeView() {
      return ({ node, getPos }) => {
        const raw = String(node.attrs.raw ?? '');
        const root = document.createElement('div');
        root.contentEditable = 'false';
        const views: { destroy(): void }[] = [];
        const galleries = name === 'richGallery' || node.attrs.galleries ? galleriesIn(raw) : [];
        if (name === 'richSource') {
          root.className = 'rich-text-source';
          const label = document.createElement('strong');
          label.textContent = options.copy.sourceLabel;
          const help = document.createElement('p');
          help.textContent = options.copy.sourceHelp;
          const pre = document.createElement('pre');
          pre.textContent = raw;
          root.append(label, help, pre);
        }
        for (const gallery of galleries) {
          const view = galleryView(gallery, options, () => {
            const position = getPos();
            if (typeof position === 'number') options.onEditGallery?.(sourceOffset(position) + gallery.start);
          }, imageViews);
          views.push(view);
          root.append(view.dom);
        }
        // A malformed gallery still remains visible as exact source.
        if (name === 'richGallery' && !galleries.length) {
          root.className = 'rich-text-source';
          const label = document.createElement('strong');
          label.textContent = options.copy.sourceLabel;
          const help = document.createElement('p');
          help.textContent = options.copy.sourceHelp;
          const pre = document.createElement('pre');
          pre.textContent = raw;
          root.append(label, help, pre);
        }
        return {
          dom: root,
          destroy() { views.forEach((view) => view.destroy()); },
          stopEvent: (event) => event.target instanceof Element && Boolean(event.target.closest('button')),
        };
      };
    },
  });
}
/** Link and image destinations are Markdown, not HTML attributes. Escape
 * punctuation and entities before reserializing an edited containing block. */
function markdownDestination(value: string): string {
  return value.replace(/&/g, '&amp;')
    .replace(/[\\()<>]/g, '\\$&')
    .replace(/[\u0000-\u0020\u007f]/g, (character) => encodeURIComponent(character));
}

function markdownTitle(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/[\\"]/g, '\\$&');
}

const safeCodeBlock = CodeBlock.extend({
  parseMarkdown(token, helpers) {
    const text = typeof token.text === 'string' ? token.text : '';
    const language = typeof token.lang === 'string' ? token.lang : null;
    return helpers.createNode('codeBlock', { language }, text ? [helpers.createTextNode(text)] : []);
  },
  renderMarkdown(node) {
    const body = (node.content ?? []).map((child) => child.text ?? '').join('');
    const language = String(node.attrs?.language ?? '');
    // A fence must be longer than every run of its delimiter in the body.
    const delimiter = language.includes('`') ? '~' : '`';
    const runs = delimiter === '`' ? /`+/g : /~+/g;
    let length = 3;
    for (const run of body.matchAll(runs)) length = Math.max(length, run[0].length + 1);
    const fence = delimiter.repeat(length);
    return `${fence}${language}\n${body}\n${fence}`;
  },
});

const safeMarkdownLink = Link.extend({
  parseMarkdown(token, helpers) {
    return helpers.applyMark('link', helpers.parseInline(token.tokens ?? []), {
      href: decodeHTMLStrict(String(token.href ?? '')),
      title: token.title ? decodeHTMLStrict(String(token.title)) : null,
    });
  },
  renderMarkdown(node, helpers) {
    const href = markdownDestination(String(node.attrs?.href ?? ''));
    const title = node.attrs?.title ? ` \"${markdownTitle(String(node.attrs.title))}\"` : '';
    return `[${helpers.renderChildren(node)}](${href}${title})`;
  },
}).configure({
  openOnClick: false, autolink: false, linkOnPaste: false,
  isAllowedUri: (url) => typeof url === 'string' && safeLink(url),
});


/** Each editor instance owns its source provenance, selection and undo history. */
export function createRichEditor(options: RichEditorOptions): RichEditor {
  // Presentation-only consumers of the article image map; refreshing them must
  // not dispatch a document transaction or disturb either engine's history.
  const imageViews = new Set<() => void>();
  const provenance = Extension.create({
    name: 'sourceProvenance',
    addGlobalAttributes() {
      return [{
        types: ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'horizontalRule', 'table', 'richSource', 'richGallery'],
        attributes: { sourceKey: { default: null, rendered: false } },
      }];
    },
  });
  const safeImage = Image.extend({
    // The renderer used for copying must not introduce a network fetch either.
    renderHTML({ node }) { return ['span', { class: 'rich-text-image' }, String(node.attrs.alt ?? '')]; },
    parseMarkdown(token, helpers) {
      return helpers.createNode('image', {
        src: decodeHTMLStrict(String(token.href ?? '')),
        alt: decodeHTMLStrict(String(token.text ?? '')),
        title: token.title ? decodeHTMLStrict(String(token.title)) : null,
      });
    },
    renderMarkdown(node) {
      const alt = String(node.attrs?.alt ?? '').replace(/&/g, '&amp;').replace(/[\\[\]]/g, '\\$&');
      const src = markdownDestination(String(node.attrs?.src ?? ''));
      const title = node.attrs?.title ? ` \"${markdownTitle(String(node.attrs.title))}\"` : '';
      return `![${alt}](${src}${title})`;
    },
    addNodeView() {
      return ({ node }) => {
        const src = String(node.attrs.src ?? '');
        const dom = document.createElement('span');
        let renderedPreview: string | null | undefined;
        const refresh = () => {
          const stored = options.images?.()[src];
          const preview = stored ? options.thumbnailUrl?.({ heroSrc: src, heroWidth: stored.width, heroFormat: stored.format }) ?? null : src;
          if (preview === renderedPreview) return;
          renderedPreview = preview;
          dom.replaceChildren(imageElement(preview, String(node.attrs.alt ?? ''), options));
        };
        refresh();
        imageViews.add(refresh);
        return { dom, destroy() { imageViews.delete(refresh); } };
      };
    },
  }).configure({ inline: true, allowBase64: false });
  let suppress = true;
  let model: RichSource;
  let editor: Editor;
  const at = (position: number) => model.render(editor.state.doc).spans.find((span) => span.position === position)?.start ?? 0;
  editor = new Editor({
    element: options.element,
    injectCSS: false,
    extensions: [
      StarterKit.configure({
        trailingNode: false,
        codeBlock: false, link: false,
      }),
      safeCodeBlock, safeMarkdownLink, safeImage, Table, TableRow, TableHeader, TableCell, TaskList, TaskItem.configure({ nested: true }),
      sourceNode('richSource', options, at, imageViews), sourceNode('richGallery', options, at, imageViews), provenance,
      // The extension's tokenizer registry mutates its Marked instance; giving
      // each editor its own avoids accumulating handlers across locale reloads.
      Markdown.configure({ marked: new Marked() as unknown as typeof marked }),
    ],
    editorProps: {
      attributes: { 'aria-label': options.copy.bodyLabel },
      // ProseMirror normally parses clipboard HTML before handlePaste. Intercept
      // the DOM event first so neither images nor author HTML are instantiated.
      handleDOMEvents: {
        paste(view, event) {
          const clipboard = event.clipboardData;
          if (!clipboard) return false;
          const text = clipboard.getData('text/plain') || clipboard.getData('text/html');
          if (text) view.pasteText(text);
          event.preventDefault();
          return true;
        },
        drop(view, event) {
          if (view.dragging) return false;
          const transfer = event.dataTransfer;
          if (!transfer) return false;
          const text = transfer.getData('text/plain') || transfer.getData('text/html');
          if (text) {
            const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            if (position !== undefined) {
              view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(position))));
              view.pasteText(text);
            }
          }
          event.preventDefault();
          return true;
        },
      },
      transformPastedHTML: () => '',
    },
    onUpdate() {
      if (suppress) return;
      options.onChange(model.render(editor.state.doc).markdown);
      options.onSelection?.();
    },
    onSelectionUpdate({ transaction }) {
      // Tiptap emits selectionUpdate before update. Do not send a selection
      // against yesterday's source while a text-changing transaction is pending.
      if (!suppress && !transaction.docChanged) options.onSelection?.();
    },
  });
  if (!editor.markdown) { editor.destroy(); throw new Error('Markdown extension unavailable'); }
  model = new RichSource(editor.markdown);
  const parse = (markdown: string): JSONContent => model.parse(markdown, (node) => editor.schema.nodeFromJSON(node));
  try {
    editor.chain().setMeta('addToHistory', false).setContent(parse(options.markdown), { emitUpdate: false, errorOnInvalidContent: true }).run();
  } catch (error) {
    editor.destroy();
    throw error;
  }
  suppress = false;

  return {
    getMarkdown() { return model.render(editor.state.doc).markdown; },
    setMarkdown(markdown) {
      if (model.render(editor.state.doc).markdown === markdown) return;
      const document = parse(markdown);
      suppress = true;
      try { editor.commands.setContent(document, { emitUpdate: false, errorOnInvalidContent: true }); }
      finally { suppress = false; }
    },
    refreshImageMetadata() { imageViews.forEach((refresh) => refresh()); },
    focus() { editor.commands.focus(); },
    destroy() { editor.destroy(); },
    getSelection() {
      const document = model.render(editor.state.doc);
      return { from: sourcePosition(document, editor.state.selection.from), to: sourcePosition(document, editor.state.selection.to) };
    },
    setSelection(selection) {
      const document = model.render(editor.state.doc);
      const from = editorPosition(document, selection.from, editor.state.doc);
      const to = editorPosition(document, selection.to, editor.state.doc);
      const $from = editor.state.doc.resolve(from);
      const $to = editor.state.doc.resolve(to);
      // Selection.near resolves atom boundaries without manufacturing an
      // invalid TextSelection at the document level.
      if (from === to && !$from.parent.inlineContent) {
        editor.view.dispatch(editor.state.tr.setSelection(Selection.near($from)));
      } else if ($from.parent.inlineContent && $to.parent.inlineContent) {
        editor.commands.setTextSelection({ from, to });
      } else {
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.between($from, $to)));
      }
    },
    command(name) {
      const chain = editor.chain().focus();
      switch (name) {
        case 'bold': return chain.toggleBold().run();
        case 'italic': return chain.toggleItalic().run();
        case 'heading': return chain.toggleHeading({ level: 2 }).run();
        case 'quote': return chain.toggleBlockquote().run();
        case 'bullets': return chain.toggleBulletList().run();
        case 'numbers': return chain.toggleOrderedList().run();
        case 'code': return chain.toggleCodeBlock().run();
        case 'link': {
          const href = window.prompt(options.copy.linkPrompt, String(editor.getAttributes('link').href ?? ''));
          if (href === null) return false;
          if (href === '') return chain.extendMarkRange('link').unsetLink().run();
          if (!safeLink(href)) { window.alert(options.copy.linkInvalid); return false; }
          return chain.extendMarkRange('link').setLink({ href }).run();
        }
        default: return false;
      }
    },
    isActive(name) {
      const type: Record<string, string> = { heading: 'heading', quote: 'blockquote', bullets: 'bulletList', numbers: 'orderedList', code: 'codeBlock' };
      return editor.isActive(type[name] ?? name);
    },
    undo() { return editor.commands.undo(); },
    redo() { return editor.commands.redo(); },
  };
}

if (typeof window !== 'undefined') {
  Object.assign(window, { RichTextEditor: { create: createRichEditor } });
}
