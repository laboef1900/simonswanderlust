export interface BuildResult { ok: boolean; release?: string; error?: string }

// The builder responds only after the full astro build finishes, so allow a
// generous default; the timeout exists to stop the uploader hanging forever if
// the builder dies mid-request.
const DEFAULT_BUILD_TIMEOUT_MS = 300_000;

export async function triggerBuild(
  builderUrl: string, secret: string,
  fetchImpl: typeof fetch = fetch, timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
): Promise<BuildResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${builderUrl.replace(/\/+$/, '')}/build`, {
      method: 'POST',
      headers: { 'x-build-secret': secret, 'content-type': 'application/json' },
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { release?: string; error?: string };
    if (!res.ok) return { ok: false, error: body.error || `builder returned HTTP ${res.status}` };
    return { ok: true, release: body.release };
  } catch (e) {
    if ((e as Error).name === 'AbortError' || controller.signal.aborted) {
      return { ok: false, error: `build request timed out after ${timeoutMs}ms` };
    }
    return { ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
