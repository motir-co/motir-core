import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import type { SharpenAction } from '@/lib/ai/types';
import type { SharpenDoorResult, SharpenSessionDto, SharpenSettleResult } from '@/lib/dto/sharpen';

// The browser's half of the SHARPEN door (Task MOTIR-1101 · Subtask MOTIR-8181) —
// the bodies `POST /api/ai/sharpen` takes, the settle that stores a finished turn,
// and the two reads. The Sharpen UI's hook calls ONLY this file.
//
// Errors arrive as the shipped `PlanEditsClientError`, carrying the route's
// `code` (`SHARPEN_TURN_IN_FLIGHT`, `SHARPEN_SESSION_ENDED`, …), so the
// out-of-credits test every planning surface uses applies here too.

export type SharpenTarget = { planId: string } | { conversationId: string };

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code ?? null;
  } catch {
    return null;
  }
}

async function call<T>(
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method: init.method,
    headers: {
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as T;
}

/** OPEN a Sharpen session on a plan or a conversation — resumes the caller's open
 *  one (`outcome: 'resumed'`, nothing sent), else starts one and its first job. */
export function openSharpen(target: SharpenTarget, signal?: AbortSignal) {
  return call<SharpenDoorResult>('/api/ai/sharpen', { method: 'POST', body: target }, signal);
}

/** ACT on the pending question. `readingId` with `answer`; `text` with `own_words`. */
export function sharpenAct(
  sessionId: string,
  action: Exclude<SharpenAction, 'start'>,
  opts: { readingId?: string; text?: string } = {},
  signal?: AbortSignal,
) {
  return call<SharpenDoorResult>(
    '/api/ai/sharpen',
    { method: 'POST', body: { sessionId, action, ...opts } },
    signal,
  );
}

/** Re-run a turn whose submit or job failed (Try again). Replay-safe. */
export function resubmitSharpen(sessionId: string, turnId: string, signal?: AbortSignal) {
  return call<SharpenDoorResult>(
    '/api/ai/sharpen',
    { method: 'POST', body: { sessionId, turnId } },
    signal,
  );
}

/** Store a finished job's result. `pending` until the job ends; replayable. */
export function settleSharpen(sessionId: string, jobId: string, signal?: AbortSignal) {
  return call<SharpenSettleResult>(
    '/api/ai/sharpen/settle',
    { method: 'POST', body: { sessionId, jobId } },
    signal,
  );
}

/** One of the caller's sessions, as the server holds it. */
export function getSharpenSession(sessionId: string, signal?: AbortSignal) {
  return call<SharpenSessionDto>(
    `/api/ai/sharpen/${encodeURIComponent(sessionId)}`,
    { method: 'GET' },
    signal,
  );
}

/** The caller's OPEN session on a target, or null. */
export function getOpenSharpen(target: SharpenTarget, signal?: AbortSignal) {
  const query =
    'planId' in target
      ? `planId=${encodeURIComponent(target.planId)}`
      : `conversationId=${encodeURIComponent(target.conversationId)}`;
  return call<SharpenSessionDto | null>(`/api/ai/sharpen?${query}`, { method: 'GET' }, signal);
}

/** The caller's LATEST session on a conversation, open or ended, or null. */
export function getLatestConversationSharpen(conversationId: string, signal?: AbortSignal) {
  return call<SharpenSessionDto | null>(
    `/api/ai/sharpen?conversationId=${encodeURIComponent(conversationId)}&latest=1`,
    { method: 'GET' },
    signal,
  );
}
