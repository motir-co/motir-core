import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { presentWorkItemRepairClaim } from '@/lib/api/v1/workLoop/schema';
import { db } from '@/lib/db';
import { recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { REVIEW_AGENT_REVIEWER_NAME } from '@/lib/workItems/fixReason';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// THE `review` REPAIR CLASS (Story MOTIR-1626 · MOTIR-6822; `approval-gates.md` §12.4,
// §12.7), over real Postgres.
//
// A card a REVIEW sent back — the review agent's `changes_requested` on `agent_review`,
// or a person's Request changes on the approve-and-merge gate — at the delivery set's
// CURRENT version is claimable by `motir fix` though its checks are green, and the claim
// carries the findings in full and who sent it back. The To fix column agrees with the
// claim (`repair: 'fix'` for both kinds), a refusal about an OLDER version admits
// nothing, and a push — a head move — clears the reason without touching the decision.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const HEAD = 'c'.repeat(40); // the head `deliveredPr` writes its check rows at
const versionOf = (repoName: string, number: number, head = HEAD) =>
  `acme/${repoName}#${number}@${head}`;

const FINDINGS = [
  '1. `exportCsv` drops the header row when the list is empty.',
  '2. The new route has no tenant check — read `projectAccessService.assertCanBrowse`.',
  '',
  'Both must be fixed before this can merge.',
].join('\n');

const recompute = (fx: WorkItemFixture, workItemId: string) =>
  withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, (tx) =>
    recomputeWorkItemFixReason(workItemId, tx),
  );

/** A card at `status` with one open pull request carrying `checks`. */
async function cardWith(
  fx: WorkItemFixture,
  status: string,
  checks: Record<string, 'success' | 'failure' | 'pending'> = { Vitest: 'success' },
) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: `card ${randomToken(4)}` });
  await setStatus(card.id, status);
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  const pr = await deliveredPr(fx, card.id, repo, { headRef: `subtask/${randomToken(4)}`, checks });
  return { card, repo, pr };
}

/** A decided review refusal on `workItemId`, about `subjectVersion`. */
async function sentBack(
  fx: WorkItemFixture,
  workItemId: string,
  subjectVersion: string,
  kind: 'agent_review' | 'pull_request_approval',
  opts: {
    decidedAt?: Date;
    state?: 'changes_requested' | 'approved';
    /** Write the gate with no audit label and no recorded authority. */
    unlabelled?: boolean;
  } = {},
) {
  const byAgent = kind === 'agent_review';
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      kind,
      subjectId: workItemId,
      subjectVersion,
      state: opts.state ?? 'changes_requested',
      decidedById: fx.ownerId,
      decidedAt: opts.decidedAt ?? new Date('2026-09-29T10:00:00Z'),
      decidedByLabel: opts.unlabelled ? null : 'Yue Zhu <yue@example.com>',
      decisionSource: 'ui',
      decidedUnderAuthority: opts.unlabelled ? null : byAgent ? 'review_agent' : 'assignee',
      noteMd: FINDINGS,
    },
  });
}

const claimOf = (fx: WorkItemFixture, key: string) =>
  workItemRepairService.claimRepair(fx.projectId, key, fx.ctx);

