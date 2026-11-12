import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const signedIn = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

import { db } from '@/lib/db';
import { mintInstallationToken } from '@/lib/github/appAuth';
import { pullRequestAutoMerge } from '@/lib/jobs/definitions/pullRequestAutoMerge';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { releaseProviderRepo } from '../helpers/releaseProviderRepo';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine } from '../helpers/jobs';
import { linkPrByIdentifier } from '../helpers/prLink';

const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');

// THE MERGE STORY'S JOURNEY, ACROSS ITS SEAMS (Story MOTIR-4882 · MOTIR-5519, §2) — real
// Postgres and the real webhook service, CI reports, the decide ROUTE and the merge
// webhook, with GitHub stubbed only at `fetch` and the App credential at `appAuth`
// (the convention in `tests/git/providerSeam.test.ts`). Each child's units mock their
// neighbours; this is the one place the chain runs whole:
//
//   green checks raise a question → a person answers it → GitHub merges →
//   the merge webhook, and nothing else, finishes the card.
//
// ⚠️ RE-KEYED ONTO ONE GATE PER CARD (Bug MOTIR-5603 · MOTIR-5617). A card no longer
// holds a `pull_request_merge` gate per pull request; it holds ONE
// `pull_request_approval` gate over its whole delivery set, and approving it merges
// every member. The journeys below therefore ask about the CARD's gate, and the door
// they press is `pullRequestMergeService.approveAndMerge` — the function the item
// page's *Approve and merge* action calls.
//
// ⚠️ THE REST DECIDE ROUTE IS A MERGING DOOR TOO (MOTIR-5624). `decideGate` became a
// pass-through in MOTIR-5613 and the route approved the card while merging nothing;
// it now runs the press's own two steps for an approve on this gate, so journey 1
// walks BOTH doors and asserts they end in the same place.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-merge-journey';
const REPO_PROVIDER_ID = '993';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

// ── the stubbed host ───────────────────────────────────────────────────────────

interface Host {
  /** The head GitHub reports for each pull request number. */
  heads: Record<number, string>;
  /** The base branch's rules — `[{ type: 'merge_queue' }]` for a queued repository. */
  rules: unknown[];
  /** The answer to `PUT /pulls/{n}/merge`. */
  merge: (n: number) => { status: number; body?: unknown; headers?: Record<string, string> };
  /** The pull request as it reads on its SECOND read (the re-read after a 405). */
  reread: (n: number) => Record<string, unknown>;
  calls: Array<{ method: string; url: string }>;
}

let host: Host;

function resetHost(): void {
  host = {
    heads: {},
    rules: [],
    merge: (n) => ({ status: 200, body: { merged: true, sha: `merge-${n}` } }),
    reread: () => ({}),
    calls: [],
  };
  const reads = new Map<number, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers });
      const pull = url.match(/\/repos\/moooon\/acme\/pulls\/(\d+)(\/merge)?$/);
      if (url.endsWith('/repos/moooon/acme') && method === 'GET') {
        host.calls.push({ method, url });
        return json(200, { allow_squash_merge: true });
      }
      if (url.includes('/rules/branches/')) {
        host.calls.push({ method, url });
        return json(200, host.rules);
      }
      if (url.endsWith('/graphql')) {
        host.calls.push({ method, url });
        return json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } } });
      }
      if (pull && pull[2] && method === 'PUT') {
        host.calls.push({ method, url });
        const answer = host.merge(Number(pull[1]));
        return json(answer.status, answer.body ?? {}, answer.headers);
      }
      if (pull && !pull[2]) {
        const n = Number(pull[1]);
        host.calls.push({ method, url });
        const count = (reads.get(n) ?? 0) + 1;
        reads.set(n, count);
        return json(200, {
          node_id: `PR_${n}`,
          merged: false,
          state: 'open',
          head: { sha: host.heads[n] ?? 'unknown' },
          base: { ref: 'main' },
          ...(count > 1 ? host.reread(n) : {}),
        });
      }
      // Everything else the webhook path touches — the link check, the file listing —
      // is not this journey's subject.
      return json(404, {});
    }),
  );
}

