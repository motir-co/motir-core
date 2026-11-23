import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { makeWorkWaitOn } from '@/tests/helpers/designWaits';
import { hostAnswersCleanAt } from '../helpers/hostMergeability';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// TWO GATES ON ONE CARD, THE DESIGN ONE PRIMARY (Story MOTIR-5652 · Subtask
// MOTIR-5662; `docs/decisions/design-result.md` AMENDMENT 6 Q1), against a REAL
// Postgres through the real webhook and publish doors.
//
// ⚠️ THIS IS THE DEFECT ITSELF, DRIVEN. Before this card a design card with a
// published result and an open pull request held NO question at all: CI green,
// card In Review, pull request clean, mock rendered, and nothing to press. Two
// independently-reasoned suppressions produced it and neither author could see
// the hole from their own card — the design gate was suppressed because the merge
// gate would carry the decision (AMENDMENT 4 Q8 / MOTIR-5534), and the merge gate
// then refused because the card was not the run target.
//
// Both refusals come out together, and they had to: each was safe only while the
// other fired.

const store = new Map<string, { contentType: string; size: number }>();

/** Every job the promotion enqueues — the channel a HELD merge comes back on. */
const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { pullRequestMergeService } = await import('@/lib/services/pullRequestMergeService');
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-two-gates';
const REPO_PROVIDER_ID = '881';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string) {
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

const ci = (opts: {
  conclusion: string | null;
  headSha: string;
  number: number;
  status?: string;
}) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: null,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: opts.number }],
    },
  });

async function openLinked(identifier: string, number: number) {
  const headRef = `design/${identifier}-${number}`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A design (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

/** A design card with an open delivering pull request, mid-run. */
async function designCard(s: Scenario, title = 'Draw the frame') {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await makeWorkWaitOn(item.id, { projectId: s.project.id, ctx: s.ctx });
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

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const awaitingKinds = async (workItemId: string) =>
  (await gatesOf(workItemId)).filter((g) => g.state === 'awaiting').map((g) => g.kind);

beforeEach(async () => {
  store.clear();
  sent.length = 0;
  await truncateAuthTables();
  _resetInstallationTokenCache();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('MOTIR-5652 — a design result AND an open pull request is TWO questions', () => {
  it('publishing onto a card with an OPEN pull request raises the design gate', async () => {
    const s = await makeScenario('tg-publish@example.com');
    const item = await designCard(s);
    await openLinked(item.identifier, 21);

    const evidence = await publish(s, item.id, 'v1');

    // The assertion that was FALSE before this card: the suppression returned the
    // evidence and raised nothing at all.
    expect(await awaitingKinds(item.id)).toEqual(['design_result']);
    expect((await gatesOf(item.id))[0]).toMatchObject({
      subjectId: evidence.id,
      subjectVersion: shaFor('v1'),
    });
  });

  it('and once the set goes green the card holds BOTH — design first, merge beside it', async () => {
    const s = await makeScenario('tg-both@example.com');
    const item = await designCard(s);
    await openLinked(item.identifier, 22);
    await publish(s, item.id, 'v1');

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 22 });

    // TWO gates, of two kinds, with two different subjects: the design gate names
    // the evidence row, the merge gate names the card and its commits.
    expect(await awaitingKinds(item.id)).toEqual(['design_result', 'pull_request_approval']);
    const [design, merge] = await gatesOf(item.id);
    expect(design!.subjectId).not.toBe(item.id);
    expect(merge!.subjectId).toBe(item.id);
    expect(merge!.subjectVersion).toBe('moooon/acme#22@sha-a');
  });

  it('LINKING a pull request to a card that already holds a design gate leaves it standing', async () => {
    // The retired `retireDesignGateForOpenPullRequest`, driven from the other side:
    // publish first, link second. A link is evidence the design gate is ABOUT.
    const s = await makeScenario('tg-link@example.com');
    const item = await designCard(s);
    await publish(s, item.id, 'v1');
    expect(await awaitingKinds(item.id)).toEqual(['design_result']);

    await openLinked(item.identifier, 23);

    expect(await awaitingKinds(item.id)).toEqual(['design_result']);
  });
});

describe('MOTIR-5603 — at most ONE merge gate, across the whole sequence', () => {
  it('publish → link → green → push → green leaves one merge gate at every point', async () => {
    const s = await makeScenario('tg-sequence@example.com');
    const item = await designCard(s);
    const mergeGates = async () =>
      (await gatesOf(item.id)).filter((g) => g.kind === 'pull_request_approval');
    const awaitingMerge = async () => (await mergeGates()).filter((g) => g.state === 'awaiting');

    await publish(s, item.id, 'v1');
    expect(await mergeGates()).toHaveLength(0);

    await openLinked(item.identifier, 24);
    expect(await mergeGates()).toHaveLength(0);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 24 });
    expect(await awaitingMerge()).toHaveLength(1);

    // A PUSH withdraws it — the commits asked about are not the commits any more.
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-b', number: 24 });
    expect(await awaitingMerge()).toHaveLength(0);

    // …and the NEXT green raises exactly one fresh gate over the new head
    // (MOTIR-5604: the withdrawal used to have no matching raiser).
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 24 });
    const live = await awaitingMerge();
    expect(live).toHaveLength(1);
    expect(live[0]!.subjectVersion).toBe('moooon/acme#24@sha-b');

    // Two rows in total across the sequence, and never two live at once — the
    // whole content of MOTIR-5603's invariant, asserted as a sequence.
    expect((await mergeGates()).map((g) => g.state)).toEqual(['superseded', 'awaiting']);

    // The design question rode through all of it untouched. It has a different
    // lifetime, which is why collapsing the two was the original error.
    const design = (await gatesOf(item.id)).filter((g) => g.kind === 'design_result');
    expect(design.map((g) => g.state)).toEqual(['awaiting']);
  });
});

