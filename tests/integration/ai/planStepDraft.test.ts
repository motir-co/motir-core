import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { PLAN_ITEM_DRAFT_BODY_MAX, PLAN_ITEM_DRAFT_TITLE_MAX } from '@/lib/plans/planItemDraft';
import { POST as stepPOST } from '@/app/api/internal/ai/plan-step/route';
import { createTestWorkItem, makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Story MOTIR-11190 · Subtask MOTIR-11199) — the plan-step door's
// eighth form, `itemDraft`: an `author` session's in-flight card, end to end
// through the REAL route against a real Postgres.
//
// What is proven: the body-shape 400s, the 404 / 409 / 422 refusals that write
// nothing, the sequence guard under the plan lock (a stale report answers
// `applied: false`), the draft served on the overlay's live read only while the
// plan is `generating`, that NO report ever changes the stored proposal (row,
// `get_plan`, the review's items, approve's materialization, a refused deepen),
// and every way the draft is cleared.

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_code_read", "plan_step", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;

function report(fx: Fx, jobId: string, body: Record<string, unknown>): Promise<Response> {
  const token = mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
  return stepPOST(
    new Request('http://core/api/internal/ai/plan-step', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SERVICE_SECRET}`,
        'x-motir-job-token': token,
      },
      body: JSON.stringify({ jobId, ...body }),
    }),
  );
}

/** A `generating` plan bound to `jobId` with two `add`s, the first being authored. */
async function authoring(
  fx: Fx,
  jobId: string,
): Promise<{ planId: string; addId: string; otherId: string; target: string }> {
  const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [
      { op: 'add', proposedFields: { title: 'Stored title', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Another card', kind: 'task' } },
    ],
    fx.ctx,
  );
  const [addId, otherId] = appended.appendedItemIds as [string, string];
  const target = `planItem:${addId}`;
  const step = await report(fx, jobId, { sessionKey: 'author-1', step: 'author', target });
  expect(step.status).toBe(200);
  return { planId: plan.id, addId, otherId, target };
}

const drafts = (planId: string, fx: Fx) =>
  planReviewService.getPlanReview(planId, fx.ctx).then((r) => r.inFlightDrafts ?? []);

const storedItem = (id: string) => adminDb.planItem.findUniqueOrThrow({ where: { id } });

describe('POST /api/internal/ai/plan-step — itemDraft', () => {
  it('holds a draft beside the proposal and serves it on the live read', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_happy';
    const { planId, addId, target } = await authoring(fx, jobId);
    const before = await storedItem(addId);
    const versionBefore = (await planReviewService.getPlanReview(planId, fx.ctx)).reviewVersion;

    const res = await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 1, title: 'Live ti', descriptionMd: 'The first li' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ planId, itemDraft: { applied: true, seq: 1 } });

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(review.inFlightDrafts).toEqual([
      {
        planItemId: addId,
        sessionKey: 'author-1',
        seq: 1,
        title: 'Live ti',
        descriptionMd: 'The first li',
        explanationMd: null,
        updatedAt: expect.any(String),
      },
    ]);
    // Each applied report moves the poll's token, so `?since=` never reads `unchanged`.
    expect(review.reviewVersion).toBeDefined();
    expect(review.reviewVersion).not.toBe(versionBefore);

    // The stored card is untouched: row, review item and get_plan.
    expect(await storedItem(addId)).toEqual(before);
    expect(review.items.find((i) => i.planItemId === addId)?.title).toBe('Stored title');
    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.items.find((i) => i.id === addId)?.proposedFields).toEqual(before.proposedFields);
  });

  it('orders reports by seq under the lock: a stale one changes nothing', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_seq';
    const { planId, target } = await authoring(fx, jobId);

    const three = await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 3, title: 'Third', explanationMd: 'Why three' },
    });
    expect(await three.json()).toEqual({ planId, itemDraft: { applied: true, seq: 3 } });
    const versionAtThree = (await planReviewService.getPlanReview(planId, fx.ctx)).reviewVersion;

    const two = await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 2, title: 'Second' },
    });
    expect(two.status).toBe(200);
    expect(await two.json()).toEqual({ planId, itemDraft: { applied: false, seq: 3 } });
    const same = await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 3, title: 'Third again' },
    });
    expect(await same.json()).toEqual({ planId, itemDraft: { applied: false, seq: 3 } });
    expect((await drafts(planId, fx))[0]).toMatchObject({
      seq: 3,
      title: 'Third',
      explanationMd: 'Why three',
    });

    // A higher seq replaces the WHOLE draft: a field it omits is not started.
    await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 4, descriptionMd: 'Body' },
    });
    expect((await drafts(planId, fx))[0]).toMatchObject({
      seq: 4,
      title: null,
      descriptionMd: 'Body',
      explanationMd: null,
    });
    expect((await planReviewService.getPlanReview(planId, fx.ctx)).reviewVersion).not.toBe(
      versionAtThree,
    );
  });

  describe('refuses a malformed body with 400 and writes nothing', () => {
    const cases: [string, (target: string) => Record<string, unknown>][] = [
      [
        'another form beside it',
        (t) => ({ step: 'author', itemDraft: { target: t, seq: 1, title: 'x' } }),
      ],
      ['a non-object', () => ({ itemDraft: 'text' })],
      ['an array', () => ({ itemDraft: [] })],
      ['a top-level target', (t) => ({ target: t, itemDraft: { target: t, seq: 1, title: 'x' } })],
      ['a missing target', () => ({ itemDraft: { seq: 1, title: 'x' } })],
      ['a zero seq', (t) => ({ itemDraft: { target: t, seq: 0, title: 'x' } })],
      ['a fractional seq', (t) => ({ itemDraft: { target: t, seq: 1.5, title: 'x' } })],
      ['a string seq', (t) => ({ itemDraft: { target: t, seq: '1', title: 'x' } })],
      ['a non-string field', (t) => ({ itemDraft: { target: t, seq: 1, descriptionMd: 7 } })],
      ['no field at all', (t) => ({ itemDraft: { target: t, seq: 1 } })],
    ];
    it.each(cases)('%s', async (_name, body) => {
      const fx = await makeFixture();
      const jobId = 'job_draft_400';
      const { planId, target } = await authoring(fx, jobId);
      const res = await report(fx, jobId, { sessionKey: 'author-1', ...body(target) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'PLAN_STEP_INVALID' });
      expect(await drafts(planId, fx)).toEqual([]);
    });
  });

  it('refuses 422 a draft for a card the session is not authoring, or a field over its cap', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_422';
    const { planId, otherId, target } = await authoring(fx, jobId);
    await report(fx, jobId, { sessionKey: 'lay-1', step: 'lay', target });

    const refusals = [
      // not the session's author target
      { sessionKey: 'author-1', itemDraft: { target: `planItem:${otherId}`, seq: 1, title: 'x' } },
      // a session whose step is `lay`, not `author`
      { sessionKey: 'lay-1', itemDraft: { target, seq: 1, title: 'x' } },
      // a session with no step
      { sessionKey: 'nobody', itemDraft: { target, seq: 1, title: 'x' } },
      // over the caps
      {
        sessionKey: 'author-1',
        itemDraft: { target, seq: 1, title: 'x'.repeat(PLAN_ITEM_DRAFT_TITLE_MAX + 1) },
      },
      {
        sessionKey: 'author-1',
        itemDraft: { target, seq: 1, explanationMd: 'x'.repeat(PLAN_ITEM_DRAFT_BODY_MAX + 1) },
      },
    ];
    for (const body of refusals) {
      const res = await report(fx, jobId, body);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'PLAN_STEP_INVALID' });
    }
    expect(await drafts(planId, fx)).toEqual([]);

    // At the caps exactly is fine.
    const atCap = await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: {
        target,
        seq: 1,
        title: 'x'.repeat(PLAN_ITEM_DRAFT_TITLE_MAX),
        descriptionMd: 'y'.repeat(PLAN_ITEM_DRAFT_BODY_MAX),
      },
    });
    expect(atCap.status).toBe(200);
  });

  it('refuses 422 an author step on a committed work item, which has no draft', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_committed';
    const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A', kind: 'task' } }],
      fx.ctx,
    );
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Committed' });
    expect(
      (await report(fx, jobId, { sessionKey: 's', step: 'author', target: item.id })).status,
    ).toBe(200);
    const res = await report(fx, jobId, {
      sessionKey: 's',
      itemDraft: { target: item.id, seq: 1, title: 'x' },
    });
    expect(res.status).toBe(422);
  });

  it('refuses 404 a foreign job or a mismatched planId, and 409 a plan not generating', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_404';
    const { planId, target } = await authoring(fx, jobId);
    const body = { sessionKey: 'author-1', itemDraft: { target, seq: 1, title: 'x' } };

    expect((await report(fx, 'job_nobody', body)).status).toBe(404);
    expect((await report(fx, jobId, { ...body, planId: 'plan_other' })).status).toBe(404);

    await plansService.markPlanned(planId, fx.ctx);
    const late = await report(fx, jobId, body);
    expect(late.status).toBe(409);
    expect(await drafts(planId, fx)).toEqual([]);
  });

  it('is never served once the plan stops generating, and approve materializes the stored card', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_planned';
    const { planId, target } = await authoring(fx, jobId);
    await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 1, title: 'A partial that never landed' },
    });
    expect(await drafts(planId, fx)).toHaveLength(1);

    await plansService.markPlanned(planId, fx.ctx);
    expect(await drafts(planId, fx)).toEqual([]);

    await plansService.approvePlan(planId, fx.ctx);
    const titles = (await adminDb.workItem.findMany({ where: { projectId: fx.projectId } })).map(
      (w) => w.title,
    );
    expect(titles).toContain('Stored title');
    expect(titles).not.toContain('A partial that never landed');
  });

  it('is cleared by the completed write, in its transaction', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_write';
    const { planId, addId, otherId, target } = await authoring(fx, jobId);
    await report(fx, jobId, { sessionKey: 'other', step: 'author', target: `planItem:${otherId}` });
    await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 1, title: 'Wri' },
    });
    await report(fx, jobId, {
      sessionKey: 'other',
      itemDraft: { target: `planItem:${otherId}`, seq: 1, title: 'Other partial' },
    });
    expect(await drafts(planId, fx)).toHaveLength(2);

    await plansService.deepenProposal(planId, addId, { title: 'Written title' }, fx.ctx);
    const left = await drafts(planId, fx);
    expect(left.map((d) => d.planItemId)).toEqual([otherId]);
    expect((await storedItem(addId)).proposedFields).toMatchObject({ title: 'Written title' });
  });

  it('is cleared by a refused deepen, and the stored card stands', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_refused';
    const { planId, addId, target } = await authoring(fx, jobId);
    const before = await storedItem(addId);
    await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 1, title: 'Wri' },
    });

    await expect(
      plansService.deepenProposal(planId, addId, { title: '   ' }, fx.ctx),
    ).rejects.toThrow(/non-empty title/);
    expect(await drafts(planId, fx)).toEqual([]);
    expect(await storedItem(addId)).toEqual(before);
  });

  it('is cleared by the session’s next step and by its end', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_step';
    const { planId, otherId, target } = await authoring(fx, jobId);

    await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 5, title: 'Wri' },
    });
    await report(fx, jobId, {
      sessionKey: 'author-1',
      step: 'author',
      target: `planItem:${otherId}`,
    });
    expect(await drafts(planId, fx)).toEqual([]);

    // The cleared sequence restarts with the new card.
    const next = await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target: `planItem:${otherId}`, seq: 1, title: 'New' },
    });
    expect(await next.json()).toEqual({ planId, itemDraft: { applied: true, seq: 1 } });

    await report(fx, jobId, { sessionKey: 'author-1', step: 'end' });
    expect(await drafts(planId, fx)).toEqual([]);
  });

  it('serves one draft per proposal, the newest when two sessions hold one', async () => {
    const fx = await makeFixture();
    const jobId = 'job_draft_two';
    const { planId, addId, target } = await authoring(fx, jobId);
    await report(fx, jobId, { sessionKey: 'author-2', step: 'author', target });
    await report(fx, jobId, {
      sessionKey: 'author-1',
      itemDraft: { target, seq: 1, title: 'Older' },
    });
    await report(fx, jobId, {
      sessionKey: 'author-2',
      itemDraft: { target, seq: 1, title: 'Newer' },
    });
    const served = await drafts(planId, fx);
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ planItemId: addId, title: 'Newer', sessionKey: 'author-2' });
  });
});
