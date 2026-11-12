import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// THE REVIEW AGENT'S GATE (Story MOTIR-1626 · MOTIR-6819; ADR `approval-gates.md` §12),
// against a REAL Postgres through the real webhook, promotion, decide door and switch.
//
// `sendEvent` is the one seam stubbed — it records what left, and reads the gate count on
// ANOTHER connection at the moment it left, so an event sent before its gate committed
// would be caught. Everything else is the product's own path.

const sent: Array<{ name: string; data: Record<string, unknown>; reviewsAtSend: number }> = [];
vi.mock('@/lib/jobs/sendEvent', async () => {
  const { adminDb: admin } = await import('../helpers/adminDb');
  return {
    sendEvent: async (name: string, data: Record<string, unknown>) => {
      const reviewsAtSend =
        typeof data['gateId'] === 'string'
          ? await admin.approvalGate.count({ where: { id: String(data['gateId']) } })
          : 0;
      sent.push({ name, data, reviewsAtSend });
    },
  };
});

const store = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

import { db } from '@/lib/db';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import {
  ApprovalGateNotAuthorisedError,
  ApprovalGateStaleSubjectError,
  ApprovalGateSupersededError,
  ApprovalGateVerbNotOfferedError,
} from '@/lib/approvalGates/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import { makeWorkWaitOn } from '../helpers/designWaits';
import { shaFor } from '../helpers/commitShaFixtures';
import { hostAnswersCleanAt } from '../helpers/hostMergeability';

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { approvalGateSettingsService } = await import('@/lib/services/approvalGateSettingsService');
const { pullRequestMergeService } = await import('@/lib/services/pullRequestMergeService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-agent-review';
const REPO_PROVIDER_ID = '6819';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const REVIEW = 'agent_review' as const;
const MERGE = 'pull_request_approval' as const;

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(slug: string, opts: { reviewAgent?: boolean } = {}) {
  const user = await usersService.createUser({
    email: `owner-${slug}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Acme ${slug}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: 'manual', reviewAgentEnabled: opts.reviewAgent ?? true },
  });
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
  return { user, workspace, project, ctx, slug };
}

function pullRequestPayload(action: string, number: number, headRef: string, extra = {}) {
  return {
    action,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
      ...extra,
    },
  };
}

/** A CI verdict for one pull request at one commit. */
const ci = (conclusion: string, headSha: string, number: number) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

async function openLinked(identifier: string, number: number, prefix = 'subtask') {
  const headRef = `${prefix}/${identifier}-${number}`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('opened', number, headRef),
  );
}

const pushTo = (identifier: string, number: number, sha: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('synchronize', number, `subtask/${identifier}-${number}`, {
      head: { ref: `subtask/${identifier}-${number}`, sha },
    }),
  );

/** A card delivered by one pull request, linked and opened, at `implemented`. */
async function cardWithPr(s: Scenario, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: `Card ${number}` },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await openLinked(item.identifier, number);
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

const gatesOf = (workItemId: string, kind: ApprovalGateKind) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind }, orderBy: { createdAt: 'asc' } });

const awaitingOf = async (workItemId: string, kind: ApprovalGateKind) =>
  (await gatesOf(workItemId, kind)).filter((g) => g.state === 'awaiting');

const reviewRequests = () => sent.filter((e) => e.name === 'agent-review/requested');
const autoMerges = () => sent.filter((e) => e.name === 'pull-request/auto-merge.requested');

const version = (number: number, sha: string) => `moooon/acme#${number}@${sha}`;

/** A promoted card holding its one awaiting review at `sha-a`. */
async function reviewing(slug: string, number: number) {
  const s = await makeScenario(slug);
  const item = await cardWithPr(s, number);
  await ci('success', 'sha-a', number);
  expect(await statusOf(item.id)).toBe('in_review');
  const [review] = await awaitingOf(item.id, REVIEW);
  expect(review).toBeDefined();
  return { s, item, review: review! };
}

const agentVerdict = (
  s: Scenario,
  gateId: string,
  subjectVersion: string,
  verdict: 'pass' | 'changes_requested',
  noteMd: string | null = null,
) => approvalGatesService.decideAgentReview({ gateId, subjectVersion, verdict, noteMd }, s.ctx);

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  store.clear();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('§12.2 — a green set with the switch on asks the REVIEW, not the merge', () => {
  it('switch on, manual, green: one awaiting agent_review, no merge gate, one request emitted after commit', async () => {
    const { s, item, review } = await reviewing('raise', 61);

    expect(await awaitingOf(item.id, REVIEW)).toHaveLength(1);
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
    expect(review.subjectId).toBe(item.id);
    expect(review.subjectVersion).toBe(version(61, 'sha-a'));
    expect(review.routedToId).toBe(item.reporterId);

    expect(reviewRequests()).toHaveLength(1);
    expect(reviewRequests()[0]!.data).toEqual({
      workspaceId: s.workspace.id,
      gateId: review.id,
      workItemId: item.id,
      subjectVersion: version(61, 'sha-a'),
      // The request's own key — the job's dedup and the review run's idempotency (MOTIR-6820).
      idempotencyKey: `agent-review:${review.id}:raise`,
    });
    // Sent only once the raising transaction had committed.
    expect(reviewRequests()[0]!.reviewsAtSend).toBe(1);
  });

  it('the review is never on a person’s To approve list', async () => {
    const { s, review } = await reviewing('not-listed', 62);
    const home = { ...s.ctx, projectId: s.project.id };
    expect(await approvalGatesService.countAwaitingMe(home)).toBe(0);
    // …while the approve-and-merge gate its pass raises IS — the same reader, the same card.
    await agentVerdict(s, review.id, version(62, 'sha-a'), 'pass');
    expect(await approvalGatesService.countAwaitingMe(home)).toBe(1);
  });

  it('the reconcile tick raises it too, and emits for the gate it created', async () => {
    const { s, item, review } = await reviewing('tick', 63);
    // Withdrawn behind the product's back, then asked again by a reconcile — the path
    // the tick, a status move and a queue exit all take.
    await adminDb.approvalGate.update({
      where: { id: review.id },
      data: { state: 'superseded', supersededCause: 'ci_failed' },
    });
    sent.length = 0;
    await withWorkspaceContext(s.ctx, async (tx) => {
      const fresh = await tx.workItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(await reconcileGatesFor(fresh, tx)).toEqual([REVIEW]);
    });
    const [again] = await awaitingOf(item.id, REVIEW);
    expect(again!.id).not.toBe(review.id);
    expect(again!.subjectVersion).toBe(version(63, 'sha-a'));
    expect(reviewRequests().map((e) => e.data['gateId'])).toEqual([again!.id]);
  });
});

describe('§12.4 — what each decision does', () => {
  it('the agent’s PASS raises exactly one approve-and-merge gate at the SAME version', async () => {
    const { s, item, review } = await reviewing('pass', 64);

    const result = await agentVerdict(s, review.id, version(64, 'sha-a'), 'pass', 'Looks right.');

    expect(result.gate.state).toBe('approved');
    const decided = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect(decided.decidedUnderAuthority).toBe('review_agent');
    expect(decided.decidedById).toBe(s.user.id);
    expect(decided.decisionSource).toBe('api');
    expect(decided.subjectVersion).toBe(version(64, 'sha-a'));

    const merge = await awaitingOf(item.id, MERGE);
    expect(merge).toHaveLength(1);
    expect(merge[0]!.subjectVersion).toBe(version(64, 'sha-a'));
    // It moved nothing, and asked for no second review.
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingOf(item.id, REVIEW)).toHaveLength(0);
    expect(reviewRequests()).toHaveLength(1);
  });

  it('the agent’s REQUEST CHANGES moves no status and derives To fix changes_requested', async () => {
    const { s, item, review } = await reviewing('refuse', 65);

    await agentVerdict(
      s,
      review.id,
      version(65, 'sha-a'),
      'changes_requested',
      'The migration drops a column the reader still selects.\nSecond line.',
    );

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(card.fixReason).toBe('changes_requested');
    expect(card.fixDetail).toMatchObject({
      gate: 'agent_review',
      reviewerName: 'Review agent',
      notePreview: 'The migration drops a column the reader still selects.',
      repair: 'fix',
    });

    // A later head move clears it: the refusal was about commits that are no longer the set.
    await pushTo(item.identifier, 65, 'sha-b');
    await ci('success', 'sha-b', 65);
    const moved = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(moved.fixReason).toBeNull();
  });

  it('the agent’s refusal needs findings', async () => {
    const { s, review } = await reviewing('no-findings', 66);
    const err = await agentVerdict(s, review.id, version(66, 'sha-a'), 'changes_requested', ' ')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect((err as ApprovalGateVerbNotOfferedError).reason).toBe('request_changes_needs_a_note');
  });
});

describe('§12.2 — one review per version', () => {
  it('a second green verdict at a version already DECIDED raises nothing and emits nothing', async () => {
    const { s, item, review } = await reviewing('decided', 67);
    await agentVerdict(s, review.id, version(67, 'sha-a'), 'changes_requested', 'Not yet.');
    sent.length = 0;

    await ci('success', 'sha-a', 67);
    await withWorkspaceContext(s.ctx, async (tx) => {
      const fresh = await tx.workItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(await reconcileGatesFor(fresh, tx)).toEqual([]);
    });

    expect(await gatesOf(item.id, REVIEW)).toHaveLength(1);
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
    expect(reviewRequests()).toHaveLength(0);
  });

  it('a review WITHDRAWN at the same version is asked again — red, then green at the same head', async () => {
    const { item, review } = await reviewing('red-green', 68);

    await ci('failure', 'sha-a', 68);
    const withdrawn = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect(withdrawn.state).toBe('superseded');
    expect(withdrawn.supersededCause).toBe('ci_failed');
    sent.length = 0;

    await ci('success', 'sha-a', 68);
    const [again] = await awaitingOf(item.id, REVIEW);
    expect(again).toBeDefined();
    expect(again!.id).not.toBe(review.id);
    expect(again!.subjectVersion).toBe(version(68, 'sha-a'));
    expect(reviewRequests().map((e) => e.data['gateId'])).toEqual([again!.id]);
  });

  it('a check PENDING again at the same head withdraws the review as `ci_rerunning`; the next green asks it again (MOTIR-6946)', async () => {
    const { item, review } = await reviewing('rerun-green', 69);
    const checkRun = (status: string, conclusion: string | null = null) =>
      githubWebhookService.handleEvent('check_run', {
        action: status === 'completed' ? 'completed' : 'created',
        installation: INSTALLATION,
        repository: { id: Number(REPO_PROVIDER_ID) },
        check_run: {
          name: 'Vitest (1/12)',
          head_sha: 'sha-a',
          status,
          conclusion,
          pull_requests: [{ number: 69 }],
          check_suite: { id: 36613621931, head_branch: null },
        },
      });

    await checkRun('queued');
    const withdrawn = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect([withdrawn.state, withdrawn.supersededCause]).toEqual(['superseded', 'ci_rerunning']);
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
    expect(await statusOf(item.id)).toBe('implemented');
    sent.length = 0;

    await checkRun('completed', 'success');
    const [again] = await awaitingOf(item.id, REVIEW);
    expect(again!.id).not.toBe(review.id);
    expect(again!.subjectVersion).toBe(version(69, 'sha-a'));
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(reviewRequests().map((e) => e.data['gateId'])).toEqual([again!.id]);
  });
});

describe('§12.5 — withdrawal', () => {
  it('a head move supersedes the awaiting review; the next green raises a new one at the new version', async () => {
    const { s, item, review } = await reviewing('head-move', 69);

    await pushTo(item.identifier, 69, 'sha-b');
    const withdrawn = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect(withdrawn.state).toBe('superseded');
    expect(withdrawn.supersededCause).toBe('head_moved');
    expect(withdrawn.decidedAt).toBeNull();
    expect(await awaitingOf(item.id, REVIEW)).toHaveLength(0);

    // The host says the new head still merges (MOTIR-7063) — until then nobody is asked.
    await hostAnswersCleanAt(s.workspace.id, 69, 'sha-b');
    await ci('success', 'sha-b', 69);
    const [fresh] = await awaitingOf(item.id, REVIEW);
    expect(fresh!.subjectVersion).toBe(version(69, 'sha-b'));
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
  });

  it('switching the agent OFF supersedes the awaiting review and raises the merge gate for that version', async () => {
    const { s, item, review } = await reviewing('switch-off', 70);

    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: false },
      s.ctx,
    );

    const retired = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect(retired.state).toBe('superseded');
    expect(retired.supersededCause).toBe('review_agent_disabled');
    const merge = await awaitingOf(item.id, MERGE);
    expect(merge).toHaveLength(1);
    expect(merge[0]!.subjectVersion).toBe(version(70, 'sha-a'));
  });

  it('switching the agent ON leaves an awaiting approve-and-merge gate exactly as it was', async () => {
    const s = await makeScenario('switch-on', { reviewAgent: false });
    const item = await cardWithPr(s, 71);
    await ci('success', 'sha-a', 71);
    const [merge] = await awaitingOf(item.id, MERGE);
    expect(merge).toBeDefined();

    await approvalGateSettingsService.updateSettings(
      s.project.id,
      { reviewAgentEnabled: true },
      s.ctx,
    );
    // A redelivered green and a reconcile ask nothing new of it.
    await ci('success', 'sha-a', 71);
    await withWorkspaceContext(s.ctx, async (tx) => {
      const fresh = await tx.workItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(await reconcileGatesFor(fresh, tx)).toEqual([]);
    });

    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: merge!.id } });
    expect(after.state).toBe('awaiting');
    expect(after.updatedAt).toEqual(merge!.updatedAt);
    expect(await gatesOf(item.id, REVIEW)).toHaveLength(0);
    expect(reviewRequests()).toHaveLength(0);
  });

  it('a legacy row with the switch on in an AUTO project reads as the review agent off', async () => {
    const s = await makeScenario('legacy-auto');
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { prMergeMode: 'auto', prMergeModeDecidedAt: new Date() },
    });
    const item = await cardWithPr(s, 72);
    await ci('success', 'sha-a', 72);
    expect(await gatesOf(item.id, REVIEW)).toHaveLength(0);
    expect(reviewRequests()).toHaveLength(0);
  });
});