const mergeCalls = () => host.calls.filter((c) => c.method === 'PUT' || c.url.endsWith('/graphql'));

// ── the scenario ───────────────────────────────────────────────────────────────

async function makeScenario(email: string, mode: 'auto' | 'manual') {
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
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: mode, prMergeModeDecidedAt: new Date() },
  });
  // Every scenario connects the SAME installation and repository, so the
  // previous scenario's organisation lets it go first (MOTIR-8218).
  await releaseProviderRepo(REPO_PROVIDER_ID);
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
  signedIn.current = { userId: user.id, workspaceId: workspace.id };
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}
type Scenario = Awaited<ReturnType<typeof makeScenario>>;

function prDelivery(action: string, number: number, headRef: string, merged = false) {
  return githubWebhookService.handleEvent('pull_request', {
    action,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged,
      merged_at: merged ? new Date().toISOString() : null,
      title: 'A change',
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

async function cardWithPrs(s: Scenario, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'The journey' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) {
    const headRef = `subtask/${item.identifier}-${number}`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef,
    });
    await prDelivery('opened', number, headRef);
  }
  return item;
}

/** CI reports a verdict for one pull request at one head — and GitHub now reports it. */
async function ci(conclusion: string | null, headSha: string, number: number) {
  host.heads[number] = headSha;
  return githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
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

async function decide(gateId: string, decision = 'approve') {
  // The route REQUIRES what the caller was shown (MOTIR-5234) — read it exactly as a
  // surface does, through the frame's own read, as the signed-in person.
  const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } });
  const { stamp } = await approvalGatesService.getForWorkItem(
    { workItemId: row.workItemId!, kind: row.kind },
    signedIn.current!,
  );
  const res = await decideRoute(
    new Request(`http://localhost/api/approval-gates/${gateId}/decide`, {
      method: 'POST',
      // A refusal SAYS WHY (ADR §10a) — the route refuses a reasonless one.
      body: JSON.stringify({
        decision,
        stamp,
        ...(decision === 'request_changes' ? { noteMd: 'Needs changes.' } : {}),
      }),
    }),
    { params: Promise.resolve({ id: gateId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const prRow = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
/** The card's ONE approve-to-merge gate — its subject is the CARD, not a pull request. */
const gateFor = async (workItemId: string, state = 'awaiting') =>
  adminDb.approvalGate.findFirstOrThrow({
    where: {
      workItemId,
      subjectId: workItemId,
      kind: 'pull_request_approval',
      state: state as never,
    },
  });

/** Every gate on the card, whatever its kind — the one-gate claim, checkable. */
const gatesOn = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

/** *Approve and merge* — the press, through the same function the item page calls. */
const press = (s: Scenario, gateId: string) =>
  pullRequestMergeService.approveAndMerge(
    { stamp: DECIDED_WITHOUT_A_READER, gateId, source: 'ui' },
    s.ctx,
  );

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  resetHost();
  sent.length = 0;
  signedIn.current = null;
  vi.mocked(mintInstallationToken).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('journey 1 — manual, imported repository, two pull requests: approve → merge → webhook → Done', () => {
  it('green raises ONE gate; the press merges BOTH; only the merge webhook finishes the card', async () => {
    const s = await makeScenario('journey-1@example.com', 'manual');
    const item = await cardWithPrs(s, [11, 12]);

    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);
    expect(await statusOf(item.id)).toBe('in_review');

    // ONE question for the whole set, named by both members.
    const gates = await gatesOn(item.id);
    expect(gates.map((g) => g.kind)).toEqual(['pull_request_approval']);
    expect(gates[0]!.subjectVersion).toBe('moooon/acme#11@sha-a,moooon/acme#12@sha-b');

    const { approval, members } = await press(s, gates[0]!.id);

    expect(approval.gate.state).toBe('approved');
    expect(members.map((m) => m.outcome)).toEqual(['merged', 'merged']);
    for (const number of [11, 12]) {
      expect(await prRow(number)).toMatchObject({
        mergeAuthority: 'gate',
        mergeOutcomeRef: `merge-${number}`,
      });
    }

    // GUARD (b) — ONE STATUS WRITER. Both merges happened and were recorded; the card
    // moved to `approved` because the APPROVAL says so, and `done` still waits for the
    // webhook.
    expect(await statusOf(item.id)).toBe('approved');
    expect(mergeCalls().filter((c) => c.method === 'PUT')).toHaveLength(2);

    await prDelivery('closed', 11, `subtask/${item.identifier}-11`, true);
    expect(await statusOf(item.id)).toBe('approved'); // its other pull request is still open
    await prDelivery('closed', 12, `subtask/${item.identifier}-12`, true);
    expect(await statusOf(item.id)).toBe('done');

    await expectNoMergeResultOnAnyGate();
  });

  it('the REST ROUTE merges BOTH members through the press’s own path, recorded as `api` — MOTIR-5624', async () => {
    const s = await makeScenario('journey-1-route@example.com', 'manual');
    const item = await cardWithPrs(s, [11, 12]);
    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);
    const gate = await gateFor(item.id);

    const res = await decide(gate.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ gate: { id: gate.id, state: 'approved' } });
    expect((res.body.members as Array<{ outcome: string }>).map((m) => m.outcome)).toEqual([
      'merged',
      'merged',
    ]);
    for (const number of [11, 12]) {
      expect(await prRow(number)).toMatchObject({
        mergeAuthority: 'gate',
        mergeOutcomeRef: `merge-${number}`,
      });
    }
    expect(mergeCalls().filter((c) => c.method === 'PUT')).toHaveLength(2);
    // The decision still says HOW it arrived.
    expect(await gateRow(gate.id)).toMatchObject({ state: 'approved', decisionSource: 'api' });

    // …and from here it is journey 1: the approval moved the card, the webhook finishes it.
    expect(await statusOf(item.id)).toBe('approved');
    await prDelivery('closed', 11, `subtask/${item.identifier}-11`, true);
    await prDelivery('closed', 12, `subtask/${item.identifier}-12`, true);
    expect(await statusOf(item.id)).toBe('done');

    await expectNoMergeResultOnAnyGate();
  });

  it('through the ROUTE, a host refusal on one member leaves the approval standing and the other still merges', async () => {
    const s = await makeScenario('journey-1-route-refused@example.com', 'manual');
    const item = await cardWithPrs(s, [11, 12]);
    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);
    const gate = await gateFor(item.id);
    host.merge = (n) =>
      n === 11
        ? { status: 405, body: { message: 'Pull Request is not mergeable' } }
        : { status: 200, body: { merged: true, sha: `merge-${n}` } };
    host.reread = (n) => (n === 11 ? { mergeable_state: 'dirty' } : {});

    const res = await decide(gate.id);

    // A refusal is a MEMBER outcome of a 200, never an error status: the approval committed
    // first, so there is nothing for a status code to report as failed.
    expect(res.status).toBe(200);
    expect(res.body.members).toMatchObject([
      { outcome: 'refused', refusal: { tag: 'MERGE_CONFLICT' } },
      { outcome: 'merged' },
    ]);
    expect(await gateRow(gate.id)).toMatchObject({ state: 'approved', decisionSource: 'api' });
    expect(await prRow(11)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
    expect(await prRow(12)).toMatchObject({ mergeAuthority: 'gate', mergeOutcomeRef: 'merge-12' });
    expect(mergeCalls().filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('request_changes through the ROUTE merges nothing and calls no host', async () => {
    const s = await makeScenario('journey-1-route-changes@example.com', 'manual');
    const item = await cardWithPrs(s, [11, 12]);
    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);
    const gate = await gateFor(item.id);
    host.calls.length = 0;

    const res = await decide(gate.id, 'request_changes');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ gate: { state: 'changes_requested' }, members: [] });
    expect(await gateRow(gate.id)).toMatchObject({
      state: 'changes_requested',
      decisionSource: 'api',
    });
    for (const number of [11, 12]) {
      expect(await prRow(number)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
    }
    expect(mergeCalls()).toEqual([]);
  });
});

describe('journey 2 — the App is chosen by the repository PROVENANCE', () => {
  it('an imported repository mints through user-facing; a hosted one through provisioning', async () => {
    // One press per scenario now, because ONE press merges the whole set: the App
    // choice is a property of the repository, so it is read once per press.
    const imported = await makeScenario('journey-2a@example.com', 'manual');
    const a = await cardWithPrs(imported, [11]);
    await ci('success', 'sha-a', 11);
    await press(imported, (await gateFor(a.id)).id);
    expect(mintInstallationToken).toHaveBeenLastCalledWith(INSTALLATION_ID, 'user-facing');

    // `moooon` becomes the organisation Motir provisions into — a HOSTED repository.
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'moooon');
    const hosted = await makeScenario('journey-2b@example.com', 'manual');
    const b = await cardWithPrs(hosted, [12]);
    await ci('success', 'sha-b', 12);
    await press(hosted, (await gateFor(b.id)).id);
    expect(mintInstallationToken).toHaveBeenLastCalledWith(INSTALLATION_ID, 'provisioning');
  });
});

describe('journey 3 — a base branch with a merge QUEUE is enqueued, and the card waits for the queue', () => {
  it('enqueuePullRequest, no merge call, queue:<id> on the pull request, the card waits for the queue', async () => {
    const s = await makeScenario('journey-3@example.com', 'manual');
    const item = await cardWithPrs(s, [11]);
    host.rules = [{ type: 'merge_queue' }];
    await ci('success', 'sha-a', 11);

    const { members } = await press(s, (await gateFor(item.id)).id);

    expect(members.map((m) => m.outcome)).toEqual(['enqueued']);
    expect(mergeCalls().map((c) => c.method)).toEqual(['POST']);
    expect((await prRow(11)).mergeOutcomeRef).toBe('queue:MQE_1');
    // The APPROVAL moved the card; `done` still waits for the queue's merge webhook.
    expect(await statusOf(item.id)).toBe('approved');
    await expectNoMergeResultOnAnyGate();
  });
});

describe('journey 4 — NOT green raises nothing and merges nothing, in either mode', () => {
  it.each(['manual', 'auto'] as const)(
    '%s: one red pull request — no gate, no job, no host call',
    async (mode) => {
      const s = await makeScenario(`journey-4-${mode}@example.com`, mode);
      const item = await cardWithPrs(s, [11, 12]);
      await ci('success', 'sha-a', 11);
      await ci('failure', 'sha-b', 12);

      expect(await statusOf(item.id)).toBe('implemented');
      expect(await adminDb.approvalGate.count({ where: { workItemId: item.id } })).toBe(0);
      expect(sent.filter((e) => e.name === 'pull-request/auto-merge.requested')).toEqual([]);
      expect(mergeCalls()).toEqual([]);
    },
  );
});

describe('journey 5 — every merge refusal rides its MEMBER and leaves the approval standing', () => {
  const MATRIX = [
    {
      code: 'MERGE_CHECKS_NOT_GREEN',
      status: 409,
      merge: { status: 405, body: { message: 'Required status check "ci" is expected.' } },
      reread: { mergeable_state: 'blocked' },
    },
    {
      code: 'MERGE_CONFLICT',
      status: 409,
      merge: { status: 405, body: { message: 'Pull Request is not mergeable' } },
      reread: { mergeable_state: 'dirty' },
    },
    {
      code: 'MERGE_BRANCH_PROTECTED',
      status: 409,
      merge: { status: 405, body: { message: 'At least 1 approving review is required.' } },
      reread: { mergeable_state: 'blocked' },
    },
    {
      code: 'MERGE_ALREADY_MERGED',
      status: 409,
      merge: { status: 405, body: { message: 'Pull Request is not mergeable' } },
      reread: { merged: true, state: 'closed' },
    },
    {
      code: 'MERGE_APP_PERMISSION_MISSING',
      status: 424,
      merge: { status: 403, headers: { 'x-accepted-github-permissions': 'contents=write' } },
      reread: {},
    },
  ];

  it('the five refusals ride the MEMBER, the approval stands, and a moved head calls no host', async () => {
    const s = await makeScenario('journey-5@example.com', 'manual');
    const item = await cardWithPrs(s, [11]);
    await ci('success', 'sha-a', 11);
    const gate = await gateFor(item.id);

    const armHost = (row: (typeof MATRIX)[number]) => {
      resetHost();
      host.heads[11] = 'sha-a';
      host.merge = () => row.merge;
      host.reread = () => row.reread;
    };

    // ⚠️ A REFUSAL IS A MEMBER'S OUTCOME NOW, NOT A THROWN STATUS. The press commits the
    // approval FIRST, so a host that refuses cannot unwind it: the member reports the
    // refusal and the gate stays `approved` as the record of what was decided.
    //
    // ⚠️ AND SINCE MOTIR-5833 · MOTIR-5834 THE REFUSAL IS RECORDED AND SPENDS THAT
    // APPROVAL (§4 FOURTH AMENDMENT, points 1, 5 and 8). Each row therefore rides its own
    // PRESS on the card's current question: the first on the gate approved here, and each
    // later one on the gate that refusal re-asked — a retry on the SPENT approval is
    // refused `MERGE_REQUEUE_NEEDS_APPROVAL`, which the last arm below asserts.
    armHost(MATRIX[0]!);
    const pressed = await press(s, gate.id);
    expect(pressed.members[0], MATRIX[0]!.code).toMatchObject({
      outcome: 'refused',
      refusal: { tag: MATRIX[0]!.code },
    });

    for (const row of MATRIX.slice(1)) {
      armHost(row);
      const reasked = await gateFor(item.id).catch(() => null);
      // A CAN'T-LAND refusal raises nothing: the card is held at `implemented` and the
      // next arm's press has no question to ride. It is re-armed by a push, which the
      // moved-head arm below exercises, so the loop simply stops there.
      if (!reasked) break;
      const member = await pullRequestMergeService.retryApproveAndMergeMember(
        {
          approvalGateId: reasked.id,
          pullRequestId: (await prRow(11)).id,
          source: 'ui',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        s.ctx,
      );
      expect(member, row.code).toMatchObject({ outcome: 'refused', refusal: { tag: row.code } });
    }

    // The refusals later: every decision still stands as its own record, and nothing was
    // recorded as merged.
    expect((await gateRow(gate.id)).state).toBe('approved');
    expect(await prRow(11)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
    // ⚠️ AND THE SPENT APPROVAL PRESSES NOTHING (MOTIR-5834): the gate that made the
    // first refused press may not make a second one.
    resetHost();
    expect(
      await pullRequestMergeService.retryApproveAndMergeMember(
        {
          approvalGateId: gate.id,
          pullRequestId: (await prRow(11)).id,
          source: 'ui',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        s.ctx,
      ),
    ).toMatchObject({ outcome: 'refused' });
    expect(host.calls).toEqual([]);

    // A head that moved after the gate was approved — recorded straight onto the pull
    // request, so it is the entry point's own check that finds it, with no host call.
    resetHost();
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: (await prRow(11)).id,
        commitSha: 'sha-moved',
        checkName: 'ci',
        conclusion: 'pending',
      },
    });
    const member = await pullRequestMergeService.retryApproveAndMergeMember(
      {
        approvalGateId: gate.id,
        pullRequestId: (await prRow(11)).id,
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );
    // A moved head makes the member stale WHATEVER the approval's state — the entry
    // point's own check, with no host call.
    expect(['no_merge_gate', 'refused']).toContain(member.outcome);
    expect(host.calls).toEqual([]);
    await expectNoMergeResultOnAnyGate();
  });
});

describe('journey 6 — AUTO merges both pull requests after promotion, and writes no gate', () => {
  it('two jobs, two auto_mode records, zero approval_gate rows', async () => {
    const s = await makeScenario('journey-6@example.com', 'auto');
    const item = await cardWithPrs(s, [11, 12]);
    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);
    expect(await statusOf(item.id)).toBe('in_review');

    const jobs = sent.filter((e) => e.name === 'pull-request/auto-merge.requested');
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      const outcome = await new JobTestEngine({
        function: pullRequestAutoMerge,
        events: [{ name: job.name, data: job.data }],
      }).execute();
      expect(outcome.error).toBeUndefined();
    }

    expect(
      [await prRow(11), await prRow(12)].map((r) => [r.mergeAuthority, r.mergeOutcomeRef]),
    ).toEqual([
      ['auto_mode', 'merge-11'],
      ['auto_mode', 'merge-12'],
    ]);
    expect(await adminDb.approvalGate.count()).toBe(0);
  });
});

