import { isInstructionText } from './translation-prompt.js';

/**
 * #579: the owner-editable style and length guidance for Story drafting. It is
 * only the leading part of the system message: `uploader/public/llm.js`
 * `draftArticle()` always appends the language, the untrusted-input guard and
 * the JSON contract after it. The browser mirrors the rule in `LLM.isDraftingPrompt`.
 */
export const DEFAULT_DRAFTING_PROMPT = 'Write a first draft of a personal travel story in the first person, ' +
  'in a warm, observant and honest voice. Follow the events in the order given and connect them into one ' +
  'readable narrative with a few descriptive subheadings. Aim for about 800–1500 words. Mention practical ' +
  'details only where the events or story details give them. Make the excerpt a short teaser for story ' +
  'cards and search results.';

/** UTF-16 code units (`String.length`), the unit of the browser counter. */
export const DRAFTING_PROMPT_MAX_LENGTH = 4000;

/** Visible plain text within the cap (the #567 rule); never coerced. Mirrored by `LLM.isDraftingPrompt`. */
export function isDraftingPrompt(v: unknown): v is string {
  return isInstructionText(v, DRAFTING_PROMPT_MAX_LENGTH);
}
