import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import type { ProjectContext } from '@/lib/projects';
import { createTestProject, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (MOTIR-10235) — `POST /api/internal/ai/conversation-notes`, the
// door a CONVERSATION job (a Grill me read, an answering session) posts its
// plain-language notes to, end to end through the REAL route against a real
// Postgres. What is asserted: the §4a-bearer + §4b-job-token auth, the body-shape
// 400s, the owner resolved FROM THE JOB within the token's project (never named by
// the caller), the 404 motir-ai retries while no turn carries the job yet, the
// per-job order, and that the notes come back on each conversation's own read.
//
// The motir-ai client is the one fake (submit / getJob), as in the sharpening
// suites; every write and read goes through the real path.

const SERVICE_SECRET = 'core-callback-secret-test';

const jobs = vi.hoisted(() => ({ next: 0 }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => {
    jobs.next += 1;
    return { jobId: `job-${jobs.next}` };
  }),
  getJob: vi.fn(async (jobId: string) => ({ jobId, status: 'running', result: null, error: null })),
  streamJob: vi.fn(),
}));

const { POST } = await import('@/app/api/internal/ai/conversation-notes/route');
const { aiSharpenService } = await import('@/lib/services/aiSharpenService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { plansService } = await import('@/lib/services/plansService');

let fx: WorkItemFixture;
let pctx: ProjectContext;

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  process.env['MOTIR_AI_URL'] = 'http://motir-ai.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc';
  jobs.next = 0;
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  pctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function tokenFor(f: WorkItemFixture, projectId = f.projectId): string {
  return mintJobToken({ userId: f.ownerId, workspaceId: f.workspaceId, projectId });
}

function req(opts: { bearer?: string; token?: string; body?: unknown; raw?: string }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/conversation-notes', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
}

/** The happy-path call: the fixture's own token. */
function post(body: unknown, f: WorkItemFixture = fx) {
  return POST(req({ bearer: SERVICE_SECRET, token: tokenFor(f), body }));
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** A Grill me session on a planned plan; its first job is in flight. */
async function grilling(): Promise<{ sessionId: string; jobId: string; planId: string }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Sharpen', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A card', kind: 'task', difficulty: 'low' } }],
    fx.ctx,
  );
  await adminDb.plan.update({ where: { id: plan.id }, data: { status: 'planned' } });
  const opened = await aiSharpenService.open({ planId: plan.id }, pctx);
  return { sessionId: opened.session.id, jobId: opened.jobId!, planId: plan.id };
}

/** A project conversation whose person turn the ASK door bound to `jobId`. */
async function askedConversation(jobId: string): Promise<string> {
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: '',
      targetKeys: [],
      lastActivityAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId: session.id,
      seq: 0,
      role: 'user',
      body: 'How do exports work?',
      intent: 'ask',
      authorId: fx.ownerId,
      jobId,
    },
  });
  return session.id;
}

describe('POST /api/internal/ai/conversation-notes — auth and shape', () => {
  it('refuses a missing service bearer or job token with 401', async () => {
    expect((await POST(req({ token: tokenFor(fx), body: {} }))).status).toBe(401);
    expect((await POST(req({ bearer: SERVICE_SECRET, body: {} }))).status).toBe(401);
  });

  it.each([
    ['a body that is not JSON', { raw: '{nope' }],
    ['a null body', { raw: 'null' }],
    ['no jobId', { body: { notes: ['x'] } }],
    ['a blank jobId', { body: { jobId: '  ', notes: ['x'] } }],
    ['notes that are not a list', { body: { jobId: 'job-1', notes: 'x' } }],
    ['a note that is not a string', { body: { jobId: 'job-1', notes: ['x', 3] } }],
  ])('refuses %s with 400 CONVERSATION_NOTES_INVALID', async (_label, opts) => {
    const res = await POST(req({ bearer: SERVICE_SECRET, token: tokenFor(fx), ...opts }));
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toMatchObject({ code: 'CONVERSATION_NOTES_INVALID' });
  });

  it('refuses no notes, too many, or a blank one with 422 and stores nothing', async () => {
    const { jobId } = await grilling();
    for (const notes of [[], Array.from({ length: 21 }, (_, i) => `Note ${i}`), ['ok', ' \n\t ']]) {
      const res = await post({ jobId, notes });
      expect(res.status).toBe(422);
      expect(await bodyOf(res)).toMatchObject({ code: 'CONVERSATION_NOTES_INVALID' });
    }
    expect(await adminDb.conversationNote.count()).toBe(0);
  });
});

