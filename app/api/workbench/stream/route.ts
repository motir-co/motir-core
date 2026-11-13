import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { projectsService } from '@/lib/services/projectsService';
import { workbenchWatermarkService } from '@/lib/services/workbenchWatermarkService';
import type { WorkbenchWatermarkDto } from '@/lib/dto/workbench';
import { withRequestLabel } from '@/lib/monitoring/requestLabel';
import { getLiveSignalHub } from '@/lib/live/liveSignalHub';
import { createWorkbenchStreamSession } from '@/lib/workbench/workbenchStreamSession';
import { planReviewService } from '@/lib/services/planReviewService';
import {
  parseWatchParams,
  WORKBENCH_STREAM_PLAN_FRAME,
  type WorkbenchStreamPlanFrame,
} from '@/lib/workbench/planWatch';

// GET /api/workbench/stream (Story MOTIR-5238 · MOTIR-5241) — the Workbench's
// LIVE TAIL, as Server-Sent Events.
//
// ⚠️ THIS MIRRORS `app/api/dispatch-runs/[id]/stream/route.ts`, which mirrors
// `app/api/ai/plan/generate/[jobId]/stream/route.ts` before it. That route's own
// header states the reason and it is copied here rather than re-derived: *"a
// SECOND streaming convention in one codebase means two heartbeat intervals, two
// frame formats, and two sets of proxy-timeout bugs to learn about
// separately."* What is identical: the frame format (`event:` + `data:` JSON
// through a local `formatFrame`), the `SSE_HEADERS` set, the
// gate-BEFORE-the-stream-opens ordering, the `:` comment heartbeat, and a
// `cancel()` that ends everything the stream started.
//
// ── PUSHED, NOT POLLED (Story MOTIR-8542 · MOTIR-8729) ──────────────────────
//
// This stream used to re-read the reader's watermark once a second, which on a
// thousand open tabs was a thousand transactions a second asking a question
// whose answer was almost always "no". It now asks only when told to: every
// committed write to a watermark input fires a Postgres trigger
// (`20261015230000_live_signal_triggers`), the process's one listener
// (`lib/live/liveSignalHub.ts`) hears it, and the stream's session
// (`lib/workbench/workbenchStreamSession.ts`) re-reads once per coalesced window
// on its project, once after the listener reconnects, and once a
// `WORKBENCH_STREAM_BACKSTOP_MS` otherwise. A quiet tab costs a heartbeat every
// fifteen seconds and one read a minute. The route itself stays a thin adapter:
// gate, resolve the project, open the session, turn its readings into frames.
//
// THE CURSOR IS A WATERMARK, NOT A SEQUENCE. A run resumes from `seq` on an
// append-only table, and `@@unique([dispatchRunId, seq])` is the guarantee that
// makes a reconnect neither a replay nor a gap. The Workbench has no such table
// and this story adds none. What replaces that guarantee is IDEMPOTENCE BY
// CONSTRUCTION: the cursor names a STATE rather than a position, the frame
// carries an INVALIDATION rather than data, and the client re-reads whatever the
// frame names — so replaying a cursor costs a redundant read and can never
// produce a duplicate row. A reader looking here for the run stream's uniqueness
// guarantee should find this paragraph instead.
//
// THERE IS NO TERMINAL STATE. A run ends; a Workbench does not. So there is no
// `done` frame and the stream runs until the reader leaves — which makes
// `cancel()` load-bearing here in a way it is not there. Without it the session
// stays subscribed and keeps re-reading the database for somebody who has closed
// the tab, and nothing would ever stop it.
//
// PLAN FRAMES RIDE THE SAME STREAM (MOTIR-8730). A tab names the plans it is
// watching on the URL (`?watch=<planId>:<reviewVersion>`, at most ten, parsed by
// `lib/workbench/planWatch.ts`; anything malformed is a 400 BEFORE the first
// read). A notification about a watched plan makes the session read that plan's
// review version under the reader's own admission, and a `plan` frame
// `{ planId, reviewVersion }` is written only when it moved. A plan the reader
// may not see answers nothing at all — no frame, no error, no hint it exists.
//
// THE FRAME CARRIES NO CONTENT — which tabs moved, and the new cursor; for a
// plan, its id and review version. Nothing else. A reader therefore receives nothing their own reads would not return,
// and the access decision stays in those reads rather than being made a second
// time here.
//
// AND IT KEEPS NO PER-CONNECTION STATE BEYOND THE CURSOR. A route that remembers
// what it has sent is a route that is wrong after a redeploy, and wrong
// per-connection rather than visibly.

