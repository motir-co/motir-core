import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { homeService } from '@/lib/services/homeService';
import { projectsService } from '@/lib/services/projectsService';
import { reviewVerdictService } from '@/lib/services/reviewVerdictService';
import { recomputeWorkItemResumeState } from '@/lib/services/resumeStateService';
import { usersService } from '@/lib/services/usersService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workItemFixReasonBackfillService } from '@/lib/services/workItemFixReasonBackfillService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workItemResumeStateBackfillService } from '@/lib/services/workItemResumeStateBackfillService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { homePageItems } from '../helpers/homePage';
import { linkPrByIdentifier } from '../helpers/prLink';

// THE STORY GATE for FIXING and MOVING AGAIN (Story MOTIR-10305 · MOTIR-10310), on a real
// Postgres, through the real services.
//
// The siblings proved each rule alone: the Fixing derivation and its backfill (MOTIR-10307,
// `fixReasonService.test.ts`), the Moving-again exit and its handler hook (MOTIR-10308,
// `resumeState.test.ts`, `fixReasonWiring.test.ts`). What only this tier sees is the CHECK
// WEBHOOK writing its row and recomputing BOTH stored columns in one transaction, read back
// through the Workbench's To fix, To resume and In progress reads and their counts — across
// several pull requests, a re-run at the raised head, a dead run, a gated run, the backfills,
// a hosted repair and the two claims. No case writes `fixReason` or `resumeState` through
// the event path's back door except where it seeds the state BEFORE this story shipped,
// which no event can produce any more.

let scenarioSeq = 0;

async function makeScenario(email: string) {
  scenarioSeq += 1;
  const installationId = `inst-fixing-gate-${scenarioSeq}`;
  const providerRepoId = `77070${scenarioSeq}`;
  const repoName = `fixing${scenarioSeq}`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Fixing ${scenarioSeq}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: 'manual' } });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: 'moooon', accountType: 'Organization' },
    repos: [
      { providerRepoId, owner: 'moooon', name: repoName, defaultBranch: 'main', archived: false },
    ],
  });
  const installation = { id: installationId, account: { login: 'moooon', type: 'Organization' } };
  return { user, workspace, project, ctx, installation, providerRepoId, repoName };
}
type Scenario = Awaited<ReturnType<typeof makeScenario>>;

const hctx = (s: Scenario) => ({
  userId: s.user.id,
  workspaceId: s.workspace.id,
  projectId: s.project.id,
});

/** A pull request opened (or pushed to) at `sha` — the head every rule measures. */
const pullRequestEvent = (
  s: Scenario,
  action: 'opened' | 'synchronize',
  number: number,
  headRef: string,
  sha: string,
) =>
  githubWebhookService.handleEvent('pull_request', {
    action,
    installation: s.installation,
    repository: { id: Number(s.providerRepoId) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef, sha },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });

/** A check completing at `headSha` with `conclusion`, or STARTING there (`null`). */
const check = (
  s: Scenario,
  number: number,
  headSha: string,
  name: string,
  conclusion: 'success' | 'failure' | null,
) =>
  githubWebhookService.handleEvent('check_run', {
    action: conclusion === null ? 'created' : 'completed',
    installation: s.installation,
    repository: { id: Number(s.providerRepoId) },
    check_run: {
      head_sha: headSha,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
      name,
      check_suite: { head_branch: null },
      pull_requests: [{ number }],
    },
  });

/** A card of the reader's, delivered by the pull requests `numbers`, each opened at sha-a. */
async function card(s: Scenario, title: string, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const heads: Record<number, string> = {};
  for (const number of numbers) {
    const headRef = `subtask/${item.identifier}-${number}`;
    heads[number] = headRef;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: s.repoName,
      number,
      headRef,
    });
    await pullRequestEvent(s, 'opened', number, headRef, 'sha-a');
  }
  return { item, heads };
}

