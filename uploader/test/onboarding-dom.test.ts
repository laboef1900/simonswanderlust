import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { editorDocument, type EditorElement } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';

const sources = ['desk.js', 'admin-confirm.js', 'onboarding.js'].map((name) => readFileSync('public/' + name, 'utf8'));
type StepState = 'done' | 'todo' | 'in_progress' | 'attention';
type View = { status: 'retired' } | {
  status: 'open' | 'dismissed'; complete: boolean;
  steps: { id: string; state: StepState; required: boolean; href: string | null }[];
};
type Request = { url: string; method: string; body?: string; cache?: string };
function view(options: { status?: 'open' | 'dismissed'; photo?: StepState; story?: StepState; publish?: StepState } = {}): Exclude<View, { status: 'retired' }> {
  const photo = options.photo ?? 'todo';
  const story = options.story ?? 'todo';
  const publish = options.publish ?? 'todo';
  return {
    status: options.status ?? 'open', complete: [photo, story, publish].every((state) => state === 'done'),
    steps: [
      { id: 'account', state: 'done', required: false, href: null },
      { id: 'identity', state: 'todo', required: false, href: '/admin/settings.html#identity' },
      { id: 'photo', state: photo, required: true, href: '/admin/media.html' },
      { id: 'story', state: story, required: true, href: '/admin/editor.html' },
      { id: 'publish', state: publish, required: true, href: '/admin/posts.html' },
    ],
  };
}
const complete = () => view({ photo: 'done', story: 'done', publish: 'done' });
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

async function page(options: {
  isAdmin?: unknown;
  locale?: 'de' | 'en';
  initial?: View;
  route?: (request: Request, index: number) => Response | Promise<Response>;
} = {}) {
  const dom = editorDocument('<body><header><h1 id="desk">Desk</h1><div id="opener" hidden></div></header><main><section id="checklist" hidden></section><a id="ordinary" href="/admin/editor.html">New trip</a></main></body>');
  const document = Object.assign(dom.document, { documentElement: { lang: options.locale ?? 'en' } });
  const get = (selector: string): EditorElement => {
    const element = document.querySelector(selector);
    if (!element) throw new Error('Missing element: ' + selector);
    return element;
  };
  const requests: Request[] = [];
  const context: Record<string, unknown> = {
    document,
    EditorCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [locale,
      Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('editor.chrome.'))
        .map(([key, text]) => [key.slice('editor.chrome.'.length), text])),
    ])),
    fetch: async (url: string, init?: { method?: string; body?: string; cache?: string }) => {
      const request = { url, method: init?.method ?? 'GET', body: init?.body, cache: init?.cache };
      requests.push(request);
      return options.route?.(request, requests.length - 1) ?? Response.json(options.initial ?? view());
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const source of sources) vm.runInContext(source, context);
  const onboarding = context.Onboarding as {
    init(options: { root: EditorElement; openerRoot: EditorElement; isAdmin: unknown }): { ready: Promise<void>; reload(): Promise<void> };
  };
  const controller = onboarding.init({ root: get('#checklist'), openerRoot: get('#opener'),
    isAdmin: 'isAdmin' in options ? options.isAdmin : true });
  await controller.ready;
  const action = (name: string) => get('[data-onboarding-action="' + name + '"]');
  const click = async (name: string) => { const control = action(name); control.focus(); control.click(); await settle(); };
  const answer = async (yes: boolean) => {
    const dialog = get('#adminConfirm');
    Object.assign(dialog, { returnValue: yes ? 'ok' : 'cancel' });
    dialog.close();
    dom.flushDialogEvents();
    await settle();
  };
  return { document, get, action, click, answer, requests, controller, dom, root: get('#checklist'), opener: get('#opener') };
}

