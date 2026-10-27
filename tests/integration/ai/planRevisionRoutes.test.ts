import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary this
// test cannot and must not reach. Everything below it is real: a real Postgres,
// the real `plansService` transactions, the real routes, real job-token auth.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import {
  CORRECT_PROPOSAL_KEYS,
  UPDATE_PROPOSAL_KEYS,
  type CorrectProposalKey,
  type UpdateProposalKey,
} from '@/lib/dto/plans';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import {
  GET as proposalsGET,
  POST as proposalsPOST,
} from '@/app/api/internal/ai/plan-proposals/route';
import {
  PATCH as itemPATCH,
  DELETE as itemDELETE,
} from '@/app/api/internal/ai/plan-proposals/[itemId]/route';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../../fixtures';
import { TODO_TEXT_MAX_LENGTH } from '@/lib/workItemTodos/limits';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-3595 · Subtask MOTIR-3598 — the JOB-TOKEN door onto
// `plansService.correctProposal` / `.withdrawProposal`, through the REAL routes.
//
// The service-level half lives in `tests/integration/plans/revisionLease.test.ts`;
// what is here is what only the transport can be wrong about: the explicit
// `mode` discriminator, the DELETE verb, and — the card's own criterion — that
// the service's frozen-status refusal arrives as a TYPED client-visible status
// rather than as a 500.

const SERVICE_SECRET = 'core-callback-secret-test';
const AGENT = { source: null, harness: 'Motir AI', model: 'claude-opus-5' };

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  vi.clearAllMocks();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function tokenFor(fx: WorkItemFixture): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

function patch(fx: WorkItemFixture, itemId: string, body: unknown): Promise<Response> {
  const req = new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
    body: JSON.stringify(body),
  });
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return itemPATCH(req, { params: Promise.resolve({ itemId }) });
}

function del(fx: WorkItemFixture, itemId: string, jobId: string): Promise<Response> {
  const req = new Request(
    `http://core/api/internal/ai/plan-proposals/${itemId}?jobId=${encodeURIComponent(jobId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${SERVICE_SECRET}` } },
  );
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return itemDELETE(req, { params: Promise.resolve({ itemId }) });
}

function append(fx: WorkItemFixture, body: unknown): Promise<Response> {
  const req = new Request('http://core/api/internal/ai/plan-proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
    body: JSON.stringify(body),
  });
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return proposalsPOST(req);
}

/** A `planned` plan bound to `jobId`, carrying two `add`s appended separately so
 *  both ids are refable. */
async function plannedPlan(fx: WorkItemFixture, jobId: string) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const first = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The prerequisite', kind: 'story' } }],
    fx.ctx,
  );
  const second = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The dependent', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return { planId: plan.id, firstId: first.items[0]!.id, secondId: second.items[1]!.id };
}

/** The `generating` twin of {@link plannedPlan} — the status the DEEPEN mode
 *  gates on, so a key can be asserted on BOTH modes rather than only the one
 *  that happened to be under test. */
async function generatingPlan(fx: WorkItemFixture, jobId: string) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Still generating', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A skeleton card', kind: 'subtask' } }],
    fx.ctx,
  );
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

// ── MOTIR-4619 ─────────────────────────────────────────────────────────────────
// The card's ORDERED STEPS through the INTERNAL routes — the door Motir's own
// planner writes through. Every parser here picks its keys by NAME, so the
// question is not whether the call succeeds (it always did) but whether the
// field ARRIVES.
describe('the internal routes carry `todos` (MOTIR-4619)', () => {
  it('the APPEND route passes `proposedFields.todos` through to the proposal', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Appended with steps', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-todos' } });

    const res = await append(fx, {
      jobId: 'job-todos',
      proposals: [
        {
          op: 'add',
          proposedFields: {
            title: 'Provision the account',
            kind: 'task',
            type: 'manual',
            todos: [{ text: 'Create the account' }, { text: 'Invite the team', executor: 'human' }],
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    const stored = await adminDb.planItem.findFirstOrThrow({ where: { planId: plan.id } });
    const pf = stored.proposedFields as { todos?: Array<{ text: string }> };
    expect(pf.todos?.map((t) => t.text)).toEqual(['Create the account', 'Invite the team']);
  });

  it('the DEEPEN mode carries `todos`, and `null` clears it', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await generatingPlan(fx, 'job-deepen-todos');

    const set = await patch(fx, itemId, {
      jobId: 'job-deepen-todos',
      patch: { type: 'manual', todos: [{ text: 'The one operation' }] },
    });
    expect(set.status).toBe(200);
    const afterSet = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect((afterSet.proposedFields as { todos?: unknown[] }).todos).toHaveLength(1);

    const cleared = await patch(fx, itemId, {
      jobId: 'job-deepen-todos',
      patch: { todos: null },
    });
    expect(cleared.status).toBe(200);
    const afterClear = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect((afterClear.proposedFields as { todos?: unknown }).todos).toBeNull();
  });

  it('the CORRECT mode carries `todos` on a plan that has already closed', async () => {
    const fx = await makeWorkItemFixture();
    const { secondId } = await plannedPlan(fx, 'job-correct-todos');

    const res = await patch(fx, secondId, {
      jobId: 'job-correct-todos',
      mode: 'correct',
      patch: { todos: [{ text: 'The corrected step', executor: 'coding_agent' }] },
    });

    expect(res.status).toBe(200);
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } });
    expect((row.proposedFields as { todos?: Array<{ text: string }> }).todos).toEqual([
      { text: 'The corrected step', executor: 'coding_agent' },
    ]);
  });

  it('answers 422 PROPOSALS_INVALID for a step past the bar, on BOTH modes', async () => {
    const fx = await makeWorkItemFixture();
    const over = 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1);

    const { itemId } = await generatingPlan(fx, 'job-bad-deepen');
    const deepen = await patch(fx, itemId, {
      jobId: 'job-bad-deepen',
      patch: { todos: [{ text: over }] },
    });
    expect(deepen.status).toBe(422);
    expect((await deepen.json()).code).toBe('INVALID_PROPOSAL');

    const { secondId } = await plannedPlan(fx, 'job-bad-correct');
    const correct = await patch(fx, secondId, {
      jobId: 'job-bad-correct',
      mode: 'correct',
      patch: { todos: [{ text: over }] },
    });
    expect(correct.status).toBe(422);
  });
});

