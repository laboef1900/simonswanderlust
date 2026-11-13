/** Shared strict JSON/token validation guards used across Fastify route modules. */

export const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STRICT_ISO_UTC_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isStrictIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !STRICT_ISO_UTC_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

export function parseStrictIsoUtc(value: unknown): Date | null {
  return isStrictIsoUtc(value) ? new Date(value) : null;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
