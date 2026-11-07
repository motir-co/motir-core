import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { InvalidProposalError } from '@/lib/plans/errors';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';
import { mcpRouteFetch } from '../../helpers/mcpRouteFetch';

// MOTIR-10490 — a proposal stores `authorFinished`; the deepen doors carry it,
// no `add` claims it, and a card written BY HAND on a plan no session is working
// on is stamped by core itself. Real Postgres throughout, and the MCP doors are
// driven through the real `/api/mcp` transport under an ordinary project
// member's token, so the tool schemas, the access context and the live-step read
// are the ones a caller meets.

const SERVICE_SECRET = 'core-callback-secret-test';
const ENDPOINT = 'http://localhost/api/mcp';

const BOUNDARY = '## Scope BOUNDARY\n\nStarts at the door and ends at the store.';
const WRITTEN = `Why the card exists.\n\n${BOUNDARY}\n\n## Acceptance criteria\n\n- It stores the key.`;
/** A boundary that uses a third-level heading and a fenced line — still only a boundary. */
const BOUNDARY_ONLY_RICH = `${BOUNDARY}\n\n### It owns\n\n- the key\n\n\`\`\`\n## Not a heading\n\`\`\``;

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** An ordinary project MEMBER — the access context the doors run under. */
async function member(fx: WorkItemFixture): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: `author-finished-${seq++}@example.com`,
    password: 'correct-horse-battery-staple',
    name: 'A member',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

async function connect(ctx: ServiceContext): Promise<Client> {
  const { token } = await apiTokensService.create(ctx.userId, ctx.workspaceId, {
    label: `author-finished-${seq++}`,
    fixedGrant: [...GRANTABLE_PERMISSIONS],
  });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'author-finished-doors', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

async function fieldsOf(itemId: string): Promise<Record<string, unknown>> {
  return (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } }))
    .proposedFields as Record<string, unknown>;
}

const editedRows = (planId: string) =>
  adminDb.planRevision.findMany({
    where: { planId, changeKind: 'edited' },
    orderBy: { changedAt: 'asc' },
  });

async function newPlan(ctx: ServiceContext, fx: WorkItemFixture, title = 'Hand-written') {
  return plansService.createPlan(fx.projectId, { title }, ctx);
}

async function addOne(
  ctx: ServiceContext,
  planId: string,
  proposedFields: Record<string, unknown>,
): Promise<string> {
  const appended = await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { kind: 'task', ...proposedFields } as never }],
    ctx,
  );
  return appended.appendedItemIds[0]!;
}

