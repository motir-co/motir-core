import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { derivePrCiState } from '@/lib/github/prCiState';
import { presentWorkItemDetail, workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { classOfQueueExit, judgeQueueExit } from '@/lib/mergeQueue/queueExit';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import {
  classifyDeliveries,
  collectDeliveries,
  recomputeWorkItemCiState,
  standingQueueFailures,
} from '@/lib/services/deliveryVerdict';
import { deliverySetIsGreen, deliveryStateForPromotion } from '@/lib/workItems/deliverySet';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { ciVerdict, renderFixPrompt, watchAndFixCi } from '../../packages/cli/src/ciWatch';
import { toWorkItemDetail } from '../../packages/cli/src/adapters/reads';

/** The exit as the recorder STORES it for a manual card whose queue run named no
 *  check (§4 SIXTH AMENDMENT): a `CI_TIMEOUT` with no known check is neutral. */
const asStored = (reason: string) => ({
  rawReason: reason,
  disposition: judgeQueueExit({ rawReason: reason, failingCheckConclusion: null }).disposition,
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE STORY GATE — AN EJECTED CARD READS RED (Story MOTIR-5628 · MOTIR-5722)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Each code child proved its own half: the fold (MOTIR-5717), the repair claim
// (MOTIR-5719), the CLI (MOTIR-5720) and the Development block (MOTIR-5721). The one
// question they all answer — *is this pull request still stuck in the queue?* — is
// only safe if they answer it TOGETHER, so this file drives the real writers into the
// real consumers on a real Postgres, through `githubWebhookService.handleEvent` with
// the captured `dequeued` delivery:
//
//   1. exit → badge, and the promotion refuses at the same head;
//   2. Queue again → clear (manual, auto), and a host refusal brings the red back;
//   3. push → running → green → In Review with exactly ONE awaiting gate;
//   4. the fold ⟺ the promotion, over seeded cards, own verdict × exit shape;
//   5. claim ⟸ exit, and the page's repair view;
//   6. the v1 resource → the CLI verdict, and the CLI loop over the real presenter;
//   7. the guards coverage cannot see: one predicate, the pill untouched, tenancy.
//
// The host is `mergeChangeRequest`, stubbed — the one call that leaves the process.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ejected-red';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const REPO_ID = '7301';
const REPOSITORY = { id: Number(REPO_ID) };
const KIND = 'pull_request_approval';
const github = getGitProvider('github') as Required<GitProvider>;

const captured = JSON.parse(
  readFileSync(
    join(process.cwd(), 'tests/fixtures/github/merge-queue/dequeued-ci-failure.json'),
    'utf8',
  ),
).payload as Record<string, unknown>;

let guid = 0;
function eject(number: number, headSha: string, reason = 'CI_FAILURE') {
  const pr = structuredClone(captured['pull_request']) as Record<string, unknown>;
  pr['number'] = number;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: headSha };
  return githubWebhookService.handleEvent(
    'pull_request',
    {
      ...captured,
      reason,
      number,
      installation: INSTALLATION,
      repository: REPOSITORY,
      pull_request: pr,
    },
    `red-gate-${++guid}`,
  );
}

const check = (number: number, headSha: string, conclusion: string | null, name = 'CI complete') =>
  githubWebhookService.handleEvent('check_run', {
    action: conclusion === null ? 'created' : 'completed',
    installation: INSTALLATION,
    repository: REPOSITORY,
    check_run: {
      head_sha: headSha,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
      name,
      check_suite: { id: 1, head_branch: null },
      pull_requests: [{ number }],
    },
  });

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'manual' | 'auto') {
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
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_ID,
        owner: 'moooon',
        name: 'web',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

async function card(s: Scenario, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Throttle the public API' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-${number}`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'web',
    number,
    headRef,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: REPOSITORY,
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: 'A change',
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  return item;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const ciStateOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).ciState;
const prRow = (number: number) =>
  adminDb.githubPullRequest.findFirstOrThrow({ where: { number }, include: { checkRuns: true } });
const awaiting = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind: KIND, state: 'awaiting' } });
const stubHost = (answer: MergeChangeRequestResult) =>
  vi.spyOn(github, 'mergeChangeRequest').mockResolvedValue(answer);

