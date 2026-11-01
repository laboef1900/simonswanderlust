import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { editorDocument, type EditorElement } from './editor-dom-harness.js';
import { ui } from '../../site/src/i18n/ui.js';

const deskWindows: EventTarget[] = [];
afterEach(() => {
  for (const window of deskWindows.splice(0)) window.dispatchEvent(new Event('pagehide'));
});

const buildCopy = Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [locale,
  Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('admin.build.')).map(([key, value]) => [key.slice('admin.build.'.length), value])),
]));
const release = '1793000000000-1-0001';
const startedAt = new Date(1793000000000).toISOString();
const live = { release, stampedAt: startedAt };
const last = { attemptId: release, startedAt, finishedAt: startedAt, result: 'failed', release: null,
  failure: { code: 'build_failed', message: 'SECRET /data/private' }, beforeBoot: false, triggers: ['publish'] };
interface Reporting {
  renderOutcome(root: EditorElement, action: string, body: unknown, values?: Record<string, unknown>): void;
  renderStatus(root: EditorElement, status: unknown): void;
}
function harness(locale: 'de' | 'en' = 'en') {
  const dom = editorDocument('<html><body><p id="status"></p></body></html>');
  const document = Object.assign(dom.document, { documentElement: { lang: locale } });
  const context: Record<string, unknown> = { document, BuildCopy: buildCopy };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync('public/build-reporting.js', 'utf8'), context);
  return { root: document.getElementById('status')!, api: context.BuildReporting as Reporting };
}

// The same renderer is used by every action consumer. Exercise independent facts,
// not incidental sentence punctuation, and never trust error/message strings.
describe.each(['de', 'en'] as const)('shared %s build evidence renderer', (locale) => {
  it.each(['publish', 'unpublish', 'delete', 'bulk', 'page', 'language', 'rebuild'])('%s names persistence separately from promotion and live observation', (action) => {
    const { root, api } = harness(locale);
    const values = { title: '<img src=x>', action: 'Publish', n: 2, m: 1 };
    for (const ok of [true, false]) {
      for (const observed of [release, null, undefined]) {
        const build = { ok, attemptId: release, release: ok ? release : undefined, code: 'build_failed', error: 'SECRET', liveRelease: observed };
        api.renderOutcome(root, action, action === 'rebuild' ? build : { build }, values);
        expect(root.textContent).not.toContain('SECRET');
        expect(root.querySelector('img')).toBeNull();
        if (action !== 'rebuild') expect(root.textContent).toContain('CMS');
        if (ok) expect(root.textContent).toContain(release);
        else {
          expect(root.textContent).toContain(ui[locale]['admin.build.failure.build_failed']);
          expect(root.querySelector('a')?.href).toBe('/admin/settings.html#site');
        }
        if (observed === null) expect(root.textContent).toContain(ui[locale]['admin.build.noLive']);
        if (observed === undefined) expect(root.textContent).toContain(ui[locale]['admin.build.liveUnavailable']);
      }
    }
  });

  it.each(['delete', 'bulk', 'page', 'language'])('%s without a build does not invent a live outcome', (action) => {
    const { root, api } = harness(locale);
    api.renderOutcome(root, action, {}, { title: 'Draft', action: 'Delete', n: 1, m: 2 });
    expect(root.textContent).toContain('CMS');
    expect(root.textContent).toContain(ui[locale]['admin.build.noBuild']);
    expect(root.querySelector('a')).toBeNull();
  });

  it.each(['build_timeout', 'build_failed', 'build_unavailable', 'no_space', 'release_write_failed', 'build_stopped', 'internal', '__proto__'])('chooses bounded copy for %s', (code) => {
    const { root, api } = harness(locale);
    api.renderOutcome(root, 'rebuild', { ok: false, code, error: 'SECRET' });
    expect(root.textContent).not.toContain('SECRET');
    if (code === 'build_stopped') {
      expect(root.textContent).toContain(ui[locale]['admin.build.stoppedRecovery']);
      expect(root.textContent).not.toContain(ui[locale]['admin.build.retry']);
    }
    if (code === '__proto__') expect(root.textContent).toContain(ui[locale]['admin.build.failure.internal']);
  });

  it.each(['missing', 'unreadable'])('%s is not success even beside an existing live release', (record) => {
    const { root, api } = harness(locale);
    for (const observation of [live, null, undefined]) {
      api.renderStatus(root, { record, running: null, last: null, live: observation });
      expect(root.textContent).toContain(ui[locale][record === 'missing' ? 'admin.build.missing' : 'admin.build.unreadable']);
      expect(root.textContent).not.toContain(locale === 'de' ? 'erfolgreich' : 'succeeded');
      if (observation === null) expect(root.textContent).toContain(ui[locale]['admin.build.noLive']);
      if (observation === undefined) expect(root.textContent).toContain(ui[locale]['admin.build.liveUnavailable']);
    }
  });

  it('does not downgrade a recorded promotion when the live observation is unavailable', () => {
    const { root, api } = harness(locale);
    api.renderStatus(root, { record: 'not_persisted', running: null,
      last: { ...last, result: 'succeeded', release, failure: null },
    });
    expect(root.textContent).toContain(locale === 'de' ? 'erfolgreich' : 'succeeded');
    expect(root.textContent).toContain(ui[locale]['admin.build.liveUnavailable']);
    expect(root.textContent).toContain(ui[locale]['admin.build.notPersisted']);
    expect(root.querySelector('a')).toBeNull();
  });

  it('keeps interrupted history, running ownership and live evidence independent', () => {
    const { root, api } = harness(locale);
    api.renderStatus(root, { record: 'not_persisted', live,
      running: { attemptId: release, startedAt, queued: true, owner: 'unverified' },
      last: { ...last, result: 'interrupted', finishedAt: null, failure: null, beforeBoot: true },
    });
    for (const key of ['queued', 'unverified', 'notPersisted', 'beforeBoot'] as const) expect(root.textContent).toContain(ui[locale][`admin.build.${key}`]);
    expect(root.textContent).toContain(locale === 'de' ? 'Ergebnis ist unbekannt' : 'result is unknown');
    expect(root.textContent).toContain(locale === 'de' ? 'beobachtet' : 'observed serving');
    expect(root.querySelector('a')?.href).toBe('/admin/settings.html#site');
  });
});

