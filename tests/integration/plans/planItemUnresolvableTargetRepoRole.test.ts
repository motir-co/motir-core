import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import { db } from '@/lib/db';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import { plansService } from '@/lib/services/plansService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanItemUnresolvableTargetRepoRoleError } from '@/lib/plans/errors';
import { APPROVE_REFUSALS } from '@/lib/plans/approveRefusals';
import { DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import type { ProposalInput } from '@/lib/dto/plans';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-10162 · Subtask MOTIR-11039 — a `targetRepoRole` the project's
// repository SET resolves to no single row is REFUSED, at the append, at a
// correction and at approve, instead of landing the card with no repository.
//
// Everything is real but the motir-ai client: a real Postgres, the real
// `plansService`, the real set service. The internal job-token doors' 422 is
// asserted beside their other refusals in `tests/integration/ai/planRevisionRoutes.test.ts`.

const EMPTY_PREPLAN: RawPreplanStateResponse = {
  session: { platform: null } as RawPreplanStateResponse['session'],
  docs: [],
  catalog: null,
};

beforeEach(async () => {
  await truncateAuthTables();
  vi.restoreAllMocks();
  vi.mocked(getPreplanState).mockResolvedValue(EMPTY_PREPLAN);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function newPlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'Pin it' }, fx.ctx)).id;
}

function addCard(title: string, targetRepoRole: string | null): ProposalInput {
  return {
    op: 'add',
    proposedFields: { title, kind: 'task', targetRepoRole } as ProposalInput['proposedFields'],
  };
}

async function refusal(
  promise: Promise<unknown>,
): Promise<PlanItemUnresolvableTargetRepoRoleError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PlanItemUnresolvableTargetRepoRoleError);
  return err as PlanItemUnresolvableTargetRepoRoleError;
}

function storedItems(planId: string) {
  return adminDb.planItem.findMany({ where: { planId }, orderBy: { createdAt: 'asc' } });
}

function workItemByTitle(fx: WorkItemFixture, title: string) {
  return adminDb.workItem.findFirst({ where: { projectId: fx.projectId, title } });
}

describe('the append — addProposals', () => {
  it('EXEMPTS a project whose set is empty, and approve then proposes the set and pins the card', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);

    await plansService.addProposals(planId, [addCard('Stand up the infra', 'infra')], fx.ctx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    const set = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    const infra = set.find((r) => r.role === 'infra');
    expect(infra).toBeDefined();
    const card = await workItemByTitle(fx, 'Stand up the infra');
    const refs = await adminDb.workItemRepo.findMany({ where: { workItemId: card!.id } });
    expect(refs.map((r) => r.projectRepoId)).toEqual([infra!.id]);
  });

  it('ACCEPTS a role exactly one row carries — a row still `proposed` included', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'infra', name: 'acme-infra' },
      fx.ctx,
    );
    expect(row.state).toBe('proposed');
    const planId = await newPlan(fx);

    await plansService.addProposals(planId, [addCard('Infra card', 'infra')], fx.ctx);
    expect(await storedItems(planId)).toHaveLength(1);
  });

  it('REFUSES a role no row carries, and stores no proposal', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const planId = await newPlan(fx);

    const err = await refusal(
      plansService.addProposals(
        planId,
        [addCard('A fine card', 'web'), addCard('The infra card', 'infra')],
        fx.ctx,
      ),
    );
    expect(err.code).toBe('PLAN_ITEM_UNRESOLVABLE_TARGET_REPO_ROLE');
    expect(err.reason).toBe('no-match');
    expect(err.planItemId).toBeNull();
    expect(err.role).toBe('infra');
    expect(err.message).toContain('`infra`');
    expect(err.message).toContain('The infra card');
    // The whole batch is refused — the fine card beside it is not stored either.
    expect(await storedItems(planId)).toEqual([]);
  });

  it('REFUSES a role two rows carry as AMBIGUOUS, naming both rows', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-api' }, fx.ctx);
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-billing' }, fx.ctx);
    const planId = await newPlan(fx);

    const err = await refusal(
      plansService.addProposals(planId, [addCard('An API card', 'api')], fx.ctx),
    );
    expect(err.reason).toBe('ambiguous');
    expect(err.rowCount).toBe(2);
    expect([...err.rowNames].sort()).toEqual(['acme-api', 'acme-billing']);
    expect(err.message).toContain('acme-api');
    expect(err.message).toContain('acme-billing');
    expect(err.message).toContain('targetRepositoryRef');
  });

  it("REFUSES a `modify` patch's role the same way", async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Existing' },
      fx.ctx,
    );
    const planId = await newPlan(fx);

    const err = await refusal(
      plansService.addProposals(
        planId,
        [{ op: 'modify', workItemId: target.id, patch: { targetRepoRole: 'mobile' } }],
        fx.ctx,
      ),
    );
    expect(err.role).toBe('mobile');
    expect(await storedItems(planId)).toEqual([]);
  });

  it('leaves an explicit `null` role and an out-of-vocabulary word to their own checks', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const planId = await newPlan(fx);

    // `null` is the unpin, not a role to resolve.
    await plansService.addProposals(planId, [addCard('Unpinned', null)], fx.ctx);
    // A word outside the vocabulary is the VOCABULARY refusal, not this one.
    const err = await plansService
      .addProposals(planId, [addCard('Bad word', 'backend')], fx.ctx)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PlanItemUnresolvableTargetRepoRoleError);
    expect((err as { code?: string }).code).toBe('PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE');
  });
});