/** A manual card over web#7, green, approved and enqueued by the REAL press, then EJECTED. */
async function ejectedManual(email: string, reason = 'CI_FAILURE') {
  const s = await makeScenario(email, 'manual');
  const item = await card(s, 7);
  await check(7, 'sha-a', 'success');
  const [gate] = await awaiting(item.id);
  stubHost({ outcome: 'enqueued', entryId: 'MQE_7' });
  await pullRequestMergeService.approveAndMerge(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, source: 'ui' },
    s.ctx,
  );
  expect(await statusOf(item.id)).toBe('approved');
  vi.restoreAllMocks();
  await eject(7, 'sha-a', reason);
  // §4 FOURTH AMENDMENT, point 2 (MOTIR-5805): settled by the reason's CLASS — back to
  // review with ONE fresh gate, or held at `implemented` where the commits cannot land.
  expect(await statusOf(item.id)).toBe(
    classOfQueueExit(asStored(reason)) === 'cant_land' ? 'implemented' : 'in_review',
  );
  return { s, item, gateId: gate!.id };
}

const queueAgain = async (s: Scenario, gateId: string, number: number) =>
  pullRequestMergeService.retryApproveAndMergeMember(
    {
      approvalGateId: gateId,
      pullRequestId: (await prRow(number)).id,
      noteMd: null,
      source: 'ui',
      stamp: DECIDED_WITHOUT_A_READER,
    },
    s.ctx,
  );

/** The v1 resource for the card, exactly as the route presents and validates it. */
async function v1Body(s: Scenario, identifier: string) {
  const detail = await workItemsService.getIssueDetail(s.project.id, identifier, s.ctx);
  const deliveries = await workItemsService.listDeliverySet(detail.item.id, s.ctx);
  return workItemDetailSchema.parse(presentWorkItemDetail(detail, 0, {}, deliveries));
}

