import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult, MergeRefusalCode } from '@/lib/git/types';
import { classOfMergeRefusal } from '@/lib/mergeQueue/queueExit';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import {
  mergeApprovedSetMembers,
  pullRequestMergeService,
} from '@/lib/services/pullRequestMergeService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// THE HOST'S REFUSAL, RECORDED (Story MOTIR-5799 · MOTIR-5833;
// `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, points 2 and 5), on a REAL
// Postgres.
//
// One approval authorizes ONE merge action. Before this card a refusal at the press
// existed only in that request's response: a reload showed a card reading **Approved**
// with nothing anywhere saying the merge had been refused, or why. Now the code, the
// head and the time are a row on the pull request, and the card is settled by the
// refusal's CLASS through the same entry point a queue exit uses.
//
// The seam's `mergeChangeRequest` is the one thing stubbed — it is what leaves the
// process.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-merge-refusal';
const REPO_PROVIDER_ID = '995';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const KIND = 'pull_request_approval';
const github = getGitProvider('github') as Required<GitProvider>;

async function scenario(email: string, mode: 'manual' | 'auto' = 'manual') {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
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
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: mode } });
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
  return { user, project, workspace, ctx: { userId: user.id, workspaceId: workspace.id } };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

const ci = (number: number, headSha: string) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const prRow = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
const awaitingGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind: KIND, state: 'awaiting' } });
const refusalsOf = async (number: number) =>
  adminDb.githubPullRequestMergeRefusal.findMany({
    where: { pullRequestId: (await prRow(number)).id },
    orderBy: { refusedAt: 'asc' },
  });

const stubHost = (answer: MergeChangeRequestResult) =>
  vi.spyOn(github, 'mergeChangeRequest').mockResolvedValue(answer);

