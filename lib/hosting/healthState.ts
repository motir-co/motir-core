import type { ReleaseLastExit, ReleaseRuntimeHealth } from '@motir/orchestrator';

// A HOSTED APPLICATION'S ONE HEALTH STATE (Story MOTIR-9799 · MOTIR-12106): the
// pure rule that combines the deploy port's runtime read with the manifest's
// health-check probe into the state the prober stores. No I/O, no clock of its
// own: the caller passes `now`.
//
// The rule, in order:
//   - no live release, or the runtime `deploying`            → `deploying`
//   - the runtime `suspended`                                → `suspended`
//     (the caller never probes a suspended app: a probe would wake it)
//   - the runtime `exited` / `oom_killed`                    → `crashed`
//   - the runtime `running` (or unreadable — the probe alone decides):
//       a 2xx/3xx probe                                      → `healthy`
//       a failed or timed-out probe, the SECOND in a row     → `unhealthy`
//       … the first one                                      → the previous state
//       no connection at all                                 → the previous state,
//                                                              `probe_unreachable`
//   - running with a `lastExit` newer than the newest crash already recorded
//     for the release: one extra `crashed` event, keyed `exit:<at>`, while the
//     state follows the probe — a crash the target recovered from between two
//     reads is still recorded.
//
// A transition INTO `crashed` or `unhealthy` is an event, keyed
// `<state>:<since ISO>`; the table's unique key on it is what makes a retried
// or concurrent run write it once.

export const HOSTED_HEALTH_STATES = [
  'healthy',
  'unhealthy',
  'suspended',
  'crashed',
  'deploying',
] as const;
export type HostedHealthState = (typeof HOSTED_HEALTH_STATES)[number];
export type HostedHealthCondition = 'probe_unreachable';
export type HostedApplicationEventKind = 'crashed' | 'health_check_failed';

/** Failed probes in a row that make a running application `unhealthy`. */
export const UNHEALTHY_AFTER_FAILURES = 2;

/** The stored state the next one is computed against; null before the first. */
export interface HealthPrevious {
  readonly state: HostedHealthState;
  readonly since: Date;
  readonly condition: HostedHealthCondition | null;
  readonly consecutiveProbeFailures: number;
}

/** What the port said about the release's process. */
export type RuntimeRead =
  /** No live release, or one still in flight. */
  | { readonly kind: 'no_release' }
  /** `RuntimeHealthUnavailableError`: the target could not answer. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'read'; readonly health: ReleaseRuntimeHealth };

/** What the health-check GET answered; null when it was not made. */
export type ProbeResult =
  | { readonly kind: 'ok'; readonly status: number }
  | { readonly kind: 'failed'; readonly status: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable' };

/** An event to record, before it has an id. */
export interface HealthEventDraft {
  readonly kind: HostedApplicationEventKind;
  readonly reason: string;
  readonly exitCode: number | null;
  readonly occurredAt: Date;
  readonly transitionKey: string;
}

export interface CombineHealthInput {
  readonly previous: HealthPrevious | null;
  readonly runtime: RuntimeRead;
  readonly probe: ProbeResult | null;
  readonly now: Date;
  /** When the newest `crashed` event already recorded for the current release
   *  occurred; null when none is. */
  readonly newestCrashAt: Date | null;
}

export interface HealthNext {
  readonly state: HostedHealthState;
  readonly since: Date;
  readonly condition: HostedHealthCondition | null;
  readonly consecutiveProbeFailures: number;
  /** At most two: a restarted-from exit, and a transition. */
  readonly events: readonly HealthEventDraft[];
}

/** The reason an exit is recorded with. */
export function exitReason(exit: { exitCode: number | null; oomKilled: boolean }): string {
  if (exit.oomKilled) return 'out of memory';
  return exit.exitCode === null ? 'exited' : `exit code ${exit.exitCode}`;
}

function probeReason(probe: ProbeResult): string {
  return probe.kind === 'timeout' ? 'timed out' : `HTTP ${(probe as { status: number }).status}`;
}

/** The state when nothing judges it yet: the previous one, else `deploying`. */
const kept = (previous: HealthPrevious | null): HostedHealthState => previous?.state ?? 'deploying';

function restartedExitEvent(
  lastExit: ReleaseLastExit | undefined,
  newestCrashAt: Date | null,
): HealthEventDraft | null {
  if (!lastExit) return null;
  if (newestCrashAt && lastExit.at.getTime() <= newestCrashAt.getTime()) return null;
  return {
    kind: 'crashed',
    reason: exitReason(lastExit),
    exitCode: lastExit.oomKilled ? null : lastExit.exitCode,
    occurredAt: lastExit.at,
    transitionKey: `exit:${lastExit.at.toISOString()}`,
  };
}

/** The next state of an application, and the events its change records. */
export function combineHealthState(input: CombineHealthInput): HealthNext {
  const { previous, runtime, probe, now } = input;
  let state: HostedHealthState;
  /** When the state began, if it is new now. */
  let changedAt = now;
  let condition: HostedHealthCondition | null = null;
  let failures = 0;
  let reason: string | null = null;
  let exitCode: number | null = null;
  const events: HealthEventDraft[] = [];

  const health = runtime.kind === 'read' ? runtime.health : null;
  if (runtime.kind === 'no_release' || health?.state === 'deploying') {
    state = 'deploying';
    if (health) changedAt = health.since;
  } else if (health?.state === 'suspended') {
    state = 'suspended';
    changedAt = health.since;
  } else if (health?.state === 'exited' || health?.state === 'oom_killed') {
    state = 'crashed';
    changedAt = health.since;
    const oomKilled = health.state === 'oom_killed';
    exitCode = health.state === 'exited' ? health.exitCode : null;
    reason = exitReason({ exitCode, oomKilled });
  } else {
    // Running, or a runtime that could not be read: the probe decides.
    if (health?.state === 'running') {
      const exit = restartedExitEvent(health.lastExit, input.newestCrashAt);
      if (exit) events.push(exit);
    }
    if (probe === null) {
      // Nothing to probe (no address or path): a running process is healthy,
      // an unreadable one keeps what it was.
      state = health ? 'healthy' : kept(previous);
    } else if (probe.kind === 'ok') {
      state = 'healthy';
    } else if (probe.kind === 'unreachable') {
      state = kept(previous);
      condition = 'probe_unreachable';
      failures = previous?.consecutiveProbeFailures ?? 0;
    } else {
      failures = (previous?.consecutiveProbeFailures ?? 0) + 1;
      if (failures >= UNHEALTHY_AFTER_FAILURES) {
        state = 'unhealthy';
        reason = probeReason(probe);
      } else {
        state = kept(previous);
      }
    }
  }

  const unchanged = previous !== null && previous.state === state;
  const since = unchanged ? previous.since : changedAt;
  if (!unchanged && (state === 'crashed' || state === 'unhealthy')) {
    events.push({
      kind: state === 'crashed' ? 'crashed' : 'health_check_failed',
      reason: reason!,
      exitCode,
      occurredAt: since,
      transitionKey: `${state}:${since.toISOString()}`,
    });
  }
  return { state, since, condition, consecutiveProbeFailures: failures, events };
}
