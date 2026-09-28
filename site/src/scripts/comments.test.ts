// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initComments, paintComments, parsePayload, submitOutcome, type CommentLabels } from './comments';
import { locales, ui } from '../i18n/ui';

const labels: CommentLabels = {
  heading: 'Comments',
  empty: 'No comments yet.',
  closed: 'Comments are closed.',
  unavailable: 'Comments are unavailable right now.',
  nameLabel: 'Name',
  bodyLabel: 'Comment',
  submit: 'Send',
  submitting: 'Sending',
  submitted: 'Thanks, pending review',
  invalid: 'Invalid',
  rateLimited: 'Slow down',
  authorBadge: 'Author',
  privacy: 'Privacy',
  count: '{n} comments',
};

const comment = (over: Partial<Parameters<typeof paintComments>[1][number]> = {}) => ({
  authorName: 'Ann',
  body: 'Hi',
  createdAt: '',
  isAuthor: false,
  postedLocale: 'en',
  ...over,
});

function mount(): HTMLElement {
  document.body.innerHTML = `
    <section data-comments-root>
      <div data-comments-list></div>
      <p data-comments-closed hidden></p>
      <form data-comments-form hidden>
        <input name="authorName" value="Ann" />
        <textarea name="body"></textarea>
        <input name="website" value="" />
        <button type="submit">Send</button>
        <p data-comments-status></p>
      </form>
    </section>`;
  return document.querySelector('[data-comments-root]') as HTMLElement;
}

const jsonFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, status: ok ? 200 : 500, json: async () => payload }) as Response) as typeof fetch;

interface Recorded {
  url: string;
  init?: RequestInit;
}

