import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { mintInstallationToken } from '@/lib/github/appAuth';
import {
  PULL_REQUEST_RECONCILE_QUIET_MINUTES,
  pullRequestReconcileService,
} from '@/lib/services/pullRequestReconcileService';
import { pullRequestReconcile } from '@/lib/jobs/definitions/pullRequestReconcile';
import { mergeCandidateHead } from '@/lib/services/mergeGates';
import { jobDefinitions } from '@/lib/jobs/registry';
import { JobTestEngine } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE OPEN-DELIVERY RECONCILE (MOTIR-5390) over real Postgres, driven through the
// real `pull_request` webhook seam.
//
// The defect: a merge whose `pull_request` delivery failed or never arrived left
// the mirror row `open` and the card unclosed for ever — GitHub does not redeliver
// a failed App delivery and nothing re-read the host. Every case below asserts the
// card's STATUS and the reconcile's SUMMARY, because a reconcile that reports a
// replay while the card stays put is the same silent failure one level up.
//
// Stubbed, both ABOVE the code under test (the `historical-pr-backfill` precedent):
// `fetch` (the GitHub REST read) and `mintInstallationToken` (a real mint needs an
// App private key). Everything from the service down is real.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-reconcile';
const CORE_REPO_ID = '9301';
const AI_REPO_ID = '9302';
const CUSTOMER_REPO_ID = '9303';
/** Not the provisioning org — a repository the customer connected. */
const CUSTOMER_OWNER = 'acme-corp';
const MERGED_AT = '2026-09-13T19:58:55.000Z';

/** Past the quiet threshold, so every row written "now" is a candidate. */
const LATER = () => new Date(Date.now() + (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000);

type HostPr = {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** MOTIR-5914 — the host's mergeability and the head it is about. Absent, the payload
   *  carries neither, exactly as before. */
  mergeable?: boolean | null;
  mergeableState?: string;
  headSha?: string;
};

/** What GitHub currently says, per repo name + number. */
let host: Map<string, HostPr | { status: number }>;
/** MOTIR-5838 — what GitHub says a commit's check runs are, per `repo@sha`.
 *  Each entry is the REST triple `[name, status, conclusion]`. */
let hostChecks: Map<string, [name: string, status: string, conclusion: string | null][]>;
/** MOTIR-5843 — the installation token each repo's PR read carried, by repo name. */
let tokensSeen: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

const CHECK_SUITE_ID = 87626131838;
const STUCK_HEAD_SHA = '7bf7511e3f774e6f067c1e8bfdc029b9c48e4a89';

function hostPayload(pr: HostPr) {
  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged ? MERGED_AT : null,
    draft: false,
    title: 'Some change',
    head: pr.headSha ? { ref: pr.headRef, sha: pr.headSha } : { ref: pr.headRef },
    base: { ref: pr.baseRef },
    user: { id: 4242 },
    ...(pr.mergeable !== undefined ? { mergeable: pr.mergeable } : {}),
    ...(pr.mergeableState !== undefined ? { mergeable_state: pr.mergeableState } : {}),
  };
}

