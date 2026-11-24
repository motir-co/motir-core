import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { engineJob } from '@/lib/jobs/engine/registry';
// ⚠️ IMPORTED FOR ITS SIDE EFFECT. `defineJob` registers at MODULE EVALUATION,
// so a file that only asks the registry finds an empty one.
import '@/lib/jobs/registry';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { FLEET_TIME_BUDGETS } from '@/lib/services/ciRunnerBootService';
import { SUB_HOURLY_CADENCE } from '@/lib/jobs/schedules';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { seedIndexWorkspace } from '../helpers/indexFleet';

// ═══════════════════════════════════════════════════════════════════════════
// STORY GATE — a supervision is a SELF-RESCHEDULING RUN (MOTIR-3778 · MOTIR-3831)
// ═══════════════════════════════════════════════════════════════════════════
//
// The story's vitest gate. It is deliberately NOT a second copy of the per-card
// suites: it asserts the ARCHITECTURE GUARDS a coverage percentage cannot see —
// no timing constant in the driver, the budgets byte-identical, §14.1's refusal
// intact, one composition per fleet, the cron on the cluster, and the tenancy
// predicate biting.
//
// ⚠️ ITS §1 SEAMS LEFT WITH THE INDEX FLEET (MOTIR-12036). They drove a whole
// index supervision through the real worker; the index jobs now hand off to
// motir-codegraph and supervise no container. The CI runner and hosted-agent
// supervisions keep their own seam suites (`tests/ciFleet/`, `tests/hostedRuns/`).

const SUPERVISION_SOURCES = [
  'lib/jobs/supervision/driver.ts',
  'lib/jobs/supervision/inProcessSteps.ts',
];

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await truncateJobRuns();
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** A queued run in a workspace of its own — the row a supervision belongs to. */
async function queuedRun(): Promise<{ runId: string; workspaceId: string }> {
  seq += 1;
  const { workspaceId } = await seedIndexWorkspace(`gate${seq}`, 1);
  const jobEvent = await adminDb.jobEvent.create({
    data: { name: 'system.ci-runner-boot', data: {}, workspaceId },
  });
  const run = await adminDb.jobQueueRun.create({
    data: {
      jobId: 'system.ci-runner-boot',
      eventId: jobEvent.id,
      eventName: 'system.ci-runner-boot',
      workspaceId,
      runAt: new Date(),
      maxAttempts: 3,
    },
  });
  return { runId: run.id, workspaceId };
}

// ───────────────────────────────────────────────────────────────────────────
// §2 · THE GUARDS
// ───────────────────────────────────────────────────────────────────────────

describe('§2.1 no timing constant lives in the driver', () => {
  it('takes its wait, its ceiling and its timeout from the caller', () => {
    // ⚠️ THE POINT IS NOT TIDINESS. A cadence with two homes is a cadence that
    // drifts, and §16.6 forbids this story moving a single value — so the
    // driver is written so that it CANNOT hold one. `waitMs`, `maxPolls` and
    // `timeoutMs` are all hooks.
    for (const path of SUPERVISION_SOURCES) {
      const code = readFileSync(path, 'utf8')
        // Strip comments: the header discusses the fleets' numbers at length,
        // and prose about a constant is not a constant.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // A duration literal is four digits or more, or any `_`-grouped number.
      expect(code, `${path} must hold no duration literal`).not.toMatch(/\b\d{4,}\b|\b\d+_\d+\b/);
    }
  });
});

describe('§2.2 the budgets are byte-identical to their pre-story values', () => {
  it('the CI fleet’s (the index fleet and its admission budget left with MOTIR-12036)', () => {
    expect(FLEET_TIME_BUDGETS).toEqual({
      bootDeadlineMs: 120_000,
      // ADDED by MOTIR-11230 (the idle-runner retirement), after this story; every
      // budget this story pinned is unchanged.
      idleTimeoutMs: 300_000,
      jobTimeoutMs: 3_600_000,
      pollIntervalMs: 3_000,
      maxPollIntervalMs: 30_000,
      reapAfterMs: 4_200_000,
      maxPollIterations: 2_000,
      stepWorkBudgetMs: 120_000,
      mintDeadlineMs: 15_000,
      containerCallDeadlineMs: 30_000,
    });
  });
});