describe('the stored fact — update_plan_item sets, clears and keeps it', () => {
  it('true stores it, a write omitting it keeps it, null clears it — on generating, and on planned with revision', async () => {
    const fx = await makeWorkItemFixture();
    const ctx = await member(fx);
    const client = await connect(ctx);
    const plan = await newPlan(ctx, fx);
    const itemId = await addOne(ctx, plan.id, { title: 'Titles first' });

    const set = await call(client, 'update_plan_item', {
      planId: plan.id,
      planItemId: itemId,
      authorFinished: true,
    });
    expect(set.isError).toBeFalsy();
    expect((await fieldsOf(itemId))['authorFinished']).toBe(true);

    await call(client, 'update_plan_item', {
      planId: plan.id,
      planItemId: itemId,
      priority: 'low',
    });
    expect((await fieldsOf(itemId))['authorFinished']).toBe(true);

    await call(client, 'update_plan_item', {
      planId: plan.id,
      planItemId: itemId,
      authorFinished: null,
    });
    expect(await fieldsOf(itemId)).toHaveProperty('authorFinished', null);

    // Any other value is refused by the tool's schema, and nothing is stored.
    const refused = await call(client, 'update_plan_item', {
      planId: plan.id,
      planItemId: itemId,
      authorFinished: false,
    });
    expect(refused.isError).toBe(true);
    expect(await fieldsOf(itemId)).toHaveProperty('authorFinished', null);

    await plansService.markPlanned(plan.id, ctx);
    const revised = await call(client, 'update_plan_item', {
      planId: plan.id,
      planItemId: itemId,
      revision: true,
      authorFinished: true,
    });
    expect(revised.isError).toBeFalsy();
    expect((await fieldsOf(itemId))['authorFinished']).toBe(true);
    await call(client, 'update_plan_item', {
      planId: plan.id,
      planItemId: itemId,
      revision: true,
      authorFinished: null,
    });
    expect(await fieldsOf(itemId)).toHaveProperty('authorFinished', null);
    await client.close();
  });

  it('a write carrying only authorFinished records no `edited` row; one carrying more does not list it', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx.ctx, fx);
    const itemId = await addOne(fx.ctx, plan.id, { title: 'Quiet' });
    const before = (await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } }))
      .lastActivityAt;
    await adminDb.plan.update({
      where: { id: plan.id },
      data: { lastActivityAt: new Date(Date.now() - 3_600_000) },
    });

    await plansService.deepenProposal(plan.id, itemId, { authorFinished: true }, fx.ctx);
    expect(await editedRows(plan.id)).toHaveLength(0);
    // …and still stamps the plan's activity.
    const after = (await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).lastActivityAt;
    expect(after!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(before).not.toBeNull();

    await plansService.deepenProposal(
      plan.id,
      itemId,
      { authorFinished: null, priority: 'high' },
      fx.ctx,
    );
    const rows = await editedRows(plan.id);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.diff as { fields: string[] }).fields).toEqual(['priority']);

    // The correction door: a write of only the key is legal and records nothing.
    await plansService.correctProposal(plan.id, itemId, { authorFinished: true }, fx.ctx);
    expect(await editedRows(plan.id)).toHaveLength(1);
    expect((await fieldsOf(itemId))['authorFinished']).toBe(true);
    // An empty correction is still refused.
    await expect(plansService.correctProposal(plan.id, itemId, {}, fx.ctx)).rejects.toBeInstanceOf(
      InvalidProposalError,
    );
  });
});

describe('the closed doors — no add claims it, no modify carries it', () => {
  it('addProposals refuses an add naming authorFinished, by name, and writes nothing from the batch', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx.ctx, fx);
    const err = await plansService
      .addProposals(
        plan.id,
        [
          { op: 'add', proposedFields: { title: 'Fine', kind: 'task' } },
          {
            op: 'add',
            proposedFields: { title: 'Claims it', kind: 'task', authorFinished: true },
          },
        ],
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as Error).message).toContain('authorFinished');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });

  it('the hosted append answers 422 and writes nothing from that batch — null included', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx.ctx, fx);
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-af' } });
    const req = new Request('http://core/api/internal/ai/plan-proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
      body: JSON.stringify({
        jobId: 'job-af',
        proposals: [
          { op: 'add', proposedFields: { title: 'Fine', kind: 'task' } },
          { op: 'add', proposedFields: { title: 'Claims it', kind: 'task', authorFinished: null } },
        ],
      }),
    });
    req.headers.set(
      'x-motir-job-token',
      mintJobToken({ userId: fx.ctx.userId, workspaceId: fx.workspaceId, projectId: fx.projectId }),
    );
    const res = await proposalsPOST(req);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('authorFinished');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });

  it('add_plan_items stores nothing for the key — its schema refuses the unknown argument', async () => {
    const fx = await makeWorkItemFixture();
    const ctx = await member(fx);
    const client = await connect(ctx);
    const plan = await newPlan(ctx, fx);
    const res = await call(client, 'add_plan_items', {
      planId: plan.id,
      proposals: [
        {
          op: 'add',
          // A title-only add claiming the state: nothing is stored for it.
          proposedFields: { title: 'Claims it', kind: 'task', authorFinished: true },
        },
      ],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('authorFinished');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
    await client.close();
  });

  it('a correction naming authorFinished on a modify or a remove is refused by the content-key refusal', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Committed' });
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'Doomed' });
    const plan = await newPlan(fx.ctx, fx);
    const appended = await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: target.id, patch: { priority: 'high' } },
        { op: 'remove', workItemId: other.id },
      ],
      fx.ctx,
    );
    for (const itemId of appended.appendedItemIds) {
      const err = await plansService
        .correctProposal(plan.id, itemId, { authorFinished: true }, fx.ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidProposalError);
      expect((err as Error).message).toContain('authorFinished');
    }
    // A modify's patch cannot carry it either: the append's key check refuses it.
    const plan2 = await newPlan(fx.ctx, fx, 'Second');
    await expect(
      plansService.addProposals(
        plan2.id,
        [{ op: 'modify', workItemId: target.id, patch: { authorFinished: true } as never }],
        fx.ctx,
      ),
    ).rejects.toThrow(/authorFinished/);
    // No committed card gained any state.
    const committed = await adminDb.workItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(JSON.stringify(committed)).not.toContain('authorFinished');
  });
});

