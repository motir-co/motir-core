import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import {
  pointerOf,
  runDiscrepancyBackfillService,
} from '@/lib/services/runDiscrepancyBackfillService';
import { composeDiscrepancyComment } from '@/lib/dispatchRuns/discrepancyComment';
import { runDiscrepancyService } from '@/lib/services/runDiscrepancyService';
import { workItemsService } from '@/lib/services/workItemsService';
import { run as runScript, parseArgs } from '@/scripts/backfill-run-discrepancy-records';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE BACKFILL of run discrepancy records written before they were data (Task MOTIR-11361),
// on a real Postgres. Each legacy state is rebuilt from the real door: record through it, then
// put back what a pre-MOTIR-11361 call left — the comment the door then wrote (composed by the
// same composer) and a finding pointing at it — and delete the structured row. Since
// MOTIR-11996 the door writes no comment, so the comment is written here, as it was then. The
// sweep is asked to put the record back, or to REPORT why it cannot.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const POINT = { planAsked: 'ASKED', built: 'BUILT', why: 'WHY' };
const DECISION = { planSaid: 'nothing', chose: 'CHOSE', why: 'DWHY', alternatives: 'ALT' };

async function card(fx: WorkItemFixture, title = 'A card') {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: item.id, key: item.identifier };
}

async function openLeg(fx: WorkItemFixture, key: string): Promise<string> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key, disposition: 'queued' as const }],
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [{ kind: 'card_claimed' as const, workItemKey: key, disposition: 'running' as const }],
    fx.ctx,
  );
  return run.id;
}

/**
 * A call as the door made it before MOTIR-11996: the record, plus the comment and a finding
 * pointing at that comment by `commentId`. Answers the comment's id and the record's.
 */
async function preCommentless(
  fx: WorkItemFixture,
  key: string,
  input: { points?: (typeof POINT)[]; decisions?: (typeof DECISION)[] },
) {
  const { recordId } = await runDiscrepancyService.recordDiscrepancy({ key, ...input }, fx.ctx);
  const row = await adminDb.runDiscrepancyRecord.findUniqueOrThrow({ where: { id: recordId } });
  const comment = await adminDb.comment.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: row.workItemId,
      authorId: fx.ctx.userId,
      bodyMd: composeDiscrepancyComment(input.points ?? [], input.decisions ?? []),
    },
  });
  await adminDb.runDiscrepancyRecord.update({
    where: { id: recordId },
    data: { commentId: comment.id },
  });
  if (row.dispatchRunCardId !== null) {
    const finding = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { kind: 'discrepancy_recorded', dispatchRunCardId: row.dispatchRunCardId },
    });
    const { recordId: _pointer, ...rest } = finding.data as Record<string, unknown>;
    await adminDb.dispatchRunEvent.update({
      where: { id: finding.id },
      data: { data: { commentId: comment.id, ...rest } as never },
    });
  }
  return { commentId: comment.id, recordId };
}

/** A record as a pre-MOTIR-11361 call left it: the comment (and finding), no row. */
async function legacy(
  fx: WorkItemFixture,
  key: string,
  input: { points?: (typeof POINT)[]; decisions?: (typeof DECISION)[] },
) {
  const { commentId, recordId } = await preCommentless(fx, key, input);
  await adminDb.runDiscrepancyRecord.delete({ where: { id: recordId } });
  return commentId;
}

const rows = () =>
  adminDb.runDiscrepancyRecord.findMany({
    include: { entries: { orderBy: [{ kind: 'asc' }, { position: 'asc' }] } },
    orderBy: { recordedAt: 'asc' },
  });

