/**
 * Reader-comments island (SPEC-UI-001; docs/superpowers/specs/2026-09-14-comments-design.md).
 *
 * @ai-warning Comment fields are reader-authored. They reach the DOM ONLY via
 * `textContent` / text nodes — never any HTML-parsing sink (the
 * invariant test in comments.test.ts scans this file for them). Line breaks become paragraphs by splitting text (decision 4).
 * The endpoint is the relative `/comments` path (same origin, no third party).
 */

export interface CommentLabels {
  heading: string;
  empty: string;
  unavailable: string;
  moderated: string;
  name: string;
  email: string;
  body: string;
  submit: string;
  sending: string;
  thanks: string;
  error: string;
  by: string;
}

export interface PublicComment {
  name: string;
  body: string;
  createdAt: string;
}

export interface CommentsPayload {
  enabled: boolean;
  comments: PublicComment[];
}

/** Validates an untrusted JSON payload into the shape the painter accepts. */
export function parsePayload(raw: unknown): CommentsPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.comments)) return null;
  const comments: PublicComment[] = [];
  for (const c of obj.comments) {
    if (typeof c !== 'object' || c === null) continue;
    const r = c as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.body !== 'string') continue;
    comments.push({
      name: r.name,
      body: r.body,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    });
  }
  return { enabled: obj.enabled === true, comments };
}

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale === 'en' ? 'en-GB' : 'de-DE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Paints comments into `list` using text nodes only. */
export function paintComments(
  list: HTMLElement,
  comments: readonly PublicComment[],
  labels: CommentLabels,
  locale: string,
): void {
  const doc = list.ownerDocument;
  list.replaceChildren();
  if (comments.length === 0) {
    const p = doc.createElement('p');
    p.className = 'comments__empty';
    p.textContent = labels.empty;
    list.append(p);
    return;
  }
  const ol = doc.createElement('ol');
  ol.className = 'comments__list';
  for (const c of comments) {
    const li = doc.createElement('li');
    li.className = 'comments__item';
    const meta = doc.createElement('p');
    meta.className = 'comments__meta';
    const who = doc.createElement('span');
    who.className = 'comments__name';
    who.textContent = c.name;
    meta.append(doc.createTextNode(`${labels.by} `), who);
    const date = formatDate(c.createdAt, locale);
    if (date) {
      const time = doc.createElement('time');
      time.dateTime = c.createdAt;
      time.textContent = date;
      meta.append(doc.createTextNode(' · '), time);
    }
    li.append(meta);
    for (const para of c.body.split(/\r?\n\s*\r?\n|\r?\n/)) {
      if (!para.trim()) continue;
      const p = doc.createElement('p');
      p.textContent = para;
      li.append(p);
    }
    ol.append(li);
  }
  list.append(ol);
}

export interface CommentsOptions {
  translationKey: string;
  locale: string;
  labels: CommentLabels;
  fetchImpl?: typeof fetch;
}

/** Loads and paints comments; wires the form. Resolves when the first paint is done. */
export async function initComments(root: HTMLElement, opts: CommentsOptions): Promise<void> {
  const list = root.querySelector<HTMLElement>('[data-comments-list]');
  const form = root.querySelector<HTMLFormElement>('[data-comments-form]');
  const status = root.querySelector<HTMLElement>('[data-comments-status]');
  if (!list) return;
  const doFetch = opts.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ translationKey: opts.translationKey, locale: opts.locale });

  let payload: CommentsPayload | null = null;
  try {
    const res = await doFetch(`/comments?${qs.toString()}`, { headers: { accept: 'application/json' } });
    if (res.ok) payload = parsePayload(await res.json());
  } catch {
    payload = null;
  }

  if (!payload) {
    list.replaceChildren();
    const p = list.ownerDocument.createElement('p');
    p.className = 'comments__unavailable';
    p.textContent = opts.labels.unavailable;
    list.append(p);
    if (form) form.hidden = true;
    return;
  }

  paintComments(list, payload.comments, opts.labels, opts.locale);
  if (!form) return;
  form.hidden = !payload.enabled;
  if (!payload.enabled) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = {
      translationKey: opts.translationKey,
      locale: opts.locale,
      name: String(data.get('name') ?? ''),
      email: String(data.get('email') ?? ''),
      body: String(data.get('body') ?? ''),
      website: String(data.get('website') ?? ''),
      token: String(data.get('token') ?? ''),
    };
    if (status) status.textContent = opts.labels.sending;
    doFetch('/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (status) status.textContent = res.status === 202 ? opts.labels.thanks : opts.labels.error;
        if (res.status === 202) form.reset();
      })
      .catch(() => {
        if (status) status.textContent = opts.labels.error;
      });
  });
}