describe('the `review` class — a green card a review sent back is claimable by `motir fix`', () => {
  it('the review AGENT’s refusal at the current version: claimed, with the FULL findings and the agent named', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    const gate = await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    const claim = await claimOf(fx, card.identifier);

    expect(claim).toMatchObject({
      outcome: 'claimed',
      reason: null,
      repairClass: 'review',
      acceptanceRefusal: null,
      reviewRefusal: {
        gate: 'agent_review',
        findingsMd: FINDINGS,
        // The agent is named as the agent, never as the run's attributed user (§12.3).
        reviewerName: REVIEW_AGENT_REVIEWER_NAME,
        decidedAt: '2026-09-29T10:00:00.000Z',
      },
    });
    // EVERY open member is handed over — green, on its own branch.
    expect(claim.pullRequests).toEqual([
      expect.objectContaining({ number: pr.number, headRef: pr.headRef, ci: 'passing' }),
    ]);
    // The claim is a `fix` run; the card's status and the decision are untouched.
    expect(await adminDb.dispatchRun.count({ where: { command: 'fix' } })).toBe(1);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'in_review',
    );
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).state).toBe(
      'changes_requested',
    );
  });

  it('a PERSON’s Request changes on the approve-and-merge gate: claimed, naming the person', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'pull_request_approval');

    const claim = await claimOf(fx, card.identifier);

    expect(claim).toMatchObject({
      outcome: 'claimed',
      repairClass: 'review',
      reviewRefusal: {
        gate: 'pull_request_approval',
        findingsMd: FINDINGS,
        // The live user row's name — never the gate's `Name <email>` audit label.
        reviewerName: fx.owner.name,
      },
    });
  });

  it('a resumed claim (`mine`) hands the findings again; a rival (`taken`) gets nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');
    await claimOf(fx, card.identifier);

    const again = await claimOf(fx, card.identifier);

    expect(again).toMatchObject({ outcome: 'mine', repairClass: 'review' });
    expect(again.reviewRefusal?.findingsMd).toBe(FINDINGS);
    expect(again.pullRequests).toHaveLength(1);
  });

  it('the v1 wire carries the class and the findings field by field', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    const wire = presentWorkItemRepairClaim(await claimOf(fx, card.identifier));

    expect(wire.repairClass).toBe('review');
    expect(wire.reviewRefusal).toEqual({
      gate: 'agent_review',
      findingsMd: FINDINGS,
      reviewerName: REVIEW_AGENT_REVIEWER_NAME,
      decidedAt: '2026-09-29T10:00:00.000Z',
    });
  });

  it('a red member rides along — the class is still `review`, and To fix names the red check first', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    // The shipped priority is unchanged: a pull-request reason outranks the refusal.
    expect((await recompute(fx, card.id)).fixReason).toBe('ci_failed');
    const claim = await claimOf(fx, card.identifier);
    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'review' });
    expect(claim.pullRequests[0]).toMatchObject({ ci: 'failing', failingChecks: ['Vitest'] });
  });
});

describe('what the class does NOT admit — the existing refusals are unchanged', () => {
  it('a refusal about an OLDER version admits nothing: not_failing, and To fix reads nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number, 'a'.repeat(40)), 'agent_review');

    expect(await recompute(fx, card.id)).toEqual({ fixReason: null, fixDetail: null });
    expect(await claimOf(fx, card.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
      repairClass: 'ci',
      reviewRefusal: null,
      pullRequests: [],
    });
  });

  it('a green In Review card with no refusal is still not_failing', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'in_review');

    expect(await claimOf(fx, card.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
    });
  });

  it('a later approval of the same version answers the refusal: not_failing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    const version = versionOf(repo.name, pr.number);
    await sentBack(fx, card.id, version, 'agent_review');
    await sentBack(fx, card.id, version, 'agent_review', {
      state: 'approved',
      decidedAt: new Date('2026-09-29T11:00:00Z'),
    });

    expect(await claimOf(fx, card.identifier)).toMatchObject({ reason: 'not_failing' });
  });

  it('a refusal of a DIFFERENT kind is no review class', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: 'design_result',
        subjectId: card.id,
        subjectVersion: versionOf(repo.name, pr.number),
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date('2026-09-29T10:00:00Z'),
        decidedByLabel: 'Yue Zhu',
        decisionSource: 'ui',
        decidedUnderAuthority: 'assignee',
        noteMd: 'Wrong colour.',
      },
    });

    expect(await claimOf(fx, card.identifier)).toMatchObject({ reason: 'not_failing' });
  });

  it.each(['todo', 'in_progress', 'approved', 'done'])(
    'a card at `%s` with a standing refusal is not_implemented',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const { card, repo, pr } = await cardWith(fx, status);
      await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

      expect(await claimOf(fx, card.identifier)).toMatchObject({ reason: 'not_implemented' });
    },
  );

  it('a child that shares its run target’s pull requests is never claimed as a review — it is pointed at the run target', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the run target' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'a child',
      parentId: story.id,
    });
    // At Implemented: an In Review child with green checks is refused `not_failing`
    // before the run target is resolved — the shipped order, which this class leaves alone.
    await setStatus(child.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    const pr = await deliveredPr(fx, child.id, repo, {
      headRef: 'parent/x',
      checks: { Vitest: 'success' },
    });
    await testInstructionsService.publish(
      {
        workItemId: story.id,
        bodyMd: '## Precondition\n\nSign in.',
        previewPath: null,
        repos: [{ repoId: repo.id, commitSha: HEAD }],
      },
      fx.ctx,
    );
    await sentBack(fx, child.id, versionOf(repo.name, pr.number), 'agent_review');

    expect(await claimOf(fx, child.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'repair_on_run_target',
      runTargetKey: story.identifier,
    });
  });
});