/** What the CLI's watch loop reads off that resource — through the CLI's own adapter. */
async function cliDeliveries(s: Scenario, identifier: string) {
  return toWorkItemDetail((await v1Body(s, identifier)) as never).deliveries;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('1 · exit → badge, and the promotion refuses', () => {
  it('a CI_FAILURE ejection turns the card red; a further green check at the SAME head neither clears it nor promotes', async () => {
    const { item } = await ejectedManual('exit-badge@example.com');
    expect(await ciStateOf(item.id)).toBe('failing');

    await check(7, 'sha-a', 'success', 'Lint');

    expect(await ciStateOf(item.id)).toBe('failing');
    // A queue FAILURE is CAN'T-LAND since the FIFTH AMENDMENT (MOTIR-6594): held at
    // Implemented, and a green at the SAME head asks nothing at all.
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toHaveLength(0);
    // Guard (a): the pull request's own verdict — the pill — is untouched.
    expect(derivePrCiState((await prRow(7)).checkRuns)).toBe('passing');
  });
});

describe('2 · Queue again → clear', () => {
  // Queue again on a manual FAILURE exit is retired (MOTIR-5802; §4 FOURTH AMENDMENT,
  // point 4): the refused press stamps nothing, so the red stands.
  it('manual: Queue again on a failure exit is refused, and the red stands', async () => {
    const { s, item, gateId } = await ejectedManual('requeue-manual@example.com');

    const host = stubHost({ outcome: 'enqueued', entryId: 'MQE_7b' });
    expect(await queueAgain(s, gateId, 7)).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(host).not.toHaveBeenCalled();
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('manual: APPROVING the re-asked gate re-queues and clears the red (MOTIR-5805)', async () => {
    // A failure that still RE-ASKS: branch protection (MOTIR-6594 made a queue failure
    // can't-land, so it raises no gate to approve).
    const { s, item } = await ejectedManual('reask-clears@example.com', 'BRANCH_PROTECTIONS');
    const [reasked] = await awaiting(item.id);
    stubHost({ outcome: 'enqueued', entryId: 'MQE_7r' });

    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: reasked!.id, source: 'ui' },
      s.ctx,
    );

    expect(await statusOf(item.id)).toBe('approved');
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('auto: a person’s Queue again clears the red', async () => {
    const s = await makeScenario('requeue-auto@example.com', 'auto');
    const item = await card(s, 21);
    await check(21, 'sha-auto', 'success');
    await adminDb.githubPullRequest.update({
      where: { id: (await prRow(21)).id },
      data: { mergeAuthority: 'auto_mode', mergeOutcomeRef: 'queue:MQE_21' },
    });
    await eject(21, 'sha-auto');
    expect(await ciStateOf(item.id)).toBe('failing');

    await pullRequestMergeService.requeueAutoMember(
      { workItemId: item.id, pullRequestId: (await prRow(21)).id },
      s.ctx,
    );

    expect(await ciStateOf(item.id)).toBe('passing');
  });
});

describe('3 · push → running → green → ONE gate', () => {
  it('a pending check at a new head reads running; its green promotes to In Review with exactly one awaiting gate', async () => {
    const { item } = await ejectedManual('push@example.com');

    await check(7, 'sha-b', null);
    expect(await ciStateOf(item.id)).toBe('running');

    await check(7, 'sha-b', 'success');
    expect(await ciStateOf(item.id)).toBe('passing');
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);
  });
});

describe('4 · the fold ⟺ the promotion, over seeded cards', () => {
  // The badge promises that `passing` is exactly "the promotion would move this card".
  // The promotion's verdict is `everyDeliveryIsGreen && !heldByQueueFailure`
  // (`ciPromotion.isPromotable`, private); it is composed here from the SAME exported
  // pieces it calls, so both halves read one seeded card each.
  const HEAD = 'c'.repeat(40);
  const OWN = ['failing', 'running', 'passing', 'null-can-report', 'null-cannot-report'] as const;
  const EXITS = [
    'none',
    'failure@head',
    'failure@old-head',
    'failure-requeued',
    'neutral@head',
  ] as const;

  it.each(OWN.flatMap((own) => EXITS.map((exit) => [own, exit] as const)))(
    'own %s × exit %s',
    async (own, exit) => {
      const fx = await makeWorkItemFixture();
      const item = await createTestWorkItem(fx, { kind: 'task', title: `${own} × ${exit}` });
      await setStatus(item.id, 'implemented');
      const repo = await connectRepairRepo(fx, `web-${own}-${exit}`.replace(/[^a-z0-9-]/gi, ''));
      const checks =
        own === 'failing'
          ? { Vitest: 'failure' as const }
          : own === 'running'
            ? { Vitest: 'pending' as const }
            : own === 'passing'
              ? { Vitest: 'success' as const }
              : undefined;
      const pr = await deliveredPr(fx, item.id, repo, {
        headRef: 'subtask/x',
        ...(checks ? { checks } : {}),
      });
      if (own === 'null-can-report') {
        // The repository HAS reported a check, on another pull request.
        const other = await deliveredPr(
          fx,
          (await createTestWorkItem(fx, { kind: 'task', title: 'o' })).id,
          repo,
          {
            headRef: 'subtask/other',
            checks: { Vitest: 'success' },
          },
        );
        void other;
      }
      if (own === 'null-cannot-report') {
        // A WATCHED merge with no check at all: the repository has no CI.
        await adminDb.githubPullRequest.create({
          data: {
            repoId: repo.id,
            number: 9000 + Math.floor(Math.random() * 999),
            state: 'closed',
            merged: true,
            mergedAt: new Date(Date.now() + 60_000),
            headRef: 'subtask/merged',
            baseRef: 'main',
            title: 'merged without CI',
          },
        });
      }
      if (exit !== 'none') {
        await adminDb.githubPullRequestQueueExit.create({
          data: {
            pullRequestId: pr.id,
            deliveryId: `seed-${own}-${exit}`,
            rawReason: exit === 'neutral@head' ? 'MANUAL' : 'CI_FAILURE',
            disposition: exit === 'neutral@head' ? 'neutral' : 'failure',
            headSha: exit === 'failure@old-head' ? 'a'.repeat(40) : HEAD,
            exitedAt: new Date('2026-09-18T10:00:00.000Z'),
            requeuedAt: exit === 'failure-requeued' ? new Date() : null,
          },
        });
      }

      const { folded, promotable } = await withWorkspaceContext(fx.ctx, async (tx) => {
        const folded = await recomputeWorkItemCiState(item.id, tx);
        const target = { id: item.id, sessionBranch: null };
        const members = await classifyDeliveries(target, tx);
        const green = deliverySetIsGreen(
          members.map((m) => deliveryStateForPromotion(m.state, m.cannotReport)),
        );
        const held =
          (await standingQueueFailures(await collectDeliveries(target, tx), tx)).size > 0;
        return { folded, promotable: green && !held };
      });

      expect(folded === 'passing').toBe(promotable);
      if (exit === 'failure@head' && own !== 'null-can-report' && own !== 'null-cannot-report') {
        expect(folded).toBe('failing');
      }
    },
  );
});

describe('5 · claim ⟸ exit, and the page’s repair view', () => {
  it('the ejected card is claimed with the exit’s reason and check; the view offers it; a refused Queue again changes neither', async () => {
    const { s, item, gateId } = await ejectedManual('claim@example.com');
    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: (await prRow(7)).id },
      data: {
        failingCheckName: 'Merge queue / e2e',
        failingCheckUrl: 'https://github.com/moooon/web/runs/9',
      },
    });

    const view = await workItemRepairService.getRepairView(item.id, s.ctx);
    expect(view).toMatchObject({
      state: 'offer',
      failing: [{ number: 7, ci: 'passing', queueExit: { rawReason: 'CI_FAILURE' } }],
    });

    const claim = await workItemRepairService.claimRepair(s.project.id, item.identifier, s.ctx);
    expect(claim.outcome).toBe('claimed');
    expect(claim.pullRequests[0]?.queueExit).toMatchObject({
      rawReason: 'CI_FAILURE',
      failingCheckName: 'Merge queue / e2e',
      failingCheckUrl: 'https://github.com/moooon/web/runs/9',
    });
    await dispatchRunService.close(claim.runId!, { stopReason: 'completed' }, s.ctx);

    stubHost({ outcome: 'enqueued', entryId: 'MQE_7c' });
    // Queue again no longer re-queues a failure exit (MOTIR-5802), so the card stays where
    // the ejection left it and the repair view still offers `motir fix`.
    expect(await queueAgain(s, gateId, 7)).toMatchObject({ outcome: 'refused' });
    // Held at Implemented, where the FIFTH AMENDMENT (MOTIR-6594) puts a queue failure.
    expect(await statusOf(item.id)).toBe('implemented');
    expect((await workItemRepairService.getRepairView(item.id, s.ctx)).state).toBe('offer');
  });
});

