import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { foldersService } from '@/lib/services/foldersService';
import { plansService } from '@/lib/services/plansService';
import { triageService } from '@/lib/services/triageService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanGrammarError } from '@/lib/plans/errors';
import { WorkItemInTriageError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';

// Bug MOTIR-11339 — a card still in TRIAGE takes no place in the planned tree.
//
// MOTIR-10560 was a triage submission that got filed into the To do folder, then
// planned into a story with nine subtasks, all while `triagedAt` was still set —
// so it and its whole subtree stayed off the canvas and every list until somebody
// pressed Accept. Every door below accepted that write on origin/main; each test
// drives the door with a triaged card (refused, the card unchanged) and then the
// SAME card after Accept in Triage (allowed, exactly as before).
//
// Real Postgres, the triage intake through `createWorkItem({ triage })`, and the
// Accept through `triageService` — no marker is hand-stamped except where a case
// needs a shape no tenant can reach any more (a plan closed before the card was a
// submission), and those cases say so.

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
  spyOnJobDispatch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Kind = 'epic' | 'story' | 'task' | 'bug' | 'subtask';

/** A triage submission, through the real intake path. */
async function submission(fx: WorkItemFixture, kind: 'bug' | 'task' = 'task', title = 'Inbox') {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, triage: { submittedByUserId: fx.ctx.userId } },
    fx.ctx,
  );
}

async function planned(fx: WorkItemFixture, kind: Kind, title: string, parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

function folder(fx: WorkItemFixture, name = 'To do') {
  return foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name },
    fx.ctx,
  );
}

function accept(fx: WorkItemFixture, id: string) {
  return triageService.acceptTriageItem(id, {}, fx.ctx);
}

function placement(id: string) {
  return adminDb.workItem.findUniqueOrThrow({
    where: { id },
    select: { folderId: true, parentId: true, position: true, kind: true, title: true },
  });
}

function childCount(parentId: string) {
  return adminDb.workItem.count({ where: { parentId } });
}

async function refusal(p: Promise<unknown>): Promise<WorkItemInTriageError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WorkItemInTriageError);
  return err as WorkItemInTriageError;
}

describe('filing a triaged card into a folder', () => {
  it('fileWorkItem refuses it with WORK_ITEM_IN_TRIAGE, unchanged, and files it once accepted', async () => {
    const fx = await makeWorkItemFixture();
    const todo = await folder(fx);
    const card = await submission(fx);
    const before = await placement(card.id);

    const err = await refusal(foldersService.fileWorkItem(card.id, { folderId: todo.id }, fx.ctx));
    expect(err.code).toBe('WORK_ITEM_IN_TRIAGE');
    expect(err.role).toBe('item');
    expect(err.key).toBe(card.identifier);
    expect(err.message).toContain('Accept it in Triage first');
    expect(await placement(card.id)).toEqual(before);

    await accept(fx, card.id);
    await foldersService.fileWorkItem(card.id, { folderId: todo.id }, fx.ctx);
    expect((await placement(card.id)).folderId).toBe(todo.id);
  });

  it('updateWorkItem({ folderId }) refuses it the same way, and writes the folder once accepted', async () => {
    const fx = await makeWorkItemFixture();
    const todo = await folder(fx);
    const card = await submission(fx);
    const before = await placement(card.id);

    await refusal(
      workItemsService.updateWorkItem(card.id, { folderId: todo.id, title: 'Renamed' }, fx.ctx),
    );
    // The whole patch is refused — the title beside the folder did not land either.
    expect(await placement(card.id)).toEqual(before);

    await accept(fx, card.id);
    await workItemsService.updateWorkItem(card.id, { folderId: todo.id }, fx.ctx);
    expect((await placement(card.id)).folderId).toBe(todo.id);
  });

  it('still lets a triaged card be taken OUT of a folder — that moves it away from the tree', async () => {
    const fx = await makeWorkItemFixture();
    const todo = await folder(fx);
    // A triaged card that is ALREADY filed — the shape this bug left behind, which
    // no door can produce any more, so the marker is stamped by hand.
    const card = await planned(fx, 'task', 'Filed before the fix');
    await foldersService.fileWorkItem(card.id, { folderId: todo.id }, fx.ctx);
    await adminDb.workItem.update({ where: { id: card.id }, data: { triagedAt: new Date() } });

    await foldersService.fileWorkItem(card.id, { folderId: null }, fx.ctx);
    expect((await placement(card.id)).folderId).toBeNull();
  });
});

