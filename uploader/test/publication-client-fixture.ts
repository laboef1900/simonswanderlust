import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ui } from '../../site/src/i18n/ui.js';

export type LiveObservation = 'live' | 'older-version-live' | 'not-live' | 'unknown';
export interface AvailablePublication {
  availability: 'available'; status: 'draft' | 'published';
  requestedLocales: ('de' | 'en')[]; committedLocales: ('de' | 'en')[];
  draftDiffers: boolean; live: { de: LiveObservation; en: LiveObservation };
}
export function publication(status: 'draft' | 'published' = 'published', draftDiffers = false): AvailablePublication {
  return { availability: 'available', status, requestedLocales: ['de', 'en'],
    committedLocales: status === 'published' ? ['de', 'en'] : [], draftDiffers,
    live: { de: status === 'published' ? 'live' : 'not-live', en: status === 'published' ? 'live' : 'not-live' } };
}
export function loadPublicationState(context: Record<string, unknown> = {}) {
  const ctx: Record<string, unknown> = {
    document: { documentElement: { lang: 'en' } },
    EditorCopy: Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [locale,
      Object.fromEntries(Object.entries(strings).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value]))])),
    ...context,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync('public/publication-state.js', 'utf8'), ctx);
  return ctx.PublicationState as {
    publicationState(value: unknown): string;
    label(value: unknown, admin?: boolean): string;
    newer(value: unknown): boolean;
    attention(value: unknown): boolean;
    summary(value: unknown): string;
    qualifiers(value: unknown, status: unknown): string;
  };
}
