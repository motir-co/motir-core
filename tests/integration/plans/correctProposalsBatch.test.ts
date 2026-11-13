import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { buildMcpServer } from '@/lib/mcp/registry';
import { UPDATE_PLAN_PROPOSAL_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { PLAN_CORRECTION_BATCH_MAX, plansService } from '@/lib/services/plansService';
import {
  InvalidProposalError,
  PlanCorrectionRefusedError,
  PlanItemNotFoundError,
  PlanNotEditableError,
  PlanRefGraphError,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-11225 — the BATCH correction: several proposal corrections in ONE
// transaction, the plan judged once on the result. Real Postgres; every refusal
// is read back from the stored rows, not only from the thrown error.
//
// The fixture is the shape the bug was found on: an epic, a story under it, and
// two cards inside the story — a deploy card and an alarms card `blocked_by` it.
// The post-merge cut moves BOTH out of the story to hang under the epic, as
// tasks, keeping their edge. Each move alone leaves the edge between two levels
// (`cross_level`); only the pair, together, is legal.

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => null,
}));

const { PATCH: batchPATCH } = await import('@/app/api/internal/ai/plan-proposals/route');

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ref = (id: string) => `${TEMP_REF_PREFIX}${id}`;

interface PairPlan {
  planId: string;
  epicId: string;
  storyId: string;
  deployId: string;
  alarmsId: string;
}

/** Epic → story → { deploy, alarms ⟵blocked_by deploy }, each appended in its own call. */
async function pairPlan(fx: WorkItemFixture, jobId?: string): Promise<PairPlan> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Indexing', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const add = async (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    (
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: fields, ...extra } as never],
        fx.ctx,
      )
    ).appendedItemIds[0]!;
  const epicId = await add({ title: 'Indexing runs from a queue', kind: 'epic' });
  const storyId = await add(
    { title: 'Workers index from the queue', kind: 'story' },
    { parentRef: ref(epicId) },
  );
  const deployId = await add(
    { title: 'Deploy the worker service', kind: 'subtask' },
    { parentRef: ref(storyId) },
  );
  const alarmsId = await add(
    { title: 'Alarm on the worker queue', kind: 'subtask' },
    { parentRef: ref(storyId), blockedByRefs: [ref(deployId)] },
  );
  if (jobId) await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return { planId: plan.id, epicId, storyId, deployId, alarmsId };
}

/** The two moves the cut makes: beside the story, as tasks, waiting on it — the pair's edge kept. */
function pairMoves(p: PairPlan) {
  return [
    {
      planItemId: p.deployId,
      parentRef: ref(p.epicId),
      kind: 'task',
      blockedByRefs: [ref(p.storyId)],
    },
    {
      planItemId: p.alarmsId,
      parentRef: ref(p.epicId),
      kind: 'task',
      blockedByRefs: [ref(p.deployId), ref(p.storyId)],
    },
  ];
}

/** The plan's proposals exactly as stored, for a byte-identical comparison. */
async function storedProposals(planId: string): Promise<string> {
  const rows = await adminDb.planItem.findMany({ where: { planId }, orderBy: { id: 'asc' } });
  return JSON.stringify(
    rows.map((r) => ({
      id: r.id,
      parentRef: r.parentRef,
      blockedByRefs: r.blockedByRefs,
      supersedesRefs: r.supersedesRefs,
      proposedFields: r.proposedFields,
      patch: r.patch,
      edgeReasons: r.edgeReasons,
    })),
  );
}

const editedRevisions = (planId: string) =>
  adminDb.planRevision.findMany({
    where: { planId, changeKind: 'edited' },
    orderBy: { changedAt: 'asc' },
  });

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

