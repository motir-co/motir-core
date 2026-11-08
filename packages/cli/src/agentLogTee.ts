import type { DispatchRunReporter } from './dispatchRunReporter.js';

// The AGENT LOG TEE (Story MOTIR-1789 · MOTIR-3961) — the producer for the
// `log` event kind, which shipped complete in every other respect and had no
// caller at all.
//
// ⚠️ WHAT WAS MISSING, because it explains the shape of this file. The schema
// carried `DispatchEventKind.log` ("The opt-in log body"), `--report-log` was
// on all three dispatch commands, `dispatchRunReporter` stripped `body`
// centrally when the flag was off, `dispatchRunSweep` deleted bodies after 30
// days, and `motir help` promised the operator all of it. Nothing in
// `packages/cli/src` ever emitted one: the emitted vocabulary was
// `run_opened` · `scope_claimed` · `snapshot_frozen` · `card_claimed` ·
// `card_skipped` · `checkout_ready` · `prompt_issued` · `agent_started` ·
// `agent_exited` · `leg_verdict` · `session_pr` · `plan_approved` ·
// `ci_verdict` · `card_settled` · `run_closed`, and the only
// `reporter.event({ kind: 'log' })` calls in the repository were in this
// package's own tests. A green unit test proves a method works when it is
// called; it never proves that anything calls it.
//
// ⚠️ IT BATCHES, AND THAT IS NOT AN OPTIMISATION. `dispatchRunReporter` bounds
// its queue at `REPORTER_QUEUE_LIMIT` and drops the OLDEST past it, so that the
// TAIL survives — "the half an operator opens a run page for". A fifty-minute
// agent run emits tens of thousands of lines; one event per line would blow
// through that bound thousands of times over and leave a queue holding the last
// few hundred LINES rather than the last few hundred KILOBYTES. Accumulating to
// a size threshold keeps the same bound holding a useful amount of transcript.

/**
 * Bytes of agent output that accumulate before one `log` event is queued — and the
 * LARGEST body one event ever carries (MOTIR-10705), measured in UTF-8 bytes, which is
 * what the server measures.
 *
 * Sized against the reporter's own queue rather than against latency: the pane
 * that reads these updates on the reporter's FLUSH cadence, not on this
 * threshold, so making it smaller buys no liveness and costs queue slots.
 *
 * ⚠️ IT IS A CEILING, NOT ONLY A TRIGGER. The tee used to send the WHOLE buffer once it
 * crossed this size, so one big write from the agent — a `prettier --write` file list, a
 * `tsc` out-of-memory trace — became one body of tens of kilobytes. The server refuses a
 * body over 16 KiB (`DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES`) and the refusal rejects the
 * whole batch; on a hosted run that ended in a stall kill fifteen minutes later. So a
 * big buffer is now CUT into pieces of at most this many bytes.
 */
export const LOG_CHUNK_BYTES = 4096;

/** The UTF-8 length of one code point — the arithmetic `Buffer.byteLength` does, a lone
 *  surrogate included (it is encoded as the three-byte replacement character). */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Cut `text` into the pieces one `log` event may carry: every piece but the last is at
 * most `limit` UTF-8 bytes, and `rest` — what is left once fewer than `limit` bytes
 * remain — is returned for the caller to keep buffering (or to send, at a flush).
 *
 * Each cut lands on a CODE-POINT boundary, so no piece carries half a character, and —
 * when the piece holds a line break — just after its LAST line break, because the run's
 * log pane renders one row per event and a row that starts mid-line reads as garbage. A
 * piece always holds at least one code point, so a limit smaller than a character cannot
 * stall the loop.
 */
export function splitLogBody(text: string, limit: number): { pieces: string[]; rest: string } {
  const pieces: string[] = [];
  // A text ending on a HIGH surrogate has the other half of that character still to come in
  // the next write; it stays in the rest, so no piece ends on half a character.
  const last = text.charCodeAt(text.length - 1);
  const scanEnd = last >= 0xd800 && last <= 0xdbff ? text.length - 1 : text.length;
  let start = 0;
  for (;;) {
    let bytes = 0;
    let end = start;
    let lastBreak = -1;
    while (end < scanEnd) {
      const codePoint = text.codePointAt(end)!;
      const width = utf8Length(codePoint);
      if (bytes + width > limit && end > start) break;
      bytes += width;
      end += codePoint > 0xffff ? 2 : 1;
      if (codePoint === 0x0a) lastBreak = end;
      if (bytes >= limit) break;
    }
    // The scan reached the end with fewer than `limit` bytes: that is the tail the caller
    // keeps. (A scan that stopped EARLY, because the next character would not fit, is a
    // full piece even when it is a byte or two short of the limit.)
    if (end >= scanEnd && bytes < limit) return { pieces, rest: text.slice(start) };
    const cut = lastBreak > start && lastBreak < end ? lastBreak : end;
    pieces.push(text.slice(start, cut));
    start = cut;
  }
}

