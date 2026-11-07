import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planProgressService } from '@/lib/services/planProgressService';
import { planAuthoringStateService } from '@/lib/services/planAuthoringStateService';
import { planValidityService } from '@/lib/services/planValidityService';
import { toPlanStepDto } from '@/lib/mappers/planMappers';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-10413 · MOTIR-10496 — the FOUR places core says "this card is
// written" agree, because all four read the stored `authorFinished` and nothing
// else: `get_plan_authoring_state`'s `authored` rows, the review read's
// "N authored", the plans-page "N authored", and `validate_plan`'s
// `notYetWritten` (M minus its length). Real Postgres, real doors.
//
// The plan is built to make every OLD reading disagree: a boundary-only
// container (a body, not written), a card whose author session ENDED without a
// stamp around a whole body (what a failed session leaves), a stamped card
// with a one-line body, and a complete card nobody stamped. Explanations are
// OFF on the project, which the old count read and the new one must not.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const BOUNDARY = '## Scope BOUNDARY\n\nStarts at the door and ends at the store.';
const WHOLE = `Why the card exists.\n\n${BOUNDARY}\n\n## Acceptance criteria\n\n1. It stores the key.`;
const SIZED = {
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 30,
  difficulty: 'low',
} as const;

async function fourCardPlan(fx: WorkItemFixture) {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
  expect(project.aiGenerateExplanations).toBe(false);

  const plan = await plansService.createPlan(fx.projectId, { title: 'Agreement' }, fx.ctx);
  // A walk is live while the lay appends, so core stamps nothing by hand: every
  // stored state below is the one this test sets.
  await plansService.recordPlanStep(
    plan.id,
    { sessionKey: 'lay', kind: 'lay', targetRef: null },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: 'Boundary only', kind: 'story', descriptionMd: BOUNDARY },
      },
      {
        op: 'add',
        proposedFields: {
          title: 'Failed session',
          kind: 'task',
          descriptionMd: WHOLE,
          explanationMd: 'Why.',
          ...SIZED,
        },
      },
      {
        op: 'add',
        proposedFields: { title: 'Stamped short', kind: 'task', descriptionMd: 'One line.' },
      },
      {
        op: 'add',
        proposedFields: {
          title: 'Complete, unstamped',
          kind: 'task',
          descriptionMd: WHOLE,
          explanationMd: 'Why.',
          ...SIZED,
        },
      },
    ],
    fx.ctx,
  );
  const [boundary, failed, stamped, complete] = appended.appendedItemIds as [
    string,
    string,
    string,
    string,
  ];
  // The failed card's author session ran and ended without its driver's stamp.
  await plansService.recordPlanStep(
    plan.id,
    { sessionKey: 'author-failed', kind: 'author', targetRef: `planItem:${failed}` },
    fx.ctx,
  );
  await plansService.endPlanStep(plan.id, 'author-failed', fx.ctx);
  // The stamped card's driver said it finished.
  await plansService.deepenProposal(plan.id, stamped, { authorFinished: true }, fx.ctx);
  await plansService.endPlanStep(plan.id, 'lay', fx.ctx);
  return { planId: plan.id, boundary, failed, stamped, complete };
}

/** Every answer core gives, read through its own door. */
async function answers(fx: WorkItemFixture, planId: string) {
  const state = await planAuthoringStateService.getAuthoringState(planId, fx.ctx);
  const validity = await planValidityService.validateProjectedPlan(planId, fx.ctx);
  const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  const input = {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    sessionId: row.sessionId,
  };
  const plan = await plansService.getPlan(planId, fx.ctx);
  const steps = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planStepRepository.listByPlan(planId, tx),
  );
  const review = await planProgressService.snapshotForReview(
    input,
    plan.items,
    steps.map(toPlanStepDto),
    fx.ctx,
  );
  const page = (await planProgressService.snapshotsForPlans([input], fx.ctx)).get(planId);
  return { state, validity, review: review!, page: page! };
}

describe('the written state agrees everywhere (MOTIR-10496)', () => {
  it('authored rows, both progress counts and M − notYetWritten name the same one card', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, boundary, failed, stamped, complete } = await fourCardPlan(fx);
    const { state, validity, review, page } = await answers(fx, planId);

    const authored = state.proposals.filter((p) => p.state === 'authored').map((p) => p.ref);
    expect(authored).toEqual([`planItem:${stamped}`]);
    expect(state.proposals.filter((p) => p.state === 'authoring')).toEqual([]);

    expect(review).toMatchObject({ authored: 1, proposed: 4 });
    expect(page).toMatchObject({ authored: 1, proposed: 4 });
    expect(review.proposed - validity.notYetWritten.length).toBe(1);

    const notYet = validity.notYetWritten.map((n) => n.item);
    expect(notYet).toEqual([boundary, failed, complete].map((id) => `planItem:${id}`).sort());
    expect(notYet).not.toContain(`planItem:${stamped}`);
    expect(validity.notYetWritten.find((n) => n.item === `planItem:${failed}`)?.title).toBe(
      'Failed session',
    );
  });

  it('a live step on the stamped card reads `authoring`, and the card stays in N', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, stamped } = await fourCardPlan(fx);
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'author-again', kind: 'author', targetRef: `planItem:${stamped}` },
      fx.ctx,
    );
    const { state, validity, review, page } = await answers(fx, planId);

    expect(state.proposals.find((p) => p.ref === `planItem:${stamped}`)?.state).toBe('authoring');
    expect(state.proposals.filter((p) => p.state === 'authored')).toEqual([]);
    expect(review).toMatchObject({ authored: 1, proposed: 4 });
    expect(page).toMatchObject({ authored: 1, proposed: 4 });
    expect(validity.notYetWritten.map((n) => n.item)).not.toContain(`planItem:${stamped}`);
    expect(review.proposed - validity.notYetWritten.length).toBe(1);
  });

  it('a decided plan carries no notYetWritten', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await fourCardPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    // `planned` is still undecided: the list stays.
    expect(
      (await planValidityService.validateProjectedPlan(planId, fx.ctx)).notYetWritten,
    ).toHaveLength(3);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
    expect((await planValidityService.validateProjectedPlan(planId, fx.ctx)).notYetWritten).toEqual(
      [],
    );
  });
});
