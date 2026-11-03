import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { runDiscrepancyService } from '@/lib/services/runDiscrepancyService';
import {
  RUN_RECORD_DISCREPANCY_BODY_MAX,
  RUN_RECORD_END_DETAIL_MAX,
  runRecordReadService,
} from '@/lib/services/runRecordReadService';
import { parseRunRecordQuery } from '@/lib/runs/runRecordQuery';
import { projectsService } from '@/lib/services/projectsService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { POST as SEARCH } from '@/app/api/internal/ai/search-run-records/route';
import { POST as GET_ONE } from '@/app/api/internal/ai/get-run-record/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-10240 — the RUN-RECORD door end to end on a real Postgres: the service,
// both internal routes through their REAL handlers, the token's OWN project as the
// only scope (two projects, two workspaces), every absence a NAMED outcome at
// 200, the discrepancy record resolved to its comment body, and nothing written.

const SERVICE_SECRET = 'core-callback-secret-test';
const POINT = {
  planAsked: 'SENTINEL-ASKED: call fooBar()',
  built: 'SENTINEL-BUILT: called bazQux()',
  why: 'SENTINEL-WHY: fooBar() was retired',
};

let fx: WorkItemFixture;
let token: string;

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  token = tokenFor(fx.ctx, fx.projectId);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function tokenFor(ctx: ServiceContext, projectId: string): string {
  return mintJobToken({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId });
}

function post(
  handler: (req: Request) => Promise<Response>,
  path: string,
  body: unknown,
  opts: { bearer?: string; token?: string; raw?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bearer = 'bearer' in opts ? opts.bearer : SERVICE_SECRET;
  const tok = 'token' in opts ? opts.token : token;
  if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;
  if (tok !== undefined) headers['x-motir-job-token'] = tok;
  return handler(
    new Request(`http://core${path}`, {
      method: 'POST',
      headers,
      body: opts.raw ?? JSON.stringify(body),
    }),
  );
}
const search = (body: unknown, opts?: Parameters<typeof post>[3]) =>
  post(SEARCH, '/api/internal/ai/search-run-records', body, opts);
const getOne = (body: unknown, opts?: Parameters<typeof post>[3]) =>
  post(GET_ONE, '/api/internal/ai/get-run-record', body, opts);
const resultOf = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()).result;
};

async function card(f: WorkItemFixture, title = 'A card', extra: Record<string, unknown> = {}) {
  const item = await workItemsService.createWorkItem(
    { projectId: f.projectId, kind: 'task', title, ...extra } as never,
    f.ctx,
  );
  return { id: item.id, key: item.identifier };
}

/** A run of `f`'s project over `keys`, every leg claimed (open). */
async function openRun(f: WorkItemFixture, keys: string[], scopeKey?: string): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: f.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      ...(scopeKey ? { scopeKey } : {}),
      cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    f.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    keys.map((key) => ({
      kind: 'card_claimed' as const,
      workItemKey: key,
      disposition: 'running' as const,
    })),
    f.ctx,
  );
  return run.id;
}

