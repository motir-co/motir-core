import { unwrapProgressFrame } from '@/lib/ai/sseFrames';

export const OUT_OF_CREDITS_CODE = 'MOTIR_AI_OUT_OF_CREDITS';

export class PlanEditsClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    /** The refusal's parsed body, when a caller needs more than its code — a
     *  `409 PLAN_TARGET_LOCKED` names the holder and when it frees (MOTIR-7643). */
    readonly body: unknown = null,
  ) {
    super(`Plan edits request failed (${status})`);
    this.name = 'PlanEditsClientError';
  }

  get isOutOfCredits(): boolean {
    return this.status === 402 || this.code === OUT_OF_CREDITS_CODE;
  }
}

/**
 * What the plan-edit submit routes return. `planId` — the `generating`
 * Plan the job's proposals append into (MOTIR-1743) — is OPTIONAL on purpose:
 * it is an additive echo, and a caller must not depend on it (an E2E stub or a
 * pre-1743 response carries only `jobId`). Read it defensively.
 */
export interface PlanEditSubmitResponse {
  jobId: string;
  planId?: string;
}

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code ?? null;
  } catch {
    return null;
  }
}

export async function submitAugmentJob(
  prompt: string,
  signal?: AbortSignal,
): Promise<PlanEditSubmitResponse> {
  const res = await fetch('/api/ai/augment', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as PlanEditSubmitResponse;
}

export async function submitExpandJob(
  itemKey: string,
  signal?: AbortSignal,
): Promise<PlanEditSubmitResponse> {
  const res = await fetch('/api/ai/expand', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemKey }),
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as PlanEditSubmitResponse;
}

export async function streamAugmentJob(
  jobId: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
  /** Every non-terminal frame, in arrival order (MOTIR-1730). The `augment` job's
   *  SSE carries structured PROGRESS frames (`search` / `drill` / `level_complete`
   *  / `pass` / `planned` / `validated`), which the conversational rail narrates
   *  live while the delta is computed. Optional — the dock consumers ignore them. */
  onFrame?: (event: string, data: unknown) => void,
  /** The CONNECTION was lost (a thrown fetch / read), not the job (MOTIR-9186). See
   *  {@link consumeStream}. */
  onLost?: () => void,
): Promise<void> {
  return consumeStream(
    `/api/ai/augment/${encodeURIComponent(jobId)}/stream`,
    signal,
    onError,
    onDone,
    onFrame,
    onLost,
  );
}

/** The ASK stream (MOTIR-1819's relay, consumed by the conversation rail). Same
 *  SSE shape as `streamAugmentJob` — the same `streamJob` proxy, the same
 *  terminal `error` frame — over an `ask_project` job.
 *
 *  ⚠️ THE STREAM IS NOT THE ANSWER. What lands on the thread is filed by
 *  `settleAskJob`, which the caller invokes when this settles; a reader who took
 *  the streamed text as the deliverable would lose it on reload. */
export async function streamAskJob(
  jobId: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
  onFrame?: (event: string, data: unknown) => void,
): Promise<void> {
  return consumeStream(
    `/api/ai/ask/${encodeURIComponent(jobId)}/stream`,
    signal,
    onError,
    onDone,
    onFrame,
  );
}

/** The ITEM-ANCHORED stream (7.12.3 · MOTIR-909's relay, consumed by the
 *  MOTIR-910 entrance). Same SSE shape as `streamAugmentJob` — the job IS an
 *  ordinary `augment` — but subscribed through the anchored route, which re-gates
 *  the anchor on every subscribe. */
export async function streamContextualPlanJob(
  anchorId: string,
  jobId: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
  onFrame?: (event: string, data: unknown) => void,
  onLost?: () => void,
): Promise<void> {
  return consumeStream(
    `/api/work-items/${encodeURIComponent(anchorId)}/ai/plan/${encodeURIComponent(jobId)}/stream`,
    signal,
    onError,
    onDone,
    onFrame,
    onLost,
  );
}

/**
 * The ONE SSE consumer every job stream in the app goes through. Exported
 * (MOTIR-1750) so the sprint-planning client subscribes through it instead of
 * introducing a second streaming implementation — same frame parsing, same
 * `error` / `done` terminal contract, same abort semantics.
 *
 * ⚠️ A LOST CONNECTION IS NOT A FAILED JOB (MOTIR-9186). A `fetch` or `reader.read()`
 * that THROWS (a screen lock, a sleeping laptop, a dropped network) says nothing
 * about the job, and `onError` is the SERVER's word that it failed. A caller that
 * passes `onLost` hears the transport failure there and can ask the server what
 * became of the job; a caller that does not keeps the shipped behaviour, a lost
 * connection reported through `onError(null)`.
 */
export async function consumeStream(
  url: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
  onFrame?: (event: string, data: unknown) => void,
  onLost?: () => void,
): Promise<void> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      const code = await readErrorCode(res);
      onError(code);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = drainLocal(buffer);
      buffer = rest;
      for (const { event, data } of frames) {
        if (event === 'error') {
          onError((data as { code?: string } | null)?.code ?? null);
          return;
        }
        if (event === 'done') {
          onDone();
          return;
        }
        // motir-ai nests a progress frame's payload under `data` (MOTIR-10864); every
        // reader of these frames reads the payload's fields at the top level.
        onFrame?.(event, unwrapProgressFrame(data));
      }
    }
    onDone();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (onLost) onLost();
    else onError(null);
  }
}

interface SseFrame {
  event: string;
  data: unknown;
}

function drainLocal(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let sep = rest.indexOf('\n\n');
  while (sep !== -1) {
    const raw = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const parsed = parseLocal(raw);
    if (parsed) frames.push(parsed);
    sep = rest.indexOf('\n\n');
  }
  return { frames, rest };
}

function parseLocal(frame: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join('\n');
  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
    // leave as raw string
  }
  return { event, data };
}