/** A card with ONE green pull request (#41), approved — and the press about to be made. */
async function approvedCard(email: string, mode: 'manual' | 'auto' = 'manual') {
  const s = await scenario(email, mode);
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'One change' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-41`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number: 41,
    headRef,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: 41,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  await ci(41, 'sha-41');
  const [gate] = await awaitingGates(item.id);
  return { s, item, gate: gate ?? null };
}

const press = async (s: Scenario, gateId: string) =>
  pullRequestMergeService.approveAndMerge(
    { stamp: DECIDED_WITHOUT_A_READER, gateId, source: 'ui' },
    s.ctx,
  );

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the class map answers for the HOST too', () => {
  it.each([
    ['checks_not_green', 'cant_land'],
    ['conflict', 'cant_land'],
    ['out_of_date', 'cant_land'],
    ['branch_protected', 'setting'],
    ['app_permission_missing', 'setting'],
    ['already_merged', 'landed'],
  ] as const)('%s → %s', (code, landingClass) => {
    expect(classOfMergeRefusal(code)).toBe(landingClass);
  });

  it('`subject_changed` is NOT an outcome — nothing was attempted, so nothing was spent', () => {
    expect(classOfMergeRefusal('subject_changed')).toBeNull();
  });

  it('a code this deployment has never seen is RETRYABLE — a person is asked', () => {
    expect(classOfMergeRefusal('some_host_said_this')).toBe('retryable');
  });

  it('is TOTAL over the seam’s union — every member has an answer', () => {
    const every: MergeRefusalCode[] = [
      'checks_not_green',
      'conflict',
      'out_of_date',
      'branch_protected',
      'already_merged',
      'app_permission_missing',
      'subject_changed',
    ];
    for (const code of every) expect(() => classOfMergeRefusal(code)).not.toThrow();
  });
});

describe('a refused press RECORDS the refusal and settles the card by its class', () => {
  it.each([
    ['conflict', 'implemented', 0],
    ['out_of_date', 'implemented', 0],
    ['checks_not_green', 'implemented', 0],
    ['branch_protected', 'in_review', 1],
    ['app_permission_missing', 'in_review', 1],
  ] as const)(
    '%s leaves the card at %s with %i awaiting gate(s), and one refusal row',
    async (code, status, gateCount) => {
      const { s, item, gate } = await approvedCard(`refuse-${code}@example.com`);
      stubHost({ outcome: 'refused', refusal: { code } });

      const result = await press(s, gate!.id);

      expect(result.members[0]).toMatchObject({ outcome: 'refused' });
      const rows = await refusalsOf(41);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        code,
        headSha: 'sha-41',
        approvalGateId: gate!.id,
        supersededAt: null,
      });
      expect(await statusOf(item.id)).toBe(status);
      expect(await awaitingGates(item.id)).toHaveLength(gateCount);
      // The decided gate is history and is never edited.
      expect(
        (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } })).state,
      ).toBe('approved');
    },
  );

  it('an OUT-OF-DATE refusal stores the `behind` reading, so the card reads To fix rather than Approved (MOTIR-10054)', async () => {
    const { s, item, gate } = await approvedCard('refuse-behind@example.com');
    stubHost({
      outcome: 'refused',
      refusal: { code: 'out_of_date', reason: '2 of 2 required status checks are expected.' },
    });

    const result = await press(s, gate!.id);

    expect(result.members[0]).toMatchObject({ outcome: 'refused' });
    expect((await refusalsOf(41))[0]).toMatchObject({
      code: 'out_of_date',
      reason: '2 of 2 required status checks are expected.',
    });
    expect(await prRow(41)).toMatchObject({
      mergeableState: 'behind',
      mergeableStateHeadSha: 'sha-41',
    });
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('implemented');
    expect(after.fixReason).toBe('out_of_date');
    expect(await awaitingGates(item.id)).toHaveLength(0);
  });

  it('a refusal of any OTHER code leaves the stored mergeability as it was', async () => {
    const { s, gate } = await approvedCard('refuse-not-behind@example.com');
    const before = await prRow(41);
    stubHost({ outcome: 'refused', refusal: { code: 'checks_not_green' } });

    await press(s, gate!.id);

    expect(await prRow(41)).toMatchObject({
      mergeableState: before.mergeableState,
      mergeableStateHeadSha: before.mergeableStateHeadSha,
    });
  });

  it('`app_permission_missing` keeps the permission the host named, for the surface to say', async () => {
    const { s, gate } = await approvedCard('refuse-permission@example.com');
    stubHost({
      outcome: 'refused',
      refusal: { code: 'app_permission_missing', permission: 'contents: write' },
    });

    await press(s, gate!.id);

    expect((await refusalsOf(41))[0]).toMatchObject({ permission: 'contents: write' });
  });

  it('the SETTING refusal is asked again, and a second refusal records a second row', async () => {
    const { s, item, gate } = await approvedCard('refuse-twice@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);

    const [reasked] = await awaitingGates(item.id);
    expect(reasked).toBeDefined();
    await press(s, reasked!.id);

    expect(await refusalsOf(41)).toHaveLength(2);
    expect(await statusOf(item.id)).toBe('in_review');
    // Still exactly ONE question, over the same commits.
    expect(await awaitingGates(item.id)).toHaveLength(1);
  });

  it('a press that LANDS retires the refusal the pull request carried', async () => {
    const { s, item, gate } = await approvedCard('refuse-then-land@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);
    const [reasked] = await awaitingGates(item.id);

    stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    await press(s, reasked!.id);

    expect((await refusalsOf(41))[0]!.supersededAt).not.toBeNull();
    expect(await statusOf(item.id)).toBe('approved');
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('`subject_changed` records NOTHING and moves nothing — the press never happened', async () => {
    const { s, item, gate } = await approvedCard('refuse-stale@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'subject_changed' } });

    const result = await press(s, gate!.id);

    expect(result.members[0]).toMatchObject({ outcome: 'refused' });
    expect(await refusalsOf(41)).toEqual([]);
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('a PUSH retires a standing refusal — the head it names is no longer the member’s', async () => {
    const { s, item, gate } = await approvedCard('refuse-then-push@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'conflict' } });
    await press(s, gate!.id);
    expect(await statusOf(item.id)).toBe('implemented');

    // The agent pushed, and the new commits went green: the refusal no longer describes
    // the code, so the card asks about the NEW commits (MOTIR-5604's path).
    await ci(41, 'sha-41b');

    const gates = await awaitingGates(item.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.subjectVersion).toContain('sha-41b');
  });

  it('the member read carries the standing refusal, and drops it once the head moves', async () => {
    const { s, item, gate } = await approvedCard('refuse-read@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);

    const read = async (gateId: string) =>
      (
        await pullRequestMergeService.listApprovalMembers(
          { workItemId: item.id, approvalGateId: gateId },
          s.ctx,
        )
      )[0];

    expect(await read(gate!.id)).toMatchObject({
      refusal: { code: 'branch_protected', landingClass: 'setting', permission: null },
    });

    await ci(41, 'sha-41c');
    expect(await read(gate!.id)).toMatchObject({ refusal: null });
  });
});

// Bug MOTIR-6735: an enqueue error the classifier does not recognise is filed under
// `branch_protected`, and GitHub's message was the only thing naming the setting — yet
// the row had no column for it, so a reload told a person to "change the setting" and
// named none. The message is now kept on the row and returned by both reads.
describe('the HOST’s own message is kept with the refusal', () => {
  const MESSAGE =
    'Repository rule violations found: required status check "CI complete" is expected.';

  it('an unrecognised host error keeps GitHub’s words on the row, the member read and the delivery set', async () => {
    const { s, item, gate } = await approvedCard('refuse-reason@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected', reason: MESSAGE } });

    await press(s, gate!.id);

    expect((await refusalsOf(41))[0]).toMatchObject({ code: 'branch_protected', reason: MESSAGE });
    const [member] = await pullRequestMergeService.listApprovalMembers(
      { workItemId: item.id, approvalGateId: gate!.id },
      s.ctx,
    );
    expect(member!.refusal).toMatchObject({ code: 'branch_protected', reason: MESSAGE });
    const [delivery] = await workItemsService.listDeliverySet(item.id, s.ctx);
    expect(delivery!.mergeRefusal).toEqual({
      code: 'branch_protected',
      reason: MESSAGE,
      headSha: 'sha-41',
      refusedAt: expect.any(String),
    });
  });

  it('a refusal the host gave NO words for records null — never an empty string', async () => {
    const { s, item, gate } = await approvedCard('refuse-no-reason@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected', reason: '   ' } });

    await press(s, gate!.id);

    expect((await refusalsOf(41))[0]!.reason).toBeNull();
    const [delivery] = await workItemsService.listDeliverySet(item.id, s.ctx);
    expect(delivery!.mergeRefusal).toMatchObject({ code: 'branch_protected', reason: null });
  });

  it('a pathological message is bounded rather than carried whole into every read', async () => {
    const { s, gate } = await approvedCard('refuse-long-reason@example.com');
    stubHost({
      outcome: 'refused',
      refusal: { code: 'branch_protected', reason: 'x'.repeat(5000) },
    });

    await press(s, gate!.id);

    expect((await refusalsOf(41))[0]!.reason).toHaveLength(2000);
  });

  it('the delivery set drops the refusal once a push moves the head — it no longer describes the code', async () => {
    const { s, item, gate } = await approvedCard('refuse-reason-push@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected', reason: MESSAGE } });
    await press(s, gate!.id);

    await ci(41, 'sha-41d');

    const [delivery] = await workItemsService.listDeliverySet(item.id, s.ctx);
    expect(delivery!.mergeRefusal).toBeNull();
  });

  it('a pull request nothing refused carries no refusal in the delivery set', async () => {
    const { s, item } = await approvedCard('refuse-none@example.com');

    const [delivery] = await workItemsService.listDeliverySet(item.id, s.ctx);
    expect(delivery!.mergeRefusal).toBeNull();
  });
});

describe('auto mode records nothing', () => {
  it('an auto project has no approval to spend, so a refused press writes no row', async () => {
    const { s, item } = await approvedCard('refuse-auto@example.com', 'auto');
    // `auto` raises no gate at all, so there is nothing to press — which is the point:
    // the refusal path this card writes is reachable only from a `manual` approval.
    expect(await awaitingGates(item.id)).toEqual([]);
    expect(await refusalsOf(41)).toEqual([]);
    expect(s.ctx.workspaceId).toBeTruthy();
  });
});

describe('§8’s Retry merge on the standing approval is CLOSED (MOTIR-5834)', () => {
  const retry = (s: Scenario, approvalGateId: string, pullRequestId: string) =>
    pullRequestMergeService.retryApproveAndMergeMember(
      {
        approvalGateId,
        pullRequestId,
        noteMd: null,
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );

  it('a SETTING refusal refuses the retry on the spent approval, and the FRESH gate merges it', async () => {
    const { s, item, gate } = await approvedCard('retry-setting@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);
    const prId = (await prRow(41)).id;
    // ⚠️ The spy survives a second `stubHost` (vi.spyOn returns the one already
    // installed), so clear the press's own call before counting this one's.
    const host = stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    host.mockClear();

    // The approval that made the refused press cannot make a second one.
    const refused = await retry(s, gate!.id, prId);
    expect(refused).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(host).not.toHaveBeenCalled();

    // The re-asked gate IS the new approval, and the row's verb decides it.
    const [reasked] = await awaitingGates(item.id);
    const landed = await retry(s, reasked!.id, prId);

    expect(landed).toMatchObject({ outcome: 'merged' });
    expect(host).toHaveBeenCalledTimes(1);
    expect(await statusOf(item.id)).toBe('approved');
    expect((await refusalsOf(41))[0]!.supersededAt).not.toBeNull();
  });

  it('a CAN’T-LAND refusal offers no retry at all — the commits have to change', async () => {
    const { s, item, gate } = await approvedCard('retry-conflict@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'conflict' } });
    await press(s, gate!.id);
    const prId = (await prRow(41)).id;
    const host = stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    host.mockClear();

    const refused = await retry(s, gate!.id, prId);

    expect(refused).toMatchObject({ outcome: 'refused', refusal: { tag: 'MERGE_CONFLICT' } });
    expect(host).not.toHaveBeenCalled();
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('a member with NO standing refusal still retries under its approval — the shipped path', async () => {
    const { s, gate } = await approvedCard('retry-plain@example.com');
    // The host fails to answer at all: nothing is recorded, and the member is simply
    // unmerged (MOTIR-5613's case, which this card does not touch).
    vi.spyOn(github, 'mergeChangeRequest').mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'MergeChangeRequestError' }),
    );
    await press(s, gate!.id).catch(() => {});
    const prId = (await prRow(41)).id;
    expect(await refusalsOf(41)).toEqual([]);

    const host = stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    host.mockClear();
    const outcome = await retry(s, gate!.id, prId);

    expect(outcome).toMatchObject({ outcome: 'merged' });
    expect(host).toHaveBeenCalledTimes(1);
  });
});

// ── THE ARMS AT THE EDGES OF THE CLASS MAP (MOTIR-5833 · MOTIR-5834) ────────────
//
// Three doors the ordinary walk never opens, each of which decides something a person
// sees. They are here rather than in a journey because reaching them takes a state the
// happy path cannot produce — a code with no class, a row backdated past its approval,
// a press naming a pull request the gate does not.
describe('the edges of the class map', () => {
  const retry = (s: Scenario, approvalGateId: string, pullRequestId: string) =>
    pullRequestMergeService.retryApproveAndMergeMember(
      {
        approvalGateId,
        pullRequestId,
        noteMd: null,
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );

  it('a SUBJECT-CHANGED refusal records NOTHING — the approval was never spent', async () => {
    const { s, item, gate } = await approvedCard('refuse-classless@example.com');
    // ⚠️ `subject_changed` IS THE ONE REFUSAL THAT WRITES NO ROW, and it is why
    // `classOfMergeRefusal` answers NULL for it rather than picking a class. The host's
    // 409 means the head moved between the check and the merge: nothing was merged and
    // nothing was attempted against these commits, so the approval was not spent and
    // there is no un-landed outcome to settle. It reads as the withdrawn question it is.
    expect(classOfMergeRefusal('subject_changed')).toBeNull();
    stubHost({ outcome: 'refused', refusal: { code: 'subject_changed' } });

    const { members } = await press(s, gate!.id);

    expect(members[0]).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'APPROVAL_GATE_SUPERSEDED' },
    });
    expect(await refusalsOf(41)).toEqual([]);
    expect(await statusOf(item.id)).toBe('approved');
    expect(await awaitingGates(item.id)).toEqual([]);
  });

  it('a refusal recorded BEFORE the approval does not spend it — the retry still merges', async () => {
    const { s, item, gate } = await approvedCard('refuse-backdated@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);
    const prId = (await prRow(41)).id;

    // ⚠️ THE PREDICATE IS *OUTRANKS*, NOT *EXISTS* (`unlandedOutcomeOutranksApproval`).
    // A refusal from BEFORE the approval was decided is about an earlier press, so it
    // cannot have spent this one — the same rule a stale queue exit gets. Backdated
    // rather than staged, because producing the order honestly needs two approvals and
    // the point is the comparison, not the journey.
    await adminDb.githubPullRequestMergeRefusal.updateMany({
      where: { pullRequestId: prId },
      data: { refusedAt: new Date('2020-01-01T00:00:00.000Z') },
    });
    const [reasked] = await awaitingGates(item.id);
    // Decide the re-asked gate away, so the retry below runs on the DECIDED gate rather
    // than being routed to it as the new approval.
    await adminDb.approvalGate.update({
      where: { id: reasked!.id },
      data: { state: 'superseded', supersededCause: 'head_moved' },
    });
    const host = stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    host.mockClear();

    expect(await retry(s, gate!.id, prId)).toMatchObject({ outcome: 'merged' });
    expect(host).toHaveBeenCalledTimes(1);
  });

  it('a member whose HEAD MOVED since the approval has NOTHING TO MERGE — no host call, no new row', async () => {
    const { s, item, gate } = await approvedCard('refuse-stale-head@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);
    const prId = (await prRow(41)).id;
    // The gate the press DECIDED — read back rather than assumed, because a refused
    // press leaves a fresh awaiting one beside it.
    const decided = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: item.id, kind: KIND, state: 'approved' },
    });
    // A new commit reports green. The DECIDED gate names the OLD head, so it no longer
    // describes this pull request — and the refusal recorded against the old head stops
    // standing at the same moment. `checkMember` answers `stale`, and the retry reports
    // the withdrawn question rather than merging commits nobody approved.
    await ci(41, 'sha-41-moved');
    const host = stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    host.mockClear();

    const outcome = await retry(s, decided.id, prId);

    // ⚠️ `no_merge_gate`, NOT a refusal (MOTIR-5613): nothing was refused — this card no
    // longer delivers that member at the head it was approved at, so there is nothing to
    // merge and nothing to report against the approval. The next green raises the
    // question again, over the new commits.
    expect(outcome).toMatchObject({ outcome: 'no_merge_gate', pullRequestId: null });
    expect(host).not.toHaveBeenCalled();
    // The press's own refusal is still on the record — it happened — and it is simply no
    // longer standing at this head.
    expect(await refusalsOf(41)).toHaveLength(1);
  });

  it('a press naming a pull request the DECIDED gate never covered is refused, not merged', async () => {
    const { s, item, gate } = await approvedCard('refuse-foreign-pr@example.com');
    // A SECOND pull request, linked after the question was asked: the card delivers it,
    // and the approval says nothing about it. Matching is by `owner/name#number`, so the
    // door finds the delivery and then finds no member — and refuses rather than merging
    // a pull request on the strength of a yes about a different one.
    const headRef = `subtask/${item.identifier}-42`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 42,
      headRef,
    });
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 42,
        state: 'open',
        merged: false,
        title: `Another change (${headRef})`,
        head: { ref: headRef },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    const host = stubHost({ outcome: 'merged', commitSha: 'merged-42' });
    host.mockClear();

    await expect(retry(s, gate!.id, (await prRow(42)).id)).rejects.toMatchObject({
      tag: 'APPROVAL_GATE_SUPERSEDED',
    });
    expect(host).not.toHaveBeenCalled();
  });

  it('a press naming a pull request the RE-ASKED gate does not cover answers `no_merge_gate`', async () => {
    const { s, item, gate } = await approvedCard('refuse-other-pr@example.com');
    stubHost({ outcome: 'refused', refusal: { code: 'branch_protected' } });
    await press(s, gate!.id);
    const [reasked] = await awaitingGates(item.id);
    stubHost({ outcome: 'merged', commitSha: 'merged-41' });

    // The row's press decides the WHOLE gate and then reports ITS member — so a stale
    // tab pressing for a pull request the gate never named still decides the gate, and
    // is told there is no outcome of its own to report.
    const outcome = await retry(s, reasked!.id, 'a-pull-request-this-gate-never-named');

    expect(outcome).toMatchObject({ outcome: 'no_merge_gate', pullRequestId: null });
    expect(await statusOf(item.id)).toBe('approved');
  });
});

