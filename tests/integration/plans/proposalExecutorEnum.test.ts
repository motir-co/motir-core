import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { PATCH as proposalPATCH } from '@/app/api/internal/ai/plan-proposals/[itemId]/route';
import { plansService } from '@/lib/services/plansService';
import { PlanGrammarError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-10678 — a plan proposal's card-level `executor` is a CLOSED set at
// every plan door.
//
// ── The bug this reproduces ────────────────────────────────────────────────
// The same hole MOTIR-10656 closed for `priority`, one column over. motir-core's
// internal deepen / correct route forwards any string `executor`, the internal
// append forwards the whole `proposedFields`, the service merged and stored it
// unchecked, `validate_plan` answered `valid: true` (the persist gate had no
// `executor` arm — `leafFieldsOnContainer` only refuses one on a CONTAINER), and
// approve was refused by `prisma.workItem.create()` as `PLAN_ITEM_FIELD_REJECTED`.
// The public MCP doors enum the field in their tool schemas; the internal AI path
// did not.
//
// This file drives the REAL internal routes motir-ai calls, over a real job
// token, into real Postgres, and then forces a bad value past them to show the
// approve-time gate reports it before anyone presses Approve. Only an `add`
// carries a card executor: a `modify` patch never sets one (`validatePatchKeys`).

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function jobHeaders(fx: WorkItemFixture): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${SERVICE_SECRET}`,
    'x-motir-job-token': mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    }),
  };
}

function appendViaRoute(fx: WorkItemFixture, body: unknown): Promise<Response> {
  return proposalsPOST(
    new Request('http://core/api/internal/ai/plan-proposals', {
      method: 'POST',
      headers: jobHeaders(fx),
      body: JSON.stringify(body),
    }),
  );
}

function patchViaRoute(fx: WorkItemFixture, itemId: string, body: unknown): Promise<Response> {
  return proposalPATCH(
    new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
      method: 'PATCH',
      headers: jobHeaders(fx),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ itemId }) },
  );
}

/** A `generating` plan bound to `jobId`, holding one `add` — the deepen's starting state. */
async function planWithOneAdd(
  fx: WorkItemFixture,
  jobId: string,
): Promise<{ planId: string; itemId: string }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Hosted planner', sourceJobId: jobId, authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'Wire the queue', kind: 'task' } }],
    fx.ctx,
  );
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

async function storedExecutor(itemId: string): Promise<unknown> {
  const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
  return (row.proposedFields as { executor?: unknown } | null)?.executor;
}

describe('the internal AI routes refuse an out-of-enum card `executor` at write time', () => {
  it('the deepen PATCH refuses "agent" with a 422 naming the proposal and the field, and stores nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithOneAdd(fx, 'job-10678-deepen');
    const before = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });

    const res = await patchViaRoute(fx, itemId, {
      jobId: 'job-10678-deepen',
      patch: { executor: 'agent', descriptionMd: 'A body the refusal must not store either.' },
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string; planItemId?: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.planItemId).toBe(itemId);
    expect(body.error).toContain('Wire the queue');
    expect(body.error).toContain('`executor`');
    expect(body.error).toContain('"agent"');
    // The caller is a model: the refusal hands it the list it can act on.
    expect(body.error).toContain('coding_agent, human');

    const after = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    // The whole row is untouched — the refused write half-applied nothing.
    expect(after).toEqual(before);
  });

  it('the deepen PATCH still stores a legal executor, so the refusal is the value and not the field', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithOneAdd(fx, 'job-10678-legal');

    const res = await patchViaRoute(fx, itemId, {
      jobId: 'job-10678-legal',
      patch: { executor: 'human' },
    });

    expect(res.status).toBe(200);
    expect(await storedExecutor(itemId)).toBe('human');
  });

  it('`mode: "correct"` refuses "agent" on an `add` and leaves the proposal unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithOneAdd(fx, 'job-10678-correct');

    const res = await patchViaRoute(fx, itemId, {
      jobId: 'job-10678-correct',
      mode: 'correct',
      patch: { executor: 'agent' },
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string; planItemId?: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.planItemId).toBe(itemId);
    expect(body.error).toContain('`executor`');
    expect(await storedExecutor(itemId)).toBeUndefined();
  });

  it('the append POST refuses an `add` proposing "agent", naming it, and writes no proposal', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Hosted planner', sourceJobId: 'job-10678-append' },
      fx.ctx,
    );

    const res = await appendViaRoute(fx, {
      jobId: 'job-10678-append',
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'A fine card', kind: 'task', executor: 'coding_agent' },
        },
        { op: 'add', proposedFields: { title: 'Wire the queue', kind: 'task', executor: 'agent' } },
      ],
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.error).toContain('Wire the queue');
    expect(body.error).toContain('`executor`');
    // The whole batch is refused: not even its legal sibling was written.
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });
});

describe('a stored invalid card executor is reported by `validate_plan` before anyone presses Approve', () => {
  // Each case writes the bad value straight into the row with `adminDb` — a
  // state the doors above now make unreachable, which is why it has to be
  // forced here.

  it('`checkApprovability` (what `validate_plan` reads) rejects an `add` with `unknown_executor`', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithOneAdd(fx, 'job-10678-gate');
    await adminDb.planItem.update({
      where: { id: itemId },
      data: { proposedFields: { title: 'Wire the queue', kind: 'task', executor: 'agent' } },
    });

    const rejections = await plansService.checkApprovability(planId, fx.ctx);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.code).toBe('PLAN_GRAMMAR_VIOLATION');
    expect(rejections[0]!.reason).toBe('unknown_executor');
    expect(rejections[0]!.item).toContain(itemId);
    expect(rejections[0]!.message).toContain('agent');
  });

  it('approve refuses it as a typed grammar violation naming the proposal, and creates nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithOneAdd(fx, 'job-10678-approve');
    await plansService.markPlanned(planId, fx.ctx);
    await adminDb.planItem.update({
      where: { id: itemId },
      data: { proposedFields: { title: 'Wire the queue', kind: 'task', executor: 'agent' } },
    });

    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('unknown_executor');
    expect((err as PlanGrammarError).planItemId).toBe(itemId);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});