// ── MOTIR-6136 ─────────────────────────────────────────────────────────────────
// A leaf's DIFFICULTY through the INTERNAL routes — the doors motir-ai's hosted
// planner writes through (MOTIR-6139 sends it). The wire: `proposedFields.difficulty`
// on the append, `patch.difficulty` on the deepen / correct content bag, and
// `modifyPatch.difficulty` for a `modify`. Present → set, `null` → clear, absent →
// untouched; a container answers 422 `INVALID_PROPOSAL`.
describe('the internal routes carry `difficulty` (MOTIR-6136)', () => {
  it('the APPEND route passes `proposedFields.difficulty` through to the proposal', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Appended with a difficulty', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-diff-add' } });

    const res = await append(fx, {
      jobId: 'job-diff-add',
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'A tricky leaf', kind: 'subtask', difficulty: 'high' },
        },
      ],
    });
    expect(res.status).toBe(200);
    const stored = await adminDb.planItem.findFirstOrThrow({ where: { planId: plan.id } });
    expect(stored.proposedFields).toMatchObject({ difficulty: 'high' });
  });

  it('the DEEPEN mode SETS `patch.difficulty`, an absent key leaves it, and `null` clears it', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await generatingPlan(fx, 'job-diff-deepen');
    const read = async () =>
      (
        (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).proposedFields as {
          difficulty?: string | null;
        }
      ).difficulty;

    const set = await patch(fx, itemId, {
      jobId: 'job-diff-deepen',
      patch: { difficulty: 'trivial' },
    });
    expect(set.status).toBe(200);
    expect(await read()).toBe('trivial');

    const untouched = await patch(fx, itemId, {
      jobId: 'job-diff-deepen',
      patch: { descriptionMd: 'The body.' },
    });
    expect(untouched.status).toBe(200);
    expect(await read()).toBe('trivial');

    const cleared = await patch(fx, itemId, {
      jobId: 'job-diff-deepen',
      patch: { difficulty: null },
    });
    expect(cleared.status).toBe(200);
    expect(await read()).toBeNull();
  });

  it('the CORRECT mode sets it, and a `modify` carries it on `modifyPatch`', async () => {
    const fx = await makeWorkItemFixture();
    const { secondId } = await plannedPlan(fx, 'job-diff-correct');
    const res = await patch(fx, secondId, {
      jobId: 'job-diff-correct',
      mode: 'correct',
      patch: { difficulty: 'medium' },
    });
    expect(res.status).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } })).proposedFields,
    ).toMatchObject({ difficulty: 'medium' });

    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'A modify', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const leaf = await createTestWorkItem(fx, { kind: 'task', title: 'A committed leaf' });
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: leaf.id, patch: { priority: 'low' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-diff-mod' } });
    const modifyId = appended.items[0]!.id;
    const mod = await patch(fx, modifyId, {
      jobId: 'job-diff-mod',
      mode: 'correct',
      modifyPatch: { difficulty: 'low' },
    });
    expect(mod.status).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } })).patch,
    ).toMatchObject({ difficulty: 'low' });
  });

  it('a difficulty on a CONTAINER is a typed 422 INVALID_PROPOSAL naming the field, on BOTH modes', async () => {
    const fx = await makeWorkItemFixture();

    const { itemId } = await generatingPlan(fx, 'job-diff-bad-deepen');
    const deepen = await patch(fx, itemId, {
      jobId: 'job-diff-bad-deepen',
      patch: { kind: 'story', difficulty: 'low' },
    });
    expect(deepen.status).toBe(422);
    const deepenBody = (await deepen.json()) as { code: string; error: string };
    expect(deepenBody.code).toBe('INVALID_PROPOSAL');
    expect(deepenBody.error).toContain('difficulty');

    // `firstId` is a `story` — the correction is judged on the merged kind.
    const { firstId } = await plannedPlan(fx, 'job-diff-bad-correct');
    const correct = await patch(fx, firstId, {
      jobId: 'job-diff-bad-correct',
      mode: 'correct',
      patch: { difficulty: 'high' },
    });
    expect(correct.status).toBe(422);
    expect(((await correct.json()) as { code: string }).code).toBe('INVALID_PROPOSAL');
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: firstId } });
    expect((stored.proposedFields as { difficulty?: unknown }).difficulty ?? null).toBeNull();
  });
});

