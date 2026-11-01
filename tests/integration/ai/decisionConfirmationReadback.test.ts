import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE AI BOUNDARY CARRIES A DECISION'S CONFIRMATION (Story MOTIR-5871 · Subtask
// MOTIR-5958; widened by Bug MOTIR-10146). Through the REAL internal routes, against
// a real Postgres: a decision's latest deciding gate — `decision_confirmation` for a
// `human` decision, `decision_approval` for the planner's own `coding_agent` record —
// rides `get-item`, `get-subtree` and `plan-tree` as a `decision` block —
// `confirmed` / `overturned` / `awaiting` / `none`, dated when decided, with an
// overturn's owed keys and the person's note — read in ONE query per response
// however many decisions the set holds, and `null` on every other item.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { aiBoundaryService } = await import('@/lib/services/aiBoundaryService');
const { GET: getItemGET } = await import('@/app/api/internal/ai/get-item/route');
const { GET: getSubtreeGET } = await import('@/app/api/internal/ai/get-subtree/route');
const { GET: planTreeGET } = await import('@/app/api/internal/ai/plan-tree/route');

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;

function req(path: string, fx: Fx, query: Record<string, string> = {}): Request {
  const url = new URL(`http://core/api/internal/ai/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, {
    headers: {
      authorization: `Bearer ${SERVICE_SECRET}`,
      'x-motir-job-token': mintJobToken({
        userId: fx.ctx.userId,
        workspaceId: fx.ctx.workspaceId,
        projectId: fx.projectId,
      }),
    },
  });
}

const BODY = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** less requirement',
  'The approved plan kept exports in Postgres.',
  '## Supersedes',
  'MOTIR-6 and MOTIR-7',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

let seq = 0;
async function decision(fx: Fx, epicId: string, descriptionMd = BODY, executor = 'human') {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      parentId: epicId,
      title: `Decision ${seq}`,
      type: 'decision',
      executor: executor as 'human',
      descriptionMd,
    },
    fx.ctx,
  );
}

async function decide(fx: Fx, itemId: string, verb: 'approve' | 'overturn') {
  const read = await approvalGatesService.getForWorkItem(
    { workItemId: itemId, kind: 'decision_confirmation' },
    fx.ctx,
  );
  const result = await approvalGatesService.decide(
    {
      gateId: read.gate!.id,
      decision: verb,
      source: 'api',
      stamp: read.stamp!,
      ...(verb === 'overturn' ? { noteMd: 'Not what we agreed.' } : {}),
    },
    fx.ctx,
  );
  return result.gate.decidedAt!;
}

/**
 * The planner's own decision's `decision_approval` gate, in a given state. Written
 * straight to the table: what is under test is the boundary's READ of the gate, and
 * the publish path that raises one is `decisionPageService`'s own suite.
 */
async function approvalGate(
  fx: Fx,
  workItemId: string,
  state: 'approved' | 'changes_requested' | 'awaiting',
  createdAt: Date,
) {
  const decided = state !== 'awaiting';
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      kind: 'decision_approval',
      subjectId: `page-version-${createdAt.getTime()}`,
      state,
      createdAt,
      ...(decided
        ? { decidedAt: new Date(createdAt.getTime() + 60_000), noteMd: 'Reviewed.' }
        : {}),
    },
  });
  return gate.decidedAt?.toISOString() ?? null;
}

async function scene() {
  const fx = await makeFixture();
  const epic = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Exports' },
    fx.ctx,
  );
  const confirmed = await decision(fx, epic.id);
  const confirmedAt = await decide(fx, confirmed.id, 'approve');
  const overturned = await decision(fx, epic.id);
  const overturnedAt = await decide(fx, overturned.id, 'overturn');
  const awaiting = await decision(fx, epic.id);
  const defective = await decision(fx, epic.id, '## Decision\nOnly this.');
  const agent = await decision(fx, epic.id, BODY, 'coding_agent');
  // An older version sent back, then the republished one approved: the latest wins.
  await approvalGate(fx, agent.id, 'changes_requested', new Date('2026-10-01T09:00:00Z'));
  const agentAt = await approvalGate(fx, agent.id, 'approved', new Date('2026-10-02T09:00:00Z'));
  const sentBack = await decision(fx, epic.id, BODY, 'coding_agent');
  await approvalGate(fx, sentBack.id, 'changes_requested', new Date('2026-10-03T09:00:00Z'));
  const unpublished = await decision(fx, epic.id, BODY, 'coding_agent');
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Plain', parentId: epic.id },
    fx.ctx,
  );
  return {
    fx,
    epic,
    confirmed,
    confirmedAt,
    overturned,
    overturnedAt,
    awaiting,
    defective,
    agent,
    agentAt,
    sentBack,
    unpublished,
    story,
  };
}

describe('GET get-item — the decision block', () => {
  it('confirmed · overturned · awaiting · none, and null on every other item', async () => {
    const s = await scene();
    const blockOf = async (key: string) => {
      const res = await getItemGET(req('get-item', s.fx, { key }));
      expect(res.status).toBe(200);
      return (await res.json()).item.decision;
    };
    const human = { kind: 'decision_confirmation' };
    const agent = { kind: 'decision_approval' };
    expect(await blockOf(s.confirmed.identifier)).toEqual({
      ...human,
      state: 'confirmed',
      decidedAt: s.confirmedAt,
      replanOwed: null,
      noteMd: null,
    });
    expect(await blockOf(s.overturned.identifier)).toEqual({
      ...human,
      state: 'overturned',
      decidedAt: s.overturnedAt,
      replanOwed: ['MOTIR-6', 'MOTIR-7'],
      noteMd: 'Not what we agreed.',
    });
    expect(await blockOf(s.awaiting.identifier)).toEqual({
      ...human,
      state: 'awaiting',
      decidedAt: null,
      replanOwed: null,
      noteMd: null,
    });
    expect(await blockOf(s.defective.identifier)).toEqual({
      ...human,
      state: 'none',
      decidedAt: null,
      replanOwed: null,
      noteMd: null,
    });
    expect(await blockOf(s.agent.identifier)).toEqual({
      ...agent,
      state: 'confirmed',
      decidedAt: s.agentAt,
      replanOwed: null,
      noteMd: null,
    });
    expect(await blockOf(s.sentBack.identifier)).toEqual({
      ...agent,
      state: 'awaiting',
      decidedAt: null,
      replanOwed: null,
      noteMd: null,
    });
    expect(await blockOf(s.unpublished.identifier)).toEqual({
      ...agent,
      state: 'none',
      decidedAt: null,
      replanOwed: null,
      noteMd: null,
    });
    expect(await blockOf(s.story.identifier)).toBeNull();
    expect(await blockOf(s.epic.identifier)).toBeNull();
  });
});

describe('skeleton rows — get-subtree and plan-tree carry the same block', () => {
  it('get-subtree rows carry each decision’s block, and null elsewhere', async () => {
    const s = await scene();
    const res = await getSubtreeGET(
      req('get-subtree', s.fx, { rootKey: s.epic.identifier, depth: '1' }),
    );
    expect(res.status).toBe(200);
    const byKey = new Map(
      (await res.json()).nodes.map((n: { key: string; decision: unknown }) => [n.key, n.decision]),
    );
    expect(byKey.get(s.confirmed.identifier)).toMatchObject({ state: 'confirmed' });
    expect(byKey.get(s.overturned.identifier)).toMatchObject({
      state: 'overturned',
      replanOwed: ['MOTIR-6', 'MOTIR-7'],
      noteMd: 'Not what we agreed.',
    });
    expect(byKey.get(s.awaiting.identifier)).toMatchObject({ state: 'awaiting' });
    expect(byKey.get(s.defective.identifier)).toMatchObject({ state: 'none' });
    expect(byKey.get(s.agent.identifier)).toEqual({
      kind: 'decision_approval',
      state: 'confirmed',
      decidedAt: s.agentAt,
      replanOwed: null,
      noteMd: null,
    });
    expect(byKey.get(s.sentBack.identifier)).toMatchObject({ state: 'awaiting' });
    expect(byKey.get(s.story.identifier)).toBeNull();
    expect(byKey.get(s.epic.identifier)).toBeNull();
  });

  it('plan-tree rows carry the same block', async () => {
    const s = await scene();
    const res = await planTreeGET(req('plan-tree', s.fx));
    expect(res.status).toBe(200);
    const items = (await res.json()).items as Array<{ key: string; decision: unknown }>;
    expect(items.find((i) => i.key === s.confirmed.identifier)?.decision).toEqual({
      kind: 'decision_confirmation',
      state: 'confirmed',
      decidedAt: s.confirmedAt,
      replanOwed: null,
      noteMd: null,
    });
    expect(items.find((i) => i.key === s.agent.identifier)?.decision).toEqual({
      kind: 'decision_approval',
      state: 'confirmed',
      decidedAt: s.agentAt,
      replanOwed: null,
      noteMd: null,
    });
    expect(items.find((i) => i.key === s.story.identifier)?.decision).toBeNull();
  });
});

describe('ONE query, however many decisions', () => {
  it('a subtree of three decisions costs the same queries as one of one', async () => {
    const countQueries = async (fn: () => Promise<unknown>): Promise<number> => {
      let calls = 0;
      const listener = (e: { query: string }) => {
        if (!/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(e.query.trim())) calls += 1;
      };
      (db as unknown as { $on: (e: 'query', cb: (e: { query: string }) => void) => void }).$on(
        'query',
        listener,
      );
      await fn();
      return calls;
    };

    const fx = await makeFixture();
    const small = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Small' },
      fx.ctx,
    );
    await decision(fx, small.id);
    const big = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Big' },
      fx.ctx,
    );
    for (let i = 0; i < 3; i += 1) await decision(fx, big.id);

    const one = await countQueries(() =>
      aiBoundaryService.getSubtree(fx.projectId, small.identifier, 1, fx.ctx),
    );
    const three = await countQueries(() =>
      aiBoundaryService.getSubtree(fx.projectId, big.identifier, 1, fx.ctx),
    );
    // The listener is cumulative (Prisma has no `$off`), so compare the DELTA.
    expect(three - one).toBe(one);
  });
});
