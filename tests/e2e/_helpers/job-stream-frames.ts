// THE WIRE SHAPE of a relayed motir-ai job stream, for the e2e seams that play it
// (MOTIR-10880).
//
// motir-ai's `GET /v1/jobs/:id/stream` writes every PROGRESS frame as an envelope —
// `{ jobId, seq, data: <payload> }` (`motir-ai/src/app.ts`, `flushProgress`) — and
// core's stream routes relay that object unchanged. The job's own `status`, `done`
// and `error` frames carry no envelope. The browser readers unwrap the envelope
// through `lib/ai/sseFrames.ts`'s `unwrapProgressFrame`; a seam that wrote its
// progress frames flat would hand them a shape the real wire never sends, and the
// unwrap would never be crossed by a browser lane.
//
// So every e2e body that stands in for a job stream is written through here: the
// spec names the event and the payload the job emitted, and this writes it the way
// motir-ai does.

/** The job's own frames: written flat, exactly as motir-ai writes them. */
const UNENVELOPED_EVENTS: ReadonlySet<string> = new Set(['status', 'done', 'error']);

/** One job-stream frame on the wire. A progress frame is wrapped in motir-ai's
 *  `{ jobId, seq, data }` envelope; `status` / `done` / `error` are written flat. */
export function jobStreamFrame(event: string, data: unknown, jobId: string, seq: number): string {
  const wire = UNENVELOPED_EVENTS.has(event) ? data : { jobId, seq, data };
  return `event: ${event}\ndata: ${JSON.stringify(wire)}\n\n`;
}

/**
 * A whole job-stream body (for a `route.fulfill`): each frame in order, the
 * progress frames numbered `seq` 1, 2, 3… as motir-ai numbers a job's progress
 * rows. A `status` / `done` / `error` frame takes no number.
 */
export function jobStreamBody(
  jobId: string,
  frames: readonly (readonly [event: string, data: unknown])[],
): string {
  let seq = 0;
  return frames
    .map(([event, data]) =>
      jobStreamFrame(event, data, jobId, UNENVELOPED_EVENTS.has(event) ? seq : (seq += 1)),
    )
    .join('');
}

/** Whether `event` is one of the job's own, unenveloped frames. */
export function isUnenvelopedEvent(event: string): boolean {
  return UNENVELOPED_EVENTS.has(event);
}