describe('6 · the v1 resource → the CLI', () => {
  it('the published deliveries read RED through the CLI’s adapter and verdict, and GREEN once the exit is re-queued', async () => {
    const { s, item } = await ejectedManual('v1-cli@example.com', 'BRANCH_PROTECTIONS');
    expect(ciVerdict(await cliDeliveries(s, item.identifier))).toBe('red');

    // The re-queue stamp is what lifts the red (MOTIR-5717). A manual re-asking failure is
    // re-queued by approving the re-asked gate (MOTIR-5805), never by Queue again
    // (MOTIR-5802).
    const [reasked] = await awaiting(item.id);
    stubHost({ outcome: 'enqueued', entryId: 'MQE_7d' });
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: reasked!.id, source: 'ui' },
      s.ctx,
    );
    expect(ciVerdict(await cliDeliveries(s, item.identifier))).toBe('green');
  });

  it('the loop over the REAL presenter: nothing pushed ends after ONE attempt; a push ends green', async () => {
    const { s, item } = await ejectedManual('loop@example.com', 'MERGE_CONFLICT');
    const ejected = await cliDeliveries(s, item.identifier);
    const prompt = renderFixPrompt({
      key: item.identifier,
      title: null,
      failing: ejected!,
      attempt: 1,
    });
    expect(prompt).toContain('Why it left the merge queue');
    expect(prompt).toContain('Merge `origin/main` into the branch, resolve the conflicts');

    const serve = (sets: unknown[]) => {
      let i = 0;
      return {
        getWorkItem: async () => ({ deliveries: sets[Math.min(i++, sets.length - 1)] }) as never,
      };
    };
    const quiet = { report: () => {}, wait: async () => {}, key: item.identifier };

    let fixes = 0;
    const nothing = await watchAndFixCi({
      ...quiet,
      client: serve([ejected]),
      fix: async () => ((fixes += 1), { ok: true }),
    });
    expect(nothing).toMatchObject({ kind: 'fix_failed', attempts: 1 });
    expect(fixes).toBe(1);

    // The agent pushed: a pending check at a new head, then its green.
    await check(7, 'sha-fix', null);
    const running = await cliDeliveries(s, item.identifier);
    await check(7, 'sha-fix', 'success');
    const passed = await cliDeliveries(s, item.identifier);
    fixes = 0;
    const green = await watchAndFixCi({
      ...quiet,
      client: serve([ejected, running, passed]),
      fix: async () => ((fixes += 1), { ok: true }),
    });
    expect(green).toEqual({ kind: 'green', attempts: 1 });
  });
});

