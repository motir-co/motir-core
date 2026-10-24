import { describe, expect, it } from 'vitest';
import {
  CONTAINER_RATES,
  FLEET_CONTAINER_SIZE,
  OrchestratorApiError,
  OrchestratorNotConfiguredError,
  billableSecondsFor,
  buildContainerUsage,
  isUnpriced,
  resolveContainerRate,
  type ContainerHandle,
  type ContainerRate,
  type UsageAttribution,
} from '../src/index';

// The CONTAINER RATE TABLE and the §5 record's arithmetic (Story MOTIR-1916 ·
// MOTIR-1921). Pure — no DB, no network.
//
// These are the assertions that make the ADR's cost model a MEASUREMENT rather
// than a paragraph: §8's figures are reproduced from the components, so a wrong
// rate row fails here instead of surfacing as margin drift a quarter later.

const HANDLE: ContainerHandle = {
  provider: 'fly',
  id: 'machine-1',
  region: 'iad',
  createdAt: new Date('2026-08-02T10:00:00.000Z'),
};

const ATTRIBUTION: UsageAttribution = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  repoFullName: 'motir-projects/acme-web',
  workload: 'ci_runner',
  workflowJobId: 44001,
  size: FLEET_CONTAINER_SIZE,
  observedStartedAt: null,
};

const AFTER_EFFECTIVE = new Date('2026-08-02T10:00:00.000Z');

describe('the rate table reproduces the ADR §8 cost model', () => {
  it("the Amsterdam row round-trips §8's ≈$0.00195/min figure exactly", () => {
    // §8 computes the fleet runner all-in as performance-2x + 4 GB extra RAM and
    // states "≈ $0.00195 / min". Reproducing it from the row is what proves the
    // METHOD is right — if this drifts, either the row or the ADR is wrong, and
    // the failure names which.
    const rate = resolveContainerRate('fly', FLEET_CONTAINER_SIZE, 'ams', AFTER_EFFECTIVE);
    expect(rate).not.toBeNull();
    const perMinute = Number(rate?.usdPerSecond) * 60;
    expect(perMinute).toBeCloseTo(0.00195336, 8);
  });

  it("the `iad` row the fleet actually runs on is CHEAPER than the ADR's Amsterdam figure", () => {
    // ⚠️ §8 shows AMSTERDAM and flags that "a per-region ratio applies". Verified
    // against Fly's pricing page 2026-08-02: performance-2x is $0.00002392/s in
    // `iad` against $0.00002484/s in `ams`. §11 fixes the fleet in `iad`, so the
    // row that bills is the cheaper one — and the difference is a DATUM here
    // rather than a caveat in prose.
    const iad = resolveContainerRate('fly', FLEET_CONTAINER_SIZE, 'iad', AFTER_EFFECTIVE);
    const ams = resolveContainerRate('fly', FLEET_CONTAINER_SIZE, 'ams', AFTER_EFFECTIVE);
    expect(Number(iad?.usdPerSecond)).toBeLessThan(Number(ams?.usdPerSecond));
    expect(Number(iad?.usdPerSecond) * 60).toBeCloseTo(0.00189816, 8);
  });

  it('every rate is a DECIMAL STRING, never a float', () => {
    // §5's requirement. A number here would be invisible per row and systematic
    // across a month — the error shape a reconciliation is worst at catching.
    for (const rate of CONTAINER_RATES) {
      expect(typeof rate.usdPerSecond).toBe('string');
      expect(rate.usdPerSecond).toMatch(/^\d+\.\d+$/);
    }
  });

  it('every row cites a vendor-direct source (`notes.html` #88)', () => {
    for (const rate of CONTAINER_RATES) {
      expect(rate.source.length).toBeGreaterThan(0);
    }
  });
});

