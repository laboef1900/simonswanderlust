import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ui } from '../../site/src/i18n/ui.js';
import { editorDocument, EditorEvent, type EditorElement } from './editor-dom-harness.js';

const src = readFileSync('public/admin-confirm.js', 'utf8');

interface Api {
  ask(opts: { title?: string; body?: string; confirmLabel?: string; danger?: boolean; typed?: string; tone?: 'publish' }): Promise<boolean>;
  prompt(opts: { title?: string; label?: string; value?: string; confirmLabel?: string; required?: string | false; validate?: (text: string) => string }): Promise<string | null>;
  liveUrls(slugs: { de?: string; en?: string }): { de: string; en: string };
  urlsPlain(slugs: { de?: string; en?: string }): string;
}

function load(opts: { confirm?: () => boolean; prompt?: (msg: string, def?: string) => string | null; origin?: string; language?: { primary: 'de' | 'en'; locales: ('de' | 'en')[] } } = {}): { api: Api; confirmedWith: string[]; promptedWith: string[] } {
  const confirmedWith: string[] = [];
  const promptedWith: string[] = [];
  const windowStub: { AdminConfirm?: Api; confirm?: (msg: string) => boolean; prompt?: (msg: string, def?: string) => string | null } = {};
  const ctx = {
    window: windowStub,
    document: {
      getElementById: () => null,
      createElement: () => ({}),
      body: { appendChild() {} },
    },
    location: { origin: opts.origin ?? 'https://simonswanderlust.com' },
    confirm: (msg: string) => {
      confirmedWith.push(msg);
      return opts.confirm ? opts.confirm() : true;
    },
    prompt: (msg: string, def?: string) => {
      promptedWith.push(msg);
      return opts.prompt ? opts.prompt(msg, def) : (def ?? '');
    },
  };
  windowStub.confirm = ctx.confirm;
  windowStub.prompt = ctx.prompt;
  Object.assign(windowStub, { EditorCopy: { en: Object.fromEntries(Object.entries(ui.en)
    .filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value])) } });
  vm.createContext(ctx);
  vm.runInContext(readFileSync('public/language.js', 'utf8'), ctx);
  vm.runInContext(`SiteLanguage = window.SiteLanguage; SiteLanguage.accept(${JSON.stringify({
    primary: 'de', locales: ['de', 'en'], ...opts.language, lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z',
  })})`, ctx);
  vm.runInContext(src, ctx);
  if (!windowStub.AdminConfirm) throw new Error('admin-confirm.js did not assign window.AdminConfirm');
  return { api: windowStub.AdminConfirm, confirmedWith, promptedWith };
}

describe('AdminConfirm.liveUrls', () => {
  it('builds DE at root and EN under /en/ with trailing slashes', () => {
    const { api } = load();
    expect(api.liveUrls({ de: 'bukarest', en: 'bucharest' })).toEqual({
      de: 'https://simonswanderlust.com/bukarest/',
      en: 'https://simonswanderlust.com/en/bucharest/',
    });
  });

  it('omits a locale whose slug is empty', () => {
    const { api } = load();
    expect(api.liveUrls({ de: 'bukarest', en: '' })).toEqual({
      de: 'https://simonswanderlust.com/bukarest/',
      en: '',
    });
  });

  it('uses the English root and never links disabled German content', () => {
    const { api } = load({ language: { primary: 'en', locales: ['en'] } });
    expect(api.liveUrls({ de: 'deutsch', en: 'english' })).toEqual({ de: '', en: 'https://simonswanderlust.com/english/' });
  });

  it('prefixes German when English is primary', () => {
    const { api } = load({ language: { primary: 'en', locales: ['en', 'de'] } });
    expect(api.liveUrls({ de: 'deutsch', en: 'english' })).toEqual({
      de: 'https://simonswanderlust.com/de/deutsch/', en: 'https://simonswanderlust.com/english/',
    });
  });
});

describe('AdminConfirm.urlsPlain', () => {
  it('formats both URLs for the confirm body', () => {
    const { api } = load();
    expect(api.urlsPlain({ de: 'a', en: 'b' })).toBe(
      'DE  https://simonswanderlust.com/a/\nEN  https://simonswanderlust.com/en/b/',
    );
  });
});

describe('AdminConfirm.ask fallback', () => {
  it('uses window.confirm when <dialog> is unavailable', async () => {
    const { api, confirmedWith } = load({ confirm: () => false });
    await expect(api.ask({ title: 'Publish to the live site?', body: 'Rebuilds the journal.' })).resolves.toBe(false);
    expect(confirmedWith).toEqual(['Publish to the live site?\n\nRebuilds the journal.']);
  });
});

