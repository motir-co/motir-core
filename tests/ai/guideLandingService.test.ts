import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { commentsService } from '@/lib/services/commentsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { manualWorkGateService } from '@/lib/services/manualWorkGateService';
import { workspacesService } from '@/lib/services/workspacesService';
import { GUIDE_BUGS_PER_CONVERSATION } from '@/lib/ai/guideWorkItem';
import { GuideBugCapExceededError, PlanChangeSessionNotFoundError } from '@/lib/planChange/errors';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { seededBugsFolderId } from '../fixtures/projectFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPr } from '../helpers/prLink';

// LANDING a guide turn (Story MOTIR-7459 · MOTIR-7470), route-level against a
// REAL Postgres — `docs/decisions/conversation-turn-intent.md` AMENDMENT 2,
// A2.4–A2.6. Only `getSession` / `getActiveProject` and the motir-ai client are
// mocked; every write runs through the service that owns it.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-1' }));
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  streamJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { POST: guide } = await import('@/app/api/ai/guide/route');
const { POST: guideSettle } = await import('@/app/api/ai/guide/settle/route');
const { POST: declineOffer } = await import('@/app/api/ai/guide/offer/decline/route');
const { POST: askSettle } = await import('@/app/api/ai/ask/settle/route');
const { guideBugFilingService } = await import('@/lib/services/guideBugFilingService');
const { guideLandingService } = await import('@/lib/services/guideLandingService');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Opened {
  jobId: string;
  session: PlanChangeSessionDto;
}
interface Settled {
  outcome: string;
  session: PlanChangeSessionDto;
  record?: {
    outcomes: Array<{ type: string; outcome: string; reason?: string; workItemKey?: string }>;
    replanOffer?: Record<string, unknown> | null;
  };
}

let fx: WorkItemFixture;
let jobN = 0;

async function manualCard(title = 'Rotate the signing key') {
  const item = await createTestWorkItem(fx, {
    kind: 'task',
    title,
    type: 'manual',
    executor: 'human',
  });
  // The fixture writes the legacy `open`; a real card sits on a workflow status.
  return adminDb.workItem.update({ where: { id: item.id }, data: { status: 'todo' } });
}

async function open(identifier: string): Promise<Opened> {
  const res = await guide(post('/api/ai/guide', { itemKey: identifier }));
  expect(res.status).toBe(200);
  return (await res.json()) as Opened;
}

async function next(sessionId: string, text: string): Promise<Opened> {
  const res = await guide(post('/api/ai/guide', { sessionId, text }));
  expect(res.status).toBe(200);
  return (await res.json()) as Opened;
}

