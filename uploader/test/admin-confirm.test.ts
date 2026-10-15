import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('public/admin-confirm.js', 'utf8');

interface Api {
  ask(opts: { title?: string; body?: string; confirmLabel?: string; danger?: boolean; typed?: string }): Promise<boolean>;
  askFields(opts: { title?: string; body?: string; confirmLabel?: string; fields: { name: string; label?: string; value?: string }[] }): Promise<Record<string, string> | null>;
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

describe('AdminConfirm.askFields fallback', () => {
  it('returns both slug values', async () => {
    const { api } = load({ prompt: (_msg, def) => (def === 'a-kopie' ? 'a-kopie' : 'b-copy') });
    await expect(api.askFields({
      title: 'New from this one',
      fields: [
        { name: 'de', label: 'DE slug', value: 'a-kopie' },
        { name: 'en', label: 'EN slug', value: 'b-copy' },
      ],
    })).resolves.toEqual({ de: 'a-kopie', en: 'b-copy' });
  });
  it('returns null when the first field is cancelled', async () => {
    const { api } = load({ prompt: () => null });
    await expect(api.askFields({
      title: 'New from this one',
      fields: [{ name: 'de', value: 'x' }, { name: 'en', value: 'y' }],
    })).resolves.toBeNull();
  });
});