function installFetch() {
  fetchMock = vi.fn(async (url: string, init?: unknown) => {
    // ⚠️ The OWNER is a wildcard, not `moooon` (MOTIR-5843). The provenance cases
    // below put a customer-owned repository on the same installation, and a regex
    // pinned to one owner answers 500 for it — which reads as a host failure
    // rather than as the fixture not being wired. Every repo NAME in this file is
    // unique, so the maps stay keyed on the name.
    const files = /\/repos\/[^/]+\/([^/]+)\/pulls\/(\d+)\/files/.exec(url);
    if (files)
      return new Response(JSON.stringify([{ filename: 'lib/changed.ts' }]), { status: 200 });
    // MOTIR-5838 — what the host says a commit's check runs are. Served from a
    // mutable map so a test can make the host disagree with the recorded set,
    // which is the whole of the lost-completion shape.
    const checks = /\/repos\/[^/]+\/([^/]+)\/commits\/([0-9a-f]+)\/check-runs/.exec(url);
    if (checks) {
      const runs = hostChecks.get(`${checks[1]}@${checks[2]}`) ?? [];
      return new Response(
        JSON.stringify({
          total_count: runs.length,
          check_runs: runs.map(([name, status, conclusion]) => ({
            name,
            status,
            conclusion,
            check_suite: { id: CHECK_SUITE_ID },
          })),
        }),
        { status: 200 },
      );
    }
    const one = /\/repos\/[^/]+\/([^/]+)\/pulls\/(\d+)$/.exec(url);
    if (!one) return new Response('not stubbed', { status: 500 });
    // MOTIR-5843 — WHICH TOKEN this repository's read actually carried. The memo
    // criterion is about the token a repository RECEIVES, so it is measured here,
    // on the request, rather than by counting mints (a reconcile pass mints
    // several times for other, already-correct reasons).
    const bearer = (init as { headers?: Record<string, string> } | undefined)?.headers?.[
      'authorization'
    ];
    if (bearer) tokensSeen.set(one[1]!, bearer.replace(/^Bearer /, ''));
    const entry = host.get(`${one[1]}#${one[2]}`);
    if (!entry) return new Response('{}', { status: 404 });
    if ('status' in entry) return new Response('{}', { status: entry.status });
    return new Response(JSON.stringify(hostPayload(entry)), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

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
        providerRepoId: CORE_REPO_ID,
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
      {
        providerRepoId: AI_REPO_ID,
        owner: 'moooon',
        name: 'motir-ai',
        defaultBranch: 'trunk',
        archived: false,
      },
      // ⚠️ A CUSTOMER-OWNED repository on the SAME installation (MOTIR-5843).
      // This is the pair the per-pass token memo has to keep apart: two repos,
      // one installation, different provenance — so one of them mints through
      // the provisioning App and the other must not receive that token.
      {
        providerRepoId: CUSTOMER_REPO_ID,
        owner: CUSTOMER_OWNER,
        name: 'acme-web',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

type Member = {
  repo: 'motir-core' | 'motir-ai' | 'acme-web';
  number: number;
  baseRef: string;
};
const CORE: Member = { repo: 'motir-core', number: 101, baseRef: 'main' };
const AI: Member = { repo: 'motir-ai', number: 202, baseRef: 'trunk' };
/** The customer-owned member — owner `acme-corp`, same installation as CORE. */
const CUSTOMER: Member = { repo: 'acme-web', number: 303, baseRef: 'main' };

const ownerOf = (m: Member) => (m.repo === 'acme-web' ? CUSTOMER_OWNER : 'moooon');

const providerIdOf = (m: Member) =>
  m.repo === 'motir-core' ? CORE_REPO_ID : m.repo === 'motir-ai' ? AI_REPO_ID : CUSTOMER_REPO_ID;

function deliveryPayload(m: Member, headRef: string, opts: { action: string; merged?: boolean }) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID },
    repository: { id: Number(providerIdOf(m)) },
    pull_request: hostPayload({
      number: m.number,
      state: opts.merged ? 'closed' : 'open',
      merged: opts.merged ?? false,
      headRef,
      baseRef: m.baseRef,
    }),
  };
}

/** A card at `implemented` delivered by `members`, each opened and linked. */
async function linkedCard(
  s: Awaited<ReturnType<typeof makeScenario>>,
  title: string,
  members: Member[],
) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const m of members) {
    const headRef = `subtask/${item.identifier}-${m.number}`;
    await githubWebhookService.handleEvent(
      'pull_request',
      deliveryPayload(m, headRef, { action: 'opened' }),
    );
    await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: s.project.id,
        owner: ownerOf(m),
        name: m.repo,
        number: m.number,
        headRef,
        baseRef: m.baseRef,
        title: null,
      },
      s.ctx,
    );
  }
  if ((await statusOf(item.id)) !== 'implemented') {
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
  }
  // The SETUP's host reads are not what this suite measures. Since MOTIR-11040 a
  // link records its pull request's repository in the project's set, and the link
  // check then reads each head it can now judge — so the calls are cleared here,
  // leaving every count below to the reconcile pass alone.
  fetchMock.mockClear();
  return item;
}

/** The host now reports `m` MERGED into `baseRef` (its own base unless overridden). */
function hostMerged(item: { identifier: string }, m: Member, baseRef = m.baseRef) {
  host.set(`${m.repo}#${m.number}`, {
    number: m.number,
    state: 'closed',
    merged: true,
    headRef: `subtask/${item.identifier}-${m.number}`,
    baseRef,
  });
}

