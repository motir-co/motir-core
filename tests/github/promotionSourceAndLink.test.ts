import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { promoteAfterDeliverySetChange } from '@/lib/services/linkPromotionService';
import { runTransitionStatus } from '@/lib/mcp/tools/transitionStatus';
import { isPromotableSourceStatus, promoteIfCiAlreadyGreen } from '@/lib/services/ciPromotion';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// Bug MOTIR-12094 — CI GREEN PROMOTED ONLY CARDS AT `implemented`, AND LINKING A GREEN
// PULL REQUEST DID NOT PROMOTE AT ALL.
//
// The rule, settled with the owner on 2026-11-23: when every pull request delivering a
// card at In Progress OR Implemented is green and landable, the card moves to In Review
// and its approve-to-merge question is raised — on BOTH triggers, CI turning green and a
// green pull request being linked (or the last red one unlinked), with no run involved
// and no reconcile tick. A card at Blocked or Planning is never promoted.
//
// ⚠️ AMENDED BY Bug MOTIR-12202: a card at TO DO is a source too. One pull request
// often delivers more than one card, and a run does not always move every card first;
// such a card used to stay To Do through the green build and the merge (MOTIR-12189).
// Linking or opening a ready pull request on it now records it Implemented, a green set
// takes it straight to In Review with its question, and the merge completes it.
//
// Real Postgres, the real webhook seam and the real link doors. Stubbed only ABOVE the
// code under test, as the reconcile suites do: `fetch` (GitHub's REST reads) and the
// installation-token mint (a real one needs an App private key).

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const INSTALLATION_ID = 'inst-12094';
const REPO_PROVIDER_ID = '12094';
const SHA = 'a'.repeat(40);

type HostPr = { draft: boolean; headSha: string; mergeableState: string };
/** What GitHub says about each pull request (by number), and about each commit's checks.
 *  A pull request with no entry is unanswered (500), which every reader takes as "no
 *  answer". */
let hostPrs: Map<number, HostPr>;
let hostChecks: Map<string, [name: string, conclusion: string][]>;

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const checks = /\/commits\/([0-9a-z-]+)\/check-runs/.exec(url);
      if (checks) {
        const runs = hostChecks.get(checks[1]!) ?? [];
        return new Response(
          JSON.stringify({
            total_count: runs.length,
            check_runs: runs.map(([name, conclusion]) => ({
              name,
              status: 'completed',
              conclusion,
              check_suite: { id: 1 },
            })),
          }),
          { status: 200 },
        );
      }
      const one = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(url);
      const pr = one ? hostPrs.get(Number(one[1])) : undefined;
      if (pr) {
        return new Response(
          JSON.stringify({
            number: Number(one![1]),
            state: 'open',
            merged: false,
            draft: pr.draft,
            head: { sha: pr.headSha },
            mergeable: pr.mergeableState !== 'dirty',
            mergeable_state: pr.mergeableState,
          }),
          { status: 200 },
        );
      }
      return new Response('not stubbed', { status: 500 });
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  hostPrs = new Map();
  hostChecks = new Map();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

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

const branchOf = (number: number) => `subtask/ACME-work-${number}`;

/** The `opened` delivery. `draft` false unless asked — the flag a ready pull request has. */
async function opened(number: number, draft = false) {
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      draft,
      title: `A change (${number})`,
      head: { ref: branchOf(number), sha: SHA },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

/** A terminal check-suite verdict at `headSha` for pull request `number`. */
async function ci(number: number, conclusion: 'success' | 'failure' | null, headSha = SHA) {
  await githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });
}

async function link(identifier: string, number: number) {
  return linkPrByIdentifier({
    identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef: branchOf(number),
  });
}

async function card(s: Scenario, title: string, kind: 'task' | 'story' = 'task') {
  return workItemsService.createWorkItem({ projectId: s.project.id, kind, title }, s.ctx);
}

/** Put a card at a status as a FIXTURE — the row, not a transition, so no door fires. */
async function setStatus(workItemId: string, status: string) {
  await adminDb.workItem.update({ where: { id: workItemId }, data: { status } });
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function awaitingKinds(workItemId: string): Promise<string[]> {
  const gates = await adminDb.approvalGate.findMany({
    where: { workItemId, state: 'awaiting' },
    select: { kind: true },
  });
  return gates.map((g) => g.kind).sort();
}

/** Status moves only — the revisions a promotion writes. */
async function statusMoves(workItemId: string): Promise<{ from: string; to: string }[]> {
  const revisions = await adminDb.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
    select: { diff: true },
  });
  return revisions
    .map((r) => (r.diff as { status?: { from: string; to: string } } | null)?.status)
    .filter((m): m is { from: string; to: string } => m !== undefined);
}

