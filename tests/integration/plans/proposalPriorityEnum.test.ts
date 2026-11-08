import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { PATCH as proposalPATCH } from '@/app/api/internal/ai/plan-proposals/[itemId]/route';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanGrammarError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-10656 — a plan proposal's `priority` is a CLOSED set at every plan door.
//
// ── The bug this reproduces ────────────────────────────────────────────────
// The hosted planner's author session wrote `priority: "p2"` through motir-ai's
// author tool, whose schema declared `priority: { type: 'string' }`. motir-core's
// internal deepen route forwards any string as `priority`, the service merged it
// unchecked, `validate_plan` answered `valid: true` (the persist gate had arms
// for `kind` and `type` and none for `priority`), and approve was refused by
// `prisma.workItem.create()` as `PLAN_ITEM_FIELD_REJECTED`. The public MCP doors
// had the enum all along; the internal AI path did not — MOTIR-3654's hole, one
// column over.
//
// This file drives the REAL internal routes motir-ai calls, over a real job
// token, into real Postgres, and then forces a bad value past them to show the
// approve-time gate reports it before anyone presses Approve.

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
    [{ op: 'add', proposedFields: { title: 'E2E acceptance journey', kind: 'task' } }],
    fx.ctx,
  );
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

async function storedPriority(itemId: string): Promise<unknown> {
  const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
  return (row.proposedFields as { priority?: unknown } | null)?.priority;
}

describe('the internal AI routes refuse an out-of-enum `priority` at write time', () => {
  it('the deepen PATCH refuses "p2" with a 422 naming the proposal and the field, and stores nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithOneAdd(fx, 'job-10656-deepen');
    const before = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });

    const res = await patchViaRoute(fx, itemId, {
      jobId: 'job-10656-deepen',
      patch: { priority: 'p2', descriptionMd: 'A body the refusal must not store either.' },
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string; planItemId?: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.planItemId).toBe(itemId);
    expect(body.error).toContain('E2E acceptance journey');
    expect(body.error).toContain('`priority`');
    expect(body.error).toContain('"p2"');
    // The caller is a model: the refusal hands it the list it can act on.
    expect(body.error).toContain('lowest, low, medium, high, highest');

    const after = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    // The whole row is untouched — the refused write half-applied nothing.
    expect(after).toEqual(before);
  });

  it('a 422 that names no persisted proposal keeps its old body — `planItemId` is added only when known', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithOneAdd(fx, 'job-10656-shape');

    // An `InvalidProposalError` with no id (the empty-title refusal) …
    const blank = await patchViaRoute(fx, itemId, {
      jobId: 'job-10656-shape',
      patch: { title: '   ' },
    });
    expect(blank.status).toBe(422);
    expect(Object.keys((await blank.json()) as object).sort()).toEqual(['code', 'error']);

    // … and a 422 of another class (a correction naming no proposal).
    const unresolved = await patchViaRoute(fx, itemId, {
      jobId: 'job-10656-shape',
      mode: 'correct',
      parentRef: 'planItem:does-not-exist',
    });
    expect(unresolved.status).toBe(422);
    expect(Object.keys((await unresolved.json()) as object).sort()).toEqual(['code', 'error']);
  });

  it('the deepen PATCH still stores a legal priority, so the refusal is the value and not the field', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithOneAdd(fx, 'job-10656-legal');

    const res = await patchViaRoute(fx, itemId, {
      jobId: 'job-10656-legal',
      patch: { priority: 'high' },
    });

    expect(res.status).toBe(200);
    expect(await storedPriority(itemId)).toBe('high');
  });

  it('`mode: "correct"` refuses "p2" on an `add` and leaves the proposal unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithOneAdd(fx, 'job-10656-correct');

    const res = await patchViaRoute(fx, itemId, {
      jobId: 'job-10656-correct',
      mode: 'correct',
      patch: { priority: 'p2' },
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string; planItemId?: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.planItemId).toBe(itemId);
    expect(body.error).toContain('`priority`');
    expect(await storedPriority(itemId)).toBeUndefined();
  });

  it('`mode: "correct"` refuses "p2" in a `modify`’s replacement patch', async () => {
    const fx = await makeWorkItemFixture();
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'An existing card' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Hosted planner', sourceJobId: 'job-10656-modify' },
      fx.ctx,
    );
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
      fx.ctx,
    );
    const itemId = appended.items[0]!.id;

    const res = await patchViaRoute(fx, itemId, {
      jobId: 'job-10656-modify',
      mode: 'correct',
      modifyPatch: { priority: 'p2' },
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string; planItemId?: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.planItemId).toBe(itemId);
    expect(body.error).toContain('`priority`');
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect((row.patch as { priority?: unknown }).priority).toBe('low');
  });

  it('the append POST refuses an `add` proposing "p2", naming it, and writes no proposal', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Hosted planner', sourceJobId: 'job-10656-append' },
      fx.ctx,
    );

    const res = await appendViaRoute(fx, {
      jobId: 'job-10656-append',
      proposals: [
        { op: 'add', proposedFields: { title: 'A fine card', kind: 'task', priority: 'medium' } },
        {
          op: 'add',
          proposedFields: { title: 'E2E acceptance journey', kind: 'task', priority: 'p2' },
        },
      ],
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.error).toContain('E2E acceptance journey');
    expect(body.error).toContain('`priority`');
    // The whole batch is refused: not even its legal sibling was written.
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });

  it('the append POST refuses a `modify` patching in "p2"', async () => {
    const fx = await makeWorkItemFixture();
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'An existing card' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Hosted planner', sourceJobId: 'job-10656-append-modify' },
      fx.ctx,
    );

    const res = await appendViaRoute(fx, {
      jobId: 'job-10656-append-modify',
      proposals: [{ op: 'modify', workItemId: target.id, patch: { priority: 'p2' } }],
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.error).toContain(target.id);
    expect(body.error).toContain('`priority`');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });
});