describe('MOTIR-5663 — a withdrawal ASKS what the card should hold now', () => {
  // Each withdrawer answers a narrow and correct question — *this head moved, so the
  // gate about the old head is stale* — and none was ever in a position to ask *and
  // what should the card have instead?* MOTIR-5604 is what that costs, already paid
  // for once and fixed at ONE site while six others behaved the same way.

  it('a push leaves NO merge gate, and the following green raises exactly one (MOTIR-5604)', async () => {
    const s = await makeScenario('wr-5604@example.com');
    const item = await designCard(s, 'Push then green');
    await openLinked(item.identifier, 31);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 31 });
    const merge = async () =>
      (await gatesOf(item.id))
        .filter((g) => g.kind === 'pull_request_approval')
        .map((g) => [g.state, g.subjectVersion]);
    expect(await merge()).toEqual([['awaiting', 'moooon/acme#31@sha-a']]);

    // THE PUSH. The re-ask runs in the same transaction and must answer *no merge
    // gate*: the commits just changed and the new head has no verdict. A re-ask that
    // raised here would re-ask about exactly what it had retired a statement earlier.
    await githubWebhookService.handleEvent('pull_request', {
      action: 'synchronize',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 31,
        state: 'open',
        merged: false,
        title: 'A design',
        head: { ref: `design/${item.identifier}-31`, sha: 'sha-b' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    expect(await merge()).toEqual([['superseded', 'moooon/acme#31@sha-a']]);

    // The host says the new head still merges (MOTIR-7063) — until then nobody is asked.
    await hostAnswersCleanAt(s.workspace.id, 31, 'sha-b');
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 31 });
    expect(await merge()).toEqual([
      ['superseded', 'moooon/acme#31@sha-a'],
      ['awaiting', 'moooon/acme#31@sha-b'],
    ]);
  });

  it('a head move leaves the DESIGN question completely alone', async () => {
    // A head move is about the COMMITS. Superseding a design gate because a pull
    // request moved is this level's own defect, one direction over.
    const s = await makeScenario('wr-design@example.com');
    const item = await designCard(s, 'Design rides through');
    await openLinked(item.identifier, 32);
    const evidence = await publish(s, item.id, 'v1');
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 32 });
    expect(await awaitingKinds(item.id)).toEqual(['design_result', 'pull_request_approval']);

    await githubWebhookService.handleEvent('pull_request', {
      action: 'synchronize',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 32,
        state: 'open',
        merged: false,
        title: 'A design',
        head: { ref: `design/${item.identifier}-32`, sha: 'sha-b' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });

    const design = (await gatesOf(item.id)).filter((g) => g.kind === 'design_result');
    expect(design.map((g) => [g.state, g.subjectId])).toEqual([['awaiting', evidence.id]]);
  });

  it('a CLOSED member withdraws and raises nothing — there is nothing left to merge', async () => {
    const s = await makeScenario('wr-closed@example.com');
    const item = await designCard(s, 'Closed member');
    await openLinked(item.identifier, 33);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 33 });

    await githubWebhookService.handleEvent('pull_request', {
      action: 'closed',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 33,
        state: 'closed',
        merged: false,
        title: 'A design',
        head: { ref: `design/${item.identifier}-33` },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });

    expect(await awaitingKinds(item.id)).toEqual([]);
    expect((await gatesOf(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'member_closed'],
    ]);
  });
});