describe("journey 7 — a push supersedes the CARD's gate, and the next green raises a fresh one", () => {
  it('superseded over the old set, re-raised over the new one — still exactly one gate', async () => {
    const s = await makeScenario('journey-7@example.com', 'manual');
    const item = await cardWithPrs(s, [11, 12]);
    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);
    const raised = await gateFor(item.id);
    expect(raised.subjectVersion).toBe('moooon/acme#11@sha-a,moooon/acme#12@sha-b');

    // ⚠️ THE SET IS THE SUBJECT, so a push to ONE member withdraws the question about
    // ALL of them — there is no longer a sibling gate to leave untouched. That is the
    // point of one gate per card: nobody is asked about half a set.
    await ci(null, 'sha-a2', 11);
    expect((await gateRow(raised.id)).state).toBe('superseded');

    await ci('success', 'sha-a2', 11);
    const reraised = await gateFor(item.id);
    expect(reraised.subjectVersion).toBe('moooon/acme#11@sha-a2,moooon/acme#12@sha-b');
    expect(reraised.id).not.toBe(raised.id);
    // One awaiting question, and one superseded record of the old one.
    expect((await gatesOn(item.id)).map((g) => g.state).sort()).toEqual(['awaiting', 'superseded']);
  });
});

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

/**
 * GUARD (c) — `outcomeRef` KEEPS ITS MEANING. The item page applies a gate's outcome as a
 * STATUS KEY, so no gate is ever decided with a MERGE result in it; a merge's outcome
 * lives on the pull request (`merge_authority` / `merge_outcome_ref`). Asserted after
 * journeys 1, 3 and 5.
 *
 * Since MOTIR-5603 the decided gate is the card's own, and it DOES carry an outcome —
 * `approved`, the status it moved the card to. So the guard asserts the distinction
 * rather than emptiness: a commit sha or a `queue:` reference in there would mean the
 * merge result had leaked into a field the page reads as a status.
 */
async function expectNoMergeResultOnAnyGate(): Promise<void> {
  const decided = await adminDb.approvalGate.findMany({
    where: { state: { in: ['approved', 'changes_requested'] } },
  });
  for (const gate of decided) {
    expect(gate.outcomeRef, gate.id).not.toMatch(/^queue:/);
    expect(gate.outcomeRef ?? 'approved', gate.id).toMatch(/^[a-z_]+$/);
  }
}
