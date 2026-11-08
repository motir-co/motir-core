import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalGateKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { carriesReviewPath, REVIEW_CARRYING_GATE_KINDS } from '@/lib/dto/reviewState';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workbenchWatermarkService } from '@/lib/services/workbenchWatermarkService';
import type { HomeActorContext } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';

// THE TO APPROVE WATERMARK OVER A STORY RUN'S ACCEPTANCE ROW (Bug MOTIR-10734), against a
// real Postgres.
//
// Since MOTIR-10533 a story run's acceptance row draws its delivery set's review line and the
// Reviewed badge (`carriesReviewPath`). While that review is owed the gate set asks the
// acceptance and the agent review and NO merge gate, so the acceptance gate is the card's only
// routed row. The watermark's review arm used to select its cards by `pull_request_approval`
// alone — a copy of the old kind list — so a passing verdict moved no tab and the row read
// *Not reviewed by an agent* until a reload. These cases hold the arm to the rows' own list.

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "github_pull_request", "github_repo", "github_installation" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'WAR' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = (): HomeActorContext => ({ ...fx.ctx, projectId: fx.projectId });

let seq = 0;
const rawId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq += 1)}`;

/** A story assigned to the reader, so every gate on it routes to them. */
async function story(title: string): Promise<{ id: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
  return { id: item.id };
}

/** A subtask under `parentId` — the card a SUBTASK run's code is delivered on. */
async function subtask(parentId: string, title: string): Promise<{ id: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId, title },
    fx.ctx,
  );
  return { id: item.id };
}

/** Link one open pull request to `workItemId` — the card's own delivery set. */
async function deliver(workItemId: string): Promise<void> {
  const installation = rawId('gi');
  const repo = rawId('gr');
  const pr = rawId('gpr');
  const w = fx.workspaceId;
  await adminDb.$executeRaw`INSERT INTO "github_installation" ("id","installation_id","workspace_id","account_login","account_type","updated_at") VALUES (${installation},${rawId('inst')},${w},'moooon','Organization',now())`;
  await adminDb.$executeRaw`INSERT INTO "github_repo" ("id","installation_id","workspace_id","organization_id","repo_id","owner","name","default_branch","updated_at") SELECT ${repo},${installation},ws."id",ws."organizationId",${rawId('repo')},'moooon',${rawId('acme')},'main',now() FROM "workspace" ws WHERE ws."id" = ${w}`;
  await adminDb.$executeRaw`INSERT INTO "github_pull_request" ("id","repo_id","number","state","head_ref","updated_at") VALUES (${pr},${repo},1,'open','story/run',now())`;
  await adminDb.$executeRaw`INSERT INTO "work_item_delivery" ("id","workspace_id","work_item_id","github_pull_request_id","repo_id") VALUES (${rawId('wid')},${w},${workItemId},${pr},${repo})`;
}

/** One awaiting gate of `kind` on the card. */
async function gate(workItemId: string, kind: ApprovalGateKind): Promise<void> {
  await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId,
        kind,
        subjectId: `subject-${workItemId}-${kind}`,
        subjectVersion: 'moooon/acme#1@sha-a',
      },
      tx,
    ),
  );
}

/** The review agent's passing verdict at the set's version — the row the review line reads. */
async function passingVerdict(workItemId: string): Promise<void> {
  await adminDb.$executeRaw`INSERT INTO "review_verdict_record" ("id","workspace_id","project_id","work_item_id","subject_version","verdict","outcome","harness","model") VALUES (${rawId('rvr')},${fx.workspaceId},${fx.projectId},${workItemId},'moooon/acme#1@sha-a','pass','recorded','Claude Code','claude-opus-5-5')`;
}

async function cardSet(): Promise<string[]> {
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.findAwaitingRoutedReviewCarryingWorkItemIds(
      { projectIds: [fx.projectId], userId: fx.ownerId, awaitingSessionIds: [] },
      tx,
    ),
  );
}

describe('a story run awaiting only its acceptance', () => {
  it('a passing agent verdict moves To approve', async () => {
    const run = await story('A story run awaiting acceptance');
    await deliver(run.id);
    // The review is owed: the gate set asks the acceptance (and the agent review, which no
    // person's list carries) — no merge gate.
    await gate(run.id, 'acceptance_result');
    await gate(run.id, 'agent_review');

    const before = await workbenchWatermarkService.read(ctx());
    await passingVerdict(run.id);
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toContain('approvals');
  });

  it('every other review write the row draws moves it too — a dismissal and a GitHub approval', async () => {
    const run = await story('A story run awaiting acceptance');
    await deliver(run.id);
    await gate(run.id, 'acceptance_result');

    const record = rawId('rvr');
    await adminDb.$executeRaw`INSERT INTO "review_verdict_record" ("id","workspace_id","project_id","work_item_id","subject_version","verdict","outcome","harness","model") VALUES (${record},${fx.workspaceId},${fx.projectId},${run.id},'moooon/acme#1@sha-a','changes_requested','recorded','Claude Code','claude-opus-5-5')`;

    const beforeDismissal = await workbenchWatermarkService.read(ctx());
    await adminDb.$executeRaw`INSERT INTO "review_dismissal" ("id","workspace_id","project_id","work_item_id","review_verdict_record_id","subject_version","reason_md") VALUES (${rawId('rd')},${fx.workspaceId},${fx.projectId},${run.id},${record},'moooon/acme#1@sha-a','Reviewed by hand.')`;
    const afterDismissal = await workbenchWatermarkService.read(ctx(), beforeDismissal.cursor);
    expect(afterDismissal.moved).toContain('approvals');

    const [delivery] = await adminDb.workItemDelivery.findMany({ where: { workItemId: run.id } });
    const beforeGithub = await workbenchWatermarkService.read(ctx());
    await adminDb.$executeRaw`INSERT INTO "github_pull_request_review" ("id","github_review_id","github_pull_request_id","reviewer_github_user_id","reviewer_login","reviewer_type","state","commit_sha","reviewer_permission","submitted_at","updated_at") VALUES (${rawId('gprr')},${rawId('review')},${delivery!.githubPullRequestId},'77','octo','User','approved','sha-a','write',now(),now())`;
    const afterGithub = await workbenchWatermarkService.read(ctx(), beforeGithub.cursor);
    expect(afterGithub.moved).toContain('approvals');
  });
});

describe('a review write on a card whose awaiting gate draws no review moves no tab', () => {
  it.each(['design_result', 'decision_approval', 'decision_confirmation'] as const)(
    '%s',
    async (kind) => {
      const item = await story(`Awaiting a ${kind}`);
      await deliver(item.id);
      await gate(item.id, kind);

      const before = await workbenchWatermarkService.read(ctx());
      await passingVerdict(item.id);
      const after = await workbenchWatermarkService.read(ctx(), before.cursor);

      expect(after.moved).toEqual([]);
    },
  );

  it("a SUBTASK run's story acceptance — the story delivers nothing of its own", async () => {
    const run = await story('A subtask run awaiting acceptance');
    const child = await subtask(run.id, 'The E2E subtask');
    await deliver(child.id);
    await gate(run.id, 'acceptance_result');

    const before = await workbenchWatermarkService.read(ctx());
    await passingVerdict(child.id);
    await passingVerdict(run.id);
    const after = await workbenchWatermarkService.read(ctx(), before.cursor);

    expect(after.moved).toEqual([]);
  });
});

describe('the watermark card set and the rows read ONE kind list', () => {
  it('a card is in the set exactly when its kind carries the review path', async () => {
    // Every kind a work item can carry — `plan_approval` and `planning_session` belong to no
    // work item (`approval_gate_work_item_iff_not_plan`).
    const cardless: readonly ApprovalGateKind[] = ['plan_approval', 'planning_session'];
    const kinds = Object.values(ApprovalGateKind).filter((kind) => !cardless.includes(kind));
    const cardByKind = new Map<ApprovalGateKind, string>();
    for (const kind of kinds) {
      const item = await story(`Awaiting ${kind}`);
      await deliver(item.id);
      await gate(item.id, kind);
      cardByKind.set(kind, item.id);
    }

    const set = new Set(await cardSet());

    for (const kind of kinds) {
      expect(set.has(cardByKind.get(kind)!), kind).toBe(carriesReviewPath(kind));
    }
    // And the predicate is the list: nothing outside it carries the path.
    expect(kinds.filter((kind) => carriesReviewPath(kind)).sort()).toEqual(
      [...REVIEW_CARRYING_GATE_KINDS].sort(),
    );
  });
});
