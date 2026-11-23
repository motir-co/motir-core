import { OrchestratorApiError } from '../../errors';
import { LogsUnavailableError } from '../../hosting/errors';
import {
  NS_PER_MS,
  type LogSliceReader,
  type LogWindowEntry,
  type LogWindowLimits,
} from '../../hosting/logWindow';
import type { ReleaseLogStream, ReleaseRuntimeHealth } from '../../hosting/types';
import type { LambdaFunctionView, LogEventView, ServerlessAwsApi } from './client';

// THE SERVERLESS TARGET'S RUNTIME READS, the pure parts (MOTIR-12103): a Lambda
// function's log group read as the shared newest-first window, its lines
// mapped to the port's, and Lambda's own platform lines read for what they say
// about the runtime — because Lambda exposes no instance state, `exited`,
// `oom_killed`, `running` and `suspended` are read from them.
//
// The line shapes are the ones Lambda's own documentation gives for its
// platform lines ("Lambda function logging", "Troubleshoot invocation issues in
// Lambda", read 2026-11-23): `START` / `END` / `REPORT RequestId: …` per
// invocation, the REPORT carrying `Memory Size: N MB` and `Max Memory Used: N MB`
// (and, on runtimes with the newer report format, `Status: error|timeout` and
// `Error Type: Runtime.ExitError|Runtime.OutOfMemory`), `INIT_START` /
// `INIT_REPORT` for the init phase, and `RequestId: … Error: Runtime exited with
// error: exit status N` (or `signal: killed`, the kernel's kill at the memory
// limit) followed by `Runtime.ExitError`. The fixtures in
// `test/serverlessRuntimeReads.test.ts` are those lines.

/** The serverless window's bounds: CloudWatch answers up to 10,000 events (1 MB)
 *  a page, so fewer pages and requests than Fly's 100-line pages need. */
export const SERVERLESS_LOG_LIMITS: LogWindowLimits = {
  defaultWindowMs: 24 * 60 * 60 * 1000,
  firstSliceNs: 5n * 60n * 1_000_000_000n,
  minSliceNs: 1_000_000_000n,
  pagesPerSlice: 5,
  maxRequests: 20,
};

/** How far back `readHealth` reads Lambda's reports for the runtime's recent
 *  state: an invocation in it is `running`, none is `suspended`. */
export const SERVERLESS_HEALTH_WINDOW_MS = 5 * 60 * 1000;

/** The CloudWatch filter pattern for the lines health reads: a report, an init
 *  report, and a runtime exit. */
export const SERVERLESS_RUNTIME_LINES =
  '?REPORT ?INIT_REPORT ?"Runtime exited" ?"Runtime.ExitError"';

const PLATFORM_LINE =
  /^(START|END|REPORT|INIT_START|INIT_REPORT|INIT_RUNTIME_DONE|RESTORE_START|RESTORE_REPORT|EXTENSION|TELEMETRY|PLATFORM)\b/;
const RUNTIME_ERROR = /Runtime exited with error|Runtime\.ExitError|Task timed out after/;

/** Lambda's own line, or the app's output? */
export function serverlessStreamOf(message: string): ReleaseLogStream {
  return PLATFORM_LINE.test(message) || RUNTIME_ERROR.test(message) ? 'platform' : 'app';
}

/** A CloudWatch event → the window's line: its text with its trailing newline
 *  trimmed and nothing else changed (masking is the logs route's). */
export function serverlessLogEntryOf(event: LogEventView): LogWindowEntry {
  const message = event.message.replace(/\r?\n$/, '');
  return {
    id: event.eventId,
    atNs: BigInt(Math.trunc(event.timestamp)) * NS_PER_MS,
    message,
    stream: serverlessStreamOf(message),
  };
}

/** The reason a read of a log group that does not exist yet gives — a function
 *  never invoked has none. */
export const LOG_GROUP_MISSING = 'the log group does not exist';

/** Is this the refusal of a log group that does not exist yet? */
export function isLogGroupMissing(error: unknown): boolean {
  return error instanceof LogsUnavailableError && error.reason === LOG_GROUP_MISSING;
}

