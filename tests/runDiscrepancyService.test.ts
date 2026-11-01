import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  DiscrepancyAlreadyRecordedError,
  RUN_DISCREPANCY_FIELD_MAX,
  RUN_DISCREPANCY_POINTS_MAX,
  RunDiscrepancyInvalidError,
} from '@/lib/dispatchRuns/errors';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { DISPATCH_RUN_EVENT_LIMIT, dispatchRunService } from '@/lib/services/dispatchRunService';
import { runDiscrepancyService } from '@/lib/services/runDiscrepancyService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from './helpers/workspaceRoleFixtures';

// A RUN'S DISCREPANCY RECORD (Story MOTIR-8651 · Subtask MOTIR-8655) against a real
// Postgres — `runDiscrepancyService.recordDiscrepancy`, as decided in the page MOTIR-8654:
// ONE comment listing the points, ONE pointer-only `discrepancy_recorded` finding per open
// leg, `DISCREPANCY_ALREADY_RECORDED` on a second call, `recorded: false` with no open leg.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const POINT = {
  planAsked: 'SENTINEL-ASKED: call the helper fooBar()',
  built: 'SENTINEL-BUILT: called the equivalent bazQux()',
  why: 'SENTINEL-WHY: fooBar() was retired in the previous release',
};

/** A member whose custom role holds exactly `permissions`, bound to the project. */
async function memberWithRole(
  fx: WorkItemFixture,
  name: string,
  permissions: readonly string[],
): Promise<ServiceContext> {
  const user = await createTestUser({ name });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name,
    permissions: [...permissions],
  });
  const key = fx.projectIdentifier;
  await addToProjectAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  await setProjectRoleAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: role.id,
  });
  return { userId: user.id, workspaceId: fx.workspaceId, tokenProjectId: fx.projectId };
}

async function card(fx: WorkItemFixture, title = 'A card') {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: item.id, key: item.identifier };
}

/** A running dispatch run whose legs for `keys` are all OPEN (claimed). */
async function openLegs(
  fx: WorkItemFixture,
  keys: string[],
  ctx: ServiceContext,
  reportedBy: 'cli' | 'agent' = 'cli',
) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy,
      cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    keys.map((key) => ({
      kind: 'card_claimed' as const,
      workItemKey: key,
      disposition: 'running' as const,
    })),
    ctx,
  );
  return run.id;
}

const record = (key: string, points: unknown[], ctx: ServiceContext) =>
  runDiscrepancyService.recordDiscrepancy({ key, points: points as (typeof POINT)[] }, ctx);

const findings = (workItemId: string) =>
  adminDb.dispatchRunEvent.findMany({
    where: { kind: 'discrepancy_recorded', card: { workItemId } },
  });

describe('validation — refused before anything is resolved or written', () => {
  it('an empty point list, too many points, an empty field and an over-long field', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);

    await expect(record(c.key, [], fx.ctx)).rejects.toMatchObject({ reason: 'points_empty' });
    await expect(
      record(
        c.key,
        Array.from({ length: RUN_DISCREPANCY_POINTS_MAX + 1 }, () => POINT),
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'points_too_many' });
    await expect(record(c.key, [{ ...POINT, why: '   ' }], fx.ctx)).rejects.toMatchObject({
      reason: 'field_empty',
      where: { point: 1, field: 'why' },
    });
    await expect(
      record(
        c.key,
        [POINT, { ...POINT, built: 'x'.repeat(RUN_DISCREPANCY_FIELD_MAX + 1) }],
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'field_too_long', where: { point: 2, field: 'built' } });
    await expect(record(c.key, [], fx.ctx)).rejects.toBeInstanceOf(RunDiscrepancyInvalidError);

    expect(await adminDb.comment.count()).toBe(0);
  });

  it('accepts the maximum: 20 points of 2000 characters', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const big = 'y'.repeat(RUN_DISCREPANCY_FIELD_MAX);
    const points = Array.from({ length: RUN_DISCREPANCY_POINTS_MAX }, () => ({
      planAsked: big,
      built: big,
      why: big,
    }));
    expect(await record(c.key, points, fx.ctx)).toMatchObject({ recorded: false });
  });
});

