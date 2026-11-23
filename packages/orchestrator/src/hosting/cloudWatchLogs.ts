import { OrchestratorApiError } from '../errors';
import { LogsUnavailableError } from './errors';
import {
  NS_PER_MS,
  type LogSliceReader,
  type LogWindowEntry,
  type LogWindowLimits,
} from './logWindow';
import type { ReleaseLogStream } from './types';

// A CLOUDWATCH LOGS GROUP READ AS THE SHARED NEWEST-FIRST WINDOW (MOTIR-12103 ·
// MOTIR-12104). Both AWS targets — Motir's serverless account and a tenant's
// own account — keep a release's output in a CloudWatch Logs group and read it
// with FilterLogEvents, which pages FORWARD through a time range. This module
// is the part they share: the slice reader over a FilterLogEvents call, the
// event → line mapping, the window's bounds, the one name for a group that
// does not exist yet, and the server-side narrowing of a text filter. Each
// target brings its own client call and its own error mapping.
//
// FilterLogEvents (CloudWatch Logs API reference, read 2026-11-23): `startTime`
// and `endTime` are milliseconds, both inclusive; events come back in ascending
// time within a page, at most 10,000 events or 1 MB, with `nextToken` while
// more remain.

/** One event, as either target's client answers it. */
export interface CloudWatchLogEvent {
  readonly eventId: string;
  /** Milliseconds since the epoch. */
  readonly timestamp: number;
  readonly message: string;
}

export interface CloudWatchLogPage {
  readonly events: readonly CloudWatchLogEvent[];
  readonly nextToken: string | null;
}

export interface CloudWatchFilterInput {
  /** Inclusive, in milliseconds. */
  readonly startMs: number;
  /** Inclusive, in milliseconds. */
  readonly endMs: number;
  readonly filterPattern?: string;
  readonly nextToken?: string;
}

/** One FilterLogEvents call on the group; null when the group does not exist. */
export type CloudWatchFilter = (input: CloudWatchFilterInput) => Promise<CloudWatchLogPage | null>;

/** The window's bounds over CloudWatch: up to 10,000 events (1 MB) a page, so
 *  far fewer pages and requests than Fly's 100-line pages need. */
export const CLOUDWATCH_LOG_LIMITS: LogWindowLimits = {
  defaultWindowMs: 24 * 60 * 60 * 1000,
  firstSliceNs: 5n * 60n * 1_000_000_000n,
  minSliceNs: 1_000_000_000n,
  pagesPerSlice: 5,
  maxRequests: 20,
};

/** The reason a read of a log group that does not exist yet gives — a release
 *  that never ran has none. */
export const LOG_GROUP_MISSING = 'the log group does not exist';

/** Is this the refusal of a log group that does not exist yet? */
export function isLogGroupMissing(error: unknown): boolean {
  return error instanceof LogsUnavailableError && error.reason === LOG_GROUP_MISSING;
}

/** A failure of a log read as `LogsUnavailableError` on `target`: the
 *  provider's refusal carries only its service and error code (an
 *  `OrchestratorApiError`'s message); anything else is thrown as it is. */
export function cloudWatchLogsUnavailable(target: string) {
  return (error: unknown): never => {
    if (error instanceof LogsUnavailableError) throw error;
    if (error instanceof OrchestratorApiError) {
      throw new LogsUnavailableError(target, error.message);
    }
    throw error;
  };
}

/** An event → the window's line: its text with its trailing newline trimmed
 *  and nothing else changed (masking is the logs route's). */
export function cloudWatchEntryOf(
  event: CloudWatchLogEvent,
  streamOf: (message: string) => ReleaseLogStream,
): LogWindowEntry {
  const message = event.message.replace(/\r?\n$/, '');
  return {
    id: event.eventId,
    atNs: BigInt(Math.trunc(event.timestamp)) * NS_PER_MS,
    message,
    stream: streamOf(message),
  };
}

export interface CloudWatchSliceReaderOptions {
  readonly filter: CloudWatchFilter;
  readonly streamOf: (message: string) => ReleaseLogStream;
  /** Narrows server-side; the window's own filter still decides. */
  readonly filterPattern?: string | null;
  /** Maps a failed call: `cloudWatchLogsUnavailable(target)`, or the target's own. */
  readonly unavailable: (error: unknown) => never;
  readonly target: string;
}

/**
 * The slice reader over one log group: FilterLogEvents on [start, end) —
 * CloudWatch's times are milliseconds and its `endTime` inclusive — paged by
 * its token. A group that does not exist is `LogsUnavailableError`
 * (`LOG_GROUP_MISSING`), never an empty page.
 */
export function cloudWatchSliceReader(options: CloudWatchSliceReaderOptions): LogSliceReader {
  const { filter, streamOf, filterPattern, unavailable, target } = options;
  return async (startNs, endNs, maxPages, budget) => {
    const startMs = Number((startNs + NS_PER_MS - 1n) / NS_PER_MS);
    const endMs = Number((endNs + NS_PER_MS - 1n) / NS_PER_MS) - 1;
    const lines: LogWindowEntry[] = [];
    if (endMs < startMs) return { lines, complete: true, pages: 0 };
    let token: string | undefined;
    let pages = 0;
    while (pages < maxPages && budget.requests > 0) {
      budget.requests -= 1;
      pages += 1;
      const page = await filter({
        startMs,
        endMs,
        ...(filterPattern ? { filterPattern } : {}),
        ...(token ? { nextToken: token } : {}),
      }).catch(unavailable);
      if (page === null) throw new LogsUnavailableError(target, LOG_GROUP_MISSING);
      for (const event of page.events) lines.push(cloudWatchEntryOf(event, streamOf));
      if (page.nextToken === null) return { lines, complete: true, pages };
      token = page.nextToken;
    }
    return { lines, complete: false, pages };
  };
}

/** The symbols CloudWatch's regex admits as themselves, and its operators,
 *  which it admits escaped ("Filter pattern syntax", read 2026-11-23). */
const REGEX_SYMBOLS = new Set([':', '_', '#', '=', '@', '/', ';', ',', '-']);
const REGEX_OPERATORS = new Set(['^', '$', '?', '[', ']', '{', '}', '|', '\\', '*', '+', '.']);
/** The longest pattern sent; a longer filter is matched in the window only. */
const MAX_FILTER_PATTERN = 512;

/**
 * A text filter as a CloudWatch filter pattern that narrows server-side
 * WITHOUT reading the text as pattern syntax, or null when it cannot.
 *
 * CloudWatch's filter patterns are case-sensitive and the port's filter is
 * not, so a quoted term would drop lines the port must answer. The text goes
 * as one regular expression instead, `%…%`, every letter a two-case class
 * (`[eE]`), every operator escaped (`\?`, `\{`), every other ASCII character
 * by its hex escape (`\x20`): it matches every line containing the text in
 * any case, and nothing in it is an operator. A filter with a character the
 * regex cannot carry (anything past ASCII), or too long, is not sent; the
 * window's own case-insensitive match is the rule either way.
 */
export function cloudWatchLiteralPattern(text: string): string | null {
  if (text.length === 0) return null;
  let body = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0x7e || code < 0x20) return null;
    if (/[a-z]/i.test(ch)) body += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
    else if (/[0-9]/.test(ch) || REGEX_SYMBOLS.has(ch)) body += ch;
    else if (REGEX_OPERATORS.has(ch)) body += `\\${ch}`;
    else body += `\\x${code.toString(16).padStart(2, '0')}`;
  }
  const pattern = `%${body}%`;
  return pattern.length > MAX_FILTER_PATTERN ? null : pattern;
}