describe('plansService.correctProposals — the pair that is only legal together', () => {
  it('REFUSES each move sent alone `cross_level`, as the single door always has', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    const [deployMove, alarmsMove] = pairMoves(p);
    const before = await storedProposals(p.planId);

    for (const { planItemId, ...move } of [deployMove!, alarmsMove!]) {
      const err = await refusal(plansService.correctProposal(p.planId, planItemId, move, fx.ctx));
      expect(err).toBeInstanceOf(PlanRefGraphError);
      expect((err as PlanRefGraphError).reason).toBe('cross_level');
    }
    expect(await storedProposals(p.planId)).toBe(before);
  });

  it('ACCEPTS both moves in one batch: both re-parent, both re-kind to task, the edge stays', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);

    const result = await plansService.correctProposals(p.planId, pairMoves(p), fx.ctx);

    const deploy = await adminDb.planItem.findUniqueOrThrow({ where: { id: p.deployId } });
    const alarms = await adminDb.planItem.findUniqueOrThrow({ where: { id: p.alarmsId } });
    expect(deploy.parentRef).toBe(ref(p.epicId));
    expect(alarms.parentRef).toBe(ref(p.epicId));
    expect((deploy.proposedFields as { kind: string }).kind).toBe('task');
    expect((alarms.proposedFields as { kind: string }).kind).toBe('task');
    expect(alarms.blockedByRefs).toEqual([ref(p.deployId), ref(p.storyId)]);
    expect(result.items.map((i) => i.id)).toEqual(expect.arrayContaining([p.deployId, p.alarmsId]));

    // Each correction on the timeline, marked with the batch it rode in.
    const revisions = await editedRevisions(p.planId);
    expect(revisions.map((r) => r.planItemId)).toEqual([p.deployId, p.alarmsId]);
    for (const [index, r] of revisions.entries()) {
      expect(r.diff).toMatchObject({
        correction: true,
        proposalCount: 1,
        batch: { size: 2, index },
      });
      expect((r.diff as { fields: string[] }).fields).toContain('kind');
    }
  });

  it('holds on a `planned` plan too', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    await plansService.markPlanned(p.planId, fx.ctx);
    const result = await plansService.correctProposals(p.planId, pairMoves(p), fx.ctx);
    expect(result.status).toBe('planned');
    const alarms = await adminDb.planItem.findUniqueOrThrow({ where: { id: p.alarmsId } });
    expect(alarms.parentRef).toBe(ref(p.epicId));
  });
});

describe('plansService.correctProposals — all or nothing', () => {
  it('a cross-level edge the batch as a WHOLE leaves writes nothing and names the correction', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    const before = await storedProposals(p.planId);
    // The deploy card moves; the alarms card is only retitled and stays inside,
    // still `blocked_by` a card that is now a level up.
    const err = await refusal(
      plansService.correctProposals(
        p.planId,
        [pairMoves(p)[0]!, { planItemId: p.alarmsId, title: 'Alarm on the queue depth' }],
        fx.ctx,
      ),
    );
    expect(err).toBeInstanceOf(PlanCorrectionRefusedError);
    const refused = err as PlanCorrectionRefusedError;
    expect(refused.cause).toBeInstanceOf(PlanRefGraphError);
    expect((refused.cause as PlanRefGraphError).reason).toBe('cross_level');
    expect(refused.correctionIndex).toBe(1);
    expect(refused.planItemId).toBe(p.alarmsId);
    expect(refused.message).toContain('nothing in the batch was written');
    expect(await storedProposals(p.planId)).toBe(before);
    expect(await editedRevisions(p.planId)).toHaveLength(0);
  });

  it('a cycle closed across two corrections writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    const before = await storedProposals(p.planId);
    const err = await refusal(
      plansService.correctProposals(
        p.planId,
        [{ planItemId: p.deployId, blockedByRefs: [ref(p.alarmsId)] }],
        fx.ctx,
      ),
    );
    expect(err).toBeInstanceOf(PlanCorrectionRefusedError);
    expect((err as PlanCorrectionRefusedError).correctionIndex).not.toBeUndefined();
    expect(await storedProposals(p.planId)).toBe(before);
  });

  it('an unresolved ref in the SECOND correction refuses the first one too', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    const before = await storedProposals(p.planId);
    const err = await refusal(
      plansService.correctProposals(
        p.planId,
        [
          { planItemId: p.deployId, title: 'Deploy the indexer workers' },
          { planItemId: p.alarmsId, blockedByRefs: [ref('no-such-proposal')] },
        ],
        fx.ctx,
      ),
    );
    expect(err).toBeInstanceOf(PlanCorrectionRefusedError);
    const refused = err as PlanCorrectionRefusedError;
    expect(refused.cause).toBeInstanceOf(UnresolvedPlanRefError);
    expect(refused.correctionIndex).toBe(1);
    expect(refused.planItemId).toBe(p.alarmsId);
    expect(refused.message).toMatch(/^corrections\[1\] \(proposal /);
    expect(await storedProposals(p.planId)).toBe(before);
  });

  it('refuses an empty batch, an oversized one, a repeated proposal and an unknown one', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    await expect(plansService.correctProposals(p.planId, [], fx.ctx)).rejects.toThrow(
      InvalidProposalError,
    );
    const tooMany = Array.from({ length: PLAN_CORRECTION_BATCH_MAX + 1 }, () => ({
      planItemId: p.deployId,
      title: 'x',
    }));
    await expect(plansService.correctProposals(p.planId, tooMany, fx.ctx)).rejects.toThrow(
      InvalidProposalError,
    );
    const twice = await refusal(
      plansService.correctProposals(
        p.planId,
        [
          { planItemId: p.deployId, title: 'one' },
          { planItemId: p.deployId, title: 'two' },
        ],
        fx.ctx,
      ),
    );
    expect((twice as PlanCorrectionRefusedError).correctionIndex).toBe(1);
    expect((twice as PlanCorrectionRefusedError).cause).toBeInstanceOf(InvalidProposalError);
    const unknown = await refusal(
      plansService.correctProposals(p.planId, [{ planItemId: 'nope', title: 'x' }], fx.ctx),
    );
    expect((unknown as PlanCorrectionRefusedError).cause).toBeInstanceOf(PlanItemNotFoundError);
    const empty = await refusal(
      plansService.correctProposals(p.planId, [{ planItemId: p.deployId }], fx.ctx),
    );
    expect((empty as PlanCorrectionRefusedError).cause).toBeInstanceOf(InvalidProposalError);
  });
});

