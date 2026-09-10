import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('public/admin-confirm.js', 'utf8');

interface Api {
  ask(opts: { title?: string; body?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  liveUrls(slugs: { de?: string; en?: string }): { de: string; en: string };
  urlsPlain(slugs: { de?: string; en?: string }): string;
}

function load(opts: { confirm?: () => boolean; origin?: string } = {}): { api: Api; confirmedWith: string[] } {
  const confirmedWith: string[] = [];
  const windowStub: { AdminConfirm?: Api; confirm?: (msg: string) => boolean } = {};
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
  };
  windowStub.confirm = ctx.confirm;
  vm.runInNewContext(src, ctx);
  if (!windowStub.AdminConfirm) throw new Error('admin-confirm.js did not assign window.AdminConfirm');
  return { api: windowStub.AdminConfirm, confirmedWith };
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