describe('the stamp — a card written by hand is marked written as its body lands', () => {
  it('stamps an add_plan_items add, an update_plan_item deepen and an update_plan_proposal correction with no live step', async () => {
    const fx = await makeWorkItemFixture();
    const ctx = await member(fx);
    const client = await connect(ctx);
    const plan = await newPlan(ctx, fx);

    // A partial body — framing, boundary and criteria, with no context refs, so
    // `validate_plan` still names it as lacking a section — is still written.
    const added = await call(client, 'add_plan_items', {
      planId: plan.id,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'By hand', kind: 'task', type: 'code', descriptionMd: WRITTEN },
        },
      ],
    });
    expect(added.isError).toBeFalsy();
    const [addRow] = await adminDb.planItem.findMany({ where: { planId: plan.id } });
    expect((addRow!.proposedFields as Record<string, unknown>)['authorFinished']).toBe(true);

    const deepId = await addOne(ctx, plan.id, { title: 'Deepened by hand' });
    expect(await fieldsOf(deepId)).not.toHaveProperty('authorFinished');
    const deepened = await call(client, 'update_plan_item', {
      planId: plan.id,
      planItemId: deepId,
      descriptionMd: WRITTEN,
    });
    expect(deepened.isError).toBeFalsy();
    expect((await fieldsOf(deepId))['authorFinished']).toBe(true);

    const corrId = await addOne(ctx, plan.id, { title: 'Corrected by hand' });
    const corrected = await call(client, 'update_plan_proposal', {
      planId: plan.id,
      planItemId: corrId,
      sections: {
        framing: 'Why.',
        scopeBoundary: 'Edge.',
        acceptanceCriteria: ['It works.'],
        contextRefs: [{ ref: 'lib/plans/authorFinished.ts', why: 'the body test' }],
      },
    });
    expect(corrected.isError, textOf(corrected)).toBeFalsy();
    expect((await fieldsOf(corrId))['authorFinished']).toBe(true);

    // The validator still names the partial body as lacking sections.
    const validated = await call(client, 'validate_plan', { planId: plan.id });
    expect(textOf(validated)).toMatch(/contextRefs|Context refs/);
    await client.close();
  });

  it('a review edit and a revision on a planned plan are stamped too — a planned plan’s old PlanStep row is no live step', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx.ctx, fx);
    const itemId = await addOne(fx.ctx, plan.id, { title: 'Reviewed' });
    const revId = await addOne(fx.ctx, plan.id, { title: 'Revised' });
    await plansService.recordPlanStep(
      plan.id,
      { sessionKey: 'dead-session', kind: 'author', targetRef: `planItem:${itemId}` },
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    // The step outlived its plan's `generating` window.
    await adminDb.planStep.create({
      data: { planId: plan.id, sessionKey: 'stale', kind: 'author', startedAt: new Date() },
    });
    expect(await adminDb.planStep.count({ where: { planId: plan.id } })).toBeGreaterThan(0);

    await plansService.updateProposal(plan.id, itemId, { descriptionMd: WRITTEN }, fx.ctx);
    expect((await fieldsOf(itemId))['authorFinished']).toBe(true);
    await plansService.reviseProposal(plan.id, revId, { descriptionMd: WRITTEN }, fx.ctx);
    expect((await fieldsOf(revId))['authorFinished']).toBe(true);
  });

  it('does not stamp a boundary-only body, a title-only add, or a write naming no body over a long one', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx.ctx, fx);

    const boundaryOnly = await addOne(fx.ctx, plan.id, {
      title: 'Boundary only',
      descriptionMd: BOUNDARY_ONLY_RICH,
    });
    expect(await fieldsOf(boundaryOnly)).not.toHaveProperty('authorFinished');
    await plansService.deepenProposal(plan.id, boundaryOnly, { descriptionMd: BOUNDARY }, fx.ctx);
    expect(await fieldsOf(boundaryOnly)).not.toHaveProperty('authorFinished');

    const titleOnly = await addOne(fx.ctx, plan.id, { title: 'Title only' });
    expect(await fieldsOf(titleOnly)).toEqual({ title: 'Title only', kind: 'task' });

    // A long body landed while a session was live, so it reads not written…
    const long = await addOne(fx.ctx, plan.id, { title: 'Long' });
    await plansService.recordPlanStep(
      plan.id,
      { sessionKey: 's1', kind: 'author', targetRef: `planItem:${long}` },
      fx.ctx,
    );
    await plansService.deepenProposal(plan.id, long, { descriptionMd: WRITTEN }, fx.ctx);
    await plansService.endPlanStep(plan.id, 's1', fx.ctx);
    expect(await fieldsOf(long)).not.toHaveProperty('authorFinished');
    // …and a later write naming no body does not stamp it, live step or not.
    await plansService.deepenProposal(plan.id, long, { priority: 'high' }, fx.ctx);
    await plansService.deepenProposal(plan.id, long, { explanationMd: 'Why.' }, fx.ctx);
    expect(await fieldsOf(long)).not.toHaveProperty('authorFinished');
  });

  it('does not stamp any body written while a lay or author step is live — under a member’s own context', async () => {
    const fx = await makeWorkItemFixture();
    const ctx = await member(fx);
    const client = await connect(ctx);
    for (const kind of ['lay', 'author'] as const) {
      const plan = await newPlan(ctx, fx, `Live ${kind}`);
      await plansService.recordPlanStep(
        plan.id,
        { sessionKey: `session-${kind}`, kind, targetRef: null },
        ctx,
      );
      const added = await call(client, 'add_plan_items', {
        planId: plan.id,
        proposals: [
          {
            op: 'add',
            proposedFields: { title: 'Session add', kind: 'task', descriptionMd: WRITTEN },
          },
        ],
      });
      expect(added.isError, textOf(added)).toBeFalsy();
      const [row] = await adminDb.planItem.findMany({ where: { planId: plan.id } });
      expect(row!.proposedFields as Record<string, unknown>).not.toHaveProperty('authorFinished');

      const deepId = await addOne(ctx, plan.id, { title: 'Session deepen' });
      const deepened = await call(client, 'update_plan_item', {
        planId: plan.id,
        planItemId: deepId,
        descriptionMd: WRITTEN,
      });
      expect(deepened.isError, textOf(deepened)).toBeFalsy();
      expect(await fieldsOf(deepId)).not.toHaveProperty('authorFinished');
    }
    await client.close();
  });

  it('a write naming authorFinished — null included — is never stamped; a later unnamed write keeps a set state', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx.ctx, fx);
    const itemId = await addOne(fx.ctx, plan.id, { title: 'Declined' });

    await plansService.deepenProposal(
      plan.id,
      itemId,
      { descriptionMd: WRITTEN, authorFinished: null },
      fx.ctx,
    );
    expect(await fieldsOf(itemId)).toHaveProperty('authorFinished', null);
    await plansService.correctProposal(
      plan.id,
      itemId,
      { descriptionMd: `${WRITTEN}\n\nMore.`, authorFinished: null },
      fx.ctx,
    );
    expect(await fieldsOf(itemId)).toHaveProperty('authorFinished', null);

    // Set, then shortened to its boundary by a write naming no state: kept.
    await plansService.deepenProposal(plan.id, itemId, { authorFinished: true }, fx.ctx);
    await plansService.deepenProposal(plan.id, itemId, { descriptionMd: BOUNDARY }, fx.ctx);
    expect((await fieldsOf(itemId))['authorFinished']).toBe(true);
  });

  it('a refused write leaves the body and the state exactly as they were', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx.ctx, fx);
    const itemId = await addOne(fx.ctx, plan.id, { title: 'Guarded', type: 'code' });
    const before = await fieldsOf(itemId);

    await expect(
      plansService.deepenProposal(
        plan.id,
        itemId,
        { sections: { framing: 'Why.', notASection: 'x' } as never },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
    await expect(
      plansService.deepenProposal(
        plan.id,
        itemId,
        { descriptionMd: WRITTEN, difficulty: 'impossible' as never },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
    expect(await fieldsOf(itemId)).toEqual(before);
  });
});

