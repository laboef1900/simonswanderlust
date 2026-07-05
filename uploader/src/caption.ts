// Prompt + response parser for browser-direct AI alt text. This module holds NO
// network code — the model is called from the browser (see public/llm.js); this
// is the canonical, unit-tested parse contract that llm.js mirrors, and the
// source of the default caption prompt used by settings.ts.

export const DEFAULT_PROMPT = [
  'You are writing alt text for a photo on a travel blog.',
  'Look at the image and respond with ONLY a JSON object, no prose, no code fences:',
  '{"altEn": "...", "altDe": "..."}',
  '- altEn: concise, factual English alt text (max ~120 chars). Do NOT start with "image of" or "photo of".',
  '- altDe: the same scene described natively in German (write it directly, do not translate word-for-word).',
].join('\n');

export class CaptionError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'CaptionError';
  }
}

export interface Caption {
  altEn: string;
  altDe: string;
}

/** Extract the first {…} JSON object from a model reply and require non-empty
 *  altEn + altDe. Tolerates prose/code-fence wrapping around the object. */
export function parseCaption(content: string): Caption {
  const match = content.match(/\{[\s\S]*?\}/);
  if (!match) throw new CaptionError('no JSON object in caption response');
  let obj: { altEn?: unknown; altDe?: unknown };
  try {
    obj = JSON.parse(match[0]) as { altEn?: unknown; altDe?: unknown };
  } catch {
    throw new CaptionError('invalid JSON in caption response');
  }
  const altEn = String(obj.altEn ?? '').trim();
  const altDe = String(obj.altDe ?? '').trim();
  if (!altEn || !altDe) throw new CaptionError('caption response missing required fields');
  return { altEn, altDe };
}