describe('the run-record routes — auth and validation', () => {
  it('both refuse a missing / wrong bearer and a missing / tampered job token with 401', async () => {
    for (const call of [search, getOne]) {
      const noBearer = await call({ runId: 'x' }, { bearer: undefined });
      expect(noBearer.status).toBe(401);
      expect(await noBearer.json()).toMatchObject({ code: 'service_unauthorized' });
      expect((await call({ runId: 'x' }, { bearer: 'wrong' })).status).toBe(401);
      const noToken = await call({ runId: 'x' }, { token: undefined });
      expect(noToken.status).toBe(401);
      expect(await noToken.json()).toMatchObject({ code: 'token_invalid' });
      expect((await call({ runId: 'x' }, { token: 'not-a-token' })).status).toBe(401);
    }
  });

  it('400 RUN_RECORD_QUERY_INVALID for a bad body', async () => {
    for (const [call, body, raw] of [
      [search, null, 'not json'],
      [search, null, '[1]'],
      [search, { workItemKey: 'A-1', scopeWorkItemKey: 'A-2' }],
      [search, { statuses: ['nope'] }],
      [search, { statuses: 'running' }],
      [search, { limit: 0 }],
      [search, { limit: 101 }],
      [search, { limit: 1.5 }],
      [search, { workItemKey: 7 }],
      [search, { scopeWorkItemKey: 7 }],
      [search, { cursor: 7 }],
      [getOne, null, 'not json'],
      [getOne, {}],
      [getOne, { runId: '  ' }],
      [getOne, null, '"a string"'],
    ] as const) {
      const res = await call(body, raw ? { raw } : {});
      expect(res.status, JSON.stringify(body ?? raw)).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'RUN_RECORD_QUERY_INVALID' });
    }
  });

  it('the query parser keeps only what was given', () => {
    expect(parseRunRecordQuery({ workItemKey: '  ', cursor: null, limit: null })).toEqual({
      ok: true,
      filters: {},
    });
    expect(
      parseRunRecordQuery({ workItemKey: ' a-1 ', statuses: ['failed'], cursor: 'c', limit: 3 }),
    ).toEqual({
      ok: true,
      filters: { workItemKey: 'a-1', statuses: ['failed'], cursor: 'c', limit: 3 },
    });
  });
});

describe('POST /api/internal/ai/search-run-records', () => {
  it('lists the project’s runs newest first with counts, narrows and pages', async () => {
    const a = await card(fx, 'A');
    const b = await card(fx, 'B');
    const first = await openRun(fx, [a.key]);
    await dispatchRunService.close(first, { stopReason: 'drained' }, fx.ctx);
    const second = await openRun(fx, [a.key, b.key]);

    const all = await resultOf(await search({}));
    expect(all.outcome).toBe('found');
    expect(all.runs.map((r: { id: string }) => r.id)).toEqual([second, first]);
    expect(all.runs[0]).toMatchObject({ command: 'run', status: 'running', cardCount: 2 });
    expect(all.runs[0].legs).toMatchObject({ running: 2 });
    expect(all.runs[0]).not.toHaveProperty('cards');
    expect(all.nextCursor).toBeNull();

    const live = await resultOf(await search({ statuses: ['running'] }));
    expect(live.runs.map((r: { id: string }) => r.id)).toEqual([second]);

    const forB = await resultOf(await search({ workItemKey: b.key.toLowerCase() }));
    expect(forB.runs.map((r: { id: string }) => r.id)).toEqual([second]);
    const forAFinished = await resultOf(
      await search({ workItemKey: a.key, statuses: ['succeeded'] }),
    );
    expect(forAFinished.runs.map((r: { id: string }) => r.id)).toEqual([first]);

    const page1 = await resultOf(await search({ limit: 1 }));
    expect(page1.runs).toHaveLength(1);
    expect(page1.nextCursor).toBe(second);
    const page2 = await resultOf(await search({ limit: 1, cursor: page1.nextCursor }));
    expect(page2.runs.map((r: { id: string }) => r.id)).toEqual([first]);
    const cardPage = await resultOf(await search({ workItemKey: a.key, limit: 1 }));
    expect(cardPage.nextCursor).toBe(second);
  });

  it('narrows by scope', async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story' },
      fx.ctx,
    );
    const child = await card(fx, 'Child', { kind: 'subtask', parentId: story.id });
    const loose = await card(fx, 'Loose');
    const scoped = await openRun(fx, [child.key], story.identifier);
    await openRun(fx, [loose.key]);
    const result = await resultOf(await search({ scopeWorkItemKey: story.identifier }));
    expect(result.runs.map((r: { id: string }) => r.id)).toEqual([scoped]);
  });

  it('a search that matches no run is nothing_matched, never an error', async () => {
    const a = await card(fx, 'A');
    expect(await resultOf(await search({}))).toEqual({
      outcome: 'nothing_matched',
      runs: [],
      nextCursor: null,
    });
    expect((await resultOf(await search({ workItemKey: a.key }))).outcome).toBe('nothing_matched');
    for (const body of [
      { workItemKey: `${fx.projectIdentifier}-99999` },
      { workItemKey: 'NODASH' },
      { scopeWorkItemKey: `${fx.projectIdentifier}-99999` },
    ]) {
      expect(await resultOf(await search(body))).toEqual({
        outcome: 'nothing_matched',
        runs: [],
        nextCursor: null,
      });
    }
  });

  it('never returns a run of another project or workspace, nor follows another project’s key', async () => {
    const sibling = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const siblingFx = { ...fx, projectId: sibling.id, projectIdentifier: sibling.identifier };
    const s = await card(siblingFx, 'Sibling card');
    await openRun(siblingFx, [s.key]);
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const r = await card(rival, 'Rival card');
    await openRun(rival, [r.key]);

    expect((await resultOf(await search({}))).outcome).toBe('nothing_matched');
    expect((await resultOf(await search({ workItemKey: s.key }))).outcome).toBe('nothing_matched');
    expect((await resultOf(await search({ workItemKey: r.key }))).outcome).toBe('nothing_matched');
  });

  it('a token whose user cannot browse the project is 404', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const crossed = mintJobToken({
      userId: rival.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect((await search({}, { token: crossed })).status).toBe(404);
  });
});