function hostOpen(item: { identifier: string }, m: Member) {
  host.set(`${m.repo}#${m.number}`, {
    number: m.number,
    state: 'open',
    merged: false,
    headRef: `subtask/${item.identifier}-${m.number}`,
    baseRef: m.baseRef,
  });
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function prRow(m: Member) {
  return adminDb.githubPullRequest.findFirstOrThrow({
    where: { number: m.number, repo: { name: m.repo } },
  });
}

/** Revisions that moved the card INTO `done` — the transition history, counted. */
async function doneTransitions(workItemId: string): Promise<number> {
  const revisions = await adminDb.workItemRevision.findMany({ where: { workItemId } });
  return revisions.filter((r) => {
    const status = (r.diff as Record<string, unknown> | null)?.['status'] as
      | { to?: unknown }
      | undefined;
    return status?.to === 'done';
  }).length;
}

/** Hosts reads made for pull requests (excluding the merged-files capture). */
const hostReads = () =>
  fetchMock.mock.calls.filter(([url]) => /\/pulls\/\d+$/.test(String(url))).length;

beforeEach(async () => {
  await truncateAuthTables();
  host = new Map();
  hostChecks = new Map();
  tokensSeen = new Map();
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // MOTIR-5843 — the provenance cases stub `GITHUB_FALLBACK_ORG`, and an env stub
  // that outlives its test silently re-classifies every later repository.
  vi.unstubAllEnvs();
  vi.mocked(mintInstallationToken).mockClear();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a merge whose delivery was LOST is completed by the reconcile', () => {
  it('a merge delivery that FAILED leaves the card open — and the reconcile completes it', async () => {
    const s = await makeScenario('reconcile-failed@example.com');
    const card = await linkedCard(s, 'lost merge', [CORE]);

    // The merge delivery fails inside the sync's resolve transaction — the shape
    // of the 2026-09-13 incident (a transaction that could not start in time).
    vi.spyOn(githubPullRequestRepository, 'upsert').mockRejectedValueOnce(
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
    );
    await expect(
      githubWebhookService.handleEvent(
        'pull_request',
        deliveryPayload(CORE, `subtask/${card.identifier}-101`, { action: 'closed', merged: true }),
      ),
    ).rejects.toThrow(/Unable to start a transaction/);

    // The reproduction: the host has merged, Motir still says open, and nothing
    // will ever say otherwise on its own.
    expect((await prRow(CORE)).state).toBe('open');
    expect(await statusOf(card.id)).toBe('implemented');

    hostMerged(card, CORE);
    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 1, replayed: 1, transitioned: 1, failed: 0 });
    expect(await statusOf(card.id)).toBe('done');
    const row = await prRow(CORE);
    expect(row).toMatchObject({ state: 'closed', merged: true });
    // The merged-path capture ran too, so the replayed row is indistinguishable
    // from one a real delivery wrote.
    expect(row.mergedAt?.toISOString()).toBe(MERGED_AT);
    expect(row.changedPaths).toEqual(['lib/changed.ts']);
  });

  it('a merge delivery that died AFTER writing the row — at the transition — is completed too', async () => {
    const s = await makeScenario('reconcile-halfway@example.com');
    const card = await linkedCard(s, 'half-way', [CORE]);

    // The sync commits the row upsert, then fails moving the card: the row reads
    // merged, the card has not moved, and the capture that stamps `merged_at`
    // never ran.
    vi.spyOn(workItemsService, 'updateStatus').mockRejectedValueOnce(
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
    );
    await expect(
      githubWebhookService.handleEvent(
        'pull_request',
        deliveryPayload(CORE, `subtask/${card.identifier}-101`, { action: 'closed', merged: true }),
      ),
    ).rejects.toThrow(/Unable to start a transaction/);
    vi.restoreAllMocks();
    expect(await prRow(CORE)).toMatchObject({ state: 'closed', merged: true, mergedAt: null });
    expect(await statusOf(card.id)).toBe('implemented');

    hostMerged(card, CORE);
    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 1, replayed: 1, transitioned: 1 });
    expect(await statusOf(card.id)).toBe('done');
    expect((await prRow(CORE)).mergedAt?.toISOString()).toBe(MERGED_AT);

    // …and, its capture now stamped, the row is not a candidate again.
    const again = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });
    expect(again.examined).toBe(0);
  });

  it('a merged row with no `merged_at` OLDER than the lookback is not a candidate', async () => {
    const s = await makeScenario('reconcile-lookback@example.com');
    const card = await linkedCard(s, 'ancient', [CORE]);
    await adminDb.githubPullRequest.updateMany({
      data: {
        state: 'closed',
        merged: true,
        mergedAt: null,
        updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
      },
    });
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary.examined).toBe(0);
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('a merge delivery that NEVER ARRIVED is completed the same way', async () => {
    const s = await makeScenario('reconcile-missing@example.com');
    const card = await linkedCard(s, 'never delivered', [CORE]);
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ replayed: 1, transitioned: 1 });
    expect(await statusOf(card.id)).toBe('done');
  });

  it('runs as the scheduled `system.pull-request-reconcile` job', async () => {
    expect(jobDefinitions).toContain(pullRequestReconcile);
    const s = await makeScenario('reconcile-job@example.com');
    const card = await linkedCard(s, 'via the job', [CORE]);
    hostMerged(card, CORE);
    // The job reads the real clock, so age the row past the threshold instead.
    await adminDb.githubPullRequest.updateMany({
      data: {
        updatedAt: new Date(Date.now() - (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000),
      },
    });

    const { result } = await new JobTestEngine({ function: pullRequestReconcile }).execute();

    expect(result).toMatchObject({ replayed: 1, transitioned: 1 });
    expect(await statusOf(card.id)).toBe('done');
  });
});

