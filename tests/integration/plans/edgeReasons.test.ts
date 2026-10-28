import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import { EDGE_REASON_MAX } from '@/lib/plans/edgeReasons';
import { InvalidProposalError } from '@/lib/plans/errors';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ProposalInput } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-9827 — a `blocked_by` a planner draws carries its REASON: one short line
// saying what the waiting card consumes from its blocker. The doors accept
// `{ ref, reason }` beside a bare ref, the plan stores and returns it, and approve
// writes it onto the link it creates — against real Postgres.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const CONSUMES_SECRETS = 'consumes: the `AWS_ORG_ADMIN_*` secrets';
const CONSUMES_AMI = 'consumes: the AMI id the workflow publishes';

async function openPlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'Edges with reasons' }, fx.ctx)).id;
}

async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  let thrown: Error | undefined;
  try {
    await fn();
  } catch (err) {
    thrown = err as Error;
  }
  expect(thrown, 'the call must be rejected').toBeInstanceOf(Error);
  return thrown!;
}

/** A blocker `add`, then a waiting `add` whose edge to it carries a reason. */
async function blockerAndWaiter(
  fx: WorkItemFixture,
  planId: string,
  edge: ProposalInput['blockedByRefs'] | unknown[],
): Promise<{ blockerId: string; waiterId: string }> {
  const [blockerId] = (
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Provision the credentials', kind: 'task' } }],
      fx.ctx,
    )
  ).appendedItemIds;
  const refs = (edge as unknown[]).map((e) =>
    typeof e === 'string'
      ? e.replace('BLOCKER', blockerId!)
      : { ...(e as object), ref: `planItem:${blockerId}` },
  );
  const [waiterId] = (
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Add the AWS shard provider', kind: 'task' },
          blockedByRefs: refs as string[],
        },
      ],
      fx.ctx,
    )
  ).appendedItemIds;
  return { blockerId: blockerId!, waiterId: waiterId! };
}

describe('the columns', () => {
  it('`plan_item.edge_reasons` defaults to `{}` and `work_item_link.reason` is a nullable TEXT', async () => {
    const rows = await adminDb.$queryRawUnsafe<
      Array<{
        table_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >(
      `SELECT table_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE (table_name = 'plan_item' AND column_name = 'edge_reasons')
           OR (table_name = 'work_item_link' AND column_name = 'reason')
        ORDER BY table_name`,
    );
    expect(rows).toEqual([
      {
        table_name: 'plan_item',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: "'{}'::jsonb",
      },
      { table_name: 'work_item_link', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
  });
});

describe('an `add` edge round-trips its reason', () => {
  it('splits `{ ref, reason }` into the ref and the reason, trimmed, and returns both on the plan read', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const { blockerId, waiterId } = await blockerAndWaiter(fx, planId, [
      { reason: `  ${CONSUMES_SECRETS}  ` },
    ]);

    const plan = await plansService.getPlan(planId, fx.ctx);
    const waiter = plan.items.find((i) => i.id === waiterId)!;
    expect(waiter.blockedByRefs).toEqual([`planItem:${blockerId}`]);
    expect(waiter.edgeReasons).toEqual({ [`planItem:${blockerId}`]: CONSUMES_SECRETS });
    // The blocker draws nothing, so it explains nothing.
    expect(plan.items.find((i) => i.id === blockerId)!.edgeReasons).toEqual({});
  });

  it('still accepts a bare ref, which carries no reason', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const { waiterId } = await blockerAndWaiter(fx, planId, ['planItem:BLOCKER']);
    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.items.find((i) => i.id === waiterId)!.edgeReasons).toEqual({});
  });
});

describe('what is refused, by name', () => {
  it(`a reason over ${EDGE_REASON_MAX} characters`, async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const err = await rejection(() =>
      blockerAndWaiter(fx, planId, [{ reason: 'x'.repeat(EDGE_REASON_MAX + 1) }]),
    );
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect(err.message).toContain(`at most ${EDGE_REASON_MAX}`);
  });

  it.each([
    ['blank', '   ', 'is blank'],
    ['two lines', 'consumes: the role\nand the bucket', 'more than one line'],
  ])('a %s reason', async (_label, reason, says) => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const err = await rejection(() => blockerAndWaiter(fx, planId, [{ reason }]));
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect(err.message).toContain(says);
  });

  it('a reason keyed by an edge the proposal does not draw', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const err = await rejection(() =>
      plansService.addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: { title: 'Waits on nothing', kind: 'task' },
            edgeReasons: { 'planItem:nobody': CONSUMES_AMI },
          },
        ],
        fx.ctx,
      ),
    );
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect(err.message).toContain('does not draw');
  });
});