describe('resolution is EFFECTIVE-DATED and exact on every key', () => {
  it('a container that ran BEFORE the row took effect resolves to no rate', () => {
    // §3.3's convention: a rate is never backfilled, so history cannot re-price.
    const before = new Date('2026-07-31T23:59:59.000Z');
    expect(resolveContainerRate('fly', FLEET_CONTAINER_SIZE, 'iad', before)).toBeNull();
  });

  it('an unknown region resolves to no rate rather than borrowing another', () => {
    // Borrowing `iad`'s price for `syd` would be a priced GUESS — the exact shape
    // of `notes.html` #88 one domain over.
    expect(resolveContainerRate('fly', FLEET_CONTAINER_SIZE, 'syd', AFTER_EFFECTIVE)).toBeNull();
  });

  it('a different machine class resolves to no rate', () => {
    const shared = { cpuKind: 'shared' as const, cpus: 4, memoryMb: 8192 };
    expect(resolveContainerRate('fly', shared, 'iad', AFTER_EFFECTIVE)).toBeNull();
  });

  // ⚠️ EACH KEY, ON ITS OWN. The `shared` case above differs in three fields at
  // once, so only the FIRST mismatch is ever exercised and a resolver that
  // stopped comparing cpus (or memory) would still pass it. A rate is a price
  // per machine class: matching the wrong one bills Motir's 2-core cost against
  // an 8-core container, and the error is systematic rather than visible.
  it('the same class with MORE CPUS resolves to no rate — cpus is compared on its own', () => {
    const bigger = { ...FLEET_CONTAINER_SIZE, cpus: FLEET_CONTAINER_SIZE.cpus + 2 };
    expect(resolveContainerRate('fly', bigger, 'iad', AFTER_EFFECTIVE)).toBeNull();
  });

  it('the same class with MORE MEMORY resolves to no rate — memory is compared on its own', () => {
    const roomier = { ...FLEET_CONTAINER_SIZE, memoryMb: FLEET_CONTAINER_SIZE.memoryMb * 2 };
    expect(resolveContainerRate('fly', roomier, 'iad', AFTER_EFFECTIVE)).toBeNull();
  });

  it('a different provider resolves to no rate', () => {
    expect(resolveContainerRate('arc', FLEET_CONTAINER_SIZE, 'iad', AFTER_EFFECTIVE)).toBeNull();
  });

  it('matches the region case-insensitively', () => {
    expect(
      resolveContainerRate('fly', FLEET_CONTAINER_SIZE, ' IAD ', AFTER_EFFECTIVE),
    ).not.toBeNull();
  });

  describe('a REPRICING is a new row, and the LATEST one in force wins (§3.3)', () => {
    // ⚠️ The shipped table has one row per key, so this rule cannot be exercised
    // against it — which would leave §3.3's central promise unproven until the
    // first real Fly repricing, i.e. until the worst possible moment to find out
    // it was wrong. A two-row fixture is how the comparison gets tested at all.
    const OLD: ContainerRate = {
      provider: 'fly',
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 8192,
      region: 'iad',
      usdPerSecond: '0.000031636049',
      effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
      source: 'test',
    };
    const NEW: ContainerRate = {
      ...OLD,
      usdPerSecond: '0.000041000000',
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
    };
    // Deliberately NEWEST-FIRST, so a resolver that simply took the last match
    // would pass by accident. Order must not decide the answer; the date must.
    const table = [NEW, OLD];

    it('a container that ran AFTER the repricing takes the new rate', () => {
      const rate = resolveContainerRate(
        'fly',
        FLEET_CONTAINER_SIZE,
        'iad',
        new Date('2026-09-15T00:00:00.000Z'),
        table,
      );
      expect(rate?.usdPerSecond).toBe('0.000041000000');
    });

    it('a container that ran BEFORE it keeps the old rate — history never re-prices', () => {
      const rate = resolveContainerRate(
        'fly',
        FLEET_CONTAINER_SIZE,
        'iad',
        new Date('2026-08-15T00:00:00.000Z'),
        table,
      );
      expect(rate?.usdPerSecond).toBe('0.000031636049');
    });

    it('takes the LATEST in-force row even when the table lists it first', () => {
      // The `best === null || newer` comparison, exercised in both directions:
      // with the newest entry first, the second iteration must NOT displace it.
      const rate = resolveContainerRate(
        'fly',
        FLEET_CONTAINER_SIZE,
        'iad',
        new Date('2026-12-01T00:00:00.000Z'),
        table,
      );
      expect(rate).toBe(NEW);
      expect(
        resolveContainerRate(
          'fly',
          FLEET_CONTAINER_SIZE,
          'iad',
          new Date('2026-12-01T00:00:00.000Z'),
          [OLD, NEW],
        ),
      ).toBe(NEW);
    });
  });
});

