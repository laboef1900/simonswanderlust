// Shared browser/server persisted-value rules. Keep internal fill-only writes on
// their existing contract; only the public conditional envelope is strict.
export const MAX_FOLDER_DEPTH = 6;
export const MAX_FOLDER_LEN = 200;
export const MAX_TAGS = 30;
export const MAX_TAG_LEN = 40;
const SAFE_FOLDER_SEG = /^[\p{L}\p{N}](?:[\p{L}\p{N} _.\-]{0,62}[\p{L}\p{N}])?$/u;

export function assertSafeFolder(path) {
  if (typeof path !== 'string') throw new Error('folder path must be a string');
  if (path === '') return;
  if (path.length > MAX_FOLDER_LEN) throw new Error('folder path too long');
  if (path.normalize('NFC') !== path) throw new Error('folder path must be NFC');
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(path)) throw new Error('folder path has control/format characters');
  const segs = path.split('/');
  if (segs.length > MAX_FOLDER_DEPTH) throw new Error('folder nesting too deep');
  for (const s of segs) {
    if (!SAFE_FOLDER_SEG.test(s)) throw new Error(`invalid folder segment "${s}"`);
  }
}

export function cleanText(value) {
  return typeof value === 'string' ? value.replace(/[\p{C}]/gu, '').slice(0, 1000) : '';
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const clean = tag.replace(/[\p{C}]/gu, '').trim().slice(0, MAX_TAG_LEN);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('invalid_media_conditional'); };
const keysOnly = (value, allowed) => {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail();
};
const text = (value) => {
  if (typeof value !== 'string') fail();
  return cleanText(value);
};

export function canonicalizePatch(value) {
  keysOnly(value, ['title', 'alt', 'caption', 'tags', 'folder']);
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === 'alt' || key === 'caption') {
      keysOnly(value[key], ['de', 'en']);
      if (!Object.keys(value[key]).length) fail();
      out[key] = {};
      for (const locale of Object.keys(value[key])) out[key][locale] = text(value[key][locale]);
    } else if (key === 'tags') {
      if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string')) fail();
      out.tags = normalizeTags(value.tags);
    } else if (key === 'folder') {
      assertSafeFolder(value.folder);
      out.folder = value.folder;
    } else out.title = text(value.title);
  }
  return out;
}

export function canonicalizeConditional(envelope) {
  keysOnly(envelope, ['conditional']);
  if (Object.keys(envelope).length !== 1) fail();
  const value = envelope.conditional;
  keysOnly(value, ['version', 'patch', 'expect']);
  if (Object.keys(value).length !== 3) fail();
  if (value.version !== 1) fail();
  const patch = canonicalizePatch(value.patch);
  const expect = canonicalizePatch(value.expect);
  const leaves = (fields) => Object.keys(fields).flatMap((key) =>
    key === 'alt' || key === 'caption' ? Object.keys(fields[key]).map((locale) => key + '.' + locale) : [key]).sort();
  const changed = leaves(patch);
  if (!changed.length || JSON.stringify(changed) !== JSON.stringify(leaves(expect))) fail();
  return { version: 1, patch, expect };
}

if (typeof window !== 'undefined') {
  window.MediaConditional = { canonicalizePatch, canonicalizeConditional, cleanText, normalizeTags, assertSafeFolder };
}