describe('re-parenting a triaged card, and placing a card under one', () => {
  it('lets a triaged card be re-kinded beneath the parent it already has — that places nothing', async () => {
    const fx = await makeWorkItemFixture();
    // A triaged card already under a parent: the shape this bug left behind,
    // stamped by hand because no door can produce it any more.
    const story = await planned(fx, 'story', 'A planned story');
    const card = await planned(fx, 'task', 'Placed before the fix', story.id);
    await adminDb.workItem.update({ where: { id: card.id }, data: { triagedAt: new Date() } });

    await workItemsService.updateWorkItem(card.id, { kind: 'bug' }, fx.ctx);
    expect(await placement(card.id)).toMatchObject({ kind: 'bug', parentId: story.id });
  });

  it('updateWorkItem({ parentId }) refuses a triaged card under a story, then allows it after Accept', async () => {
    const fx = await makeWorkItemFixture();
    const story = await planned(fx, 'story', 'A planned story');
    const card = await submission(fx);
    const before = await placement(card.id);

    const err = await refusal(
      workItemsService.updateWorkItem(card.id, { parentId: story.id }, fx.ctx),
    );
    expect(err.role).toBe('item');
    expect(await placement(card.id)).toEqual(before);

    await accept(fx, card.id);
    await workItemsService.updateWorkItem(card.id, { parentId: story.id }, fx.ctx);
    expect((await placement(card.id)).parentId).toBe(story.id);
  });

  it('moveWorkItem refuses a triaged card under a story, then allows it after Accept', async () => {
    const fx = await makeWorkItemFixture();
    const story = await planned(fx, 'story', 'A planned story');
    const card = await submission(fx);

    await refusal(workItemsService.moveWorkItem(card.id, { newParentId: story.id }, fx.ctx));
    expect((await placement(card.id)).parentId).toBeNull();

    await accept(fx, card.id);
    await workItemsService.moveWorkItem(card.id, { newParentId: story.id }, fx.ctx);
    expect((await placement(card.id)).parentId).toBe(story.id);
  });

  it('refuses moving a planned card UNDER a triaged one, by both re-parent doors, until Accept', async () => {
    const fx = await makeWorkItemFixture();
    const inbox = await submission(fx, 'task', 'Inbox task');
    const sub = await planned(
      fx,
      'subtask',
      'A planned subtask',
      (await planned(fx, 'task', 'Home')).id,
    );
    const before = await placement(sub.id);

    const viaMove = await refusal(
      workItemsService.moveWorkItem(sub.id, { newParentId: inbox.id }, fx.ctx),
    );
    expect(viaMove.role).toBe('parent');
    expect(viaMove.key).toBe(inbox.identifier);
    const viaPatch = await refusal(
      workItemsService.updateWorkItem(sub.id, { parentId: inbox.id }, fx.ctx),
    );
    expect(viaPatch.role).toBe('parent');
    expect(await placement(sub.id)).toEqual(before);
    expect(await childCount(inbox.id)).toBe(0);

    await accept(fx, inbox.id);
    await workItemsService.moveWorkItem(sub.id, { newParentId: inbox.id }, fx.ctx);
    expect((await placement(sub.id)).parentId).toBe(inbox.id);
  });

  it('createWorkItem refuses a child under a triaged card, creating nothing, until Accept', async () => {
    const fx = await makeWorkItemFixture();
    const inbox = await submission(fx, 'task', 'Inbox task');
    const before = await adminDb.workItem.count();

    const err = await refusal(planned(fx, 'subtask', 'A child', inbox.id));
    expect(err.role).toBe('parent');
    expect(err.message).toContain(`${inbox.identifier} is still in Triage`);
    expect(await adminDb.workItem.count()).toBe(before);

    await accept(fx, inbox.id);
    const child = await planned(fx, 'subtask', 'A child', inbox.id);
    expect(child.parentId).toBe(inbox.id);
  });
});

/** Connect an in-memory MCP client to a server bound to `ctx`. */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('the MCP and /api/v1 doors', () => {
  it('MCP move_to_parent { folderId } answers a typed WORK_ITEM_IN_TRIAGE, then files it after Accept', async () => {
    const fx = await makeWorkItemFixture();
    const todo = await folder(fx);
    const card = await submission(fx);
    const client = await connectClient(fx.ctx);

    const refused = await client.callTool({
      name: 'move_to_parent',
      arguments: { key: card.identifier, folderId: todo.id },
    });
    expect(refused.isError).toBe(true);
    const text = (refused.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/^WORK_ITEM_IN_TRIAGE: /);
    expect(text).toContain('Accept it in Triage first');
    expect((await placement(card.id)).folderId).toBeNull();

    await accept(fx, card.id);
    const filed = await client.callTool({
      name: 'move_to_parent',
      arguments: { key: card.identifier, folderId: todo.id },
    });
    expect(filed.isError).toBeFalsy();
    expect((await placement(card.id)).folderId).toBe(todo.id);
  });

  it('MCP create_work_item under a triaged parent answers WORK_ITEM_IN_TRIAGE', async () => {
    const fx = await makeWorkItemFixture();
    const inbox = await submission(fx, 'task', 'Inbox task');
    const client = await connectClient(fx.ctx);

    const refused = await client.callTool({
      name: 'create_work_item',
      arguments: {
        projectKey: fx.projectIdentifier,
        kind: 'subtask',
        title: 'A child',
        parentKey: inbox.identifier,
      },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toMatch(/^WORK_ITEM_IN_TRIAGE: /);
    expect(await childCount(inbox.id)).toBe(0);
  });

  it('PATCH /api/v1/work-items/{key} { folderId } answers 409 WORK_ITEM_IN_TRIAGE, then 200 after Accept', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const fx = caller.fixture;
    const todo = await folder(fx);
    const card = await submission(fx);
    const { PATCH } = await import('@/app/api/v1/work-items/[key]/route');
    const send = () =>
      PATCH(
        new Request(`http://localhost:3000/api/v1/work-items/${card.identifier}`, {
          method: 'PATCH',
          headers: { ...caller.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ folderId: todo.id }),
        }),
        { params: Promise.resolve({ key: card.identifier }) },
      );

    const refused = await send();
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ code: 'WORK_ITEM_IN_TRIAGE' });
    expect((await placement(card.id)).folderId).toBeNull();

    await accept(fx, card.id);
    const ok = await send();
    expect(ok.status).toBe(200);
    expect((await placement(card.id)).folderId).toBe(todo.id);
  });
});

