import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { InvalidProposalError } from '@/lib/plans/errors';
import { CANONICAL_ITEM_LINK_FORMS } from '@/lib/plans/validateProposedBodyRefs';
import { plansService } from '@/lib/services/plansService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { projectAccessData } from '../../helpers/projectAccess';

// Bug MOTIR-10104 — a broken item link in a proposal body is a WARNING, not a
// failed write. Every proposal write door (the append's `add` / `modify`, the
// deepen, the correction) KEEPS the body and answers with one warning per broken
// link, naming the corrected link whenever the server can compute it:
//
//   * an EARLIER plan's proposal that became a card → `[label](motir:<cardId>)`;
//   * a proposal of THIS plan written without the prefix, or as `motir:` →
//     `[label](motir-ref:planItem:<id>)`;
//   * an id that resolves to nothing → the two canonical forms.
//
// And APPROVE still refuses a plan whose bodies carry a malformed `motir-ref:`
// link (as does `checkApprovability`, which `validate_plan` reads), so a warning
// nobody acted on never ships as dead text.
//
// Real Postgres, through the service — the layer every door shares.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedItem(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

/**
 * An EARLIER, approved plan whose one `add` became a card — the shape MOTIR-5781's
 * body was written against. Returns the old plan-item id and the card's id.
 */
async function approvedEarlierProposal(
  fx: WorkItemFixture,
  title: string,
): Promise<{ oldPlanItemId: string; cardId: string }> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Earlier' }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title, kind: 'task' } }],
    fx.ctx,
  );
  const oldPlanItemId = appended.appendedItemIds[0]!;
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: oldPlanItemId } });
  return { oldPlanItemId, cardId: row.workItemId! };
}

async function openPlanWithSibling(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'Sibling', kind: 'task' } }],
    fx.ctx,
  );
  return { planId: plan.id, siblingId: appended.appendedItemIds[0]! };
}

describe('the APPEND door keeps a body with a broken link and warns (MOTIR-10104)', () => {
  it('a `modify` naming an old plan item is written, and warned with the card it became', async () => {
    const fx = await makeWorkItemFixture();
    const { oldPlanItemId, cardId } = await approvedEarlierProposal(fx, 'The host card');
    const { planId } = await openPlanWithSibling(fx);
    const targetId = await seedItem(fx, 'Story E2E');
    const body = `Builds on [the host card](motir-ref:${oldPlanItemId}).`;

    const result = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: targetId, patch: { descriptionMd: body } }],
      fx.ctx,
    );

    const modifyId = result.appendedItemIds[0]!;
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } });
    expect((row.patch as { descriptionMd?: string }).descriptionMd).toBe(body);
    expect(result.warnings).toEqual([
      {
        planItemId: modifyId,
        proposal: `the \`modify\` of work item ${targetId}`,
        field: 'descriptionMd',
        link: `[the host card](motir-ref:${oldPlanItemId})`,
        reason: expect.stringContaining('earlier, approved plan'),
        correctedLink: `[the host card](motir:${cardId})`,
      },
    ]);
  });

  it('an `add` naming this plan’s proposal as `motir:` and an unresolvable id is written and warned', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, siblingId } = await openPlanWithSibling(fx);

    const result = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Links it',
            kind: 'task',
            descriptionMd: `After [x](motir:${siblingId}).`,
            explanationMd: 'Because [gone](motir-ref:pi_nothing_here).',
          },
        },
      ],
      fx.ctx,
    );

    expect(result.items).toHaveLength(2);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        planItemId: result.appendedItemIds[0],
        proposal: '“Links it”',
        field: 'descriptionMd',
        link: `[x](motir:${siblingId})`,
        correctedLink: `[x](motir-ref:planItem:${siblingId})`,
      }),
      expect.objectContaining({
        field: 'explanationMd',
        link: '[gone](motir-ref:pi_nothing_here)',
        correctedLink: null,
        canonicalForms: [...CANONICAL_ITEM_LINK_FORMS],
      }),
    ]);
  });

  it('a clean append answers with no `warnings` key at all', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, siblingId } = await openPlanWithSibling(fx);
    const result = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Clean',
            kind: 'task',
            descriptionMd: `After [s](motir-ref:planItem:${siblingId}). Syntax: \`[x](motir-ref:<id>)\`.`,
          },
        },
      ],
      fx.ctx,
    );
    expect(result).not.toHaveProperty('warnings');
  });
});