describe('the reconcile goes through the SAME gates a delivery does', () => {
  it('the delivery-set gate still holds a card whose sibling pull request is truly open on the host', async () => {
    const s = await makeScenario('reconcile-set@example.com');
    const card = await linkedCard(s, 'two repositories', [CORE, AI]);
    hostMerged(card, CORE);
    hostOpen(card, AI);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 2, replayed: 1, transitioned: 0, stillOpen: 1 });
    expect(await statusOf(card.id)).toBe('implemented');
    expect((await prRow(CORE)).merged).toBe(true);
    expect((await prRow(AI)).state).toBe('open');
  });

  it('the base-branch gate still refuses a merge into a non-default base', async () => {
    const s = await makeScenario('reconcile-base@example.com');
    const card = await linkedCard(s, 'stacked', [CORE]);
    hostMerged(card, CORE, 'subtask/some-dead-branch');

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ replayed: 1, transitioned: 0 });
    expect(await statusOf(card.id)).toBe('implemented');
  });
});

describe('a late real delivery and the reconcile converge on ONE transition', () => {
  it('reconcile first, then the real (late) delivery: one move to done', async () => {
    const s = await makeScenario('reconcile-late@example.com');
    const card = await linkedCard(s, 'late delivery', [CORE]);
    hostMerged(card, CORE);

    await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });
    const late = await githubWebhookService.handleEvent(
      'pull_request',
      deliveryPayload(CORE, `subtask/${card.identifier}-101`, { action: 'closed', merged: true }),
    );

    expect(late).toMatchObject({ outcome: 'noop' });
    expect(await statusOf(card.id)).toBe('done');
    expect(await doneTransitions(card.id)).toBe(1);
  });

  it('real delivery first, then the reconcile: the row is no longer a candidate', async () => {
    const s = await makeScenario('reconcile-first@example.com');
    const card = await linkedCard(s, 'delivered', [CORE]);
    await githubWebhookService.handleEvent(
      'pull_request',
      deliveryPayload(CORE, `subtask/${card.identifier}-101`, { action: 'closed', merged: true }),
    );
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 0, replayed: 0 });
    expect(hostReads()).toBe(0);
    expect(await doneTransitions(card.id)).toBe(1);
  });
});

describe('the host calls are BOUNDED', () => {
  it('a row delivering only a FINISHED card is never fetched', async () => {
    const s = await makeScenario('reconcile-terminal@example.com');
    const card = await linkedCard(s, 'closed by hand', [CORE]);
    await workItemsService.updateStatus(card.id, 'in_review', s.ctx);
    // ⚠️ A SYSTEM write, since MOTIR-5526 (ADR `approval-gates.md` §6d AMENDMENT,
    // rule 2b): with its pull request still open, a HAND move to Done is refused —
    // the merge is Done's one writer. This fixture only needs a finished card, so
    // it reaches Done the way the importer or the cascade would.
    await withWorkspaceContext(s.ctx, (tx) =>
      workItemsService.applyStatusTransition(card.id, 'done', s.ctx, tx, { system: true }),
    );
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 1, skippedNoLiveCard: 1, replayed: 0 });
    expect(hostReads()).toBe(0);
  });

  it('a row delivering only an ARCHIVED card is never fetched', async () => {
    const s = await makeScenario('reconcile-archived@example.com');
    const card = await linkedCard(s, 'archived', [CORE]);
    await workItemsService.archiveWorkItem(card.id, s.ctx);
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ skippedNoLiveCard: 1 });
    expect(hostReads()).toBe(0);
  });

  it('a row heard from inside the quiet threshold is not a candidate', async () => {
    const s = await makeScenario('reconcile-quiet@example.com');
    const card = await linkedCard(s, 'recent', [CORE]);
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: new Date() });

    expect(summary.examined).toBe(0);
    expect(hostReads()).toBe(0);
  });

  it('takes at most `batchSize` rows per pass, oldest first', async () => {
    const s = await makeScenario('reconcile-batch@example.com');
    const card = await linkedCard(s, 'two rows', [CORE, AI]);
    hostOpen(card, CORE);
    hostOpen(card, AI);
    await adminDb.githubPullRequest.updateMany({
      where: { number: AI.number },
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({
      now: LATER(),
      batchSize: 1,
    });

    expect(summary).toMatchObject({ examined: 1, stillOpen: 1 });
    // Only the single-PR reads — the `opened` deliveries above also capture paths.
    const reads = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => /\/pulls\/\d+$/.test(url));
    expect(reads).toEqual([expect.stringMatching(/motir-ai\/pulls\/202$/)]);
  });

  it('a row still open on the host is stamped as heard-from, and nothing moves', async () => {
    const s = await makeScenario('reconcile-open@example.com');
    const card = await linkedCard(s, 'still open', [CORE]);
    hostOpen(card, CORE);
    const old = new Date(Date.now() - 60 * 60_000);
    await adminDb.githubPullRequest.updateMany({ data: { updatedAt: old } });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, replayed: 0 });
    expect(await statusOf(card.id)).toBe('implemented');
    expect((await prRow(CORE)).updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });
});