describe('§2.3 §14.1’s refusal is intact', () => {
  it('`DefineJobOptions` gains no member and `claimDueRuns` gains no predicate', () => {
    // The two things §15.2's test names as deciding which side of §14.1 a change
    // is on. Two noes ⇒ untouched.
    const defineJob = readFileSync('lib/jobs/defineJob.ts', 'utf8');
    expect(defineJob).not.toMatch(/^\s*concurrency\??:/m);
    expect(defineJob).not.toMatch(/^\s*supervision\??:/m);

    const claim = readFileSync('lib/repositories/jobQueueRepository.ts', 'utf8');
    const from = claim.indexOf('async claimDueRuns');
    const statement = claim.slice(from, claim.indexOf('RETURNING', from));
    expect(statement.length, 'the claim statement must be findable').toBeGreaterThan(0);
    // The four load-bearing properties of the claim, unchanged…
    expect(statement).toMatch(/WITH due AS MATERIALIZED/);
    expect(statement).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(statement).toMatch(/ORDER BY "run_at"/);
    // …and nothing about supervision anywhere near it.
    expect(statement).not.toMatch(/supervision/i);
  });
});

describe('§2.4 exactly ONE supervision composition exists per fleet', () => {
  it('the job path and the in-process wrapper drive the same machine', () => {
    for (const path of [
      'lib/services/ciRunnerBootService.ts',
      'lib/services/hostedAgentContainerService.ts',
    ]) {
      const code = readFileSync(path, 'utf8');
      // ONE call site of the shared machine per fleet — a copy-pasted second
      // composition is what MOTIR-3484 and MOTIR-3485 each spent a card
      // deleting, and it is not coming back one layer up.
      expect(code.match(/\badvanceSupervision</g) ?? [], path).toHaveLength(1);
      // And no loop left to be the second one.
      expect(code, path).not.toMatch(/for \(let iteration/);
    }
  });
});

describe('§2.5 the sweep’s cron is the sub-hourly cadence', () => {
  it('runs every 5 minutes', () => {
    const def = engineJob('system.supervision-sweep');
    expect(def).toBeDefined();
    expect(def!.cron).toBe(SUB_HOURLY_CADENCE);
  });
});

describe('§2.6 the supervision read is TENANCY-SCOPED', () => {
  it('an actor bound to one workspace sees one row out of three', async () => {
    // ⚠️ THE POPULATION AND THE VIEW MUST DIFFER, or the assertion passes
    // against a table with no policy at all.
    const live = await queuedRun();
    const other = await queuedRun();
    await withSystemContext(async (tx) => {
      await jobSupervisionRepository.open(
        {
          runId: live.runId,
          subject: 'a',
          kind: 'ci-runner',
          nextPollAt: new Date(),
          workspaceId: live.workspaceId,
        },
        tx,
      );
      await jobSupervisionRepository.open(
        {
          runId: other.runId,
          subject: 'b',
          kind: 'hosted-agent',
          nextPollAt: new Date(),
          workspaceId: other.workspaceId,
        },
        tx,
      );
      await jobSupervisionRepository.open(
        {
          runId: other.runId,
          subject: 'c',
          kind: 'ci-runner',
          nextPollAt: new Date(),
          workspaceId: other.workspaceId,
        },
        tx,
      );
    });

    const scoped = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${live.workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.jobSupervision.findMany();
    });

    expect(await adminDb.jobSupervision.count(), 'the true population').toBe(3);
    expect(
      scoped.map((r) => r.subject),
      'what the bound actor sees',
    ).toEqual(['a']);
  });
});
