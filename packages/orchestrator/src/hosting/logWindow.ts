import { OrchestratorApiError, type OrchestratorApiProvider } from '../errors';
import type { ReleaseLogLine, ReleaseLogPage, ReleaseLogQuery, ReleaseLogStream } from './types';

// A RELEASE'S LOGS NEWEST FIRST, OVER A PROVIDER THAT READS OLDEST FIRST
// (MOTIR-12102 · MOTIR-12103). Fly's logs API pages forward from a token and
// CloudWatch's FilterLogEvents pages forward through a time range; a person
// reads the newest lines. Reading forward from `since` would spend the request
// budget on the oldest lines of a busy app and never reach the newest, so the
// window is read in SLICES from its newest end, by the adapter's own
// `LogSliceReader`, and this module keeps the rest — the slicing, the filter,
// the order, the limit and the cursor — in one place for every target.

/** One line as an adapter read it: a stable id, its instant in nanoseconds
 *  (the finest a provider speaks — Fly's), its text and its stream. */
export interface LogWindowEntry {
  readonly id: string;
  readonly atNs: bigint;
  readonly message: string;
  readonly stream: ReleaseLogStream;
}

/** The requests one read may still make; a slice reader takes one per call. */
export interface LogReadBudget {
  requests: number;
}

/** What a slice reader answers: the lines in [startNs, endNs), whether it read
 *  to the end of the slice, and how many pages it took. */
export interface LogSliceRead {
  readonly lines: readonly LogWindowEntry[];
  readonly complete: boolean;
  readonly pages: number;
}

/** Read the lines in [startNs, endNs) forward, at most `maxPages` pages and
 *  never past `budget` (each request takes one from it). */
export type LogSliceReader = (
  startNs: bigint,
  endNs: bigint,
  maxPages: number,
  budget: LogReadBudget,
) => Promise<LogSliceRead>;

export interface LogWindowLimits {
  /** A read with no `since` reaches back this far from `until`. */
  readonly defaultWindowMs: number;
  /** The newest slice; each older slice doubles the one before. */
  readonly firstSliceNs: bigint;
  /** The narrowest slice, read to its end whatever its pages. */
  readonly minSliceNs: bigint;
  /** Pages one slice may take before it is narrowed. */
  readonly pagesPerSlice: number;
  /** Requests one read may make before it answers what it has. */
  readonly maxRequests: number;
}

export const NS_PER_MS = 1_000_000n;

/** Where a log page stopped: lines strictly before `b` (ns), and the lines AT
 *  `b` whose ids are not in `s` — those were already answered. */
interface LogCursor {
  readonly b: bigint;
  readonly s: readonly string[];
}

function encodeLogCursor(cursor: LogCursor): string {
  return Buffer.from(JSON.stringify({ b: String(cursor.b), s: cursor.s })).toString('base64url');
}

function decodeLogCursor(
  target: OrchestratorApiProvider,
  appRef: string,
  cursor: string,
): LogCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      b?: unknown;
      s?: unknown;
    };
    if (
      typeof parsed.b === 'string' &&
      /^\d{1,30}$/.test(parsed.b) &&
      Array.isArray(parsed.s) &&
      parsed.s.every((id) => typeof id === 'string')
    ) {
      return { b: BigInt(parsed.b), s: parsed.s as string[] };
    }
  } catch {
    // fall through to the refusal
  }
  throw new OrchestratorApiError(target, 400, `app ${appRef}: "${cursor}" is not a log cursor`);
}