describe('a per-row failure is COUNTED, never thrown', () => {
  it('a pull request the host no longer has is reported as gone and moves nothing', async () => {
    const s = await makeScenario('reconcile-gone@example.com');
    const card = await linkedCard(s, 'gone', [CORE]);
    host.set('motir-core#101', { status: 404 });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ gone: 1, replayed: 0, failed: 0 });
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('an unreadable pull request and a failed mint are each counted, and the pass completes', async () => {
    const s = await makeScenario('reconcile-fail@example.com');
    const card = await linkedCard(s, 'unreadable', [CORE, AI]);
    host.set('motir-core#101', { status: 401 });
    hostMerged(card, AI);

    const first = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });
    expect(first).toMatchObject({ examined: 2, failed: 1, replayed: 1 });

    vi.mocked(mintInstallationToken).mockRejectedValueOnce(new Error('no private key'));
    const second = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });
    expect(second).toMatchObject({ examined: 1, failed: 1, replayed: 0 });
    expect(await statusOf(card.id)).toBe('implemented');
  });
});

// ── MOTIR-5671: the sweep also repairs a card whose GATES are wrong ─────────────
describe('a card whose question went missing is repaired by the sweep', () => {
  it('a still-open row whose card is green and gateless gets its gate back', async () => {
    // A LOST EVENT costs a card its gate exactly as it costs it a merge: every
    // raise in the product hangs off a delivery, so a check-suite delivery that
    // never arrived leaves a green card with no question on it and nothing else
    // ever asks again. That is this sweep's own justification, applied to the
    // other thing a delivery carries — and it is independent of MOTIR-5670's
    // premise, which the measurement there falsified.
    const s = await makeScenario('reconcile-gate@example.com');
    const card = await linkedCard(s, 'green and gateless', [CORE]);
    hostOpen(card, CORE);

    // The green verdict arrived and its gate did not: the row is green, the card
    // is in review, and no gate exists. Written directly because the point is a
    // state the product cannot reach through a door — that is what makes it a
    // repair rather than a raise.
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: (await prRow(CORE)).id,
        commitSha: 'sha-lost',
        checkName: 'ci / vitest',
        conclusion: 'success',
      },
    });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_review' } });
    expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(0);
    await adminDb.githubPullRequest.updateMany({
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, replayed: 0, gatesRaised: 1 });
    const [gate] = await adminDb.approvalGate.findMany({ where: { workItemId: card.id } });
    expect(gate).toMatchObject({ kind: 'pull_request_approval', state: 'awaiting' });
  });

  it('writes NOTHING for a card whose gates are already right', async () => {
    // `reconcileGatesFor` only raises what is missing and never supersedes, so a
    // sweep over a correct card is a no-op — which is what makes running it every
    // thirty minutes safe.
    const s = await makeScenario('reconcile-gate-noop@example.com');
    const card = await linkedCard(s, 'already right', [CORE]);
    hostOpen(card, CORE);
    await adminDb.githubPullRequest.updateMany({
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, gatesRaised: 0 });
    expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(0);
  });
});

// MOTIR-5914 — THE SWEEP IS ALSO THE MERGEABILITY BACKSTOP. The read it already makes
// carries the host's `mergeable_state`, so a conflict the base-branch job never saw (a
// lost push, a read GitHub had not computed in time) is settled here: stored, the
// question withdrawn, the card held at Implemented — BEFORE the gate repair above, which
// would otherwise raise a question over a member that cannot merge.
describe('the sweep settles a member the host now reports conflicted (MOTIR-5914)', () => {
  it('a green in-review member the host reports `dirty`: stored, NO gate raised, and the card held at Implemented', async () => {
    const s = await makeScenario('reconcile-conflict@example.com');
    const card = await linkedCard(s, 'conflicted while nobody was looking', [CORE]);
    host.set(`${CORE.repo}#${CORE.number}`, {
      number: CORE.number,
      state: 'open',
      merged: false,
      headRef: `subtask/${card.identifier}-${CORE.number}`,
      baseRef: CORE.baseRef,
      mergeable: false,
      mergeableState: 'dirty',
      headSha: 'sha-conflicted',
    });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: (await prRow(CORE)).id,
        commitSha: 'sha-conflicted',
        checkName: 'ci / vitest',
        conclusion: 'success',
      },
    });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_review' } });
    await adminDb.githubPullRequest.updateMany({
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, gatesRaised: 0 });
    const row = await prRow(CORE);
    expect([row.mergeableState, row.mergeableStateHeadSha]).toEqual(['dirty', 'sha-conflicted']);
    expect(await statusOf(card.id)).toBe('implemented');
    expect(
      await adminDb.approvalGate.count({ where: { workItemId: card.id, state: 'awaiting' } }),
    ).toBe(0);
  });
});

