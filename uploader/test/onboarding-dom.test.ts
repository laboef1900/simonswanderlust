import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { editorDocument, type EditorElement } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';
import type { OnboardingLanguage } from '../src/onboarding.js';

// The Desk loads build-reporting.js before onboarding.js; failed-build wording comes from it.
const sources = ['build-reporting.js', 'desk.js', 'language.js', 'admin-confirm.js', 'onboarding.js'].map((name) => readFileSync('public/' + name, 'utf8'));
type StepState = 'done' | 'todo' | 'in_progress' | 'attention';
type View = { status: 'retired' } | {
  status: 'open' | 'dismissed'; complete: boolean;
  language: OnboardingLanguage;
  steps: { id: string; state: StepState; required: boolean; href: string | null }[];
};
type Request = { url: string; method: string; body?: string; cache?: string };
function view(options: { status?: 'open' | 'dismissed'; photo?: StepState; story?: StepState; publish?: StepState } = {}): Exclude<View, { status: 'retired' }> {
  const photo = options.photo ?? 'todo';
  const story = options.story ?? 'todo';
  const publish = options.publish ?? 'todo';
  return {
    status: options.status ?? 'open', complete: [photo, story, publish].every((state) => state === 'done'),
    language: { primary: 'de', locales: ['de', 'en'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z' },
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
    BuildCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [locale,
      Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('admin.build.'))
        .map(([key, text]) => [key.slice('admin.build.'.length), text])),
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
    expect(h.root.querySelectorAll('[data-step]')).toHaveLength(5);
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
    expect(h.root.querySelectorAll('[data-step]')).toHaveLength(5);
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
  language?: () => Promise<Response>;
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
    // The dynamic copy endpoint also serves build-status copy (#297).
    BuildCopy: { en: Object.fromEntries(Object.entries(ui.en)
      .filter(([key]) => key.startsWith('admin.build.'))
      .map(([key, text]) => [key.slice('admin.build.'.length), text])) },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async (url: string, init?: { method?: string; body?: string; cache?: string }) => {
      const request = { url, method: init?.method ?? 'GET', body: init?.body, cache: init?.cache };
      requests.push(request);
      if (url === '/auth/me') return options.auth ? options.auth() : Response.json({
        authenticated: true, userId: 'user-1', username: 'writer', isAdmin: options.isAdmin ?? true, needsSetup: false,
      });
      if (url === '/language') return options.language ? options.language() : Response.json({
        primary: 'de', locales: ['de', 'en'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z',
      });
      if (url === '/onboarding') return options.onboarding ? options.onboarding(request) : Response.json(options.initial ?? view());
      if (url === '/posts') return options.posts ? options.posts() : Response.json([]);
      if (url === '/media/queue') return Response.json({ pending: 0, running: 0 });
      if (url === '/health') return Response.json({ release: false });
      // The Desk reads the language mode (#284) and, for admins, build status (#297).
      if (url === '/language') return Response.json({ primary: 'de', locales: ['de', 'en'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z' });
      if (url === '/rebuild/status') return Response.json({ live: null, running: null, last: null, record: 'missing' });
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
  it('waits for language context before exposing the Desk or onboarding', async () => {
    const pending = Promise.withResolvers<Response>();
    const h = await deskPage({ language: () => pending.promise });
    expect(h.requests.map((request) => request.url)).toEqual(['/auth/me', '/language']);
    expect(h.get('#onboardingChecklist').hidden).toBe(true);
    expect(h.document.querySelector('.cms-app-shell')).toBeNull();
    pending.resolve(Response.json({ primary: 'en', locales: ['en'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z' }));
    await h.flush();
    expect(h.get('#onboardingChecklist').hidden).toBe(false);
    expect(h.get('#deskNext').querySelector('a')?.href).toBe('/admin/editor.html');
    expect(h.get('#deskNext').textContent).toContain(ui.en['editor.chrome.deskNoDrafts']);
    expect(h.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('does not turn unavailable language context into logout or a default-language Desk', async () => {
    let attempts = 0;
    const h = await deskPage({ language: async () => {
      if (attempts++ === 0) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ primary: 'en', locales: ['en'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z' });
    } });
    expect(h.location.href).toBe('');
    expect(h.requests.map((request) => request.url)).toEqual(['/auth/me', '/language']);
    expect(h.get('#onboardingChecklist').hidden).toBe(true);
    expect(h.get('#deskError').hidden).toBe(false);
    h.get('#deskError').querySelector('button')!.click();
    await h.flush();
    expect(h.get('#deskError').hidden).toBe(true);
    expect(h.get('#deskNext').querySelector('a')?.href).toBe('/admin/editor.html');
    expect(h.requests.filter((request) => request.url === '/language')).toHaveLength(2);
    expect(h.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('waits for the shared role context before loading data or exposing actions', async () => {
    const pending = Promise.withResolvers<Response>();
    const h = await deskPage({ auth: () => pending.promise });
    expect(h.requests.map((request) => request.url)).toEqual(['/auth/me']);
    expect(h.get('#onboardingChecklist').hidden).toBe(true);
    expect(h.get('#onboardingOpener').hidden).toBe(true);
    expect(h.document.querySelector('.cms-app-shell')).toBeNull();
    pending.resolve(Response.json({ authenticated: true, userId: 'admin-1', username: 'admin', isAdmin: true, needsSetup: false }));
    await h.flush();
    expect(h.get('#onboardingChecklist').querySelectorAll('[data-step]')).toHaveLength(5);
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
    expect(h.requests.map((request) => request.url).sort()).toEqual(['/auth/me', '/health', '/language', '/media/queue', '/posts']);
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
    expect(h.get('#onboardingChecklist').querySelectorAll('[data-step]')).toHaveLength(5);
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

describe('Optional Desk language configuration', () => {
  const modes: OnboardingLanguage[] = [
    { primary: 'de', locales: ['de'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z' },
    { primary: 'en', locales: ['en'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z' },
    { primary: 'de', locales: ['de', 'en'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z' },
    { primary: 'en', locales: ['en', 'de'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z' },
  ];
  function select(h: { root: EditorElement }, index: number) {
    const radios = h.root.querySelectorAll('input[type="radio"]');
    radios.forEach((radio, position) => { radio.checked = position === index; });
    radios[index]!.focus();
    radios[index]!.fire('change');
  }
  function selected(h: { root: EditorElement }) {
    return h.root.querySelectorAll('input[type="radio"]').findIndex((radio) => radio.checked);
  }

  it.each(['de', 'en'] as const)('inserts an optional native group after Account, with associated descriptions in %s', async (locale) => {
    const h = await page({ locale });
    const rows = h.get('.onboarding-steps').children;
    expect(rows.map((row) => row.dataset.step ?? 'language')).toEqual(['account', 'language', 'identity', 'photo', 'story', 'publish']);
    expect(rows[1]!.getAttribute('data-state')).toBeNull();
    expect(rows[1]!.querySelector('.onboarding-icon')).toBeNull();
    expect(rows[1]!.querySelector('legend')?.textContent).not.toBe('');
    const radios = h.root.querySelectorAll('input[type="radio"]');
    expect(radios).toHaveLength(4);
    expect(new Set(radios.map((radio) => radio.getAttribute('name')))).toEqual(new Set(['onboarding-language']));
    for (const radio of radios) {
      expect(radio.parentElement?.tagName.toLowerCase()).toBe('label');
      expect(h.get('#' + radio.getAttribute('aria-describedby')).textContent).not.toBe('');
    }
    expect(selected(h)).toBe(2);
    select(h, 1);
    expect(h.requests).toHaveLength(1);
    expect(h.root.querySelector('[data-onboarding-action="finish"]')).toBeNull();
    await h.click('language-save');
    expect(h.requests).toHaveLength(1);
    expect(h.get('#adminConfirmBody').textContent).toContain('/');
    await h.answer(false);
    expect(h.requests).toHaveLength(1);
    expect(selected(h)).toBe(1);
    expect(h.document.activeElement).toBe(h.action('language-save'));
  });

  it.each(modes.map((mode, index) => ({ mode, index })))('submits only the confirmed $mode.primary / $mode.locales configuration and rereads progress', async ({ mode, index }) => {
    let stored = modes[(index + 1) % modes.length]!;
    const h = await page({ route: (request) => {
      if (request.method === 'PUT') {
        stored = { ...mode, updatedAt: '2026-10-29T00:00:00.000Z' };
        // A committed change answers with its build attempt beside the configuration (#297).
        return Response.json({ ...stored, build: { ok: true, attemptId: 'r1', release: 'r1' } });
      }
      return Response.json({ ...view(), language: stored });
    } });
    select(h, index);
    await h.click('language-save');
    expect(h.root.querySelector('fieldset')?.disabled).toBe(true);
    const expectedPaths = mode.locales.map((locale) => locale === mode.primary ? '/' : `/${locale}/`);
    expect(new Set(h.get('#adminConfirmBody').textContent.match(/\/(?:de\/|en\/)?/g))).toEqual(new Set(expectedPaths));
    const selectedRadio = h.root.querySelectorAll('input[type="radio"]')[index]!;
    const description = h.get('#' + selectedRadio.getAttribute('aria-describedby'));
    expect(new Set(description.textContent.match(/\/(?:de\/|en\/)?/g))).toEqual(new Set(expectedPaths));
    await h.answer(true);
    expect(h.requests.map((request) => [request.url, request.method])).toEqual([
      ['/onboarding', 'GET'], ['/language', 'PUT'], ['/onboarding', 'GET'],
    ]);
    expect(JSON.parse(h.requests[1]!.body!)).toEqual({ primary: mode.primary, locales: mode.locales });
    expect(selected(h)).toBe(index);
    expect(h.document.activeElement).toBe(h.action('language-save'));
    expect(h.root.querySelectorAll('[data-step]')).toHaveLength(5);
    expect(h.root.querySelector('[data-onboarding-action="finish"]')).toBeNull();
    expect(h.get('.onboarding-language-status').textContent).toBe(ui.en['editor.chrome.onboardingLanguageSaved']);
  });

  it('acknowledges the same-mode request only for this page, without adding a completion state', async () => {
    const h = await page({ route: (request) => Response.json(request.method === 'PUT' ? modes[2] : view()) });
    await h.click('language-save');
    await h.answer(true);
    expect(JSON.parse(h.requests[1]!.body!)).toEqual({ primary: 'de', locales: ['de', 'en'] });
    expect(h.get('.onboarding-language-status').textContent).not.toBe('');
    expect(h.get('.onboarding-language').getAttribute('data-state')).toBeNull();
    const reopened = await page();
    expect(reopened.get('.onboarding-language-status').textContent).toBe('');
    expect(reopened.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it.each([400, 401, 403, 409, 500, 503])('retains the selection after HTTP %s, refreshes authoritative state and never replays', async (status) => {
    const h = await page({ route: (request) => request.method === 'PUT'
      ? Response.json({ code: status === 400 ? 'invalid_language' : 'language_pages_incomplete' }, { status })
      : Response.json(view()) });
    select(h, 1);
    await h.click('language-save');
    await h.answer(true);
    expect(selected(h)).toBe(1);
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(h.get('.onboarding-language-status').textContent).not.toBe('');
    expect(h.document.activeElement).toBe(h.action('language-save'));
    expect(h.get('.onboarding-language-current').textContent).toContain('/en/');
  });

  it.each(['network', 'json', 'wrong-mode', 'invalid-lock'] as const)('reconciles an ambiguous %s response without overwriting the candidate or claiming success', async (failure) => {
    const h = await page({ route: (request) => {
      if (request.method === 'GET') return Response.json(view());
      if (failure === 'network') throw new TypeError('lost acknowledgement');
      if (failure === 'json') return new Response('{');
      return Response.json(failure === 'wrong-mode' ? modes[2] : { ...modes[1], lockedAt: false });
    } });
    select(h, 1);
    await h.click('language-save');
    await h.answer(true);
    expect(selected(h)).toBe(1);
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(h.action('language-save').disabled).toBe(false);
    expect(h.get('.onboarding-language-status').textContent).not.toBe('');
  });

  it('shows the authoritative saved mode after a lost commit acknowledgement, retaining the request warning and never resending', async () => {
    let committed = false;
    const h = await page({ route: (request) => {
      if (request.method === 'PUT') { committed = true; throw new TypeError('connection lost after commit'); }
      return Response.json({ ...view(), language: committed ? modes[3] : modes[2] });
    } });
    select(h, 3);
    await h.click('language-save');
    await h.answer(true);
    expect(selected(h)).toBe(3);
    expect(h.get('.onboarding-language-current').textContent).toContain('/de/');
    expect(h.get('.onboarding-language-current').textContent).not.toContain('/en/');
    expect(h.get('.onboarding-language-status').textContent).not.toBe('');
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('keeps edits through a failed reconciliation read and explicit retry', async () => {
    let reads = 0;
    const h = await page({ route: (request) => {
      if (request.method === 'PUT') throw new TypeError('lost response');
      return ++reads === 2 ? Response.json({}, { status: 503 }) : Response.json(view());
    } });
    select(h, 3);
    await h.click('language-save');
    await h.answer(true);
    expect(h.root.querySelector('input')).toBeNull();
    expect(h.document.activeElement).toBe(h.action('retry'));
    await h.click('retry');
    expect(selected(h)).toBe(3);
    expect(h.document.activeElement).toBe(h.action('language-save'));
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
  });

  it('adopts a committed mode whose build failed and offers the existing saved-state rebuild without another write', async () => {
    let persisted = false;
    const h = await page({ route: (request) => {
      if (request.method === 'PUT') {
        persisted = true;
        // #297: the committed configuration answers 200 beside its failed build attempt.
        return Response.json({ ...modes[1], build: { ok: false, attemptId: 'failed', code: 'build_failed', error: 'The site generator stopped with an error.' } });
      }
      return Response.json({ ...view(), language: persisted ? modes[1] : modes[2] });
    } });
    select(h, 1);
    await h.click('language-save');
    await h.answer(true);
    expect(selected(h)).toBe(1);
    expect(h.get('.onboarding-language').querySelector('a')?.href).toBe('/admin/settings.html#site');
    expect(h.get('.onboarding-language-status').textContent).toContain(ui.en['admin.build.failedChange'].replace('{error}', ui.en['admin.build.failure.build_failed']));
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'GET']);
    await h.click('refresh');
    expect(selected(h)).toBe(1);
    expect(h.get('.onboarding-language').querySelector('a')?.href).toBe('/admin/settings.html#site');
    expect(h.requests.filter((request) => request.method !== 'GET')).toHaveLength(1);
  });

  it('renders seeded publication history read-only and directs secondary activation to Settings', async () => {
    const h = await page({ initial: { ...view(), language: { ...modes[0]!, lockedAt: '2026-10-29T00:00:00.000Z' } } });
    expect(h.root.querySelector('input')).toBeNull();
    expect(h.root.querySelector('[data-onboarding-action="language-save"]')).toBeNull();
    expect(h.get('.onboarding-language').querySelector('a')?.href).toBe('/admin/settings.html#language');
    expect(h.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('handles a publication racing the confirmation by rendering the authoritative lock and moving focus', async () => {
    let published = false;
    const h = await page({ route: (request) => {
      if (request.method === 'PUT') {
        published = true;
        return Response.json({ code: 'language_primary_locked' }, { status: 409 });
      }
      return Response.json({ ...view(), language: { ...modes[2]!, lockedAt: published ? '2026-10-29T00:00:00.000Z' : null } });
    } });
    select(h, 1);
    await h.click('language-save');
    await h.answer(true);
    expect(h.root.querySelector('input')).toBeNull();
    expect(h.document.activeElement).toBe(h.get('#onboardingLanguageHeading'));
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it.each(['dismissed', 'retired'] as const)('does not keep language focus in a concurrently %s checklist', async (status) => {
    let writes = 0;
    const h = await page({ route: (request) => {
      if (request.method === 'PUT') { writes++; return Response.json(modes[2]); }
      return Response.json(writes ? (status === 'retired' ? { status } : view({ status })) : view());
    } });
    await h.click('language-save');
    await h.answer(true);
    expect(h.root.hidden).toBe(true);
    expect(h.root.querySelector('input')).toBeNull();
    expect(h.document.activeElement).toBe(status === 'retired' ? h.get('#desk') : h.action('resume'));
  });

  it('owns the form through confirmation, write and reread, preventing duplicate or checklist mutations', async () => {
    const pending = Promise.withResolvers<Response>();
    const h = await page({ route: (request) => request.method === 'PUT' ? pending.promise : Response.json(view()) });
    await h.click('language-save');
    await h.click('dismiss');
    await h.controller.reload();
    expect(h.requests).toHaveLength(1);
    await h.answer(true);
    await h.click('language-save');
    await h.click('dismiss');
    await h.controller.reload();
    expect(h.requests).toHaveLength(2);
    pending.resolve(Response.json(modes[2]));
    await settle();
    expect(h.requests.map((request) => request.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(h.root.getAttribute('aria-busy')).toBe('false');
  });

  it.each([
    undefined, {}, { ...modes[2], lockedAt: undefined }, { ...modes[2], lockedAt: 'invalid' },
    { ...modes[2], locales: ['de', 'de'] }, { ...modes[2], acknowledgement: true },
  ])('fails closed for malformed language projection %j', async (language) => {
    const initial = { ...view(), language } as View;
    const h = await page({ initial });
    expect(h.root.querySelector('input')).toBeNull();
    expect(h.action('retry')).toBeDefined();
    expect(h.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('rejects language information attached to a retired projection instead of inventing eligibility', async () => {
    const h = await page({ route: () => Response.json({ status: 'retired', language: modes[2] }) });
    expect(h.root.querySelector('input')).toBeNull();
    expect(h.action('retry')).toBeDefined();
    expect(h.requests.map((request) => request.method)).toEqual(['GET']);
  });
});
