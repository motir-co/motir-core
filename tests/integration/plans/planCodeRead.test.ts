import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import {
  InvalidPlanStepError,
  PlanNotFoundError,
  PlanNotGeneratingError,
} from '@/lib/plans/errors';
import { PLAN_CODE_READ_BATCH_MAX } from '@/lib/plans/planCodeRead';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../../helpers/sqlstate';

// MOTIR-10122 — a plan KEEPS every code read its planner sessions made
// (`plan_code_read`): what was asked, the COMMIT it was read at and how much came
// back, never the code. Every case drives `plansService` against real Postgres
// and reads the stored rows back through `adminDb`, so a service that refused yet
// returned a plausible DTO cannot pass.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SHA_A = 'a'.repeat(40);
const SHA_B = '4aadf3c0123456789abcdef0123456789abcdef0';

async function generatingPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The search story', kind: 'story' } }],
    fx.ctx,
  );
  return plan.id;
}

const readsOf = (planId: string) =>
  adminDb.planCodeRead.findMany({ where: { planId }, orderBy: { seq: 'asc' } });

const fileRead = {
  tool: 'read_file',
  repo: 'acme/web',
  path: 'lib/search.ts',
  startLine: 10,
  endLine: 40,
  askedRef: 'main',
  commits: [{ repo: 'acme/web', sha: SHA_A }],
  outcome: 'found',
  lines: 31,
};