// ── MOTIR-6631 ─────────────────────────────────────────────────────────────────
// The obsolescence MARK, its note and the `supersedes` edges through the INTERNAL
// routes motir-ai writes through. The append passes `ProposalInput` whole and the
// correction passes `modifyPatch` whole, so the six patch keys ride without a
// parser change; `supersedesRefs` on a correction is read by `correctionFrom`.
// This seam resolves NO keys — refs are ids or `planItem:` refs — and every
// refusal is the service's, answered as a typed 422.
describe('the internal routes carry the mark and its supersedes edges (MOTIR-6631)', () => {
  async function doneLeaf(fx: WorkItemFixture, title: string) {
    const leaf = await createTestWorkItem(fx, { kind: 'task', title });
    await adminDb.workItem.update({ where: { id: leaf.id }, data: { status: 'done' } });
    return leaf;
  }

  async function jobPlan(fx: WorkItemFixture, jobId: string) {
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Marks a card', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
    return plan.id;
  }

  it('the APPEND route carries an `add`’s `supersedesRefs` and a mark-only `modify` of a DONE card', async () => {
    const fx = await makeWorkItemFixture();
    const old = await doneLeaf(fx, 'The old contract');
    const planId = await jobPlan(fx, 'job-mark-append');

    const first = await append(fx, {
      jobId: 'job-mark-append',
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'The new contract', kind: 'task' },
          supersedesRefs: [old.id],
        },
      ],
    });
    expect(first.status).toBe(200);
    const addId = ((await first.json()) as { planItemIds: string[] }).planItemIds[0]!;

    const second = await append(fx, {
      jobId: 'job-mark-append',
      proposals: [
        {
          op: 'modify',
          workItemId: old.id,
          patch: {
            obsolescence: 'outdated',
            obsolescenceNoteMd: 'Replaced by the new contract.',
            supersededByAdd: [`planItem:${addId}`],
          },
        },
      ],
    });
    expect(second.status).toBe(200);

    const rows = await adminDb.planItem.findMany({
      where: { planId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows[0]!.supersedesRefs).toEqual([old.id]);
    expect(rows[1]!.patch).toEqual({
      obsolescence: 'outdated',
      obsolescenceNoteMd: 'Replaced by the new contract.',
      supersededByAdd: [`planItem:${addId}`],
    });
  });

  it('the APPEND route refuses a mark on an UNFINISHED card with the typed 422 pointing at `remove`', async () => {
    const fx = await makeWorkItemFixture();
    const open = await createTestWorkItem(fx, { kind: 'task', title: 'Still to do' });
    await jobPlan(fx, 'job-mark-open');

    const res = await append(fx, {
      jobId: 'job-mark-open',
      proposals: [{ op: 'modify', workItemId: open.id, patch: { obsolescence: 'deprecated' } }],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.error).toContain('a plan may mark only a finished work item');
    expect(body.error).toContain("op: 'remove'");
  });

  it('the APPEND route refuses `supersedesRefs` on a `modify`, naming the patch lists', async () => {
    const fx = await makeWorkItemFixture();
    const old = await doneLeaf(fx, 'Old');
    const other = await doneLeaf(fx, 'Other');
    await jobPlan(fx, 'job-mark-misplaced');

    const res = await append(fx, {
      jobId: 'job-mark-misplaced',
      proposals: [
        {
          op: 'modify',
          workItemId: old.id,
          patch: { obsolescence: 'outdated' },
          supersedesRefs: [other.id],
        },
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.error).toContain('supersededByAdd');
  });

  it('the CORRECT mode replaces an `add`’s `supersedesRefs` and a `modify`’s mark on `modifyPatch`', async () => {
    const fx = await makeWorkItemFixture();
    const old = await doneLeaf(fx, 'Old');
    const newer = await doneLeaf(fx, 'Newer');
    const planId = await jobPlan(fx, 'job-mark-correct');
    const appended = await plansService.addProposals(
      planId,
      [
        { op: 'add', proposedFields: { title: 'Replacement', kind: 'task' } },
        { op: 'modify', workItemId: old.id, patch: { obsolescence: 'outdated' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    const [addId, modifyId] = appended.appendedItemIds as [string, string];

    const onAdd = await patch(fx, addId, {
      jobId: 'job-mark-correct',
      mode: 'correct',
      supersedesRefs: [old.id],
    });
    expect(onAdd.status).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: addId } })).supersedesRefs,
    ).toEqual([old.id]);

    const onModify = await patch(fx, modifyId, {
      jobId: 'job-mark-correct',
      mode: 'correct',
      modifyPatch: {
        obsolescence: 'deprecated',
        obsolescenceNoteMd: 'Overturned.',
        supersededByAdd: [newer.id],
      },
    });
    expect(onModify.status).toBe(200);
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } })).patch).toEqual({
      obsolescence: 'deprecated',
      obsolescenceNoteMd: 'Overturned.',
      supersededByAdd: [newer.id],
    });

    // `supersedesRefs` is an `add`'s column: on the `modify` it is refused.
    const misplaced = await patch(fx, modifyId, {
      jobId: 'job-mark-correct',
      mode: 'correct',
      supersedesRefs: [newer.id],
    });
    expect(misplaced.status).toBe(422);
    expect(((await misplaced.json()) as { code: string }).code).toBe('INVALID_PROPOSAL');
  });

  it('a supersedes CYCLE through the correction is a typed 422 INVALID_PLAN_REF_GRAPH', async () => {
    const fx = await makeWorkItemFixture();
    const old = await doneLeaf(fx, 'Old');
    const planId = await jobPlan(fx, 'job-mark-cycle');
    const appended = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Replacement', kind: 'task' },
          supersedesRefs: [old.id],
        },
      ],
      fx.ctx,
    );
    const second = await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: old.id,
          patch: { obsolescence: 'outdated' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    const addId = appended.appendedItemIds[0]!;
    const modifyId = second.appendedItemIds[0]!;

    // The old card now claims to REPLACE the card that replaces it.
    const res = await patch(fx, modifyId, {
      jobId: 'job-mark-cycle',
      mode: 'correct',
      modifyPatch: { obsolescence: 'outdated', supersedesAdd: [`planItem:${addId}`] },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe('INVALID_PLAN_REF_GRAPH');
    expect(body.reason).toBe('cycle');
  });
});