async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
async function desk(isAdmin: boolean) {
  const html = readFileSync('public/index.html', 'utf8');
  const dom = editorDocument(html);
  const requests: string[] = [];
  let failing = true;
  const window = new EventTarget();
  deskWindows.push(window);
  const context: Record<string, unknown> = {
    document: Object.assign(dom.document, { documentElement: { lang: 'en' }, title: 'Desk' }), BuildCopy: buildCopy,
    EditorCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [locale,
      Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('editor.chrome.'))
        .map(([key, text]) => [key.slice('editor.chrome.'.length), text])),
    ])),
    location: { pathname: '/admin/index.html', search: '', origin: 'https://blog.test' },
    AbortController, setTimeout, clearTimeout,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async (url: string) => {
      requests.push(url);
      if (url === '/auth/me') return Response.json({
        authenticated: true, userId: '11111111-1111-4111-8111-111111111111',
        username: 'writer', isAdmin, needsSetup: false,
      });
      if (url === '/language') return Response.json({
        primary: 'en', locales: ['en'], lockedAt: null, updatedAt: '2026-10-27T00:00:00.000Z',
      });
      if (url === '/onboarding') return Response.json({ status: 'retired' });
      if (url === '/posts') return Response.json([]);
      if (url === '/media/queue') return Response.json({ pending: 0, running: 0 });
      if (url === '/health') return Response.json({ release: true });
      if (url === '/publication/summary') return Response.json({ availability: 'available', release: 'unknown', posts: null, galleryDescriptions: null });
      if (url === '/rebuild/status') {
        if (failing) throw new Error('offline');
        return Response.json({ live, running: null, last, record: 'ok' });
      }
      throw new Error('Unexpected request ' + url);
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const script of html.matchAll(/<script(?:\s+src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
    if (script[1] === '/admin/editor-image-copy.js') continue;
    vm.runInContext(script[1] ? readFileSync('public/' + script[1].slice('/admin/'.length), 'utf8') : script[2]!, context);
  }
  await settle();
  return { requests, document: dom.document, recover() { failing = false; } };
}

describe('Desk build status authorization and recovery', () => {
  it('never requests build status for an author', async () => {
    const h = await desk(false);
    expect(h.requests).not.toContain('/rebuild/status');
    expect(h.document.getElementById('deskBuild')!.hidden).toBe(true);
  });

  it('isolates history failure from fresh posts and uses the shared read-only refresh without duplicate requests', async () => {
    const h = await desk(true);
    const root = h.document.getElementById('deskBuild')!;
    expect(root.hidden).toBe(false);
    expect(root.textContent).toContain(ui.en['admin.build.unavailable']);
    expect(h.document.getElementById('deskNext')!.querySelector('a')?.href).toBe('/admin/editor.html');
    const retry = h.document.getElementById('publicationRefresh')!;
    h.recover();
    retry.click(); retry.click();
    await settle();
    expect(h.requests.filter((url) => url === '/rebuild/status')).toHaveLength(2);
    expect(root.textContent).not.toContain('SECRET');
    expect(root.querySelector('a')?.href).toBe('/admin/settings.html#site');
  });
});
