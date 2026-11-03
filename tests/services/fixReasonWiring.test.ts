import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { projectsService } from '@/lib/services/projectsService';
import { pullRequestMergeabilityService } from '@/lib/services/pullRequestMergeabilityService';
import { recomputeWorkItemResumeState } from '@/lib/services/resumeStateService';
import { usersService } from '@/lib/services/usersService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// EVERY EVENT THAT CAN CHANGE A CARD'S `fixReason` RECOMPUTES IT (Story MOTIR-6588 ·
// MOTIR-6602), on a real Postgres, through the doors a GitHub delivery and a person's
// press actually walk — the check webhook, the queue's `dequeued`, a mergeability
// reading, a push, a gate decision and a status move. Each assertion reads the column
// straight after the event returns: nothing else ran in between, so the value was
// written in the event's own transaction.

const INSTALLATION_ID = 'inst-fix-wiring';
const REPO_PROVIDER_ID = '6602';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
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
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}
type Scenario = Awaited<ReturnType<typeof makeScenario>>;

const pullRequestEvent = (
  action: 'opened' | 'synchronize',
  number: number,
  headRef: string,
  sha?: string,
) =>
  githubWebhookService.handleEvent('pull_request', {
    action,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: sha ? { ref: headRef, sha } : { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });

async function card(s: Scenario, title: string, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-${number}`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
  });
  await pullRequestEvent('opened', number, headRef);
  return { item, headRef };
}

/** A check completing at `headSha` with `conclusion`, or starting (`null`). */
const check = (
  number: number,
  headSha: string,
  name: string,
  conclusion: 'success' | 'failure' | null,
) =>
  githubWebhookService.handleEvent('check_run', {
    action: conclusion === null ? 'created' : 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: headSha,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
      name,
      check_suite: { head_branch: null },
      pull_requests: [{ number }],
    },
  });

const fixOf = async (id: string) => {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return { fixReason: row.fixReason, fixDetail: row.fixDetail as Record<string, unknown> | null };
};
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const prRow = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a check run', () => {
  it('a red check on an Implemented card sets ci_failed; a green push clears it', async () => {
    const s = await makeScenario('red@example.com');
    const { item } = await card(s, 'red card', 31);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect((await fixOf(item.id)).fixReason).toBeNull();

    await check(31, 'sha-a', 'vitest', 'failure');
    expect(await fixOf(item.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { check: 'vitest', repair: 'fix', affected: 1, total: 1 },
    });

    await check(31, 'sha-b', 'vitest', 'success');
    expect((await fixOf(item.id)).fixReason).toBeNull();
  });

  // MOTIR-7491 (found on MOTIR-1408): the red arrived BEFORE the card reached In Review, so
  // the edge-triggered red hold never fired, and a hand move to In Review then RECOMPUTED
  // the reason to null — the card left To fix while its pull request was still red.
  it('a card moved to In Review by hand while already red keeps ci_failed', async () => {
    const s = await makeScenario('red-review@example.com');
    const { item } = await card(s, 'red then reviewed', 32);
    await check(32, 'sha-a', 'vitest', 'failure');
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect((await fixOf(item.id)).fixReason).toBe('ci_failed');

    await workItemsService.updateStatus(item.id, 'in_review', s.ctx);

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await fixOf(item.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { check: 'vitest', repair: 'fix', affected: 1, total: 1 },
    });
  });
});

describe('a merge-queue exit', () => {
  it('a queue FAILURE sets queue_failed in the dequeued delivery’s own transaction', async () => {
    const s = await makeScenario('queue@example.com');
    const { item } = await card(s, 'queued card', 41);
    await check(41, 'sha-a', 'vitest', 'success');
    expect(await statusOf(item.id)).toBe('in_review');
    const [gate] = await adminDb.approvalGate.findMany({
      where: { workItemId: item.id, kind: 'pull_request_approval', state: 'awaiting' },
    });
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, decision: 'approve', source: 'ui' },
      s.ctx,
    );
    const pr = await prRow(41);
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { mergeAuthority: 'gate', mergeOutcomeRef: 'queue:entry-41' },
    });

    const file = join(
      process.cwd(),
      'tests/fixtures/github/merge-queue',
      'dequeued-ci-failure.json',
    );
    const body = JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
    const pull = structuredClone(body['pull_request']) as Record<string, unknown>;
    pull['number'] = 41;
    pull['head'] = { ...(pull['head'] as Record<string, unknown>), sha: 'sha-a' };
    await githubWebhookService.handleEvent(
      'pull_request',
      {
        ...body,
        number: 41,
        installation: INSTALLATION,
        repository: { id: Number(REPO_PROVIDER_ID), full_name: 'moooon/acme' },
        pull_request: pull,
      },
      'guid-fix-wiring-1',
    );

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await fixOf(item.id)).toMatchObject({
      fixReason: 'queue_failed',
      fixDetail: { queueReason: 'CI_FAILURE', repair: 'fix' },
    });

    // A push that goes green moves the head, so the exit stops standing.
    await check(41, 'sha-a2', 'vitest', 'success');
    expect((await fixOf(item.id)).fixReason).toBeNull();
  });
});

describe('a mergeability reading', () => {
  it('a conflicted reading sets conflicted; a push clears the reading and a clean one keeps it clear', async () => {
    const s = await makeScenario('conflict@example.com');
    const { item, headRef } = await card(s, 'conflicted card', 51);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    await check(51, 'sha-a', 'vitest', 'success');
    // A green check promotes the card; hold it at Implemented the way a conflict does.
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'implemented' } });
    const pr = await prRow(51);

    await pullRequestMergeabilityService.settleReading(s.workspace.id, pr.id, {
      mergeable: false,
      mergeableState: 'dirty',
      headSha: 'sha-a',
    });
    expect(await fixOf(item.id)).toMatchObject({
      fixReason: 'conflicted',
      fixDetail: { base: 'main' },
    });

    await pullRequestEvent('synchronize', 51, headRef, 'sha-b');
    expect((await fixOf(item.id)).fixReason).toBeNull();

    await pullRequestMergeabilityService.settleReading(s.workspace.id, pr.id, {
      mergeable: true,
      mergeableState: 'clean',
      headSha: 'sha-a',
    });
    expect((await fixOf(item.id)).fixReason).toBeNull();
  });

  it('a clean reading clears a conflict recorded earlier', async () => {
    const s = await makeScenario('clean@example.com');
    const { item } = await card(s, 'conflicted card', 52);
    await check(52, 'sha-a', 'vitest', 'success');
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'implemented' } });
    const pr = await prRow(52);
    await pullRequestMergeabilityService.settleReading(s.workspace.id, pr.id, {
      mergeable: false,
      mergeableState: 'dirty',
      headSha: 'sha-a',
    });
    expect((await fixOf(item.id)).fixReason).toBe('conflicted');

    await pullRequestMergeabilityService.settleReading(s.workspace.id, pr.id, {
      mergeable: true,
      mergeableState: 'clean',
      headSha: 'sha-a',
    });
    expect((await fixOf(item.id)).fixReason).toBeNull();
  });
});

describe('a gate decision', () => {
  it('Request changes sets changes_requested; a new commit ends it', async () => {
    const s = await makeScenario('changes@example.com');
    const { item } = await card(s, 'reviewed card', 61);
    await check(61, 'sha-a', 'vitest', 'success');
    const [gate] = await adminDb.approvalGate.findMany({
      where: { workItemId: item.id, kind: 'pull_request_approval', state: 'awaiting' },
    });

    await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: gate!.id,
        decision: 'request_changes',
        noteMd: 'Rename the export button.\nAnd the tooltip.',
        source: 'ui',
      },
      s.ctx,
    );

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await fixOf(item.id)).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: {
        repair: 'fix',
        gate: 'pull_request_approval',
        notePreview: 'Rename the export button.',
      },
    });
    // …and `motir fix` claims it — the `review` class, with the WHOLE note (MOTIR-6822).
    const claim = await workItemRepairService.claimRepair(s.project.id, item.identifier, s.ctx);
    expect(claim).toMatchObject({
      outcome: 'claimed',
      repairClass: 'review',
      reviewRefusal: {
        gate: 'pull_request_approval',
        findingsMd: 'Rename the export button.\nAnd the tooltip.',
      },
    });

    // The first check at a NEW head is a new commit: the refusal was about the old one.
    await check(61, 'sha-b', 'vitest', null);
    // …so it no longer stands, and while CI runs at that head the card reads Fixing
    // (MOTIR-10307): the CI-start event is what recomputed it.
    expect(await fixOf(item.id)).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: { fixing: true },
    });
    await check(61, 'sha-b', 'vitest', 'success');
    expect((await fixOf(item.id)).fixReason).toBeNull();
    // The repair's push answered the refusal without re-deciding it.
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } })).state).toBe(
      'changes_requested',
    );
  });
});

describe('a status move', () => {
  it('moving a to-fix card to a done-category status clears it; archiving clears it too', async () => {
    const s = await makeScenario('status@example.com');
    const { item } = await card(s, 'red card', 71);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    await check(71, 'sha-a', 'vitest', 'failure');
    expect((await fixOf(item.id)).fixReason).toBe('ci_failed');

    // `done` itself is held while a pull request is open (only its merge writes it), so
    // the done-category move a person can make here is `cancelled`.
    await workItemsService.updateStatus(item.id, 'cancelled', s.ctx);
    expect(await fixOf(item.id)).toEqual({ fixReason: null, fixDetail: null });

    // Back to Implemented — a status move re-reads it.
    await workItemsService.updateStatus(item.id, 'todo', s.ctx);
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect((await fixOf(item.id)).fixReason).toBe('ci_failed');

    await workItemsService.archiveWorkItem(item.id, s.ctx);
    expect((await fixOf(item.id)).fixReason).toBeNull();
    await workItemsService.unarchiveWorkItem(item.id, s.ctx);
    expect((await fixOf(item.id)).fixReason).toBe('ci_failed');
  });
});

// THE RESUME STATE RIDES THE SAME CI EVENTS (Story MOTIR-10305 · MOTIR-10308): a CI
// start after a gated run ended takes the card off To resume in the check row's own
// transaction — the pending arm and the terminal verdict arm both recompute it.
describe('a gated card whose CI starts again', () => {
  async function gatedCard(s: Scenario, number: number) {
    const { item } = await card(s, `gated ${number}`, number);
    // Linking the pull request delivered it to Implemented; an open delivery there is
    // MOTIR-8611's exit, so put the card back where a run that stopped at a gate leaves it.
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_progress' } });
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        command: 'run',
        status: 'succeeded',
        stopReason: 'gated',
        endedAt: new Date(Date.now() - 60_000),
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
    // No held gate recorded: the run is released at once.
    expect(
      await withWorkspaceContext(s.ctx, (tx) => recomputeWorkItemResumeState(item.id, tx)),
    ).toEqual({ resumeState: 'ready_to_resume', resumeRunId: run.id });
    return item;
  }
  const resumeOf = async (id: string) =>
    (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).resumeState;

  it('a check STARTING clears the stored resume state (the pending arm)', async () => {
    const s = await makeScenario('resume-pending@example.com');
    const item = await gatedCard(s, 91);

    await check(91, 'sha-a', 'vitest', null);

    expect(await resumeOf(item.id)).toBeNull();
  });

  it('a check reported only when it finishes clears it too (the verdict arm)', async () => {
    const s = await makeScenario('resume-verdict@example.com');
    const item = await gatedCard(s, 92);

    await check(92, 'sha-a', 'vitest', 'success');

    expect(await resumeOf(item.id)).toBeNull();
  });
});