describe('a sound link is not warned, whatever else the plan carries (MOTIR-10104)', () => {
  it('an ordinary card link beside a `remove` answers no warnings and blocks nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await openPlanWithSibling(fx);
    const cardId = await seedItem(fx, 'An existing card');
    const doomedId = await seedItem(fx, 'Doomed');

    const result = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Links a card',
            kind: 'task',
            descriptionMd: `See [the card](motir:${cardId}).`,
          },
        },
        { op: 'remove', workItemId: doomedId },
      ],
      fx.ctx,
    );

    expect(result).not.toHaveProperty('warnings');
    await plansService.markPlanned(planId, fx.ctx);
    expect(await plansService.checkApprovability(planId, fx.ctx)).toEqual([]);
  });
});

// Bug MOTIR-10111 — a `motir:` link whose id names no card at all (a zero-padded
// id written from memory) is warned at the write, with the link computed from the
// one key its label names when the writer can open that card.
describe('a card link that names no card is warned, corrected from its label (MOTIR-10111)', () => {
  const DEAD_ID = 'cmvlr0b0000000000000000000';

  async function appendWithBody(fx: WorkItemFixture, planId: string, descriptionMd: string) {
    return plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Links a card', kind: 'task', descriptionMd } }],
      fx.ctx,
    );
  }

  it('a label naming a browsable key is kept and warned with that card’s link', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await openPlanWithSibling(fx);
    const cardId = await seedItem(fx, 'The turn-on card');
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: cardId } });
    const link = `[${card.identifier}](motir:${DEAD_ID})`;

    const result = await appendWithBody(fx, planId, `Scope boundary: ${link}.`);

    const row = await adminDb.planItem.findUniqueOrThrow({
      where: { id: result.appendedItemIds[0]! },
    });
    expect((row.proposedFields as { descriptionMd?: string }).descriptionMd).toContain(link);
    expect(result.warnings).toEqual([
      {
        planItemId: result.appendedItemIds[0],
        proposal: '“Links a card”',
        field: 'descriptionMd',
        link,
        reason: expect.stringContaining(DEAD_ID),
        correctedLink: `[${card.identifier}](motir:${cardId})`,
      },
    ]);
  });

  it('a label naming no key is warned with no correction and the canonical forms', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await openPlanWithSibling(fx);
    const link = `[the turn-on card](motir:${DEAD_ID})`;

    const result = await appendWithBody(fx, planId, `See ${link}.`);

    expect(result.warnings).toEqual([
      expect.objectContaining({
        link,
        correctedLink: null,
        canonicalForms: [...CANONICAL_ITEM_LINK_FORMS],
      }),
    ]);
  });

  it('a key in a project the writer cannot browse gets no correction and leaks no id', async () => {
    const fx = await makeWorkItemFixture();
    const secretProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SECRET',
    });
    await adminDb.project.update({
      where: { id: secretProject.id },
      data: projectAccessData('members'),
    });
    const secret = await workItemsService.createWorkItem(
      { projectId: secretProject.id, kind: 'task', title: 'Classified' },
      fx.ctx,
    );
    const plain = await usersService.createUser({
      email: `plain-${secretProject.id}@ex.com`,
      password: 'correct-horse-battery-staple',
      name: 'Plain',
    });
    await workspacesService.addMember({ userId: plain.id, workspaceId: fx.workspaceId });
    const plainCtx: ServiceContext = { userId: plain.id, workspaceId: fx.workspaceId };
    const link = `[${secret.identifier}](motir:${DEAD_ID})`;
    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, plainCtx);

    const asPlain = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Links it', kind: 'task', descriptionMd: link } }],
      plainCtx,
    );

    expect(asPlain.warnings).toEqual([
      expect.objectContaining({
        link,
        correctedLink: null,
        canonicalForms: [...CANONICAL_ITEM_LINK_FORMS],
      }),
    ]);
    expect(JSON.stringify(asPlain.warnings)).not.toContain(secret.id);

    // The owner, who can open SECRET-1, is handed the link that works.
    const ownerPlan = await plansService.createPlan(fx.projectId, { title: 'Owner' }, fx.ctx);
    const asOwner = await appendWithBody(fx, ownerPlan.id, link);
    expect(asOwner.warnings).toEqual([
      expect.objectContaining({ correctedLink: `[${secret.identifier}](motir:${secret.id})` }),
    ]);
  });

  it('a link to an existing card is not warned, as before', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await openPlanWithSibling(fx);
    const cardId = await seedItem(fx, 'An existing card');
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: cardId } });

    const result = await appendWithBody(fx, planId, `See [${card.identifier}](motir:${cardId}).`);

    expect(result).not.toHaveProperty('warnings');
  });
});

