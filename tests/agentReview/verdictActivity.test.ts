import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { activityService, ACTIVITY_PAGE_SIZE } from '@/lib/services/activityService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { reviewSentBackService } from '@/lib/services/reviewSentBackService';
import { reviewVerdictRecordService } from '@/lib/services/reviewVerdictRecordService';
import { readApprovedReviews, approvedReviewKey } from '@/lib/services/reviewStateService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { HOSTED_REVIEW_HARNESS } from '@/lib/agentReview/reviewState';
import type { ActivityAgentVerdictPartDto, ActivityEntryDto } from '@/lib/dto/activity';
import type { ReviewVerdictOutcome } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// AGENT VERDICTS, READ BACK (Story MOTIR-10327 · MOTIR-10338), against REAL Postgres.
//
// Every verdict is written through `reviewVerdictRecordService.record` — the one write both
// verdict doors call — so what is asserted here is what production writes:
//
//   · the card's History and All views carry ONE entry per record, at every version and
//     outcome, in time order with the other revisions, across the feed's cursor;
//   · an answering send-back notifies the assignee ONCE (a retry writes nothing more), and a
//     pass, a late or a second verdict notifies nobody;
//   · the approvals room's decided rows say which review the approval stood on, read at the
//     APPROVED version — a later pass at a new head does not change an old row — and a
//     record in another workspace is never read.

const V1 = 'moooon/acme#1@1111111111111111111111111111111111111111';
const V2 = 'moooon/acme#1@2222222222222222222222222222222222222222';
const V3 = 'moooon/acme#1@3333333333333333333333333333333333333333';

let fx: WorkItemFixture;
let assigneeId: string;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "approval_gate", "work_item", "notification" RESTART IDENTITY CASCADE',
  );
  spyOnJobDispatch();
  fx = await makeWorkItemFixture();
  const assignee = await createTestUser({ email: 'ana@ex.com', name: 'Ana Lima' });
  await workspacesService.addMember({ userId: assignee.id, workspaceId: fx.workspaceId });
  assigneeId = assignee.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function card(title = 'Export the invoice list'): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId } });
  return item.id;
}

async function verdict(
  workItemId: string,
  opts: {
    version: string;
    verdict: 'pass' | 'changes_requested';
    outcome: ReviewVerdictOutcome;
    hosted?: boolean;
    submittedById?: string;
    findingsMd?: string | null;
    at?: Date;
  },
  f: WorkItemFixture = fx,
) {
  const record = await withWorkspaceContext(f.ctx, (tx) =>
    reviewVerdictRecordService.record(
      {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        workItemId,
        gateId: null,
        subjectVersion: opts.version,
        verdict: opts.verdict,
        outcome: opts.outcome,
        summaryMd: 'Summary.',
        findingsMd:
          opts.findingsMd === undefined
            ? opts.verdict === 'changes_requested'
              ? '| row | status |\n|---|---|\n| export | not_met |\n\n**major** — no header row.'
              : null
            : opts.findingsMd,
        checklist: [],
        submittedById: opts.submittedById ?? f.ownerId,
        harness: opts.hosted ? HOSTED_REVIEW_HARNESS : 'Claude Code',
        model: 'claude-opus-5-5',
      },
      tx,
    ),
  );
  if (opts.at) {
    await adminDb.reviewVerdictRecord.update({
      where: { id: record.id },
      data: { createdAt: opts.at },
    });
  }
  return record;
}

async function sentBackNotifications() {
  return adminDb.notification.findMany({ where: { type: 'review_sent_back' } });
}

const verdictPart = (entry: ActivityEntryDto): ActivityAgentVerdictPartDto | undefined =>
  entry.parts.find((p): p is ActivityAgentVerdictPartDto => p.kind === 'agentVerdict');