async function prRow(number: number) {
  return adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
}

/** CI trigger fixture: a linked, ready pull request whose card is parked at `status`. */
async function linkedThenParked(s: Scenario, status: string, number: number) {
  const item = await card(s, `card at ${status}`);
  await opened(number);
  await link(item.identifier, number);
  await setStatus(item.id, status);
  return item;
}

/** The host's check set at {@link SHA}: one check with this conclusion, or one still
 *  running. */
function hostVerdict(verdict: 'success' | 'failure' | null) {
  hostChecks.set(SHA, [['ci / vitest', verdict ?? 'in_progress']]);
}

/** Link trigger fixture: a ready pull request that is ALREADY green before any card
 *  delivers it, and a card at `status` that is about to be linked to it. The check
 *  delivery found no card to settle, so the verdict lives on the host, which is where
 *  the link door has to read it from. */
async function greenThenUnlinked(s: Scenario, status: string, number: number) {
  const item = await card(s, `card at ${status}`);
  await setStatus(item.id, status);
  await opened(number);
  await ci(number, 'success');
  hostVerdict('success');
  return item;
}

const NEVER = ['blocked', 'planning'] as const;
const SOURCES = ['todo', 'in_progress', 'implemented'] as const;

describe('the source set', () => {
  it('is To Do, In Progress and Implemented, and nothing else (MOTIR-12202 adds To Do)', () => {
    for (const s of SOURCES) expect(isPromotableSourceStatus(s)).toBe(true);
    for (const s of [...NEVER, 'to_plan', 'in_review', 'approved', 'done', 'cancelled'])
      expect(isPromotableSourceStatus(s)).toBe(false);
  });
});

describe('TRIGGER 1 — CI turning green', () => {
  it.each(SOURCES)(
    'promotes a card at %s DIRECTLY to In Review and raises its question',
    async (status) => {
      const s = await makeScenario(`ci-src-${status}@example.com`);
      const item = await linkedThenParked(s, status, 11);

      await ci(11, 'success');

      expect(await statusOf(item.id)).toBe('in_review');
      expect(await awaitingKinds(item.id)).toEqual(['pull_request_approval']);
      // Straight there — no hop through Implemented.
      expect((await statusMoves(item.id)).at(-1)).toEqual({ from: status, to: 'in_review' });
    },
  );

  it.each(NEVER)('never promotes a card at %s and asks it nothing', async (status) => {
    const s = await makeScenario(`ci-never-${status}@example.com`);
    const item = await linkedThenParked(s, status, 12);

    await ci(12, 'success');

    expect(await statusOf(item.id)).toBe(status);
    expect(await awaitingKinds(item.id)).toEqual([]);
  });

  it('a second green verdict changes nothing: one question, no extra revision', async () => {
    const s = await makeScenario('ci-idem@example.com');
    const item = await linkedThenParked(s, 'in_progress', 13);
    await ci(13, 'success');
    const revisions = await adminDb.workItemRevision.count({ where: { workItemId: item.id } });
    const gates = await adminDb.approvalGate.count({ where: { workItemId: item.id } });

    await ci(13, 'success');

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await adminDb.workItemRevision.count({ where: { workItemId: item.id } })).toBe(
      revisions,
    );
    expect(await adminDb.approvalGate.count({ where: { workItemId: item.id } })).toBe(gates);
  });
});

