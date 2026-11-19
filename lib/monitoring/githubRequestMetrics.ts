import { emitEmfLine, readCloudWatchSettings, type CloudWatchSettings } from './cloudwatchMetrics';

// GITHUB REST REQUESTS PER CALLER AS A CLOUDWATCH METRIC (MOTIR-11842).
//
// GitHub's SECONDARY limit is tripped by a burst — concurrency, points per
// minute, content-creating calls — and on 2026-11-19 nothing Motir kept could
// say which caller made the burst before the motir-co installation was
// throttled. So every GitHub call site that names itself (`GithubCallSite` in
// `lib/github/restRetry.ts`) counts each request it sends here, and once a
// minute this writes ONE EMF line per caller that sent any:
//
//   metric `GithubRequestCount` (Count), dimensions `Service` + `Caller`,
//   on `MONITORING_CLOUDWATCH_NAMESPACE` (`Motir/Core` in production).
//
// ⚠️ COUNTED IN MEMORY, NOT LOGGED PER REQUEST. A line per request would cost a
// log line per GitHub call, which during a burst is the very volume being
// measured. CloudWatch sums the per-minute lines of every task into one series
// per caller, so a burst reads as a spike on the caller that made it.
//
// ⚠️ UNSET MEANS NOTHING, as for the other publishers: with the namespace unset
// or blank no counter is kept, no timer starts and nothing is written (Fly and a
// self-hosted build). The settings are read once, on the first count.
//
// ⚠️ ONE COUNTER PER PROCESS, on `globalThis` (the MOTIR-7007 rule): Next
// evaluates route handlers in more than one module graph, and two counters would
// each publish half a minute's calls under the same dimensions.

export const GITHUB_REQUEST_METRIC = 'GithubRequestCount';
export const GITHUB_REQUEST_METRICS_INTERVAL_MS = 60_000;

const COUNTER_KEY = Symbol.for('motir.githubRequestMetrics.counter');

type Env = Readonly<Record<string, string | undefined>>;

interface Counter {
  readonly settings: CloudWatchSettings;
  readonly counts: Map<string, number>;
  readonly timer: NodeJS.Timeout;
}

/** `null` = the settings were read and publishing is off for this process. */
type Holder = { [COUNTER_KEY]?: Counter | null };

function flush(counter: Counter, now: number = Date.now()): void {
  for (const [caller, count] of counter.counts) {
    emitEmfLine(
      counter.settings.namespace,
      { Service: counter.settings.service, Caller: caller },
      [{ name: GITHUB_REQUEST_METRIC, unit: 'Count', value: count }],
      now,
    );
  }
  counter.counts.clear();
}

function counterFor(env: Env): Counter | null {
  const holder = globalThis as Holder;
  const existing = holder[COUNTER_KEY];
  if (existing !== undefined) return existing;

  const settings = readCloudWatchSettings(env);
  if (!settings) {
    holder[COUNTER_KEY] = null;
    return null;
  }
  const counts = new Map<string, number>();
  const counter: Counter = {
    settings,
    counts,
    timer: setInterval(() => flush(counter), GITHUB_REQUEST_METRICS_INTERVAL_MS),
  };
  // Never keep a process alive for a measurement.
  counter.timer.unref();
  holder[COUNTER_KEY] = counter;
  return counter;
}

/** Count ONE GitHub REST request sent by `caller`. A no-op with publishing off. */
export function countGithubRequest(caller: string, env: Env = process.env): void {
  const counter = counterFor(env);
  if (!counter) return;
  counter.counts.set(caller, (counter.counts.get(caller) ?? 0) + 1);
}

/** Tests only: write the counts gathered so far now, as the timer would. */
export function flushGithubRequestMetricsForTests(now?: number): void {
  const counter = (globalThis as Holder)[COUNTER_KEY];
  if (counter) flush(counter, now);
}

/** Tests only: stop the timer and forget the counter and the settings it read. */
export function resetGithubRequestMetricsForTests(): void {
  const holder = globalThis as Holder;
  const counter = holder[COUNTER_KEY];
  delete holder[COUNTER_KEY];
  if (counter) clearInterval(counter.timer);
}
