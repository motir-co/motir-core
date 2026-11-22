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
// ONE record holding the points, ONE pointer-only `discrepancy_recorded` finding per open
// leg, `DISCREPANCY_ALREADY_RECORDED` on a second call, `recorded: false` with no open leg.
// Since MOTIR-11996 it writes NO comment: the card shows the record in its own section.

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

describe('an open leg — one record, one pointer-only finding, no comment', () => {
  it('three points make ONE record holding all three and ONE finding with a pointer', async () => {
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

    // MOTIR-11996: no comment on the card — the record is what the card shows.
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(0);
    const [row] = await records(c.id);
    expect(row!.id).toBe(result.recordId);
    expect(row!.recordedById).toBe(cli.userId);
    expect(row!.commentId).toBeNull();
    expect(row!.entries.map((e) => [e.planText, e.outcomeText, e.why])).toEqual(
      [1, 2, 3].map((n) => [`ASKED-${n}`, `BUILT-${n}`, `WHY-${n}`]),
    );

    const events = await findings(c.id);
    expect(events).toHaveLength(1);
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { workItemId: c.id } });
    // A POINTER and a count — exactly these keys, and none of the text.
    expect(events[0]!.data).toEqual({
      recordId: result.recordId,
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

  it('a SECOND call on the same leg is refused and writes no second record', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx);

    await record(c.key, [POINT], fx.ctx);
    await expect(record(c.key, [POINT], fx.ctx)).rejects.toBeInstanceOf(
      DiscrepancyAlreadyRecordedError,
    );

    expect(await records(c.id)).toHaveLength(1);
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(0);
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
    expect(await records(c.id)).toHaveLength(1);
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(0);
    expect(await findings(c.id)).toHaveLength(1);
  });
});

describe('no open leg — the record is still written, and that is not an error', () => {
  it('a card on no run answers recorded: false with its record, no comment and no event', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);

    const result = await record(c.key, [POINT], fx.ctx);

    expect(result.recorded).toBe(false);
    expect((await records(c.id)).map((x) => x.id)).toEqual([result.recordId]);
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(0);
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
    expect(result.recordId).toEqual(expect.any(String));
  });

  it('a run already at the event cap keeps the record and answers recorded: false', async () => {
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
    expect(await records(c.id)).toHaveLength(1);
  });
});

describe('who may record', () => {
  it('a member holding exactly CLI_TOKEN_GRANT may', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await memberWithRole(fx, 'CLI agent', CLI_TOKEN_GRANT);
    const c = await card(fx);

    expect(CLI_TOKEN_GRANT).toContain('work_item:edit');
    expect((await record(c.key, [POINT], cli)).recordId).toEqual(expect.any(String));
  });

  it('a member who may only browse is refused and nothing is written', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const viewer = await memberWithRole(fx, 'Viewer', ['project:browse']);
    const c = await card(fx);

    await expect(record(c.key, [POINT], viewer)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await adminDb.runDiscrepancyRecord.count()).toBe(0);
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

  it('decisions alone make ONE record and ONE finding counting them', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx, 'agent');

    const { planSaid, chose, why } = DECISION;
    const result = await recordAll(c.key, [], [DECISION, { planSaid, chose, why }], fx.ctx);
    expect(result.recorded).toBe(true);

    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(0);
    const [row] = await records(c.id);
    expect(row).toMatchObject({ pointCount: 0, decisionCount: 2 });
    expect(row!.entries.every((e) => e.kind === 'decision')).toBe(true);
    expect(row!.entries[0]).toMatchObject({
      planText: DECISION.planSaid,
      outcomeText: DECISION.chose,
      why: DECISION.why,
      alternatives: DECISION.alternatives,
    });
    // `alternatives` is optional: the second decision carries none.
    expect(row!.entries[1]!.alternatives).toBeNull();

    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { workItemId: c.id } });
    const events = await findings(c.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({
      recordId: result.recordId,
      pointCount: 2,
      decisionCount: 2,
      dispatchRunCardId: leg.id,
    });
    expect(JSON.stringify(events[0]!.data)).not.toContain('SENTINEL');
  });

  it('points and decisions in one call: both kinds stored, the count over every entry', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx);

    await recordAll(c.key, [POINT], [DECISION], fx.ctx);

    const [row] = await records(c.id);
    expect(row!.entries.map((e) => [e.kind, e.planText])).toEqual([
      ['point', POINT.planAsked],
      ['decision', DECISION.planSaid],
    ]);
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(0);
    expect((await findings(c.id))[0]!.data).toMatchObject({ pointCount: 2, decisionCount: 1 });

    // …and the leg's ONE record is spent: a decisions-only second call is refused too.
    await expect(recordAll(c.key, [], [DECISION], fx.ctx)).rejects.toBeInstanceOf(
      DiscrepancyAlreadyRecordedError,
    );
  });

  it('no open leg: the decisions record is still written, recorded: false', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);

    expect(await recordAll(c.key, [], [DECISION], fx.ctx)).toMatchObject({ recorded: false });
    expect(await records(c.id)).toHaveLength(1);
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(0);
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
    expect(await adminDb.runDiscrepancyRecord.count()).toBe(1);
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