describe('approve writes each reason onto the link it creates', () => {
  it('an `add` edge and a `modify` edge both land with their reasons, and the card read shows them', async () => {
    const fx = await makeWorkItemFixture();
    const ami = await createTestWorkItem(fx, { kind: 'task', title: 'Publish the AMI' });
    const boot = await createTestWorkItem(fx, { kind: 'task', title: 'Boot a runner' });
    const planId = await openPlan(fx);
    const { waiterId } = await blockerAndWaiter(fx, planId, [{ reason: CONSUMES_SECRETS }]);
    await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: boot.id,
          patch: { blockedByAdd: [{ ref: ami.id, reason: CONSUMES_AMI }] as unknown as string[] },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    const plan = await plansService.getPlan(planId, fx.ctx);
    const waiterItemId = plan.items.find((i) => i.id === waiterId)!.workItemId!;
    const links = await adminDb.workItemLink.findMany({
      where: { kind: 'is_blocked_by' },
      select: { fromId: true, toId: true, reason: true },
    });
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromId: waiterItemId, reason: CONSUMES_SECRETS }),
        { fromId: boot.id, toId: ami.id, reason: CONSUMES_AMI },
      ]),
    );

    const detail = await workItemsService.getIssueDetail(
      fx.projectId,
      `${fx.projectIdentifier}-${boot.key}`,
      fx.ctx,
    );
    expect(detail.blockedBy).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ id: ami.id }),
        reason: CONSUMES_AMI,
      }),
    ]);
  });

  it('a second `modify` of one card UNIONS its reasons, and a cancelled edge keeps none', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    const planId = await openPlan(fx);
    const edges = (list: Array<{ ref: string; reason: string }>) => list as unknown as string[];
    await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: a.id,
          patch: { blockedByAdd: edges([{ ref: b.id, reason: 'consumes: B' }]) },
        },
      ],
      fx.ctx,
    );
    await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: a.id,
          patch: {
            blockedByAdd: edges([{ ref: c.id, reason: 'consumes: C' }]),
            blockedByRemove: [b.id],
          },
        },
      ],
      fx.ctx,
    );
    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.patch?.blockedByAdd).toEqual([c.id]);
    expect(plan.items[0]!.edgeReasons).toEqual({ [c.id]: 'consumes: C' });
  });
});

// ── the MCP doors ───────────────────────────────────────────────────────────

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'edge-reasons', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

describe('`add_plan_items` and `update_plan_proposal`', () => {
  it('take `{ ref, reason }` with a KEY ref, re-key the reason with the resolved id, and `get_plan` shows it', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await createTestWorkItem(fx, { kind: 'task', title: 'Provision the role' });
    const key = `${fx.projectIdentifier}-${blocker.key}`;
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(fx);

    const added = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Use the role', kind: 'task' },
          blockedByRefs: [{ ref: key, reason: 'consumes: the `motir-runner` role ARN' }],
        },
      ],
    });
    expect(added.isError).toBeFalsy();
    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.items[0]!.edgeReasons).toEqual({
      [blocker.id]: 'consumes: the `motir-runner` role ARN',
    });

    const read = await call(client, GET_PLAN_TOOL_NAME, { planId });
    expect(text(read)).toContain(`${blocker.id} (consumes: the \`motir-runner\` role ARN)`);

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: plan.items[0]!.id,
      blockedByRefs: [{ ref: key, reason: 'consumes: the role ARN and its external id' }],
    });
    expect(corrected.isError).toBeFalsy();
    const after = await plansService.getPlan(planId, fx.ctx);
    expect(after.items[0]!.edgeReasons).toEqual({
      [blocker.id]: 'consumes: the role ARN and its external id',
    });
  });

  it('refuses a reason over the cap at the door, naming the edge', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await createTestWorkItem(fx, { kind: 'task', title: 'Blocker' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(fx);
    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Waiter', kind: 'task' },
          blockedByRefs: [{ ref: blocker.id, reason: 'y'.repeat(EDGE_REASON_MAX + 1) }],
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(`the edge to ${blocker.id}`);
  });
});