/** Why the log group could not be read, without the provider's words: our
 *  errors from the client carry the service and AWS error code only. */
function logsReason(error: unknown): string | null {
  // The client's message carries the service and AWS error code only.
  if (error instanceof OrchestratorApiError) return error.message;
  return null;
}

/** A failure of a log read as `LogsUnavailableError`; anything not AWS's is
 *  thrown as it is. */
export function logsUnavailable(error: unknown): never {
  if (error instanceof LogsUnavailableError) throw error;
  const reason = logsReason(error);
  if (reason === null) throw error;
  throw new LogsUnavailableError('serverless', reason);
}

/**
 * The slice reader over one log group: FilterLogEvents on [start, end) —
 * CloudWatch's times are milliseconds and its `endTime` inclusive — paged by
 * its token. A group that does not exist is `LogsUnavailableError`, never an
 * empty page.
 */
export function serverlessSliceReader(
  api: ServerlessAwsApi,
  group: string,
  filterPattern?: string,
): LogSliceReader {
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
      const page = await api
        .filterLogEvents(group, {
          startMs,
          endMs,
          ...(filterPattern ? { filterPattern } : {}),
          ...(token ? { nextToken: token } : {}),
        })
        .catch(logsUnavailable);
      if (page === null) throw new LogsUnavailableError('serverless', LOG_GROUP_MISSING);
      for (const event of page.events) lines.push(serverlessLogEntryOf(event));
      if (page.nextToken === null) return { lines, complete: true, pages };
      token = page.nextToken;
    }
    return { lines, complete: false, pages };
  };
}

/** What one of Lambda's platform lines says about the runtime. */
export type LambdaRuntimeSignal =
  /** An invocation that finished. */
  | { readonly kind: 'invocation'; readonly at: Date }
  /** An invocation that ran out its timeout: the runtime ran, nothing more. */
  | { readonly kind: 'timeout'; readonly at: Date }
  /** The runtime's process exited on its own. */
  | {
      readonly kind: 'exit';
      readonly at: Date;
      readonly exitCode: number | null;
      readonly requestId: string | null;
    }
  /** The runtime was killed at its memory limit. */
  | { readonly kind: 'oom'; readonly at: Date; readonly requestId: string | null };

/** One platform line → its signal, or null when it says nothing of the runtime
 *  (`START`, `END`, an `INIT_REPORT` that succeeded, the app's own output). */
export function lambdaRuntimeSignal(message: string, at: Date): LambdaRuntimeSignal | null {
  const requestId = /RequestId: ([0-9A-Za-z-]+)/.exec(message)?.[1] ?? null;
  const exited = /Runtime exited with error: (.+?)\s*$/m.exec(message);
  if (exited) {
    const how = exited[1]!;
    if (/signal: killed/.test(how)) return { kind: 'oom', at, requestId };
    const status = /exit status (-?\d+)/.exec(how);
    return { kind: 'exit', at, exitCode: status ? Number(status[1]) : null, requestId };
  }
  if (/^(REPORT|INIT_REPORT)\b/.test(message)) {
    const errorType = /Error Type: (\S+)/.exec(message)?.[1] ?? null;
    const status = /Status: (\w+)/.exec(message)?.[1] ?? null;
    const size = /Memory Size: (\d+) MB/.exec(message);
    const used = /Max Memory Used: (\d+) MB/.exec(message);
    if (errorType === 'Runtime.OutOfMemory') return { kind: 'oom', at, requestId };
    if (size && used && Number(used[1]) >= Number(size[1])) return { kind: 'oom', at, requestId };
    if (status === 'timeout') return { kind: 'timeout', at };
    if (status === 'error' || errorType === 'Runtime.ExitError') {
      return { kind: 'exit', at, exitCode: null, requestId };
    }
    return message.startsWith('REPORT') ? { kind: 'invocation', at } : null;
  }
  if (/^Runtime\.ExitError\b/.test(message)) {
    return { kind: 'exit', at, exitCode: null, requestId };
  }
  if (/Task timed out after/.test(message)) return { kind: 'timeout', at };
  return null;
}

/** What `readHealth` read about a serverless release, for the pure
 *  classification below. */