describe('an open leg — one comment, one pointer-only finding', () => {
  it('three points make ONE comment listing all three and ONE finding with a pointer', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await memberWithRole(fx, 'CLI agent', CLI_TOKEN_GRANT);
    const c = await card(fx);
    await openLegs(fx, [c.key], cli);
    const points = [1, 2, 3].map((n) => ({
      planAsked: `ASKED-${n}`,
      built: `BUILT-${n}`,
      why: `WHY-${n}`,
    }));

    const result = await record(c.key, points, cli);
    expect(result.recorded).toBe(true);

    const comments = await adminDb.comment.findMany({ where: { workItemId: c.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(result.commentId);
    expect(comments[0]!.authorId).toBe(cli.userId);
    for (const n of [1, 2, 3]) {
      expect(comments[0]!.bodyMd).toContain(`ASKED-${n}`);
      expect(comments[0]!.bodyMd).toContain(`BUILT-${n}`);
      expect(comments[0]!.bodyMd).toContain(`WHY-${n}`);
    }

    const events = await findings(c.id);
    expect(events).toHaveLength(1);
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { workItemId: c.id } });
    // A POINTER and a count — exactly these keys, and none of the text.
    expect(events[0]!.data).toEqual({
      commentId: result.commentId,
      pointCount: 3,
      dispatchRunCardId: leg.id,
    });
    expect(JSON.stringify(events[0]!.data)).not.toContain('ASKED');
    expect(events[0]).toMatchObject({
      workspaceId: fx.workspaceId,
      dispatchRunId: leg.dispatchRunId,
      dispatchRunCardId: leg.id,
      reportedBy: 'cli',
    });
  });

  it('an agent-reported run records the finding as reportedBy: agent', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx, 'agent');

    expect((await record(c.key, [POINT], fx.ctx)).recorded).toBe(true);
    expect((await findings(c.id))[0]!.reportedBy).toBe('agent');
  });

  it("a parent run's discrepancy lands on the CHILD's own leg", async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const a = await card(fx, 'Child A');
    const b = await card(fx, 'Child B');
    await openLegs(fx, [a.key, b.key], fx.ctx, 'agent');

    await record(b.key, [POINT], fx.ctx);

    expect(await findings(a.id)).toHaveLength(0);
    expect(await findings(b.id)).toHaveLength(1);
    // …and the sibling can still record its own.
    await record(a.key, [POINT, POINT], fx.ctx);
    expect((await findings(a.id))[0]!.data).toMatchObject({ pointCount: 2 });
  });

  it('a SECOND call on the same leg is refused and writes no second comment', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx);

    await record(c.key, [POINT], fx.ctx);
    await expect(record(c.key, [POINT], fx.ctx)).rejects.toBeInstanceOf(
      DiscrepancyAlreadyRecordedError,
    );

    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(1);
    expect(await findings(c.id)).toHaveLength(1);
  });

  it('two concurrent calls on one leg write exactly one record', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx);

    const settled = await Promise.allSettled([
      record(c.key, [POINT], fx.ctx),
      record(c.key, [POINT], fx.ctx),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const refused = settled.filter((s) => s.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DiscrepancyAlreadyRecordedError,
    );
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(1);
    expect(await findings(c.id)).toHaveLength(1);
  });
});

describe('no open leg — the comment is still written, and that is not an error', () => {
  it('a card on no run answers recorded: false with its comment and no event', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);

    const result = await record(c.key, [POINT], fx.ctx);

    expect(result.recorded).toBe(false);
    const comments = await adminDb.comment.findMany({ where: { workItemId: c.id } });
    expect(comments.map((x) => x.id)).toEqual([result.commentId]);
    expect(await adminDb.dispatchRunEvent.count({ where: { kind: 'discrepancy_recorded' } })).toBe(
      0,
    );
  });

  it('a leg on a CLOSED run is not open', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const runId = await openLegs(fx, [c.key], fx.ctx);
    await dispatchRunService.close(runId, { stopReason: 'completed' }, fx.ctx);

    expect((await record(c.key, [POINT], fx.ctx)).recorded).toBe(false);
  });
});

describe('the edges', () => {
  it('a key with no dash and a key of an unknown project are both WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    await expect(record('NODASH', [POINT], fx.ctx)).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(record('NOPE-1', [POINT], fx.ctx)).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('a point with a MISSING field is refused as an empty field', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await expect(record(c.key, [{ planAsked: 'a', built: 'b' }], fx.ctx)).rejects.toBeInstanceOf(
      RunDiscrepancyInvalidError,
    );
  });

  it('a call made through an automation rule still records', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const result = await record(c.key, [POINT], { ...fx.ctx, viaAutomationRuleId: 'rule-1' });
    expect(result.commentId).toEqual(expect.any(String));
  });

  it('a run already at the event cap keeps the comment and answers recorded: false', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const runId = await openLegs(fx, [c.key], fx.ctx);
    await adminDb.dispatchRunEvent.createMany({
      data: Array.from({ length: DISPATCH_RUN_EVENT_LIMIT }, (_, i) => ({
        workspaceId: fx.workspaceId,
        dispatchRunId: runId,
        seq: 100_000 + i,
        kind: 'card_claimed' as const,
        reportedBy: 'cli' as const,
        data: {},
      })),
    });

    const result = await record(c.key, [POINT], fx.ctx);

    expect(result.recorded).toBe(false);
    expect(await findings(c.id)).toHaveLength(0);
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(1);
  });
});