/** GET answers `getPayload`; POST answers `postStatus` and records the request. */
function fetchPair(getPayload: unknown, postStatus: number | 'network', calls: Recorded[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === 'POST') {
      if (postStatus === 'network') throw new Error('offline');
      return { ok: postStatus < 300, status: postStatus, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => getPayload } as Response;
  }) as unknown as typeof fetch;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('paintComments', () => {
  it('keeps script and img onerror payloads as text', () => {
    const list = document.createElement('div');
    document.body.append(list);
    const name = '<img src=x onerror="window.__pwned=1">';
    const body = '<script>window.__pwned=1</script>';
    paintComments(list, [comment({ authorName: name, body, createdAt: '2026-09-01T10:00:00Z' })], labels, 'en');
    expect(list.querySelector('script')).toBeNull();
    expect(list.querySelector('img')).toBeNull();
    expect(list.querySelector('.comments__name')?.textContent).toBe(name);
    expect(list.textContent).toContain(body);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('splits line breaks into paragraphs by text', () => {
    const list = document.createElement('div');
    paintComments(list, [comment({ body: 'one\n\ntwo' })], labels, 'de');
    const paras = [...list.querySelectorAll('.comments__body > p')].map((p) => p.textContent);
    expect(paras).toEqual(['one', 'two']);
  });

  it('shows the empty message for no comments', () => {
    const list = document.createElement('div');
    paintComments(list, [], labels, 'en');
    expect(list.textContent).toBe('No comments yet.');
  });

  it('isAuthor adds the text badge; readers get none', () => {
    const list = document.createElement('div');
    paintComments(list, [comment(), comment({ authorName: 'Simon', isAuthor: true })], labels, 'en');
    const items = list.querySelectorAll('.comments__item');
    expect(items[0]?.querySelector('.comments__badge')).toBeNull();
    expect(items[1]?.querySelector('.comments__badge')?.textContent).toBe('Author');
    expect(items[1]?.classList.contains('comments__item--author')).toBe(true);
  });

  it('keeps other-locale comments visible and marks their lang', () => {
    const list = document.createElement('div');
    paintComments(list, [comment({ postedLocale: 'de' }), comment({ postedLocale: 'en' })], labels, 'en');
    const langs = [...list.querySelectorAll('.comments__body')].map((el) => el.getAttribute('lang'));
    expect(langs).toEqual(['de', 'en']);
  });

  it('renders the count with {n} substituted, in served (oldest-first) order', () => {
    const list = document.createElement('div');
    paintComments(list, [comment({ authorName: 'first' }), comment({ authorName: 'second' })], labels, 'en');
    expect(list.querySelector('.comments__count')?.textContent).toBe('2 comments');
    expect([...list.querySelectorAll('.comments__name')].map((n) => n.textContent)).toEqual(['first', 'second']);
  });
});

describe('initComments load', () => {
  it('fetches the relative /comments URL with tk', async () => {
    const root = mount();
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ enabled: true, comments: [] }) } as Response;
    }) as unknown as typeof fetch;
    await initComments(root, { translationKey: 'my key', locale: 'en', labels, fetchImpl: f });
    expect(url).toBe('/comments?tk=my+key');
  });

  it('enabled false hides form and keeps list', async () => {
    const root = mount();
    const payload = { enabled: false, comments: [comment()] };
    await initComments(root, { translationKey: 'tk', locale: 'en', labels, fetchImpl: jsonFetch(payload) });
    expect(root.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    expect(root.querySelector('.comments__name')?.textContent).toBe('Ann');
    const closed = root.querySelector<HTMLElement>('[data-comments-closed]')!;
    expect(closed.hidden).toBe(false);
    expect(closed.textContent).toBe(labels.closed);
  });

  it('enabled true reveals the form and shows the empty message', async () => {
    const root = mount();
    await initComments(root, {
      translationKey: 'tk',
      locale: 'en',
      labels,
      fetchImpl: jsonFetch({ enabled: true, comments: [] }),
    });
    expect(root.querySelector<HTMLFormElement>('form')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-comments-closed]')!.hidden).toBe(true);
    expect(root.querySelector('[data-comments-list]')?.textContent).toBe(labels.empty);
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

  it('parsePayload drops malformed entries and reads isAuthor/postedLocale', () => {
    expect(parsePayload(null)).toBeNull();
    const parsed = parsePayload({
      enabled: true,
      comments: [{ authorName: 1 }, { authorName: 'a', body: 'b', isAuthor: true, postedLocale: 'de' }],
    });
    expect(parsed?.comments).toEqual([{ authorName: 'a', body: 'b', createdAt: '', isAuthor: true, postedLocale: 'de' }]);
  });
});

describe('initComments submit', () => {
  async function submit(postStatus: number | 'network') {
    const root = mount();
    const calls: Recorded[] = [];
    await initComments(root, {
      translationKey: 'tk',
      locale: 'de',
      labels,
      fetchImpl: fetchPair({ enabled: true, comments: [] }, postStatus, calls),
    });
    const form = root.querySelector<HTMLFormElement>('form')!;
    const button = form.querySelector<HTMLButtonElement>('button')!;
    form.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Hello';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(button.disabled).toBe(true);
    await flush();
    const status = root.querySelector('[data-comments-status]')!.textContent;
    return { root, form, button, calls, status };
  }

  it('posts the #206 JSON body with no email and no token', async () => {
    const { calls } = await submit(201);
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toBe('/comments');
    expect(JSON.parse(String(post.init?.body))).toEqual({
      translationKey: 'tk',
      postedLocale: 'de',
      authorName: 'Ann',
      body: 'Hello',
      website: '',
    });
  });

  it('201 clears the form, shows submitted, does not optimistic-append', async () => {
    const { root, form, button, status } = await submit(201);
    expect(status).toBe(labels.submitted);
    expect(form.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
    expect(root.querySelector('.comments__item')).toBeNull();
    expect(button.disabled).toBe(false);
  });

  it.each([
    [409, labels.closed],
    [429, labels.rateLimited],
    [403, labels.unavailable],
    [400, labels.invalid],
    [500, labels.unavailable],
  ])('%d maps to its message and re-enables the button', async (code, expected) => {
    const { form, button, status } = await submit(code);
    expect(status).toBe(expected);
    expect(button.disabled).toBe(false);
    expect(form.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Hello');
  });

  it('409 also hides the form and shows closed', async () => {
    const { root, form } = await submit(409);
    expect(form.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-comments-closed]')!.hidden).toBe(false);
  });

  it('network failure shows unavailable and re-enables the button', async () => {
    const { button, status } = await submit('network');
    expect(status).toBe(labels.unavailable);
    expect(button.disabled).toBe(false);
  });

  it('submitOutcome covers every mapped status', () => {
    expect(submitOutcome(201, labels)).toBe(labels.submitted);
    expect(submitOutcome(409, labels)).toBe(labels.closed);
    expect(submitOutcome(429, labels)).toBe(labels.rateLimited);
    expect(submitOutcome(403, labels)).toBe(labels.unavailable);
    expect(submitOutcome(400, labels)).toBe(labels.invalid);
  });
});

describe('comments i18n and invariants', () => {
  const REQUIRED = [
    'comments.heading',
    'comments.empty',
    'comments.closed',
    'comments.unavailable',
    'comments.noscript',
    'comments.nameLabel',
    'comments.bodyLabel',
    'comments.submit',
    'comments.submitting',
    'comments.submitted',
    'comments.invalid',
    'comments.rateLimited',
    'comments.authorBadge',
    'comments.privacy',
    'comments.count',
  ].sort();

  it('defines exactly the mandated comments.* key set, non-empty, in de and en', () => {
    for (const locale of locales) {
      const keys = Object.keys(ui[locale]).filter((k) => k.startsWith('comments.')).sort();
      expect(keys, locale).toEqual(REQUIRED);
      for (const k of keys) expect(ui[locale][k as keyof typeof ui.de], `${locale}.${k}`).not.toBe('');
      expect(ui[locale]['comments.count']).toContain('{n}');
    }
    expect(ui.en['comments.privacy']).toMatch(/no email/i);
  });

  it('never uses innerHTML, set:html or astro:content for comments; no email field', () => {
    // happy-dom rewrites import.meta.url, so resolve from the site root (vitest cwd).
    const script = readFileSync(resolve(process.cwd(), 'src/scripts/comments.ts'), 'utf8');
    const island = readFileSync(resolve(process.cwd(), 'src/components/CommentsIsland.astro'), 'utf8');
    for (const src of [script, island]) {
      expect(src).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
      expect(src).not.toMatch(/set:html=/);
      expect(src).not.toMatch(/from\s+['"]astro:content['"]/);
      expect(src).not.toMatch(/PUBLIC_BASE_URL/);
    }
    expect(island).not.toMatch(/type="email"|name="email"/);
    expect(island).toMatch(/data-comments-url="\/comments"/);
    expect(island).toMatch(/<noscript>/);
    expect(island).toMatch(/for="comments-author-name"/);
    expect(island).toMatch(/aria-hidden="true"/);
    expect(island).not.toMatch(/class="hidden"/);
  });
});