describe('recordPlanCodeReads — appends the session’s reads, in call order', () => {
  it('stores each read with a plan-wide seq that continues across calls and sessions', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);

    const first = await plansService.recordPlanCodeReads(
      planId,
      {
        sessionKey: 'plan.py:run:001',
        codeReads: [
          fileRead,
          {
            tool: 'code_search',
            query: 'searchIssues',
            commits: [{ repo: 'acme/web', sha: SHA_B.toUpperCase() }],
            outcome: 'ok',
            hits: 3,
          },
        ],
      },
      fx.ctx,
    );
    expect(first.map((r) => [r.seq, r.tool])).toEqual([
      [1, 'read_file'],
      [2, 'code_search'],
    ]);
    // A sha is stored canonical — lower-cased — so it is one key, not two.
    expect(first[1]!.commits).toEqual([{ repo: 'acme/web', sha: SHA_B }]);

    const second = await plansService.recordPlanCodeReads(
      planId,
      {
        sessionKey: 'ai:job:2',
        codeReads: [
          {
            tool: 'Read',
            repo: 'motir-core',
            path: 'lib/a.ts',
            commits: [{ sha: SHA_A, dirty: true }],
            outcome: 'found',
            lines: 12,
          },
        ],
      },
      fx.ctx,
    );
    expect(second[0]).toMatchObject({ seq: 3, sessionKey: 'ai:job:2' });

    const rows = await readsOf(planId);
    expect(rows.map((r) => [r.sessionKey, r.seq, r.tool, r.path, r.startLine, r.endLine])).toEqual([
      ['plan.py:run:001', 1, 'read_file', 'lib/search.ts', 10, 40],
      ['plan.py:run:001', 2, 'code_search', null, null, null],
      ['ai:job:2', 3, 'Read', 'lib/a.ts', null, null],
    ]);
    expect(rows[2]!.commits).toEqual([{ sha: SHA_A, dirty: true }]);
    expect(rows[0]!.askedRef).toBe('main');
  });

  it('needs NO step — a session that never reported one (plan.py’s PART 1) still records', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const [row] = await plansService.recordPlanCodeReads(
      planId,
      { sessionKey: 'conversation', codeReads: [fileRead] },
      fx.ctx,
    );
    expect(row).toMatchObject({ seq: 1, sessionKey: 'conversation' });
  });

  it('records a REFUSED read with its refusal, and a read with no resolved commit', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanCodeReads(
      planId,
      {
        sessionKey: 's1',
        codeReads: [
          { ...fileRead, outcome: 'too_large', lines: undefined, detail: 'over 1048576 bytes' },
          {
            tool: 'read_file',
            repo: 'acme/web',
            path: 'x.ts',
            askedRef: 'gone',
            outcome: 'ref_not_found',
          },
        ],
      },
      fx.ctx,
    );
    const rows = await readsOf(planId);
    expect(rows.map((r) => [r.outcome, r.detail, r.commits])).toEqual([
      ['too_large', 'over 1048576 bytes', [{ repo: 'acme/web', sha: SHA_A }]],
      ['ref_not_found', null, []],
    ]);
  });

  it.each([
    ['an empty batch', []],
    ['a batch over the cap', Array.from({ length: PLAN_CODE_READ_BATCH_MAX + 1 }, () => fileRead)],
    ['a branch name as a sha', [{ ...fileRead, commits: [{ sha: 'main' }] }]],
    ['a read with no tool', [{ ...fileRead, tool: '' }]],
    ['a read with no outcome', [{ ...fileRead, outcome: undefined }]],
    ['a read carrying file content', [{ ...fileRead, text: 'export const secret = 1;' }]],
    ['an end line before the start line', [{ ...fileRead, startLine: 9, endLine: 2 }]],
  ])('refuses %s, writing nothing', async (_label, codeReads) => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await expect(
      plansService.recordPlanCodeReads(planId, { sessionKey: 's1', codeReads }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await readsOf(planId)).toEqual([]);
  });

  it('caps a long field and never stores more than the cap', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const [row] = await plansService.recordPlanCodeReads(
      planId,
      { sessionKey: 's1', codeReads: [{ ...fileRead, detail: 'd'.repeat(5000) }] },
      fx.ctx,
    );
    expect(Array.from(row!.detail!)).toHaveLength(200);
    expect(row!.detail!.endsWith('…')).toBe(true);
  });

  it('is refused once the plan is no longer generating', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      plansService.recordPlanCodeReads(planId, { sessionKey: 's1', codeReads: [fileRead] }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotGeneratingError);
    expect(await readsOf(planId)).toEqual([]);
  });

  it('is the fourth exclusive form of reportPlanStep, and names no target', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const result = await plansService.reportPlanStep(
      planId,
      { sessionKey: 's1', targetRef: null, codeReads: [fileRead] },
      fx.ctx,
    );
    expect(result.kind).toBe('codeReads');
    await expect(
      plansService.reportPlanStep(
        planId,
        { sessionKey: 's1', targetRef: 'planItem:x', codeReads: [fileRead] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    await expect(
      plansService.reportPlanStep(
        planId,
        { sessionKey: 's1', targetRef: null, step: 'settle', codeReads: [fileRead] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await readsOf(planId)).toHaveLength(1);
  });
});

describe('listPlanCodeReads — reads back by plan and session, in call order', () => {
  it('pages in seq order, filters one session and carries its step words', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'lay', kind: 'lay', targetRef: null },
      fx.ctx,
    );
    await plansService.recordPlanCodeReads(
      planId,
      { sessionKey: 'lay', codeReads: [fileRead, { ...fileRead, path: 'lib/b.ts' }] },
      fx.ctx,
    );
    await plansService.recordPlanCodeReads(
      planId,
      { sessionKey: 'other', codeReads: [{ ...fileRead, path: 'lib/c.ts' }] },
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    // Readable after the plan is decided-ready — it is evidence, not a live signal.
    const first = await plansService.listPlanCodeReads(planId, { limit: 2 }, fx.ctx);
    expect(first.reads.map((r) => [r.seq, r.path])).toEqual([
      [1, 'lib/search.ts'],
      [2, 'lib/b.ts'],
    ]);
    expect(first.sessions.map((s) => [s.sessionKey, s.stepKind])).toEqual([['lay', 'lay']]);
    expect(first.nextAfterSeq).toBe(2);

    const rest = await plansService.listPlanCodeReads(planId, { afterSeq: 2 }, fx.ctx);
    expect(rest.reads.map((r) => r.path)).toEqual(['lib/c.ts']);
    expect(rest.sessions).toEqual([]);
    expect(rest.nextAfterSeq).toBeNull();

    const one = await plansService.listPlanCodeReads(planId, { sessionKey: 'other' }, fx.ctx);
    expect(one.reads.map((r) => r.sessionKey)).toEqual(['other']);
  });

  it('answers another workspace’s plan as not found', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await expect(plansService.listPlanCodeReads(planB, {}, a.ctx)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
  });

  it('cascades away with the plan', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanCodeReads(
      planId,
      { sessionKey: 's', codeReads: [fileRead] },
      fx.ctx,
    );
    await adminDb.plan.delete({ where: { id: planId } });
    expect(await readsOf(planId)).toEqual([]);
  });
});

describe('plan_code_read RLS — the gate is the parent plan', () => {
  async function asAppRole<T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return fn(tx);
    });
  }

  it('another workspace’s reads are neither readable nor writable', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await plansService.recordPlanCodeReads(
      planB,
      { sessionKey: 'b', codeReads: [fileRead] },
      b.ctx,
    );

    expect(await asAppRole(a.workspaceId, (tx) => tx.planCodeRead.findMany())).toEqual([]);
    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.planCodeRead.create({
          data: {
            planId: planB,
            sessionKey: 'x',
            seq: 99,
            tool: 'Read',
            commits: [],
            outcome: 'found',
          },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    expect(await asAppRole(b.workspaceId, (tx) => tx.planCodeRead.findMany())).toHaveLength(1);
  });
});
