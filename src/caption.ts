export interface Caption {
  altEn: string;
  altDe: string;
  slug: string;
}

export interface CaptionConfig {
  baseUrl: string;            // e.g. http://host.docker.internal:1234/v1
  model: string;              // e.g. qwen/qwen3-vl-4b
  timeoutMs?: number;         // default 60000
  fetchImpl?: typeof fetch;   // injected in tests
}

export class CaptionError extends Error {}

const PROMPT = [
  'You are writing alt text for a photo on a travel blog.',
  'Look at the image and respond with ONLY a JSON object, no prose, no code fences:',
  '{"altEn": "...", "altDe": "...", "slug": "..."}',
  '- altEn: concise, factual English alt text (max ~120 chars). Do NOT start with "image of" or "photo of".',
  '- altDe: the same scene described natively in German (write it directly, do not translate word-for-word).',
  '- slug: 2-4 word English kebab-case identifier (lowercase, hyphens).',
].join('\n');

/** lowercase, strip diacritics, replace runs of non-alphanumerics with single dashes. */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseCaption(content: string): Caption {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new CaptionError('no JSON object in caption response');
  let obj: { altEn?: unknown; altDe?: unknown; slug?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    throw new CaptionError('invalid JSON in caption response');
  }
  const altEn = String(obj.altEn ?? '').trim();
  const altDe = String(obj.altDe ?? '').trim();
  const slug = slugify(String(obj.slug ?? ''));
  if (!altEn || !altDe || !slug) throw new CaptionError('caption response missing required fields');
  return { altEn, altDe, slug };
}

export async function captionImage(jpeg: Buffer, cfg: CaptionConfig): Promise<Caption> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 60000);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new CaptionError(`caption request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new CaptionError(`caption request returned HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content ?? '';
  return parseCaption(content);
}
