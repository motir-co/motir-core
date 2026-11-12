import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanItemProposedFields, PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-11051 — an INIT card declares the repository it will create, through the
// real doors into real Postgres: the append, the close, the approve and the
// created row; each refusal storing nothing; and the same declaration through
// `add_plan_items` over the real MCP transport.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const INIT: PlanItemProposedFields = {
  title: 'Create the motir-infra repository',
  kind: 'task',
  subject: 'init',
  initRepositoryName: 'motir-infra',
};

async function storedItems(planId: string) {
  return adminDb.planItem.findMany({ where: { planId } });
}

describe('initRepositoryName — the declaration round-trips without pinning a repository', () => {
  it('is stored verbatim on the proposal, and approve writes it with no repository pin', async () => {
    const fx = await makeWorkItemFixture();
    expect(await adminDb.projectRepo.count({ where: { projectId: fx.projectId } })).toBe(0);

    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(plan.id, [{ op: 'add', proposedFields: INIT }], fx.ctx);

    const [item] = await storedItems(plan.id);
    expect((item!.proposedFields as unknown as PlanItemProposedFields).initRepositoryName).toBe(
      'motir-infra',
    );

    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const row = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: INIT.title },
    });
    expect(row.initRepositoryName).toBe('motir-infra');
    expect(row.subject).toBe('init');
    expect(row.targetRepo).toBeNull();
    expect(row.targetRepos).toEqual([]);
    expect(await adminDb.workItemRepo.count({ where: { workItemId: row.id } })).toBe(0);
  });

  it('keeps the casing exactly as sent', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { ...INIT, initRepositoryName: 'Motir-Infra' } }],
      fx.ctx,
    );
    const [item] = await storedItems(plan.id);
    expect((item!.proposedFields as unknown as PlanItemProposedFields).initRepositoryName).toBe(
      'Motir-Infra',
    );
  });

  it('leaves a proposal with neither the init subject nor a declaration exactly as before', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Ordinary', kind: 'task' } }],
      fx.ctx,
    );
    const [item] = await storedItems(plan.id);
    expect(item!.proposedFields).not.toHaveProperty('initRepositoryName');
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);
    const row = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Ordinary' },
    });
    expect(row.initRepositoryName).toBeNull();
  });
});

describe('initRepositoryName — each refusal stores nothing', () => {
  async function refusedAndEmpty(fx: WorkItemFixture, proposedFields: PlanItemProposedFields) {
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    const err = await plansService
      .addProposals(plan.id, [{ op: 'add', proposedFields }], fx.ctx)
      .then(() => null)
      .catch((e: unknown) => e as { code?: string; message: string });
    expect(err).toMatchObject({ code: 'INVALID_PROPOSAL' });
    expect(await storedItems(plan.id)).toHaveLength(0);
    return err!.message;
  }

  it('without the init subject', async () => {
    const fx = await makeWorkItemFixture();
    const msg = await refusedAndEmpty(fx, { title: 'x', kind: 'task', initRepositoryName: 'r' });
    expect(msg).toContain('initRepositoryName');
    expect(msg).toContain('`init`');
  });

  it('with another subject', async () => {
    const fx = await makeWorkItemFixture();
    const msg = await refusedAndEmpty(fx, {
      title: 'x',
      kind: 'task',
      subject: 'data',
      initRepositoryName: 'r',
    });
    expect(msg).toContain('subject `data`');
  });

  it.each([
    ['targetRepo', { targetRepo: 'motir-infra' }],
    ['targetRepos', { targetRepos: ['motir-infra'] }],
    ['targetRepositories', { targetRepositories: ['cm_repo'] }],
    ['targetRepositoryRef', { targetRepositoryRef: 'cm_repo' }],
    ['targetRepoRole', { targetRepoRole: 'infra' }],
  ] as const)('beside the `%s` pin', async (key, pin) => {
    const fx = await makeWorkItemFixture();
    const msg = await refusedAndEmpty(fx, { ...INIT, ...pin } as PlanItemProposedFields);
    expect(msg).toContain('initRepositoryName');
    expect(msg).toContain(`\`${key}\``);
  });

  it.each(['', '   ', 'motir infra', 'motir-co/motir-infra'])(
    'the non-bare name %j',
    async (name) => {
      const fx = await makeWorkItemFixture();
      const msg = await refusedAndEmpty(fx, { ...INIT, initRepositoryName: name });
      expect(msg).toContain('bare repository name');
    },
  );

  it('refuses the key on a `modify` patch with the unchanged unknown-patch-key refusal', async () => {
    const fx = await makeWorkItemFixture();
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Existing' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await expect(
      plansService.addProposals(
        plan.id,
        [
          {
            op: 'modify',
            workItemId: target.id,
            patch: { initRepositoryName: 'motir-infra' } as never,
          },
        ],
        fx.ctx,
      ),
    ).rejects.toThrow(/initRepositoryName/);
    expect(await storedItems(plan.id)).toHaveLength(0);
  });
});

describe('initRepositoryName — the review model carries it add-only', () => {
  it('returns it for the add and null for a modify and a remove', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Modified' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Removed' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: INIT },
        { op: 'modify', workItemId: a.id, patch: { title: 'Modified again' } },
        { op: 'remove', workItemId: b.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const byOp = Object.fromEntries(review.items.map((i) => [i.op, i.initRepositoryName]));
    expect(byOp).toEqual({ add: 'motir-infra', modify: null, remove: null });
  });
});

describe('initRepositoryName — through `add_plan_items`', () => {
  async function connect(ctx: ServiceContext): Promise<Client> {
    const server = buildMcpServer(() => ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'init-repository', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('the strict schema accepts the argument and stores it verbatim', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const created = (await client.callTool({
      name: CREATE_PLAN_TOOL_NAME,
      arguments: {
        projectKey: fx.projectIdentifier,
        title: 'Infra',
        plannedWithHarness: 'Claude Code',
        plannedWithModel: 'claude-opus-5',
      },
    })) as CallToolResult;
    const planId = (created.structuredContent as unknown as PlanWithItemsDto).id;

    const res = (await client.callTool({
      name: ADD_PLAN_ITEMS_TOOL_NAME,
      arguments: { planId, proposals: [{ op: 'add', proposedFields: INIT }] },
    })) as CallToolResult;
    expect(res.isError).not.toBe(true);

    const [item] = await storedItems(planId);
    expect((item!.proposedFields as unknown as PlanItemProposedFields).initRepositoryName).toBe(
      'motir-infra',
    );
    await client.close();
  });
});