describe('POST /api/internal/ai/conversation-notes — where the notes go', () => {
  it('hangs a Grill me job’s notes on its session, cleaned, in order, and the session reads them back', async () => {
    const { sessionId, jobId, planId } = await grilling();

    const first = await post({
      jobId,
      notes: ['Reading  the\nexport service.', 'Checking the plan.'],
    });
    expect(first.status).toBe(200);
    expect(await bodyOf(first)).toEqual({ stored: 2 });
    const second = await post({ jobId, notes: ['Ready to ask.'] });
    expect(await bodyOf(second)).toEqual({ stored: 1 });

    const rows = await adminDb.conversationNote.findMany({ orderBy: { seq: 'asc' } });
    expect(rows.map((r) => [r.seq, r.body, r.sharpenSessionId, r.planChangeSessionId])).toEqual([
      [1, 'Reading the export service.', sessionId, null],
      [2, 'Checking the plan.', sessionId, null],
      [3, 'Ready to ask.', sessionId, null],
    ]);
    expect(rows.every((r) => r.workspaceId === fx.workspaceId && r.jobId === jobId)).toBe(true);

    const read = await aiSharpenService.getOpenFor({ planId }, pctx);
    expect(read?.notes).toEqual([
      { jobId, body: 'Reading the export service.' },
      { jobId, body: 'Checking the plan.' },
      { jobId, body: 'Ready to ask.' },
    ]);
  });

  it('hangs an answering session’s notes on its conversation, and the thread reads them back', async () => {
    const conversationId = await askedConversation('job-ask');
    const res = await post({ jobId: 'job-ask', notes: ['Searching the work items for exports.'] });
    expect(res.status).toBe(200);

    const rows = await adminDb.conversationNote.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ planChangeSessionId: conversationId, sharpenSessionId: null });

    const thread = await planChangeSessionsService.getById(pctx, conversationId);
    expect(thread.notes).toEqual([
      { jobId: 'job-ask', body: 'Searching the work items for exports.' },
    ]);
  });

  it('keeps one job’s order gapless when its batches arrive at once', async () => {
    const { jobId } = await grilling();
    const sent = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post({ jobId, notes: [`Batch ${i} a`, `Batch ${i} b`] })),
    );
    expect(sent.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const rows = await adminDb.conversationNote.findMany({ orderBy: { seq: 'asc' } });
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // Each batch's two sentences stay side by side.
    for (let i = 0; i < 12; i += 2) {
      expect(rows[i]!.body.replace(/ a$/, '')).toBe(rows[i + 1]!.body.replace(/ b$/, ''));
    }
  });

  it('answers 404 CONVERSATION_NOTES_NOT_FOUND while no turn carries the job, so motir-ai retries', async () => {
    const res = await post({ jobId: 'job-unbound', notes: ['Reading.'] });
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toMatchObject({ code: 'CONVERSATION_NOTES_NOT_FOUND' });
    expect(await adminDb.conversationNote.count()).toBe(0);
  });

  it('never writes into another person’s conversation, even with the job’s id', async () => {
    const { sessionId, jobId } = await grilling();
    await askedConversation('job-asked');
    const other = await adminDb.user.create({
      data: { id: 'someone-else', email: 'someone-else@example.test', name: 'Someone Else' },
    });
    const token = mintJobToken({
      userId: other.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    for (const id of [jobId, 'job-asked']) {
      const res = await POST(
        req({ bearer: SERVICE_SECRET, token, body: { jobId: id, notes: ['Written elsewhere.'] } }),
      );
      expect(res.status).toBe(404);
    }
    expect(await adminDb.conversationNote.count({ where: { sharpenSessionId: sessionId } })).toBe(
      0,
    );
  });

  it('never writes into another project’s conversation, even with the job’s id', async () => {
    const { jobId } = await grilling();
    // A token for a sibling project in the SAME workspace: the job's turn is not in
    // that project, so it resolves nothing.
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SIB',
    });
    const res = await POST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx, sibling.id),
        body: { jobId, notes: ['Reading.'] },
      }),
    );
    expect(res.status).toBe(404);
    expect(await adminDb.conversationNote.count()).toBe(0);
  });
});
