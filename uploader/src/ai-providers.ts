import { randomBytes } from 'node:crypto';

/**
 * AI provider registry: the non-sensitive half of every AI destination. Keys
 * live encrypted in `app_secrets`, one slot per remote provider.
 * @ai-context docs/superpowers/specs/2026-10-19-ai-provider-registry-design.md
 */

export type AiProviderKind = 'lm-studio' | 'openrouter' | 'deepseek' | 'custom';

export interface AiProvider {
  /** Server-assigned, immutable; the ONLY input a secret slot name is built from. */
  id: string;
  name: string;
  /** Immutable after creation. `lm-studio` is local and never holds a key. */
  kind: AiProviderKind;
  baseUrl: string;
}

export const MAX_AI_PROVIDERS = 20;
export const MAX_PROVIDER_NAME = 60;
export const MAX_PROVIDER_URL = 300;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Pre-fill for Add (UI) and the destination of a derived legacy preset. `custom` must be entered. */
export const PRESET_BASE_URLS: Readonly<Record<AiProviderKind, string>> = {
  'lm-studio': 'http://localhost:1234/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  custom: '',
};

/**
 * The single slot the pre-registry app kept its one shared key in. Read only by
 * the boot migration, which deletes it.
 */
export const LEGACY_AI_KEY_SLOT = 'ai_api_key';

/** The settings.json fields the registry replaced; their presence marks a legacy file. */
export const LEGACY_AI_FIELDS = ['lmBaseUrl', 'captionProvider', 'captionCustomBaseUrl', 'aiProvider', 'aiCustomBaseUrl'] as const;

export function defaultProviders(): AiProvider[] {
  return [{ id: 'lm-studio', name: 'Local LM Studio', kind: 'lm-studio', baseUrl: PRESET_BASE_URLS['lm-studio'] }];
}

export function isProviderKind(v: unknown): v is AiProviderKind {
  return v === 'lm-studio' || v === 'openrouter' || v === 'deepseek' || v === 'custom';
}

export function isProviderId(v: unknown): v is string {
  return typeof v === 'string' && PROVIDER_ID_RE.test(v);
}

/** Remote kinds may hold a key; a local LM Studio provider never does. */
export function isRemoteKind(kind: AiProviderKind): boolean {
  return kind !== 'lm-studio';
}

/** Fixed messages: never echo a submitted name or URL. */
export function providerNameError(v: unknown): string | null {
  return typeof v === 'string' && v === v.trim() && v.length >= 1 && v.length <= MAX_PROVIDER_NAME && !/\p{C}/u.test(v)
    ? null : `AI provider name must be 1–${MAX_PROVIDER_NAME} characters without control characters.`;
}

export function providerUrlError(v: unknown): string | null {
  const reason = `AI provider base URL must be an absolute HTTP(S) URL of at most ${MAX_PROVIDER_URL} characters, without credentials, query, or fragment.`;
  // `?`/`#` are refused as characters: `new URL('https://x/v1?')` reports an
  // empty `search`, so the parsed check alone would keep a bare delimiter.
  if (typeof v !== 'string' || v === '' || v.length > MAX_PROVIDER_URL || /[\p{C}\s?#]/u.test(v)) return reason;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return reason;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return reason;
  return null;
}

function providerError(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'Each AI provider must be an object.';
  const p = v as Record<string, unknown>;
  if (!isProviderId(p.id)) return 'AI provider id is invalid.';
  if (!isProviderKind(p.kind)) return 'AI provider kind must be lm-studio, openrouter, deepseek, or custom.';
  return providerNameError(p.name) ?? providerUrlError(p.baseUrl);
}

/** The whole registry as ONE settings field: shape, limits, unique ids and names. */
export function validateProviders(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_AI_PROVIDERS) {
    return `Configure between 1 and ${MAX_AI_PROVIDERS} AI providers.`;
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of v) {
    const reason = providerError(entry);
    if (reason) return reason;
    const p = entry as AiProvider;
    if (ids.has(p.id)) return 'AI provider ids must be unique.';
    ids.add(p.id);
    const name = p.name.toLowerCase();
    if (names.has(name)) return 'AI provider names must be unique.';
    names.add(name);
  }
  return null;
}

/** Copy only the four registry fields; call after validateProviders accepted `providers`. */
export function cleanProviders(providers: readonly AiProvider[]): AiProvider[] {
  return providers.map(({ id, name, kind, baseUrl }) => ({ id, name, kind, baseUrl }));
}

/**
 * @ai-warning Every slot name MUST come from here, and only for an id that was
 * found in the registry: a client string never becomes a slot name.
 */
export function slotFor(id: string): string {
  if (!isProviderId(id)) throw new Error('invalid AI provider id');
  return `ai_provider_key:${id}`;
}

/**
 * `null` follows the default. Validation guarantees a hit; a miss is an
 * invariant failure (500), never a silent fallback to another destination.
 */
export function resolveProvider(
  settings: { aiProviders: readonly AiProvider[]; aiDefaultProviderId: string },
  useCaseProviderId: string | null,
): AiProvider {
  const id = useCaseProviderId ?? settings.aiDefaultProviderId;
  const provider = settings.aiProviders.find((p) => p.id === id);
  if (!provider) throw new Error('AI provider registry invariant violated');
  return provider;
}

/** `p-` + 8 hex chars, regenerated on collision with an existing id. */
export function newProviderId(existing: readonly AiProvider[]): string {
  for (;;) {
    const id = `p-${randomBytes(4).toString('hex')}`;
    if (!existing.some((p) => p.id === id)) return id;
  }
}

/** A settings.json without `aiProviders` that still carries a pre-registry AI field. */
export function isLegacyAiSettings(raw: Record<string, unknown>): boolean {
  return !Object.hasOwn(raw, 'aiProviders') && LEGACY_AI_FIELDS.some((field) => Object.hasOwn(raw, field));
}

export interface LegacyDerivation {
  aiProviders: AiProvider[];
  aiDefaultProviderId: string;
  reviewProviderId: string | null;
  captionProviderId: string | null;
  /** Remote providers a feature had SELECTED: exactly the destinations that already received the shared key. */
  keyedProviderIds: string[];
}

const PRESET_NAMES: Readonly<Record<'openrouter' | 'deepseek', string>> = { openrouter: 'OpenRouter', deepseek: 'DeepSeek' };

/** A legacy URL the registry would refuse falls back like today's field-by-field recovery. */
function legacyUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return providerUrlError(trimmed) === null ? trimmed : null;
}

