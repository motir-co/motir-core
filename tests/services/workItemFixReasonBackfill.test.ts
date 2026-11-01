import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import {
  workItemFixReasonBackfillService,
  type FixReasonBackfillProgress,
} from '@/lib/services/workItemFixReasonBackfillService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// `pnpm db:backfill:fix-reason` (Story MOTIR-6588 · MOTIR-6603), driven through its
// entry function — the script's `main()` is argument parsing and console output over
// this call. Real Postgres, no mocks. The stuck cards are built with `fixReason` NULL,
// which is what every row reads before the wiring deploys.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const HEAD = 'c'.repeat(40);

async function card(
  fx: WorkItemFixture,
  status: string,
  checks: Record<string, 'success' | 'failure' | 'pending'> = { Vitest: 'success' },
) {
  const item = await createTestWorkItem(fx, { kind: 'task', title: `card ${randomToken(4)}` });
  await setStatus(item.id, status);
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  const pr = await deliveredPr(fx, item.id, repo, { headRef: `subtask/${randomToken(4)}`, checks });
  return { item, repo, pr };
}

/** One card per reason, plus a green one, a done one, and an archived stuck one. */
async function scenario(fx: WorkItemFixture) {
  // A card whose run DIED before `run_died` existed (MOTIR-6880): In Progress, its
  // local run silent for ten minutes, nothing but the backfill left to notice it.
  const died = await createTestWorkItem(fx, { kind: 'task', title: 'a card whose run died' });
  await setStatus(died.id, 'in_progress');
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: died.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'checkout_ready',
        workItemKey: died.identifier,
        disposition: 'running',
        data: { branch: `subtask/${died.identifier}-work` },
      },
    ],
    fx.ctx,
  );
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
  });

  const red = await card(fx, 'implemented', { Vitest: 'failure' });

  const queued = await card(fx, 'implemented');
  await adminDb.githubPullRequestQueueExit.create({
    data: {
      pullRequestId: queued.pr.id,
      deliveryId: `guid-${randomToken(8)}`,
      rawReason: 'CI_FAILURE',
      disposition: 'failure',
      headSha: HEAD,
      exitedAt: new Date('2026-09-18T10:00:00.000Z'),
      failingCheckName: 'Merge queue / e2e',
    },
  });

  const conflicted = await card(fx, 'implemented');
  await adminDb.githubPullRequest.update({
    where: { id: conflicted.pr.id },
    data: { mergeableState: 'dirty', mergeableStateHeadSha: HEAD },
  });

  const sentBack = await card(fx, 'in_review');
  await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: sentBack.item.id,
      kind: 'pull_request_approval',
      subjectId: sentBack.item.id,
      subjectVersion: `acme/${sentBack.repo.name}#${sentBack.pr.number}@${HEAD}`,
      state: 'changes_requested',
      decidedById: fx.ownerId,
      decidedAt: new Date('2026-09-26T10:00:00Z'),
      decidedByLabel: 'Yue Zhu',
      decisionSource: 'ui',
      decidedUnderAuthority: 'assignee',
      noteMd: 'Rename the export button.',
    },
  });

  const green = await card(fx, 'implemented');
  const done = await card(fx, 'done', { Vitest: 'failure' });
  const archived = await card(fx, 'implemented', { Vitest: 'failure' });
  await adminDb.workItem.update({
    where: { id: archived.item.id },
    data: { archivedAt: new Date() },
  });

  return { died, red, queued, conflicted, sentBack, green, done, archived };
}

async function reasonOf(id: string) {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).fixReason;
}

