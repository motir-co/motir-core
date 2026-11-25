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

import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { db } from '@/lib/db';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import {
  MergeOutcomeProvider,
  rowKey,
  type RowMergeOutcome,
} from '@/components/github/MergeOutcomeSlot';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import enMessages from '@/messages/en.json';
import {
  ApprovalGateNotAuthorisedError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { projectsService } from '@/lib/services/projectsService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// THE APPROVE-AND-MERGE STORY, ACROSS ITS SEAMS (Story MOTIR-4909 · MOTIR-5486, §2 and §3) —
// real Postgres and the real webhook service, CI reports and the merge webhook, with GitHub
// stubbed only at `fetch` and the App credential at `appAuth`: the seam MOTIR-4882's own
// journey (`tests/integration/mergeStoryJourney.test.ts`) stubs, never above the press
// service. Each child's suite mocks its neighbours; this is the one place the chain runs whole:
//
//   the whole set turns green → ONE question is raised → a person presses Approve and merge →
//   the approval commits, then each pull request merges or joins its queue →
//   the merge webhook, and nothing else, finishes the card.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-approve-and-merge-journey';
const REPO_PROVIDER_ID = '994';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const APPROVAL = 'pull_request_approval' as const;

// ── the stubbed host ───────────────────────────────────────────────────────────

interface Host {
  heads: Record<number, string>;
  /** The base branch's rules, answered IN ORDER per rules read — `[{ type: 'merge_queue' }]`
   *  queues that merge. Past the end, no rules. */
  rules: unknown[][];
  merge: (n: number) => { status: number; body?: unknown };
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
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status });
      const pull = url.match(/\/repos\/moooon\/acme\/pulls\/(\d+)(\/merge)?$/);
      if (url.endsWith('/repos/moooon/acme') && method === 'GET') {
        return json(200, { allow_squash_merge: true });
      }
      if (url.includes('/rules/branches/')) {
        host.calls.push({ method, url });
        return json(200, host.rules.shift() ?? []);
      }
      if (url.endsWith('/graphql')) {
        host.calls.push({ method, url });
        return json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } } });
      }
      if (pull && pull[2] && method === 'PUT') {
        host.calls.push({ method, url });
        const answer = host.merge(Number(pull[1]));
        return json(answer.status, answer.body ?? {});
      }
      if (pull && !pull[2]) {
        const n = Number(pull[1]);
        const count = (reads.get(n) ?? 0) + 1;
        reads.set(n, count);
        return json(200, {
          node_id: `PR_${n}`,
          merged: false,
          state: 'open',
          // A head nobody has reported yet is one the host does not name: the link door asks
          // the host about the pull request it links (MOTIR-12094), and a made-up head would be
          // stored as the one CI must report at.
          head: host.heads[n] ? { sha: host.heads[n] } : {},
          base: { ref: 'main' },
          ...(count > 1 ? host.reread(n) : {}),
        });
      }
      return json(404, {});
    }),
  );
}

const mergeCalls = () => host.calls.filter((c) => c.method === 'PUT' || c.url.endsWith('/graphql'));

// ── the scenario ───────────────────────────────────────────────────────────────

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
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: 'manual' } });
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
    { projectId: s.project.id, kind: 'task', title: 'Approve and merge, end to end' },
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

const mergedWebhook = (identifier: string, number: number) =>
  prDelivery('closed', number, `subtask/${identifier}-${number}`, true);

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const prRow = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
const approvalGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: APPROVAL },
    orderBy: { createdAt: 'asc' },
  });
const awaitingApproval = async (workItemId: string) =>
  (await approvalGates(workItemId)).filter((g) => g.state === 'awaiting');
/** Every gate on the card, whatever its kind — MOTIR-5613 asserts there is only ever the
 *  one, so a per-pull-request gate would show up here. */
const allGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