// ── MOTIR-11361 — the record is DATA (and since MOTIR-11996, the only write) ──

const records = (workItemId: string) =>
  adminDb.runDiscrepancyRecord.findMany({
    where: { workItemId },
    include: { entries: { orderBy: [{ kind: 'asc' }, { position: 'asc' }] } },
  });

describe('the structured record (MOTIR-11361)', () => {
  it('stores every point and decision field by field, tied to the leg and run', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const runId = await openLegs(fx, [c.key], fx.ctx);
    const decision = { planSaid: 'nothing', chose: 'CHOSE', why: 'WHY', alternatives: 'ALT' };

    const result = await runDiscrepancyService.recordDiscrepancy(
      {
        key: c.key,
        points: [POINT, { planAsked: '  padded  ', built: 'b', why: 'w' }],
        decisions: [decision, { planSaid: 's', chose: 'c', why: 'w', alternatives: '  ' }],
      },
      fx.ctx,
    );

    const [row] = await records(c.id);
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { workItemId: c.id } });
    expect(row).toMatchObject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      dispatchRunId: runId,
      dispatchRunCardId: leg.id,
      id: result.recordId,
      commentId: null,
      recordedById: fx.ctx.userId,
      source: 'recorded',
      pointCount: 2,
      decisionCount: 2,
    });
    expect(
      row!.entries.map(({ kind, position, planText, outcomeText, why, alternatives }) => ({
        kind,
        position,
        planText,
        outcomeText,
        why,
        alternatives,
      })),
    ).toEqual([
      {
        kind: 'point',
        position: 1,
        planText: POINT.planAsked,
        outcomeText: POINT.built,
        why: POINT.why,
        alternatives: null,
      },
      {
        kind: 'point',
        position: 2,
        planText: 'padded',
        outcomeText: 'b',
        why: 'w',
        alternatives: null,
      },
      {
        kind: 'decision',
        position: 1,
        planText: 'nothing',
        outcomeText: 'CHOSE',
        why: 'WHY',
        alternatives: 'ALT',
      },
      {
        kind: 'decision',
        position: 2,
        planText: 's',
        outcomeText: 'c',
        why: 'w',
        alternatives: null,
      },
    ]);
    expect(row!.entries.every((e) => e.workspaceId === fx.workspaceId)).toBe(true);
  });

  it('a comment an EARLIER run wrote is linked, and deleting it leaves the record whole', async () => {
    // Before MOTIR-11996 the door wrote a comment beside the record; such rows still carry its
    // id. Simulate one by linking a comment by hand: deleting it nulls the pointer only.
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    await openLegs(fx, [c.key], fx.ctx);
    const { recordId } = await record(c.key, [POINT], fx.ctx);
    const comment = await adminDb.comment.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: c.id,
        authorId: fx.ctx.userId,
        bodyMd: 'the legacy comment',
      },
    });
    await adminDb.runDiscrepancyRecord.update({
      where: { id: recordId },
      data: { commentId: comment.id },
    });

    await adminDb.comment.update({ where: { id: comment.id }, data: { bodyMd: 'rewritten' } });
    expect((await records(c.id))[0]!.entries[0]!.outcomeText).toBe(POINT.built);

    await adminDb.comment.delete({ where: { id: comment.id } });
    const [row] = await records(c.id);
    expect(row!.commentId).toBeNull();
    expect(row!.entries.map((e) => e.planText)).toEqual([POINT.planAsked]);
  });

  it('no open leg: still stored, tied to the card and project with no run', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const result = await record(c.key, [POINT], fx.ctx);
    expect(result.recorded).toBe(false);
    expect(await records(c.id)).toEqual([
      expect.objectContaining({
        projectId: fx.projectId,
        workItemId: c.id,
        dispatchRunId: null,
        dispatchRunCardId: null,
        id: result.recordId,
        commentId: null,
        pointCount: 1,
        decisionCount: 0,
      }),
    ]);
  });

  it('a refused call writes no record; a second call on a leg is refused by the record too', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const c = await card(fx);
    const runId = await openLegs(fx, [c.key], fx.ctx);
    // At the event cap the first call writes a record and NO finding…
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
    expect((await record(c.key, [POINT], fx.ctx)).recorded).toBe(false);
    expect(await records(c.id)).toHaveLength(1);
    // …so the record, not the finding, is what refuses the second.
    await expect(record(c.key, [POINT], fx.ctx)).rejects.toBeInstanceOf(
      DiscrepancyAlreadyRecordedError,
    );
    expect(await records(c.id)).toHaveLength(1);
    expect(await adminDb.comment.count({ where: { workItemId: c.id } })).toBe(0);

    await expect(record(c.key, [], fx.ctx)).rejects.toBeInstanceOf(RunDiscrepancyInvalidError);
    expect(await records(c.id)).toHaveLength(1);
  });
});