describe('backfillFixReason', () => {
  it('the dry run reports every reason and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const s = await scenario(fx);
    const before = await adminDb.workItem.findMany({ orderBy: { id: 'asc' } });

    const report = await workItemFixReasonBackfillService.backfillFixReason({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.byReason).toEqual({
      run_died: 1,
      queue_failed: 1,
      conflicted: 1,
      out_of_date: 0,
      ci_failed: 1,
      changes_requested: 1,
      none: 1,
    });
    expect(report.changed).toHaveLength(5);
    expect(report.skippedArchived).toBe(1);
    expect(report.failed).toEqual([]);
    expect(await adminDb.workItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await reasonOf(s.red.item.id)).toBeNull();
  });

  it('apply sets each reason, skips done and archived cards, and a second apply changes 0', async () => {
    const fx = await makeWorkItemFixture();
    const s = await scenario(fx);

    const first = await workItemFixReasonBackfillService.backfillFixReason({ dryRun: false });

    expect(first.failed).toEqual([]);
    expect(first.total).toBe(7); // six in-progress-category cards + the archived one
    expect(first.scanned).toBe(7);
    expect(first.skippedArchived).toBe(1);
    expect(new Map(first.changed.map((c) => [c.workItemId, [c.from, c.to]]))).toEqual(
      new Map([
        [s.died.id, [null, 'run_died']],
        [s.red.item.id, [null, 'ci_failed']],
        [s.queued.item.id, [null, 'queue_failed']],
        [s.conflicted.item.id, [null, 'conflicted']],
        [s.sentBack.item.id, [null, 'changes_requested']],
      ]),
    );
    expect(first.unchanged).toBe(1); // the green card
    expect(await reasonOf(s.died.id)).toBe('run_died');
    expect(await reasonOf(s.red.item.id)).toBe('ci_failed');
    expect(await reasonOf(s.queued.item.id)).toBe('queue_failed');
    expect(await reasonOf(s.conflicted.item.id)).toBe('conflicted');
    expect(await reasonOf(s.sentBack.item.id)).toBe('changes_requested');
    expect(await reasonOf(s.done.item.id)).toBeNull();
    expect(await reasonOf(s.archived.item.id)).toBeNull();

    const second = await workItemFixReasonBackfillService.backfillFixReason({ dryRun: false });
    expect(second.changed).toEqual([]);
    expect(second.unchanged).toBe(6);
    expect(second.byReason).toEqual(first.byReason);
  });

  it('clears a stale reason on a card that has left the in-progress category', async () => {
    const fx = await makeWorkItemFixture();
    const { item } = await card(fx, 'done', { Vitest: 'failure' });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { fixReason: 'ci_failed', fixDetail: { repair: 'fix' } },
    });

    const report = await workItemFixReasonBackfillService.backfillFixReason({ dryRun: false });

    expect(report.changed).toEqual([
      { workItemId: item.id, identifier: item.identifier, from: 'ci_failed', to: null },
    ]);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.fixReason).toBeNull();
    expect(row.fixDetail).toBeNull();
  });

  it('--workspace narrows the sweep to one tenant', async () => {
    const mine = await makeWorkItemFixture();
    const other = await makeWorkItemFixture();
    const a = await card(mine, 'implemented', { Vitest: 'failure' });
    const b = await card(other, 'implemented', { Vitest: 'failure' });

    const report = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: false,
      workspaceId: mine.workspaceId,
    });

    expect(report.changed.map((c) => c.workItemId)).toEqual([a.item.id]);
    expect(await reasonOf(b.item.id)).toBeNull();
  });

  it('reports progress, and an aborted sweep returns its partial report', async () => {
    const fx = await makeWorkItemFixture();
    await card(fx, 'implemented', { Vitest: 'failure' });
    await card(fx, 'implemented', { Vitest: 'failure' });
    const seen: FixReasonBackfillProgress[] = [];

    const full = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: true,
      progressEvery: 1,
      onProgress: (p) => seen.push(p),
    });
    expect(seen.map((p) => p.examined)).toEqual([1, 2]);
    expect(full.interrupted).toBe(false);

    const controller = new AbortController();
    controller.abort();
    const partial = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: true,
      signal: controller.signal,
    });
    expect(partial).toMatchObject({ interrupted: true, scanned: 0, total: 2 });
  });

  it('a card whose write fails is recorded as a failure and the sweep carries on', async () => {
    const fx = await makeWorkItemFixture();
    const bad = await card(fx, 'implemented', { Vitest: 'failure' });
    const good = await card(fx, 'implemented', { Vitest: 'failure' });
    // A real database refusal for ONE card: a trigger that rejects its update.
    await adminDb.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fix_reason_backfill_test_reject() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = '${bad.item.id}' THEN RAISE EXCEPTION 'rejected for the test'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await adminDb.$executeRawUnsafe(`
      CREATE TRIGGER fix_reason_backfill_test_reject BEFORE UPDATE ON "work_item"
      FOR EACH ROW EXECUTE FUNCTION fix_reason_backfill_test_reject()`);
    try {
      const report = await workItemFixReasonBackfillService.backfillFixReason({ dryRun: false });

      expect(report.failed).toEqual([
        { workItemId: bad.item.id, error: expect.stringContaining('rejected for the test') },
      ]);
      expect(report.scanned).toBe(2);
      expect(await reasonOf(good.item.id)).toBe('ci_failed');
      expect(await reasonOf(bad.item.id)).toBeNull();
    } finally {
      await adminDb.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS fix_reason_backfill_test_reject ON "work_item"',
      );
      await adminDb.$executeRawUnsafe('DROP FUNCTION IF EXISTS fix_reason_backfill_test_reject()');
    }
  });
});