describe('§12.3 — who decides it', () => {
  it('the routed person continues without the review WITH a reason, under their own authority', async () => {
    const { s, item, review } = await reviewing('override', 73);

    const result = await approvalGatesService.decide(
      {
        gateId: review.id,
        decision: 'approve',
        noteMd: 'The review cannot read the second repository; I checked it myself.',
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );

    expect(result.gate.state).toBe('approved');
    const decided = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } });
    expect(decided.decidedById).toBe(s.user.id);
    // The owner reported the card and nobody is assigned: §2's reporter arm.
    expect(decided.decidedUnderAuthority).toBe('reporter');
    expect(await awaitingOf(item.id, MERGE)).toHaveLength(1);
  });

  it('continuing without the review with no reason is refused, and nothing is written', async () => {
    const { s, review } = await reviewing('override-no-note', 74);
    const err = await approvalGatesService
      .decide(
        { gateId: review.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
        s.ctx,
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect((err as ApprovalGateVerbNotOfferedError).reason).toBe('override_needs_a_note');
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } })).state).toBe(
      'awaiting',
    );
  });

  it('a person’s REQUEST CHANGES is refused — only the agent refuses a review', async () => {
    const { s, review } = await reviewing('person-refuses', 75);
    const err = await approvalGatesService
      .decide(
        {
          gateId: review.id,
          decision: 'request_changes',
          noteMd: 'I would rather it did not.',
          source: 'ui',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        s.ctx,
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect((err as ApprovalGateVerbNotOfferedError).reason).toBe('request_changes_on_agent_review');
  });

  it('a member the gate is not routed to, without approval:decide_any, is refused', async () => {
    const { s, review } = await reviewing('bystander', 76);
    const member = await usersService.createUser({
      email: 'member-bystander@example.com',
      password: PASSWORD,
      name: 'Member',
    });
    await workspacesService.addMember({ userId: member.id, workspaceId: s.workspace.id });
    await addToProjectAs({
      key: s.project.identifier,
      actorUserId: s.user.id,
      ctx: s.ctx,
      targetUserId: member.id,
      role: 'member',
    });

    await expect(
      approvalGatesService.decide(
        {
          gateId: review.id,
          decision: 'approve',
          noteMd: 'Waving it through.',
          source: 'ui',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        { userId: member.id, workspaceId: s.workspace.id },
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);
  });

  it('a verdict for a SUPERSEDED review decides nothing', async () => {
    const { s, item, review } = await reviewing('superseded-verdict', 77);
    await pushTo(item.identifier, 77, 'sha-b');

    await expect(agentVerdict(s, review.id, version(77, 'sha-a'), 'pass')).rejects.toBeInstanceOf(
      ApprovalGateSupersededError,
    );
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
  });

  it('a verdict about ANOTHER version is stale and decides nothing', async () => {
    const { s, item, review } = await reviewing('stale-verdict', 78);
    await expect(agentVerdict(s, review.id, version(78, 'sha-zzz'), 'pass')).rejects.toBeInstanceOf(
      ApprovalGateStaleSubjectError,
    );
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: review.id } })).state).toBe(
      'awaiting',
    );
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
  });

  it('the agent’s verdict is refused on any other kind', async () => {
    const s = await makeScenario('other-kind', { reviewAgent: false });
    const item = await cardWithPr(s, 79);
    await ci('success', 'sha-a', 79);
    const [merge] = await awaitingOf(item.id, MERGE);
    const err = await agentVerdict(s, merge!.id, version(79, 'sha-a'), 'pass')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect((err as ApprovalGateVerbNotOfferedError).reason).toBe('review_agent_on_other_kind');
  });
});

