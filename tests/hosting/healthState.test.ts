// MOTIR-12106 — the pure rule that combines the deploy port's runtime read with
// the health-check probe into one state: every row of the card's table, the
// two-failure rule, `since` holding while a state holds, the events a transition
// records with their keys and reasons, and the restarted-from exit.
import { describe, expect, it } from 'vitest';
import {
  combineHealthState,
  exitReason,
  type CombineHealthInput,
  type HealthPrevious,
  type ProbeResult,
  type RuntimeRead,
} from '@/lib/hosting/healthState';

const T0 = new Date('2026-11-23T10:00:00.000Z');
const T1 = new Date('2026-11-23T10:01:00.000Z');
const NOW = new Date('2026-11-23T10:02:00.000Z');

const running = (lastExit?: { exitCode: number | null; oomKilled: boolean; at: Date }) =>
  ({
    kind: 'read',
    health: lastExit ? { state: 'running', since: T0, lastExit } : { state: 'running', since: T0 },
  }) as RuntimeRead;
const read = (health: Extract<RuntimeRead, { kind: 'read' }>['health']): RuntimeRead => ({
  kind: 'read',
  health,
});
const OK: ProbeResult = { kind: 'ok', status: 200 };
const REDIRECT: ProbeResult = { kind: 'ok', status: 302 };
const FAIL: ProbeResult = { kind: 'failed', status: 503 };
const TIMEOUT: ProbeResult = { kind: 'timeout' };
const UNREACHABLE: ProbeResult = { kind: 'unreachable' };

const prev = (state: HealthPrevious['state'], failures = 0, since = T0): HealthPrevious => ({
  state,
  since,
  condition: null,
  consecutiveProbeFailures: failures,
});

function combine(input: Partial<CombineHealthInput> & Pick<CombineHealthInput, 'runtime'>) {
  return combineHealthState({
    previous: null,
    probe: null,
    now: NOW,
    newestCrashAt: null,
    ...input,
  });
}

describe('combineHealthState — the runtime rows', () => {
  it('is deploying with no live release', () => {
    expect(combine({ runtime: { kind: 'no_release' } })).toEqual({
      state: 'deploying',
      since: NOW,
      condition: null,
      consecutiveProbeFailures: 0,
      events: [],
    });
  });

  it('is deploying while the target deploys, since the target says', () => {
    const next = combine({
      runtime: read({ state: 'deploying', since: T1 }),
      previous: prev('healthy'),
    });
    expect(next).toMatchObject({ state: 'deploying', since: T1, events: [] });
  });

  it('is suspended while the target sleeps it', () => {
    const next = combine({
      runtime: read({ state: 'suspended', since: T1 }),
      previous: prev('healthy'),
    });
    expect(next).toMatchObject({ state: 'suspended', since: T1, events: [] });
  });

  it('is crashed on an exit, with one event keyed on when it exited', () => {
    const next = combine({
      runtime: read({ state: 'exited', exitCode: 137, since: T1 }),
      previous: prev('healthy'),
    });
    expect(next).toMatchObject({ state: 'crashed', since: T1 });
    expect(next.events).toEqual([
      {
        kind: 'crashed',
        reason: 'exit code 137',
        exitCode: 137,
        occurredAt: T1,
        transitionKey: `crashed:${T1.toISOString()}`,
      },
    ]);
  });

  it('is crashed on a memory kill, reason out of memory', () => {
    const next = combine({ runtime: read({ state: 'oom_killed', since: T1 }) });
    expect(next.state).toBe('crashed');
    expect(next.events[0]).toMatchObject({ reason: 'out of memory', exitCode: null });
  });

  it('records no second event while it stays crashed, and keeps since', () => {
    const next = combine({
      runtime: read({ state: 'exited', exitCode: 1, since: T1 }),
      previous: prev('crashed', 0, T0),
    });
    expect(next).toMatchObject({ state: 'crashed', since: T0, events: [] });
  });
});