/** Serialise one event as an SSE frame — the shipped format, unchanged. */
function formatFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

// The push cadence, exported from here so the tests read the numbers from the
// route they are about.
export { WORKBENCH_STREAM_BACKSTOP_MS } from '@/lib/workbench/workbenchStreamSession';
export { WORKBENCH_STREAM_COALESCE_MS } from '@/lib/workbench/workbenchStreamCoalescer';

/**
 * How often a silent stream writes a comment frame.
 *
 * A Workbench can be quiet for hours — most of them are, most of the time — and
 * an idle connection is exactly what a proxy in front of the app closes. The
 * heartbeat is a `:` comment rather than an event, so a client's frame parser
 * never surfaces it and no consumer has to learn to ignore it.
 */
export const WORKBENCH_STREAM_HEARTBEAT_MS = 15_000;

/** The frame this route writes. Named so the client and the tests agree on it. */
export const WORKBENCH_STREAM_FRAME = 'watermark';

/** What a frame carries: which tabs moved, and the cursor to present next time. */
export interface WorkbenchStreamFrame {
  moved: WorkbenchWatermarkDto['moved'];
  cursor: string;
}

export async function GET(req: Request): Promise<Response> {
  // The label covers the whole response lifetime: `ReadableStream`'s `start`
  // runs inside it, so every re-read's watermark read is recorded as
  // `workbench_stream` (MOTIR-8553).
  return withRequestLabel({ route: 'workbench_stream' }, () => openStream(req));
}