describe('runDiscrepancyBackfillService.backfill', () => {
  it('puts back a leg’s record and a no-leg record, field by field, and is idempotent', async () => {
    const fx = await makeWorkItemFixture();
    const a = await card(fx, 'A');
    const b = await card(fx, 'B');
    const runId = await openLeg(fx, a.key);
    const legComment = await legacy(fx, a.key, { points: [POINT], decisions: [DECISION] });
    const looseComment = await legacy(fx, b.key, { decisions: [DECISION] });
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { workItemId: a.id } });
    const comments = await adminDb.comment.findMany({
      where: { id: { in: [legComment, looseComment] } },
    });
    const at = new Map(comments.map((c) => [c.id, c.createdAt]));

    const dry = await runDiscrepancyBackfillService.backfill({ dryRun: true });
    expect(dry).toMatchObject({
      dryRun: true,
      total: 2,
      backfilled: 2,
      unreadable: [],
      failed: [],
    });
    expect(await rows()).toEqual([]);

    const applied = await runDiscrepancyBackfillService.backfill({ dryRun: false });
    expect(applied).toMatchObject({ total: 2, examined: 2, backfilled: 2, alreadyRecorded: 0 });
    const [first, second] = await rows();
    expect(first).toMatchObject({
      source: 'backfilled',
      workItemId: a.id,
      projectId: fx.projectId,
      dispatchRunId: runId,
      dispatchRunCardId: leg.id,
      commentId: legComment,
      recordedById: fx.ctx.userId,
      pointCount: 1,
      decisionCount: 1,
      recordedAt: at.get(legComment),
    });
    expect(
      first!.entries.map((e) => [e.kind, e.planText, e.outcomeText, e.why, e.alternatives]),
    ).toEqual([
      ['point', 'ASKED', 'BUILT', 'WHY', null],
      ['decision', 'nothing', 'CHOSE', 'DWHY', 'ALT'],
    ]);
    expect(second).toMatchObject({
      source: 'backfilled',
      workItemId: b.id,
      dispatchRunId: null,
      dispatchRunCardId: null,
      commentId: looseComment,
      pointCount: 0,
      decisionCount: 1,
    });

    const again = await runDiscrepancyBackfillService.backfill({ dryRun: false });
    // The leg's finding is examined again and is already recorded; the loose comment
    // now has a record, so it is no longer a candidate at all.
    expect(again).toMatchObject({ total: 1, backfilled: 0, alreadyRecorded: 1 });
    expect(await rows()).toHaveLength(2);
  });

  it('a deleted or edited comment behind a finding is kept as backfill_unreadable, and reported', async () => {
    const fx = await makeWorkItemFixture();
    const a = await card(fx, 'A');
    const b = await card(fx, 'B');
    await openLeg(fx, a.key);
    await openLeg(fx, b.key);
    const gone = await legacy(fx, a.key, { points: [POINT, POINT], decisions: [DECISION] });
    const edited = await legacy(fx, b.key, { points: [POINT] });
    await adminDb.comment.delete({ where: { id: gone } });
    await adminDb.comment.update({
      where: { id: edited },
      data: { bodyMd: 'rewritten by a person' },
    });

    const report = await runDiscrepancyBackfillService.backfill({ dryRun: false });
    expect(report.backfilled).toBe(0);
    expect(report.unreadable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'finding', workItemId: a.id, reason: 'comment_deleted' }),
        expect.objectContaining({
          from: 'finding',
          workItemId: b.id,
          reason: 'comment_unparseable',
        }),
      ]),
    );
    const stored = await rows();
    expect(
      stored.map((r) => [
        r.workItemId,
        r.source,
        r.commentId,
        r.pointCount,
        r.decisionCount,
        r.entries.length,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [a.id, 'backfill_unreadable', null, 2, 1, 0],
        [b.id, 'backfill_unreadable', edited, 1, 0, 0],
      ]),
    );
  });

  it('a header comment that no longer parses and has no finding is reported, not written', async () => {
    const fx = await makeWorkItemFixture();
    const a = await card(fx);
    const id = await legacy(fx, a.key, { points: [POINT] });
    const body = (await adminDb.comment.findUniqueOrThrow({ where: { id } })).bodyMd;
    await adminDb.comment.update({
      where: { id },
      data: { bodyMd: body.replace('**1.**', '**one**') },
    });

    const report = await runDiscrepancyBackfillService.backfill({ dryRun: false });
    expect(report.unreadable).toEqual([
      { from: 'comment', id, workItemId: a.id, reason: 'comment_unparseable' },
    ]);
    expect(await rows()).toEqual([]);
  });

  it('a malformed finding and a finding whose card was deleted are skipped with their reason', async () => {
    const fx = await makeWorkItemFixture();
    const a = await card(fx, 'A');
    const b = await card(fx, 'B');
    const runA = await openLeg(fx, a.key);
    await openLeg(fx, b.key);
    const legA = await adminDb.dispatchRunCard.findFirstOrThrow({ where: { workItemId: a.id } });
    const bad = await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: runA,
        dispatchRunCardId: legA.id,
        seq: 9_000,
        kind: 'discrepancy_recorded',
        reportedBy: 'cli',
        data: { commentId: 5 },
      },
    });
    await legacy(fx, b.key, { points: [POINT] });
    const findingB = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { kind: 'discrepancy_recorded', card: { workItemId: b.id } },
    });
    await adminDb.workItem.delete({ where: { id: b.id } });

    const report = await runDiscrepancyBackfillService.backfill({ dryRun: false });
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { id: bad.id, reason: 'malformed_finding' },
        { id: findingB.id, reason: 'card_deleted' },
      ]),
    );
    expect(await rows()).toEqual([]);
  });

  it('only the first finding per leg is a candidate', async () => {
    const fx = await makeWorkItemFixture();
    const a = await card(fx);
    const runId = await openLeg(fx, a.key);
    await legacy(fx, a.key, { points: [POINT] });
    const first = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { kind: 'discrepancy_recorded' },
    });
    await adminDb.dispatchRunEvent.create({
      data: {
        ...first,
        id: undefined,
        seq: first.seq + 500,
        data: first.data as never,
        dispatchRunId: runId,
      },
    });
    const report = await runDiscrepancyBackfillService.backfill({ dryRun: false });
    expect(report).toMatchObject({ total: 1, backfilled: 1 });
  });

  it('narrows to one workspace, and stops between candidates when aborted', async () => {
    const fx = await makeWorkItemFixture();
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    await legacy(fx, (await card(fx)).key, { points: [POINT] });
    await legacy(rival, (await card(rival)).key, { points: [POINT] });

    const scoped = await runDiscrepancyBackfillService.backfill({
      dryRun: false,
      workspaceId: rival.workspaceId,
    });
    expect(scoped).toMatchObject({ total: 1, backfilled: 1 });
    expect((await rows()).map((r) => r.workspaceId)).toEqual([rival.workspaceId]);

    const controller = new AbortController();
    controller.abort();
    const stopped = await runDiscrepancyBackfillService.backfill({
      dryRun: false,
      signal: controller.signal,
    });
    expect(stopped).toMatchObject({ interrupted: true, examined: 0, total: 1 });
  });

  it('a candidate whose write fails is reported as failed, and the rest still run', async () => {
    const fx = await makeWorkItemFixture();
    const a = await card(fx, 'A');
    const other = await card(fx, 'Other');
    await legacy(fx, other.key, { points: [POINT] });
    // A comment already recorded on one leg, and a second finding on another leg of the
    // same card pointing at it: its record would collide on the unique comment.
    const runOne = await openLeg(fx, a.key);
    const { commentId } = await preCommentless(fx, a.key, { points: [POINT] });
    await dispatchRunService.close(runOne, { stopReason: 'completed' }, fx.ctx);
    const runTwo = await openLeg(fx, a.key);
    const legTwo = await adminDb.dispatchRunCard.findFirstOrThrow({
      where: { dispatchRunId: runTwo },
    });
    const clash = await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: runTwo,
        dispatchRunCardId: legTwo.id,
        seq: 9_000,
        kind: 'discrepancy_recorded',
        reportedBy: 'cli',
        data: { commentId, pointCount: 1, dispatchRunCardId: legTwo.id },
      },
    });

    const report = await runDiscrepancyBackfillService.backfill({ dryRun: false });
    expect(report.failed.map((f) => f.id)).toEqual([clash.id]);
    expect(report).toMatchObject({ backfilled: 1, alreadyRecorded: 1 });

    const c = { lines: [] as string[] };
    const out = { log: (l: string) => c.lines.push(l), error: (l: string) => c.lines.push(l) };
    expect(await runScript([], { out })).toBe(1);
    expect(c.lines.join('\n')).toContain(`${clash.id} FAILED`);
  });
});