describe('a stored invalid priority is reported by `validate_plan` before anyone presses Approve', () => {
  // Each case writes the bad value straight into the row with `adminDb` — the
  // state production's plan `cmw7r4uvr03k301leeoxxi7y2` was in, and one the doors
  // above now make unreachable, which is why it has to be forced here.

  it('`checkApprovability` (what `validate_plan` reads) rejects an `add` with `unknown_priority`', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithOneAdd(fx, 'job-10656-gate');
    await adminDb.planItem.update({
      where: { id: itemId },
      data: { proposedFields: { title: 'E2E acceptance journey', kind: 'task', priority: 'p2' } },
    });

    const rejections = await plansService.checkApprovability(planId, fx.ctx);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.code).toBe('PLAN_GRAMMAR_VIOLATION');
    expect(rejections[0]!.reason).toBe('unknown_priority');
    expect(rejections[0]!.item).toContain(itemId);
    expect(rejections[0]!.message).toContain('p2');
  });

  it('rejects a stored `modify` patch carrying "p2" the same way', async () => {
    const fx = await makeWorkItemFixture();
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'An existing card' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'Hosted planner' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
      fx.ctx,
    );
    const itemId = appended.items[0]!.id;
    await adminDb.planItem.update({ where: { id: itemId }, data: { patch: { priority: 'p2' } } });

    const rejections = await plansService.checkApprovability(plan.id, fx.ctx);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.reason).toBe('unknown_priority');
    expect(rejections[0]!.item).toContain(itemId);
  });

  it('approve refuses it as a typed grammar violation naming the proposal, and creates nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithOneAdd(fx, 'job-10656-approve');
    await plansService.markPlanned(planId, fx.ctx);
    await adminDb.planItem.update({
      where: { id: itemId },
      data: { proposedFields: { title: 'E2E acceptance journey', kind: 'task', priority: 'p2' } },
    });

    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('unknown_priority');
    expect((err as PlanGrammarError).planItemId).toBe(itemId);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});
