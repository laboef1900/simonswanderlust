export interface BuildResult { ok: boolean; release?: string; error?: string }

export async function triggerBuild(builderUrl: string, secret: string, fetchImpl: typeof fetch = fetch): Promise<BuildResult> {
  try {
    const res = await fetchImpl(`${builderUrl.replace(/\/+$/, '')}/build`, {
      method: 'POST',
      headers: { 'x-build-secret': secret, 'content-type': 'application/json' },
    });
    const body = (await res.json().catch(() => ({}))) as { release?: string; error?: string };
    if (!res.ok) return { ok: false, error: body.error || `builder returned HTTP ${res.status}` };
    return { ok: true, release: body.release };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