describe('TRIGGER 2 — linking a pull request that is already green', () => {
  it.each(SOURCES)('promotes a card at %s before the link returns', async (status) => {
    const s = await makeScenario(`link-src-${status}@example.com`);
    const item = await greenThenUnlinked(s, status, 21);

    await link(item.identifier, 21);

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingKinds(item.id)).toEqual(['pull_request_approval']);
    expect((await statusMoves(item.id)).at(-1)).toEqual({ from: status, to: 'in_review' });
  });

  it.each(NEVER)('never promotes a card at %s and asks it nothing', async (status) => {
    const s = await makeScenario(`link-never-${status}@example.com`);
    const item = await greenThenUnlinked(s, status, 22);

    await link(item.identifier, 22);

    // Blocked included: the link-time sync does not lift a person's block, so the card
    // never reaches Implemented — and so never the latch — on the way (review of #4403).
    expect(await statusOf(item.id)).toBe(status);
    // The only status revision is the card's creation: the link moved it nowhere.
    expect((await statusMoves(item.id)).filter((m) => m.from !== null)).toEqual([]);
    expect(await awaitingKinds(item.id)).toEqual([]);
  });

  it('a pull request OPENED or marked ready on a Blocked card leaves it Blocked', async () => {
    const s = await makeScenario('open-on-blocked@example.com');
    const item = await card(s, 'blocked while its pull request opens');
    await setStatus(item.id, 'blocked');
    await opened(34, true);
    await link(item.identifier, 34);

    await githubWebhookService.handleEvent('pull_request', {
      action: 'ready_for_review',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 34,
        state: 'open',
        merged: false,
        draft: false,
        title: 'A change (34)',
        head: { ref: branchOf(34), sha: SHA },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    await ci(34, 'success');

    expect(await statusOf(item.id)).toBe('blocked');
    expect(await awaitingKinds(item.id)).toEqual([]);
  });

  it('through the PICKER door (by internal id) too', async () => {
    const s = await makeScenario('link-picker@example.com');
    const item = await greenThenUnlinked(s, 'implemented', 23);

    await githubPullRequestService.linkPullRequest(item.id, (await prRow(23)).id, s.ctx);

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingKinds(item.id)).toEqual(['pull_request_approval']);
  });

  it('a second link changes nothing: one question, no extra revision', async () => {
    const s = await makeScenario('link-idem@example.com');
    const item = await greenThenUnlinked(s, 'in_progress', 24);
    await link(item.identifier, 24);
    const revisions = await adminDb.workItemRevision.count({ where: { workItemId: item.id } });
    const gates = await adminDb.approvalGate.count({ where: { workItemId: item.id } });

    await link(item.identifier, 24);

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await adminDb.workItemRevision.count({ where: { workItemId: item.id } })).toBe(
      revisions,
    );
    expect(await adminDb.approvalGate.count({ where: { workItemId: item.id } })).toBe(gates);
  });

  it.each(SOURCES)(
    'a link that CREATES the row (no delivery ever arrived) reads the host and promotes a card at %s',
    async (status) => {
      const s = await makeScenario(`link-create-${status}@example.com`);
      const item = await card(s, 'no delivery reached Motir');
      await setStatus(item.id, status);
      hostPrs.set(25, { draft: false, headSha: SHA, mergeableState: 'clean' });
      hostChecks.set(SHA, [['ci / vitest', 'success']]);

      const result = await link(item.identifier, 25);

      expect(result.created).toBe(true);
      const row = await prRow(25);
      expect(row).toMatchObject({ draft: false, headSha: SHA });
      expect(await statusOf(item.id)).toBe('in_review');
      expect(await awaitingKinds(item.id)).toEqual(['pull_request_approval']);
    },
  );

  it('a link that creates the row of a DRAFT reads the flag and promotes nothing', async () => {
    const s = await makeScenario('link-create-draft@example.com');
    const item = await card(s, 'a draft nobody delivered');
    await setStatus(item.id, 'in_progress');
    hostPrs.set(26, { draft: true, headSha: SHA, mergeableState: 'clean' });
    hostChecks.set(SHA, [['ci / vitest', 'success']]);

    await link(item.identifier, 26);

    expect((await prRow(26)).draft).toBe(true);
    expect(await statusOf(item.id)).toBe('in_progress');
  });

  it('a link that creates the row while the host is unreachable promotes nothing and still links', async () => {
    const s = await makeScenario('link-create-down@example.com');
    const item = await card(s, 'host down');
    await setStatus(item.id, 'in_progress');

    const result = await link(item.identifier, 27);

    expect(result.created).toBe(true);
    expect((await prRow(27)).draft).toBeNull();
    expect(await statusOf(item.id)).toBe('in_progress');
  });

  it('an UNLINK that leaves the whole set green promotes the card', async () => {
    const s = await makeScenario('unlink-green@example.com');
    const item = await card(s, 'one green, one red');
    await setStatus(item.id, 'in_progress');
    await opened(28);
    await opened(29);
    await link(item.identifier, 28);
    await link(item.identifier, 29);
    await ci(28, 'success');
    await ci(29, 'failure');
    expect(await statusOf(item.id)).not.toBe('in_review');

    const result = await githubPullRequestService.unlinkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: 'acme',
        number: 29,
      },
      s.ctx,
    );

    expect(result.removed).toBe(true);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingKinds(item.id)).toEqual(['pull_request_approval']);
  });

  it('the unlink by internal id does the same', async () => {
    const s = await makeScenario('unlink-picker@example.com');
    const item = await card(s, 'one green, one red');
    await setStatus(item.id, 'implemented');
    await opened(30);
    await opened(31);
    await link(item.identifier, 30);
    await link(item.identifier, 31);
    await ci(30, 'success');
    await ci(31, 'failure');

    const result = await githubPullRequestService.unlinkPullRequest(
      item.id,
      (await prRow(31)).id,
      s.ctx,
    );

    expect(result).toEqual({ removed: true });
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('an unlink of a pair that was never linked promotes nothing and reports nothing removed', async () => {
    const s = await makeScenario('unlink-none@example.com');
    const item = await card(s, 'never linked');
    await setStatus(item.id, 'in_progress');
    await opened(32);

    const result = await githubPullRequestService.unlinkPullRequest(
      item.id,
      (await prRow(32)).id,
      s.ctx,
    );

    expect(result).toEqual({ removed: false });
    expect(await statusOf(item.id)).toBe('in_progress');
  });
});

