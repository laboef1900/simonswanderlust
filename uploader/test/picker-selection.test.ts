import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// picker-selection.js is a plain browser IIFE (window.PickerSelection) holding
// the media picker's ordered multi-selection. Run it in a vm sandbox — same
// precedent as posts-filter.js — so the ordering rules are covered without a
// browser. The DOM wiring in media-picker.js stays untested by design; the
// ordering is what silently corrupts a gallery when it is wrong.
const src = readFileSync('public/picker-selection.js', 'utf8');

interface Row { key: string; src: string; title?: string }
interface Selection {
  adopt(rows: Row[]): number;
  toggle(item: Row): boolean;
  set(item: Row | null): void;
  move(from: number, to: number): boolean;
  remove(index: number): boolean;
  indexOf(key: string): number;
  size(): number;
  items(): Row[];
  pending(): number;
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

/** `src` is `${baseUrl}/${key}` — the shape media-store.ts actually serializes. */
const row = (key: string): Row => ({ key, src: `https://img.example.com/${key}`, title: key });
const url = (key: string) => `https://img.example.com/${key}`;
const keys = (sel: Selection) => sel.items().map((i) => i.key);

describe('PickerSelection — plain selection', () => {
  it('appends in click order and toggles off', () => {
    const sel = PickerSelection.create();
    expect(sel.toggle(row('b'))).toBe(true);
    expect(sel.toggle(row('a'))).toBe(true);
    expect(keys(sel)).toEqual(['b', 'a']);
    expect(sel.toggle(row('b'))).toBe(false);
    expect(keys(sel)).toEqual(['a']);
  });

  it('set() replaces outright, for the single-select hero picker', () => {
    const sel = PickerSelection.create();
    sel.toggle(row('a'));
    sel.set(row('b'));
    expect(keys(sel)).toEqual(['b']);
  });

  it('move() reorders and refuses out-of-range or no-op moves', () => {
    const sel = PickerSelection.create();
    ['a', 'b', 'c'].forEach((k) => sel.toggle(row(k)));
    expect(sel.move(2, 0)).toBe(true);
    expect(keys(sel)).toEqual(['c', 'a', 'b']);
    expect(sel.move(0, -1)).toBe(false);
    expect(sel.move(0, 3)).toBe(false);
    expect(sel.move(1, 1)).toBe(false);
    expect(keys(sel)).toEqual(['c', 'a', 'b']);
  });
});

describe('PickerSelection — preselect adoption', () => {
  it('restores the fence order regardless of the order pages deliver rows in', () => {
    const sel = PickerSelection.create({ preselect: [url('a'), url('b'), url('c')] });
    sel.adopt([row('c'), row('a')]); // library paging order, not gallery order
    expect(keys(sel)).toEqual(['a', 'c']);
    sel.adopt([row('b')]);
    expect(keys(sel)).toEqual(['a', 'b', 'c']);
    expect(sel.pending()).toBe(0);
  });

  it('adopts a photo the author never pages past only once', () => {
    const sel = PickerSelection.create({ preselect: [url('a')] });
    expect(sel.adopt([row('a')])).toBe(1);
    expect(sel.adopt([row('a')])).toBe(0);
    expect(keys(sel)).toEqual(['a']);
  });

  it('places a later-adopted photo before photos the author added by hand', () => {
    const sel = PickerSelection.create({ preselect: [url('a'), url('b')] });
    sel.adopt([row('a')]);        // page 1 carries only `a`
    sel.toggle(row('new'));       // author picks something new
    sel.adopt([row('b')]);        // page 2 carries `b`
    expect(keys(sel)).toEqual(['a', 'b', 'new']);
  });

  // @ai-warning This is the regression the first implementation had: adoption
  // re-sorted the WHOLE selection on every load, guarded only by "some
  // preselected URL is still unmatched" — a condition a photo deleted from the
  // library makes permanent. Searching or paging then silently undid the
  // author's ordering and hoisted their own picks to the front. Gallery order is
  // the fence's line order, so that is published output, not a UI detail.
  it('never re-orders a selection the author has arranged', () => {
    const sel = PickerSelection.create({ preselect: [url('a'), url('b'), url('gone')] });
    sel.adopt([row('a'), row('b')]);
    sel.toggle(row('new'));
    sel.move(2, 0); // author drags their new photo to the front
    expect(keys(sel)).toEqual(['new', 'a', 'b']);

    // A preselected URL the library no longer has never matches, so every
    // later load still tries to adopt. It must not touch what is already there.
    expect(sel.pending()).toBe(1);
    sel.adopt([row('a'), row('b')]);
    sel.adopt([]);
    expect(keys(sel)).toEqual(['new', 'a', 'b']);
  });

  it('appends rather than guessing a position once the author has arranged', () => {
    const sel = PickerSelection.create({ preselect: [url('a'), url('b')] });
    sel.adopt([row('a')]);
    sel.toggle(row('new'));
    sel.move(1, 0); // author arranges: new, a
    sel.adopt([row('b')]);
    expect(keys(sel)).toEqual(['new', 'a', 'b']);
  });

  it('drops a preselected photo the library no longer has', () => {
    const sel = PickerSelection.create({ preselect: [url('a'), url('deleted')] });
    sel.adopt([row('a')]);
    expect(keys(sel)).toEqual(['a']);
    expect(sel.pending()).toBe(1);
  });

  it('ignores junk in preselect and duplicate URLs', () => {
    const sel = PickerSelection.create({ preselect: [url('a'), url('a'), '', null, 7] });
    sel.adopt([row('a')]);
    expect(keys(sel)).toEqual(['a']);
    expect(sel.pending()).toBe(0);
  });

  it('removing then re-picking a preselected photo puts it where the author clicked', () => {
    const sel = PickerSelection.create({ preselect: [url('a'), url('b')] });
    sel.adopt([row('a'), row('b')]);
    sel.toggle(row('a')); // deselect
    expect(keys(sel)).toEqual(['b']);
    sel.toggle(row('a')); // re-pick — the author's click order wins
    expect(keys(sel)).toEqual(['b', 'a']);
  });
});
