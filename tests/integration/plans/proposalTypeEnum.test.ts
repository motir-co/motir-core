import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanGrammarError, PlanItemFieldRejectedError } from '@/lib/plans/errors';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-3654 — a plan proposal's `type` is a CLOSED set, at every door.
//
// ── The bug this reproduces ────────────────────────────────────────────────
// `authorPlan.ts` declared four sibling fields. `kind`, `priority` and
// `executor` were each a `z.enum`; `type` alone was a bare `z.string()`, with
// its fourteen legal members demoted into a prose `.describe()` ending in an
// ellipsis — "code / design / test / decision / manual / …". So the schema
// advertised five of fourteen and invited the reader to complete the pattern.
//
// `type: "migration"` was written. `add_plan_items` accepted it, the row stored
// it, `validate_plan` answered `{ valid: true, blockers: [], rejections: [] }`,
// and `POST /api/plans/<id>/approve` returned **500 with an empty body** —
// `prisma.workItem.create()` raising a `PrismaClientValidationError` from inside
// the transaction. An empty body is why Approve was pressed twice.
//
// ── Why the whole chain is asserted here rather than at one layer ──────────
// The fix has three doors and each is individually passable while the composite
// is broken: the tool schemas refuse at the append, `validatePlanProposals`
// re-checks before the transaction opens (the "core re-checks, defense in
// depth" doctrine that file states for `kind`), and materialize contains the ORM
// failure for anything still getting through. A unit test of any one of them
// stays green if the other two regress, which is exactly the shape that let the
// original defect exist: `create_work_item`'s door had the enum all along, and
// the plan door did not.
//
// The unit-level verdict lives in `tests/plans/validateProposals.test.ts`; this
// file drives the REAL tools over the REAL transport into real Postgres.

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'proposal-type-enum', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  return struct(
    await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Job substrate',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5',
    }),
  ).id;
}

/** The project's key counter — the clean-rollback property is measured on this. */
async function lastKey(projectId: string): Promise<number> {
  const row = await adminDb.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { lastWorkItemNumber: true },
  });
  return row.lastWorkItemNumber;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the tool boundary refuses an out-of-enum `type` at all three doors', () => {
  it('refuses it on an `add`, and the refusal names the legal members', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);

    const res = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Cut the queue over', kind: 'task', type: 'migration' },
        },
      ],
    });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    // The half that prevents recurrence: a caller reading this error is told
    // what IS legal, rather than only that their value was not.
    expect(text).toContain('migration');
    expect(text).toContain('code');
    expect(text).toContain('chore');

    // Nothing was stored. The original bug's whole cost is that the value got
    // this far and then failed 500 later, so "refused" has to mean "absent".
    const items = await adminDb.planItem.findMany({ where: { planId } });
    expect(items).toHaveLength(0);
    await client.close();
  });

  it('refuses it on a `modify` patch', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);

    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'An existing card' },
      fx.ctx,
    );

    const res = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target.id, patch: { type: 'migration' } }],
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('migration');
    await client.close();
  });

  it('refuses it on `update_plan_proposal` — the EDIT door, the one the gate distrusts', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);

    const added = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'Cut the queue over', kind: 'task' } }],
    });
    const itemId = ids(added)[0]!;

    const res = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: itemId,
      type: 'migration',
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('migration');

    // And the proposal is unchanged — a refused edit must not half-apply.
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect((row.proposedFields as { type?: string } | null)?.type).toBeUndefined();
    await client.close();
  });

  it('accepts a LEGAL type through the same door, so the refusal is the value and not the field', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);

    const res = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Cut the queue over', kind: 'task', type: 'code' } },
      ],
    });

    expect(res.isError).toBeFalsy();
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: ids(res)[0]! } });
    expect((row.proposedFields as { type?: string }).type).toBe('code');
    await client.close();
  });
});