/** A fix PUSHED to `number` at `sha`, its CI starting there — the two events a push makes. */
async function push(s: Scenario, number: number, headRef: string, sha: string) {
  await pullRequestEvent(s, 'synchronize', number, headRef, sha);
  await check(s, number, sha, 'vitest', null);
}

async function requestChanges(s: Scenario, itemId: string, noteMd: string) {
  const [gate] = await adminDb.approvalGate.findMany({
    where: { workItemId: itemId, kind: 'pull_request_approval', state: 'awaiting' },
  });
  await approvalGatesService.decide(
    {
      stamp: DECIDED_WITHOUT_A_READER,
      gateId: gate!.id,
      decision: 'request_changes',
      noteMd,
      source: 'ui',
    },
    s.ctx,
  );
}

const prId = async (s: Scenario, number: number) =>
  (
    await adminDb.githubPullRequest.findFirstOrThrow({
      where: { number, repo: { workspaceId: s.workspace.id } },
    })
  ).id;

/** The stored answers, as the row holds them. */
async function stored(id: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  const detail = (row.fixDetail ?? null) as {
    fixing?: boolean;
    raisedHeads?: Record<string, string> | null;
  } | null;
  return {
    status: row.status,
    fixReason: row.fixReason,
    fixing: detail?.fixing === true,
    raisedHeads: detail?.raisedHeads ?? null,
    resumeState: row.resumeState,
  };
}

/** Where the READER sees the card, and the badge counts — which must agree with the lists. */
async function whereIs(s: Scenario, itemId: string) {
  const ctx = hctx(s);
  const [toFix, toResume, inProgress, counts] = await Promise.all([
    homeService.listToFix(ctx),
    homeService.listToResume(ctx),
    homeService.listInProgress(ctx),
    homeService.tabCounts(ctx),
  ]);
  expect(counts.toFix).toBe(toFix.total);
  expect(counts.toResume).toBe(toResume.total);
  expect(counts.inProgress).toBe(homePageItems(inProgress).length);
  const fixRow = toFix.items.find((r) => r.id === itemId);
  const tabs = [
    fixRow ? 'to-fix' : null,
    toResume.items.some((r) => r.id === itemId) ? 'to-resume' : null,
    homePageItems(inProgress).some((r) => r.id === itemId) ? 'in-progress' : null,
  ].filter((t): t is string => t !== null);
  // A card is listed ONCE: never on two work tabs, never twice on one.
  expect(new Set(tabs).size).toBe(tabs.length);
  expect(toFix.items.filter((r) => r.id === itemId).length).toBeLessThanOrEqual(1);
  return { tabs, fixRow, counts };
}

/** A run on `item` that stops at a gate — awaiting `held` when given, released when not. */
async function gatedRun(s: Scenario, itemId: string, identifier: string, held: boolean) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: s.project.identifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: identifier, disposition: 'queued' }],
    },
    s.ctx,
  );
  if (held) {
    await adminDb.approvalGate.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: itemId,
        kind: 'design_result',
        subjectId: `ev-${itemId}-${Math.random()}`,
        state: 'awaiting',
      },
    });
  }
  await dispatchRunService.close(run.id, { stopReason: 'gated' }, s.ctx);
  return run.id;
}

/** A card at In Progress with an open pull request whose run stopped at an awaiting gate. */
async function gatedCard(s: Scenario, title: string, number: number) {
  const { item, heads } = await card(s, title, [number]);
  // Opening the pull request delivered it to Implemented — an open delivery there is
  // MOTIR-8611's exit, so put it back where a run that parks at a gate leaves it.
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await gatedRun(s, item.id, item.identifier, true);
  expect((await stored(item.id)).resumeState).toBe('waiting_on_gate');
  return { item, headRef: heads[number]! };
}

const repairClaim = (s: Scenario, identifier: string) =>
  workItemRepairService.claimRepair(s.project.id, identifier, s.ctx);

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixing ───────────────────────────────────────────────────────────────────────