describe('To fix agrees with the claim — `repair: fix` for both review kinds', () => {
  it.each([
    ['agent_review', () => REVIEW_AGENT_REVIEWER_NAME],
    ['pull_request_approval', (fx: WorkItemFixture) => fx.owner.name],
  ] as const)('%s → changes_requested, repaired by `motir fix`', async (kind, nameOf) => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), kind);

    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: {
        repair: 'fix',
        gate: kind,
        reviewerName: nameOf(fx),
        notePreview: '1. `exportCsv` drops the header row when the list is empty.',
        affected: 1,
        total: 1,
      },
    });
  });
});

describe('the repair’s push clears it', () => {
  it('a head move after the repair clears the claim, reads Fixing while CI runs, and leaves the decision as it was', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    const gate = await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');
    expect((await recompute(fx, card.id)).fixReason).toBe('changes_requested');
    const claim = await claimOf(fx, card.identifier);
    expect(claim.repairClass).toBe('review');

    // The repair pushed: the first check at the NEW head is a new version.
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'e'.repeat(40),
        checkName: 'Vitest',
        conclusion: 'pending',
      },
    });

    // Its CI is running at the new head: the card stays on To fix as Fixing (MOTIR-10307)
    // until the checks decide — the refusal it was sent back with is still what it names.
    expect(await recompute(fx, card.id)).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: { fixing: true, gate: 'agent_review' },
    });
    // The decided refusal is history: nothing re-decided, re-opened or superseded it.
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(after).toMatchObject({ state: 'changes_requested', noteMd: FINDINGS });
    expect(after.decidedAt).toEqual(gate.decidedAt);
    // And nothing re-runs by itself: the only run is the repair the person claimed.
    expect(await adminDb.dispatchRun.count()).toBe(1);
  });
});

describe('the Development block’s fix part — the sent-back part (MOTIR-6930)', () => {
  it('a GREEN review claim is offered as the sent-back part, every open member handed over', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    // Where *Fix in Motir agent* and `motir fix` sit — never `hidden` (§ 30 Panel 3).
    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toMatchObject({
      state: 'offer',
      repairClass: 'review',
      failing: [{ number: pr.number, ci: 'passing' }],
      lastGaveUp: null,
    });
  });

  it('a person’s Request changes is the same part (§12.7, Panel 3e)', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'pull_request_approval');

    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toMatchObject({
      state: 'offer',
      repairClass: 'review',
    });
  });

  it('a review claim with a red member keeps the review class; the part names the red one', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'implemented', { Vitest: 'failure' });
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');

    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toMatchObject({
      state: 'offer',
      repairClass: 'review',
      failing: [{ number: pr.number, ci: 'failing' }],
    });
  });

  it('a repair held names its run — local, then hosted (Panel 3b) — and the open-repair read agrees', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review');
    const claim = await claimOf(fx, card.identifier);
    expect(claim.outcome).toBe('claimed');
    const run = await adminDb.dispatchRun.findFirstOrThrow({ where: { command: 'fix' } });

    const local = await workItemRepairService.getRepairView(card.id, fx.ctx);
    expect(local).toMatchObject({
      state: 'in_progress',
      repairClass: 'review',
      byViewer: true,
      run: { id: run.id, hosted: false },
    });
    expect(local.state === 'in_progress' && local.run?.label).toMatch(/^motir fix · .+ UTC$/);

    await adminDb.dispatchRun.update({ where: { id: run.id }, data: { origin: 'hosted' } });
    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toMatchObject({
      state: 'in_progress',
      run: { id: run.id, hosted: true },
    });
    const open = await workItemRepairService.findOpenRepairRuns([card.id, 'wi_none'], fx.ctx);
    expect([...open.keys()]).toEqual([card.id]);
    expect(open.get(card.id)).toMatchObject({
      id: run.id,
      hosted: true,
      byViewer: true,
      holder: { id: fx.ctx.userId },
    });
  });
});