describe('POST /api/internal/ai/get-run-record', () => {
  it('answers how the run ended and, per leg, what it recorded as different', async () => {
    const a = await card(fx, 'A');
    const b = await card(fx, 'B');
    const runId = await openRun(fx, [a.key, b.key]);
    await runDiscrepancyService.recordDiscrepancy(
      {
        key: a.key,
        points: [POINT],
        decisions: [{ planSaid: 'nothing', chose: 'SENTINEL-CHOSE', why: 'convention' }],
      },
      fx.ctx,
    );
    await dispatchRunService.close(runId, { stopReason: 'drained' }, fx.ctx);

    const result = await resultOf(await getOne({ runId }));
    expect(result.outcome).toBe('found');
    expect(result.run).toMatchObject({
      id: runId,
      command: 'run',
      status: 'succeeded',
      stopReason: 'drained',
      hostedEnd: null,
    });
    expect(result.run.endedAt).toEqual(expect.any(String));
    const [legA, legB] = result.run.legs;
    expect(legA).toMatchObject({ key: a.key, skipReason: null, exitCode: null });
    expect(legA.discrepancy).toMatchObject({
      pointCount: 2,
      decisionCount: 1,
      bodyTruncated: false,
    });
    expect(legA.discrepancy.commentId).toEqual(expect.any(String));
    expect(legA.discrepancy.bodyMd).toContain('SENTINEL-BUILT');
    expect(legA.discrepancy.bodyMd).toContain('SENTINEL-CHOSE');
    expect(legB).toMatchObject({ key: b.key, discrepancy: null });
  });

  it('a hosted end line is carried verbatim and bounded; a long record body is cut and says so', async () => {
    const a = await card(fx, 'A');
    const runId = await openRun(fx, [a.key]);
    await runDiscrepancyService.recordDiscrepancy({ key: a.key, points: [POINT] }, fx.ctx);
    const finding = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: runId, kind: 'discrepancy_recorded' },
    });
    const commentId = (finding.data as { commentId: string }).commentId;
    await adminDb.comment.update({
      where: { id: commentId },
      data: { bodyMd: 'x'.repeat(RUN_RECORD_DISCREPANCY_BODY_MAX + 5) },
    });
    await adminDb.dispatchRun.update({ where: { id: runId }, data: { origin: 'instance' } });
    const seq = (await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: runId } })) + 10;
    await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: runId,
        seq,
        kind: 'log',
        reportedBy: 'cli',
        data: { end: 'stall' },
        body: `stalled: ${'y'.repeat(RUN_RECORD_END_DETAIL_MAX + 50)}`,
      },
    });

    const result = await resultOf(await getOne({ runId }));
    expect(result.run.hostedEnd).toMatchObject({ outcome: 'stall', detailTruncated: true });
    expect(result.run.hostedEnd.detail).toHaveLength(RUN_RECORD_END_DETAIL_MAX);
    expect(result.run.legs[0].discrepancy.bodyTruncated).toBe(true);
    expect(result.run.legs[0].discrepancy.bodyMd).toHaveLength(RUN_RECORD_DISCREPANCY_BODY_MAX);

    await adminDb.comment.delete({ where: { id: commentId } });
    const gone = await resultOf(await getOne({ runId }));
    expect(gone.run.legs[0].discrepancy).toMatchObject({ commentId, bodyMd: null });
  });

  it('a malformed finding pointer is no record', async () => {
    const a = await card(fx, 'A');
    const runId = await openRun(fx, [a.key]);
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { dispatchRunId: runId } });
    for (const [i, data] of [
      [1, ['x']],
      [2, { commentId: 5 }],
      [3, null],
    ] as const) {
      await adminDb.dispatchRunEvent.create({
        data: {
          workspaceId: fx.workspaceId,
          dispatchRunId: runId,
          dispatchRunCardId: leg.id,
          seq: 1000 + i,
          kind: 'discrepancy_recorded',
          reportedBy: 'cli',
          data: data as never,
        },
      });
    }
    const result = await resultOf(await getOne({ runId }));
    expect(result.run.legs[0].discrepancy).toBeNull();
  });

  it('an unknown id, another project’s run and another workspace’s run answer the SAME bytes', async () => {
    const sibling = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const siblingFx = { ...fx, projectId: sibling.id, projectIdentifier: sibling.identifier };
    const s = await card(siblingFx, 'Sibling secret');
    const siblingRun = await openRun(siblingFx, [s.key]);
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const r = await card(rival, 'Rival secret');
    const rivalRun = await openRun(rival, [r.key]);

    const bodies = [];
    for (const runId of ['run_unknown', siblingRun, rivalRun]) {
      const res = await getOne({ runId });
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    expect(bodies[0]).toBe(JSON.stringify({ result: { outcome: 'not_found' } }));
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);

    // A reader who cannot browse the run's project: the same answer.
    const crossed = mintJobToken({
      userId: rival.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    const a = await card(fx, 'Mine');
    const mine = await openRun(fx, [a.key]);
    expect(await (await getOne({ runId: mine }, { token: crossed })).text()).toBe(bodies[0]);
  });

  it('an unexpected failure is rethrown, not dressed as an outcome', async () => {
    vi.spyOn(dispatchRunService, 'getRunDetail').mockRejectedValueOnce(new Error('db down'));
    await expect(runRecordReadService.readRun(fx.projectId, 'r', fx.ctx)).rejects.toThrow(
      'db down',
    );
    vi.spyOn(dispatchRunService, 'listRunsForProject').mockRejectedValueOnce(new Error('db down'));
    await expect(runRecordReadService.searchRuns(fx.projectId, {}, fx.ctx)).rejects.toThrow(
      'db down',
    );
    vi.spyOn(dispatchRunService, 'listRunsForWorkItemKey').mockRejectedValueOnce(
      new Error('db down'),
    );
    const a = await card(fx, 'A');
    await expect(
      runRecordReadService.searchRuns(fx.projectId, { workItemKey: a.key }, fx.ctx),
    ).rejects.toThrow('db down');
  });

  it('is read-only: no run, event or comment row is written by a search or a read', async () => {
    const a = await card(fx, 'A');
    const runId = await openRun(fx, [a.key]);
    await runDiscrepancyService.recordDiscrepancy({ key: a.key, points: [POINT] }, fx.ctx);
    const count = async () => ({
      runs: await adminDb.dispatchRun.count(),
      events: await adminDb.dispatchRunEvent.count(),
      comments: await adminDb.comment.count(),
    });
    const before = await count();
    await search({});
    await search({ workItemKey: a.key });
    await getOne({ runId });
    expect(await count()).toEqual(before);
  });
});

describe('POST /api/internal/ai/search-run-records — the service’s refusals', () => {
  it('a browse denial is 404, any other denial 403, anything else rethrown', async () => {
    const spy = vi.spyOn(runRecordReadService, 'searchRuns');
    spy.mockRejectedValueOnce(new ProjectAccessDeniedError(fx.projectId, 'browse'));
    expect((await search({})).status).toBe(404);
    spy.mockRejectedValueOnce(new ProjectAccessDeniedError(fx.projectId, 'edit'));
    expect((await search({})).status).toBe(403);
    spy.mockRejectedValueOnce(new Error('db down'));
    await expect(search({})).rejects.toThrow('db down');
  });
});