describe('Fixing — a pushed fix stays on To fix while its CI runs', () => {
  async function redCard(s: Scenario, number: number) {
    const { item, heads } = await card(s, `red ${number}`, [number]);
    await check(s, number, 'sha-a', 'vitest', 'failure');
    const seen = await whereIs(s, item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(await stored(item.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixing: false,
      raisedHeads: { [await prId(s, number)]: 'sha-a' },
    });
    return { item, headRef: heads[number]!, before: seen.counts.toFix };
  }

  it('red → CI started at a new head → green: Fixing at the same count, then gone', async () => {
    const s = await makeScenario('fixing-green@example.com');
    const { item, headRef, before } = await redCard(s, 201);

    await push(s, 201, headRef, 'sha-b');

    const fixing = await whereIs(s, item.id);
    expect(fixing.tabs).toEqual(['to-fix']);
    expect(fixing.counts.toFix).toBe(before);
    expect(fixing.fixRow).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { fixing: true, check: 'vitest' },
    });

    await check(s, 201, 'sha-b', 'vitest', 'success');

    const cleared = await whereIs(s, item.id);
    expect(cleared.tabs).not.toContain('to-fix');
    expect(cleared.counts.toFix).toBe(before - 1);
    expect(await stored(item.id)).toMatchObject({ fixReason: null, fixing: false });
  });

  it('red → CI started at a new head → red: the reason is raised again on the new head', async () => {
    const s = await makeScenario('fixing-red@example.com');
    const { item, headRef, before } = await redCard(s, 202);
    await push(s, 202, headRef, 'sha-b');
    expect((await stored(item.id)).fixing).toBe(true);

    await check(s, 202, 'sha-b', 'vitest', 'failure');

    const seen = await whereIs(s, item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(seen.counts.toFix).toBe(before);
    expect(seen.fixRow).toMatchObject({ fixReason: 'ci_failed', fixDetail: { fixing: false } });
    expect((await stored(item.id)).raisedHeads).toEqual({ [await prId(s, 202)]: 'sha-b' });
  });

  it('a re-run at the head the reason was raised on is never Fixing', async () => {
    const s = await makeScenario('fixing-rerun@example.com');
    const { item } = await redCard(s, 203);

    // The same commit's checks start again — no push happened.
    await check(s, 203, 'sha-a', 'vitest', null);

    const after = await stored(item.id);
    expect(after.fixing).toBe(false);
    expect((await whereIs(s, item.id)).fixRow?.fixDetail?.fixing ?? false).toBe(false);
  });

  it('a card stored before the recorded heads existed is never Fixing', async () => {
    const s = await makeScenario('fixing-noheads@example.com');
    const { item, headRef } = await redCard(s, 204);
    // The answer the derivation stored before MOTIR-10307: no heads recorded.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    const {
      raisedHeads: _drop,
      fixing: _off,
      ...legacy
    } = row.fixDetail as Record<string, string | number | boolean | null>;
    await adminDb.workItem.update({ where: { id: item.id }, data: { fixDetail: legacy } });

    await push(s, 204, headRef, 'sha-b');

    expect((await stored(item.id)).fixing).toBe(false);
    expect((await whereIs(s, item.id)).tabs).not.toContain('to-fix');
  });
});

