/**
 * Reader-comments island (SPEC-UI-001; docs/superpowers/specs/2026-09-14-comments-design.md).
 *
 * @ai-warning Comment fields are reader-authored. They reach the DOM ONLY via
 * `textContent` / text nodes — never any HTML-parsing sink (the invariant test
 * in comments.test.ts scans this file for them). Line breaks become paragraphs
 * by splitting text (decision 4). The endpoint is the relative `/comments`
 * path (same origin, no third party, no absolute host baked into static HTML).
 *
 * Wire contract (issue #206 / #208): `GET /comments?tk=` → `{ enabled, comments }`;
 * `POST /comments` JSON `{ translationKey, postedLocale, authorName, body, website }`
 * → 201 pending (never optimistic-appended), 409 closed, 429 rate limited,
 * 403 unavailable (Origin check), 400 invalid.
 */

export interface CommentLabels {
  heading: string;
  empty: string;
  closed: string;
  unavailable: string;
  nameLabel: string;
  bodyLabel: string;
  submit: string;
  submitting: string;
  submitted: string;
  invalid: string;
  rateLimited: string;
  authorBadge: string;
  privacy: string;
  /** Contains `{n}`. */
  count: string;
}

export interface PublicComment {
  authorName: string;
  body: string;
  createdAt: string;
  isAuthor: boolean;
  postedLocale: string;
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
    const authorName = typeof r.authorName === 'string' ? r.authorName : r.name;
    if (typeof authorName !== 'string' || typeof r.body !== 'string') continue;
    comments.push({
      authorName,
      body: r.body,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      isAuthor: r.isAuthor === true,
      postedLocale: typeof r.postedLocale === 'string' ? r.postedLocale : '',
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

/** Paints comments (oldest first, as served) into `list` using text nodes only. */
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
  const count = doc.createElement('p');
  count.className = 'comments__count';
  count.textContent = labels.count.replace('{n}', String(comments.length));
  list.append(count);

  const ol = doc.createElement('ol');
  ol.className = 'comments__list';
  for (const c of comments) {
    const li = doc.createElement('li');
    li.className = 'comments__item';
    if (c.isAuthor) li.classList.add('comments__item--author');
    const meta = doc.createElement('p');
    meta.className = 'comments__meta';
    const who = doc.createElement('span');
    who.className = 'comments__name';
    who.textContent = c.authorName;
    meta.append(who);
    if (c.isAuthor) {
      // Text label, not colour alone (WCAG 1.4.1).
      const badge = doc.createElement('span');
      badge.className = 'comments__badge';
      badge.textContent = labels.authorBadge;
      meta.append(doc.createTextNode(' '), badge);
    }
    const date = formatDate(c.createdAt, locale);
    if (date) {
      const time = doc.createElement('time');
      time.dateTime = c.createdAt;
      time.textContent = date;
      meta.append(doc.createTextNode(' · '), time);
    }
    li.append(meta);
    const bodyEl = doc.createElement('div');
    bodyEl.className = 'comments__body';
    // Shared thread: a comment posted under the other locale stays visible,
    // only its language is marked for assistive tech.
    if (c.postedLocale) bodyEl.setAttribute('lang', c.postedLocale);
    for (const para of c.body.split(/\r?\n\s*\r?\n|\r?\n/)) {
      if (!para.trim()) continue;
      const p = doc.createElement('p');
      p.textContent = para;
      bodyEl.append(p);
    }
    li.append(bodyEl);
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

function setStatus(status: HTMLElement | null, text: string): void {
  if (status) status.textContent = text;
}

function paintNotice(list: HTMLElement, className: string, text: string): void {
  list.replaceChildren();
  const p = list.ownerDocument.createElement('p');
  p.className = className;
  p.textContent = text;
  list.append(p);
}

/** Maps a POST response status to the reader-facing string (item 11). */
export function submitOutcome(status: number, labels: CommentLabels): string {
  switch (status) {
    case 201:
      return labels.submitted;
    case 409:
      return labels.closed;
    case 429:
      return labels.rateLimited;
    case 400:
      return labels.invalid;
    case 403:
    default:
      return labels.unavailable;
  }
}

/** Loads and paints comments; wires the form. Resolves when the first paint is done. */
export async function initComments(root: HTMLElement, opts: CommentsOptions): Promise<void> {
  const list = root.querySelector<HTMLElement>('[data-comments-list]');
  const form = root.querySelector<HTMLFormElement>('[data-comments-form]');
  const status = root.querySelector<HTMLElement>('[data-comments-status]');
  const closed = root.querySelector<HTMLElement>('[data-comments-closed]');
  if (!list) return;
  const doFetch = opts.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ tk: opts.translationKey });

  let payload: CommentsPayload | null = null;
  try {
    const res = await doFetch(`/comments?${qs.toString()}`, { headers: { accept: 'application/json' } });
    if (res.ok) payload = parsePayload(await res.json());
  } catch {
    payload = null;
  }

  if (!payload) {
    // The article above is static and unaffected; only the island degrades.
    paintNotice(list, 'comments__unavailable', opts.labels.unavailable);
    if (form) form.hidden = true;
    return;
  }

  paintComments(list, payload.comments, opts.labels, opts.locale);
  if (!form) return;
  form.hidden = !payload.enabled;
  if (!payload.enabled) {
    if (closed) {
      closed.textContent = opts.labels.closed;
      closed.hidden = false;
    }
    return;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const data = new FormData(form);
    const body = {
      translationKey: opts.translationKey,
      postedLocale: opts.locale,
      authorName: String(data.get('authorName') ?? ''),
      body: String(data.get('body') ?? ''),
      website: String(data.get('website') ?? ''),
    };
    if (button) button.disabled = true;
    setStatus(status, opts.labels.submitting);
    doFetch('/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => {
        setStatus(status, submitOutcome(res.status, opts.labels));
        if (res.status === 201) form.reset();
        if (res.status === 409) {
          form.hidden = true;
          if (closed) {
            closed.textContent = opts.labels.closed;
            closed.hidden = false;
          }
        }
      })
      .catch(() => {
        setStatus(status, opts.labels.unavailable);
      })
      .finally(() => {
        // #139: re-enable on every outcome.
        if (button) button.disabled = false;
      });
  });
}
