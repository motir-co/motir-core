import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: async () => undefined,
}));

import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { gateDecisionRefusalResponse } from '@/lib/approvalGates/decisionRefusalResponse';
import { ApprovalGateDeliveryUnreadableError } from '@/lib/approvalGates/errors';
import { toGateRefusal } from '@/lib/approvalGates/refusals';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { projectsService } from '@/lib/services/projectsService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// THE GATE AND THE MERGE OVER A DELIVERY SET THE CARD CANNOT FULLY READ (Bug MOTIR-8236).
//
// A delivery row is admitted on the CARD's workspace; the pull request and the repository
// it joins are admitted through `github_repo`'s policies, which key on the REPOSITORY's
// workspace and organisation. When the repository stops belonging to the card's
// organisation, the delivery row stays visible and its joins come back NULL — a value the
// generated type says cannot happen. MOTIR-8215 made the DISPLAY reads drop such a member.
// The approval gate and approve-and-merge must not: deciding over part of a set would let
// a merge approve pull requests nobody was shown, so they REFUSE, by name, instead of
// throwing `TypeError: Cannot read properties of null (reading 'checkRuns')`.
//
// The unreadable state is made directly — the repository row moved to another
// organisation — because the way it first arose in production (a second organisation
// connecting the same installation) is being closed by MOTIR-8216, while the state can
// still be reached by a repository legitimately changing hands.

const INSTALLATION_ID = 'inst-delivery-unreadable';
const REPO_PROVIDER_ID = '995';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

let heads: Record<number, string> = {};

function stubHost(): void {
  heads = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status });
      const pull = url.match(/\/repos\/moooon\/acme\/pulls\/(\d+)(\/merge)?$/);
      if (url.endsWith('/repos/moooon/acme') && method === 'GET') {
        return json(200, { allow_squash_merge: true });
      }
      if (url.includes('/rules/branches/')) return json(200, []);
      if (pull && pull[2] && method === 'PUT') {
        return json(200, { merged: true, sha: `merge-${pull[1]}` });
      }
      if (pull && !pull[2]) {
        const n = Number(pull[1]);
        return json(200, {
          node_id: `PR_${n}`,
          merged: false,
          state: 'open',
          // A head nobody has reported yet is one the host does not name: the link door asks
          // the host about the pull request it links (MOTIR-12094), and a made-up head would be
          // stored as the one CI must report at.
          head: heads[n] ? { sha: heads[n] } : {},
          base: { ref: 'main' },
        });
      }
      return json(404, {});
    }),
  );
}

async function makeOrg(email: string, name: string, identifier: string) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: user.id });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name,
    identifier,
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

function prOpened(number: number, headRef: string) {
  return githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      merged_at: null,
      title: 'A change',
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

function ciGreen(number: number, headSha: string) {
  heads[number] = headSha;
  return githubWebhookService.handleEvent('check_suite', {
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
}

/** A card in a manual project whose one pull request is green, holding its merge gate. */
async function greenCard() {
  const ours = await makeOrg('ours@example.com', 'Ours', 'OURS');
  await adminDb.project.update({ where: { id: ours.project.id }, data: { prMergeMode: 'manual' } });
  await githubInstallationService.persistInstallation({
    workspaceId: ours.workspace.id,
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
  const item = await workItemsService.createWorkItem(
    { projectId: ours.project.id, kind: 'task', title: 'Delivered by one pull request' },
    ours.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ours.ctx);
  const headRef = `subtask/${item.identifier}-21`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number: 21,
    headRef,
  });
  await prOpened(21, headRef);
  await ciGreen(21, 'sha-21');
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: item.id, kind: 'pull_request_approval', state: 'awaiting' },
  });
  return { ours, item, gate };
}

/** Move the card's pull request onto a repository of another organisation — the
 *  delivery row stays behind. A repository row cannot change organisation in place
 *  (`trg_github_repo_one_organization`, MOTIR-8218), so the pull request is the row
 *  that moves; the reader sees the same NULL join either way. */
async function moveRepositoryAway() {
  const theirs = await makeOrg('theirs@example.com', 'Theirs', 'THEM');
  const ours = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: REPO_PROVIDER_ID } });
  const elsewhere = await adminDb.githubRepo.create({
    data: {
      installationId: ours.installationId,
      repoId: `${REPO_PROVIDER_ID}-elsewhere`,
      owner: ours.owner,
      name: `${ours.name}-elsewhere`,
      defaultBranch: ours.defaultBranch,
      workspaceId: theirs.workspace.id,
      organizationId: theirs.workspace.organizationId,
    },
  });
  await adminDb.githubPullRequest.updateMany({
    where: { repoId: ours.id },
    data: { repoId: elsewhere.id },
  });
  return theirs;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  stubHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the gate and merge readers over a delivery the card cannot read', () => {
  it('reads the whole set while every member is readable', async () => {
    const { ours, item } = await greenCard();
    const rows = await withWorkspaceContext(ours.ctx, (tx) =>
      workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
    );
    expect(rows.map((r) => r.pullRequest.number)).toEqual([21]);
  });

  it('refuses the set by name instead of handing back a null join', async () => {
    const { ours, item } = await greenCard();
    const theirs = await moveRepositoryAway();
    expect(theirs.workspace.organizationId).not.toBe(ours.workspace.organizationId);

    const read = withWorkspaceContext(ours.ctx, (tx) =>
      workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
    );
    await expect(read).rejects.toBeInstanceOf(ApprovalGateDeliveryUnreadableError);
    const err = (await read.catch((e: unknown) => e)) as ApprovalGateDeliveryUnreadableError;
    expect(err.tag).toBe('APPROVAL_GATE_DELIVERY_UNREADABLE');
    expect(err.workItemId).toBe(item.id);
    expect(err.deliveryIds).toHaveLength(1);

    // The delivery row is untouched: the refusal reports what this reader may see.
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: item.id } })).toBe(1);
  });

  it('approve-and-merge refuses with that typed reason and merges nothing', async () => {
    const { ours, item, gate } = await greenCard();
    await moveRepositoryAway();

    await expect(
      pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
        ours.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateDeliveryUnreadableError);

    // Nothing was decided and nothing moved.
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).state).toBe(
      'awaiting',
    );
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_review',
    );
    expect(
      (await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 21 } })).merged,
    ).toBe(false);
  });

  it('reaches the decide door and the approval control as a refusal, not a 500', async () => {
    const err = new ApprovalGateDeliveryUnreadableError('card-1', ['delivery-1']);
    const response = gateDecisionRefusalResponse(err);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ code: 'APPROVAL_GATE_DELIVERY_UNREADABLE' });
    expect(toGateRefusal(err.tag)).toEqual({ tag: 'APPROVAL_GATE_DELIVERY_UNREADABLE' });
  });
});