describe('the activity feed — one entry per recorded verdict, at every version', () => {
  it('History carries a pass, a send-back, a late and a second verdict, newest first, each named', async () => {
    const id = await card();
    const pass = await verdict(id, {
      version: V1,
      verdict: 'pass',
      outcome: 'recorded',
      hosted: true,
    });
    const sendBack = await verdict(id, {
      version: V2,
      verdict: 'changes_requested',
      outcome: 'decided',
    });
    const late = await verdict(id, { version: V1, verdict: 'pass', outcome: 'late' });
    const second = await verdict(id, {
      version: V2,
      verdict: 'changes_requested',
      outcome: 'second',
    });

    const page = await activityService.listHistory(id, {}, fx.ctx);
    const verdicts = page.entries.filter((e) => e.changeKind === 'agent_verdict');
    expect(verdicts.map((e) => verdictPart(e)?.recordId)).toEqual([
      second.id,
      late.id,
      sendBack.id,
      pass.id,
    ]);
    // The other revisions (the create) are still in the same stream, after them.
    expect(page.entries.at(-1)?.changeKind).not.toBe('agent_verdict');

    const byId = new Map(verdicts.map((e) => [verdictPart(e)?.recordId, e] as const));
    expect(verdictPart(byId.get(pass.id)!)).toMatchObject({
      verdict: 'pass',
      outcome: 'recorded',
      hosted: true,
      harness: HOSTED_REVIEW_HARNESS,
      model: 'claude-opus-5-5',
      subjectVersion: V1,
      findingsExcerpt: null,
      notified: null,
    });
    const sendBackEntry = byId.get(sendBack.id)!;
    expect(sendBackEntry.actor.userId).toBe(fx.ownerId);
    expect(verdictPart(sendBackEntry)).toMatchObject({
      verdict: 'changes_requested',
      outcome: 'decided',
      hosted: false,
      harness: 'Claude Code',
      subjectVersion: V2,
      notified: { type: 'user', userId: assigneeId, name: 'Ana Lima' },
    });
    expect(verdictPart(sendBackEntry)?.findingsExcerpt).toContain('no header row');
    expect(verdictPart(byId.get(late.id)!)).toMatchObject({ outcome: 'late', notified: null });
    expect(verdictPart(byId.get(second.id)!)).toMatchObject({ outcome: 'second', notified: null });
  });

  it('All carries the same entries, merged in time order with the trail', async () => {
    const id = await card();
    const a = await verdict(id, { version: V1, verdict: 'pass', outcome: 'recorded' });
    await workItemsService.updateWorkItem(id, { title: 'Export the invoice list as CSV' }, fx.ctx);
    const b = await verdict(id, { version: V2, verdict: 'changes_requested', outcome: 'decided' });

    const page = await activityService.listAll(id, { order: 'asc' }, fx.ctx);
    const kinds = page.entries.map((e) =>
      e.type === 'history' ? (verdictPart(e.entry)?.recordId ?? e.entry.changeKind) : 'comment',
    );
    expect(kinds).toEqual(['created', a.id, 'updated', b.id]);
    expect(page.totalChanges).toBe(4);
  });

  it('pages across verdicts with the feed’s own cursor — every entry once', async () => {
    const id = await card();
    const total = ACTIVITY_PAGE_SIZE + 3;
    for (let i = 0; i < total; i++) {
      // Late verdicts decide nothing, so any number may stand at distinct versions.
      await verdict(id, {
        version: `moooon/acme#1@${String(i).padStart(40, '0')}`,
        verdict: 'pass',
        outcome: 'late',
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await activityService.listHistory(id, { cursor }, fx.ctx);
      for (const e of page.entries) {
        const part = verdictPart(e);
        if (part) seen.push(part.recordId);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('a verdict whose submitter is gone writes no trail entry, and still records', async () => {
    const id = await card();
    const record = await withWorkspaceContext(fx.ctx, (tx) =>
      reviewVerdictRecordService.record(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: id,
          gateId: null,
          subjectVersion: V1,
          verdict: 'pass',
          outcome: 'recorded',
          summaryMd: null,
          findingsMd: null,
          checklist: [],
          submittedById: null,
          harness: HOSTED_REVIEW_HARNESS,
          model: 'm',
        },
        tx,
      ),
    );
    expect(record.id).toBeTruthy();
    const page = await activityService.listHistory(id, {}, fx.ctx);
    expect(page.entries.some((e) => e.changeKind === 'agent_verdict')).toBe(false);
  });
});

describe('a send-back notifies the assignee once', () => {
  it('an answering send-back writes one notification, linked to the record', async () => {
    const id = await card();
    const record = await verdict(id, {
      version: V1,
      verdict: 'changes_requested',
      outcome: 'recorded',
    });
    const rows = await sentBackNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientUserId: assigneeId,
      workItemId: id,
      category: 'direct',
      dedupeKey: `review_sent_back:${record.id}`,
    });
    expect(rows[0]?.data).toMatchObject({ kind: 'review_sent_back', recordId: record.id });

    // A retry of the same notice (a redelivered job, a reload) writes nothing more.
    await reviewSentBackService.notify(fx.workspaceId, record.id, id, assigneeId);
    expect(await sentBackNotifications()).toHaveLength(1);

    // A second verdict at the version notifies nobody.
    await verdict(id, { version: V1, verdict: 'changes_requested', outcome: 'second' });
    expect(await sentBackNotifications()).toHaveLength(1);
  });

  it('a pass, a late and a second verdict notify nobody', async () => {
    const id = await card();
    await verdict(id, { version: V1, verdict: 'pass', outcome: 'decided' });
    await verdict(id, { version: V2, verdict: 'changes_requested', outcome: 'late' });
    await verdict(id, { version: V1, verdict: 'changes_requested', outcome: 'second' });
    expect(await sentBackNotifications()).toHaveLength(0);
  });

  it('the assignee whose OWN agent sent it back is not told what they just ran', async () => {
    const id = await card();
    await verdict(id, {
      version: V1,
      verdict: 'changes_requested',
      outcome: 'decided',
      submittedById: assigneeId,
    });
    expect(await sentBackNotifications()).toHaveLength(0);
    // …but the hosted agent's send-back, run under their name, does tell them.
    await verdict(id, {
      version: V2,
      verdict: 'changes_requested',
      outcome: 'decided',
      submittedById: assigneeId,
      hosted: true,
    });
    expect(await sentBackNotifications()).toHaveLength(1);
  });

  it('an assignee who turned the event off in-app is not written to', async () => {
    const id = await card();
    await adminDb.notificationPreference.create({
      data: {
        userId: assigneeId,
        eventType: 'review_sent_back',
        channel: 'in_app',
        enabled: false,
      },
    });
    const record = await verdict(id, {
      version: V1,
      verdict: 'changes_requested',
      outcome: 'decided',
    });
    expect(await sentBackNotifications()).toHaveLength(0);
    expect(await reviewSentBackService.notify(fx.workspaceId, record.id, id, assigneeId)).toBe(
      'off',
    );
  });

  it('a card with no assignee notifies nobody', async () => {
    const id = await card();
    await adminDb.workItem.update({ where: { id }, data: { assigneeId: null } });
    await verdict(id, { version: V1, verdict: 'changes_requested', outcome: 'decided' });
    expect(await sentBackNotifications()).toHaveLength(0);
  });
});

describe('the approval record line — read at the APPROVED version', () => {
  async function approvedMerge(workItemId: string, version: string, f: WorkItemFixture = fx) {
    return adminDb.approvalGate.create({
      data: {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        workItemId,
        kind: 'pull_request_approval',
        subjectId: workItemId,
        subjectVersion: version,
        state: 'approved',
        decidedById: f.ownerId,
        decidedAt: new Date(),
        decidedByLabel: 'Owner Person <owner@ex.com>',
        decidedUnderAuthority: 'assignee',
      },
    });
  }

  async function decidedReviews() {
    const page = await approvalGatesService.listRecords(
      { ...fx.ctx, projectId: fx.projectId },
      { limit: 100 },
    );
    return new Map(page.sections.decided.items.map((r) => [r.workItem?.title, r.review] as const));
  }

  it('names the review each approval stood on — reviewed, skipped, dismissed, none', async () => {
    const reviewed = await card('reviewed');
    await verdict(reviewed, { version: V1, verdict: 'pass', outcome: 'recorded' });
    // A LATER pass at a new head never rewrites the old approval's line.
    await verdict(reviewed, { version: V2, verdict: 'pass', outcome: 'recorded' });
    await approvedMerge(reviewed, V1);

    const skipped = await card('skipped');
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: skipped,
        kind: 'agent_review',
        subjectId: skipped,
        subjectVersion: V1,
        state: 'approved',
        decidedById: assigneeId,
        decidedAt: new Date(),
        decidedByLabel: 'Ana Lima <ana@ex.com>',
        decidedUnderAuthority: 'assignee',
        noteMd: 'The agent cannot reach the staging database.',
      },
    });
    await approvedMerge(skipped, V1);

    const dismissed = await card('dismissed');
    const sendBack = await verdict(dismissed, {
      version: V1,
      verdict: 'changes_requested',
      outcome: 'recorded',
    });
    await adminDb.reviewDismissal.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: dismissed,
        reviewVerdictRecordId: sendBack.id,
        subjectVersion: V1,
        reasonMd: 'The finding is about code this work item does not change.',
        dismissedById: assigneeId,
      },
    });
    await approvedMerge(dismissed, V1);

    const none = await card('none');
    // A pass at ANOTHER version is not a review of the approved one.
    await verdict(none, { version: V3, verdict: 'pass', outcome: 'recorded' });
    await approvedMerge(none, V1);

    const reviews = await decidedReviews();
    expect(reviews.get('reviewed')).toEqual({
      kind: 'reviewed',
      commits: 'moooon/acme#1 @ 1111111',
    });
    expect(reviews.get('skipped')).toEqual({
      kind: 'skipped',
      by: 'Ana Lima',
      reason: 'The agent cannot reach the staging database.',
    });
    expect(reviews.get('dismissed')).toEqual({
      kind: 'dismissed',
      by: 'Ana Lima',
      reason: 'The finding is about code this work item does not change.',
    });
    expect(reviews.get('none')).toEqual({ kind: 'none' });
  });

  it('only an approved merge carries the line; every other decided row is null', async () => {
    const id = await card('sent back');
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: id,
        kind: 'pull_request_approval',
        subjectId: id,
        subjectVersion: V1,
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date(),
        decidedByLabel: 'Owner Person <owner@ex.com>',
      },
    });
    expect((await decidedReviews()).get('sent back')).toBeNull();
  });

  it('the Done card’s gate read carries the same line', async () => {
    const id = await card('done');
    await verdict(id, { version: V1, verdict: 'pass', outcome: 'recorded' });
    await approvedMerge(id, V1);
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: id, kind: 'pull_request_approval' },
      fx.ctx,
    );
    expect(read.approvedReview).toEqual({ kind: 'reviewed', commits: 'moooon/acme#1 @ 1111111' });
  });

  it('never reads another workspace’s records', async () => {
    const id = await card('ours');
    await verdict(id, { version: V1, verdict: 'pass', outcome: 'recorded' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    // Read under the OTHER workspace's context, the first workspace's pass is invisible.
    const seen = await withWorkspaceContext(other.ctx, (tx) =>
      readApprovedReviews([{ workItemId: id, subjectVersion: V1 }], tx),
    );
    expect(seen.get(approvedReviewKey(id, V1))).toEqual({ kind: 'none' });
    // And under its own, it is read.
    const ours = await withWorkspaceContext(fx.ctx, (tx) =>
      readApprovedReviews([{ workItemId: id, subjectVersion: V1 }], tx),
    );
    expect(ours.get(approvedReviewKey(id, V1))?.kind).toBe('reviewed');
  });
});
