import 'server-only';
import { getJob } from '@/lib/ai/motirAiClient';
import type { JobStreamEvent } from '@/lib/ai/types';
import { parseWalkPosition, type JobWalkPosition } from '@/lib/planChange/failureRecord';
import { unwrapProgressFrame } from '@/lib/ai/sseFrames';

// Enrich a relayed job-stream frame with its terminal-failure REASON (Subtask
// 8.1.8). The raw `/v1/jobs/:id/stream` SSE protocol emits a `status` frame
// (`{ status: 'failed' }`) and a `done` frame when a job ends badly, but NOT the
// failure's problem+json — that lives only on `GET /v1/jobs/:id` (JobView.error).
// So a client watching the stream alone learns THAT a job failed, never WHY (e.g.
// out-of-credits vs a transient outage).
//
// This closes that gap inside motir-core (no motir-ai change): the stream ROUTE
// calls this for each frame it relays. On the terminal `failed` status it fetches
// the job's mapped error once and returns a synthesised `error` frame carrying
// the typed `code` — the SAME shape the routes already emit for a transport
// failure. Both SSE consumers (`useDiscoveryChat`, `useExplanationDraft`) already
// route an `error` frame's `code` into their error state, so a
// `MOTIR_AI_OUT_OF_CREDITS` refusal reaches the 8.1.8 paywall.
//
// It lives in the ROUTE relay loop (not a stream wrapper) deliberately: the route
// owns the upstream iterator, so a client disconnect still cancels it promptly —
// a wrapper generator parked on a hung upstream pull could not be returned in
// time. `readJobError` is injected so it is unit-testable without a live boundary.
export async function failureReasonFrame(
  jobId: string,
  frame: JobStreamEvent,
  // MOTIR-2359 — the default reader needs the caller's project, because `getJob`
  // now names the project it is reading FOR. Callers that inject their own reader
  // (the tests) are unaffected.
  coreProjectId: string,
  readJobError: (jobId: string) => Promise<{ code: string; message: string } | null> = async (
    id,
  ) => {
    const view = await getJob(id, coreProjectId);
    return view.error ? { code: view.error.code, message: view.error.message } : null;
  },
): Promise<JobStreamEvent | null> {
  if (frame.event !== 'status' || !isFailedStatus(frame.data)) return null;
  const reason = await readJobError(jobId).catch(() => null);
  if (!reason) return null;
  return { event: 'error', data: { code: reason.code, message: reason.message } };
}

function isFailedStatus(data: unknown): boolean {
  return (
    typeof data === 'object' && data !== null && (data as { status?: unknown }).status === 'failed'
  );
}

/**
 * Whether a relayed frame says the job ENDED BADLY — a `status` frame of
 * `failed` or `canceled` (story MOTIR-7630 · MOTIR-7638). The relay ends the
 * attempt's planning session on it, server-side, so a closed tab never loses
 * the end. A client disconnect is not a frame and ends nothing.
 */
export function isTerminalFailureFrame(frame: JobStreamEvent): boolean {
  if (frame.event !== 'status') return false;
  const status =
    typeof frame.data === 'object' && frame.data !== null
      ? (frame.data as { status?: unknown }).status
      : undefined;
  return status === 'failed' || status === 'canceled';
}

/** A relayed frame's terminal status — `failed`, `canceled`, or null for anything else. */
export function terminalStatusOf(frame: JobStreamEvent): 'failed' | 'canceled' | null {
  if (!isTerminalFailureFrame(frame)) return null;
  const status = (frame.data as { status?: unknown }).status;
  return status === 'canceled' ? 'canceled' : 'failed';
}

/** The position a `walk_position` progress frame names (MOTIR-7909), or null. */
export function walkPositionOf(frame: JobStreamEvent): JobWalkPosition | null {
  // A PROGRESS frame: motir-ai nests the position under `data` (MOTIR-10878).
  return frame.event === 'walk_position'
    ? parseWalkPosition(unwrapProgressFrame(frame.data))
    : null;
}
