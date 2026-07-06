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

/** Index of the `}` that balances the `{` at `start`, or -1 if unbalanced.
 *  String-aware: braces inside string literals don't affect depth, so a `}`
 *  in a value (e.g. "a sign reading {closed}") won't end the object early. */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < s.length; j++) {
    const ch = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return j;
  }
  return -1;
}

/** Extract the first JSON object that carries a non-empty altEn + altDe from a
 *  model reply. Scans each `{`, matching braces string-aware, so it tolerates
 *  prose/code-fence wrapping, a stray `{…}` before the real object, and literal
 *  braces inside string values — cases a plain regex match mishandles. */
export function parseCaption(content: string): Caption {
  const s = String(content);
  let sawJson = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    const end = matchBrace(s, i);
    if (end < 0) break; // no balanced object from here on
    let obj: { altEn?: unknown; altDe?: unknown };
    try {
      obj = JSON.parse(s.slice(i, end + 1)) as { altEn?: unknown; altDe?: unknown };
    } catch {
      continue; // not valid JSON from this `{`; try the next one
    }
    sawJson = true;
    const altEn = String(obj.altEn ?? '').trim();
    const altDe = String(obj.altDe ?? '').trim();
    if (altEn && altDe) return { altEn, altDe };
  }
  throw new CaptionError(
    sawJson ? 'caption response missing required fields' : 'no JSON object in caption response',
  );
}
