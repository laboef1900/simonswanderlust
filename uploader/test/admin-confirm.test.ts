import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { editorDocument, EditorEvent, type EditorElement } from './editor-dom-harness.js';

const src = readFileSync('public/admin-confirm.js', 'utf8');

interface Api {
  ask(opts: { title?: string; body?: string; confirmLabel?: string; danger?: boolean; typed?: string }): Promise<boolean>;
  liveUrls(slugs: { de?: string; en?: string }): { de: string; en: string };
  urlsPlain(slugs: { de?: string; en?: string }): string;
}

function load(opts: { confirm?: () => boolean; prompt?: (msg: string, def?: string) => string | null; origin?: string } = {}): { api: Api; confirmedWith: string[]; promptedWith: string[] } {
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
  vm.runInNewContext(src, ctx);
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
});