/**
 * The longest a line of agent output waits for company before it is queued anyway
 * (MOTIR-8980). A streamed run writes a line when the agent acts — "Edit lib/x.ts" is
 * 20 bytes — and 4 KiB of those is minutes of work: the size threshold alone would
 * keep the first lines of a run back until long after they happened. The cap keeps the
 * reporter's bound meaningful: one event per interval at the very most, however
 * chatty the agent.
 */
export const LOG_FLUSH_MS = 2000;

export interface AgentLogTee {
  /** Take a chunk of the agent's output. Never throws. */
  write(chunk: string): void;
  /** Queue whatever is left. Call once, before the run's terminal event. */
  flush(): void;
}

export interface AgentLogTeeDeps {
  /** Queue one body. In production this is a `reporter.event` call. */
  emit: (body: string) => void;
  /** Overridden only by the tests. */
  chunkBytes?: number;
  /** Overridden only by the tests. */
  flushMs?: number;
}

export function createAgentLogTee(deps: AgentLogTeeDeps): AgentLogTee {
  const limit = deps.chunkBytes ?? LOG_CHUNK_BYTES;
  const waitMs = deps.flushMs ?? LOG_FLUSH_MS;
  let buffer = '';
  /** Armed by the first byte of a batch; sends it if the size threshold has not. */
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  // Reporting is an OBSERVATION of the run and may never change it: a throw
  // here would propagate out of a stream 'data' handler and take the dispatch
  // with it. Swallowed at the one place every chunk passes through, for the
  // same reason the body strip lives in one place — a call site that forgot
  // would be the bug.
  const send = (body: string): void => {
    if (body === '') return;
    try {
      deps.emit(body);
    } catch {
      /* best-effort, always */
    }
  };

  /** Send every whole piece the buffer holds, keeping the short tail buffered. */
  const sendFull = (): void => {
    const { pieces, rest } = splitLogBody(buffer, limit);
    if (pieces.length === 0) return;
    disarm();
    buffer = rest;
    for (const piece of pieces) send(piece);
  };
  /** Send everything, the tail included — every piece still within the ceiling. */
  const sendAll = (): void => {
    const { pieces, rest } = splitLogBody(buffer, limit);
    buffer = '';
    for (const piece of pieces) send(piece);
    send(rest);
  };

  return {
    write(chunk) {
      buffer += chunk;
      sendFull();
      // The tail a size cut leaves behind waits for company like any other short batch.
      if (timer !== null || buffer === '') return;
      timer = setTimeout(() => {
        timer = null;
        sendAll();
      }, waitMs);
      // Never the thing that keeps a finished process alive.
      timer.unref?.();
    },
    flush() {
      disarm();
      sendAll();
    },
  };
}

/**
 * The tee for ONE dispatched leg, or `null` when the operator did not ask for
 * log bodies.
 *
 * ⚠️ THE NULL IS ABOUT CAPTURE, NOT ABOUT PRIVACY, and the distinction is the
 * whole reason this reads `wantsLogBodies` rather than re-deriving the flag.
 * The scrub stays where it is — `dispatchRunReporter.event` strips `body` from
 * every event when the flag is off, and this file adds no second check and no
 * per-call-site branch. What it avoids is the WORK: without the opt-in, teeing
 * the agent's output would pipe every byte through this process to build events
 * whose bodies the reporter would then throw away.
 */
export function createLegLogTee(
  reporter: DispatchRunReporter,
  workItemKey: string,
): AgentLogTee | null {
  if (!reporter.wantsLogBodies) return null;
  return createAgentLogTee({
    emit: (body) => {
      reporter.event({ kind: 'log', workItemKey, body });
      // A `log` event waits for the reporter's next flush, which is the heartbeat — up to
      // a minute — so a batch would reach the run page long after the agent wrote it
      // (MOTIR-8980). The tee already batches, so this is at most one request per batch.
      void reporter.flush().catch(() => undefined);
    },
  });
}