describe('plansService.correctProposals — the status gate', () => {
  it.each(['approved', 'declined'] as const)(
    'is refused on an `%s` plan exactly as the single door is',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const p = await pairPlan(fx);
      await adminDb.plan.update({ where: { id: p.planId }, data: { status } });
      const before = await storedProposals(p.planId);
      await expect(plansService.correctProposals(p.planId, pairMoves(p), fx.ctx)).rejects.toThrow(
        PlanNotEditableError,
      );
      const [single] = pairMoves(p);
      const { planItemId, ...move } = single!;
      await expect(
        plansService.correctProposal(p.planId, planItemId, move, fx.ctx),
      ).rejects.toThrow(PlanNotEditableError);
      expect(await storedProposals(p.planId)).toBe(before);
    },
  );
});

// ── The internal job-token door: PATCH /api/internal/ai/plan-proposals ────────

function batchRequest(fx: WorkItemFixture, body: unknown, raw?: string): Promise<Response> {
  const req = new Request('http://core/api/internal/ai/plan-proposals', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
    body: raw ?? JSON.stringify(body),
  });
  req.headers.set(
    'x-motir-job-token',
    mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    }),
  );
  return batchPATCH(req);
}

/** The wire shape motir-ai sends: content keys under `patch`, structure beside them. */
function wireMoves(p: PairPlan) {
  return pairMoves(p).map(({ planItemId, kind, ...structure }) => ({
    planItemId,
    patch: { kind },
    ...structure,
  }));
}