describe('7 · the guards coverage cannot see', () => {
  it('ONE predicate: `requeuedAt` is read by the rule and the repository, never by the fold or the claim', () => {
    const src = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
    expect(src('lib/workItems/deliverySet.ts')).toContain('requeuedAt');
    expect(src('lib/repositories/githubPullRequestQueueExitRepository.ts')).toContain('requeuedAt');
    for (const path of [
      'lib/services/workItemRepairService.ts',
      'lib/services/deliveryVerdict.ts',
      'lib/services/ciPromotion.ts',
    ]) {
      expect(src(path), path).not.toMatch(/requeuedAt\s*[!=]==/);
    }
  });

  it('TENANCY: an exit in workspace A never turns workspace B red — fold, claim or presenter', async () => {
    const a = await makeWorkItemFixture({ name: 'A' });
    const b = await makeWorkItemFixture({ name: 'B' });
    const seed = async (fx: typeof a) => {
      const item = await createTestWorkItem(fx, { kind: 'task', title: 'x' });
      await setStatus(item.id, 'implemented');
      const repo = await connectRepairRepo(fx, 'web');
      const pr = await deliveredPr(fx, item.id, repo, {
        headRef: 'subtask/x',
        checks: { Vitest: 'success' },
      });
      return { item, pr };
    };
    const inA = await seed(a);
    const inB = await seed(b);
    await adminDb.githubPullRequestQueueExit.create({
      data: {
        pullRequestId: inA.pr.id,
        deliveryId: 'tenancy-a',
        rawReason: 'CI_FAILURE',
        disposition: 'failure',
        headSha: 'c'.repeat(40),
        exitedAt: new Date(),
      },
    });

    const foldA = await withWorkspaceContext(a.ctx, (tx) =>
      recomputeWorkItemCiState(inA.item.id, tx),
    );
    const foldB = await withWorkspaceContext(b.ctx, (tx) =>
      recomputeWorkItemCiState(inB.item.id, tx),
    );
    expect(foldA).toBe('failing');
    expect(foldB).toBe('passing');
    expect(
      (await workItemRepairService.claimRepair(b.projectId, inB.item.identifier, b.ctx)).reason,
    ).toBe('not_failing');
    expect((await workItemsService.listDeliverySet(inB.item.id, b.ctx))[0]?.queueExit).toBeNull();
  });
});