describe('pointerOf', () => {
  it('reads the writer’s pointer and refuses anything else', () => {
    expect(pointerOf({ commentId: 'c', pointCount: 3, decisionCount: 1 })).toEqual({
      commentId: 'c',
      entryCount: 3,
      decisionCount: 1,
    });
    expect(pointerOf({ commentId: 'c', pointCount: -1, decisionCount: 'x' })).toEqual({
      commentId: 'c',
      entryCount: 0,
      decisionCount: 0,
    });
    for (const bad of [null, [], 'x', { commentId: 5 }]) expect(pointerOf(bad)).toBeNull();
  });
});

describe('the script', () => {
  const capture = () => {
    const lines: string[] = [];
    return {
      lines,
      out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`ERR ${l}`) },
    };
  };

  it('parses its flags and refuses an unknown one', () => {
    expect(parseArgs(['--dry-run', '--workspace=w'])).toEqual({ dryRun: true, workspaceId: 'w' });
    expect(() => parseArgs(['--apply'])).toThrow('unknown argument: --apply');
    expect(() => parseArgs(['--workspace='])).toThrow('unknown argument');
  });

  it('prints every unreadable and skipped candidate and the totals; 0 on success', async () => {
    const fx = await makeWorkItemFixture();
    const a = await card(fx);
    await openLeg(fx, a.key);
    const id = await legacy(fx, a.key, { points: [POINT] });
    await adminDb.comment.delete({ where: { id } });

    const dry = capture();
    expect(await runScript(['--dry-run'], { out: dry.out })).toBe(0);
    expect(dry.lines[0]).toContain('DRY RUN');
    expect(dry.lines.join('\n')).toContain(
      'comment_deleted — would be kept as a backfill_unreadable record with its counts',
    );
    expect(dry.lines.join('\n')).toContain('would backfill 0, unreadable 1');
    expect(dry.lines.at(-1)).toContain('Re-run without --dry-run');

    const real = capture();
    expect(await runScript([`--workspace=${fx.workspaceId}`], { out: real.out })).toBe(0);
    expect(real.lines).toContain(`[backfill-run-discrepancy] scope: workspace ${fx.workspaceId}.`);
    expect(real.lines.join('\n')).toContain('backfilled 0, unreadable 1');
    expect(real.lines.at(-1)).toBe('[backfill-run-discrepancy] done.');
  });

  it('answers 1 when interrupted', async () => {
    const fx = await makeWorkItemFixture();
    await legacy(fx, (await card(fx)).key, { points: [POINT] });
    const controller = new AbortController();
    controller.abort();
    const c = capture();
    expect(await runScript([], { out: c.out, signal: controller.signal })).toBe(1);
    expect(c.lines.join('\n')).toContain('INTERRUPTED after 0 of 1');
  });
});