describe('PATCH — `mode: "correct"` reaches the correction door', () => {
  it('carries the STRUCTURAL fields the deepen turn may not touch', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await plannedPlan(fx, 'job-1');
    // A same-level blocker for the moved task: its new parent is one level up
    // (MOTIR-6367 / 6411), so the peer is a sibling under that parent.
    const peer = (
      await plansService.addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: { title: 'A peer task', kind: 'task' },
            parentRef: `planItem:${firstId}`,
          },
        ],
        fx.ctx,
        { revision: true },
      )
    ).appendedItemIds[0]!;

    const res = await patch(fx, secondId, {
      jobId: 'job-1',
      mode: 'correct',
      parentRef: `planItem:${firstId}`,
      blockedByRefs: [`planItem:${peer}`],
      patch: { title: 'The dependent, renamed' },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } });
    expect(stored.parentRef).toBe(`planItem:${firstId}`);
    expect(stored.blockedByRefs).toEqual([`planItem:${peer}`]);
    // The CONTENT bag still rides `patch`, exactly as it does on the deepen path
    // — one key, one meaning, on both modes.
    expect((stored.proposedFields as { title?: string }).title).toBe('The dependent, renamed');
    expect(await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
      status: 'planned',
    });
  });

  it('WITHOUT the mode it is the DEEPEN route, byte-identical — and a `planned` plan is refused', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId } = await plannedPlan(fx, 'job-2');

    // The deepen gate is `generating`, and this plan is not. The mode is
    // EXPLICIT precisely so a body that happens to carry `parentRef` cannot
    // silently become a correction and slip past it.
    const res = await patch(fx, firstId, {
      jobId: 'job-2',
      parentRef: 'something',
      patch: { descriptionMd: 'Deepened' },
    });
    expect(res.status).toBe(409);
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: firstId } });
    expect(stored.parentRef).toBeNull();
  });

  it('a `modify`’s patch rides `modifyPatch`, which is a DIFFERENT thing from the content bag', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'With a modify', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const target = await createTestWorkItem(fx, { kind: 'story', title: 'A committed story' });
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-modify' } });
    const modifyId = appended.items[0]!.id;

    const res = await patch(fx, modifyId, {
      jobId: 'job-modify',
      mode: 'correct',
      modifyPatch: { priority: 'highest' },
    });
    expect(res.status).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } })).patch,
    ).toMatchObject({ priority: 'highest' });
  });

  it('a FROZEN plan is refused with a TYPED 409, never a 500', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId } = await plannedPlan(fx, 'job-3');
    await plansService.declinePlan(planId, fx.ctx);

    const res = await patch(fx, firstId, {
      jobId: 'job-3',
      mode: 'correct',
      patch: null,
      title: 'Too late',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PLAN_NOT_EDITABLE' });
  });

  it('an UNRESOLVABLE corrected ref is a typed 422', async () => {
    const fx = await makeWorkItemFixture();
    const { secondId } = await plannedPlan(fx, 'job-4');

    const res = await patch(fx, secondId, {
      jobId: 'job-4',
      mode: 'correct',
      blockedByRefs: ['planItem:nothing-at-all'],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'UNRESOLVED_PLAN_REF' });
  });

  // ── MOTIR-3865 · THE TRANSPORT PARITY GUARD ─────────────────────────────────
  //
  // ⚠️ THE FAILURE THIS ENDS IS SILENT AT EVERY LAYER. A key declared on
  // `UpdateProposalInput` / `CorrectProposalInput` that this route's parser never
  // picks off the body is dropped without a word: the request succeeds, the
  // response is a `200`, and the proposal simply keeps the value it had. That is
  // how `explanationMd` sat DECLARED-and-unread here while
  // `lib/mcp/tools/authorPlan.ts` — the door an EXTERNAL agent uses — parsed it,
  // so an outside MCP client could rewrite a landed plan's rationale and Motir's
  // own hosted planner could not.
  //
  // So the samples below are typed `satisfies Record<…Key, unknown>` — TOTAL over
  // the declared constant in both directions, checked by `tsc` — and asserted
  // total again at runtime. A field added to either input with no parser reaching
  // it fails HERE, in the pull request that adds it, rather than being discovered
  // months later by a re-plan that quietly under-delivered. (The compile-time half
  // — the constants against the INTERFACES — is in `lib/dto/plans.ts`; this is the
  // half that was missing, because the interfaces and the parser were each
  // internally consistent and had never been compared.)
  const CONTENT_SAMPLE = {
    title: 'The dependent, corrected',
    kind: 'task',
    descriptionMd: 'The corrected spec.',
    // `sections` is the OTHER way to say the body (Story MOTIR-9023 · MOTIR-9030):
    // rendered into `descriptionMd`, never stored, and refused beside it — so it
    // cannot ride in this sample, which sends `descriptionMd` and asserts it
    // stored. Its own transport test is below; the key-set assertions add it back.
    type: 'code',
    priority: 'high',
    storyPoints: 3,
    estimateMinutes: 45,
    // A leaf's DIFFICULTY (MOTIR-6133) — `kind: 'task'` above is a leaf, so the
    // container refusal does not fire and the transport is what is asserted.
    difficulty: 'high',
    explanationMd: 'The corrected WHY — the key this route never read.',
    executor: 'human',
    // The card's proposed STEPS (MOTIR-4616). Present here because the
    // compile-time half of the guard REQUIRES it — `UPDATE_PROPOSAL_KEYS` gained
    // `todos` with the interface, and this object `satisfies` that key set — and
    // because the runtime half is exactly the assertion this story owes: the
    // internal correction route's parser has to carry the key through into
    // `proposedFields`, which is the door MOTIR-4619 opens.
    todos: [{ text: 'Create the restricted API key', executor: 'human' }],
    // The language each text field above was written in (MOTIR-8743) — every
    // field it names is rewritten here, so the merge keeps all four keys.
    languages: { title: 'zh', description: 'zh', explanation: 'ko', todos: 'zh' },
  } satisfies Record<Exclude<UpdateProposalKey, 'sections'>, unknown>;

  /** Each STRUCTURAL key → where the correction lands it, or `null` for a key
   *  this test does not exercise (with the reason, by name). */
  const STRUCTURAL_LANDS_IN: Record<
    Exclude<CorrectProposalKey, UpdateProposalKey>,
    string | null
  > = {
    parentRef: 'planItem.parentRef',
    blockedByRefs: 'planItem.blockedByRefs',
    // The edges' REASONS (MOTIR-9827) — carried as `{ ref, reason }` entries of
    // `blockedByRefs` and split off by the service onto `planItem.edgeReasons`.
    edgeReasons: 'planItem.edgeReasons',
    // An `add`'s supersedes set (MOTIR-6630) lands in `planItem.supersedesRefs`;
    // `correctionFrom` carries it (MOTIR-6631), driven through the body below.
    supersedesRefs: 'planItem.supersedesRefs',
    targetRepo: 'proposedFields.targetRepo',
    // The SET spellings (bug MOTIR-4904) — the same landing place, one field
    // over, and the same transport: `correctionFrom` reads each when PRESENT.
    targetRepos: 'proposedFields.targetRepos',
    targetRepositories: 'proposedFields.targetRepositories',
    // The singular ROW-ID pin (Story MOTIR-2732 · MOTIR-3045, surfaced by
    // MOTIR-4924) — the same landing place and transport as the SET forms.
    targetRepositoryRef: 'proposedFields.targetRepositoryRef',
    targetRepoRole: 'proposedFields.targetRepoRole',
    // The SUBJECT coordinate (Story MOTIR-5062 · MOTIR-5065) — the same landing
    // place and the same transport as the role beside it, and structural for the
    // same reason: it is settled at the `lay`, so the deepen turn cannot reach it
    // and only a correction can.
    subject: 'proposedFields.subject',
    // `modify` ONLY, and mutually exclusive with an `add`'s content bag — the
    // service refuses the two together by design. Its own transport (the
    // `modifyPatch` rename) is asserted by the `a modify's patch rides
    // modifyPatch` test above.
    patch: null,
  };

  it('every key `UpdateProposalInput` declares SURVIVES from the request body into the proposal (MOTIR-3865)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await plannedPlan(fx, 'job-keys');
    // A same-level blocker (MOTIR-6367 / 6411): the corrected TASK moves under the
    // story prerequisite, so its blocker is a sibling under that parent.
    const peer = (
      await plansService.addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: { title: 'A peer task', kind: 'task' },
            parentRef: `planItem:${firstId}`,
          },
        ],
        fx.ctx,
        { revision: true },
      )
    ).appendedItemIds[0]!;
    expect([...Object.keys(CONTENT_SAMPLE), 'sections'].sort()).toEqual(
      [...UPDATE_PROPOSAL_KEYS].sort(),
    );
    expect(Object.keys(STRUCTURAL_LANDS_IN).sort()).toEqual(
      [...CORRECT_PROPOSAL_KEYS].filter((k) => !UPDATE_PROPOSAL_KEYS.includes(k as never)).sort(),
    );

    const res = await patch(fx, secondId, {
      jobId: 'job-keys',
      mode: 'correct',
      patch: CONTENT_SAMPLE,
      parentRef: `planItem:${firstId}`,
      blockedByRefs: [{ ref: `planItem:${peer}`, reason: 'consumes: the peer task' }],
      // The corrected card REPLACES the story prerequisite (MOTIR-6631) — any
      // kind may supersede any kind, and a supersedes edge orders nothing.
      supersedesRefs: [`planItem:${firstId}`],
      // A ROLE needs no repository to exist — the closed vocabulary is exactly
      // what makes it pinnable this early, and it is the pin an ONBOARDING plan
      // carries.
      targetRepoRole: 'api',
      // A well-formed member. Membership is NOT checked at either write boundary
      // in this repository — the vocabulary is the rule-pack file set — so what
      // this asserts is the TRANSPORT: the key survives the parser into
      // `proposedFields`, which is the whole point of this guard.
      subject: 'jobs',
    });
    expect(res.status).toBe(200);

    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } });
    expect(stored.proposedFields).toMatchObject({
      ...CONTENT_SAMPLE,
      targetRepoRole: 'api',
      subject: 'jobs',
    });
    expect(stored.parentRef).toBe(`planItem:${firstId}`);
    expect(stored.blockedByRefs).toEqual([`planItem:${peer}`]);
    expect(stored.edgeReasons).toEqual({ [`planItem:${peer}`]: 'consumes: the peer task' });
    expect(stored.supersedesRefs).toEqual([`planItem:${firstId}`]);
  });

  // ── MOTIR-9030 · the `sections` key SURVIVES the parser, on both modes ───────
  //
  // Held apart from the key-sample above because `sections` and `descriptionMd`
  // may not ride together. What this asserts is the TRANSPORT: the parser picks
  // the key off the body and forwards it AS SENT, so the service — which owns
  // every rule — renders it, and a wrong-typed value is refused rather than
  // dropped.
  it('`sections` reaches the proposal on the deepen and the correct modes, rendered and never stored', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await generatingPlan(fx, 'job-sections');
    const sections = {
      framing: 'Why this card exists.',
      scopeBoundary: 'Stops at the renderer.',
      acceptanceCriteria: ['It renders.'],
      contextRefs: [{ ref: 'lib/a.ts', why: 'the module' }],
    };

    const deepened = await patch(fx, itemId, {
      jobId: 'job-sections',
      patch: { type: 'code', sections },
    });
    expect(deepened.status).toBe(200);
    const afterDeepen = (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } }))
      .proposedFields as Record<string, unknown>;
    expect(afterDeepen['descriptionMd']).toContain('## Scope BOUNDARY');
    expect(afterDeepen['descriptionMd']).toContain('It renders.');
    expect(afterDeepen).not.toHaveProperty('sections');

    // A SPARSE correction over the body just rendered — only the boundary changes.
    const corrected = await patch(fx, itemId, {
      jobId: 'job-sections',
      mode: 'correct',
      patch: { sections: { scopeBoundary: 'Stops at the parser.' } },
    });
    expect(corrected.status).toBe(200);
    const afterCorrect = (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } }))
      .proposedFields as Record<string, unknown>;
    expect(afterCorrect['descriptionMd']).toContain('Stops at the parser.');
    expect(afterCorrect['descriptionMd']).toContain('It renders.');
    expect(afterCorrect['descriptionMd']).not.toContain('Stops at the renderer.');
    expect(afterCorrect).not.toHaveProperty('sections');
  });

  it('a WRONG-TYPED `sections` and `sections` beside `descriptionMd` are typed 422s, never dropped', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await generatingPlan(fx, 'job-sections-bad');

    const wrongType = await patch(fx, itemId, {
      jobId: 'job-sections-bad',
      patch: { sections: 'a string' },
    });
    expect(wrongType.status).toBe(422);
    expect(await wrongType.json()).toMatchObject({ code: 'INVALID_PROPOSAL' });

    const both = await patch(fx, itemId, {
      jobId: 'job-sections-bad',
      patch: { descriptionMd: 'a body', sections: { framing: 'f' } },
    });
    expect(both.status).toBe(422);
    const message = ((await both.json()) as { error: string }).error;
    expect(message).toContain('`sections`');
    expect(message).toContain('`descriptionMd`');
  });

  it('`explanationMd` reaches the proposal on the DEEPEN mode too, not only on `correct`', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await generatingPlan(fx, 'job-deepen');

    // No `mode` — the generation-time deepen seam, which is where a titles-first
    // proposal gains its body. One parser serves both modes, so the key has to
    // land on both or the deepen turn keeps writing a description with no WHY.
    const res = await patch(fx, itemId, {
      jobId: 'job-deepen',
      patch: {
        descriptionMd: 'The body.',
        explanationMd: 'And the WHY beside it.',
        type: 'code',
        executor: 'coding_agent',
      },
    });
    expect(res.status).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).proposedFields,
    ).toMatchObject({
      descriptionMd: 'The body.',
      explanationMd: 'And the WHY beside it.',
      type: 'code',
      executor: 'coding_agent',
    });
  });

  it('`targetRepoRole` is SPARSE — an explicit `null` unpins, an absent key leaves the pin alone', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Pinned', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const appended = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Pinned to a role', kind: 'task', targetRepoRole: 'web' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-role' } });
    const itemId = appended.items[0]!.id;

    // ABSENT — a correction that touches something else must not disturb the pin.
    // Collapsing "absent" and "null" is the bug this shape exists to avoid.
    expect(
      (await patch(fx, itemId, { jobId: 'job-role', mode: 'correct', patch: { title: 'Renamed' } }))
        .status,
    ).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).proposedFields,
    ).toMatchObject({ targetRepoRole: 'web' });

    // EXPLICIT `null` — the unpin, which is unsayable if the two collapse.
    expect(
      (await patch(fx, itemId, { jobId: 'job-role', mode: 'correct', targetRepoRole: null }))
        .status,
    ).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).proposedFields,
    ).toMatchObject({ targetRepoRole: null });
  });

  it('`targetRepositoryRef` is SPARSE — an explicit `null` unpins, an absent key leaves the pin alone (MOTIR-4924)', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Row-pinned', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const appended = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Pinned to a row',
            kind: 'task',
            targetRepositoryRef: 'row-one',
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-rowref' } });
    const itemId = appended.items[0]!.id;

    // ABSENT — a correction that touches something else must not disturb the pin.
    expect(
      (
        await patch(fx, itemId, {
          jobId: 'job-rowref',
          mode: 'correct',
          patch: { title: 'Renamed' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).proposedFields,
    ).toMatchObject({ targetRepositoryRef: 'row-one' });

    // EXPLICIT `null` — the unpin, which is unsayable if the two collapse.
    expect(
      (await patch(fx, itemId, { jobId: 'job-rowref', mode: 'correct', targetRepositoryRef: null }))
        .status,
    ).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } })).proposedFields,
    ).toMatchObject({ targetRepositoryRef: null });
  });

  it('an UNKNOWN `targetRepoRole` is a typed 422, never a 500 — the same refusal the append gives', async () => {
    const fx = await makeWorkItemFixture();
    const { secondId } = await plannedPlan(fx, 'job-badrole');

    const res = await patch(fx, secondId, {
      jobId: 'job-badrole',
      mode: 'correct',
      targetRepoRole: 'backend',
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE' });
    // …and NOTHING was written: the role is validated before the update, so a
    // refused correction leaves the proposal exactly as it was.
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } })).proposedFields,
    ).not.toHaveProperty('targetRepoRole');
  });
});

