import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  PLAN_CLOSED_WRITE_BACK,
  ReplanRefusalTooLateError,
  replanRefusalService,
} from '@/lib/services/replanRefusalService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { CommentForbiddenError, EmptyCommentBodyError } from '@/lib/comments/errors';
import { POST as refusalPOST } from '@/app/api/internal/ai/replan-refusal/route';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (MOTIR-10233) — the CAN'T-PLAN verdict's door,
// `POST /api/internal/ai/replan-refusal`, through the REAL route against a real
// Postgres. What it must hold, each case chosen so a lazy implementation fails it:
//
//   1. THE ANSWER LANDS UNDER THE RUN'S COMMENT — a reply, `parentCommentId` the
//      run's comment, authored as the Motir system account — and on the card when the
//      run named none, or its comment is gone. A retry finds the comment and adds none.
//   2. THE GRILLING ENDS, as finished and saying the plan closed, never as a failure
//      — for every open session on the plan, and only on that plan.
//   3. NOTHING ELSE MOVES: the card's status is the one the run parked it at.
//   4. IT COMES BEFORE PLANNING OR NOT AT ALL: a plan that holds a proposal, or has
//      left `generating`, is refused (409) and nothing is written.
//   5. The job-token family's posture: 401 without the bearer, 400 on a bad body,
//      404 for a job whose plan is not the token's project's.

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "sharpen_turn", "sharpen_session", "comment", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;

function req(opts: { bearer?: string; token?: string; body?: unknown; raw?: string }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/replan-refusal', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
}

function tokenFor(fx: Fx): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

function refuse(fx: Fx, body: Record<string, unknown>) {
  return refusalPOST(req({ bearer: SERVICE_SECRET, token: tokenFor(fx), body }));
}

async function scenario(jobId: string) {
  const fx = await makeFixture();
  // The account the comment is written by. It has no membership: it enters by identity.
  await adminDb.user.upsert({
    where: { email: MOTIR_SYSTEM_USER_EMAIL },
    update: {},
    create: { email: MOTIR_SYSTEM_USER_EMAIL, name: 'Motir' },
  });
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Stopped on' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'planning' } });
  const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
  const runComment = await adminDb.comment.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: card.id,
      authorId: fx.ownerId,
      bodyMd: 'Stopped: the card is wrong.',
    },
  });
  return { fx, card, planId: plan.id, runComment };
}

async function openGrilling(fx: Fx, planId: string): Promise<string> {
  const row = await adminDb.sharpenSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKind: 'plan',
      planId,
    },
  });
  return row.id;
}