describe('the DEEPEN door keeps the body and warns (MOTIR-10104)', () => {
  it('writes a body naming this plan’s proposal without the prefix and warns with the canonical token', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, siblingId } = await openPlanWithSibling(fx);
    const other = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Target', kind: 'task' } }],
      fx.ctx,
    );
    const targetItemId = other.appendedItemIds[0]!;
    const body = `Needs [the sibling](motir-ref:${siblingId}).`;

    const result = await plansService.deepenProposal(
      planId,
      targetItemId,
      { descriptionMd: body },
      fx.ctx,
    );

    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: targetItemId } });
    expect((row.proposedFields as { descriptionMd?: string }).descriptionMd).toBe(body);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        planItemId: targetItemId,
        proposal: '“Target”',
        correctedLink: `[the sibling](motir-ref:planItem:${siblingId})`,
      }),
    ]);
  });
});

describe('the CORRECTION door keeps the body and warns (MOTIR-10104)', () => {
  it('writes an `add` and a `modify` correction carrying old links, warning with the cards', async () => {
    const fx = await makeWorkItemFixture();
    const { oldPlanItemId, cardId } = await approvedEarlierProposal(fx, 'Serving');
    const { planId, siblingId } = await openPlanWithSibling(fx);
    const targetId = await seedItem(fx, 'Committed target');
    const withModify = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: targetId, patch: { title: 'Renamed' } }],
      fx.ctx,
    );
    const modifyItemId = withModify.appendedItemIds[0]!;
    await plansService.markPlanned(planId, fx.ctx);

    const onAdd = await plansService.correctProposal(
      planId,
      siblingId,
      { descriptionMd: `Uses [serving](motir-ref:${oldPlanItemId}).` },
      fx.ctx,
    );
    expect(onAdd.warnings).toEqual([
      expect.objectContaining({
        planItemId: siblingId,
        correctedLink: `[serving](motir:${cardId})`,
      }),
    ]);

    const onModify = await plansService.correctProposal(
      planId,
      modifyItemId,
      { patch: { title: 'Renamed', descriptionMd: `After [serving](motir:${oldPlanItemId}).` } },
      fx.ctx,
    );
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyItemId } });
    expect((row.patch as { descriptionMd?: string }).descriptionMd).toBe(
      `After [serving](motir:${oldPlanItemId}).`,
    );
    expect(onModify.warnings).toEqual([
      expect.objectContaining({
        planItemId: modifyItemId,
        link: `[serving](motir:${oldPlanItemId})`,
        correctedLink: `[serving](motir:${cardId})`,
      }),
    ]);
  });
});

describe('APPROVE still refuses a malformed link the plan kept (MOTIR-10104)', () => {
  it('refuses naming the corrected link, reports it as a rejection, and approves once it is fixed', async () => {
    const fx = await makeWorkItemFixture();
    const { oldPlanItemId, cardId } = await approvedEarlierProposal(fx, 'The vitest gate');
    const { planId } = await openPlanWithSibling(fx);
    const targetId = await seedItem(fx, 'Story E2E');
    const appended = await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: targetId,
          patch: { descriptionMd: `Gated by [the vitest gate](motir-ref:${oldPlanItemId}).` },
        },
      ],
      fx.ctx,
    );
    const modifyItemId = appended.appendedItemIds[0]!;
    // The close is not refused: the planner was warned, and the plan reaches review.
    await plansService.markPlanned(planId, fx.ctx);

    const rejections = await plansService.checkApprovability(planId, fx.ctx);
    expect(rejections).toEqual([
      expect.objectContaining({
        code: 'INVALID_PROPOSAL',
        item: `planItem:${modifyItemId}`,
        message: expect.stringContaining(`[the vitest gate](motir:${cardId})`),
      }),
    ]);
    const refused = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InvalidProposalError);
    expect((refused as InvalidProposalError).planItemId).toBe(modifyItemId);
    expect((refused as Error).message).toContain('approve would ship 1 item link(s) as dead text');
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } })).descriptionMd,
    ).toBeNull();

    // The correction the warning named is applied, and the plan approves.
    await plansService.correctProposal(
      planId,
      modifyItemId,
      { patch: { descriptionMd: `Gated by [the vitest gate](motir:${cardId}).` } },
      fx.ctx,
    );
    expect(await plansService.checkApprovability(planId, fx.ctx)).toEqual([]);
    await plansService.approvePlan(planId, fx.ctx);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: targetId } })).descriptionMd,
    ).toBe(`Gated by [the vitest gate](motir:${cardId}).`);
  });
});