describe('Fixing — several pull requests', () => {
  it('any red member means not Fixing; with none red and one running at a newer head, Fixing', async () => {
    const s = await makeScenario('fixing-two@example.com');
    const { item, heads } = await card(s, 'two prs', [211, 212]);
    await check(s, 211, 'sha-a', 'vitest', 'failure');
    await check(s, 212, 'sha-a', 'vitest', 'failure');
    const before = (await whereIs(s, item.id)).counts.toFix;
    const [one, two] = [await prId(s, 211), await prId(s, 212)];
    expect((await stored(item.id)).raisedHeads).toEqual({ [one]: 'sha-a', [two]: 'sha-a' });

    // A fix pushed to the second; the first is still red.
    await push(s, 212, heads[212]!, 'sha-b');

    expect(await stored(item.id)).toMatchObject({ fixReason: 'ci_failed', fixing: false });
    // The running member keeps the head the reason was raised on: its push is still a push.
    expect((await stored(item.id)).raisedHeads).toEqual({ [one]: 'sha-a', [two]: 'sha-a' });

    // The first turns green; the second still runs at its new head.
    await check(s, 211, 'sha-a', 'vitest', 'success');

    const seen = await whereIs(s, item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(seen.counts.toFix).toBe(before);
    expect(seen.fixRow).toMatchObject({ fixReason: 'ci_failed', fixDetail: { fixing: true } });
  });
});

describe('Fixing — a standing Request changes', () => {
  async function sentBack(s: Scenario, number: number) {
    const { item, heads } = await card(s, `sent back ${number}`, [number]);
    await check(s, number, 'sha-a', 'vitest', 'success');
    await requestChanges(s, item.id, 'Rename the export button.');
    expect(await stored(item.id)).toMatchObject({
      status: 'in_review',
      fixReason: 'changes_requested',
      fixing: false,
    });
    return { item, headRef: heads[number]! };
  }

  it('at In Review: CI re-running at the reviewed head is not Fixing; a push that moves it is', async () => {
    const s = await makeScenario('fixing-review@example.com');
    const { item, headRef } = await sentBack(s, 221);

    await check(s, 221, 'sha-a', 'vitest', null);
    expect(await stored(item.id)).toMatchObject({
      fixReason: 'changes_requested',
      fixing: false,
    });

    await push(s, 221, headRef, 'sha-b');

    const seen = await whereIs(s, item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(seen.fixRow).toMatchObject({
      status: 'in_review',
      fixReason: 'changes_requested',
      fixDetail: { fixing: true, gate: 'pull_request_approval' },
    });
    // At In Review the claim refuses `not_failing`, never `ci_running`.
    expect(await repairClaim(s, item.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
    });
  });

  it('at Implemented: the same push reads Fixing, and the claim refuses it as CI running', async () => {
    const s = await makeScenario('fixing-implemented@example.com');
    const { item, headRef } = await sentBack(s, 222);
    // A green card is promoted to In Review on its own, so a refusal standing at
    // Implemented (a review agent's, sent back before the promotion) is placed directly.
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'implemented' } });
    expect(await stored(item.id)).toMatchObject({
      status: 'implemented',
      fixReason: 'changes_requested',
      fixing: false,
    });

    await push(s, 222, headRef, 'sha-b');

    expect(await stored(item.id)).toMatchObject({
      status: 'implemented',
      fixReason: 'changes_requested',
      fixing: true,
    });
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-fix']);
    expect(await repairClaim(s, item.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'ci_running',
    });
  });
});

