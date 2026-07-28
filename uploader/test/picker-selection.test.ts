import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// picker-selection.js is a plain browser IIFE (window.PickerSelection) holding
// the media picker's ordered multi-selection. Run it in a vm sandbox — same
// precedent as posts-filter.js — so the ordering rules are covered without a
// browser. The DOM wiring in media-picker.js stays untested by design; the
// selection is what silently corrupts a gallery when it is wrong.
const src = readFileSync('public/picker-selection.js', 'utf8');

interface Row { src: string; key?: string; title?: string; width?: number; height?: number; fromPost?: boolean }
interface Selection {
  adopt(rows: unknown[]): number;
  toggle(item: Row): boolean;
  set(item: Row | null): void;
  move(from: number, to: number): boolean;
  remove(index: number): boolean;
  indexOf(src: string): number;
  size(): number;
  items(): Row[];
  unresolved(): number;
  isResolved(index: number): boolean;
}
interface Api {
  create(opts?: { preselect?: unknown[] }): Selection;
}

function load(): Api {
  const windowStub: { PickerSelection?: Api } = {};
  vm.runInNewContext(src, { window: windowStub });
  if (!windowStub.PickerSelection) throw new Error('picker-selection.js did not assign window.PickerSelection');
  return windowStub.PickerSelection;
}

const PickerSelection = load();

/** A full library row. `src` is `${baseUrl}/${key}` — what media-store.ts serializes. */
const row = (key: string): Row => ({
  key, src: `https://img.example.com/${key}`, title: key, width: 3000, height: 2000,
});
/** What editor.html reconstructs from a gallery fence plus the post's images map. */
const carried = (key: string, dims: Partial<Row> = {}): Row => ({
  src: `https://img.example.com/${key}`,
  width: 3000,
  height: 2000,
  fromPost: true,
  ...dims,
});
const srcs = (sel: Selection) => sel.items().map((i) => i.src.replace('https://img.example.com/', ''));

describe('PickerSelection — plain selection', () => {
  it('appends in click order and toggles off', () => {
    const sel = PickerSelection.create();
    expect(sel.toggle(row('b'))).toBe(true);
    expect(sel.toggle(row('a'))).toBe(true);
    expect(srcs(sel)).toEqual(['b', 'a']);
    expect(sel.toggle(row('b'))).toBe(false);
    expect(srcs(sel)).toEqual(['a']);
  });

  it('set() replaces outright, for the single-select hero picker', () => {
    const sel = PickerSelection.create();
    sel.toggle(row('a'));
    sel.set(row('b'));
    expect(srcs(sel)).toEqual(['b']);
  });

  it('move() reorders and refuses out-of-range or no-op moves', () => {
    const sel = PickerSelection.create();
    ['a', 'b', 'c'].forEach((k) => sel.toggle(row(k)));
    expect(sel.move(2, 0)).toBe(true);
    expect(srcs(sel)).toEqual(['c', 'a', 'b']);
    expect(sel.move(0, -1)).toBe(false);
    expect(sel.move(0, 3)).toBe(false);
    expect(sel.move(1, 1)).toBe(false);
    expect(srcs(sel)).toEqual(['c', 'a', 'b']);
  });

  it('identifies photos by src, so a carried-in photo and its library row are one entry', () => {
    const sel = PickerSelection.create({ preselect: [carried('a')] });
    expect(sel.indexOf('https://img.example.com/a')).toBe(0);
    sel.toggle(row('a')); // clicking its grid cell deselects rather than duplicating
    expect(sel.size()).toBe(0);
  });
});

describe('PickerSelection — photos carried in from the caller', () => {
  // @ai-warning The bug this guards is the one that loses an author's work.
  // `GET /media` returns 40 rows ordered by upload date, so an older post's
  // gallery photos are usually on no page the author opens. An earlier version
  // seeded the selection from URLs and adopted them only as it met them in a
  // page — so confirming the dialog wrote back only the photos that happened to
  // be on screen and silently dropped the rest of the gallery.
  it('holds every carried-in photo before the library is ever queried', () => {
    const sel = PickerSelection.create({ preselect: [carried('a'), carried('b'), carried('c')] });
    expect(srcs(sel)).toEqual(['a', 'b', 'c']);
    expect(sel.unresolved()).toBe(3);
  });

  it('keeps them through pages that contain none of them', () => {
    const sel = PickerSelection.create({ preselect: [carried('a'), carried('b')] });
    sel.adopt([row('x'), row('y')]); // page 1
    sel.adopt([row('z')]);           // page 2
    sel.adopt([]);                   // a search with no hits
    expect(srcs(sel)).toEqual(['a', 'b']);
  });

  it('upgrades in place when the library row finally appears, without moving it', () => {
    const sel = PickerSelection.create({ preselect: [carried('a'), carried('b'), carried('c')] });
    sel.toggle(row('new'));
    expect(sel.isResolved(1)).toBe(false);
    expect(sel.adopt([row('b')])).toBe(1);
    expect(srcs(sel)).toEqual(['a', 'b', 'c', 'new']);
    expect(sel.isResolved(1)).toBe(true);
    expect(sel.items()[1]?.title).toBe('b'); // gained the library row's fields
    expect(sel.unresolved()).toBe(2);
  });

  it('never re-orders a selection the author has arranged', () => {
    const sel = PickerSelection.create({ preselect: [carried('a'), carried('b')] });
    sel.toggle(row('new'));
    sel.move(2, 0);
    expect(srcs(sel)).toEqual(['new', 'a', 'b']);
    sel.adopt([row('a'), row('b')]); // upgrading must not reorder
    sel.adopt([row('a')]);           // and must be idempotent
    expect(srcs(sel)).toEqual(['new', 'a', 'b']);
  });

  it('keeps the post dimensions when the library row has none', () => {
    const sel = PickerSelection.create({ preselect: [carried('a', { width: 3000, height: 2000 })] });
    sel.adopt([{ ...row('a'), width: 0, height: 0 }]);
    expect(sel.items()[0]).toMatchObject({ width: 3000, height: 2000, fromPost: true });
  });

  it('prefers the library row dimensions when it has usable ones', () => {
    const sel = PickerSelection.create({ preselect: [carried('a', { width: 10, height: 20 })] });
    sel.adopt([row('a')]);
    expect(sel.items()[0]).toMatchObject({ width: 3000, height: 2000 });
  });

  it('a photo deleted from the library stays selected and is written back', () => {
    // It is still in the author's gallery. Dropping it would edit the post on
    // their behalf; leaving it lets the fence keep the reference it already had.
    const sel = PickerSelection.create({ preselect: [carried('gone'), carried('a')] });
    sel.adopt([row('a')]);
    expect(srcs(sel)).toEqual(['gone', 'a']);
    expect(sel.isResolved(0)).toBe(false);
    expect(sel.isResolved(1)).toBe(true);
  });

  it('removing a carried-in photo is how the author drops it', () => {
    const sel = PickerSelection.create({ preselect: [carried('a'), carried('b')] });
    expect(sel.remove(0)).toBe(true);
    expect(srcs(sel)).toEqual(['b']);
  });

  it('ignores junk and the same photo listed twice', () => {
    const sel = PickerSelection.create({ preselect: [carried('a'), carried('a'), { src: '' }, null, 7] });
    expect(srcs(sel)).toEqual(['a']);
  });
});