/** A card whose two pull requests are green, holding its ONE approve-and-merge gate. */
async function greenCard(email: string) {
  const s = await makeScenario(email);
  const item = await cardWithPrs(s, [11, 12]);
  await ci('success', 'sha-a', 11);
  await ci('success', 'sha-b', 12);
  const [gate, ...more] = await awaitingApproval(item.id);
  expect(more).toEqual([]);
  return { s, item, gate: gate! };
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  resetHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('§2 seam 1 — green → raise → press → approved', () => {
  it('the set turning green raises ONE gate over both heads; the press approves it and moves the card to approved', async () => {
    const { s, item, gate } = await greenCard('seam-1@example.com');
    expect(await statusOf(item.id)).toBe('in_review');
    expect(gate.subjectVersion).toBe('moooon/acme#11@sha-a,moooon/acme#12@sha-b');

    const { approval, members } = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      s.ctx,
    );

    expect(approval.gate.state).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    expect(members.map((m) => m.outcome)).toEqual(['merged', 'merged']);
  });
});

describe('§2 seam 2 — press → merged → webhook → done', () => {
  it('the card reaches done through the merge webhook, never through a gate write', async () => {
    const { s, item, gate } = await greenCard('seam-2@example.com');
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      s.ctx,
    );
    expect(mergeCalls().filter((c) => c.method === 'PUT')).toHaveLength(2);
    // Both merged on the host, and the card has NOT moved past approved: no gate writes done.
    expect(await statusOf(item.id)).toBe('approved');

    await mergedWebhook(item.identifier, 11);
    expect(await statusOf(item.id)).toBe('approved'); // its other pull request is still open
    await mergedWebhook(item.identifier, 12);
    expect(await statusOf(item.id)).toBe('done');

    // The approval's outcome is the status it wrote; the merges' live on the pull requests
    // — and there is no second gate anywhere on the card (MOTIR-5613).
    expect((await approvalGates(item.id))[0]!.outcomeRef).toBe('approved');
    expect((await allGates(item.id)).map((g) => g.kind)).toEqual([APPROVAL]);
    for (const n of [11, 12]) {
      expect((await prRow(n)).mergeAuthority).toBe('gate');
      expect((await prRow(n)).mergeOutcomeRef).not.toBeNull();
    }
  });
});

describe('§2 seam 3 — press → enqueued → approved → webhook → done', () => {
  it('the queued member keeps the card approved until the merge webhook lands it', async () => {
    const { s, item, gate } = await greenCard('seam-3@example.com');
    // #11's base branch has no rules; #12's requires a merge queue.
    host.rules = [[], [{ type: 'merge_queue' }]];

    const { members } = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      s.ctx,
    );

    expect(members.map((m) => m.outcome)).toEqual(['merged', 'enqueued']);
    // The queue entry is recorded on the PULL REQUEST, and no gate is decided by the
    // enqueue (`approval-gates.md` §8's SECOND AMENDMENT, decisions 4 and 6).
    expect((await allGates(item.id)).map((g) => g.kind)).toEqual([APPROVAL]);
    expect((await prRow(12)).mergeAuthority).toBe('gate');
    expect((await prRow(12)).mergeOutcomeRef).toBe('queue:MQE_1');
    expect(await statusOf(item.id)).toBe('approved');
    expect(
      (
        await pullRequestMergeService.listApprovalMembers(
          { workItemId: item.id, approvalGateId: gate.id },
          s.ctx,
        )
      ).map((m) => m.queued),
    ).toEqual([false, true]);

    await mergedWebhook(item.identifier, 11);
    expect(await statusOf(item.id)).toBe('approved');
    await mergedWebhook(item.identifier, 12);
    expect(await statusOf(item.id)).toBe('done');
  });
});

describe('§2 seam 4 — one refused', () => {
  // ⚠️ REWRITTEN AGAINST THE FOURTH AMENDMENT (MOTIR-5833 · MOTIR-5834; point 2). The
  // decision is immutable and still reads `approved`; the CARD does not stay there. The
  // host's 405 is a CONFLICT, which is `cant_land` — the approval is spent, the card
  // falls back to `implemented`, and nothing is asked again, because no yes can land
  // these commits. `motir fix` is the way forward.
  it('the DECISION stays approved, the card falls back to implemented, and nothing is asked again', async () => {
    const { s, item, gate } = await greenCard('seam-4@example.com');
    host.merge = (n) =>
      n === 12
        ? { status: 405, body: { message: 'Pull Request is not mergeable' } }
        : { status: 200, body: { merged: true, sha: `merge-${n}` } };
    host.reread = (n) => (n === 12 ? { mergeable_state: 'dirty' } : {});

    const { members } = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      s.ctx,
    );

    expect(members[1]).toMatchObject({ outcome: 'refused', refusal: { tag: 'MERGE_CONFLICT' } });
    const approval = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    expect(approval.state).toBe('approved');
    expect(await statusOf(item.id)).toBe('implemented');
    // The refused member has no outcome — and no verb either, because the commits cannot
    // land as they stand — and the merged one carries its own. ONE gate throughout: a
    // `cant_land` outcome raises none, so there is nothing new to hold a decision.
    expect(await prRow(12)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
    expect(await prRow(11)).toMatchObject({ mergeAuthority: 'gate' });
    expect((await allGates(item.id)).map((g) => [g.kind, g.state])).toEqual([
      [APPROVAL, 'approved'],
    ]);
  });
});