describe('Fixing — a review AGENT sent it back (Bug MOTIR-10733)', () => {
  const versionOf = (s: Scenario, number: number, sha: string) =>
    `moooon/${s.repoName}#${number}@${sha}`;

  async function agentSentBack(s: Scenario, number: number) {
    const { item, heads } = await card(s, `agent sent back ${number}`, [number]);
    await check(s, number, 'sha-a', 'vitest', 'success');
    await reviewVerdictService.submit(
      s.project.id,
      item.identifier,
      {
        verdict: 'changes_requested',
        subjectVersion: versionOf(s, number, 'sha-a'),
        summaryMd: 'A zero count renders blank.',
        findingsMd: '- `lib/export.ts:12` drops the header row.',
        checklist: [{ key: null, criterion: 'It exports', status: 'not_met', evidence: null }],
        harness: 'Claude Code',
        model: 'claude-opus-5-5',
      },
      s.ctx,
    );
    expect(await stored(item.id)).toMatchObject({
      status: 'in_review',
      fixReason: 'changes_requested',
      fixing: false,
      raisedHeads: { [await prId(s, number)]: 'sha-a' },
    });
    return { item, headRef: heads[number]! };
  }

  it('the push alone (no check at the new head yet) reads Fixing, and so does its first check', async () => {
    const s = await makeScenario('fixing-agent-push@example.com');
    const { item, headRef } = await agentSentBack(s, 231);

    await pullRequestEvent(s, 'synchronize', 231, headRef, 'sha-b');
    expect(await stored(item.id), 'on the push').toMatchObject({
      fixReason: 'changes_requested',
      fixing: true,
    });

    await check(s, 231, 'sha-b', 'vitest', null);
    expect(await stored(item.id), 'CI running at the new head').toMatchObject({
      fixReason: 'changes_requested',
      fixing: true,
    });
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-fix']);

    await check(s, 231, 'sha-b', 'vitest', 'success');
    expect((await stored(item.id)).fixReason, 'green clears it').toBeNull();
  });

  // THE OBSERVED DEFECT. GitHub delivers a push's checks one webhook at a time and in no
  // order: a quick success at the new head (a lint job, Motir's own link check) can be
  // recorded before anything running there. That recompute reads the head green and stores
  // nothing to fix — and the Fixing rule, reading only that stored prior, had nothing left to
  // keep for the rest of the CI run.
  it.each([
    { label: 'the switch off (a recorded send-back)', gateOn: false, number: 232 },
    { label: 'the switch on (a decided review gate)', gateOn: true, number: 233 },
  ])(
    'with $label: a quick green at the new head, then a running check, reads Fixing again',
    async ({ gateOn, number }) => {
      const s = await makeScenario(`fixing-agent-early-green-${number}@example.com`);
      if (gateOn) {
        await adminDb.project.update({
          where: { id: s.project.id },
          data: { reviewAgentEnabled: true },
        });
      }
      const { item, headRef } = await agentSentBack(s, number);
      if (gateOn) {
        expect(
          await adminDb.approvalGate.count({
            where: { workItemId: item.id, kind: 'agent_review', state: 'changes_requested' },
          }),
        ).toBe(1);
      }

      await pullRequestEvent(s, 'synchronize', number, headRef, 'sha-b');
      await check(s, number, 'sha-b', 'lint', 'success');
      // The partial set reads green for a moment: nothing running is recorded yet.
      expect((await stored(item.id)).fixReason).toBeNull();

      await check(s, number, 'sha-b', 'vitest', null);
      expect(await stored(item.id), 'the running check brings it back').toMatchObject({
        status: 'in_review',
        fixReason: 'changes_requested',
        fixing: true,
        raisedHeads: { [await prId(s, number)]: 'sha-a' },
      });
      const seen = await whereIs(s, item.id);
      expect(seen.tabs).toEqual(['to-fix']);
      expect(seen.fixRow).toMatchObject({
        fixReason: 'changes_requested',
        fixDetail: { fixing: true, gate: 'agent_review', reviewerName: 'Review agent' },
      });

      await check(s, number, 'sha-b', 'vitest', 'success');
      expect((await stored(item.id)).fixReason, 'green clears it').toBeNull();
    },
  );

  it('a person’s Request changes: a quick green at the new head, then a running check, reads Fixing again', async () => {
    const s = await makeScenario('fixing-person-early-green@example.com');
    const { item, heads } = await card(s, 'person sent back', [235]);
    await check(s, 235, 'sha-a', 'vitest', 'success');
    await requestChanges(s, item.id, 'Rename the export button.');

    await pullRequestEvent(s, 'synchronize', 235, heads[235]!, 'sha-b');
    await check(s, 235, 'sha-b', 'lint', 'success');
    expect((await stored(item.id)).fixReason).toBeNull();

    await check(s, 235, 'sha-b', 'vitest', null);
    expect((await whereIs(s, item.id)).fixRow).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: { fixing: true, gate: 'pull_request_approval', reviewerName: 'Owner' },
    });
  });
});

