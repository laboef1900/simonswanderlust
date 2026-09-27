// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initComments, paintComments, parsePayload, type CommentLabels } from './comments';
import { locales, ui } from '../i18n/ui';

const labels: CommentLabels = {
  heading: 'Comments',
  empty: 'No comments yet.',
  unavailable: 'Comments are unavailable right now.',
  moderated: 'Moderated',
  name: 'Name',
  email: 'Email',
  body: 'Comment',
  submit: 'Send',
  sending: 'Sending',
  thanks: 'Thanks',
  error: 'Error',
  by: 'By',
};

function mount(): HTMLElement {
  document.body.innerHTML = `
    <section data-comments-root>
      <div data-comments-list></div>
      <form data-comments-form hidden><p data-comments-status></p></form>
    </section>`;
  return document.querySelector('[data-comments-root]') as HTMLElement;
}

const jsonFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, status: ok ? 200 : 500, json: async () => payload }) as Response) as typeof fetch;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('paintComments', () => {
  it('keeps script and img onerror payloads as text', () => {
    const list = document.createElement('div');
    document.body.append(list);
    const name = '<img src=x onerror="window.__pwned=1">';
    const body = '<script>window.__pwned=1</script>';
    paintComments(list, [{ name, body, createdAt: '2026-09-01T10:00:00Z' }], labels, 'en');
    expect(list.querySelector('script')).toBeNull();
    expect(list.querySelector('img')).toBeNull();
    expect(list.querySelector('.comments__name')?.textContent).toBe(name);
    expect(list.textContent).toContain(body);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('splits line breaks into paragraphs by text', () => {
    const list = document.createElement('div');
    paintComments(list, [{ name: 'A', body: 'one\n\ntwo', createdAt: '' }], labels, 'de');
    const paras = [...list.querySelectorAll('li > p')].map((p) => p.textContent);
    expect(paras.slice(1)).toEqual(['one', 'two']);
  });

  it('shows the empty message for no comments', () => {
    const list = document.createElement('div');
    paintComments(list, [], labels, 'en');
    expect(list.textContent).toBe('No comments yet.');
  });
});

describe('initComments', () => {
  it('fetches the relative /comments URL', async () => {
    const root = mount();
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ enabled: true, comments: [] }) } as Response;
    }) as unknown as typeof fetch;
    await initComments(root, { translationKey: 'tk', locale: 'en', labels, fetchImpl: f });
    expect(url.startsWith('/comments?')).toBe(true);
  });

  it('enabled false hides form and keeps list', async () => {
    const root = mount();
    const payload = { enabled: false, comments: [{ name: 'Ann', body: 'Hi', createdAt: '' }] };
    await initComments(root, { translationKey: 'tk', locale: 'en', labels, fetchImpl: jsonFetch(payload) });
    expect(root.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    expect(root.querySelector('.comments__name')?.textContent).toBe('Ann');
  });

  it('enabled true reveals the form', async () => {
    const root = mount();
    await initComments(root, {
      translationKey: 'tk',
      locale: 'en',
      labels,
      fetchImpl: jsonFetch({ enabled: true, comments: [] }),
    });
    expect(root.querySelector<HTMLFormElement>('form')!.hidden).toBe(false);
  });

  it('degrades to the unavailable message on fetch failure', async () => {
    for (const f of [
      jsonFetch({}, false),
      (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
      jsonFetch('garbage'),
    ]) {
      const root = mount();
      await initComments(root, { translationKey: 'tk', locale: 'de', labels, fetchImpl: f });
      expect(root.querySelector('[data-comments-list]')?.textContent).toBe(labels.unavailable);
      expect(root.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    }
  });

  it('parsePayload drops malformed entries', () => {
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload({ enabled: true, comments: [{ name: 1 }, { name: 'a', body: 'b' }] })?.comments).toHaveLength(1);
  });
});

describe('comments i18n and invariants', () => {
  it('defines every comments.* key, non-empty, in de and en', () => {
    const deKeys = Object.keys(ui.de).filter((k) => k.startsWith('comments.')).sort();
    expect(deKeys.length).toBeGreaterThanOrEqual(12);
    for (const locale of locales) {
      const keys = Object.keys(ui[locale]).filter((k) => k.startsWith('comments.')).sort();
      expect(keys, locale).toEqual(deKeys);
      for (const k of keys) expect(ui[locale][k as keyof typeof ui.de], `${locale}.${k}`).not.toBe('');
    }
  });

  it('never uses innerHTML, set:html or astro:content for comments', () => {
    // happy-dom rewrites import.meta.url, so resolve from the site root (vitest cwd).
    const script = readFileSync(resolve(process.cwd(), 'src/scripts/comments.ts'), 'utf8');
    const island = readFileSync(resolve(process.cwd(), 'src/components/CommentsIsland.astro'), 'utf8');
    for (const src of [script, island]) {
      expect(src).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
      expect(src).not.toMatch(/set:html=/);
      expect(src).not.toMatch(/from\s+['"]astro:content['"]/);
    }
  });
});