describe('Desk onboarding interactions', () => {
  it.each([false, undefined, null, {}, { isAdmin: true }, 'true'])('does not request or reveal onboarding without a resolved admin boolean: %s', async (isAdmin) => {
    const h = await page({ isAdmin });
    await h.controller.reload();
    expect(h.requests).toEqual([]);
    expect(h.root.hidden).toBe(true);
    expect(h.opener.hidden).toBe(true);
    expect(h.root.children).toHaveLength(0);
    expect(h.get('#ordinary').href).toBe('/admin/editor.html');
  });

  it('renders five real destinations with only three required steps and no automatic writes', async () => {
    const h = await page();
    expect(h.root.querySelectorAll('li')).toHaveLength(5);
    expect(h.root.querySelectorAll('a').map((link) => link.href)).toEqual([
      '/admin/settings.html#identity', '/admin/media.html', '/admin/editor.html', '/admin/posts.html',
    ]);
    expect(h.get('[role="status"]').textContent).toContain('0 of 3');
    expect(h.get('[data-step="account"]').querySelector('a')).toBeNull();
    expect(h.get('[data-step="identity"]').querySelector('.onboarding-optional')).not.toBeNull();
    expect(h.root.querySelector('[data-onboarding-action="finish"]')).toBeNull();
    expect(h.opener.hidden).toBe(true);
    expect(h.requests).toEqual([{ url: '/onboarding', method: 'GET', body: undefined, cache: 'no-store' }]);
  });

  it.each(['de', 'en'] as const)('renders live status and labelled native controls in %s', async (locale) => {
    const h = await page({ locale });
    expect(h.get('h2').textContent).toBe(ui[locale]['editor.chrome.onboardingTitle']);
    expect(h.get('[role="status"]').getAttribute('aria-live')).toBe('polite');
    expect(h.action('dismiss').type).toBe('button');
    expect(h.action('dismiss').textContent).toBe(ui[locale]['editor.chrome.onboardingHide']);
    expect(h.get('[data-step="photo"]').querySelector('[aria-hidden="true"]')?.querySelector('svg')).not.toBeNull();
  });

  it.each(['todo', 'in_progress', 'attention', 'done'] as const)('exposes photo state %s as text as well as an icon', async (photo) => {
    const h = await page({ initial: view({ photo }) });
    const row = h.get('[data-step="photo"]');
    expect(row.dataset.state).toBe(photo);
    expect(row.querySelector('.onboarding-step-status')?.textContent.length).toBeGreaterThan(0);
    expect(row.querySelector('svg')).not.toBeNull();
    expect(h.get('[role="status"]').textContent).toContain((photo === 'done' ? '1' : '0') + ' of 3');
  });

  it('hides for the installation and resumes only from the Desk header, restoring focus', async () => {
    const h = await page({ route: (request) => {
      const action = request.body ? JSON.parse(request.body).action : null;
      return Response.json(view({ status: action === 'dismiss' ? 'dismissed' : 'open' }));
    } });
    await h.click('dismiss');
    expect(h.root.hidden).toBe(true);
    expect(h.opener.hidden).toBe(false);
    expect(h.document.activeElement).toBe(h.action('resume'));
    await h.click('resume');
    expect(h.root.hidden).toBe(false);
    expect(h.opener.hidden).toBe(true);
    expect(h.document.activeElement).toBe(h.get('h2'));
    expect(h.requests.map((request) => request.body)).toEqual([undefined, '{"action":"dismiss"}', '{"action":"resume"}']);
    expect(h.requests.every((request) => request.url === '/onboarding')).toBe(true);
  });

  it('keeps a completed hidden checklist hidden on a later page load', async () => {
    const h = await page({ initial: { ...complete(), status: 'dismissed' } });
    expect(h.root.hidden).toBe(true);
    expect(h.opener.hidden).toBe(false);
    expect(h.root.querySelector('[data-onboarding-action="finish"]')).toBeNull();
    expect(h.requests).toHaveLength(1);
  });

  it('allows permanent Finish with optional identity undone, only after dialog confirmation', async () => {
    const h = await page({ route: (request) => Response.json(request.method === 'POST' ? { status: 'retired' } : complete()) });
    expect(h.get('[data-step="identity"]').dataset.state).toBe('todo');
    await h.click('finish');
    expect(h.get('#adminConfirm').open).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.get('#adminConfirmBody').textContent).toContain('all admins');
    expect(h.get('#adminConfirmBody').textContent).toContain('permanently');
    await h.answer(true);
    expect(h.requests[1]?.body).toBe('{"action":"finish"}');
    expect(h.root.hidden).toBe(true);
    expect(h.opener.hidden).toBe(true);
    expect(h.document.activeElement).toBe(h.get('#desk'));
  });

  it('cancels Finish with Escape without a POST and restores the Finish control', async () => {
    const h = await page({ initial: complete() });
    await h.click('finish');
    h.get('#adminConfirmOk').fire('keydown', { key: 'Escape' });
    h.dom.flushDialogEvents();
    await settle();
    expect(h.get('#adminConfirm').open).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(h.document.activeElement).toBe(h.action('finish'));
    expect(h.action('finish').disabled).toBe(false);
  });

  it('does not take focus on initial loading or reveal retired onboarding', async () => {
    const h = await page({ initial: { status: 'retired' } });
    expect(h.document.activeElement).toBeNull();
    expect(h.root.hidden).toBe(true);
    expect(h.opener.hidden).toBe(true);
    expect(h.root.querySelector('a')).toBeNull();
  });

  it('reflects required progress regression after an explicit GET refresh', async () => {
    const h = await page({ route: (_request, index) => Response.json(index === 0 ? complete() : view({ photo: 'attention', story: 'done' })) });
    expect(h.action('finish')).toBeDefined();
    await h.click('refresh');
    expect(h.get('[data-step="photo"]').dataset.state).toBe('attention');
    expect(h.root.querySelector('[data-onboarding-action="finish"]')).toBeNull();
    expect(h.get('[role="status"]').textContent).toContain('1 of 3');
    expect(h.document.activeElement).toBe(h.get('h2'));
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
  });

  it.each([401, 403, 500, 503])('shows unavailable and retries GET rather than treating HTTP %s as empty progress', async (status) => {
    const h = await page({ route: (_request, index) => index === 0 ? Response.json({}, { status }) : Response.json(view()) });
    expect(h.root.querySelector('li')).toBeNull();
    expect(h.opener.hidden).toBe(true);
    await h.click('retry');
    expect(h.root.querySelectorAll('li')).toHaveLength(5);
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
  });

  it.each(['network', 'invalid-json', 'incomplete', 'retired', 'read-only'])('reconciles uncertain %s actions with GET and never blindly replays', async (failure) => {
    const h = await page({ route: (request, index) => {
      if (request.method === 'POST') {
        if (failure === 'network') throw new TypeError('connection lost after commit');
        if (failure === 'invalid-json') return new Response('{');
        return Response.json({ error: 'onboarding_' + failure }, { status: failure === 'read-only' ? 503 : 409 });
      }
      return Response.json(index === 0 ? complete() : { status: 'retired' });
    } });
    await h.click('finish');
    await h.answer(true);
    expect(h.root.querySelector('li')).toBeNull();
    expect(h.get('[role="status"]').textContent).toBe(ui.en['editor.chrome.onboardingUncertain']);
    expect(h.document.activeElement).toBe(h.action('retry'));
    await h.click('retry');
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'POST', 'GET']);
    expect(h.root.hidden).toBe(true);
    expect(h.opener.hidden).toBe(true);
    expect(h.document.activeElement).toBe(h.get('#desk'));
  });

  it('coalesces repeated refreshes and prevents a mutation during the pending read', async () => {
    const pending = Promise.withResolvers<Response>();
    const h = await page({ route: (_request, index) => index === 0 ? Response.json(view()) : pending.promise });
    const staleDismiss = h.action('dismiss');
    await h.click('refresh');
    await h.controller.reload();
    staleDismiss.click();
    await settle();
    expect(h.requests).toHaveLength(2);
    expect(h.root.getAttribute('aria-busy')).toBe('true');
    pending.resolve(Response.json(view()));
    await settle();
    expect(h.root.getAttribute('aria-busy')).toBe('false');
  });

  it('prevents duplicate mutations while a request is unresolved', async () => {
    const pending = Promise.withResolvers<Response>();
    const h = await page({ route: (request) => request.method === 'GET' ? Response.json(view()) : pending.promise });
    const dismiss = h.action('dismiss');
    await h.click('dismiss');
    dismiss.click();
    await h.controller.reload();
    expect(h.requests).toHaveLength(2);
    expect(dismiss.disabled).toBe(true);
    pending.resolve(Response.json(view({ status: 'dismissed' })));
    await settle();
    expect(h.opener.hidden).toBe(false);
    expect(h.action('resume').disabled).toBe(false);
  });

  it.each([
    'javascript:alert(1)', '//attacker.example/admin/editor.html?tk=x',
    '/admin/editor.html?tk=x&next=https://attacker.example', '/admin/editor.html?tk=x#bad',
    '/admin/editor.html?tk=%', '/admin/editor.html?tk=', '/admin/editor.html?tk=x y',
    '/admin/settings.html#identity',
  ])('refuses an unsafe or wrong-flow story destination: %s', async (href) => {
    const initial = view();
    initial.steps[3]!.href = href;
    const h = await page({ initial });
    expect(h.root.querySelector('a')).toBeNull();
    expect(h.action('retry')).toBeDefined();
    expect(h.requests).toHaveLength(1);
  });

  it('preserves a server-encoded translation key as one safe query parameter', async () => {
    const initial = view({ story: 'done' });
    const key = 'a&next=//host/<img src=x># section';
    const href = '/admin/editor.html?tk=' + encodeURIComponent(key);
    initial.steps[3]!.href = href;
    initial.steps[4]!.href = href;
    const h = await page({ initial });
    expect(h.get('[data-step="story"]').querySelector('a')?.href).toBe(href);
    expect(h.root.querySelector('img')).toBeNull();
    expect(h.root.textContent).not.toContain(key);
  });

  it.each(['missing-step', 'duplicate-step', 'required-identity', 'false-complete', 'invalid-state', 'unsafe-identity', 'account-link'])('rejects malformed views instead of presenting false progress: %s', async (malformation) => {
    const initial = view();
    if (malformation === 'missing-step') initial.steps.pop();
    if (malformation === 'duplicate-step') initial.steps[2]!.id = 'identity';
    if (malformation === 'required-identity') initial.steps[1]!.required = true;
    if (malformation === 'false-complete') initial.complete = true;
    if (malformation === 'invalid-state') initial.steps[3]!.state = 'attention';
    if (malformation === 'unsafe-identity') initial.steps[1]!.href = 'https://evil.example';
    if (malformation === 'account-link') initial.steps[0]!.href = '/admin/users.html';
    const h = await page({ initial });
    expect(h.root.querySelector('li')).toBeNull();
    expect(h.opener.hidden).toBe(true);
    expect(h.action('retry')).toBeDefined();
  });
});