describe('a correction — correctProposal', () => {
  it('REFUSES a re-pin to an unresolvable role and keeps the old pin', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const planId = await newPlan(fx);
    const appended = await plansService.addProposals(planId, [addCard('Web card', 'web')], fx.ctx);
    const itemId = appended.items[0]!.id;

    const err = await refusal(
      plansService.correctProposal(planId, itemId, { targetRepoRole: 'infra' }, fx.ctx),
    );
    expect(err.planItemId).toBe(itemId);
    expect(err.message).toContain(itemId);
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(stored.proposedFields).toMatchObject({ targetRepoRole: 'web' });
  });

  it("REFUSES a modify's replacement patch carrying an unresolvable role", async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Existing' },
      fx.ctx,
    );
    const planId = await newPlan(fx);
    const appended = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'Renamed' } }],
      fx.ctx,
    );
    const itemId = appended.items[0]!.id;

    await refusal(
      plansService.correctProposal(
        planId,
        itemId,
        { patch: { title: 'Renamed', targetRepoRole: 'shared' } },
        fx.ctx,
      ),
    );
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(stored.patch).toEqual({ title: 'Renamed' });
  });
});

describe('approve — approvePlan', () => {
  it('REFUSES a plan whose role stopped resolving after the close, writes nothing, and approves once the pin is corrected', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    // Appended while the set was EMPTY, so the append's exemption held…
    const appended = await plansService.addProposals(
      planId,
      [addCard('The API card', 'api')],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    // …and then the set moved: it holds a row, and not one of that role.
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);

    const err = await refusal(plansService.approvePlan(planId, fx.ctx));
    const itemId = appended.items[0]!.id;
    expect(err.planItemId).toBe(itemId);
    expect(err.message).toContain('The API card');
    expect(await workItemByTitle(fx, 'The API card')).toBeNull();
    // The set was not touched by the refused approve.
    expect(
      (await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).map((r) => r.name),
    ).toEqual(['acme-web']);

    await plansService.correctProposal(planId, itemId, { targetRepoRole: 'web' }, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);
    const card = await workItemByTitle(fx, 'The API card');
    expect(card).not.toBeNull();
    const web = (await projectRepoSetService.listByProject(fx.projectId, fx.ctx))[0]!;
    expect(
      (await adminDb.workItemRepo.findMany({ where: { workItemId: card!.id } })).map(
        (r) => r.projectRepoId,
      ),
    ).toEqual([web.id]);
  });
});

describe('the registrations', () => {
  it('is a 422 on the v1 surface and a classified approve refusal', () => {
    expect(DOMAIN_ERROR_STATUS['PLAN_ITEM_UNRESOLVABLE_TARGET_REPO_ROLE']).toBe(422);
    expect(APPROVE_REFUSALS['PLAN_ITEM_UNRESOLVABLE_TARGET_REPO_ROLE']?.cause).toBe('tree-caused');
  });
});