describe('nothing is promoted while any member cannot land — on either trigger', () => {
  type Hold = {
    name: string;
    /** Make the member unlandable once its card delivers it and its verdict is green. */
    apply: (number: number) => Promise<void>;
    /** The verdict the member reports. */
    verdict?: 'failure' | null;
    draft?: boolean;
  };
  const holds: Hold[] = [
    { name: 'red', apply: async () => {}, verdict: 'failure' },
    { name: 'still running', apply: async () => {}, verdict: null },
    { name: 'a draft', apply: async () => {}, draft: true },
    {
      name: 'of unknown draft-ness',
      apply: async (n) => {
        await adminDb.githubPullRequest.updateMany({ where: { number: n }, data: { draft: null } });
      },
    },
    {
      name: 'conflicted',
      apply: async (n) => {
        await adminDb.githubPullRequest.updateMany({
          where: { number: n },
          data: { mergeableState: 'dirty', mergeableStateHeadSha: SHA },
        });
      },
    },
    {
      name: 'behind a base that requires it up to date',
      apply: async (n) => {
        await adminDb.githubPullRequest.updateMany({
          where: { number: n },
          data: { mergeableState: 'behind', mergeableStateHeadSha: SHA },
        });
      },
    },
    {
      name: 'held by the merge queue',
      apply: async (n) => {
        await adminDb.githubPullRequestQueueExit.create({
          data: {
            pullRequestId: (await prRow(n)).id,
            deliveryId: `guid-${n}`,
            rawReason: 'CI_FAILURE',
            disposition: 'failure',
            headSha: SHA,
            exitedAt: new Date(),
          },
        });
      },
    },
  ];

  it.each(holds)('CI trigger — a member $name', async (hold) => {
    const s = await makeScenario(`hold-ci-${hold.name.replace(/\W+/g, '-')}@example.com`);
    const item = await card(s, `held: ${hold.name}`);
    await opened(41, hold.draft ?? false);
    await link(item.identifier, 41);
    await setStatus(item.id, 'in_progress');
    await hold.apply(41);

    await ci(41, hold.verdict === undefined ? 'success' : hold.verdict);

    expect(await statusOf(item.id)).toBe('in_progress');
    expect(await awaitingKinds(item.id)).toEqual([]);
  });

  it.each(holds)('link trigger — a member $name', async (hold) => {
    const s = await makeScenario(`hold-link-${hold.name.replace(/\W+/g, '-')}@example.com`);
    const item = await card(s, `held: ${hold.name}`);
    await setStatus(item.id, 'in_progress');
    await opened(42, hold.draft ?? false);
    await ci(42, hold.verdict === undefined ? 'success' : hold.verdict);
    hostVerdict(hold.verdict === undefined ? 'success' : hold.verdict);
    await hold.apply(42);

    await link(item.identifier, 42);

    // The link-time sync still records the open pull request (In Progress → Implemented,
    // as before); the hold is that nobody is asked to approve it.
    expect(await statusOf(item.id)).not.toBe('in_review');
    expect(await awaitingKinds(item.id)).toEqual([]);
  });

  it('a draft holds a card at Implemented too — it could be asked about by nobody', async () => {
    const s = await makeScenario('hold-draft-implemented@example.com');
    const item = await card(s, 'implemented over a draft');
    await opened(43, true);
    await link(item.identifier, 43);
    await setStatus(item.id, 'implemented');

    await ci(43, 'success');

    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('an UNKNOWN draft-ness at Implemented keeps today’s reading (a legacy row) and promotes', async () => {
    const s = await makeScenario('legacy-null-implemented@example.com');
    const item = await card(s, 'implemented over a legacy row');
    await opened(44);
    await link(item.identifier, 44);
    await setStatus(item.id, 'implemented');
    await adminDb.githubPullRequest.updateMany({ where: { number: 44 }, data: { draft: null } });

    await ci(44, 'success');

    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a CONTAINER with an open child is refused at In Progress, on both triggers', async () => {
    const s = await makeScenario('hold-container@example.com');
    const story = await card(s, 'a story with a child still to do', 'story');
    await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'subtask', title: 'not landed', parentId: story.id },
      s.ctx,
    );
    await opened(45);
    await link(story.identifier, 45);
    await setStatus(story.id, 'in_progress');

    await ci(45, 'success');
    expect(await statusOf(story.id)).toBe('in_progress');

    await link(story.identifier, 45);
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(await awaitingKinds(story.id)).toEqual([]);
  });

  it('a MARKED card (a legacy mark on an open card) is refused at In Progress', async () => {
    const s = await makeScenario('hold-marked@example.com');
    const item = await linkedThenParked(s, 'in_progress', 46);
    await adminDb.workItem.update({ where: { id: item.id }, data: { obsolescence: 'outdated' } });

    await ci(46, 'success');

    expect(await statusOf(item.id)).toBe('in_progress');
  });
});

