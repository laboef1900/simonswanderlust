export interface ConditionalMediaPatch {
  title?: string;
  folder?: string;
  alt?: { de?: string; en?: string };
  caption?: { de?: string; en?: string };
  tags?: string[];
}
export interface MediaConditional {
  version: 1;
  patch: ConditionalMediaPatch;
  expect: ConditionalMediaPatch;
}
export const MAX_FOLDER_DEPTH: 6;
export const MAX_FOLDER_LEN: 200;
export const MAX_TAGS: 30;
export const MAX_TAG_LEN: 40;
export function assertSafeFolder(path: string): void;
export function cleanText(value: unknown): string;
export function normalizeTags(tags: unknown): string[];
export function canonicalizePatch(value: unknown): ConditionalMediaPatch;
/** Accepts the full public envelope; returns its validated, canonical inner value. */
export function canonicalizeConditional(envelope: unknown): MediaConditional;