describe('§2 seam 5 — withdrawn by a push', () => {
  it('a CI event at a new head supersedes the gate; the next all-green verdict raises a fresh one naming the new commit', async () => {
    const { item, gate } = await greenCard('seam-5@example.com');

    await ci(null, 'sha-a2', 11);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).state).toBe(
      'superseded',
    );
    expect(await awaitingApproval(item.id)).toEqual([]);
    expect(await statusOf(item.id)).toBe('in_review');

    await ci('success', 'sha-a2', 11);
    const [fresh] = await awaitingApproval(item.id);
    expect(fresh?.subjectVersion).toBe('moooon/acme#11@sha-a2,moooon/acme#12@sha-b');
  });
});

describe('§3 races', () => {
  it('two green events for the two members, driven concurrently, leave exactly ONE gate and no error', async () => {
    const s = await makeScenario('race-raise@example.com');
    const item = await cardWithPrs(s, [11, 12]);
    // Both heads already carry a green row, so EACH event, on its own, sees an all-green set.
    for (const [n, sha] of [
      [11, 'sha-a'],
      [12, 'sha-b'],
    ] as const) {
      host.heads[n] = sha;
      await adminDb.githubCheckRun.create({
        data: {
          pullRequestId: (await prRow(n)).id,
          commitSha: sha,
          checkName: 'ci',
          conclusion: 'success',
        },
      });
    }

    const settled = await Promise.allSettled([
      ci('success', 'sha-a', 11),
      ci('success', 'sha-b', 12),
    ]);

    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await awaitingApproval(item.id)).toHaveLength(1);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a press racing a supersede ends in exactly ONE of the two legitimate outcomes', async () => {
    const { s, item, gate } = await greenCard('race-press@example.com');

    const [press] = await Promise.allSettled([
      pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
        s.ctx,
      ),
      ci(null, 'sha-a2', 11),
    ]);

    const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });
    if (press.status === 'fulfilled') {
      // The press won the row lock: approved, and the push found nothing awaiting to withdraw.
      expect(row.state).toBe('approved');
      expect(await statusOf(item.id)).toBe('approved');
    } else {
      // The push won: withdrawn, and the press was refused with the door's own error.
      expect(press.reason).toBeInstanceOf(ApprovalGateSupersededError);
      expect(row.state).toBe('superseded');
      expect(row.decidedById).toBeNull();
      expect(await statusOf(item.id)).toBe('in_review');
    }
    // Never both: no approval gate row reads decided AND withdrawn, and nothing new awaits.
    expect(await awaitingApproval(item.id)).toEqual([]);
  });
});

describe('§3 access', () => {
  async function plainMember(workspaceId: string) {
    const user = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: user.id, workspaceId, workspaceRole: 'member' },
    });
    return user;
  }

  it('the REPORTER of a card with an assignee cannot decide it, and the press is refused before any merge', async () => {
    const { s, item, gate } = await greenCard('access-reporter@example.com');
    const reporter = await plainMember(s.workspace.id);
    const assignee = await plainMember(s.workspace.id);
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { reporterId: reporter.id, assigneeId: assignee.id },
    });
    const asReporter = { userId: reporter.id, workspaceId: s.workspace.id };

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: APPROVAL },
      asReporter,
    );
    expect(read.canDecide).toBe(false);
    await expect(
      pullRequestMergeService.approveAndMerge(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
        asReporter,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);
    expect(mergeCalls()).toEqual([]);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).state).toBe(
      'awaiting',
    );
  });

  it('an actor holding approval:decide_any — the workspace owner — may press a card routed to somebody else', async () => {
    const { s, item, gate } = await greenCard('access-admin@example.com');
    const assignee = await plainMember(s.workspace.id);
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: assignee.id } });

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: APPROVAL },
      s.ctx,
    );
    expect(read.canDecide).toBe(true);
    const { approval } = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, source: 'ui' },
      s.ctx,
    );
    expect(approval.gate.state).toBe('approved');
    expect(approval.gate.decidedUnderAuthority).toBe('admin');
  });
});