describe('PATCH /api/internal/ai/plan-proposals — the batch door', () => {
  it('200: moves the pair in one call and answers the corrected proposals in order', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx, 'job-batch-ok');
    const res = await batchRequest(fx, { jobId: 'job-batch-ok', corrections: wireMoves(p) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { planId: string; items: { id: string }[] };
    expect(body.planId).toBe(p.planId);
    expect(body.items.map((i) => i.id)).toEqual([p.deployId, p.alarmsId]);
    const alarms = await adminDb.planItem.findUniqueOrThrow({ where: { id: p.alarmsId } });
    expect(alarms.parentRef).toBe(ref(p.epicId));
    expect((alarms.proposedFields as { kind: string }).kind).toBe('task');
  });

  it('422 naming the correction, with the cause’s own code, and nothing written', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx, 'job-batch-refused');
    const before = await storedProposals(p.planId);
    const res = await batchRequest(fx, {
      jobId: 'job-batch-refused',
      corrections: [wireMoves(p)[0], { planItemId: p.alarmsId, patch: { title: 'Alarms' } }],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('INVALID_PLAN_REF_GRAPH');
    expect(body.reason).toBe('cross_level');
    expect(body.correctionIndex).toBe(1);
    expect(body.planItemId).toBe(p.alarmsId);
    expect(await storedProposals(p.planId)).toBe(before);
  });

  it('409 on a declined plan, 404 for a job with no plan', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx, 'job-batch-closed');
    await adminDb.plan.update({ where: { id: p.planId }, data: { status: 'declined' } });
    const closed = await batchRequest(fx, { jobId: 'job-batch-closed', corrections: wireMoves(p) });
    expect(closed.status).toBe(409);
    const none = await batchRequest(fx, { jobId: 'job-nobody', corrections: wireMoves(p) });
    expect(none.status).toBe(404);
  });

  it('400 PROPOSALS_INVALID for a malformed body', async () => {
    const fx = await makeWorkItemFixture();
    expect((await batchRequest(fx, undefined, 'not json')).status).toBe(400);
    expect((await batchRequest(fx, { corrections: [] })).status).toBe(400);
    expect((await batchRequest(fx, { jobId: 'j', corrections: 'nope' })).status).toBe(400);
    const missing = await batchRequest(fx, { jobId: 'j', corrections: [{ patch: {} }] });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { correctionIndex: number }).correctionIndex).toBe(0);
  });

  it('401 without the service secret, before the body is read', async () => {
    const res = await batchPATCH(
      new Request('http://core/api/internal/ai/plan-proposals', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: 'j', corrections: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('a key ref naming no work item refuses the batch and names its correction', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx, 'job-batch-key');
    const before = await storedProposals(p.planId);
    const [first] = wireMoves(p);
    const res = await batchRequest(fx, {
      jobId: 'job-batch-key',
      corrections: [first, { planItemId: p.alarmsId, blockedByRefs: ['NOPE-424242'] }],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.correctionIndex).toBe(1);
    expect(String(body.error)).toContain('corrections[1]');
    expect(await storedProposals(p.planId)).toBe(before);
  });
});

// ── The MCP twin: `update_plan_proposal` with `corrections` ───────────────────

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'correct-proposals-batch', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');

async function callTool(client: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({
    name: UPDATE_PLAN_PROPOSAL_TOOL_NAME,
    arguments: args,
  })) as CallToolResult;
}

describe('update_plan_proposal { corrections } — the MCP twin', () => {
  it('moves the pair in one call', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    const client = await connect(fx.ctx);
    const result = await callTool(client, { planId: p.planId, corrections: pairMoves(p) });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(textOf(result)).toContain('Corrected 2 proposal(s)');
    expect(textOf(result)).toContain(`corrections[1] — proposal ${p.alarmsId}`);
    const alarms = await adminDb.planItem.findUniqueOrThrow({ where: { id: p.alarmsId } });
    expect(alarms.parentRef).toBe(ref(p.epicId));
  });

  it('names the refused correction under the cause’s code', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    const client = await connect(fx.ctx);
    const result = await callTool(client, {
      planId: p.planId,
      corrections: [pairMoves(p)[0], { planItemId: p.alarmsId, title: 'Alarms' }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(textOf(result)).toContain(`corrections[1] (proposal ${p.alarmsId})`);
  });

  it('refuses `corrections` beside the single form, and a call naming no proposal', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    const client = await connect(fx.ctx);
    const mixed = await callTool(client, {
      planId: p.planId,
      planItemId: p.deployId,
      title: 'x',
      corrections: pairMoves(p),
    });
    expect(mixed.isError).toBe(true);
    expect(textOf(mixed)).toContain('INSTEAD of `planItemId`');
    const neither = await callTool(client, { planId: p.planId, title: 'x' });
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toContain('Name the proposal to correct');
  });

  it('still corrects ONE proposal through the single form', async () => {
    const fx = await makeWorkItemFixture();
    const p = await pairPlan(fx);
    const client = await connect(fx.ctx);
    const result = await callTool(client, {
      planId: p.planId,
      planItemId: p.deployId,
      title: 'Deploy the indexer workers',
    });
    expect(result.isError, textOf(result)).toBeFalsy();
    const deploy = await adminDb.planItem.findUniqueOrThrow({ where: { id: p.deployId } });
    expect((deploy.proposedFields as { title: string }).title).toBe('Deploy the indexer workers');
  });
});