// MOTIR-7005 — A PUSH THAT PRODUCED NO CI MOVES THE HEAD ANYWAY.
//
// The flap, as observed: a pull request green at A (card In Review, gate @A) gets a
// push B that conflicts with its base. GitHub builds no merge ref for a conflicting
// pull request, so no `pull_request` workflow runs and the check rows stay at A. Every
// reconcile tick then stored `dirty @ B`, withdrew the question (card → Implemented),
// and promoted it straight back — because the promotion read "the head" off the check
// rows (A), discarded the reading as older, saw green, and raised a fresh gate @A.
//
// The fix stores the host's head, and every reader asks `pullRequestHead`: a head with
// no check rows is not green, so the card stays put however many ticks pass.
describe('a push that produced no CI is not green at its old commit (MOTIR-7005)', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  /** The `synchronize` delivery GitHub sends for a push to `m`'s branch. */
  async function pushed(card: { identifier: string }, m: Member, headSha: string) {
    const payload = deliveryPayload(m, `subtask/${card.identifier}-${m.number}`, {
      action: 'synchronize',
    });
    payload.pull_request = hostPayload({
      number: m.number,
      state: 'open',
      merged: false,
      headRef: `subtask/${card.identifier}-${m.number}`,
      baseRef: m.baseRef,
      headSha,
    });
    await githubWebhookService.handleEvent('pull_request', payload);
  }

  /** What the host reports on the next tick: open, at `headSha`, with this reading. */
  function hostAt(
    card: { identifier: string },
    m: Member,
    headSha: string,
    mergeableState: 'clean' | 'dirty',
  ) {
    host.set(`${m.repo}#${m.number}`, {
      number: m.number,
      state: 'open',
      merged: false,
      headRef: `subtask/${card.identifier}-${m.number}`,
      baseRef: m.baseRef,
      mergeable: mergeableState === 'clean',
      mergeableState,
      headSha,
    });
  }

  async function greenAt(m: Member, commitSha: string) {
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: (await prRow(m)).id,
        commitSha,
        checkName: 'ci / vitest',
        conclusion: 'success',
      },
    });
  }

  const awaitingGates = (workItemId: string) =>
    adminDb.approvalGate.findMany({
      where: { workItemId, kind: 'pull_request_approval', state: 'awaiting' },
    });

  /** The row as the merge-candidate predicate reads it. */
  const candidateRow = async (m: Member) => {
    const row = await prRow(m);
    const checkRuns = await adminDb.githubCheckRun.findMany({ where: { pullRequestId: row.id } });
    return { ...row, checkRuns, repo: { provider: 'github' } };
  };

  /** Green at A, promoted by the sweep, one gate asking about A. */
  async function greenAndAskedAtA(email: string) {
    const s = await makeScenario(email);
    const card = await linkedCard(s, 'green at A', [CORE]);
    await pushed(card, CORE, SHA_A);
    await greenAt(CORE, SHA_A);
    hostAt(card, CORE, SHA_A, 'clean');

    await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(await statusOf(card.id)).toBe('in_review');
    const gates = await awaitingGates(card.id);
    expect(gates.map((g) => g.subjectVersion)).toEqual([
      `moooon/motir-core#${CORE.number}@${SHA_A}`,
    ]);
    return card;
  }

  it('a conflicting push holds the card at Implemented across two reconcile passes, and asks nothing', async () => {
    const card = await greenAndAskedAtA('reconcile-7005-flap@example.com');

    // The push: GitHub delivers `synchronize` @B and runs NO CI, so the rows stay at A.
    await pushed(card, CORE, SHA_B);
    expect((await prRow(CORE)).headSha).toBe(SHA_B);
    expect(await awaitingGates(card.id)).toEqual([]);

    // Every tick reads the host: open, `dirty`, at B.
    hostAt(card, CORE, SHA_B, 'dirty');
    for (const pass of [1, 2]) {
      const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

      expect(summary, `pass ${pass}`).toMatchObject({ stillOpen: 1, promoted: 0, gatesRaised: 0 });
      expect(await statusOf(card.id), `pass ${pass}`).toBe('implemented');
      expect(await awaitingGates(card.id), `pass ${pass}`).toEqual([]);
      const row = await prRow(CORE);
      expect([row.headSha, row.mergeableState, row.mergeableStateHeadSha]).toEqual([
        SHA_B,
        'dirty',
        SHA_B,
      ]);
      // Green at A says nothing about B: not a merge candidate.
      expect(mergeCandidateHead(await candidateRow(CORE))).toBeNull();
    }
  });

  it('a clean push with no checks yet is not promotable either — and the gate, once owed, names the real head', async () => {
    const card = await greenAndAskedAtA('reconcile-7005-no-checks@example.com');

    await pushed(card, CORE, SHA_B);
    hostAt(card, CORE, SHA_B, 'clean');
    await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    // Mergeable, but nothing has reported at B: the push withdrew the question @A and
    // nothing asks again — the sweep's gate repair used to re-raise it @A, green-at-A.
    // (The card's own column waits for B's CI to move it; a push alone never has.)
    expect(await awaitingGates(card.id)).toEqual([]);
    expect(mergeCandidateHead(await candidateRow(CORE))).toBeNull();

    // B's checks arrive green: now it is promoted, and the question names B.
    await greenAt(CORE, SHA_B);
    await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(await statusOf(card.id)).toBe('in_review');
    const gates = await awaitingGates(card.id);
    expect(gates.map((g) => g.subjectVersion)).toEqual([
      `moooon/motir-core#${CORE.number}@${SHA_B}`,
    ]);
    expect(mergeCandidateHead(await candidateRow(CORE))).toBe(SHA_B);
  });

  it('a reconcile read that learns the head moves it, when the push delivery was lost', async () => {
    const card = await greenAndAskedAtA('reconcile-7005-lost-push@example.com');

    // No `synchronize` ever arrives; the host has moved to B and conflicts there.
    hostAt(card, CORE, SHA_B, 'dirty');
    await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect((await prRow(CORE)).headSha).toBe(SHA_B);
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await awaitingGates(card.id)).toEqual([]);
  });
});