describe('plans — the append, validate_plan and approve', () => {
  async function openPlan(fx: WorkItemFixture) {
    return plansService.createPlan(fx.projectId, { title: 'Proposed' }, fx.ctx);
  }

  async function refusedAppend(p: Promise<unknown>): Promise<PlanGrammarError> {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('target_in_triage');
    return err as PlanGrammarError;
  }

  it('refuses at the APPEND a modify of a triaged card and an add under one, writing nothing', async () => {
    const fx = await makeWorkItemFixture();
    const inbox = await submission(fx, 'task', 'Inbox task');
    const plan = await openPlan(fx);

    await refusedAppend(
      plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: inbox.id, patch: { kind: 'story' } }],
        fx.ctx,
      ),
    );
    await refusedAppend(
      plansService.addProposals(
        plan.id,
        [{ op: 'add', parentRef: inbox.id, proposedFields: { kind: 'subtask', title: 'Child' } }],
        fx.ctx,
      ),
    );
    // …and a re-parent of a planned card under it.
    const home = await planned(fx, 'subtask', 'Movable', (await planned(fx, 'task', 'Home')).id);
    await refusedAppend(
      plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: home.id, patch: { parentRef: inbox.id } }],
        fx.ctx,
      ),
    );
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
    // The refused modify did not park the card at Planning either.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: inbox.id } })).status).toBe(
      inbox.status,
    );

    // A proposal naming no live card reads nothing and is never refused here.
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: null, proposedFields: { kind: 'epic', title: 'Elsewhere' } }],
      fx.ctx,
    );

    await accept(fx, inbox.id);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: inbox.id, patch: { kind: 'story' } },
        { op: 'add', parentRef: inbox.id, proposedFields: { kind: 'subtask', title: 'Child' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);
    expect(await childCount(inbox.id)).toBe(1);
    expect((await placement(inbox.id)).kind).toBe('story');
  });

  it('refuses a correction that moves an add under a triaged card', async () => {
    const fx = await makeWorkItemFixture();
    const home = await planned(fx, 'task', 'Home');
    const inbox = await submission(fx, 'task', 'Inbox task');
    const plan = await openPlan(fx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: home.id, proposedFields: { kind: 'subtask', title: 'Child' } }],
      fx.ctx,
    );
    const [itemId] = appended.appendedItemIds;

    await refusedAppend(
      plansService.correctProposal(plan.id, itemId!, { parentRef: inbox.id }, fx.ctx),
    );
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId! } });
    expect(row.parentRef).toBe(home.id);
  });

  it('reports it through validate_plan and refuses approve with no write, for a plan closed before the card entered triage', async () => {
    const fx = await makeWorkItemFixture();
    const card = await planned(fx, 'task', 'Becomes a submission');
    const plan = await openPlan(fx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: card.id, proposedFields: { kind: 'subtask', title: 'Child' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    // FIXTURE SURGERY: no door sets the marker after creation, so a plan that the
    // close admitted can only meet a triaged parent this way. It is what makes
    // the approve gate's re-check observable on its own.
    await adminDb.workItem.update({ where: { id: card.id }, data: { triagedAt: new Date() } });

    const rejections = await plansService.checkApprovability(plan.id, fx.ctx);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      code: 'PLAN_GRAMMAR_VIOLATION',
      reason: 'target_in_triage',
    });

    const before = await adminDb.workItem.count();
    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toBeInstanceOf(
      PlanGrammarError,
    );
    expect(await adminDb.workItem.count()).toBe(before);
    expect(await childCount(card.id)).toBe(0);

    await accept(fx, card.id);
    expect(await plansService.checkApprovability(plan.id, fx.ctx)).toEqual([]);
    await plansService.approvePlan(plan.id, fx.ctx);
    expect(await childCount(card.id)).toBe(1);
  });
});