describe('DELETE — the withdraw verb', () => {
  it('takes a proposal off the plan and reports what remains', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await plannedPlan(fx, 'job-5');

    const res = await del(fx, secondId, 'job-5');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ planId, itemCount: 1 });
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it('REFUSES a withdraw a sibling still references, naming the referrers', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId, secondId } = await plannedPlan(fx, 'job-6');
    // Wire the dependent at the prerequisite, then try to remove the prerequisite.
    expect(
      (
        await patch(fx, secondId, {
          jobId: 'job-6',
          mode: 'correct',
          blockedByRefs: [`planItem:${firstId}`],
        })
      ).status,
    ).toBe(200);

    const res = await del(fx, firstId, 'job-6');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('PLAN_PROPOSAL_REFERENCED');
    expect(body.error).toContain(secondId);
  });

  it('requires a `jobId`, and cannot reach another job’s plan', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId } = await plannedPlan(fx, 'job-7');

    const req = new Request(`http://core/api/internal/ai/plan-proposals/${firstId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SERVICE_SECRET}` },
    });
    req.headers.set('x-motir-job-token', tokenFor(fx));
    expect((await itemDELETE(req, { params: Promise.resolve({ itemId: firstId }) })).status).toBe(
      400,
    );

    expect((await del(fx, firstId, 'job-nobody')).status).toBe(404);
  });
});

