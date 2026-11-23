import { LogsUnavailableError } from './errors';
import { isLogGroupMissing } from './cloudWatchLogs';
import {
  NS_PER_MS,
  readLogWindowNewestFirst,
  type LogSliceReader,
  type LogWindowLimits,
} from './logWindow';
import type { ReleaseLogStream, ReleaseRuntimeHealth } from './types';
import type { OrchestratorApiProvider } from '../errors';

// A LAMBDA FUNCTION'S RUNTIME, READ FROM LAMBDA'S OWN LINES (MOTIR-12103 ·
// MOTIR-12104). Lambda exposes no instance state, so `exited`, `oom_killed`,
// `running` and `suspended` are read from the platform lines it writes into the
// function's log group. Both targets that run a release as a Lambda function —
// Motir's serverless account and the AWS target's function shape in a tenant
// account — read them the same way, through this module.
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

/** How far back a health read reads Lambda's reports for the runtime's recent
 *  state: an invocation in it is `running`, none is `suspended`. */
export const LAMBDA_HEALTH_WINDOW_MS = 5 * 60 * 1000;

/** The CloudWatch filter pattern for the lines health reads: a report, an init
 *  report, and a runtime exit. */
export const LAMBDA_RUNTIME_LINES = '?REPORT ?INIT_REPORT ?"Runtime exited" ?"Runtime.ExitError"';

const PLATFORM_LINE =
  /^(START|END|REPORT|INIT_START|INIT_REPORT|INIT_RUNTIME_DONE|RESTORE_START|RESTORE_REPORT|EXTENSION|TELEMETRY|PLATFORM)\b/;
const RUNTIME_ERROR = /Runtime exited with error|Runtime\.ExitError|Task timed out after/;

/** Lambda's own line, or the app's output? */
export function lambdaStreamOf(message: string): ReleaseLogStream {
  return PLATFORM_LINE.test(message) || RUNTIME_ERROR.test(message) ? 'platform' : 'app';
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

/** The function's own state, as Lambda reports it (compared case-insensitively:
 *  the serverless client keeps Lambda's casing, the tenant seam lowers it). */
export interface LambdaFunctionStatus {
  /** `Pending` · `Active` · `Inactive` · `Failed`. */
  readonly state: string | null;
  /** `Successful` · `Failed` · `InProgress`; null when Lambda gives none. */
  readonly lastUpdateStatus: string | null;
  readonly lastModified: Date | null;
}

/** What a health read read about a function release, for the pure
 *  classification below. */
export interface LambdaRuntimeFacts {
  readonly function: LambdaFunctionStatus;
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
 * A function release's runtime state, in order:
 *
 * 1. `deploying` — the function `Pending` or an update `InProgress`, no `live`
 *    alias, or provisioned concurrency `IN_PROGRESS` — since `LastModified`;
 * 2. `exited` — the function or its last update `Failed` (no exit code: the
 *    state reason is Lambda's, not the process's) — since `LastModified`;
 * 3. `exited` / `oom_killed` — the newest runtime exit or memory kill of the
 *    window, with no finished invocation after it — since that crash's first
 *    line;
 * 4. `running` — provisioned concurrency `READY` (always-on), since
 *    `LastModified`; or any invocation in the window, since the first one after
 *    the newest crash;
 * 5. `suspended` — none of the above: no invocation in the window, since the
 *    last invocation read before it, else `LastModified`.
 *
 * A wrong answer here becomes a false crash event downstream, so `exited` and
 * `oom_killed` are only ever read from a line Lambda wrote about that crash.
 */
export function lambdaRuntimeHealth(facts: LambdaRuntimeFacts): ReleaseRuntimeHealth {
  const state = facts.function.state?.toLowerCase() ?? null;
  const update = facts.function.lastUpdateStatus?.toLowerCase() ?? null;
  const changed = facts.function.lastModified ?? facts.windowStart;
  if (state === 'pending' || update === 'inprogress') {
    return { state: 'deploying', since: changed };
  }
  if (state === 'failed' || update === 'failed') {
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

/** The runtime signals in [since, until], from one bounded slice read through
 *  `read` (built over `LAMBDA_RUNTIME_LINES`). A group that does not exist yet
 *  — a function never invoked — has none; a window holding more lines than one
 *  bounded read is refused rather than read in part. */
export async function readLambdaRuntimeSignals(
  target: string,
  read: LogSliceReader,
  since: Date,
  until: Date,
  limits: LogWindowLimits,
): Promise<LambdaRuntimeSignal[]> {
  try {
    const slice = await read(
      BigInt(since.getTime()) * NS_PER_MS,
      BigInt(until.getTime() + 1) * NS_PER_MS,
      limits.pagesPerSlice,
      { requests: limits.pagesPerSlice },
    );
    if (!slice.complete) throw new LogsUnavailableError(target, 'too many runtime lines to read');
    return slice.lines.flatMap((line) => {
      const signal = lambdaRuntimeSignal(line.message, new Date(Number(line.atNs / NS_PER_MS)));
      return signal ? [signal] : [];
    });
  } catch (error) {
    if (isLogGroupMissing(error)) return [];
    throw error;
  }
}

/** The newest finished invocation before `before`, back to the function's
 *  last change (or the window's default reach), or null. `read` narrows to
 *  `REPORT` lines. */
export async function lastLambdaInvocationBefore(
  provider: OrchestratorApiProvider,
  group: string,
  read: LogSliceReader,
  before: Date,
  changed: Date | null,
  limits: LogWindowLimits,
): Promise<Date | null> {
  const reach = before.getTime() - limits.defaultWindowMs;
  const since = new Date(Math.max(reach, changed?.getTime() ?? reach));
  if (since >= before) return null;
  try {
    const page = await readLogWindowNewestFirst(
      provider,
      group,
      { since, until: new Date(before.getTime() - 1), filter: 'REPORT RequestId', limit: 1 },
      before,
      limits,
      read,
    );
    return page.lines[0]?.at ?? null;
  } catch (error) {
    if (isLogGroupMissing(error)) return null;
    throw error;
  }
}