describe('a proposal FORCED past the door is still caught before it can 500', () => {
  // Each case writes the bad value straight into the row with `adminDb`, which
  // is the state the tool schema now makes unreachable — and is exactly the
  // state the shipped plan `cmtb6zjgt003whvn8zbgc6e9h` was in. Reproducing it
  // directly is what keeps the two downstream doors honest once the first one
  // makes the natural path impossible.

  it('`validate_plan` reports it — not a clean `valid: true`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);

    const added = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [{ op: 'add', proposedFields: { title: 'Cut the queue over', kind: 'task' } }],
    });
    const itemId = ids(added)[0]!;
    await adminDb.planItem.update({
      where: { id: itemId },
      data: { proposedFields: { title: 'Cut the queue over', kind: 'task', type: 'migration' } },
    });

    // `checkApprovability` IS the gate `validate_plan` reads — the same pass
    // `approvePlan` runs, returned rather than thrown. Before this card it
    // answered `[]` for this exact plan, which is what made the 500 a surprise.
    const rejections = await plansService.checkApprovability(planId, fx.ctx);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.code).toBe('PLAN_GRAMMAR_VIOLATION');
    expect(rejections[0]!.reason).toBe('unknown_type');
    expect(rejections[0]!.item).toContain(itemId);
    expect(rejections[0]!.message).toContain('migration');
    await client.close();
  });

  it('`approve` answers a TYPED error naming the proposal — never a bare 500', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);

    const added = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [{ op: 'add', proposedFields: { title: 'Cut the queue over', kind: 'task' } }],
    });
    const itemId = ids(added)[0]!;
    await adminDb.planItem.update({
      where: { id: itemId },
      data: { proposedFields: { title: 'Cut the queue over', kind: 'task', type: 'migration' } },
    });

    const before = await lastKey(fx.projectId);

    // The gate catches it first, which is the correct outcome and the one the
    // route maps to a 400 naming the proposal. What must NEVER happen again is
    // a raw `PrismaClientValidationError` reaching the route's rethrow.
    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err instanceof PlanGrammarError || err instanceof PlanItemFieldRejectedError).toBe(true);
    if (err instanceof PlanGrammarError) {
      expect(err.reason).toBe('unknown_type');
      expect(err.planItemId).toBe(itemId);
    } else if (err instanceof PlanItemFieldRejectedError) {
      expect(err.planItemId).toBe(itemId);
      expect(err.field).toBe('type');
    }

    // ── The clean-rollback property, ASSERTED rather than assumed (AC 6).
    // The production incident happened to roll back cleanly — the failing child
    // proposed the same key on both attempts, so the counter had not advanced
    // and the story that materialized first did not exist. That was observed,
    // not guaranteed, and a rejection that leaves a half-tree is a far worse
    // failure than the 500 this card is about.
    expect(await lastKey(fx.projectId)).toBe(before);
    const created = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId, title: 'Cut the queue over' },
    });
    expect(created).toHaveLength(0);

    // And the plan still awaits a decision, so a corrected retry is legitimate.
    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.status).toBe('planned');
    await client.close();
  });

  it('the materialize containment turns a real ORM validation failure into a typed 4xx', async () => {
    // The LAST door, driven for real rather than constructed. `executor` is the
    // honest vehicle: the tool schema closes it, `validatePlanProposals` does
    // NOT re-check it, and materialize passes it straight to
    // `prisma.workItem.create()`. So a row forced into this state reaches the ORM
    // exactly the way `type: "migration"` used to — which is the whole class this
    // containment exists for, not the one column this card fixed. (It was
    // `priority` until MOTIR-10656 gave the gate an `unknown_priority` arm, which
    // now refuses that value before the ORM ever sees it.)
    //
    // Asserting it on a DIFFERENT column than the card's is deliberate: a
    // containment tested only through the value its own front door now refuses
    // is a containment nothing can ever reach.
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);

    const added = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [{ op: 'add', proposedFields: { title: 'Cut the queue over', kind: 'task' } }],
    });
    const itemId = ids(added)[0]!;
    await adminDb.planItem.update({
      where: { id: itemId },
      data: { proposedFields: { title: 'Cut the queue over', kind: 'task', executor: 'robot' } },
    });

    const before = await lastKey(fx.projectId);
    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanItemFieldRejectedError);
    const rejected = err as PlanItemFieldRejectedError;
    expect(rejected.code).toBe('PLAN_ITEM_FIELD_REJECTED');
    // It names the PROPOSAL — the actionable half, and the one the old bare 500
    // with an empty body could not give anybody.
    expect(rejected.planItemId).toBe(itemId);
    // …and the FIELD, parsed from Prisma's message. Parsed, never asserted: a
    // null field with a real proposal id is still strictly better than a 500,
    // which is why the class allows it.
    expect(rejected.field).toBe('executor');
    expect(rejected.message).toContain(itemId);

    // The transaction rolled back — same property as the `type` case above.
    expect(await lastKey(fx.projectId)).toBe(before);
    expect(
      await adminDb.workItem.findMany({
        where: { projectId: fx.projectId, title: 'Cut the queue over' },
      }),
    ).toHaveLength(0);
    await client.close();
  });

  it('a typed plan error still passes through the containment untouched', async () => {
    // The other half of the containment's contract, and the one a wrapper gets
    // wrong: `containPrismaFailure` one layer up is explicit that swallowing the
    // service's own typed errors would trade one opaque failure for another.
    // A grammar violation must arrive as itself, not as a field rejection.
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);

    const added = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [{ op: 'add', proposedFields: { title: 'Cut the queue over', kind: 'task' } }],
    });
    await adminDb.planItem.update({
      where: { id: ids(added)[0]! },
      data: { proposedFields: { title: 'Cut the queue over', kind: 'milestone' } },
    });

    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect(err).not.toBeInstanceOf(PlanItemFieldRejectedError);
    expect((err as PlanGrammarError).reason).toBe('unknown_kind');
    await client.close();
  });
});