/**
 * Pure derivation of the registry from a pre-registry settings.json (spec §5
 * step 1). Ids are deterministic so a run that crashed after the secret copy
 * derives the same slots again.
 */
export function deriveFromLegacy(raw: Record<string, unknown>): LegacyDerivation {
  const reviewKind = isProviderKind(raw.aiProvider) ? raw.aiProvider : 'lm-studio';
  const captionKind = isProviderKind(raw.captionProvider) ? raw.captionProvider : 'lm-studio';
  const reviewCustom = legacyUrl(raw.aiCustomBaseUrl);
  const captionCustom = legacyUrl(raw.captionCustomBaseUrl);

  const providers: AiProvider[] = [{
    id: 'lm-studio', name: 'Local LM Studio', kind: 'lm-studio',
    baseUrl: legacyUrl(raw.lmBaseUrl) ?? PRESET_BASE_URLS['lm-studio'],
  }];
  for (const kind of [reviewKind, captionKind]) {
    if ((kind === 'openrouter' || kind === 'deepseek') && !providers.some((p) => p.id === kind)) {
      providers.push({ id: kind, name: PRESET_NAMES[kind], kind, baseUrl: PRESET_BASE_URLS[kind] });
    }
  }
  // Every distinct custom URL is kept, selected or not, so no configured value
  // is lost; only a SELECTED one is keyed below.
  const customIdByUrl = new Map<string, string>();
  for (const url of [reviewCustom, captionCustom]) {
    if (url === null || customIdByUrl.has(url)) continue;
    const n = customIdByUrl.size + 1;
    const id = n === 1 ? 'custom' : `custom-${n}`;
    customIdByUrl.set(url, id);
    providers.push({ id, name: n === 1 ? 'Custom' : `Custom ${n}`, kind: 'custom', baseUrl: url });
  }

  const selected = (kind: AiProviderKind, customUrl: string | null): string => {
    if (kind === 'openrouter' || kind === 'deepseek') return kind;
    // A selected custom with no usable URL was legacy-valid but could not be
    // called; it lands on the local provider, which never receives a key.
    if (kind === 'custom' && customUrl !== null) return customIdByUrl.get(customUrl) ?? 'lm-studio';
    return 'lm-studio';
  };
  const reviewId = selected(reviewKind, reviewCustom);
  const captionId = selected(captionKind, captionCustom);
  const keyedProviderIds = [...new Set([reviewId, captionId])]
    .filter((id) => providers.some((p) => p.id === id && isRemoteKind(p.kind)));
  return {
    aiProviders: providers,
    aiDefaultProviderId: reviewId,
    reviewProviderId: reviewId,
    captionProviderId: captionId,
    keyedProviderIds,
  };
}