describe('GET — reading what the plan currently PROPOSES', () => {
  function read(fx: WorkItemFixture, jobId: string): Promise<Response> {
    const req = new Request(
      `http://core/api/internal/ai/plan-proposals?jobId=${encodeURIComponent(jobId)}`,
      { headers: { authorization: `Bearer ${SERVICE_SECRET}` } },
    );
    req.headers.set('x-motir-job-token', tokenFor(fx));
    return proposalsGET(req);
  }

  it('answers with the plan’s OWN proposals — the read every other internal seam cannot make', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx, 'job-read');

    const res = await read(fx, 'job-read');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; items: { id: string; op: string }[] };
    expect(body.id).toBe(planId);
    // Proposals, not work items: this is what a revising pass seeds its registry
    // from, and it is empty in every committed-tree read.
    expect(body.items).toHaveLength(2);
    expect(body.items.every((i) => i.op === 'add')).toBe(true);
  });

  it('cannot read a plan that is not its job’s', async () => {
    const fx = await makeWorkItemFixture();
    await plannedPlan(fx, 'job-read-2');
    expect((await read(fx, 'job-somebody-else')).status).toBe(404);
  });

  it('requires a `jobId`', async () => {
    const fx = await makeWorkItemFixture();
    const req = new Request('http://core/api/internal/ai/plan-proposals', {
      headers: { authorization: `Bearer ${SERVICE_SECRET}` },
    });
    req.headers.set('x-motir-job-token', tokenFor(fx));
    expect((await proposalsGET(req)).status).toBe(400);
  });
});