async function openStream(req: Request): Promise<Response> {
  // ⚠️ THE GATE RUNS BEFORE ANYTHING IS WRITTEN. A session, 2FA-hold or
  // tenancy refusal is a real HTTP status with a JSON body, so no frame is ever
  // written to a reader who may not see the data — the shipped route's ordering,
  // and the reason it is an ordering rather than a check.
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  // The reader's ACTIVE project, resolved through the same service the Workbench
  // page resolves it through. A reader with none is answered with a status
  // rather than an empty stream: unreachable for a signed-in member (MOTIR-4870
  // seeds a default project at the workspace tier), and a stream that opened and
  // then said nothing for ever would be the worst way to express it.
  const project = await projectsService.getActiveProject(ctx.userId, ctx.workspaceId);
  if (!project) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project for this reader.' },
      { status: 404 },
    );
  }
  const actor = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };

  const params = new URL(req.url).searchParams;
  const since = params.get('since');

  // The watched-plan set is validated AFTER the gate and BEFORE any read, so a
  // malformed one is a status with a JSON body and never a stream.
  const watched = parseWatchParams(params);
  if (!Array.isArray(watched)) {
    return NextResponse.json({ code: 'INVALID_WATCH', error: watched.error }, { status: 400 });
  }

  // ⚠️ A READER WHO HAS ALREADY LEFT NEVER SUBSCRIBES (MOTIR-8568).
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const encoder = new TextEncoder();
  // ⚠️ TWO SIGNALS SAY THE READER HAS GONE, AND EITHER ONE ENDS THE SESSION
  // (MOTIR-8568). `cancel()` fires when the stream is cancelled — once the
  // response is being piped. The REQUEST's abort signal fires when the
  // connection closes, which is the only one of the two that fires for a reader
  // who left BEFORE the handler returned this Response: Next never starts
  // piping a response whose connection already closed, so nothing ever cancels
  // the stream. Measured on a built server before that fix: a reader leaving
  // 50ms after the request went out was still being polled once a second 38s
  // later. With push there is no loop to keep running, but a session left
  // subscribed is the same leak in another form.
  let cancelled = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  // Frames a re-read produced before the stream existed: a write that committed
  // during the opening read is read straight after it, and that frame must
  // follow the opening frame, never precede it or be lost.
  const pending: string[] = [];
  let heartbeat: ReturnType<typeof setTimeout> | undefined;

  const gone = (): boolean => cancelled || req.signal.aborted;

  // A write after the reader left is dropped rather than thrown: the controller
  // of a cancelled stream rejects `enqueue`, and the departure is the most
  // ordinary event in this stream's life.
  const write = (frame: string): void => {
    if (gone()) return;
    if (!controller) {
      pending.push(frame);
      return;
    }
    controller.enqueue(encoder.encode(frame));
    armHeartbeat();
  };

  // A Workbench can be quiet for hours, and an idle connection is exactly what
  // a proxy in front of the app closes — so a silent stream writes a `:` comment
  // `WORKBENCH_STREAM_HEARTBEAT_MS` after its last write. Re-armed on every
  // write, so a busy stream never writes one.
  function armHeartbeat(): void {
    if (heartbeat !== undefined) clearTimeout(heartbeat);
    heartbeat = setTimeout(() => {
      heartbeat = undefined;
      write(': heartbeat\n\n');
    }, WORKBENCH_STREAM_HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  const emit = (reading: WorkbenchWatermarkDto): void =>
    write(formatFrame(WORKBENCH_STREAM_FRAME, { moved: reading.moved, cursor: reading.cursor }));

  const session = createWorkbenchStreamSession({
    actor,
    hub: getLiveSignalHub(),
    // Every re-read is the reader's own read, under their own workspace context.
    read: (reader, cursor) => workbenchWatermarkService.read(reader, cursor),
    write: emit,
    watched,
    // The plan read is the reader's own, behind the review read's admission.
    readPlan: (planId) => planReviewService.readReviewVersionForReader(planId, ctx),
    writePlan: (frame: WorkbenchStreamPlanFrame) =>
      write(
        formatFrame(WORKBENCH_STREAM_PLAN_FRAME, {
          planId: frame.planId,
          reviewVersion: frame.reviewVersion,
        }),
      ),
  });

  // ⚠️ ENDING WAITS FOR A READ ALREADY RUNNING (MOTIR-8812). Everything else
  // stops at once, but a re-read the session started before the reader left is
  // a transaction under their context; `end()` answers the session's settle, so
  // the stream's `cancel()` resolves only once that transaction has closed.
  let ending: Promise<void> | undefined;
  const end = (): Promise<void> => {
    if (ending) return ending;
    ending = session.close();
    if (heartbeat !== undefined) clearTimeout(heartbeat);
    heartbeat = undefined;
    req.signal.removeEventListener('abort', onAbort);
    // A controller whose stream was CANCELLED is already closed; closing it
    // again throws, and a throw here would be an unhandled rejection on a
    // disconnect — the most ordinary event in this stream's life.
    if (controller && !cancelled) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
    return ending;
  };
  const onAbort = (): void => void end();
  req.signal.addEventListener('abort', onAbort, { once: true });

  // The OPENING read happens BEFORE the stream is constructed, so a failure in
  // it is a real status rather than a stream that opens and immediately errors.
  let first: WorkbenchWatermarkDto;
  try {
    first = await session.start(since);
  } catch (err) {
    await end();
    throw err;
  }

  // ⚠️ A READER WHO LEFT WHILE THE GATE OR THE FIRST READ WAS IN FLIGHT gets
  // no stream at all, and the session is already closed by the abort above.
  if (req.signal.aborted) {
    await end();
    return new Response(null, { status: 204 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      // ⚠️ THE OPENING FRAME IS WRITTEN EVEN WHEN NOTHING MOVED, and that is
      // what makes a reconnect work at all: it is how a client LEARNS the
      // cursor it will present next time. It carries `moved: []` for a reader
      // who presented no cursor and for one whose cursor is current, so a
      // reconnect that has missed nothing asks the client to do nothing.
      emit(first);
      for (const frame of pending.splice(0)) write(frame);
    },
    cancel() {
      cancelled = true;
      return end();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
