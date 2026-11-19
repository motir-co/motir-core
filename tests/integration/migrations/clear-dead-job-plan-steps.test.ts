import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// Bug MOTIR-11833 — the forward, data-only migration that deletes every `plan_step` row a DEAD
// planning job left behind. Real Postgres; the SQL is replayed verbatim, as the deploy applies
// it, as the OWNER and as the non-bypass RUNTIME role — `plan_step`'s system arm is read-only,
// so under the runtime role only the per-workspace binding lets the DELETE through.

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261119220000_clear_dead_job_plan_steps/migration.sql'),
  'utf8',
);

/** Replay the migration as the database OWNER — the deploy's role. */
const runAsOwner = () => adminDb.$executeRawUnsafe(MIGRATION_SQL);
/** Replay it as the NON-BYPASS runtime role, inside one transaction so the `is_local`
 *  bindings scope to it exactly as `prisma migrate deploy` scopes them. */
const runAsAppRole = (sql = MIGRATION_SQL) => db.$transaction((tx) => tx.$executeRawUnsafe(sql));
/** The same migration with its per-workspace binding removed — the negative control. */
const UNBOUND_SQL = MIGRATION_SQL.replace(
  /^\s*PERFORM set_config\('app\.workspace_id', ws.*$/gm,
  '',
);

let scopeSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type SessionShape = 'running' | 'failed' | 'ended' | 'none';

/** A plan written by `sourceJobId`, in a session of the given shape, holding the given steps. */
async function planWith(
  fx: WorkItemFixture,
  opts: { sourceJobId: string | null; session: SessionShape; status?: 'generating' | 'planned' },
  stepKeys: string[],
) {
  let sessionId: string | null = null;
  if (opts.session !== 'none') {
    const failed = opts.session === 'failed';
    const session = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ownerId,
        scopeKey: `scope-${scopeSeq++}`,
        lastJobId: opts.sourceJobId,
        ...(failed
          ? { failedAt: new Date(), failedJobId: opts.sourceJobId, failureReason: 'rate_limited' }
          : {}),
        ...(opts.session === 'ended' ? { endedAt: new Date() } : {}),
      },
    });
    sessionId = session.id;
  }
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status: opts.status ?? 'generating',
      sourceJobId: opts.sourceJobId,
      createdById: fx.ownerId,
    },
  });
  for (const sessionKey of stepKeys) {
    await adminDb.planStep.create({
      data: { planId: plan.id, sessionKey, kind: 'author', targetRef: null, startedAt: new Date() },
    });
  }
  return plan.id;
}

const keysOf = async (planId: string) =>
  (await adminDb.planStep.findMany({ where: { planId }, orderBy: { sessionKey: 'asc' } })).map(
    (row) => row.sessionKey,
  );

/** The production shape and every arm beside it, across two workspaces. */
async function seedEstate() {
  const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
  const b = await makeWorkItemFixture({ name: 'Bravo', identifier: 'BRAV' });
  return {
    // Resumed: job-old died with authors in flight, job-new runs now. A plan.py key is opaque.
    resumed: await planWith(a, { sourceJobId: 'job-new', session: 'running' }, [
      'ai:job-old:3',
      'ai:job-old:20',
      'ai:job-new:1',
      'plan-py-1',
    ]),
    // Failed and not yet resumed: every step goes, whoever wrote it.
    failed: await planWith(b, { sourceJobId: 'job-f', session: 'failed' }, [
      'ai:job-f:1',
      'plan-py-2',
    ]),
    // A failed REVISION beside a planned plan — the failure record's own rule.
    failedRevision: await planWith(
      a,
      { sourceJobId: 'job-r', session: 'failed', status: 'planned' },
      ['ai:job-r:1'],
    ),
    // Healthy: the current job's own steps, and an opaque key, are live.
    healthy: await planWith(b, { sourceJobId: 'job-h', session: 'running' }, [
      'ai:job-h:1',
      'plan-py-3',
    ]),
    // An ENDED session carries no failure (`plan_change_session_one_wait`): only a job that is
    // not the plan's current one is judged, so its current job's step stays.
    ended: await planWith(a, { sourceJobId: 'job-e', session: 'ended' }, ['ai:job-e:1']),
    // No session, no hosted job: an `ai:` key names no current job, so it is dead.
    sessionless: await planWith(b, { sourceJobId: null, session: 'none' }, [
      'ai:job-x:1',
      'plan-py-4',
    ]),
  };
}

async function expectCleared(plans: Awaited<ReturnType<typeof seedEstate>>) {
  expect(await keysOf(plans.resumed)).toEqual(['ai:job-new:1', 'plan-py-1']);
  expect(await keysOf(plans.failed)).toEqual([]);
  expect(await keysOf(plans.failedRevision)).toEqual([]);
  expect(await keysOf(plans.healthy)).toEqual(['ai:job-h:1', 'plan-py-3']);
  expect(await keysOf(plans.ended)).toEqual(['ai:job-e:1']);
  expect(await keysOf(plans.sessionless)).toEqual(['plan-py-4']);
}

describe('the migration file', () => {
  it('cites the bug it applies and changes no schema', () => {
    expect(MIGRATION_SQL).toContain('MOTIR-11833');
    expect(MIGRATION_SQL).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|TYPE|INDEX|POLICY)\b/i);
  });
});

describe('20261119220000_clear_dead_job_plan_steps', () => {
  it('as the OWNER, deletes exactly the dead jobs’ steps', async () => {
    const plans = await seedEstate();
    await runAsOwner();
    await expectCleared(plans);
  });

  it('as the non-bypass RUNTIME role, deletes the same rows in every workspace', async () => {
    const plans = await seedEstate();
    await runAsAppRole();
    await expectCleared(plans);
  });

  it('without the per-workspace binding the runtime role deletes NOTHING (control)', async () => {
    expect(UNBOUND_SQL).not.toEqual(MIGRATION_SQL);
    const plans = await seedEstate();
    const before = await adminDb.planStep.count();
    await runAsAppRole(UNBOUND_SQL);
    expect(await adminDb.planStep.count()).toBe(before);
    expect(await keysOf(plans.failed)).toEqual(['ai:job-f:1', 'plan-py-2']);
  });

  it('is idempotent — a second replay finds nothing', async () => {
    const plans = await seedEstate();
    await runAsOwner();
    await runAsAppRole();
    await expectCleared(plans);
  });

  it('is a no-op on a database with no step', async () => {
    await runAsOwner();
    await runAsAppRole();
    expect(await adminDb.planStep.count()).toBe(0);
  });
});
