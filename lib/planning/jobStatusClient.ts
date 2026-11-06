/**
 * Whether a Motir job has ENDED (MOTIR-10453), read through `GET /api/ai/jobs/[jobId]`.
 *
 * `true` when the job is terminal, `false` while it is `queued` or `running`, and `null`
 * when the status cannot be read. A caller that must not act on a finished job treats
 * `null` as "do not know" and decides for itself.
 */
export async function isJobOver(jobId: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const res = await fetch(`/api/ai/jobs/${encodeURIComponent(jobId)}`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const { status } = (await res.json()) as { status?: unknown };
    if (status === 'queued' || status === 'running') return false;
    if (status === 'succeeded' || status === 'failed' || status === 'canceled') return true;
    return null;
  } catch {
    return null;
  }
}