describe('AMENDMENT 6 Q4 — a design approved BEFORE green: the merge is held, then carried', () => {
  it('no second press: the next green merges instead of asking again', async () => {
    // The design gate rises on PUBLISH and the merge gate on GREEN, so the primary can
    // be pressed first. Q4: "the decision stands and the merge follows on the next green
    // verdict, with no second press." A merge gate raised at that moment would BE the
    // second press — a question whose answer is already on the record.
    const s = await makeScenario('q4-held@example.com');
    const item = await designCard(s, 'Approved before green');
    await openLinked(item.identifier, 41);
    const evidence = await publish(s, item.id, 'v1');
    // No CI verdict yet, so the card holds the design question ALONE.
    expect(await awaitingKinds(item.id)).toEqual(['design_result']);

    const design = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: item.id, kind: 'design_result' },
    });
    const pressed = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design.id, source: 'ui' },
      s.ctx,
    );
    // The press is NOT refused, and it merges nothing yet — there is nothing green.
    expect(pressed.approval.gate.state).toBe('approved');
    expect(pressed.members).toEqual([]);
    expect(pressed.approval.gate.subjectId).toBe(evidence.id);

    sent.length = 0;
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 41 });

    // NO merge gate is raised — the predicate answers the same question the press did.
    expect(await awaitingKinds(item.id)).toEqual([]);
    // …and the merge is carried out on the promotion's own post-commit channel, the one
    // `auto` mode already uses. One approval, one merge, no second press.
    expect(sent.filter((e) => e.name === 'pull-request/auto-merge.requested')).toHaveLength(1);
  });
});

describe("MOTIR-5670 — the card's own status change re-asks", () => {
  // ⚠️ THE MEASUREMENT THIS CARD REQUIRED, KEPT AS THE TEST. The card was written
  // from a reading of the code rather than an observed failure, and its own first
  // deliverable was to settle that. What the measurement found, on this branch:
  //
  //   · green at `in_progress`, then → `implemented`: a gate DOES appear. The
  //     CI-GREEN LATCH (MOTIR-3006) already covers it — a card ARRIVING at
  //     `implemented` re-reads its green verdict. That is the path a run takes, so
  //     the card's premise is FALSIFIED for the ordinary case.
  //   · green at `in_progress`, then → `in_review` without passing `implemented`:
  //     NOTHING appeared. The latch watches one rung. That residual is real and is
  //     MOTIR-5652's own shape reached by another road — green, in review, nothing
  //     to press — so it is what the trigger was built for.

  async function greenBeforeEligible(email: string, number: number) {
    const s = await makeScenario(email);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Green before eligible' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await openLinked(item.identifier, number);
    // The link may promote it; hold it below the band so the green lands on a card
    // neither of `promoteDeliveredCardsOnGreen`'s populations contains. Since
    // MOTIR-12094 `in_progress` IS a source, so the green lands at `blocked`, and the
    // row is put back at `in_progress` as a fixture — no door, so nothing re-asks.
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'blocked' } });
    await ci({ conclusion: 'success', headSha: 'sha-early', number });
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_progress' } });
    expect(await awaitingKinds(item.id)).toEqual([]);
    return { s, item };
  }

  it('reaching `in_review` WITHOUT passing `implemented` raises the gate, with no new CI delivery', async () => {
    const { s, item } = await greenBeforeEligible('wake-review@example.com', 51);

    await workItemsService.updateStatus(item.id, 'in_review', s.ctx);

    const [gate] = await gatesOf(item.id);
    expect(gate).toMatchObject({
      kind: 'pull_request_approval',
      state: 'awaiting',
      subjectVersion: 'moooon/acme#51@sha-early',
    });
  });

  it('is IDEMPOTENT — asking again writes no row and moves no version', async () => {
    // The property to test hardest: re-asking must never supersede and re-raise an
    // identical gate. That would churn `subjectVersion`, rewrite the audit trail,
    // and re-ask a question somebody had already answered. Driven through the
    // helper itself, because every legal second STATUS move from here is either
    // held by the gate this raised or is a pull-back.
    const { s, item } = await greenBeforeEligible('wake-idem@example.com', 52);
    await workItemsService.updateStatus(item.id, 'in_review', s.ctx);
    const before = await gatesOf(item.id);
    expect(before).toHaveLength(1);

    await withWorkspaceContext(s.ctx, async (tx) => {
      const row = await tx.workItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(await reconcileGatesFor(row, tx)).toEqual([]);
      expect(await reconcileGatesFor(row, tx)).toEqual([]);
    });

    expect(await gatesOf(item.id)).toEqual(before);
  });

  it('a PULL-BACK still withdraws, and is not undone by the re-ask one statement later', async () => {
    const { s, item } = await greenBeforeEligible('wake-pullback@example.com', 53);
    await workItemsService.updateStatus(item.id, 'in_review', s.ctx);
    expect(await awaitingKinds(item.id)).toEqual(['pull_request_approval']);

    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);

    expect((await gatesOf(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'pulled_back'],
    ]);
  });
});