describe('Fixing — a dead run', () => {
  it('a card whose latest run died is never Fixing, whatever its CI does', async () => {
    const s = await makeScenario('fixing-died@example.com');
    const { item, heads } = await card(s, 'died', [231]);
    await check(s, 231, 'sha-a', 'vitest', 'failure');
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    const { run } = await dispatchRunService.open(
      {
        projectKey: s.project.identifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: item.identifier, disposition: 'queued' }],
      },
      s.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'checkout_ready',
          workItemKey: item.identifier,
          disposition: 'running',
          data: { branch: heads[231] },
        },
      ],
      s.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'interrupted' }, s.ctx);
    expect((await stored(item.id)).fixReason).toBe('run_died');

    await push(s, 231, heads[231]!, 'sha-b');

    expect(await stored(item.id)).toMatchObject({ fixReason: 'run_died', fixing: false });
    expect((await whereIs(s, item.id)).fixRow).toMatchObject({
      fixReason: 'run_died',
      fixDetail: { fixing: false },
    });
  });
});

// ── Moving again ─────────────────────────────────────────────────────────────────

describe('Moving again — a gated card leaves To resume once CI starts after its run', () => {
  it('a check row created after the run ended clears it: off To resume, onto In progress', async () => {
    const s = await makeScenario('moving-start@example.com');
    const { item, headRef } = await gatedCard(s, 'gated', 241);
    const before = await whereIs(s, item.id);
    expect(before.tabs).toEqual(['to-resume']);

    // CI at the head the run LEFT is the run's own push being checked (review of
    // MOTIR-10305): not a start, the card still waits.
    await check(s, 241, 'sha-a', 'e2e', null);
    expect((await stored(item.id)).resumeState).toBe('waiting_on_gate');

    // A push after the stop, and its CI starting: the card is moving again.
    await push(s, 241, headRef, 'sha-b');

    const after = await whereIs(s, item.id);
    expect((await stored(item.id)).resumeState).toBeNull();
    expect(after.tabs).toEqual(['in-progress']);
    expect(after.counts.toResume).toBe(before.counts.toResume - 1);
  });

  it('a status move alone does not: the card is back on To resume', async () => {
    const s = await makeScenario('moving-status@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'no pull request' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await gatedRun(s, item.id, item.identifier, true);
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-resume']);

    await workItemsService.updateStatus(item.id, 'todo', s.ctx);
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);

    expect((await stored(item.id)).resumeState).toBe('waiting_on_gate');
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-resume']);
  });

  it('a pull request already open, every check row created before the run ended: it stays', async () => {
    const s = await makeScenario('moving-before@example.com');
    const { item } = await card(s, 'checked before', [242]);
    await check(s, 242, 'sha-a', 'vitest', null);
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    // The rows predate the stop by a clear margin.
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: await prId(s, 242) },
      data: { createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000) },
    });
    await gatedRun(s, item.id, item.identifier, true);

    await withWorkspaceContext(s.ctx, (tx) => recomputeWorkItemResumeState(item.id, tx));

    expect((await stored(item.id)).resumeState).toBe('waiting_on_gate');
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-resume']);
  });

  it('the continue claim answers exactly as it did: the gate still holds the run', async () => {
    const s = await makeScenario('moving-claim@example.com');
    const { item, headRef } = await gatedCard(s, 'gated claim', 243);
    const before = await workItemContinueService.claimContinue(
      s.project.id,
      item.identifier,
      s.ctx,
    );
    expect(before).toMatchObject({ outcome: 'not_continuable', reason: 'gate_awaiting' });

    await push(s, 243, headRef, 'sha-b');
    expect((await stored(item.id)).resumeState).toBeNull();

    const after = await workItemContinueService.claimContinue(s.project.id, item.identifier, s.ctx);
    expect(after).toMatchObject({ outcome: before.outcome, reason: before.reason });
  });
});