describe('combineHealthState — a running process and its probe', () => {
  it('is healthy on a 2xx or a 3xx, and resets the failures', () => {
    for (const probe of [OK, REDIRECT]) {
      const next = combine({ runtime: running(), probe, previous: prev('unhealthy', 3) });
      expect(next).toMatchObject({
        state: 'healthy',
        since: NOW,
        condition: null,
        consecutiveProbeFailures: 0,
        events: [],
      });
    }
  });

  it('keeps the previous state on a FIRST failure or timeout', () => {
    for (const probe of [FAIL, TIMEOUT]) {
      const next = combine({ runtime: running(), probe, previous: prev('healthy', 0, T0) });
      expect(next).toMatchObject({
        state: 'healthy',
        since: T0,
        consecutiveProbeFailures: 1,
        events: [],
      });
    }
  });

  it('is unhealthy on the SECOND failure in a row, with one event', () => {
    const next = combine({ runtime: running(), probe: FAIL, previous: prev('healthy', 1) });
    expect(next).toMatchObject({ state: 'unhealthy', since: NOW, consecutiveProbeFailures: 2 });
    expect(next.events).toEqual([
      {
        kind: 'health_check_failed',
        reason: 'HTTP 503',
        exitCode: null,
        occurredAt: NOW,
        transitionKey: `unhealthy:${NOW.toISOString()}`,
      },
    ]);
  });

  it('names a timed-out second probe', () => {
    const next = combine({ runtime: running(), probe: TIMEOUT, previous: prev('healthy', 1) });
    expect(next.events[0]!.reason).toBe('timed out');
  });

  it('stays unhealthy without a second event', () => {
    const next = combine({ runtime: running(), probe: FAIL, previous: prev('unhealthy', 2, T0) });
    expect(next).toMatchObject({
      state: 'unhealthy',
      since: T0,
      consecutiveProbeFailures: 3,
      events: [],
    });
  });

  it('keeps the previous state and sets probe_unreachable with no connection', () => {
    const next = combine({
      runtime: running(),
      probe: UNREACHABLE,
      previous: prev('healthy', 1, T0),
    });
    expect(next).toEqual({
      state: 'healthy',
      since: T0,
      condition: 'probe_unreachable',
      consecutiveProbeFailures: 1,
      events: [],
    });
  });

  it('is deploying when a first read judges nothing', () => {
    expect(combine({ runtime: running(), probe: UNREACHABLE }).state).toBe('deploying');
    expect(combine({ runtime: running(), probe: FAIL }).state).toBe('deploying');
  });

  it('is healthy for a running process with nothing to probe', () => {
    expect(combine({ runtime: running(), probe: null }).state).toBe('healthy');
  });
});

describe('combineHealthState — an unreadable runtime lets the probe alone decide', () => {
  const runtime: RuntimeRead = { kind: 'unavailable' };

  it('follows the probe', () => {
    expect(combine({ runtime, probe: OK }).state).toBe('healthy');
    expect(combine({ runtime, probe: FAIL, previous: prev('healthy', 1) }).state).toBe('unhealthy');
  });

  it('never yields crashed', () => {
    for (const probe of [OK, FAIL, TIMEOUT, UNREACHABLE, null]) {
      expect(combine({ runtime, probe, previous: prev('healthy', 1) }).state).not.toBe('crashed');
    }
  });

  it('keeps the previous state with nothing to probe', () => {
    expect(combine({ runtime, probe: null, previous: prev('suspended') }).state).toBe('suspended');
  });
});

describe('combineHealthState — an exit the target restarted from', () => {
  const exit = { exitCode: 1, oomKilled: false, at: T1 };

  it('records one crashed event keyed exit:<at>, while the state follows the probe', () => {
    const next = combine({ runtime: running(exit), probe: OK, previous: prev('healthy') });
    expect(next.state).toBe('healthy');
    expect(next.events).toEqual([
      {
        kind: 'crashed',
        reason: 'exit code 1',
        exitCode: 1,
        occurredAt: T1,
        transitionKey: `exit:${T1.toISOString()}`,
      },
    ]);
  });

  it('records nothing for an exit no newer than the newest crash recorded', () => {
    expect(combine({ runtime: running(exit), probe: OK, newestCrashAt: T1 }).events).toEqual([]);
    expect(combine({ runtime: running(exit), probe: OK, newestCrashAt: NOW }).events).toEqual([]);
  });

  it('records one newer than the newest crash', () => {
    expect(combine({ runtime: running(exit), probe: OK, newestCrashAt: T0 }).events).toHaveLength(
      1,
    );
  });

  it('names a memory kill, and records it beside a transition', () => {
    const next = combine({
      runtime: running({ exitCode: 137, oomKilled: true, at: T1 }),
      probe: FAIL,
      previous: prev('healthy', 1),
    });
    expect(next.events.map((e) => [e.kind, e.reason, e.exitCode])).toEqual([
      ['crashed', 'out of memory', null],
      ['health_check_failed', 'HTTP 503', null],
    ]);
  });
});

describe('exitReason', () => {
  it('names an exit', () => {
    expect(exitReason({ exitCode: 2, oomKilled: false })).toBe('exit code 2');
    expect(exitReason({ exitCode: null, oomKilled: false })).toBe('exited');
    expect(exitReason({ exitCode: 137, oomKilled: true })).toBe('out of memory');
  });
});
