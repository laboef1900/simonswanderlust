import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { editorDocument } from './editor-dom-harness.js';

interface Api {
  AdminFormat: {
    date(value: unknown, options?: { utc?: boolean }): string;
    dateTime(value: unknown, options?: { utc?: boolean }): string;
    time(value: unknown, options?: { utc?: boolean }): string;
    count(n: number, singular: string, plural?: string): string;
    region(slug: string): string;
  };
  AdminField: { invalid(field: unknown, message: string, options?: { focus?: boolean }): unknown; valid(field: unknown): void };
  AdminFocus: { hold(control: unknown): (...fallbacks: unknown[]) => void };
}

function load(markup = '<body></body>') {
  const dom = editorDocument(markup);
  const window = {} as Api;
  vm.runInNewContext(readFileSync('public/admin-ui.js', 'utf8'), { window, document: dom.document });
  return { ...window, dom };
}

describe('AdminFormat', () => {
  const { AdminFormat } = load();

  it('writes a date day-first with a short month, never month/day/year', () => {
    expect(AdminFormat.date('2026-11-07T12:00:00Z', { utc: true })).toBe('7 Nov 2026');
  });

  it('keeps a bare calendar date on its own day in any time zone', () => {
    // 2026-10-01 is a day, not an instant: west of UTC it must not become 30 Sept.
    expect(AdminFormat.date('2026-10-01')).toBe('1 Oct 2026');
  });

  it('writes a moment as date, comma, 24-hour time', () => {
    expect(AdminFormat.dateTime('2026-11-10T08:43:41Z', { utc: true })).toBe('10 Nov 2026, 08:43');
    expect(AdminFormat.dateTime('2026-11-10T20:05:00Z', { utc: true })).toBe('10 Nov 2026, 20:05');
    expect(AdminFormat.time('2026-11-10T00:07:00Z', { utc: true })).toBe('00:07');
  });

  it.each([null, undefined, '', 'not a date'])('returns an empty string for %j', (value) => {
    expect(AdminFormat.date(value)).toBe('');
    expect(AdminFormat.dateTime(value)).toBe('');
  });

  it('pluralises counts, including irregular plurals and zero', () => {
    expect(AdminFormat.count(1, 'photo')).toBe('1 photo');
    expect(AdminFormat.count(3, 'photo')).toBe('3 photos');
    expect(AdminFormat.count(0, 'account')).toBe('0 accounts');
    expect(AdminFormat.count(2, 'story', 'stories')).toBe('2 stories');
    expect(AdminFormat.count(1, 'story', 'stories')).toBe('1 story');
    expect(AdminFormat.count(1234, 'photo')).toBe('1,234 photos');
  });

  it('names a region instead of showing its slug', () => {
    expect(AdminFormat.region('north-america')).toBe('North America');
    expect(AdminFormat.region('europe')).toBe('Europe');
    expect(AdminFormat.region('atlantis')).toBe('atlantis');
    expect(AdminFormat.region('')).toBe('');
  });
});

describe('AdminField', () => {
  it('puts the reason under the field, marks it invalid, describes it and focuses it', () => {
    const { AdminField, dom } = load('<body><label for="siteName">Site name</label><input id="siteName" aria-describedby="siteNameHelp"><p id="siteNameHelp"></p></body>');
    const field = dom.document.getElementById('siteName')!;
    AdminField.invalid(field, 'Site name can be at most 60 characters.');

    const line = dom.document.getElementById('siteNameError')!;
    expect(line.textContent).toBe('Site name can be at most 60 characters.');
    expect(line.hidden).toBe(false);
    expect(line.className).toBe('field-error');
    expect(field.parentElement!.children.indexOf(line)).toBe(field.parentElement!.children.indexOf(field) + 1);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe('siteNameHelp siteNameError');
    expect(dom.document.activeElement).toBe(field);
  });

  it('clears the mark and keeps the field’s other descriptions', () => {
    const { AdminField, dom } = load('<body><input id="slug" aria-describedby="slugHelp"></body>');
    const field = dom.document.getElementById('slug')!;
    AdminField.invalid(field, 'Use lowercase letters, digits and hyphens.');
    AdminField.invalid(field, 'This slug is already in use.');
    expect(dom.document.querySelectorAll('.field-error')).toHaveLength(1);

    AdminField.valid(field);
    expect(dom.document.getElementById('slugError')!.hidden).toBe(true);
    expect(field.hasAttribute('aria-invalid')).toBe(false);
    expect(field.getAttribute('aria-describedby')).toBe('slugHelp');
  });

  it('can mark a field without stealing focus while the author types elsewhere', () => {
    const { AdminField, dom } = load('<body><input id="a"><input id="b"></body>');
    dom.document.getElementById('b')!.focus();
    AdminField.invalid(dom.document.getElementById('a')!, 'Required.', { focus: false });
    expect(dom.document.activeElement).toBe(dom.document.getElementById('b'));
  });
});

describe('AdminFocus.hold', () => {
  const markup = '<body><button id="save">Save</button><button id="other">Other</button><select id="filter"></select></body>';

  it('returns focus to a control that was disabled while its action ran', () => {
    const { AdminFocus, dom } = load(markup);
    const save = dom.document.getElementById('save')!;
    save.focus();
    const restore = AdminFocus.hold(save);
    save.disabled = true;
    // What a browser does when the focused control is disabled: focus falls to <body>.
    dom.document.body!.focus();
    save.disabled = false;
    restore();
    expect(dom.document.activeElement).toBe(save);
  });

  it('falls back when the control is gone, and never moves focus the author has since placed', () => {
    const { AdminFocus, dom } = load(markup);
    const save = dom.document.getElementById('save')!;
    const filter = dom.document.getElementById('filter')!;
    save.focus();
    const removed = AdminFocus.hold(save);
    save.remove();
    dom.document.body!.focus();
    removed(filter);
    expect(dom.document.activeElement).toBe(filter);

    const other = dom.document.getElementById('other')!;
    other.focus();
    const held = AdminFocus.hold(other);
    filter.focus();
    held();
    expect(dom.document.activeElement).toBe(filter);
  });

  it('does nothing when the control never had focus', () => {
    const { AdminFocus, dom } = load(markup);
    dom.document.getElementById('other')!.focus();
    const restore = AdminFocus.hold(dom.document.getElementById('save')!);
    dom.document.body!.focus();
    restore();
    expect(dom.document.activeElement).toBe(dom.document.body);
  });
});