// ── THE SET MERGER'S OWN DOORS (MOTIR-4882 · MOTIR-5608) ────────────────────────
//
// `mergeApprovedSetMembers` is called AFTER a decision commits — by the press, and by the
// synced-review runner — with a gate id it did not validate itself. Its contract is that a
// per-member refusal is a RESULT rather than a throw, so one bad member never costs the
// others their merge. These are the doors `checkMember` closes before a host is ever
// called, each returning the refusal that is TRUE of it.
describe('the set merger refuses per member, and calls no host', () => {
  const merge = (s: Scenario, gateId: string, subjectVersion: string | null) =>
    mergeApprovedSetMembers(gateId, subjectVersion, s.ctx);

  it.each([
    [
      'superseded',
      { state: 'superseded', supersededCause: 'head_moved' },
      'APPROVAL_GATE_SUPERSEDED',
    ],
    ['changes requested', { state: 'changes_requested' }, 'APPROVAL_GATE_ALREADY_DECIDED'],
  ] as const)('a gate that is %s merges nothing', async (label, data, tag) => {
    const { s, gate } = await approvedCard(`set-${label.replace(/\s/g, '-')}@example.com`);
    const host = stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    host.mockClear();
    await adminDb.approvalGate.update({ where: { id: gate!.id }, data });

    const [member] = await merge(s, gate!.id, gate!.subjectVersion);

    expect(member, label).toMatchObject({ outcome: 'refused', refusal: { tag } });
    expect(host, label).not.toHaveBeenCalled();
  });

  it('a gate nobody has ever raised is NOT FOUND, per member', async () => {
    const { s, gate } = await approvedCard('set-no-gate@example.com');
    const host = stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    host.mockClear();

    const [member] = await merge(s, 'cmthisisnotagateatall0001', gate!.subjectVersion);

    expect(member).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'APPROVAL_GATE_NOT_FOUND' },
    });
    expect(host).not.toHaveBeenCalled();
  });

  it('a gate still AWAITING is a programming error, and is thrown rather than reported', async () => {
    const { s, gate } = await approvedCard('set-awaiting@example.com');
    const host = stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    host.mockClear();

    // ⚠️ NOT a refusal: every caller decides first, so reaching here with an undecided
    // gate means the CALLER is wrong. A refusal would report it as something the host or
    // the reader did, and it is neither.
    await expect(merge(s, gate!.id, gate!.subjectVersion)).rejects.toThrow(
      /merge was attempted under an awaiting gate/,
    );
    expect(host).not.toHaveBeenCalled();
  });
});

describe('the set merger asks WHO is pressing', () => {
  it('a workspace member who may not decide this card merges nothing', async () => {
    const { s, gate } = await approvedCard('set-bystander@example.com');
    // A colleague in the same workspace, neither the card's assignee nor its reporter
    // and holding no `approval:decide_any`. The authority check is `checkMember`'s, so
    // it runs per member and refuses per member — the same answer the door gives.
    const bystander = await usersService.createUser({
      email: 'set-bystander-other@example.com',
      password: PASSWORD,
      name: 'Bea',
    });
    await workspacesService.addMember({ userId: bystander.id, workspaceId: s.workspace.id });
    const host = stubHost({ outcome: 'merged', commitSha: 'merged-41' });
    host.mockClear();

    const [member] = await mergeApprovedSetMembers(gate!.id, gate!.subjectVersion, {
      userId: bystander.id,
      workspaceId: s.workspace.id,
    });

    expect(member).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'APPROVAL_GATE_NOT_AUTHORISED' },
    });
    expect(host).not.toHaveBeenCalled();
  });
});