describe('POST — the REVISION pass', () => {
  it('APPENDS to a `planned` plan when it declares itself a revision, and `final` CLOSES it', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx, 'job-8');
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    const res = await append(fx, {
      jobId: 'job-8',
      revision: true,
      actor: { harness: 'Motir AI', model: 'claude-opus-5' },
      proposals: [{ op: 'add', proposedFields: { title: 'The split half', kind: 'task' } }],
      final: true,
    });
    expect(res.status).toBe(200);
    // The revision re-opened the plan, so its `final` closes it through
    // `markPlanned` (MOTIR-8208) and reports it truthfully as `planned`.
    expect(await res.json()).toMatchObject({ planId, planned: true, released: true });

    // The plan is `planned` again — and decidable.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(3);
    const rows = await adminDb.planRevision.findMany({
      where: { planId },
      orderBy: { changedAt: 'asc' },
    });
    expect(rows.at(-1)).toMatchObject({ changeKind: 'revision_ended', actorHarness: 'Motir AI' });
  });

  it('WITHOUT the flag a `planned` plan still refuses the append', async () => {
    const fx = await makeWorkItemFixture();
    await plannedPlan(fx, 'job-9');
    const res = await append(fx, {
      jobId: 'job-9',
      proposals: [{ op: 'add', proposedFields: { title: 'Sneaked in', kind: 'task' } }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PLAN_NOT_GENERATING' });
  });
});
