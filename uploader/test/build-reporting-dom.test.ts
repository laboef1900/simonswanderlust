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
interface Format { dateTime(value: unknown): string }
const fill = (text: string, values: Record<string, unknown>) => text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
function harness(locale: 'de' | 'en' = 'en') {
  const dom = editorDocument('<html><body><p id="status"></p></body></html>');
  const document = Object.assign(dom.document, { documentElement: { lang: locale } });
  const context: Record<string, unknown> = { document, BuildCopy: buildCopy };
  context.window = context;
  vm.createContext(context);
  // Every admin page loads admin-ui.js before build-reporting.js formats a moment through it.
  vm.runInContext(readFileSync('public/admin-ui.js', 'utf8'), context);
  vm.runInContext(readFileSync('public/build-reporting.js', 'utf8'), context);
  return { root: document.getElementById('status')!, api: context.BuildReporting as Reporting, format: context.AdminFormat as Format, copy: ui[locale] };
}

// The same renderer is used by every action consumer. Exercise independent facts,
// not incidental sentence punctuation, and never trust error/message strings.
describe.each(['de', 'en'] as const)('shared %s build evidence renderer', (locale) => {
  it.each(['publish', 'unpublish', 'delete', 'bulk', 'page', 'language', 'rebuild'])('%s names the acknowledgement, what the live site does now and the build moment — never a release id', (action) => {
    const { root, api, format, copy } = harness(locale);
    const values = { title: '<img src=x>', action: 'Publish', n: 2, m: 1 };
    const builtAt = format.dateTime(1793000000000);
    expect(builtAt).toMatch(/^\d{1,2} \w{3} 2026, \d{2}:\d{2}$/);
    for (const ok of [true, false]) {
      for (const observed of [release, null, undefined]) {
        const build = { ok, attemptId: release, release: ok ? release : undefined, code: 'build_failed', error: 'SECRET', liveRelease: observed };
        api.renderOutcome(root, action, action === 'rebuild' ? build : { build }, values);
        const text = root.textContent;
        expect(text).not.toContain('SECRET');
        expect(text).not.toContain(release);
        expect(root.querySelector('img')).toBeNull();
        if (action !== 'rebuild') expect(text.startsWith(fill(copy[`admin.build.${action}` as keyof typeof copy], values))).toBe(true);
        if (ok && observed === release) {
          const key = action === 'unpublish' || action === 'delete' ? 'admin.build.liveWithout' : 'admin.build.liveThis';
          expect(text).toContain(fill(copy[key], { builtAt }));
          expect(text).not.toContain(copy['admin.build.built']);
        } else if (ok) {
          expect(text).toContain(copy['admin.build.built']);
        } else {
          expect(text).toContain(fill(copy[action === 'rebuild' ? 'admin.build.failedRebuild' : 'admin.build.failedChange'], { error: copy['admin.build.failure.build_failed'] }));
          expect(root.querySelector('a')?.href).toBe('/admin/settings.html#site');
          if (observed === release) expect(text).toContain(fill(copy['admin.build.live'], { stampedAt: builtAt }));
        }
        if (observed === null) expect(text).toContain(copy['admin.build.noLive']);
        if (observed === undefined) expect(text).toContain(copy['admin.build.liveUnavailable']);
      }
    }
  });

  it.each(['delete', 'bulk', 'page', 'language'])('%s without a build does not invent a live outcome', (action) => {
    const { root, api, copy } = harness(locale);
    const values = { title: 'Draft', action: 'Delete', n: 1, m: 2 };
    api.renderOutcome(root, action, {}, values);
    expect(root.textContent.startsWith(fill(copy[action === 'delete' ? 'admin.build.deleteDraft' : `admin.build.${action}` as keyof typeof copy], values))).toBe(true);
    expect(root.textContent).toContain(copy['admin.build.noBuild']);
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

  it('keeps interrupted history, running ownership and live evidence independent, each moment in the one date format', () => {
    const { root, api, format } = harness(locale);
    api.renderStatus(root, { record: 'not_persisted', live,
      running: { attemptId: release, startedAt, queued: true, owner: 'unverified' },
      last: { ...last, result: 'interrupted', finishedAt: null, failure: null, beforeBoot: true },
    });
    for (const key of ['queued', 'unverified', 'notPersisted', 'beforeBoot'] as const) expect(root.textContent).toContain(ui[locale][`admin.build.${key}`]);
    expect(root.textContent).toContain(locale === 'de' ? 'Ergebnis ist unbekannt' : 'result is unknown');
    const moment = format.dateTime(startedAt);
    expect(root.textContent).toContain(fill(ui[locale]['admin.build.running'], { startedAt: moment }));
    expect(root.textContent).toContain(fill(ui[locale]['admin.build.live'], { stampedAt: moment }));
    expect(root.textContent).not.toContain(release);
    expect(root.textContent).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}T/);
    expect(root.querySelector('a')?.href).toBe('/admin/settings.html#site');
  });
});

it('reads as plain outcomes in English: what was done, what the live site does now, when it was built', () => {
  const { root, api, format } = harness('en');
  const builtAt = format.dateTime(1793000000000);
  api.renderOutcome(root, 'publish', { build: { ok: true, attemptId: release, release, liveRelease: release } });
  expect(root.textContent).toBe(`Published. The live site is serving this version (built ${builtAt}).`);
  api.renderOutcome(root, 'unpublish', { build: { ok: true, attemptId: release, release, liveRelease: release } }, { title: 'Bukarest' });
  expect(root.textContent).toBe(`Unpublished “Bukarest”. The live site no longer shows it (built ${builtAt}).`);
  api.renderOutcome(root, 'delete', {}, { title: 'Bukarest' });
  expect(root.textContent).toBe('Deleted draft “Bukarest”. The site was not rebuilt.');
  api.renderOutcome(root, 'publish', { build: { ok: false, code: 'no_space', liveRelease: release } });
  // The sentence first; the recovery link follows it as its own element.
  expect(root.textContent).toBe(`Published. The live site was not updated because the rebuild failed: ${ui.en['admin.build.failure.no_space']} The live site is serving the version built ${builtAt}. ${ui.en['admin.build.retry']}`);
  expect(root.querySelector('a')?.textContent).toBe(ui.en['admin.build.retry']);
  api.renderOutcome(root, 'publish', { build: { ok: 'pending' } });
  expect(root.textContent).toBe(`Published. ${ui.en['admin.build.unknown']}`);
  api.renderStatus(root, { record: 'ok', running: { attemptId: release, startedAt, queued: false, owner: 'this_process' }, last: null, live: null });
  expect(root.textContent).toBe(`Rebuild in progress since ${builtAt}. Nothing is live yet.`);
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
  return { requests, document: dom.document, recover() { failing = false; }, refresh() { return vm.runInContext('publicationRefresh.refresh()', context) as Promise<void>; } };
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
    expect(h.document.getElementById('deskNewPost')!.hidden).toBe(false);
    h.recover();
    void h.refresh(); void h.refresh();
    await settle();
    expect(h.requests.filter((url) => url === '/rebuild/status')).toHaveLength(2);
    expect(root.textContent).not.toContain('SECRET');
    expect(root.querySelector('a')?.href).toBe('/admin/settings.html#site');
  });
});
