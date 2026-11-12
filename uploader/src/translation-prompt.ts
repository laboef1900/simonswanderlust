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

// C0/C1 controls other than tab, newline and carriage return; the same class the
// transport refuses in model output.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
// Lone surrogates are not text a provider can read.
const LONE_SURROGATE = /\p{Cs}/u;
// At least one character a reader can see: not whitespace, a control, an
// invisible format character (zero-width space, word joiner, soft hyphen…), a
// default-ignorable code point (Hangul filler, variation selector…) or the
// blank Braille pattern.
const VISIBLE = /[^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/u;

/**
 * Visible plain text of at most `max` UTF-16 units; never coerced. The one
 * owner-instruction rule shared by translation (#567) and story drafting (#579);
 * mirrored by `instructionProblem` in `uploader/public/llm.js`.
 */
export function isInstructionText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max &&
    !CONTROL.test(v) && !LONE_SURROGATE.test(v) && VISIBLE.test(v);
}

/** Visible plain text within the cap; never coerced. Mirrored by `LLM.isTranslationPrompt`. */
export function isTranslationPrompt(v: unknown): v is string {
  return isInstructionText(v, TRANSLATION_PROMPT_MAX_LENGTH);
}
