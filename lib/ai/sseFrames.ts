// Client-side Server-Sent-Events frame parsing — shared by every browser
// consumer of a motir-ai job stream (the `useExplanationDraft` draft hook, the
// `useDiscoveryChat` onboarding loop, and — for the progress-envelope unwrap —
// the planning streams' `consumeStream`). The server side has its own parser in
// `lib/ai/motirAiClient.ts` (Node stream); this is the DOM `fetch().body` reader
// counterpart. Pure + browser-safe (no imports) so it unit-tests trivially.
//
// Frames are `event: <name>\ndata: <json>\n\n` (see the chat/explanation stream
// routes' `formatFrame`). A frame may carry a multi-line `data:`; comment lines
// (`:`-prefixed keep-alives) are ignored. `data` is JSON-parsed when possible,
// else left as the raw string.

export interface SseFrame {
  event: string;
  data: unknown;
}

/** Parse one raw SSE frame (no trailing blank line) into `{ event, data }`, or
 *  `null` when it carries no `data:` line. */
export function parseSseFrame(frame: string): SseFrame | null {
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
    // leave as the raw string
  }
  return { event, data };
}

const PROGRESS_ENVELOPE_KEYS: ReadonlySet<string> = new Set(['jobId', 'seq', 'data']);

/**
 * The payload of a motir-ai PROGRESS frame, read through its envelope
 * (MOTIR-10878).
 *
 * motir-ai's `GET /v1/jobs/:id/stream` writes every progress frame as
 * `{ jobId, seq, data: <payload> }` (`motir-ai/src/app.ts`, `flushProgress`), and
 * core's stream routes relay that object unchanged. The job's own `status`
 * (`{ jobId, status }`), `done` and `error` frames carry no envelope. A reader
 * that wants the fields the job emitted (`token.text`, `docs.docs`, …) reads
 * them here, never at the top level of the relayed frame.
 *
 * Only the exact envelope is unwrapped — a numeric `seq`, an object `data`, and
 * no key beside `jobId` / `seq` / `data` — and the envelope's `jobId` and `seq`
 * win over any the payload names. Every other shape (a job status frame, an
 * `error` problem, a frame a test seam writes flat, a payload that is not an
 * object) is returned unchanged.
 *
 * It is the ONE copy of the rule (MOTIR-10880): the planning streams'
 * `consumeStream` (`lib/planning/planEditsClient.ts`), the job-stream hooks and
 * the server-side `walkPositionOf` all read a relayed frame through it.
 */
export function unwrapProgressFrame(data: unknown): unknown {
  if (!isRecord(data) || typeof data['seq'] !== 'number') return data;
  const payload = data['data'];
  if (!isRecord(payload)) return data;
  if (Object.keys(data).some((key) => !PROGRESS_ENVELOPE_KEYS.has(key))) return data;
  return {
    ...payload,
    ...(data['jobId'] !== undefined ? { jobId: data['jobId'] } : {}),
    seq: data['seq'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Split a decoded chunk buffer into complete frames (separated by a blank
 *  line), returning the parsed frames + the unconsumed remainder to carry into
 *  the next read. */
export function drainSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let sep = rest.indexOf('\n\n');
  while (sep !== -1) {
    const raw = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const parsed = parseSseFrame(raw);
    if (parsed) frames.push(parsed);
    sep = rest.indexOf('\n\n');
  }
  return { frames, rest };
}