/** Make the job settle with this guide turn, then settle it. */
async function settleWith(
  opened: Opened,
  actions: unknown[],
  messageMd = 'Here is the next step.',
): Promise<Settled> {
  getJobMock.mockResolvedValue({
    status: 'succeeded',
    result: { guideTurn: { messageMd, actions, dropped: [] } },
    error: null,
  });
  const res = await guideSettle(
    post('/api/ai/guide/settle', { jobId: opened.jobId, sessionId: opened.session.id }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Settled;
}

async function rows(workItemId: string) {
  return (await workItemTodosService.listTodos(workItemId, fx.ctx)).items;
}

async function addRows(workItemId: string, texts: string[]) {
  const ids: string[] = [];
  for (const text of texts) {
    ids.push((await workItemTodosService.addTodo(workItemId, { text }, fx.ctx)).todo.id);
  }
  return ids;
}

const outcomesOf = (s: Settled) => s.record!.outcomes.map((o) => [o.type, o.outcome]);

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-guide-${++jobN}` }));
  getJobMock.mockReset();
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('write_todos', () => {
  it('creates the rows IN ORDER on a card with none, with the ticks so far', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      {
        type: 'write_todos',
        rows: [
          { fromId: 'tmp-1', text: 'Open the console', done: true },
          { fromId: 'tmp-2', text: 'Rotate', commandText: 'motir keys rotate', done: false },
        ],
      },
    ]);
    expect(outcomesOf(settled)).toEqual([['write_todos', 'landed']]);
    const list = await rows(card.id);
    expect(list.map((r) => [r.text, r.done, r.commandText])).toEqual([
      ['Open the console', true, null],
      ['Rotate', false, 'motir keys rotate'],
    ]);
    expect(list[0]!.doneBy?.id).toBe(fx.ownerId);
  });

  it('creates nothing on a card that already has rows', async () => {
    const card = await manualCard();
    await addRows(card.id, ['Existing']);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'write_todos', rows: [{ fromId: 'tmp-1', text: 'New', done: false }] },
    ]);
    expect(outcomesOf(settled)).toEqual([['write_todos', 'skipped']]);
    expect((await rows(card.id)).map((r) => r.text)).toEqual(['Existing']);
  });
});

describe('tick / untick', () => {
  it('ticks as the person and unticks, and a row from another card is skipped while the rest land', async () => {
    const card = await manualCard();
    const [r1, r2] = await addRows(card.id, ['One', 'Two']);
    const other = await manualCard('Other');
    const [foreign] = await addRows(other.id, ['Theirs']);
    await workItemTodosService.setTodoDone(r2!, true, fx.ctx);

    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'tick', rowId: foreign },
      { type: 'tick', rowId: r1 },
      { type: 'untick', rowId: r2 },
    ]);
    expect(outcomesOf(settled)).toEqual([
      ['tick', 'skipped'],
      ['tick', 'landed'],
      ['untick', 'landed'],
    ]);
    const list = await rows(card.id);
    expect(list.map((r) => r.done)).toEqual([true, false]);
    expect(list[0]!.doneBy?.id).toBe(fx.ownerId);
    expect((await rows(other.id))[0]!.done).toBe(false);
    // The turn says what did not land, and why.
    expect(settled.session.turns.at(-1)!.body).toContain('Some of that did not land:');
  });

  it('a tick on a row already done is skipped, not an error', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['One']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'tick', rowId: r1 }]);
    expect(outcomesOf(settled)).toEqual([['tick', 'skipped']]);
  });
});

describe('corrections on a saved list', () => {
  it('add, revise, remove and move each change the rows as stated', async () => {
    const card = await manualCard();
    const [a, b, c] = await addRows(card.id, ['A', 'B', 'C']);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'add_step', afterRowId: a, reason: 'Missing', text: 'A2' },
      { type: 'revise_step', rowId: b, reason: 'Clearer', text: 'B!' },
      { type: 'remove_step', rowId: c, reason: 'Not needed' },
      { type: 'move_step', rowId: a, afterRowId: b, reason: 'Order' },
    ]);
    expect(outcomesOf(settled).map((o) => o[1])).toEqual(['landed', 'landed', 'landed', 'landed']);
    expect((await rows(card.id)).map((r) => r.text)).toEqual(['A2', 'B!', 'A']);
  });

  // A3.9 (b) — `guide-turn-files.md` amends A2.4: while the card's target holds,
  // a ticked row may be corrected, and a revised ticked row KEEPS its tick.
  it('a correction naming a TICKED row lands, and the revised row keeps its tick', async () => {
    const card = await manualCard();
    const [a, b, c] = await addRows(card.id, ['A', 'B', 'C']);
    await workItemTodosService.setTodoDone(a!, true, fx.ctx);
    await workItemTodosService.setTodoDone(c!, true, fx.ctx);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'revise_step', rowId: a, reason: 'Clearer', text: 'A!' },
      { type: 'move_step', rowId: a, afterRowId: b, reason: 'Order' },
      { type: 'remove_step', rowId: c, reason: 'Not needed' },
    ]);
    expect(outcomesOf(settled).map((o) => o[1])).toEqual(['landed', 'landed', 'landed']);
    expect((await rows(card.id)).map((r) => [r.text, r.done])).toEqual([
      ['B', false],
      ['A!', true],
    ]);
  });

  it('an untick before a revision re-opens the ticked row, then revises it', async () => {
    const card = await manualCard();
    const [a] = await addRows(card.id, ['Rotate on the old console', 'B']);
    await workItemTodosService.setTodoDone(a!, true, fx.ctx);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'untick', rowId: a },
      {
        type: 'revise_step',
        rowId: a,
        reason: 'The console moved',
        text: 'Rotate in the new console',
      },
    ]);
    expect(outcomesOf(settled)).toEqual([
      ['untick', 'landed'],
      ['revise_step', 'landed'],
    ]);
    expect((await rows(card.id)).map((r) => [r.text, r.done])).toEqual([
      ['Rotate in the new console', false],
      ['B', false],
    ]);
  });

  it('on a TEMPORARY walk, a correction to a ticked step is recorded too', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    await settleWith(opened, [
      {
        type: 'propose_todos',
        rows: [
          { id: 'tmp-1', text: 'One' },
          { id: 'tmp-2', text: 'Two' },
        ],
      },
    ]);
    const second = await next(opened.session.id, 'walk it');
    await settleWith(second, [{ type: 'tick', rowId: 'tmp-1' }]);
    const third = await next(opened.session.id, 'reword the first');
    const settled = await settleWith(third, [
      { type: 'revise_step', rowId: 'tmp-1', reason: 'Clearer', text: 'One!' },
      { type: 'remove_step', rowId: 'nope', reason: 'x' },
    ]);
    expect(outcomesOf(settled)).toEqual([
      ['revise_step', 'recorded'],
      ['remove_step', 'skipped'],
    ]);
    expect(await rows(card.id)).toEqual([]);
  });
});

describe('edit_item', () => {
  it('changes the guided card as the person, and a second edit restores it', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    await settleWith(opened, [
      {
        type: 'edit_item',
        reason: 'The scope changed',
        descriptionMd: 'Rotate both keys.',
        previous: { descriptionMd: '' },
      },
    ]);
    const edited = await workItemsService.getWorkItem(card.id, fx.ctx);
    expect(edited.descriptionMd).toBe('Rotate both keys.');
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: card.id, changeKind: 'updated' },
    });
    expect(revisions.some((r) => r.changedById === fx.ownerId)).toBe(true);

    const again = await next(opened.session.id, 'Put it back');
    await settleWith(again, [
      {
        type: 'edit_item',
        reason: 'Undo',
        descriptionMd: '',
        previous: { descriptionMd: 'Rotate both keys.' },
      },
    ]);
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).descriptionMd ?? '').toBe('');
  });

  it('an edit naming another field is refused whole and changes nothing', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    getJobMock.mockResolvedValue({
      status: 'succeeded',
      result: {
        guideTurn: {
          messageMd: 'x',
          actions: [{ type: 'edit_item', reason: 'x', status: 'done', title: 'T' }],
        },
      },
      error: null,
    });
    const res = await guideSettle(
      post('/api/ai/guide/settle', { jobId: opened.jobId, sessionId: opened.session.id }),
    );
    expect(res.status).toBe(502);
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).title).toBe(
      'Rotate the signing key',
    );
  });
});

describe('cannot_do', () => {
  it('adds ONE comment naming the step and the reason', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Log in to the vault']);
    const opened = await open(card.identifier);
    await settleWith(opened, [
      { type: 'current_step', rowId: r1 },
      { type: 'cannot_do', reason: 'Needs an admin you do not have' },
    ]);
    const comments = await commentsService.listComments(card.id, {}, fx.ctx);
    const bodies = JSON.stringify(comments);
    expect(bodies).toContain('Log in to the vault');
    expect(bodies).toContain('Needs an admin you do not have');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
  });
});

describe('needs_replan (A3.9 (b))', () => {
  it('edits nothing and leaves ONE comment carrying the reason', async () => {
    const card = await manualCard();
    await addRows(card.id, ['A']);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [
      { type: 'needs_replan', reason: 'Switching providers changes what the card delivers' },
    ]);
    expect(outcomesOf(settled)).toEqual([['needs_replan', 'landed']]);
    const comments = await adminDb.comment.findMany({ where: { workItemId: card.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('needs a re-plan');
    expect(comments[0]!.bodyMd).toContain('Switching providers changes what the card delivers');
    expect((await rows(card.id)).map((r) => r.text)).toEqual(['A']);
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).title).toBe(
      'Rotate the signing key',
    );
  });
});

describe('needs_replan offer — the stored, resolved offer (MOTIR-8689)', () => {
  /** A manual card under a story under an epic, all on a workflow status. */
  async function chain() {
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Email' });
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Sending',
      parentId: epic.id,
    });
    const card = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Rotate the signing key',
      type: 'manual',
      executor: 'human',
      parentId: story.id,
    });
    for (const w of [epic, story, card]) {
      await adminDb.workItem.update({ where: { id: w.id }, data: { status: 'todo' } });
    }
    return { epic, story, card };
  }

  const offer = (targetKey?: string | null) => ({
    type: 'needs_replan',
    reason: 'The story is wrong',
    requestMd: 'Re-plan the story',
    ...(targetKey === undefined ? {} : { targetKey }),
  });

  const commentOn = async (id: string) =>
    (await adminDb.comment.findMany({ where: { workItemId: id } })).map((c) => c.bodyMd);

  it('an open target stands as asked, is stored on the reply, and reads back', async () => {
    const { story, card } = await chain();
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [offer(story.identifier)]);
    expect(outcomesOf(settled)).toEqual([['needs_replan', 'landed']]);
    expect(settled.record?.replanOffer).toEqual({
      reason: 'The story is wrong',
      requestMd: 'Re-plan the story',
      requestedTargetKey: story.identifier,
      targetKey: story.identifier,
      targetResolution: 'as_asked',
      declinedAt: null,
      declinedById: null,
      confirmedAt: null,
      confirmedById: null,
      confirmedSessionId: null,
    });
    const bodies = await commentOn(card.id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`Re-plan offered on: ${story.identifier}`);
    // It survives a fresh read of the thread.
    const reread = await planChangeSessionsService.getById(activeCtx.current!, opened.session.id);
    expect(reread.turns.at(-1)?.guide?.replanOffer?.targetKey).toBe(story.identifier);
  });

  it('naming the guided card ITSELF, in any case, stands as asked on that card (MOTIR-10154)', async () => {
    const { card } = await chain();
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [offer(card.identifier.toLowerCase())]);
    expect(outcomesOf(settled)).toEqual([['needs_replan', 'landed']]);
    expect(settled.record?.replanOffer).toMatchObject({
      requestedTargetKey: card.identifier.toLowerCase(),
      targetKey: card.identifier,
      targetResolution: 'as_asked',
    });
  });

  it('no named target plans on the guided card', async () => {
    const { card } = await chain();
    const settled = await settleWith(await open(card.identifier), [offer(null)]);
    expect(settled.record?.replanOffer).toMatchObject({
      requestedTargetKey: null,
      targetKey: card.identifier,
      targetResolution: 'guided_card',
    });
  });

  it('an unknown key falls back to the guided card and keeps only the key the guide wrote', async () => {
    const { card } = await chain();
    const settled = await settleWith(await open(card.identifier), [offer('NOPE-999')]);
    expect(settled.record?.replanOffer).toMatchObject({
      requestedTargetKey: 'NOPE-999',
      targetKey: card.identifier,
      targetResolution: 'guided_card',
    });
  });

  it('a done target resolves to the nearest not-done ancestor, parent first', async () => {
    const { epic, story, card } = await chain();
    await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'done' } });
    const settled = await settleWith(await open(card.identifier), [offer(story.identifier)]);
    expect(settled.record?.replanOffer).toMatchObject({
      requestedTargetKey: story.identifier,
      targetKey: epic.identifier,
      targetResolution: 'nearest_open_ancestor',
    });
  });

  it('a done target with every ancestor done offers no target, and the comment says so', async () => {
    const { epic, story, card } = await chain();
    await adminDb.workItem.update({ where: { id: epic.id }, data: { status: 'done' } });
    await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'done' } });
    const settled = await settleWith(await open(card.identifier), [offer(story.identifier)]);
    expect(settled.record?.replanOffer).toMatchObject({
      targetKey: null,
      targetResolution: 'none',
    });
    expect((await commentOn(card.id))[0]).toContain('No open work item to re-plan on');
  });

  it('a reason-only needs_replan stores no offer and comments exactly as before', async () => {
    const { card } = await chain();
    const settled = await settleWith(await open(card.identifier), [
      { type: 'needs_replan', reason: 'The target moved' },
    ]);
    // The record carries the field, empty: `replanOffer: null` is "no offer".
    expect(settled.record?.replanOffer).toBeNull();
    const bodies = await commentOn(card.id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('Re-plan offered on');
  });

  it('a second offer in the same turn is skipped, the first stands', async () => {
    const { story, epic, card } = await chain();
    const settled = await settleWith(await open(card.identifier), [
      offer(story.identifier),
      offer(epic.identifier),
    ]);
    expect(outcomesOf(settled)).toEqual([
      ['needs_replan', 'landed'],
      ['needs_replan', 'skipped'],
    ]);
    expect(settled.record?.replanOffer?.targetKey).toBe(story.identifier);
  });
});

describe('Decline a re-plan offer — POST /api/ai/guide/offer/decline (MOTIR-8689)', () => {
  const offerAction = (targetKey: string) => ({
    type: 'needs_replan',
    reason: 'The story is wrong',
    requestMd: 'Re-plan the story',
    targetKey,
  });

  const decline = (sessionId: string, turnId: string) =>
    declineOffer(post('/api/ai/guide/offer/decline', { sessionId, turnId }));

  async function offered(opts: { rows?: string[] } = {}) {
    const parent = await createTestWorkItem(fx, { kind: 'story', title: 'Sending' });
    const card = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Rotate the signing key',
      type: 'manual',
      executor: 'human',
      parentId: parent.id,
    });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'todo' } });
    await adminDb.workItem.update({ where: { id: parent.id }, data: { status: 'todo' } });
    if (opts.rows) await addRows(card.id, opts.rows);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [offerAction(parent.identifier)]);
    const turn = settled.session.turns.find((t) => t.role === 'assistant')!;
    return { card, parent, opened, settled, turnId: turn.id };
  }

  it('stamps the decision and writes nothing else: no turn, no job, no change to the card', async () => {
    const { card, opened, turnId } = await offered();
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    const turnsBefore = await adminDb.planChangeTurn.count({
      where: { sessionId: opened.session.id },
    });
    const jobsBefore = submitJobMock.mock.calls.length;

    const res = await decline(opened.session.id, turnId);
    expect(res.status).toBe(200);
    const dto = (await res.json()) as PlanChangeSessionDto;
    const offer = dto.turns.find((t) => t.id === turnId)?.guide?.replanOffer;
    expect(offer?.declinedAt).toEqual(expect.any(String));
    expect(offer?.declinedById).toBe(fx.ownerId);

    expect(await adminDb.planChangeTurn.count({ where: { sessionId: opened.session.id } })).toBe(
      turnsBefore,
    );
    expect(submitJobMock.mock.calls.length).toBe(jobsBefore);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('is idempotent: a second decline answers 200 and rewrites nothing', async () => {
    const { opened, turnId } = await offered();
    await decline(opened.session.id, turnId);
    const first = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
    const res = await decline(opened.session.id, turnId);
    expect(res.status).toBe(200);
    const second = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
    expect(second.guideTurn).toEqual(first.guideTurn);
  });

  it('refuses a superseded offer with 409 GUIDE_REPLAN_OFFER_NOT_OPEN', async () => {
    const { parent, opened, turnId } = await offered();
    const next1 = await next(opened.session.id, 'No, the story is the problem.');
    await settleWith(next1, [offerAction(parent.identifier)]);
    const res = await decline(opened.session.id, turnId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('GUIDE_REPLAN_OFFER_NOT_OPEN');
  });

  it('answers 404 alike for a turn with no offer, an unknown turn and another member’s session', async () => {
    const { card, opened } = await offered();
    const reply = opened.session.turns.find((t) => t.role === 'user')!;
    for (const turnId of [reply.id, 'no-such-turn']) {
      const res = await decline(opened.session.id, turnId);
      expect(res.status).toBe(404);
    }
    const other = await createTestUser();
    session.current = { user: { id: other.id, email: other.email, name: 'Other' } };
    activeCtx.current = { ...activeCtx.current!, userId: other.id };
    const assistant = (
      await adminDb.planChangeTurn.findMany({ where: { sessionId: opened.session.id } })
    ).find((t) => t.role === 'assistant');
    expect(assistant).toBeDefined();
    expect((await decline(opened.session.id, assistant!.id)).status).toBe(404);
    expect(card.id).toBeTruthy();
  });

  it('answers 400 without a sessionId or turnId', async () => {
    expect((await declineOffer(post('/api/ai/guide/offer/decline', { turnId: 'x' }))).status).toBe(
      400,
    );
    expect(
      (await declineOffer(post('/api/ai/guide/offer/decline', { sessionId: 'x' }))).status,
    ).toBe(400);
  });

  it('after a decline, Guide me through resumes the same conversation', async () => {
    // The door resumes a walk only on a card with to-do rows (a card with none
    // starts fresh, by design), so the walk this declines on has its rows.
    const { card, opened, turnId } = await offered({ rows: ['Rotate the key', 'Verify'] });
    await decline(opened.session.id, turnId);
    const again = await open(card.identifier);
    expect(again.session.id).toBe(opened.session.id);
  });
});

describe('local_agent_prompt (A3.9 (a))', () => {
  it('is recorded on the conversation and writes nothing to the card', async () => {
    const card = await manualCard();
    const [a] = await addRows(card.id, ['Rotate the key']);
    const opened = await open(card.identifier);
    const before = await adminDb.workItemRevision.count({ where: { workItemId: card.id } });
    const settled = await settleWith(opened, [
      { type: 'current_step', rowId: a },
      { type: 'local_agent_prompt', rowId: a, prompt: 'Rotate the signing key using the CLI.' },
      { type: 'local_agent_prompt', rowId: 'not-a-row', prompt: 'x' },
    ]);
    expect(outcomesOf(settled)).toEqual([
      ['current_step', 'recorded'],
      ['local_agent_prompt', 'recorded'],
      ['local_agent_prompt', 'skipped'],
    ]);
    expect(await adminDb.workItemRevision.count({ where: { workItemId: card.id } })).toBe(before);
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(0);
    const reply = settled.session.turns.at(-1)!;
    expect(reply.guide?.actions[1]).toEqual({
      type: 'local_agent_prompt',
      rowId: a,
      prompt: 'Rotate the signing key using the CLI.',
    });
  });
});

describe('close', () => {
  it('moves the card to Done with a summary comment when every row is ticked and no PR is linked', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'close' }], 'All done, closing it.');
    expect(settled.record!.outcomes[0]!.reason).toBeUndefined();
    expect(outcomesOf(settled)).toEqual([['close', 'landed']]);
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).toBe('done');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
  });

  it('DECIDES a pending manual-work gate through the decide door — Mark done, as the person (MOTIR-7474)', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateService.raise(card.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
    );
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'close' }], 'All done, closing it.');
    expect(outcomesOf(settled)).toEqual([['close', 'landed']]);
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).toBe('done');
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: card.id, kind: 'manual_work' },
    });
    expect(gate).toMatchObject({ state: 'approved', decidedById: fx.ownerId });
  });

  it('a manual-work gate the person may NOT decide skips the close with the reason, and decides nothing (MOTIR-10154)', async () => {
    // The decide door's own refusal: a workspace member holds `work_item:edit`
    // (so the turn lands) but is neither the card's assignee nor holds
    // `approval:decide_any` (§2), so Mark done is not theirs to press.
    const card = await manualCard();
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
    const [r1] = await addRows(card.id, ['Only step']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateService.raise(card.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
    );
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    session.current = { user: { id: member.id, email: member.email, name: 'Member' } };
    activeCtx.current = { ...activeCtx.current!, userId: member.id };

    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'close' }], 'All done, closing it.');
    expect(settled.record!.outcomes).toEqual([
      {
        type: 'close',
        outcome: 'skipped',
        reason: 'the work waiting on this card could not be marked done — mark it on the card',
      },
    ]);
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: card.id, kind: 'manual_work' },
    });
    expect(gate).toMatchObject({ state: 'awaiting', decidedById: null });
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).not.toBe('done');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(0);
  });

  it('lands nothing while a row is unticked', async () => {
    const card = await manualCard();
    await addRows(card.id, ['Not yet']);
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'close' }]);
    expect(settled.record!.outcomes[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'not every step is ticked',
    });
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).not.toBe('done');
  });

  it('lands nothing when a pull request is linked — its merge closes the card', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: { installationId: '7470', accountLogin: 'moooon', accountType: 'Organization' },
      repos: [
        {
          providerRepoId: '747001',
          owner: 'moooon',
          name: 'acme',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    await linkPr(
      {
        workItemId: card.id,
        projectId: fx.projectId,
        owner: 'moooon',
        name: 'acme',
        number: 12,
        headRef: 'subtask/guide',
      },
      fx.ctx,
    );
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [{ type: 'close' }]);
    expect(settled.record!.outcomes[0]).toMatchObject({ outcome: 'skipped' });
    expect(settled.record!.outcomes[0]!.reason).toContain('pull request');
    expect((await workItemsService.getWorkItem(card.id, fx.ctx)).status).not.toBe('done');
  });
});

describe('replay and failure', () => {
  it('settling the same job twice lands each action once', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    await settleWith(opened, [
      { type: 'tick', rowId: r1 },
      { type: 'cannot_do', reason: 'Stuck' },
    ]);
    const replay = await settleWith(opened, [
      { type: 'tick', rowId: r1 },
      { type: 'cannot_do', reason: 'Stuck' },
    ]);
    expect(replay.outcome).toBe('guided');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
    const replies = replay.session.turns.filter((t) => t.role === 'assistant');
    expect(replies).toHaveLength(1);
  });

  it('two CONCURRENT settles land once', async () => {
    const card = await manualCard();
    await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    getJobMock.mockResolvedValue({
      status: 'succeeded',
      result: { guideTurn: { messageMd: 'm', actions: [{ type: 'cannot_do', reason: 'Stuck' }] } },
      error: null,
    });
    const body = { jobId: opened.jobId, sessionId: opened.session.id };
    await Promise.all([
      guideSettle(post('/api/ai/guide/settle', body)),
      guideSettle(post('/api/ai/guide/settle', body)),
    ]);
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
  });

  // THE CONCURRENT LOSER'S TWO PATHS, EACH PINNED ON ITS OWN (MOTIR-10154). In the
  // test above, the second settle either reads the first one's reply (the replay
  // path) or passes that check first and loses the landing claim — which one
  // depends on timing, so a branch only it reached flipped the coverage lane's
  // number between runs. The replay path is pinned by "settling the same job
  // twice"; this pins the lost claim, deterministically.
  it('a landing that LOSES the claim to an earlier one lands nothing and reads silent', async () => {
    const card = await manualCard();
    await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    const turn = opened.session.turns.find((t) => t.role === 'user' && t.jobId === opened.jobId)!;
    const input = {
      jobId: opened.jobId,
      turn,
      result: {
        messageMd: 'm',
        actions: [{ type: 'cannot_do', reason: 'Stuck' } as never],
        dropped: [],
      },
    };
    const first = await guideLandingService.land(input, opened.session, activeCtx.current!);
    expect(first.outcome).toBe('guided');
    // The thread as the loser read it — before the winner appended its reply.
    const second = await guideLandingService.land(input, opened.session, activeCtx.current!);
    expect(second.outcome).toBe('silent');
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
    const reread = await planChangeSessionsService.getById(activeCtx.current!, opened.session.id);
    expect(reread.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
  });

  it.each(['queued', 'running'])(
    'a job still %s lands nothing and reads silent — and lands once it succeeds',
    async (status) => {
      const card = await manualCard();
      const [r1] = await addRows(card.id, ['One']);
      const opened = await open(card.identifier);
      getJobMock.mockResolvedValue({ status, result: null, error: null });
      const res = await guideSettle(
        post('/api/ai/guide/settle', { jobId: opened.jobId, sessionId: opened.session.id }),
      );
      const pending = (await res.json()) as Settled;
      expect(pending.outcome).toBe('silent');
      expect(pending.session.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
      expect((await rows(card.id))[0]!.done).toBe(false);

      // Nothing was decided: the same job lands when it settles.
      const settled = await settleWith(opened, [{ type: 'tick', rowId: r1 }]);
      expect(outcomesOf(settled)).toEqual([['tick', 'landed']]);
      expect((await rows(card.id))[0]!.done).toBe(true);
    },
  );

  it('replaying a job whose stored reply no longer reads as a guide record is silent and lands nothing again', async () => {
    const card = await manualCard();
    await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    const first = await settleWith(opened, [{ type: 'cannot_do', reason: 'Stuck' }]);
    const reply = first.session.turns.find((t) => t.role === 'assistant')!;
    await adminDb.planChangeTurn.update({
      where: { id: reply.id },
      data: { guideTurn: { unreadable: true } },
    });
    const replay = await settleWith(opened, [{ type: 'cannot_do', reason: 'Stuck' }]);
    expect(replay.outcome).toBe('silent');
    expect(replay.record).toBeUndefined();
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(1);
  });

  it('a conversation with no target card is refused as not found, and claims nothing', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    const turn = opened.session.turns.find((t) => t.role === 'user' && t.jobId === opened.jobId)!;
    await expect(
      guideLandingService.land(
        { jobId: opened.jobId, turn, result: { messageMd: 'm', actions: [], dropped: [] } },
        { ...opened.session, targetKeys: [] },
        activeCtx.current!,
      ),
    ).rejects.toBeInstanceOf(PlanChangeSessionNotFoundError);
    // The turn was not claimed, so the real settle still lands it.
    const settled = await settleWith(opened, [{ type: 'cannot_do', reason: 'Stuck' }]);
    expect(outcomesOf(settled)).toEqual([['cannot_do', 'landed']]);
  });

  it('a failed job lands no action and appends no reply', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    getJobMock.mockResolvedValue({
      status: 'failed',
      result: { guideTurn: { messageMd: 'm', actions: [{ type: 'tick', rowId: r1 }] } },
      error: { code: 'out_of_credits' },
    });
    const res = await guideSettle(
      post('/api/ai/guide/settle', { jobId: opened.jobId, sessionId: opened.session.id }),
    );
    await expect(res.json()).resolves.toMatchObject({ outcome: 'failed' });
    expect((await rows(card.id))[0]!.done).toBe(false);
  });

  it('the ask settle door lands a guide session’s job too', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    getJobMock.mockResolvedValue({
      status: 'succeeded',
      result: { guideTurn: { messageMd: 'Ticked.', actions: [{ type: 'tick', rowId: r1 }] } },
      error: null,
    });
    const res = await askSettle(
      post('/api/ai/ask/settle', { jobId: opened.jobId, sessionId: opened.session.id }),
    );
    await expect(res.json()).resolves.toMatchObject({ outcome: 'guided' });
    expect((await rows(card.id))[0]!.done).toBe(true);
  });
});

describe('a temporary walk', () => {
  it('ticks write nothing to the card; saving mid-walk writes the rows with the ticks so far', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    await settleWith(opened, [
      {
        type: 'propose_todos',
        rows: [
          { id: 'tmp-1', text: 'Open the console' },
          { id: 'tmp-2', text: 'Rotate' },
        ],
      },
      { type: 'current_step', rowId: 'tmp-1' },
    ]);
    const second = await next(opened.session.id, 'Done with the first');
    // The next job reads the temporary list from the conversation.
    const ctx2 = (
      submitJobMock.mock.calls.at(-1)![2] as {
        guideContext: { todos: { temporary: boolean; rows: Array<{ id: string }> } };
      }
    ).guideContext;
    expect(ctx2.todos.temporary).toBe(true);
    expect(ctx2.todos.rows.map((r) => r.id)).toEqual(['tmp-1', 'tmp-2']);

    const ticked = await settleWith(second, [{ type: 'tick', rowId: 'tmp-1' }]);
    expect(outcomesOf(ticked)).toEqual([['tick', 'recorded']]);
    expect(await rows(card.id)).toHaveLength(0);

    const third = await next(opened.session.id, 'Save it');
    await settleWith(third, [
      {
        type: 'write_todos',
        rows: [
          { fromId: 'tmp-1', text: 'Open the console', done: true },
          { fromId: 'tmp-2', text: 'Rotate', done: false },
        ],
      },
    ]);
    expect((await rows(card.id)).map((r) => [r.text, r.done])).toEqual([
      ['Open the console', true],
      ['Rotate', false],
    ]);
  });
});

describe('file_bug (MOTIR-7800; decision MOTIR-7798 Q3)', () => {
  const fileBug = (title: string, extra: Record<string, unknown> = {}) => ({
    type: 'file_bug',
    title,
    descriptionMd: `Saving a rotated key returns HTTP 500 (${title}).`,
    ...extra,
  });
  const bugsIn = () =>
    adminDb.workItem.findMany({ where: { projectId: fx.projectId, kind: 'bug' } });
  const replyOf = (s: Settled) => s.session.turns.filter((t) => t.role === 'assistant').at(-1)!;
  const counter = async (sessionId: string) =>
    (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } }))
      .guideBugsFiled;

  /** A guided task under a story — the placement cases' shape. */
  async function cardUnderStory(storyStatus = 'todo') {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Key rotation' });
    await adminDb.workItem.update({ where: { id: story.id }, data: { status: storyStatus } });
    const task = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Rotate the signing key',
      type: 'manual',
      executor: 'human',
      parentId: story.id,
    });
    const card = await adminDb.workItem.update({
      where: { id: task.id },
      data: { status: 'todo' },
    });
    return { story, card };
  }

  async function links(fromId: string, toId: string) {
    return (await adminDb.workItemLink.findMany({ where: { fromId, toId } })).map((l) => l.kind);
  }

  it('files ONE bug as the person, opening with the Found-while line, `relates_to` the card, and names its key in the reply', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    const settled = await settleWith(
      opened,
      [
        fileBug('The console 500s on save', {
          explanationMd: 'The save handler reads the old key id.',
        }),
      ],
      'That is a defect — I have filed it.',
    );

    const [outcome] = settled.record!.outcomes;
    expect(outcome).toMatchObject({ type: 'file_bug', outcome: 'landed' });
    const bugs = await bugsIn();
    expect(bugs).toHaveLength(1);
    const bug = bugs[0]!;
    expect(outcome!.workItemKey).toBe(bug.identifier);
    expect(bug.title).toBe('The console 500s on save');
    expect(bug.reporterId).toBe(fx.ownerId);
    expect(bug.projectId).toBe(fx.projectId);
    // The person's own filing: no planning provenance.
    expect(bug.planningSource).toBeNull();
    // The create stores the key as its canonical mention link (`[KEY](motir:id)`).
    expect(bug.descriptionMd!.split('\n')[0]).toBe(
      `**Found while:** guiding [${card.identifier}](motir:${card.id}) (Guide me through)`,
    );
    expect(bug.explanationMd).toBe('The save handler reads the old key id.');
    // Not blocking → the project's bug destination, no parent, and no block edge.
    expect(bug.parentId).toBeNull();
    expect(bug.folderId).toBe(await seededBugsFolderId(fx.projectId));
    expect(await links(bug.id, card.id)).toEqual(['relates_to']);
    expect(await links(card.id, bug.id)).toEqual(['relates_to']);

    // The reply names the key and title; the record round-trips it.
    const reply = replyOf(settled);
    expect(reply.body).toContain(`${bug.identifier}: The console 500s on save`);
    expect(reply.guide?.outcomes[0]).toMatchObject({ workItemKey: bug.identifier });
    expect(await counter(opened.session.id)).toBe(1);

    // MOTIR-7811: the session read resolves the filed key in its ONE resolve, so
    // the rail's chip carries the bug's live title — on the settle, and on a
    // reload of the thread (a replayed settle re-reads it as it stands).
    const summary = {
      accessible: true,
      id: bug.id,
      identifier: bug.identifier,
      title: 'The console 500s on save',
      kind: 'bug',
    };
    expect(settled.session.workItemRefs[bug.identifier]).toMatchObject(summary);
    const reloaded = await settleWith(opened, []);
    expect(reloaded.session.workItemRefs[bug.identifier]).toMatchObject(summary);
  });

  it('keeps a description that already opens with a Found-while line', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    await settleWith(opened, [
      fileBug('Own line', { descriptionMd: '**Found while:** guiding it by hand\n\nSteps.' }),
    ]);
    const [bug] = await bugsIn();
    expect(bug!.descriptionMd).toBe('**Found while:** guiding it by hand\n\nSteps.');
  });

  it('a bug that BLOCKS the card goes under the card’s not-done parent, and the card is `blocked_by` it', async () => {
    const { story, card } = await cardUnderStory();
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [fileBug('Blocks it', { blocksGuidedCard: true })]);
    expect(outcomesOf(settled)).toEqual([['file_bug', 'landed']]);

    const [bug] = await bugsIn();
    expect(bug!.parentId).toBe(story.id);
    expect(bug!.folderId).toBeNull();
    // The guided card is blocked_by the bug; the two also relate.
    expect((await links(card.id, bug!.id)).sort()).toEqual(['is_blocked_by', 'relates_to']);
  });

  it('a blocking bug whose card has a DONE parent goes to the Bugs folder, and the parent stays done', async () => {
    const { story, card } = await cardUnderStory('done');
    const opened = await open(card.identifier);
    await settleWith(opened, [fileBug('Blocks it', { blocksGuidedCard: true })]);

    const [bug] = await bugsIn();
    expect(bug!.parentId).toBeNull();
    expect(bug!.folderId).toBe(await seededBugsFolderId(fx.projectId));
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).status).toBe(
      'done',
    );
    // Still blocking the guided card: the placement moved, the edge did not.
    expect(await links(card.id, bug!.id)).toContain('is_blocked_by');
  });

  it('a blocking bug on a ROOT card goes to the Bugs folder', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    await settleWith(opened, [fileBug('Blocks a root card', { blocksGuidedCard: true })]);
    const [bug] = await bugsIn();
    expect(bug!.parentId).toBeNull();
    expect(bug!.folderId).toBe(await seededBugsFolderId(fx.projectId));
  });

  it('a non-blocking bug on a card with a parent still goes to the Bugs folder', async () => {
    const { card } = await cardUnderStory();
    const opened = await open(card.identifier);
    await settleWith(opened, [fileBug('Merely related')]);
    const [bug] = await bugsIn();
    expect(bug!.parentId).toBeNull();
    expect(bug!.folderId).toBe(await seededBugsFolderId(fx.projectId));
    expect(await links(card.id, bug!.id)).toEqual(['relates_to']);
  });

  it('a DUPLICATE of an open bug related to the card is skipped with that bug’s key, and nothing is filed', async () => {
    const card = await manualCard();
    const existing = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'bug',
        title: 'The console 500s on save',
        links: [{ targetId: card.id, relationship: 'relates_to' }],
      },
      fx.ctx,
    );
    const opened = await open(card.identifier);
    // The context the model reads carries the known bug.
    const sent = (
      submitJobMock.mock.calls.at(-1)![2] as {
        guideContext: { card: { openBugs: Array<{ key: string; title: string }> } };
      }
    ).guideContext;
    expect(sent.card.openBugs).toEqual([
      { key: existing.identifier, title: 'The console 500s on save', status: 'todo' },
    ]);

    const settled = await settleWith(opened, [fileBug('  the CONSOLE 500s on save ')]);
    expect(settled.record!.outcomes[0]).toEqual({
      type: 'file_bug',
      outcome: 'skipped',
      reason: `already filed as ${existing.identifier}`,
      workItemKey: existing.identifier,
    });
    expect(await bugsIn()).toHaveLength(1);
    expect(replyOf(settled).body).toContain(`already filed as ${existing.identifier}`);
    expect(await counter(opened.session.id)).toBe(0);
    // MOTIR-7811: the duplicate's key resolves for the rail's `alreadyFiled` chip.
    expect(settled.session.workItemRefs[existing.identifier]).toMatchObject({
      accessible: true,
      identifier: existing.identifier,
    });
  });

  it('a DONE bug with the same title is not a duplicate', async () => {
    const card = await manualCard();
    const old = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'bug',
        title: 'Same title',
        links: [{ targetId: card.id, relationship: 'relates_to' }],
      },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: old.id }, data: { status: 'done' } });
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [fileBug('Same title')]);
    expect(outcomesOf(settled)).toEqual([['file_bug', 'landed']]);
  });

  it('a second file_bug in ONE turn is skipped, and the first lands', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    const settled = await settleWith(opened, [fileBug('First'), fileBug('Second')]);
    expect(outcomesOf(settled)).toEqual([
      ['file_bug', 'landed'],
      ['file_bug', 'skipped'],
    ]);
    expect(settled.record!.outcomes[1]!.reason).toBe('a guide turn files at most one bug');
    expect((await bugsIn()).map((b) => b.title)).toEqual(['First']);
  });

  it(`after ${GUIDE_BUGS_PER_CONVERSATION} filings ACROSS TURNS the next is skipped with the cap reason, and the turn’s other actions still land`, async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['One']);
    const opened = await open(card.identifier);
    // Four filed on earlier turns of this conversation …
    await adminDb.planChangeSession.update({
      where: { id: opened.session.id },
      data: { guideBugsFiled: GUIDE_BUGS_PER_CONVERSATION - 1 },
    });
    // … the fifth lands on this turn …
    const fifth = await settleWith(opened, [fileBug('Fifth')]);
    expect(outcomesOf(fifth)).toEqual([['file_bug', 'landed']]);
    expect(await counter(opened.session.id)).toBe(GUIDE_BUGS_PER_CONVERSATION);

    // … and on the next turn the sixth is refused while its tick still lands.
    const second = await next(opened.session.id, 'Another one, and I did step one');
    const sixth = await settleWith(second, [fileBug('Sixth'), { type: 'tick', rowId: r1 }]);
    expect(outcomesOf(sixth)).toEqual([
      ['file_bug', 'skipped'],
      ['tick', 'landed'],
    ]);
    expect(sixth.record!.outcomes[0]!.reason).toBe(
      `this conversation has already filed ${GUIDE_BUGS_PER_CONVERSATION} bugs, the most one guide conversation may file`,
    );
    expect((await bugsIn()).map((b) => b.title)).toEqual(['Fifth']);
    expect((await rows(card.id))[0]!.done).toBe(true);
    expect(await counter(opened.session.id)).toBe(GUIDE_BUGS_PER_CONVERSATION);
  });

  it('a person without `work_item:edit` files nothing — the landing’s own gate', async () => {
    const card = await manualCard();
    const opened = await open(card.identifier);
    const viewer = await createTestUser();
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: viewer.id, workspaceId: fx.workspaceId } },
      data: { workspaceRole: 'viewer' },
    });
    const turn = opened.session.turns.find((t) => t.role === 'user' && t.jobId === opened.jobId)!;

    await expect(
      guideLandingService.land(
        {
          jobId: opened.jobId,
          turn,
          result: { messageMd: 'm', actions: [fileBug('Not mine to file') as never], dropped: [] },
        },
        opened.session,
        { ...activeCtx.current!, userId: viewer.id },
      ),
    ).rejects.toThrow();
    expect(await bugsIn()).toHaveLength(0);
    expect(await counter(opened.session.id)).toBe(0);
  });

  it('UNDER REAL CONCURRENCY at cap − 1, parallel filings on one conversation file exactly ONE', async () => {
    // A count read outside the session's row lock would let every racer see
    // `cap − 1` and file. The lock serialises them on the count, so exactly one
    // passes and the others count its increment.
    const card = await manualCard();
    const opened = await open(card.identifier);
    await adminDb.planChangeSession.update({
      where: { id: opened.session.id },
      data: { guideBugsFiled: GUIDE_BUGS_PER_CONVERSATION - 1 },
    });
    const item = await workItemsService.getWorkItem(card.id, fx.ctx);

    const RACERS = 4;
    const settled = await Promise.allSettled(
      Array.from({ length: RACERS }, (_, i) =>
        guideBugFilingService.fileGuideBug(
          {
            type: 'file_bug',
            title: `Racer ${i}`,
            descriptionMd: 'Steps.',
            explanationMd: null,
            blocksGuidedCard: false,
          },
          { id: opened.session.id },
          item,
          activeCtx.current!,
        ),
      ),
    );
    const won = settled.filter((s) => s.status === 'fulfilled');
    const lost = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(RACERS - 1);
    for (const l of lost) {
      expect(l.reason).toBeInstanceOf(GuideBugCapExceededError);
      expect((l.reason as GuideBugCapExceededError).filed).toBe(GUIDE_BUGS_PER_CONVERSATION);
    }
    expect(await counter(opened.session.id)).toBe(GUIDE_BUGS_PER_CONVERSATION);
    expect(await bugsIn()).toHaveLength(1);
  });
});

describe('a card closed while the turn ran (MOTIR-7817)', () => {
  // The door refuses a Done or archived card (A2.7, `GuideCardClosedError`), but
  // the job runs for seconds to minutes after it. The landing re-applies that gate
  // against the card as it stands: nothing lands, each action is recorded as
  // skipped with the reason, and the reply still arrives saying so.
  it('ARCHIVED: a tick, a comment and a close all land nothing, and the reply says why', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    const opened = await open(card.identifier);
    await workItemsService.archiveWorkItem(card.id, fx.ctx);
    const settled = await settleWith(
      opened,
      [
        { type: 'current_step', rowId: r1 },
        { type: 'tick', rowId: r1 },
        { type: 'cannot_do', reason: 'Stuck' },
        { type: 'close' },
      ],
      'Ticked it, closing.',
    );
    expect(settled.outcome).toBe('guided');
    expect(outcomesOf(settled)).toEqual([
      ['current_step', 'skipped'],
      ['tick', 'skipped'],
      ['cannot_do', 'skipped'],
      ['close', 'skipped'],
    ]);
    expect(settled.record!.outcomes.map((o) => o.reason)).toEqual(
      Array(4).fill('the card was archived while this turn ran'),
    );
    expect((await rows(card.id))[0]!.done).toBe(false);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('todo');
    expect(after.archivedAt).not.toBeNull();
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(0);
    const reply = settled.session.turns.at(-1)!;
    expect(reply.role).toBe('assistant');
    expect(reply.body).toContain('Some of that did not land:');
    expect(reply.body).toContain('- close: the card was archived while this turn ran');
  });

  it('ARCHIVED with every row ticked: the close does not walk the card to Done', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    const opened = await open(card.identifier);
    await workItemsService.archiveWorkItem(card.id, fx.ctx);
    const settled = await settleWith(opened, [{ type: 'close' }], 'All done, closing it.');
    expect(outcomesOf(settled)).toEqual([['close', 'skipped']]);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'todo',
    );
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(0);
  });

  it('DONE by hand while the turn ran: an untick and a close land nothing', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    await workItemTodosService.setTodoDone(r1!, true, fx.ctx);
    const opened = await open(card.identifier);
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });
    const settled = await settleWith(opened, [{ type: 'untick', rowId: r1 }, { type: 'close' }]);
    expect(outcomesOf(settled)).toEqual([
      ['untick', 'skipped'],
      ['close', 'skipped'],
    ]);
    expect(settled.record!.outcomes[0]!.reason).toBe('the card was finished while this turn ran');
    expect((await rows(card.id))[0]!.done).toBe(true);
    expect(await adminDb.comment.count({ where: { workItemId: card.id } })).toBe(0);
  });

  it('a replay of the skipped turn writes nothing more', async () => {
    const card = await manualCard();
    const [r1] = await addRows(card.id, ['Only step']);
    const opened = await open(card.identifier);
    await workItemsService.archiveWorkItem(card.id, fx.ctx);
    await settleWith(opened, [{ type: 'tick', rowId: r1 }]);
    const replay = await settleWith(opened, [{ type: 'tick', rowId: r1 }]);
    expect(outcomesOf(replay)).toEqual([['tick', 'skipped']]);
    expect(replay.session.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
    expect((await rows(card.id))[0]!.done).toBe(false);
  });
});