// MOTIR-5838 — A LOST CHECK COMPLETION IS THE SAME SHAPE ONE LAYER DOWN.
//
// The sweep above repairs a lost CLOSE and a missing GATE. This repairs a card
// whose recorded check set is itself wrong: a `pending` row nothing will ever
// refresh folds the pull request to `running`, so the card is not promotable, no
// gate is OWED, and the gate sweep raises nothing — correctly, and for ever.
//
// Observed on PR #2994 / MOTIR-5782: GitHub reported 22 `success` + 8 `skipped`
// and ZERO pending at head `7bf7511e3`, while Motir's delivery row read
// `ci: "running"`. Both the 21:00 and 21:30 ticks passed with no change.
describe('a lost CHECK COMPLETION is repaired by the same sweep', () => {
  /** Seed the stranded set: one lane settled, one stuck at `pending`, both
   *  back-dated past the stale threshold. `updatedAt` is written explicitly
   *  because the column is `@updatedAt` and a create would stamp it `now()`. */
  async function strandedAtPending(m: Member, writtenAt: Date) {
    const pr = await prRow(m);
    await adminDb.githubCheckRun.createMany({
      data: [
        {
          pullRequestId: pr.id,
          commitSha: STUCK_HEAD_SHA,
          checkName: 'TypeScript build',
          checkSuiteId: String(CHECK_SUITE_ID),
          conclusion: 'success',
        },
        {
          pullRequestId: pr.id,
          commitSha: STUCK_HEAD_SHA,
          checkName: 'Vitest',
          checkSuiteId: String(CHECK_SUITE_ID),
          conclusion: 'pending',
        },
      ],
    });
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id, commitSha: STUCK_HEAD_SHA },
      data: { createdAt: writtenAt, updatedAt: writtenAt },
    });
  }

  const conclusionOf = async (m: Member, checkName: string) =>
    (
      await adminDb.githubCheckRun.findFirstOrThrow({
        where: { pullRequestId: (await prRow(m)).id, commitSha: STUCK_HEAD_SHA, checkName },
      })
    ).conclusion;

  it('re-reads the host, settles the stuck row, promotes the card and raises its gate', async () => {
    const s = await makeScenario('reconcile-stale-check@example.com');
    const card = await linkedCard(s, 'green on the host, running in Motir', [CORE]);
    hostOpen(card, CORE);
    await strandedAtPending(CORE, new Date(Date.now() - 60 * 60_000));
    await adminDb.githubPullRequest.updateMany({
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    // The host has every check complete and green; Motir holds one at `pending`.
    hostChecks.set(`motir-core@${STUCK_HEAD_SHA}`, [
      ['TypeScript build', 'completed', 'success'],
      ['Vitest', 'completed', 'success'],
    ]);

    // The reproduction: green and mergeable on the host, and nothing on the card.
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(0);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, replayed: 0, promoted: 1 });
    expect(await conclusionOf(CORE, 'Vitest')).toBe('success');
    expect(await statusOf(card.id)).toBe('in_review');
    const [gate] = await adminDb.approvalGate.findMany({ where: { workItemId: card.id } });
    expect(gate).toMatchObject({ kind: 'pull_request_approval', state: 'awaiting' });
  });

  it('leaves a lane the host still reports RUNNING exactly where it is', async () => {
    const s = await makeScenario('reconcile-really-running@example.com');
    const card = await linkedCard(s, 'a genuinely slow lane', [CORE]);
    hostOpen(card, CORE);
    await strandedAtPending(CORE, new Date(Date.now() - 60 * 60_000));
    await adminDb.githubPullRequest.updateMany({
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });
    hostChecks.set(`motir-core@${STUCK_HEAD_SHA}`, [
      ['TypeScript build', 'completed', 'success'],
      ['Vitest', 'in_progress', null],
    ]);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, promoted: 0 });
    expect(await conclusionOf(CORE, 'Vitest')).toBe('pending');
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(0);
  });
});