describe('AdminConfirm.ask typed fallback', () => {
  it('accepts only the required token', async () => {
    const { api, promptedWith } = load({ prompt: () => 'DELETE' });
    await expect(api.ask({ title: 'Delete 2 post(s)?', body: 'Cannot be undone.', typed: 'DELETE' })).resolves.toBe(true);
    expect(promptedWith[0]).toMatch(/Type DELETE/);
  });
  it('rejects a mismatched token', async () => {
    const { api } = load({ prompt: () => 'delete' });
    await expect(api.ask({ title: 'Delete?', typed: 'DELETE' })).resolves.toBe(false);
  });
});

it('presents the primary URL first in the publication confirmation', () => {
  const { api } = load({ language: { primary: 'en', locales: ['en', 'de'] } });
  expect(api.urlsPlain({ de: 'reise', en: 'journey' })).toBe(
    'EN  https://simonswanderlust.com/journey/\nDE  https://simonswanderlust.com/de/reise/',
  );
});

describe('AdminConfirm.ask native dialog', () => {
  function nativeDialog() {
    const dom = editorDocument('<body></body>');
    const window: { AdminConfirm?: Api } = {};
    vm.runInNewContext(src, { window, document: dom.document });
    const api = window.AdminConfirm!;
    const dialog = () => dom.document.getElementById('adminConfirm') as EditorElement & { returnValue: string };
    function close(result?: string) {
      // Native dialog close requests leave the previous result untouched when
      // no result is supplied (including Escape in Firefox/WebKit).
      if (result !== undefined) dialog().returnValue = result;
      dialog().close();
      dom.flushDialogEvents();
    }
    return { api, dom, dialog, close };
  }

  it.each(['escape', 'close', 'cancel'] as const)('does not reuse prior consent after %s', async (dismiss) => {
    const { api, dom, dialog, close } = nativeDialog();
    const accepted = api.ask({ title: 'Unpublish?' });
    close('ok');
    await expect(accepted).resolves.toBe(true);

    const cancelled = api.ask({ title: 'Delete?', danger: true });
    if (dismiss === 'escape') {
      dialog().fire('keydown', { key: 'Escape' });
      dom.flushDialogEvents();
    } else {
      close(dismiss === 'cancel' ? 'cancel' : undefined);
    }
    await expect(cancelled).resolves.toBe(false);

    const confirmedAgain = api.ask({ title: 'Publish?' });
    close('ok');
    await expect(confirmedAgain).resolves.toBe(true);
  });

  it('confirms a matching typed token with Enter, but not a mismatch or composition', async () => {
    const { api, dom, dialog } = nativeDialog();
    const accepted = api.ask({ title: 'Delete two trips?', typed: 'DELETE' });
    const input = dom.document.getElementById('adminConfirmTyped')!;
    for (const token of ['', 'delete', 'DELETE ']) {
      input.value = token;
      const event = input.fire('keydown', { key: 'Enter' });
      expect(event.defaultPrevented).toBe(true);
      expect(dialog().open).toBe(true);
    }
    input.value = 'DELETE';
    input.dispatchEvent(new EditorEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    expect(dialog().open).toBe(true);
    input.fire('keydown', { key: 'Enter' });
    expect(dialog().open).toBe(false);
    dom.flushDialogEvents();
    await expect(accepted).resolves.toBe(true);
  });

  it('requires fresh consent and the token on each typed confirmation', async () => {
    const { api, dom, dialog, close } = nativeDialog();
    const accepted = api.ask({ title: 'Delete two trips?', typed: 'DELETE' });
    dom.document.getElementById('adminConfirmTyped')!.value = 'DELETE';
    close('ok');
    await expect(accepted).resolves.toBe(true);

    const escaped = api.ask({ title: 'Delete another trip?', typed: 'DELETE' });
    dom.document.getElementById('adminConfirmTyped')!.value = 'DELETE';
    dialog().fire('keydown', { key: 'Escape' });
    dom.flushDialogEvents();
    await expect(escaped).resolves.toBe(false);

    const wrongToken = api.ask({ title: 'Delete another trip?', typed: 'DELETE' });
    dom.document.getElementById('adminConfirmTyped')!.value = 'delete';
    close('ok');
    await expect(wrongToken).resolves.toBe(false);
  });

  it('paints the action red only for a live-site or destructive decision, and never focuses Delete', async () => {
    const { api, dom, close } = nativeDialog();
    const ok = () => dom.document.getElementById('adminConfirmOk')!;
    const cancel = () => dom.document.getElementById('adminConfirmCancel')!;

    const restore = api.ask({ title: 'Restore unsaved draft?', confirmLabel: 'Restore' });
    expect(ok().className).toBe('');
    expect(dom.document.activeElement).toBe(ok());
    close('cancel');
    await restore;

    const publish = api.ask({ title: 'Publish to the live site?', confirmLabel: 'Publish', tone: 'publish' });
    expect(ok().className).toBe('btn-publish');
    expect(dom.document.activeElement).toBe(ok());
    close('cancel');
    await publish;

    const remove = api.ask({ title: 'Delete this comment?', confirmLabel: 'Delete', danger: true });
    expect(ok().className).toBe('btn-remove');
    expect(dom.document.activeElement).toBe(cancel());
    close('cancel');
    await remove;

    // A live-site action that is also destructive (Unpublish) keeps the destructive defaults.
    const unpublish = api.ask({ title: 'Unpublish?', danger: true, tone: 'publish' });
    expect(ok().className).toBe('btn-remove');
    expect(dom.document.activeElement).toBe(cancel());
    close('cancel');
    await unpublish;
  });

  it('asks for one line of text in the same dialog and returns it trimmed', async () => {
    const { api, dom, dialog } = nativeDialog();
    const asked = api.prompt({ title: 'New folder', label: 'Folder name', confirmLabel: 'Create folder' });
    const input = dom.document.getElementById('adminConfirmText')!;
    expect(dom.document.activeElement).toBe(input);
    expect(dom.document.querySelector('label[for=adminConfirmText]')!.textContent).toBe('Folder name');
    input.value = '  Rumänien 2026  ';
    input.fire('keydown', { key: 'Enter' });
    expect(dialog().open).toBe(false);
    dom.flushDialogEvents();
    await expect(asked).resolves.toBe('Rumänien 2026');
  });

  it('refuses an empty or invalid name with a sentence under the field, and keeps the dialog open', async () => {
    const { api, dom, dialog, close } = nativeDialog();
    const asked = api.prompt({
      title: 'Rename folder', value: 'trips', required: 'Enter a folder name.',
      validate: (text) => text.includes('/') ? 'A folder name cannot contain “/”.' : '',
    });
    const input = dom.document.getElementById('adminConfirmText')!;
    const error = dom.document.getElementById('adminConfirmTextError')!;
    expect(input.value).toBe('trips');

    input.value = '   ';
    input.fire('keydown', { key: 'Enter' });
    expect(dialog().open).toBe(true);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Enter a folder name.');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    input.value = 'a/b';
    const click = dom.document.getElementById('adminConfirmOk')!.fire('click');
    expect(click.defaultPrevented).toBe(true);
    expect(error.textContent).toBe('A folder name cannot contain “/”.');

    // A forced close with an invalid value is a cancel, never the invalid text.
    close('ok');
    await expect(asked).resolves.toBeNull();
  });

  it('returns null when the text prompt is cancelled, and starts each prompt clean', async () => {
    const { api, dom, dialog, close } = nativeDialog();
    const first = api.prompt({ title: 'New folder' });
    dom.document.getElementById('adminConfirmText')!.value = 'draft';
    dialog().fire('keydown', { key: 'Escape' });
    dom.flushDialogEvents();
    await expect(first).resolves.toBeNull();

    const second = api.prompt({ title: 'New folder' });
    expect(dom.document.getElementById('adminConfirmText')!.value).toBe('');
    expect(dom.document.querySelectorAll('#adminConfirmText')).toHaveLength(1);
    close('cancel');
    await expect(second).resolves.toBeNull();
  });

  it('accepts an empty answer only when the caller says the text is optional, and tells it apart from Cancel', async () => {
    const { api, dom, dialog, close } = nativeDialog();
    const cleared = api.prompt({ title: 'Link', label: 'Link address', value: 'https://example.com/', required: false });
    const input = dom.document.getElementById('adminConfirmText')!;
    input.value = '   ';
    input.fire('keydown', { key: 'Enter' });
    expect(dialog().open).toBe(false);
    dom.flushDialogEvents();
    await expect(cleared).resolves.toBe('');

    const cancelled = api.prompt({ title: 'Link', label: 'Link address', required: false });
    close('cancel');
    await expect(cancelled).resolves.toBeNull();
  });
});