describe('§12.2 — a primary’s CARRIED merge waits for the review', () => {
  /** A design card with an open delivering pull request, mid-run. */
  async function designCard(s: Scenario, number: number) {
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: `Draw the frame ${number}` },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await makeWorkWaitOn(item.id, { projectId: s.project.id, ctx: s.ctx });
    await openLinked(item.identifier, number, 'design');
    return item;
  }

  async function publish(s: Scenario, itemId: string, label: string) {
    const prefix = designPrefix(s.workspace.id, itemId);
    store.set(`${prefix}${label}.mock.html`, { contentType: 'text/html', size: 2048 });
    store.set(`${prefix}${label}.design-notes.md`, { contentType: 'text/markdown', size: 512 });
    return designEvidenceService.recordFromPathnames(
      {
        workItemId: itemId,
        assets: [
          {
            kind: 'mock',
            sourcePath: `design/work-items/${label}.mock.html`,
            pathname: `${prefix}${label}.mock.html`,
          },
          {
            kind: 'note_file',
            sourcePath: 'design/work-items/design-notes.md',
            pathname: `${prefix}${label}.design-notes.md`,
          },
        ],
        commitSha: shaFor(label),
      },
      s.ctx,
    );
  }

  it('a design approved before green carries nothing while the review is owed, and merges once it passes', async () => {
    const s = await makeScenario('carry');
    const item = await designCard(s, 80);
    await publish(s, item.id, 'v1');
    const [design] = await awaitingOf(item.id, 'design_result');
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design!.id, source: 'ui' },
      s.ctx,
    );

    // Green: the review is asked, and the carried merge is HELD behind it.
    await ci('success', 'sha-a', 80);
    const [review] = await awaitingOf(item.id, REVIEW);
    expect(review).toBeDefined();
    expect(autoMerges()).toHaveLength(0);
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);

    // The pass releases the carry — the merge the design press authorised, with no
    // second press and no approve-and-merge question (AMENDMENT 6 Q4).
    await agentVerdict(s, review!.id, version(80, 'sha-a'), 'pass');
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
    expect(autoMerges()).toHaveLength(1);
    expect(autoMerges()[0]!.data).toMatchObject({ workItemId: item.id, headSha: 'sha-a' });
  });

  it('a refused review keeps holding the carried merge', async () => {
    const s = await makeScenario('carry-refused');
    const item = await designCard(s, 81);
    await publish(s, item.id, 'v1');
    const [design] = await awaitingOf(item.id, 'design_result');
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design!.id, source: 'ui' },
      s.ctx,
    );
    await ci('success', 'sha-a', 81);
    const [review] = await awaitingOf(item.id, REVIEW);

    await agentVerdict(s, review!.id, version(81, 'sha-a'), 'changes_requested', 'No.');
    await ci('success', 'sha-a', 81);
    expect(autoMerges()).toHaveLength(0);
    expect(await gatesOf(item.id, MERGE)).toHaveLength(0);
  });
});