// ── Both at once ─────────────────────────────────────────────────────────────────

describe('one card on To fix AND gated — one CI event updates both answers', () => {
  it('Fixing stays on To fix and the resume state clears, in the same handler call', async () => {
    const s = await makeScenario('both@example.com');
    const { item, heads } = await card(s, 'both', [251]);
    await check(s, 251, 'sha-a', 'vitest', 'failure');
    await gatedRun(s, item.id, item.identifier, true);
    // ⚠️ SEEDED: live, To fix (Implemented / In Review with an open pull request) and To
    // resume are disjoint — MOTIR-8611 clears a delivered card's resume state. The pair
    // exists only as a row stored before that recompute ran, so it is written directly.
    await adminDb.workItem.update({
      where: { id: item.id },
      data: {
        resumeState: 'waiting_on_gate',
        resumeRunId: (
          await adminDb.dispatchRun.findFirstOrThrow({ where: { stopReason: 'gated' } })
        ).id,
      },
    });
    expect(await stored(item.id)).toMatchObject({
      status: 'implemented',
      fixReason: 'ci_failed',
      resumeState: 'waiting_on_gate',
    });

    await push(s, 251, heads[251]!, 'sha-b');

    expect(await stored(item.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixing: true,
      resumeState: null,
    });
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-fix']);
  });
});

// ── A hosted repair ──────────────────────────────────────────────────────────────

describe('a hosted repair in flight and Fixing', () => {
  it('the row carries both, independently — the surface decides which line wins', async () => {
    const s = await makeScenario('hosted@example.com');
    const { item, heads } = await card(s, 'hosted', [261]);
    await check(s, 261, 'sha-a', 'vitest', 'success');
    await requestChanges(s, item.id, 'Not yet.');
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        command: 'fix',
        status: 'running',
        origin: 'hosted',
        createdById: s.user.id,
      },
    });
    await adminDb.dispatchRunCard.create({
      data: {
        workspaceId: s.workspace.id,
        dispatchRunId: run.id,
        workItemId: item.id,
        workItemKey: item.identifier,
        position: 0,
      },
    });

    await push(s, 261, heads[261]!, 'sha-b');

    const { fixRow } = await whereIs(s, item.id);
    expect(fixRow).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: { fixing: true },
      repairRun: { id: run.id, hosted: true },
    });
  });
});

// ── The backfills ────────────────────────────────────────────────────────────────