describe('the state stays on the plan', () => {
  it('get_plan returns it, the review shows no card change, and approve carries no trace of it', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await newPlan(fx.ctx, fx);
    const stamped = await addOne(fx.ctx, plan.id, {
      title: 'Stamped',
      descriptionMd: WRITTEN,
      type: 'code',
      executor: 'coding_agent',
      storyPoints: 2,
      estimateMinutes: 30,
    });
    const plain = await addOne(fx.ctx, plan.id, {
      title: 'Plain',
      descriptionMd: WRITTEN,
      type: 'code',
      executor: 'coding_agent',
      storyPoints: 2,
      estimateMinutes: 30,
    });
    await plansService.deepenProposal(plan.id, plain, { authorFinished: null }, fx.ctx);
    expect((await fieldsOf(stamped))['authorFinished']).toBe(true);
    expect(await fieldsOf(plain)).toHaveProperty('authorFinished', null);

    // `get_plan` reads `proposedFields` through `toPlanItemDto`, so a fresh read
    // gives the same answer.
    const read = await plansService.getPlan(plan.id, fx.ctx);
    const dto = read.items.find((i) => i.id === stamped)!;
    expect(dto.proposedFields).toMatchObject({ authorFinished: true });

    await plansService.markPlanned(plan.id, fx.ctx);
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const reviewed = review.items.filter((i) => i.title === 'Stamped' || i.title === 'Plain');
    expect(reviewed).toHaveLength(2);
    // The review reports the WRITTEN STATE read-only (MOTIR-10496) — the run
    // context reads it there — and never as a change to the card: no change row,
    // no field a reviewer decides on.
    expect(reviewed.map((i) => [i.title, i.authorFinished])).toEqual(
      expect.arrayContaining([
        ['Stamped', true],
        ['Plain', false],
      ]),
    );
    for (const item of reviewed) {
      const { authorFinished: _state, ...card } = item;
      expect(JSON.stringify(card)).not.toContain('authorFinished');
    }
    const strip = (i: (typeof reviewed)[number]) => {
      const { id: _id, title: _title, ...rest } = i as unknown as Record<string, unknown>;
      return Object.keys(rest).sort();
    };
    expect(strip(reviewed[0]!)).toEqual(strip(reviewed[1]!));

    await plansService.approvePlan(plan.id, fx.ctx);
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Stamped' },
    });
    expect(JSON.stringify(created)).not.toContain('authorFinished');
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: created.id },
    });
    expect(revisions.length).toBeGreaterThan(0);
    expect(JSON.stringify(revisions)).not.toContain('authorFinished');
    const trail = await adminDb.planRevision.findMany({ where: { planId: plan.id } });
    expect(JSON.stringify(trail.map((r) => r.diff))).not.toContain('authorFinished');
  });
});