// ── PROVENANCE: which App the reconcile mints through (MOTIR-5843) ───────────
//
// The defect Yue saw by name, in an acceptance transcript:
//
//   [pullRequestReconcile] could not reconcile motir-projects-e2e/decision-web#16101;
//   it is due again next pass: GithubAppNotConfiguredError: GitHub App (user-facing)
//   is not configured.
//
// A hosted repository is on the provisioning App and on NO other, so minting
// through the user-facing default cannot reach it — the refusal is counted as
// `failed` and retried for ever, which is why a hosted repository's pull requests
// never reconcile.
//
// ⚠️ MEASURED ON THE TOKEN THE READ CARRIED, not by counting mints. `appAuth` is
// mocked at module scope here (a real mint needs an RSA key — the header's
// `historical-pr-backfill` precedent), so the "wire only one App" arm cannot bite
// in this file. Instead the mock stamps the resolved ROLE into the token it
// returns and the fetch stub records what each repository's read presented, which
// is the criterion stated literally: what token did THIS repository receive.
describe('the App is chosen by the repository’s provenance', () => {
  /** Make each mint return a token that NAMES the App it came from, so the
   *  request a repository made identifies the registration behind it. */
  function stampTokensWithRole() {
    vi.mocked(mintInstallationToken).mockImplementation(async (_id, role) => ({
      token: `ghs_${role ?? 'defaulted'}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    }));
  }

  /** A card whose linked pull request is open in Motir and MERGED on the host —
   *  i.e. exactly one reconcile candidate. */
  async function candidate(s: Awaited<ReturnType<typeof makeScenario>>, title: string, m: Member) {
    const card = await linkedCard(s, title, [m]);
    hostMerged(card, m);
    return card;
  }

  it('a HOSTED repository is read with a PROVISIONING-App token', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'moooon');
    stampTokensWithRole();
    const s = await makeScenario('prov-hosted@example.com');
    const card = await candidate(s, 'hosted reconcile', CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 1, replayed: 1, failed: 0 });
    expect(await statusOf(card.id)).toBe('done');
    // Before the fix this read carried `ghs_defaulted` — the seam was handed no
    // repository, so the mint fell to the user-facing default.
    expect(tokensSeen.get('motir-core')).toBe('ghs_provisioning');
  });

  it('CONTROL — a CUSTOMER-OWNED repository is still read with a USER-FACING token, with the provisioning org configured', async () => {
    // The provisioning org is SET and is not this repository's owner. Without this
    // half, an implementation that always reached for the provisioning App would
    // pass the case above and break every real tenant.
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    stampTokensWithRole();
    const s = await makeScenario('prov-customer@example.com');
    const card = await candidate(s, 'customer reconcile', CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 1, replayed: 1, failed: 0 });
    expect(await statusOf(card.id)).toBe('done');
    expect(tokensSeen.get('motir-core')).toBe('ghs_user-facing');
  });

  // ⚠️ THE MEMO. Both cases above pass with the per-pass cache still keyed on
  // `installationId` alone — one repository per pass never reveals a shared key.
  // This is the case that does: TWO repositories, ONE installation, DIFFERENT
  // provenance, in a SINGLE pass.
  //
  // It is also the one regression this change could INTRODUCE rather than remove.
  // Before the fix the memo was safe only because every mint through it was wrong
  // in the same direction; resolving provenance per repository without widening
  // the key hands the second repository the first's credential — a
  // cross-repository token leak, worse than the refusal being fixed, announcing
  // itself nowhere.
  it('two repositories on ONE installation with DIFFERENT provenance do not receive each other’s token', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'moooon'); // moooon hosted, acme-corp not
    stampTokensWithRole();
    const s = await makeScenario('prov-memo@example.com');
    const hosted = await candidate(s, 'hosted member', CORE);
    const customer = await candidate(s, 'customer member', CUSTOMER);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 2, replayed: 2, failed: 0 });
    expect(await statusOf(hosted.id)).toBe('done');
    expect(await statusOf(customer.id)).toBe('done');

    // The whole criterion, in two lines: each repository was read with its OWN
    // App's token. A cache keyed on the installation alone gives BOTH of them
    // whichever one was minted first.
    expect(tokensSeen.get('motir-core')).toBe('ghs_provisioning');
    expect(tokensSeen.get('acme-web')).toBe('ghs_user-facing');
  });
});