/** The `closed` delivery of a MERGED pull request into the default branch. */
async function mergedInto(number: number) {
  await githubWebhookService.handleEvent('pull_request', {
    action: 'closed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'closed',
      merged: true,
      draft: false,
      title: `A change (${number})`,
      head: { ref: branchOf(number), sha: SHA },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

describe('Bug MOTIR-12202 — a pull request delivering a card that still reads To Do', () => {
  it('linking a ready pull request whose checks are still running moves it to Implemented and asks nobody', async () => {
    const s = await makeScenario('todo-running@example.com');
    const item = await card(s, 'delivered while still To Do');
    await opened(61);
    hostVerdict(null);

    await link(item.identifier, 61);

    expect(await statusOf(item.id)).toBe('implemented');
    expect((await statusMoves(item.id)).at(-1)).toEqual({ from: 'todo', to: 'implemented' });
    expect(await awaitingKinds(item.id)).toEqual([]);
  });

  it('a pull request OPENED after the link moves it to Implemented', async () => {
    const s = await makeScenario('todo-opened-later@example.com');
    const item = await card(s, 'linked before any delivery');

    // The host is unreachable, so the link only writes its placeholder row.
    await link(item.identifier, 62);
    expect(await statusOf(item.id)).toBe('todo');

    await opened(62);

    expect(await statusOf(item.id)).toBe('implemented');
    expect((await statusMoves(item.id)).at(-1)).toEqual({ from: 'todo', to: 'implemented' });
  });

  it('moves to In Review when the running pull request turns green, and raises its question', async () => {
    const s = await makeScenario('todo-then-green@example.com');
    const item = await card(s, 'green later');
    await opened(63);
    hostVerdict(null);
    await link(item.identifier, 63);
    expect(await statusOf(item.id)).toBe('implemented');

    await ci(63, 'success');

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingKinds(item.id)).toEqual(['pull_request_approval']);
  });

  it('a DRAFT pull request moves a To Do card nowhere, and its green build asks nobody', async () => {
    const s = await makeScenario('todo-draft@example.com');
    const item = await card(s, 'delivered by a draft');
    await opened(64, true);

    await link(item.identifier, 64);
    expect(await statusOf(item.id)).toBe('todo');

    await ci(64, 'success');

    expect(await statusOf(item.id)).toBe('todo');
    expect(await awaitingKinds(item.id)).toEqual([]);
  });

  it('a member of UNKNOWN draft-ness holds a To Do card at the green build, as it holds In Progress', async () => {
    const s = await makeScenario('todo-null-draft@example.com');
    const item = await linkedThenParked(s, 'todo', 65);
    await adminDb.githubPullRequest.updateMany({ where: { number: 65 }, data: { draft: null } });

    await ci(65, 'success');

    expect(await statusOf(item.id)).toBe('todo');
    expect(await awaitingKinds(item.id)).toEqual([]);
  });

  it('the merge completes it through Implemented, with no hand move', async () => {
    const s = await makeScenario('todo-merge-implemented@example.com');
    const item = await card(s, 'merged from Implemented');
    await opened(66);
    hostVerdict(null);
    await link(item.identifier, 66);

    await mergedInto(66);

    expect(await statusOf(item.id)).toBe('done');
    expect((await statusMoves(item.id)).map((m) => `${m.from}→${m.to}`)).toEqual(
      expect.arrayContaining(['todo→implemented', 'implemented→done']),
    );
  });

  it('the merge completes it through In Review when its build was green, with no hand move', async () => {
    const s = await makeScenario('todo-merge-in-review@example.com');
    const item = await greenThenUnlinked(s, 'todo', 67);
    await link(item.identifier, 67);
    expect(await statusOf(item.id)).toBe('in_review');

    await mergedInto(67);

    expect(await statusOf(item.id)).toBe('done');
  });
});

describe('the post-commit promotion is best-effort', () => {
  it('a card that cannot be read is skipped quietly, and the rest are still asked', async () => {
    const s = await makeScenario('best-effort@example.com');
    const item = await greenThenUnlinked(s, 'in_progress', 51);
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: s.workspace.id,
        workItemId: item.id,
        githubPullRequestId: (await prRow(51)).id,
        repoId: (await prRow(51)).repoId,
      },
    });

    const promoted = await promoteAfterDeliverySetChange(
      { workItemIds: ['no-such-card', item.id], pullRequestId: (await prRow(51)).id },
      s.ctx,
    );

    expect(promoted).toEqual([item.id]);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a latch or a host read that throws is logged and stops neither the link nor the next card', async () => {
    const s = await makeScenario('best-effort-throw@example.com');
    const item = await greenThenUnlinked(s, 'in_progress', 52);
    await link(item.identifier, 52);
    await setStatus(item.id, 'in_progress');
    await adminDb.approvalGate.deleteMany({ where: { workItemId: item.id } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A NUL byte is a string Postgres refuses outright: the read throws, it is not empty.
    const promoted = await promoteAfterDeliverySetChange(
      { workItemIds: ['bad\u0000id', item.id], pullRequestId: 'bad\u0000pr' },
      s.ctx,
    );

    expect(promoted).toEqual([item.id]);
    expect(warn.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        '[linkPromotion] could not read a linked pull request from the host',
        '[linkPromotion] could not promote after a delivery-set change',
      ]),
    );
    warn.mockRestore();
    expect(await promoteIfCiAlreadyGreen('no-such-card', s.ctx)).toBe(false);
  });

  it('a closed or merged row is never asked about', async () => {
    const s = await makeScenario('closed-row@example.com');
    const item = await card(s, 'closed pull request');
    await setStatus(item.id, 'in_progress');
    await opened(53);
    await adminDb.githubPullRequest.updateMany({
      where: { number: 53 },
      data: { state: 'closed' },
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await promoteAfterDeliverySetChange(
      { workItemIds: [item.id], pullRequestId: (await prRow(53)).id },
      s.ctx,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await statusOf(item.id)).toBe('in_progress');
  });

  it('a host that names no draft flag and no head leaves the row unknown and promotes nothing', async () => {
    const s = await makeScenario('host-silent@example.com');
    const item = await card(s, 'host says little');
    await setStatus(item.id, 'in_progress');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        /\/pulls\/54$/.test(url)
          ? new Response(JSON.stringify({ number: 54, state: 'open', merged: false }), {
              status: 200,
            })
          : new Response('not stubbed', { status: 500 }),
      ),
    );

    await link(item.identifier, 54);

    const row = await prRow(54);
    expect(row.draft).toBeNull();
    expect(row.headSha).toBeNull();
    expect(await statusOf(item.id)).toBe('in_progress');
  });

  it('a LEGACY row (draft unknown, checks recorded) is asked for its flag only, then promotes', async () => {
    const s = await makeScenario('legacy-row@example.com');
    const item = await linkedThenParked(s, 'in_progress', 56);
    hostVerdict('success');
    await ci(56, 'success');
    await setStatus(item.id, 'in_progress');
    await adminDb.approvalGate.deleteMany({ where: { workItemId: item.id } });
    await adminDb.githubPullRequest.updateMany({ where: { number: 56 }, data: { draft: null } });
    hostPrs.set(56, { draft: false, headSha: SHA, mergeableState: 'clean' });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    await promoteAfterDeliverySetChange(
      { workItemIds: [], pullRequestId: (await prRow(56)).id },
      s.ctx,
    );

    expect((await prRow(56)).draft).toBe(false);
    // The pull request was read; its checks, already recorded at that head, were not.
    expect(
      fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => /check-runs/.test(u)),
    ).toEqual([]);
    expect(await promoteAfterDeliverySetChange({ workItemIds: [item.id] }, s.ctx)).toEqual([
      item.id,
    ]);
  });

  it('a provider that gives no reading leaves the placeholder as it was', async () => {
    const s = await makeScenario('no-reading@example.com');
    const item = await card(s, 'no reading');
    await setStatus(item.id, 'in_progress');
    const github = getGitProvider('github') as Required<GitProvider>;
    const spy = vi.spyOn(github, 'readChangeRequestMergeability').mockResolvedValue(null as never);
    let asked = 0;
    try {
      await link(item.identifier, 57);
      asked = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }

    expect(asked).toBeGreaterThan(0);
    expect(await prRow(57)).toMatchObject({ draft: null, headSha: null });
    expect(await statusOf(item.id)).toBe('in_progress');
  });

  it('a row that already holds check rows at its head is not re-read', async () => {
    const s = await makeScenario('rows-known@example.com');
    const item = await linkedThenParked(s, 'implemented', 55);
    hostVerdict('failure');
    await ci(55, 'failure');
    expect(await adminDb.githubCheckRun.count({ where: { commitSha: SHA } })).toBeGreaterThan(0);
    await setStatus(item.id, 'implemented');
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    // No cards: only the host read runs, so any fetch would be the hydration's.
    await promoteAfterDeliverySetChange(
      { workItemIds: [], pullRequestId: (await prRow(55)).id },
      s.ctx,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await statusOf(item.id)).toBe('implemented');
  });
});