// THE HOSTED OPENING, AT THE SERVICE (MOTIR-6928). `hostedRunStartFix.test.ts` drives it
// through the hosted start, which only ever opens the `review` class; these pin what the
// claim itself records for the classes the start never hands it, and that `admit` is asked
// under the lock BEFORE anything is written.
const OPENING = {
  origin: 'hosted' as const,
  agent: 'opencode' as const,
  model: 'anthropic/claude-test',
  idempotencyKey: 'press-1',
};

describe('claimRepair with a hosted opening', () => {
  it('a `ci` claim records the class with no findings, and a head no check row names as null', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'conflicted' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    // Conflicted with NO check rows: a failing member whose head nothing names.
    const pr = await deliveredPr(fx, card.id, repo, { headRef: 'subtask/conflict' });
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { mergeableState: 'dirty', mergeableStateHeadSha: HEAD },
    });
    const seen: string[] = [];

    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx, {
      opening: OPENING,
      admit: (repairClass) => seen.push(repairClass),
    });

    expect(seen).toEqual(['ci']);
    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'ci', reviewRefusal: null });
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: claim.runId! } });
    expect(run).toMatchObject({ command: 'fix', origin: 'hosted', model: OPENING.model });
    const events = await adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId: run.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      command: 'fix',
      key: card.identifier,
      repairClass: 'ci',
      findings: null,
      acceptanceRefusal: null,
      pullRequests: [
        {
          number: pr.number,
          branch: 'subtask/conflict',
          headRef: 'subtask/conflict',
          headSha: null,
        },
      ],
    });
    // The Development block names the conflict and the base it is against.
    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toMatchObject({
      state: 'in_progress',
      repairClass: 'ci',
      failing: [{ number: pr.number, conflict: { baseRef: 'main' } }],
      run: { id: run.id, hosted: true },
    });
  });

  it('a review recorded by a gate with no label or authority reads those as null, not a guess', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await cardWith(fx, 'in_review');
    const gate = await sentBack(fx, card.id, versionOf(repo.name, pr.number), 'agent_review', {
      unlabelled: true,
    });

    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx, {
      opening: OPENING,
    });

    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: claim.runId!, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({
      repairClass: 'review',
      pullRequests: [{ number: pr.number, headSha: HEAD }],
      findings: {
        gate: 'agent_review',
        gateId: gate.id,
        subjectVersion: versionOf(repo.name, pr.number),
        findingsMd: FINDINGS,
        reviewerName: REVIEW_AGENT_REVIEWER_NAME,
        decidedByLabel: null,
        decidedUnderAuthority: null,
      },
    });
  });

  it('an `admit` that refuses the class aborts the claim with nothing written', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'implemented', { Vitest: 'failure' });

    await expect(
      workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx, {
        opening: OPENING,
        admit: (repairClass) => {
          if (repairClass !== 'review') throw new Error(`not sent back: ${repairClass}`);
        },
      }),
    ).rejects.toThrow('not sent back: ci');

    expect(await adminDb.dispatchRun.count()).toBe(0);
    expect(await adminDb.dispatchRunEvent.count()).toBe(0);
  });

  it('a LOCAL claim writes no `run_opened` — `motir fix` appends its own', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await cardWith(fx, 'implemented', { Vitest: 'failure' });

    const claim = await claimOf(fx, card.identifier);

    expect(claim.outcome).toBe('claimed');
    expect(
      await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: claim.runId! } }),
    ).toMatchObject({ origin: 'local' });
    expect(await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: claim.runId! } })).toBe(
      0,
    );

    // A run that never beat reads its heartbeat as null once it is closed.
    expect(
      await workItemRepairService.closeRepair(
        fx.projectId,
        card.identifier,
        claim.runId!,
        'green',
        fx.ctx,
      ),
    ).toMatchObject({ runId: claim.runId, open: false, lastHeartbeatAt: null });
  });
});

describe('findOpenRepairRuns', () => {
  it('no cards: an empty map, with no read', async () => {
    const fx = await makeWorkItemFixture();
    expect((await workItemRepairService.findOpenRepairRuns([], fx.ctx)).size).toBe(0);
  });
});