/** Newest first; at one instant, by id, so a page is the same on every read. */
function newerFirst(a: LogWindowEntry, b: LogWindowEntry): number {
  if (a.atNs !== b.atNs) return a.atNs > b.atNs ? -1 : 1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function lineOf(entry: LogWindowEntry): ReleaseLogLine {
  return {
    at: new Date(Number(entry.atNs / NS_PER_MS)),
    stream: entry.stream,
    message: entry.message,
  };
}

/**
 * The query's page of lines, NEWEST FIRST.
 *
 * The window is read in slices from its newest end: `firstSliceNs` first, then
 * each older slice twice as long, each read forward to its end. A slice that
 * overflows its `pagesPerSlice` pages is narrowed toward its newer end — to the
 * part its pages did not reach, or to half when that is more — and read again,
 * so a burst is never skipped for older lines. A slice already at `minSliceNs`
 * is read to its end whatever its pages. The read stops once more matching
 * lines than the limit are in hand (so it knows a further page exists), the
 * window is read, or the request budget is spent — then it answers what it
 * has, with a cursor to the unread rest.
 *
 * The filter is matched here, case-insensitively, as the port defines it; a
 * reader may narrow server-side first, but this is the rule that decides.
 */
export async function readLogWindowNewestFirst(
  target: OrchestratorApiProvider,
  appRef: string,
  query: ReleaseLogQuery,
  now: Date,
  limits: LogWindowLimits,
  readSlice: LogSliceReader,
): Promise<ReleaseLogPage> {
  if (!Number.isInteger(query.limit) || query.limit < 1) {
    throw new OrchestratorApiError(target, 400, 'a log limit must be a positive integer');
  }
  const cursor = query.cursor ? decodeLogCursor(target, appRef, query.cursor) : null;
  const untilEnd = BigInt((query.until ?? now).getTime() + 1) * NS_PER_MS;
  const lowest = query.since
    ? BigInt(query.since.getTime()) * NS_PER_MS
    : untilEnd - BigInt(limits.defaultWindowMs) * NS_PER_MS;
  const needle = query.filter ? query.filter.toLowerCase() : null;
  const answered = new Set(cursor?.s ?? []);
  const keep = (e: LogWindowEntry) =>
    (needle === null || e.message.toLowerCase().includes(needle)) &&
    !(cursor !== null && e.atNs === cursor.b && answered.has(e.id));

  const budget: LogReadBudget = { requests: limits.maxRequests };
  const found = new Map<string, LogWindowEntry>();
  let end = cursor ? (cursor.b + 1n < untilEnd ? cursor.b + 1n : untilEnd) : untilEnd;
  let size = limits.firstSliceNs;
  let unread = false;
  while (end > lowest && found.size <= query.limit) {
    if (budget.requests <= 0) {
      unread = true;
      break;
    }
    const start = end - size > lowest ? end - size : lowest;
    const narrowest = end - start <= limits.minSliceNs;
    const slice = await readSlice(start, end, narrowest ? Infinity : limits.pagesPerSlice, budget);
    if (!slice.complete && !narrowest && budget.requests > 0) {
      // Narrow toward the newer end: to the part the pages did not reach when
      // that is under half the slice (a burst at its newer end), else to half.
      let reached: bigint | null = null;
      for (const line of slice.lines)
        if (reached === null || line.atNs > reached) reached = line.atNs;
      const half = (end - start) / 2n;
      const rest = reached === null ? half : end - reached;
      size = rest < half ? rest : half;
      continue;
    }
    if (!slice.complete) {
      // The budget ran out inside a slice. With lines in hand, leave the slice
      // unread for the cursor; with none, answer its older part rather than a
      // page that would never move.
      unread = true;
      if (found.size > 0) break;
      for (const entry of slice.lines) if (keep(entry)) found.set(entry.id, entry);
      end = start;
      break;
    }
    for (const entry of slice.lines) if (keep(entry)) found.set(entry.id, entry);
    size = (end - start) * 2n;
    end = start;
  }

  const matching = [...found.values()].sort(newerFirst);
  const page = matching.slice(0, query.limit);
  const oldest = page[page.length - 1];
  let next: LogCursor | null = null;
  if (oldest && matching.length > page.length) {
    next = { b: oldest.atNs, s: page.filter((e) => e.atNs === oldest.atNs).map((e) => e.id) };
  } else if (unread && end - 1n >= lowest) {
    // The budget ran out: everything before `end` is unread.
    next = { b: end - 1n, s: [] };
  }
  return { lines: page.map(lineOf), cursor: next ? encodeLogCursor(next) : null };
}