describe('the backfills converge cards stored before the change', () => {
  it('dry run predicts the apply, the cards reach the live answer, a second apply changes 0', async () => {
    const s = await makeScenario('backfill@example.com');
    // (1) A To fix card whose CI start at a new head was never processed: its PR moved
    //     and a pending row exists, but the stored answer is still the plain red one.
    const missed = await card(s, 'missed start', [271]);
    await check(s, 271, 'sha-a', 'vitest', 'failure');
    const missedPr = await prId(s, 271);
    await adminDb.githubPullRequest.update({ where: { id: missedPr }, data: { headSha: 'sha-b' } });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: missedPr,
        commitSha: 'sha-b',
        checkName: 'vitest',
        conclusion: 'pending',
      },
    });
    // (2) A red card stored before raised heads existed.
    const legacy = await card(s, 'legacy red', [272]);
    await check(s, 272, 'sha-a', 'vitest', 'failure');
    const legacyRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: legacy.item.id } });
    const {
      raisedHeads: _drop,
      fixing: _off,
      ...legacyDetail
    } = legacyRow.fixDetail as Record<string, string | number | boolean | null>;
    await adminDb.workItem.update({
      where: { id: legacy.item.id },
      data: { fixDetail: legacyDetail },
    });
    // (3) A gated card pushed and checked after the run ended, whose CI event was never
    //     processed: the PR moved and a pending row exists at the new head.
    const gated = await gatedCard(s, 'gated before', 273);
    const gatedPr = await prId(s, 273);
    await adminDb.githubPullRequest.update({ where: { id: gatedPr }, data: { headSha: 'sha-b' } });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: gatedPr,
        commitSha: 'sha-b',
        checkName: 'e2e',
        conclusion: 'pending',
      },
    });
    expect((await stored(gated.item.id)).resumeState).toBe('waiting_on_gate');

    const fixDry = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: true,
      workspaceId: s.workspace.id,
    });
    const resumeDry = await workItemResumeStateBackfillService.backfillResumeState({
      dryRun: true,
      workspaceId: s.workspace.id,
    });
    // A dry run writes nothing.
    expect((await stored(missed.item.id)).fixing).toBe(false);
    expect((await stored(gated.item.id)).resumeState).toBe('waiting_on_gate');

    const fixApply = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: false,
      workspaceId: s.workspace.id,
    });
    const resumeApply = await workItemResumeStateBackfillService.backfillResumeState({
      dryRun: false,
      workspaceId: s.workspace.id,
    });
    expect(fixApply.failed).toEqual([]);
    expect(resumeApply.failed).toEqual([]);
    expect(fixApply.changed).toEqual(fixDry.changed);
    expect(fixApply.byReason).toEqual(fixDry.byReason);
    expect(fixApply.fixing).toBe(fixDry.fixing);
    expect(fixApply.fixing).toBe(1);
    expect(resumeApply.changed).toEqual(resumeDry.changed);
    expect(resumeApply.changed).toEqual([
      expect.objectContaining({ workItemId: gated.item.id, from: 'waiting_on_gate', to: null }),
    ]);

    // The live answers.
    expect(await stored(missed.item.id)).toMatchObject({ fixReason: 'ci_failed', fixing: true });
    expect(await stored(legacy.item.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixing: false,
      raisedHeads: { [await prId(s, 272)]: 'sha-a' },
    });
    expect((await stored(gated.item.id)).resumeState).toBeNull();

    const fixAgain = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: false,
      workspaceId: s.workspace.id,
    });
    const resumeAgain = await workItemResumeStateBackfillService.backfillResumeState({
      dryRun: false,
      workspaceId: s.workspace.id,
    });
    expect(fixAgain.changed).toEqual([]);
    expect(resumeAgain.changed).toEqual([]);
    expect(fixAgain.fixing).toBe(1);
  });
});

// ── The claim and the workflow ───────────────────────────────────────────────────

describe('`motir fix` claims exactly what it did, and no status is added', () => {
  it('a Fixing card is refused as CI running; a red one is claimed; the statuses are the same', async () => {
    const s = await makeScenario('claim@example.com');
    const statusKeys = async () =>
      (await adminDb.workflowStatus.findMany({ where: { projectId: s.project.id } }))
        .map((st) => st.key)
        .sort();
    const keysBefore = await statusKeys();

    const fixing = await card(s, 'fixing', [281]);
    await check(s, 281, 'sha-a', 'vitest', 'failure');
    await push(s, 281, fixing.heads[281]!, 'sha-b');
    expect((await stored(fixing.item.id)).fixing).toBe(true);

    const running = await card(s, 'just running', [282]);
    await workItemsService.updateStatus(running.item.id, 'implemented', s.ctx);
    await check(s, 282, 'sha-a', 'vitest', null);

    const red = await card(s, 'red', [283]);
    await check(s, 283, 'sha-a', 'vitest', 'failure');

    expect(await repairClaim(s, fixing.item.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'ci_running',
    });
    expect(await repairClaim(s, running.item.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'ci_running',
    });
    expect(await repairClaim(s, red.item.identifier)).toMatchObject({ outcome: 'claimed' });

    expect(await statusKeys()).toEqual(keysBefore);
  });
});