describe('billable seconds — ceil, and ZERO for a container that never ran', () => {
  it('rounds a partial second UP', () => {
    const started = new Date('2026-08-02T10:00:00.000Z');
    const stopped = new Date('2026-08-02T10:00:30.400Z');
    expect(billableSecondsFor(started, stopped)).toBe(31);
  });

  it('is zero when the container never started', () => {
    expect(billableSecondsFor(null, new Date())).toBe(0);
  });

  it('clamps an impossible (negative) span to zero rather than crediting it', () => {
    const started = new Date('2026-08-02T10:05:00.000Z');
    const stopped = new Date('2026-08-02T10:00:00.000Z');
    expect(billableSecondsFor(started, stopped)).toBe(0);
  });
});

describe('the §5 record', () => {
  it('costs a real run in DECIMAL, with the applied row recorded', () => {
    const startedAt = new Date('2026-08-02T10:00:00.000Z');
    const stoppedAt = new Date('2026-08-02T10:05:00.000Z'); // 300s
    const usage = buildContainerUsage({
      handle: HANDLE,
      attribution: ATTRIBUTION,
      reason: 'job_completed',
      lifecycle: { createdAt: HANDLE.createdAt, startedAt, stoppedAt, terminalState: 'destroyed' },
    });

    expect(usage.billableSeconds).toBe(300);
    expect(usage.usdPerSecond).toBe('0.000031636049');
    // 300 × 0.000031636049 — exact decimal multiplication, no float rounding.
    expect(usage.costUsd).toBe('0.0094908147');
    expect(usage.rateEffectiveFrom).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(isUnpriced(usage)).toBe(false);
  });

  it('carries the attribution the meter reads WITHOUT a join (§5)', () => {
    const usage = buildContainerUsage({
      handle: HANDLE,
      attribution: ATTRIBUTION,
      reason: 'job_completed',
      lifecycle: {
        createdAt: HANDLE.createdAt,
        startedAt: HANDLE.createdAt,
        stoppedAt: new Date('2026-08-02T10:00:10.000Z'),
        terminalState: 'destroyed',
      },
    });
    expect(usage).toMatchObject({
      orgId: 'org-1',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      repoFullName: 'motir-projects/acme-web',
      workflowJobId: 44001,
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 8192,
      teardownReason: 'job_completed',
      terminalState: 'destroyed',
    });
  });

  it('a container that never started costs NOTHING but still produces a row', () => {
    // §5: "a container with no usage row is a bug with a name". A failed boot is
    // still a provisioned handle, so it still gets a row — it just costs zero,
    // because Fly bills a Machine on its RUNNING seconds and charging ourselves
    // for it would make the reconciliation disagree with the invoice by
    // construction.
    const usage = buildContainerUsage({
      handle: HANDLE,
      attribution: ATTRIBUTION,
      reason: 'provision_failed',
      lifecycle: {
        createdAt: HANDLE.createdAt,
        startedAt: null,
        stoppedAt: new Date('2026-08-02T10:02:00.000Z'),
        terminalState: 'created',
      },
    });
    expect(usage.billableSeconds).toBe(0);
    expect(usage.costUsd).toBe('0');
    expect(usage.startedAt).toBeNull();
    expect(usage.teardownReason).toBe('provision_failed');
  });

  it('an UNPRICED triple records a zero rate and a null effective-from, not a guess', () => {
    const unpricedRegion: ContainerHandle = { ...HANDLE, region: 'syd' };
    const usage = buildContainerUsage({
      handle: unpricedRegion,
      attribution: ATTRIBUTION,
      reason: 'job_completed',
      lifecycle: {
        createdAt: HANDLE.createdAt,
        startedAt: HANDLE.createdAt,
        stoppedAt: new Date('2026-08-02T10:01:00.000Z'),
        terminalState: 'destroyed',
      },
    });
    expect(usage.billableSeconds).toBe(60);
    expect(usage.usdPerSecond).toBe('0');
    expect(usage.costUsd).toBe('0');
    expect(usage.rateEffectiveFrom).toBeNull();
    // The two together are the unambiguous "cost unknown" signal, distinguishable
    // from a genuine zero-second row by the billable seconds beside them.
    expect(isUnpriced(usage)).toBe(true);
  });

  it('resolves the rate at `stoppedAt`, not at "now"', () => {
    // A container that ran across a repricing boundary is costed at the rate in
    // force WHILE IT RAN. Proven by stopping before the row's effective instant:
    // the rate is null even though "now" is well past it.
    const usage = buildContainerUsage({
      handle: HANDLE,
      attribution: ATTRIBUTION,
      reason: 'job_completed',
      lifecycle: {
        createdAt: new Date('2026-07-31T23:00:00.000Z'),
        startedAt: new Date('2026-07-31T23:00:00.000Z'),
        stoppedAt: new Date('2026-07-31T23:10:00.000Z'),
        terminalState: 'destroyed',
      },
    });
    expect(usage.rateEffectiveFrom).toBeNull();
  });
});