// Exercise the actual Desk markup, shared auth helper and shell, not a second
// onboarding-only context loader. The dynamic copy endpoint is injected as data.
async function deskPage(options: {
  isAdmin?: boolean;
  initial?: View;
  auth?: () => Promise<Response>;
  onboarding?: (request: Request) => Promise<Response>;
  posts?: () => Promise<Response>;
} = {}) {
  const html = readFileSync('public/index.html', 'utf8');
  const dom = editorDocument(html);
  const document = Object.assign(dom.document, { documentElement: { lang: 'en' }, title: 'Desk' });
  const location = { pathname: '/admin/', search: '?from=setup', href: '' };
  const requests: Request[] = [];
  const context: Record<string, unknown> = {
    document, location,
    EditorCopy: { en: Object.fromEntries(Object.entries(ui.en)
      .filter(([key]) => key.startsWith('editor.chrome.'))
      .map(([key, text]) => [key.slice('editor.chrome.'.length), text])) },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async (url: string, init?: { method?: string; body?: string; cache?: string }) => {
      const request = { url, method: init?.method ?? 'GET', body: init?.body, cache: init?.cache };
      requests.push(request);
      if (url === '/auth/me') return options.auth ? options.auth() : Response.json({
        authenticated: true, userId: 'user-1', username: 'writer', isAdmin: options.isAdmin ?? true, needsSetup: false,
      });
      if (url === '/onboarding') return options.onboarding ? options.onboarding(request) : Response.json(options.initial ?? view());
      if (url === '/posts') return options.posts ? options.posts() : Response.json([]);
      if (url === '/media/queue') return Response.json({ pending: 0, running: 0 });
      if (url === '/health') return Response.json({ release: false });
      throw new Error('Unexpected Desk request: ' + url);
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const script of html.matchAll(/<script(?:\s+src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
    if (script[1] === '/admin/editor-image-copy.js') continue;
    vm.runInContext(script[1] ? readFileSync('public/' + script[1].slice('/admin/'.length), 'utf8') : script[2]!, context);
  }
  await nextTurn();
  const get = (selector: string) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error('Missing Desk element: ' + selector);
    return node;
  };
  return { document, location, requests, get, flush: nextTurn };
}

describe('Actual Desk authenticated onboarding activation', () => {
  it('waits for the shared role context before loading data or exposing actions', async () => {
    const pending = Promise.withResolvers<Response>();
    const h = await deskPage({ auth: () => pending.promise });
    expect(h.requests.map((request) => request.url)).toEqual(['/auth/me']);
    expect(h.get('#onboardingChecklist').hidden).toBe(true);
    expect(h.get('#onboardingOpener').hidden).toBe(true);
    expect(h.document.querySelector('.cms-app-shell')).toBeNull();
    pending.resolve(Response.json({ authenticated: true, userId: 'admin-1', username: 'admin', isAdmin: true, needsSetup: false }));
    await h.flush();
    expect(h.get('#onboardingChecklist').querySelectorAll('li')).toHaveLength(5);
    expect(h.get('#onboardingChecklist').hidden).toBe(false);
    expect(h.get('#onboardingOpener').parentElement).toBe(h.get('.cms-topbar-right'));
    expect(h.requests.filter((request) => request.url === '/auth/me')).toHaveLength(1);
    expect(h.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(h.requests.some((request) => request.url === '/auth/status')).toBe(false);
    expect(h.get('#deskNext').querySelector('a')?.href).toBe('/admin/editor.html');
  });

  it('announces pending Desk loading politely and clears the same live region when data arrives', async () => {
    const pending = Promise.withResolvers<Response>();
    const h = await deskPage({ posts: () => pending.promise });
    const status = h.get('#deskStatus');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.hidden).toBe(false);
    expect(status.textContent.trim().length).toBeGreaterThan(0);
    expect(h.get('#deskError').hidden).toBe(true);
    pending.resolve(Response.json([]));
    await h.flush();
    expect(h.get('#deskStatus')).toBe(status);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
    expect(h.get('#deskNext').querySelector('a')?.href).toBe('/admin/editor.html');
  });

  it('keeps authors on the ordinary empty Desk without admin requests or instructions', async () => {
    const h = await deskPage({ isAdmin: false });
    expect(h.get('#onboardingChecklist').hidden).toBe(true);
    expect(h.get('#onboardingOpener').hidden).toBe(true);
    expect(h.requests.map((request) => request.url).sort()).toEqual(['/auth/me', '/health', '/media/queue', '/posts']);
    expect(h.get('#deskNext').querySelector('a')?.href).toBe('/admin/editor.html');
    expect(h.get('#deskRelease').textContent).toBe(ui.en['editor.chrome.deskNoReleaseAuthor']);
    expect(h.document.querySelector('a[href="/admin/settings.html"]')).toBeNull();
    expect(h.location.href).toBe('');
  });

  it.each(['dismissed', 'retired'] as const)('respects shared %s state after the actual shell relocates the opener', async (status) => {
    const h = await deskPage({ initial: status === 'retired' ? { status } : view({ status }) });
    expect(h.get('#onboardingChecklist').hidden).toBe(true);
    expect(h.get('#onboardingOpener').hidden).toBe(status === 'retired');
    expect(h.get('#onboardingOpener').parentElement).toBe(h.get('.cms-topbar-right'));
    expect(h.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('uses the actual relocated opener to resume and hide install-wide state', async () => {
    const h = await deskPage({ onboarding: async (request) => {
      const action = request.body ? JSON.parse(request.body).action : null;
      return Response.json(view({ status: action === 'resume' ? 'open' : 'dismissed' }));
    } });
    h.get('[data-onboarding-action="resume"]').click();
    await h.flush();
    expect(h.get('#onboardingChecklist').hidden).toBe(false);
    h.get('[data-onboarding-action="dismiss"]').click();
    await h.flush();
    expect(h.get('#onboardingChecklist').hidden).toBe(true);
    expect(h.get('#onboardingOpener').hidden).toBe(false);
    expect(h.requests.filter((request) => request.method === 'POST').map((request) => [request.url, request.body]))
      .toEqual([['/onboarding', '{"action":"resume"}'], ['/onboarding', '{"action":"dismiss"}']]);
  });

  it.each(['network', 'server'] as const)('keeps %s auth failures distinct from logout and allows a safe read retry', async (failure) => {
    let attempts = 0;
    const h = await deskPage({ auth: async () => {
      if (attempts++ === 0) {
        if (failure === 'network') throw new TypeError('network unavailable');
        return Response.json({ error: 'internal server error' }, { status: 500 });
      }
      return Response.json({ authenticated: true, userId: 'admin-1', username: 'admin', isAdmin: true, needsSetup: false });
    } });
    expect(h.location.href).toBe('');
    expect(h.requests.map((request) => request.url)).toEqual(['/auth/me']);
    expect(h.get('#deskError').hidden).toBe(false);
    expect(h.get('#deskError').getAttribute('role')).toBe('alert');
    expect(h.get('#deskError').textContent).toContain(ui.en['editor.chrome.authContextUnavailable']);
    expect(h.get('#deskError').querySelector('button')?.textContent).toBe(ui.en['editor.chrome.authContextRetry']);
    expect(h.get('#onboardingChecklist').hidden).toBe(true);
    h.get('#deskError').querySelector('button')!.click();
    await h.flush();
    expect(h.get('#deskError').hidden).toBe(true);
    expect(h.get('#deskError').getAttribute('role')).toBe('alert');
    expect(h.get('#deskError').textContent).toBe('');
    expect(h.get('#onboardingChecklist').querySelectorAll('li')).toHaveLength(5);
    expect(h.requests.filter((request) => request.url === '/auth/me')).toHaveLength(2);
    expect(h.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(h.location.href).toBe('');
  });

  it('redirects an expired session without loading onboarding or ordinary protected data', async () => {
    const h = await deskPage({ auth: async () => Response.json({ error: 'unauthorized' }, { status: 401 }) });
    expect(h.location.href).toBe('/login?next=' + encodeURIComponent('/admin/?from=setup'));
    expect(h.requests.map((request) => request.url)).toEqual(['/auth/me']);
    expect(h.get('#onboardingChecklist').hidden).toBe(true);
    expect(h.get('#deskError').hidden).toBe(true);
  });
});