describe('who may record', () => {
  it('a member holding exactly CLI_TOKEN_GRANT may', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await memberWithRole(fx, 'CLI agent', CLI_TOKEN_GRANT);
    const c = await card(fx);

    expect(CLI_TOKEN_GRANT).toContain('work_item:edit');
    expect((await record(c.key, [POINT], cli)).commentId).toEqual(expect.any(String));
  });

  it('a member who may only browse is refused and nothing is written', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const viewer = await memberWithRole(fx, 'Viewer', ['project:browse']);
    const c = await card(fx);

    await expect(record(c.key, [POINT], viewer)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await adminDb.comment.count()).toBe(0);
  });

  it('an unknown card key is a WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    await expect(record('CUST-9999', [POINT], fx.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

// THE DECISIONS ARM (MOTIR-10000): a run never asks about the implementation — it decides what
// the plan left open and records each decision in this same ONE record, beside the points or
// alone. Points-only calls are covered above and write exactly what they did before.
describe('decisions — the same record, its own section', () => {
  const DECISION = {
    planSaid: 'SENTINEL-SAID: nothing — the card names no retry policy',
    chose: 'SENTINEL-CHOSE: exponential backoff with jitter, three attempts',
    why: 'SENTINEL-WHY: the repository retries every other outbound call this way',
    alternatives: 'SENTINEL-ALT: a fixed delay; no retry at all',
  };
  const recordAll = (key: string, points: unknown[], decisions: unknown[], ctx: ServiceContext) =>
    runDiscrepancyService.recordDiscrepancy(
      {
        key,
        points: points as (typeof POINT)[],
        decisions: decisions as (typeof DECISION)[],
      },
      ctx,
    );

  it('decisions alone make ONE comment and ONE finding counting them', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx, 'agent');

    const { planSaid, chose, why } = DECISION;
    const result = await recordAll(c.key, [], [DECISION, { planSaid, chose, why }], fx.ctx);
    expect(result.recorded).toBe(true);

    const comments = await adminDb.comment.findMany({ where: { workItemId: c.id } });
    expect(comments).toHaveLength(1);
    const body = comments[0]!.bodyMd;
    expect(body).toContain('Decided by the run where the plan was silent');
    expect(body).toContain('2 decisions');
    expect(body).not.toContain('Built through a plan');
    for (const text of Object.values(DECISION)) expect(body).toContain(text);
    // `alternatives` is optional: the second decision carries no such line.
    expect(body.match(/Alternatives considered/g)).toHaveLength(1);

    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { workItemId: c.id } });
    const events = await findings(c.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({
      commentId: result.commentId,
      pointCount: 2,
      decisionCount: 2,
      dispatchRunCardId: leg.id,
    });
    expect(JSON.stringify(events[0]!.data)).not.toContain('SENTINEL');
  });

  it('points and decisions in one call: both sections, the count over every entry', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx);

    await recordAll(c.key, [POINT], [DECISION], fx.ctx);

    const [comment] = await adminDb.comment.findMany({ where: { workItemId: c.id } });
    expect(comment!.bodyMd).toContain('Built through a plan that was wrong about the HOW');
    expect(comment!.bodyMd).toContain(
      '**Decided by the run where the plan was silent** — 1 decision,',
    );
    expect(comment!.bodyMd.indexOf(POINT.planAsked)).toBeLessThan(
      comment!.bodyMd.indexOf(DECISION.planSaid),
    );
    expect((await findings(c.id))[0]!.data).toMatchObject({ pointCount: 2, decisionCount: 1 });

    // …and the leg's ONE record is spent: a decisions-only second call is refused too.
    await expect(recordAll(c.key, [], [DECISION], fx.ctx)).rejects.toBeInstanceOf(
      DiscrepancyAlreadyRecordedError,
    );
  });

  it('no open leg: the decisions comment is still written, recorded: false', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);

    expect(await recordAll(c.key, [], [DECISION], fx.ctx)).toMatchObject({ recorded: false });
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(1);
  });

  it('refuses no entries at all, too many decisions, an empty or an over-long field', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);

    await expect(recordAll(c.key, [], [], fx.ctx)).rejects.toMatchObject({
      reason: 'points_empty',
    });
    await expect(
      recordAll(
        c.key,
        [],
        Array.from({ length: RUN_DISCREPANCY_POINTS_MAX + 1 }, () => DECISION),
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'decisions_too_many' });
    await expect(
      recordAll(c.key, [], [DECISION, { ...DECISION, chose: ' ' }], fx.ctx),
    ).rejects.toMatchObject({ reason: 'field_empty', where: { decision: 2, field: 'chose' } });
    await expect(
      recordAll(
        c.key,
        [],
        [{ ...DECISION, alternatives: 'z'.repeat(RUN_DISCREPANCY_FIELD_MAX + 1) }],
        fx.ctx,
      ),
    ).rejects.toMatchObject({
      reason: 'field_too_long',
      where: { decision: 1, field: 'alternatives' },
    });
    // A blank `alternatives` is the same as none, not an empty field.
    expect(await recordAll(c.key, [], [{ ...DECISION, alternatives: '  ' }], fx.ctx)).toMatchObject(
      { recorded: false },
    );
    expect(await adminDb.comment.count()).toBe(1);
  });

  it('the refusal message names the decision and the field', () => {
    const err = new RunDiscrepancyInvalidError('field_empty', { decision: 3, field: 'why' });
    expect(err.message).toContain('(decision 3, `why`)');
    expect(new RunDiscrepancyInvalidError('decisions_too_many').message).toContain(
      `${RUN_DISCREPANCY_POINTS_MAX} decisions`,
    );
    expect(new RunDiscrepancyInvalidError('points_empty').message).toContain('one decision');
  });
});
