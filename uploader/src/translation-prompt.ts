/**
 * #567: the owner-editable house guidance for Article translation. It is only
 * the leading part of the system message: `uploader/public/llm.js`
 * `translateArticle()` always appends the faithful-translation direction, the
 * untrusted-input guard and the JSON slot contract after it.
 * The browser mirrors the rule in `LLM.isTranslationPrompt`.
 */
export const DEFAULT_TRANSLATION_PROMPT = 'Preserve meaning, facts, names and detail; do not summarize, omit or invent content.';

/** UTF-16 code units (`String.length`), the unit of the slot budget and the browser counter. */
export const TRANSLATION_PROMPT_MAX_LENGTH = 4000;

/** A string with visible content, at most the cap; never coerced. */
export function isTranslationPrompt(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= TRANSLATION_PROMPT_MAX_LENGTH;
}