describe('POST /api/internal/ai/replan-refusal — the verdict, where a person reads it', () => {
  it('replies UNDER the run’s comment, as the Motir system account, and moves nothing', async () => {
    const { fx, card, runComment } = await scenario('job_refuse_reply');
    const res = await refuse(fx, {
      jobId: 'job_refuse_reply',
      workItemKey: card.identifier.toLowerCase(),
      bodyMd: 'This report cannot be planned: it contradicts itself.',
      replyToCommentId: runComment.id,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { commentId: string; replied: boolean };
    expect(json.replied).toBe(true);

    const row = await adminDb.comment.findUniqueOrThrow({ where: { id: json.commentId } });
    expect(row.parentCommentId).toBe(runComment.id);
    expect(row.workItemId).toBe(card.id);
    const author = await adminDb.user.findUniqueOrThrow({ where: { id: row.authorId } });
    expect(author.email).toBe(MOTIR_SYSTEM_USER_EMAIL);
    expect(row.bodyMd).toContain('cannot be planned');

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('planning');
  });

  it('comments on the card when the run named no comment', async () => {
    const { fx, card } = await scenario('job_refuse_top');
    const res = await refuse(fx, {
      jobId: 'job_refuse_top',
      workItemKey: card.identifier,
      bodyMd: 'Nothing here can be planned.',
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { commentId: string; replied: boolean };
    expect(json.replied).toBe(false);
    const row = await adminDb.comment.findUniqueOrThrow({ where: { id: json.commentId } });
    expect(row.parentCommentId).toBeNull();
  });

  it('a run comment that is gone does not drop the answer — it lands on the card', async () => {
    const { fx, card, runComment } = await scenario('job_refuse_gone');
    await adminDb.comment.delete({ where: { id: runComment.id } });
    const res = await refuse(fx, {
      jobId: 'job_refuse_gone',
      workItemKey: card.identifier,
      bodyMd: 'Still cannot be planned.',
      replyToCommentId: runComment.id,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { commentId: string; replied: boolean };
    expect(json.replied).toBe(false);
    expect(
      (await adminDb.comment.findUniqueOrThrow({ where: { id: json.commentId } })).parentCommentId,
    ).toBeNull();
  });

  it('a comment on ANOTHER card of the project: the reply goes there, under it', async () => {
    const { fx, card, runComment } = await scenario('job_refuse_wider');
    const container = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The wider lane’s anchor' },
      fx.ctx,
    );
    const res = await refuse(fx, {
      jobId: 'job_refuse_wider',
      workItemKey: container.identifier,
      bodyMd: 'Cannot be planned.',
      replyToCommentId: runComment.id,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { commentId: string; replied: boolean };
    expect(json.replied).toBe(true);
    const row = await adminDb.comment.findUniqueOrThrow({ where: { id: json.commentId } });
    expect(row.workItemId).toBe(card.id);
    expect(row.parentCommentId).toBe(runComment.id);
  });

  it('NO CARD: the run’s comment is the anchor; with that gone too there is nowhere to go', async () => {
    const { fx, card, runComment } = await scenario('job_refuse_nocard');
    const res = await refuse(fx, {
      jobId: 'job_refuse_nocard',
      workItemKey: null,
      bodyMd: 'Cannot be planned.',
      replyToCommentId: runComment.id,
    });
    expect(res.status).toBe(201);
    const row = await adminDb.comment.findUniqueOrThrow({
      where: { id: ((await res.json()) as { commentId: string }).commentId },
    });
    expect(row.workItemId).toBe(card.id);

    const gone = await refuse(fx, {
      jobId: 'job_refuse_nocard',
      bodyMd: 'A different verdict.',
      replyToCommentId: 'cm_no_such_comment',
    });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe('REPLAN_REFUSAL_NO_ANCHOR');
  });

  it('A RETRY adds no second comment, and a closed plan is reported rather than refused', async () => {
    const { fx, card, planId, runComment } = await scenario('job_refuse_retry');
    const body = {
      jobId: 'job_refuse_retry',
      workItemKey: card.identifier,
      bodyMd: 'The same verdict.',
      replyToCommentId: runComment.id,
    };
    const first = (await (await refuse(fx, body)).json()) as {
      commentId: string;
      planAlreadyClosed: boolean;
    };
    expect(first.planAlreadyClosed).toBe(false);

    const again = (await (await refuse(fx, body)).json()) as {
      commentId: string;
      replied: boolean;
      planAlreadyClosed: boolean;
    };
    expect(again.commentId).toBe(first.commentId);
    expect(again.replied).toBe(true);
    expect(again.planAlreadyClosed).toBe(false);

    await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
    const afterClose = await refuse(fx, body);
    expect(afterClose.status).toBe(201);
    const closed = (await afterClose.json()) as { commentId: string; planAlreadyClosed: boolean };
    expect(closed.commentId).toBe(first.commentId);
    expect(closed.planAlreadyClosed).toBe(true);
    expect(await adminDb.comment.count({ where: { bodyMd: 'The same verdict.' } })).toBe(1);
  });

  it('a person who dispatched the run still hears of it: the token’s user is not the actor', async () => {
    const { fx, card } = await scenario('job_refuse_actor');
    const res = await refuse(fx, {
      jobId: 'job_refuse_actor',
      workItemKey: card.identifier,
      bodyMd: 'Cannot be planned.',
    });
    const row = await adminDb.comment.findUniqueOrThrow({
      where: { id: ((await res.json()) as { commentId: string }).commentId },
    });
    expect(row.authorId).not.toBe(fx.ownerId);
  });

  it('ENDS every open grilling on the plan as finished with a plan-closed write-back — and no other', async () => {
    const { fx, card, planId } = await scenario('job_refuse_grill');
    const onPlan = await openGrilling(fx, planId);
    const otherPlan = await plansService.createPlan(
      fx.projectId,
      { sourceJobId: 'job_other' },
      fx.ctx,
    );
    const elsewhere = await openGrilling(fx, otherPlan.id);

    const res = await refuse(fx, {
      jobId: 'job_refuse_grill',
      workItemKey: card.identifier,
      bodyMd: 'Cannot be planned.',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { endedSharpenSessions: number }).endedSharpenSessions).toBe(1);

    const ended = await adminDb.sharpenSession.findUniqueOrThrow({ where: { id: onPlan } });
    expect(ended.status).toBe('ended');
    expect(ended.endReason).toBe('finished');
    expect(ended.pendingQuestion).toBeNull();
    expect(ended.writeBack).toEqual(PLAN_CLOSED_WRITE_BACK);
    const untouched = await adminDb.sharpenSession.findUniqueOrThrow({ where: { id: elsewhere } });
    expect(untouched.status).toBe('open');
  });

  it('is refused 409 once the plan holds a proposal — nothing is written', async () => {
    const { fx, card, planId } = await scenario('job_refuse_late');
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId,
        op: 'add',
        proposedFields: { title: 'A proposal', kind: 'task' },
      },
    });
    const res = await refuse(fx, {
      jobId: 'job_refuse_late',
      workItemKey: card.identifier,
      bodyMd: 'Too late.',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('REPLAN_REFUSAL_TOO_LATE');
    expect(await adminDb.comment.count({ where: { bodyMd: 'Too late.' } })).toBe(0);
  });

  it('is refused 409 once the plan has left `generating`', async () => {
    const { fx, card, planId } = await scenario('job_refuse_closed');
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
    const res = await refuse(fx, {
      jobId: 'job_refuse_closed',
      workItemKey: card.identifier,
      bodyMd: 'Closed.',
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/internal/ai/replan-refusal — the job-token posture', () => {
  it('401 without the service bearer', async () => {
    const { fx, card } = await scenario('job_refuse_auth');
    const res = await refusalPOST(
      req({
        token: tokenFor(fx),
        body: { jobId: 'job_refuse_auth', workItemKey: card.identifier, bodyMd: 'x' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('400 on a body that is not JSON, or misses a field', async () => {
    const { fx, card } = await scenario('job_refuse_shape');
    const raw = await refusalPOST(req({ bearer: SERVICE_SECRET, token: tokenFor(fx), raw: '{' }));
    expect(raw.status).toBe(400);
    for (const body of [
      { workItemKey: card.identifier, bodyMd: 'x' },
      { jobId: 'job_refuse_shape', bodyMd: 'x' },
      { jobId: 'job_refuse_shape', workItemKey: 7, bodyMd: 'x' },
      { jobId: 'job_refuse_shape', workItemKey: ' ', replyToCommentId: ' ', bodyMd: 'x' },
      { jobId: 'job_refuse_shape', workItemKey: card.identifier, bodyMd: '  ' },
      { jobId: 'job_refuse_shape', workItemKey: card.identifier, bodyMd: 'x', replyToCommentId: 7 },
    ]) {
      const res = await refuse(fx, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('REPLAN_REFUSAL_INVALID');
    }
  });

  it('404 for a job with no plan, and for a key outside the token’s project', async () => {
    const { fx, card } = await scenario('job_refuse_404');
    const noPlan = await refuse(fx, {
      jobId: 'job_nobody_opened',
      workItemKey: card.identifier,
      bodyMd: 'x',
    });
    expect(noPlan.status).toBe(404);
    const foreign = await refuse(fx, {
      jobId: 'job_refuse_404',
      workItemKey: 'PROD-99999',
      bodyMd: 'x',
    });
    expect(foreign.status).toBe(404);
  });
});

describe('POST /api/internal/ai/replan-refusal — each typed error keeps its status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps every service error to its documented status, and rethrows the rest', async () => {
    const { fx, card } = await scenario('job_refuse_map');
    const body = { jobId: 'job_refuse_map', workItemKey: card.identifier, bodyMd: 'x' };
    const cases: Array<[Error, number]> = [
      [new ProjectAccessDeniedError(fx.projectId, 'browse'), 404],
      [new ProjectAccessDeniedError(fx.projectId, 'edit'), 403],
      [new CommentForbiddenError('add'), 403],
      [new EmptyCommentBodyError(), 400],
      [new ReplanRefusalTooLateError('plan_x', 'it holds a proposal'), 409],
    ];
    const spy = vi.spyOn(replanRefusalService, 'recordRefusal');
    for (const [err, status] of cases) {
      spy.mockRejectedValueOnce(err);
      const res = await refuse(fx, body);
      expect(res.status, err.name).toBe(status);
    }
    spy.mockRejectedValueOnce(new Error('boom'));
    await expect(refuse(fx, body)).rejects.toThrow('boom');
  });

  it('a blank replyToCommentId is no reply — the comment lands on the card', async () => {
    const { fx, card } = await scenario('job_refuse_blank');
    const spy = vi.spyOn(replanRefusalService, 'recordRefusal');
    const res = await refuse(fx, {
      jobId: 'job_refuse_blank',
      workItemKey: card.identifier,
      bodyMd: 'x',
      replyToCommentId: '   ',
    });
    expect(res.status).toBe(201);
    expect(spy.mock.calls[0]?.[0].replyToCommentId).toBeNull();
  });
});