describe("a run's own `implemented` report after CI already promoted the card (review of #4403)", () => {
  it('changes nothing: still In Review, the same question, no new revision', async () => {
    const s = await makeScenario('late-report@example.com');
    const item = await linkedThenParked(s, 'in_progress', 61);
    await ci(61, 'success');
    expect(await statusOf(item.id)).toBe('in_review');
    const gatesBefore = await adminDb.approvalGate.findMany({
      where: { workItemId: item.id },
      select: { id: true, state: true },
    });
    const revisions = await adminDb.workItemRevision.count({ where: { workItemId: item.id } });

    const result = await runTransitionStatus(
      { key: item.identifier, status: 'implemented' },
      s.ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('no-op');
    expect(await statusOf(item.id)).toBe('in_review');
    expect(
      await adminDb.approvalGate.findMany({
        where: { workItemId: item.id },
        select: { id: true, state: true },
      }),
    ).toEqual(gatesBefore);
    expect(await adminDb.workItemRevision.count({ where: { workItemId: item.id } })).toBe(
      revisions,
    );
  });

  it('still moves the card back when its set no longer holds it In Review', async () => {
    const s = await makeScenario('late-report-red@example.com');
    const item = await linkedThenParked(s, 'in_progress', 62);
    await ci(62, 'success');
    expect(await statusOf(item.id)).toBe('in_review');
    // A member went into conflict under the question: the promotion no longer holds.
    await adminDb.githubPullRequest.updateMany({
      where: { number: 62 },
      data: { mergeableState: 'dirty', mergeableStateHeadSha: SHA },
    });

    await runTransitionStatus({ key: item.identifier, status: 'implemented' }, s.ctx);

    expect(await statusOf(item.id)).toBe('implemented');
  });
});
