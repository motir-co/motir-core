import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { parseChoiceOptions } from '@/lib/approvalGates/choiceOptions';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanItemProposedFields } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// BUG MOTIR-12145 — A CARD AN APPROVE CREATES ASKS ITS QUESTION AT BIRTH.
//
// `workItemsService.createWorkItem` raises a `type: choice` card's `decision_choice`
// gate, and a `human` decision's `decision_confirmation` gate, the moment the card is
// born with a body that parses and nothing open blocking it. Materialize writes its
// cards through the leaf repositories, and until this fix never called either raiser:
// a choice with a blocker was asked later, when the blocker finished, and one with NO
// blocker was never asked at all (MOTIR-12076 sat In Progress for 16 hours).
//
// Real Postgres and the real `sendEvent`, so the walk to review is read off the
// revisions and the `job_event` rows it announced.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const CHOICE = [
  '## Question',
  'Where do exported reports live?',
  '## Why this is a choice',
  '**Situation:** better than your decision',
  '**You said:** "Keep them in Postgres."',
  'Research found a cheaper store.',
  '## Options',
  '### Managed object storage',
  '**Best if you want:** less to operate',
  'The provider runs it.',
  '### Our own Postgres',
  '**Best if you want:** more cost-effective',
  'No new vendor.',
  '## What this choice gates',
  'The export story.',
].join('\n');

const DECISION = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** workflow · less requirement',
  'The approved plan kept exports in Postgres.',
  '## Supersedes',
  'MOTIR-6 and MOTIR-7',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

const choiceAdd = (title: string, descriptionMd = CHOICE): PlanItemProposedFields => ({
  title,
  kind: 'task',
  type: 'choice',
  executor: 'human',
  descriptionMd,
});

type Proposal = Parameters<typeof plansService.addProposals>[1][number];

/** Author, close and approve a plan of `layers`, each one append (refs resolve to the previous). */
async function approve(layers: Array<(ids: string[]) => Proposal[]>): Promise<void> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
  let ids: string[] = [];
  for (const layer of layers) {
    ids = (await plansService.addProposals(plan.id, layer(ids), fx.ctx)).appendedItemIds;
  }
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
}

const byTitle = (title: string) =>
  adminDb.workItem.findFirstOrThrow({ where: { projectId: fx.projectId, title } });

const gatesOf = (workItemId: string, kind: 'decision_choice' | 'decision_confirmation') =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind } });

describe('materialize asks a new choice its question (MOTIR-12145)', () => {
  it('raises the gate on an unblocked choice and walks it to review, announcing each hop', async () => {
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: choiceAdd('Pick the store') }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const item = await byTitle('Pick the store');
    const gates = await gatesOf(item.id, 'decision_choice');
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ state: 'awaiting', subjectId: item.id });
    expect(gates[0]!.subjectVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(item.status).toBe('in_review');

    // The same raise `createWorkItem` makes for the same body: one stamp, not a second.
    const direct = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Pick the store, directly',
        type: 'choice',
        executor: 'human',
        descriptionMd: CHOICE,
      },
      fx.ctx,
    );
    const [directGate] = await gatesOf(direct.id, 'decision_choice');
    expect(directGate!.subjectVersion).toBe(gates[0]!.subjectVersion);
  });

  it('records the walk as revisions and announces every hop after the commit', async () => {
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: choiceAdd('Pick, announced') }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);
    const createdId = (await byTitle('Pick, announced')).id;

    const statusRevisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: createdId, changeKind: 'updated' },
    });
    const walked = statusRevisions
      .map((row) => (row.diff as { status?: { from: string; to: string } }).status)
      .filter(Boolean);
    expect(walked).toEqual(
      expect.arrayContaining([
        { from: 'todo', to: 'in_progress' },
        { from: 'in_progress', to: 'in_review' },
      ]),
    );
    expect(walked).toHaveLength(2);
    const events = await adminDb.jobEvent.findMany({
      where: {
        name: 'work-item/transitioned',
        data: { path: ['workItemId'], equals: createdId },
      },
    });
    // One announcement per hop, carrying the revision that recorded it.
    const announced = events.map((e) => e.data as { toStatusKey: string; revisionId: string });
    expect(announced.map((e) => e.toStatusKey).sort()).toEqual(['in_progress', 'in_review']);
    expect(announced.map((e) => e.revisionId).sort()).toEqual(
      statusRevisions.map((row) => row.id).sort(),
    );
  });

  it('a choice born blocked by OPEN work is not asked until that work is done', async () => {
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Measure the exports' },
      fx.ctx,
    );
    await approve([
      () => [
        {
          op: 'add',
          proposedFields: choiceAdd('Pick after measuring'),
          blockedByRefs: [blocker.id],
        },
      ],
    ]);

    const item = await byTitle('Pick after measuring');
    expect(await gatesOf(item.id, 'decision_choice')).toHaveLength(0);
    expect(item.status).toBe('blocked');

    // The later trigger still asks it, exactly as before.
    for (const key of ['in_progress', 'in_review', 'done']) {
      await workItemsService.updateStatus(blocker.id, key, fx.ctx);
    }
    expect(await gatesOf(item.id, 'decision_choice')).toHaveLength(1);
  });

  it('a choice blocked by a sibling the same plan creates waits for that sibling', async () => {
    await approve([
      () => [{ op: 'add', proposedFields: { title: 'Measure first', kind: 'task' } }],
      ([measure]) => [
        {
          op: 'add',
          proposedFields: choiceAdd('Pick after the sibling'),
          blockedByRefs: [`planItem:${measure}`],
        },
      ],
    ]);
    const item = await byTitle('Pick after the sibling');
    expect(await gatesOf(item.id, 'decision_choice')).toHaveLength(0);
    expect(item.status).toBe('blocked');
  });

  it('stamps the question from the STORED body, after its plan-item links are rewritten', async () => {
    await approve([
      () => [{ op: 'add', proposedFields: { title: 'The export story', kind: 'task' } }],
      ([story]) => [
        {
          op: 'add',
          proposedFields: choiceAdd(
            'Pick for the story',
            CHOICE.replace('The export story.', `[The export story](motir-ref:planItem:${story})`),
          ),
        },
      ],
    ]);
    const item = await byTitle('Pick for the story');
    expect(item.descriptionMd).not.toContain('motir-ref:planItem:');
    const stored = parseChoiceOptions(item.descriptionMd);
    expect(stored.ok).toBe(true);
    const [gate] = await gatesOf(item.id, 'decision_choice');
    expect(gate!.subjectVersion).toBe(stored.ok ? stored.subjectVersion : null);
  });

  it('a choice whose body does not parse raises nothing and stays where it was born', async () => {
    const defective = CHOICE.replace('**Best if you want:** more cost-effective\n', '');
    await approve([
      () => [{ op: 'add', proposedFields: choiceAdd('Pick, half-written', defective) }],
    ]);
    const item = await byTitle('Pick, half-written');
    expect(await gatesOf(item.id, 'decision_choice')).toHaveLength(0);
    expect(item.status).toBe('todo');
  });
});

describe('materialize asks a new human decision its confirm question (MOTIR-12145)', () => {
  it('raises `decision_confirmation` on an unblocked human decision and walks it to review', async () => {
    await approve([
      () => [
        {
          op: 'add',
          proposedFields: {
            title: 'Record the export store',
            kind: 'task',
            type: 'decision',
            executor: 'human',
            descriptionMd: DECISION,
          },
        },
      ],
    ]);
    const item = await byTitle('Record the export store');
    const gates = await gatesOf(item.id, 'decision_confirmation');
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ state: 'awaiting' });
    expect(await gatesOf(item.id, 'decision_choice')).toHaveLength(0);
    expect(item.status).toBe('in_review');
  });

  it('an agent decision, and a plain task, ask nothing and keep their birth status', async () => {
    await approve([
      () => [
        {
          op: 'add',
          proposedFields: {
            title: 'An agent writes the record',
            kind: 'task',
            type: 'decision',
            executor: 'coding_agent',
            descriptionMd: DECISION,
          },
        },
        { op: 'add', proposedFields: { title: 'Just a task', kind: 'task', type: 'code' } },
      ],
    ]);
    for (const title of ['An agent writes the record', 'Just a task']) {
      const item = await byTitle(title);
      expect(await adminDb.approvalGate.count({ where: { workItemId: item.id } })).toBe(0);
      expect(item.status).toBe('todo');
    }
  });
});