// ── The typed failures ──────────────────────────────────────────────────────

describe('the port’s typed errors name the PROVIDER and never the raw body', () => {
  it('a refusal reads as a status', () => {
    const err = new OrchestratorApiError('fly', 429, 'too many machines');
    expect(err.code).toBe('ORCHESTRATOR_API_FAILED');
    expect(err.provider).toBe('fly');
    expect(err.status).toBe(429);
    expect(err.message).toContain('HTTP 429');
    expect(err.message).toContain('too many machines');
  });

  it('a refusal with NO detail still reads cleanly — no dangling punctuation', () => {
    // A provider that refuses with an unreadable body is common enough that the
    // message must not degrade into `HTTP 500: undefined`.
    const err = new OrchestratorApiError('fly', 500, '');
    expect(err.message).toBe('The fly orchestrator refused a call (HTTP 500).');
  });

  it('an UNREACHABLE provider is a different sentence, not a status of null', () => {
    const err = new OrchestratorApiError('fake', null, 'socket hang up');
    expect(err.message).toBe('The fake orchestrator could not be reached (socket hang up).');
  });

  it('an unconfigured deployment says WHICH variables are missing', () => {
    const err = new OrchestratorNotConfiguredError('set FLY_FLEET_API_TOKEN');
    expect(err.code).toBe('ORCHESTRATOR_NOT_CONFIGURED');
    expect(err.message).toContain('FLY_FLEET_API_TOKEN');
  });
});

// ── The AWS row (MOTIR-9276) ────────────────────────────────────────────────

describe('the aws / us-east-1 row', () => {
  const AWS_HANDLE: ContainerHandle = {
    provider: 'aws',
    id: 'i-0abc',
    region: 'us-east-1',
    createdAt: new Date('2026-10-25T10:00:00.000Z'),
  };

  it('resolves for the fleet size after it took effect, and not before', () => {
    const rate = resolveContainerRate(
      'aws',
      FLEET_CONTAINER_SIZE,
      'us-east-1',
      new Date('2026-10-25T00:00:00.000Z'),
    );
    expect(rate?.usdPerSecond).toBe('0.000029577626');
    expect(rate?.effectiveFrom).toEqual(new Date('2026-10-24T00:00:00.000Z'));
    expect(
      resolveContainerRate('aws', FLEET_CONTAINER_SIZE, 'us-east-1', new Date('2026-10-23')),
    ).toBeNull();
  });

  it('is the sum of its cited parts: instance, two gp3 volumes, public IPv4', () => {
    // $0.096/h + $0.08 × 50 GB per 730 h + $0.005/h, per second.
    const parts = 0.096 / 3600 + (0.08 * 50) / (730 * 3600) + 0.005 / 3600;
    expect(Number('0.000029577626')).toBeCloseTo(parts, 12);
  });

  it('cites the AWS pricing pages and the day they were read', () => {
    const rate = CONTAINER_RATES.find((r) => r.provider === 'aws')!;
    expect(rate.source).toContain('https://aws.amazon.com/ec2/pricing/on-demand/');
    expect(rate.source).toContain('https://aws.amazon.com/ebs/pricing/');
    expect(rate.source).toContain('https://aws.amazon.com/vpc/pricing/');
    expect(rate.source).toContain('2026-10-24');
  });

  it('prices an AWS usage row — not unpriced', () => {
    const usage = buildContainerUsage({
      handle: AWS_HANDLE,
      attribution: ATTRIBUTION,
      reason: 'job_completed',
      lifecycle: {
        createdAt: AWS_HANDLE.createdAt,
        startedAt: AWS_HANDLE.createdAt,
        stoppedAt: new Date('2026-10-25T10:10:00.000Z'),
        terminalState: 'destroyed',
      },
    });
    expect(isUnpriced(usage)).toBe(false);
    expect(usage.costUsd).toBe('0.0177465756');
  });
});