export interface ServerlessRuntimeFacts {
  readonly fn: LambdaFunctionView;
  /** The version `live` points at; null when there is no alias. */
  readonly liveVersion: string | null;
  /** The provisioned-concurrency status on `live`; null when it has none. */
  readonly provisioned: string | null;
  /** The runtime signals of the recent window, any order. */
  readonly recent: readonly LambdaRuntimeSignal[];
  /** The latest finished invocation before the window, when one was read. */
  readonly lastInvocation: Date | null;
  /** Where the read started: the window's start. */
  readonly windowStart: Date;
}

/**
 * A serverless release's runtime state, in order (MOTIR-12103):
 *
 * 1. `deploying` — the function `Pending` or an update `InProgress`, no `live`
 *    alias, or provisioned concurrency `IN_PROGRESS` — since `LastModified`;
 * 2. `exited` — the function or its last update `Failed` (no exit code: the
 *    state reason is Lambda's, not the process's) — since `LastModified`;
 * 3. `exited` / `oom_killed` — the newest runtime exit or memory kill of the
 *    window, with no finished invocation after it — since that line;
 * 4. `running` — provisioned concurrency `READY` (always-on), since
 *    `LastModified`; or any invocation in the window, since the first one after
 *    the newest crash;
 * 5. `suspended` — none of the above: no invocation in the window, since the
 *    last invocation read before it, else `LastModified`.
 *
 * A wrong answer here becomes a false crash event downstream, so `exited` and
 * `oom_killed` are only ever read from a line Lambda wrote about that crash.
 */
export function serverlessRuntimeHealth(facts: ServerlessRuntimeFacts): ReleaseRuntimeHealth {
  const { fn } = facts;
  const changed = fn.lastModified ?? facts.windowStart;
  if (fn.state === 'Pending' || fn.lastUpdateStatus === 'InProgress') {
    return { state: 'deploying', since: changed };
  }
  if (fn.state === 'Failed' || fn.lastUpdateStatus === 'Failed') {
    return { state: 'exited', exitCode: null, since: changed };
  }
  if (facts.liveVersion === null || facts.provisioned === 'IN_PROGRESS') {
    return { state: 'deploying', since: changed };
  }
  const newest = (match: (s: LambdaRuntimeSignal) => boolean) =>
    facts.recent
      .filter(match)
      .reduce<LambdaRuntimeSignal | null>((a, s) => (a === null || s.at > a.at ? s : a), null);
  const crash = newest((s) => s.kind === 'exit' || s.kind === 'oom');
  const ran = (s: LambdaRuntimeSignal) => s.kind === 'invocation' || s.kind === 'timeout';
  const recovered =
    crash !== null && facts.recent.some((s) => s.kind === 'invocation' && s.at > crash.at);
  if (crash && !recovered) {
    // Lambda writes one crash as several lines (the runtime's exit, then the
    // REPORT that says Status: error): read them as one, from the first line,
    // with the exit code and the memory kill whichever line carries them.
    const id = 'requestId' in crash ? crash.requestId : null;
    const lines = facts.recent.filter(
      (s): s is Extract<LambdaRuntimeSignal, { kind: 'exit' | 'oom' }> =>
        (s.kind === 'exit' || s.kind === 'oom') &&
        (s === crash || (id !== null && s.requestId === id)),
    );
    const since = lines.reduce((a, s) => (s.at < a ? s.at : a), crash.at);
    if (lines.some((s) => s.kind === 'oom')) return { state: 'oom_killed', since };
    const exitCode =
      lines.find(
        (s): s is Extract<LambdaRuntimeSignal, { kind: 'exit' }> =>
          s.kind === 'exit' && s.exitCode !== null,
      )?.exitCode ?? null;
    return { state: 'exited', exitCode, since };
  }
  if (facts.provisioned === 'READY') return { state: 'running', since: changed };
  const after = facts.recent.filter((s) => ran(s) && (crash === null || s.at > crash.at));
  if (after.length > 0) {
    const first = after.reduce((a, s) => (s.at < a.at ? s : a));
    return { state: 'running', since: first.at };
  }
  return { state: 'suspended', since: facts.lastInvocation ?? changed };
}