describe('§4 the row after the press — Merged once, whichever lands first (Bug MOTIR-12232)', () => {
  // The press returns its outcome into the frame's CLIENT state and the page re-reads
  // (`router.refresh()`); GitHub's `pull_request` closed delivery may be processed before or
  // after that re-read. The re-read is the real Development read (`listLinkedPullRequests`),
  // and the row is rendered from it inside the outcome the frame holds after the press.
  const PR_STATE = enMessages.github.development.prState;
  const OUTCOME = enMessages.approvalGate.pullRequestApproval.outcome;

  /** The Development block the re-read draws, inside the frame's press outcome for #11. */
  function drawRow(rows: LinkedPullRequestDto[], outcome: RowMergeOutcome): string {
    const value = new Map([[rowKey('moooon/acme', 11), outcome]]);
    const block = createElement(DevelopmentSectionBody, {
      pullRequests: rows,
      itemIdentifier: 'ACME-1',
    });
    const provider: ComponentProps<typeof MergeOutcomeProvider> = { value, children: block };
    const intl: ComponentProps<typeof NextIntlClientProvider> = {
      locale: 'en',
      messages: enMessages,
      children: createElement(MergeOutcomeProvider, provider),
    };
    return renderToStaticMarkup(createElement(NextIntlClientProvider, intl));
  }
  /** How many pills read exactly `label` — a pill is a glyph, then its label. */
  const pills = (html: string, label: string) => html.split(`</svg>${label}</span>`).length - 1;

  async function pressedCard(email: string) {
    const s = await makeScenario(email);
    const item = await cardWithPrs(s, [11]);
    await ci('success', 'sha-a', 11);
    const [gate] = await awaitingApproval(item.id);
    const { members } = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, source: 'ui' },
      s.ctx,
    );
    return { s, item, outcome: members[0]!.outcome };
  }

  it('the re-read BEFORE any merge delivery draws Merged once and no Open; the delivery, twice, changes nothing', async () => {
    const { s, item, outcome } = await pressedCard('row-merged@example.com');
    expect(outcome).toBe('merged');
    // No merge delivery has been processed: the row's own columns still say open.
    expect(await prRow(11)).toMatchObject({ state: 'open', merged: false });

    const before = await workItemsService.listLinkedPullRequests(item.id, s.ctx);
    expect(before.map((pr) => pr.state)).toEqual(['merged']);
    const drawn = drawRow(before, { kind: 'merged' });
    expect(pills(drawn, PR_STATE.merged)).toBe(1);
    expect(pills(drawn, PR_STATE.open)).toBe(0);

    // GitHub's closed delivery lands after the re-read — and is redelivered.
    await mergedWebhook(item.identifier, 11);
    await mergedWebhook(item.identifier, 11);
    expect(await prRow(11)).toMatchObject({ state: 'closed', merged: true });
    expect(await statusOf(item.id)).toBe('done');
    const after = await workItemsService.listLinkedPullRequests(item.id, s.ctx);
    expect(after).toEqual(before);
    expect(drawRow(after, { kind: 'merged' })).toBe(drawn);
  });

  it('an enqueued press still draws Open with the Queued pill', async () => {
    host.rules = [[{ type: 'merge_queue' }]];
    const { s, item, outcome } = await pressedCard('row-queued@example.com');
    expect(outcome).toBe('enqueued');

    const rows = await workItemsService.listLinkedPullRequests(item.id, s.ctx);
    expect(rows.map((pr) => pr.state)).toEqual(['open']);
    const drawn = drawRow(rows, { kind: 'queued' });
    expect(pills(drawn, PR_STATE.open)).toBe(1);
    expect(pills(drawn, OUTCOME.queued)).toBe(1);
    expect(pills(drawn, PR_STATE.merged)).toBe(0);
  });
});
