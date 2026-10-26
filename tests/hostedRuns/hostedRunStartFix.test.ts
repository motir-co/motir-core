import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator, OrchestratorNotConfiguredError } from '@motir/orchestrator';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import {
  HostedFixRefusedError,
  HostedModelNotOfferedError,
  HostedRunCreditsUnavailableError,
  HostedRunNoCapacityError,
  HostedRunOutOfCreditsError,
  HostedRunRepositoryNotWritableError,
} from '@/lib/hostedRuns/errors';
import {
  _resetRunGitBotAuthors,
  mintRunGitCredentials,
  runRepositories,
} from '@/lib/github/runGitCredential';
import { recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { agentRunCapacityService } from '@/lib/services/agentRunCapacityService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { usersService } from '@/lib/services/usersService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workspacesService } from '@/lib/services/workspacesService';
import { REVIEW_AGENT_REVIEWER_NAME } from '@/lib/workItems/fixReason';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { grantPaidAiPlan, stubPaidAiPlan } from '../helpers/paidAiPlan';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// FIX ON THE HOSTED AGENT (Story MOTIR-1626 · MOTIR-6928; `hosted-agent-run.md` §8.6,
// `approval-gates.md` §12.4b) — `hostedRunService.start({ mode: 'fix' })` over the real
// services against real Postgres, the fleet on the fake orchestrator and motir-ai, the
// gateway and GitHub stubbed at their HTTP seam (`fetch`), as `hostedRunStart.test.ts`
// stubs them.
//
// ⚠️ THE ABSENCES ARE THE ASSERTIONS for every refusal: no `fix` run (so no repair lock),
// no run-key mint, no provision. And on every path the card's status and assignee are
// untouched: a repair moves nothing (§8.6).

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const HEAD = 'c'.repeat(40); // the head `deliveredPr` writes its check rows at
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const FINDINGS = [
  '1. `exportCsv` drops the header row when the list is empty.',
  '2. The new route has no tenant check.',
].join('\n');

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  models?: { ids?: string[] };
  mayRun?: boolean | 'unanswerable';
  /** `GET /repos/{owner}/{name}/installation` status, by `owner/name`. Default 200. */
  installation?: Record<string, number>;
}

let calls: Call[] = [];

function stub(s: Stub = {}): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (url === `${AI}/v1/agent-models`) {
        const ids = s.models?.ids ?? [MODEL];
        return json(200, {
          models: ids.map((id) => ({
            id,
            provider: id.startsWith('deepseek') ? 'deepseek' : 'anthropic',
          })),
          default: ids[0] ?? null,
        });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        if (s.mayRun === 'unanswerable') return json(503, { code: 'internal_error' });
        const mayRun = s.mayRun ?? true;
        return json(200, {
          coreOrganizationId: body?.coreOrganizationId,
          balanceCredits: mayRun ? 250 : 0,
          hasCredits: mayRun,
          mayRun,
        });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, {
          key: 'sk-run-key-secret',
          runRef: body?.runRef,
          coreOrganizationId: body?.coreOrganizationId,
          expiresAt: body?.expiresAt,
          lane: 'agent',
        });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        return json(200, { runRef: url.split('/').pop(), revoked: 1 });
      }
      const inst = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        const repo = inst[1] ?? '';
        const status = s.installation?.[repo] ?? 200;
        if (status !== 200) return json(status, {});
        const owner = repo.split('/')[0];
        return json(200, {
          id: 42,
          account: { login: owner },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended_at: null,
          html_url: `https://github.com/organizations/${owner}/settings/installations/42`,
        });
      }
      if (/\/app\/installations\/\d+\/access_tokens$/.test(url) && method === 'POST') {
        return json(201, {
          token: `ghs_run_${calls.length}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.endsWith('/app') && method === 'GET') return json(200, { slug: 'motir-integration' });
      const user = /\/users\/(.+)$/.exec(url);
      if (user && method === 'GET') {
        return json(200, { id: 2002, login: decodeURIComponent(user[1] ?? '') });
      }
      if (/\/installation\/token$/.test(url) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

const mintCalls = () =>
  calls.filter((c) => c.url === `${GATEWAY}/api/motir/run-keys` && c.method === 'POST');

let fx: WorkItemFixture;
let seq = 0;

const pressFix = (
  key: string,
  opts: { ctx?: ServiceContext; idem?: string; model?: string } = {},
) =>
  hostedRunService.start(
    {
      workItemKey: key,
      model: opts.model ?? MODEL,
      idempotencyKey: opts.idem ?? `fix-${++seq}`,
      mode: 'fix',
    },
    opts.ctx ?? fx.ctx,
  );

const fixRuns = (workItemId: string) =>
  adminDb.dispatchRun.findMany({
    where: { command: 'fix', cards: { some: { workItemId } } },
    orderBy: { startedAt: 'asc' },
  });

async function member(name: string): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `${name.toLowerCase().replace(/\W/g, '')}+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** A card at `status` with one open pull request per repository named, each carrying `checks`. */
async function cardWith(
  status: string,
  opts: { checks?: Record<string, 'success' | 'failure'>; repos?: number } = {},
) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: `card ${randomToken(4)}` });
  await setStatus(card.id, status);
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
  const prs = [];
  for (let i = 0; i < (opts.repos ?? 1); i++) {
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await deliveredPr(fx, card.id, repo, {
      headRef: `subtask/${card.identifier}-${i}`,
      checks: opts.checks ?? { Vitest: 'success' },
    });
    prs.push({ repo, pr });
  }
  const version = prs
    .map(({ repo, pr }) => `acme/${repo.name}#${pr.number}@${HEAD}`)
    .sort()
    .join(',');
  return { card, prs, version };
}

/** A decided review refusal on `workItemId` about `subjectVersion`. */
function sentBack(
  workItemId: string,
  subjectVersion: string,
  kind: 'agent_review' | 'pull_request_approval' = 'agent_review',
) {
  const byAgent = kind === 'agent_review';
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      kind,
      subjectId: workItemId,
      subjectVersion,
      state: 'changes_requested',
      decidedById: fx.ownerId,
      decidedAt: new Date('2026-09-29T10:00:00Z'),
      decidedByLabel: byAgent ? 'Review agent' : 'Yue Zhu <yue@example.com>',
      decisionSource: 'ui',
      decidedUnderAuthority: byAgent ? 'review_agent' : 'assignee',
      noteMd: FINDINGS,
    },
  });
}

/** A card In Review a review sent back, over `repos` open green pull requests. */
async function sentBackCard(
  kind: 'agent_review' | 'pull_request_approval' = 'agent_review',
  repos = 1,
) {
  const made = await cardWith('in_review', { repos });
  const gate = await sentBack(made.card.id, made.version, kind);
  return { ...made, gate };
}

async function expectNothingStarted(cardId: string): Promise<void> {
  expect(await fixRuns(cardId)).toEqual([]);
  expect(mintCalls()).toEqual([]);
  expect(fakeOrchestrator.provisioned).toEqual([]);
}

async function expectCardUntouched(cardId: string, status = 'in_review'): Promise<void> {
  const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: cardId } });
  expect(after).toMatchObject({ status, assigneeId: fx.ownerId, implementationSource: null });
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  fx = await makeWorkItemFixture();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_RUN_URL', GATEWAY);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.test/');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', '222');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  stub();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('Fix on the hosted agent — the run it starts', () => {
  it('opens ONE hosted `fix` run as the presser, boots MOTIR_RUN_MODE=fix, and moves nothing', async () => {
    const { card, prs, gate } = await sentBackCard('agent_review');

    const started = await pressFix(card.identifier);

    expect(started.created).toBe(true);
    const runs = await adminDb.dispatchRun.findMany({ where: { workspaceId: fx.workspaceId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: started.dispatchRunId,
      command: 'fix',
      origin: 'hosted',
      agent: 'opencode',
      model: MODEL,
      status: 'running',
      createdById: fx.ownerId,
    });
    const legs = await adminDb.dispatchRunCard.findMany({
      where: { dispatchRunId: started.dispatchRunId },
    });
    expect(legs.map((l) => l.workItemKey)).toEqual([card.identifier]);

    // The run key and the run credential are minted for THIS run, and one container boots.
    expect(mintCalls()).toHaveLength(1);
    expect(mintCalls()[0]!.body).toMatchObject({ runRef: started.dispatchRunId });
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: started.dispatchRunId } })).toBe(
      1,
    );
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env).toMatchObject({
      MOTIR_DISPATCH_RUN_ID: started.dispatchRunId,
      MOTIR_WORK_ITEM_KEY: card.identifier,
      MOTIR_RUN_MODE: 'fix',
    });

    // No status, no assignee, no provenance stamp — and the refusal is not decided away.
    await expectCardUntouched(card.id);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).state).toBe(
      'changes_requested',
    );

    // ONE `run_opened`, written by the claim — what the container adopts.
    const events = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: started.dispatchRunId },
    });
    expect(events.map((e) => e.kind)).toEqual(['run_opened']);
    expect(events[0]!.data).toMatchObject({
      command: 'fix',
      key: card.identifier,
      origin: 'hosted',
      model: MODEL,
      repairClass: 'review',
      pullRequests: [
        {
          repo: `acme/${prs[0]!.repo.name}`,
          number: prs[0]!.pr.number,
          branch: prs[0]!.pr.headRef,
          headRef: prs[0]!.pr.headRef,
          headSha: HEAD,
        },
      ],
      findings: {
        gate: 'agent_review',
        gateId: gate.id,
        findingsMd: FINDINGS,
        reviewerName: REVIEW_AGENT_REVIEWER_NAME,
        decidedByLabel: 'Review agent',
        decidedUnderAuthority: 'review_agent',
        decidedAt: '2026-09-29T10:00:00.000Z',
      },
    });

    // The run's OWN read says what it repairs (MOTIR-6929) — what the container adopting
    // it reads back instead of claiming.
    const run = await dispatchRunService.getRun(started.dispatchRunId, fx.ctx);
    expect(run.continues).toBeNull();
    expect(run.repair).toEqual({
      repairClass: 'review',
      // A hosted run records no agent session to resume (MOTIR-9043's `resume` field).
      resume: null,
      title: card.title,
      pullRequests: [
        {
          repo: `acme/${prs[0]!.repo.name}`,
          number: prs[0]!.pr.number,
          url: `https://github.com/acme/${prs[0]!.repo.name}/pull/${prs[0]!.pr.number}`,
          branch: prs[0]!.pr.headRef,
          baseRef: prs[0]!.pr.baseRef,
          headSha: HEAD,
        },
      ],
      findings: {
        gate: 'agent_review',
        gateId: gate.id,
        subjectVersion: expect.any(String),
        findingsMd: FINDINGS,
        reviewerName: REVIEW_AGENT_REVIEWER_NAME,
        decidedByLabel: 'Review agent',
        decidedUnderAuthority: 'review_agent',
        decidedAt: '2026-09-29T10:00:00.000Z',
      },
    });
  });

  it('a PERSON’s Request changes: the findings name the person and their authority', async () => {
    const { card } = await sentBackCard('pull_request_approval');

    const started = await pressFix(card.identifier);

    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: started.dispatchRunId, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({
      repairClass: 'review',
      findings: {
        gate: 'pull_request_approval',
        findingsMd: FINDINGS,
        reviewerName: fx.owner.name,
        decidedByLabel: 'Yue Zhu <yue@example.com>',
        decidedUnderAuthority: 'assignee',
      },
    });
  });

  it('two repositories: every pull request recorded on its own branch, and the git credential writes each', async () => {
    const { card, prs } = await sentBackCard('agent_review', 2);

    const started = await pressFix(card.identifier);

    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: started.dispatchRunId, kind: 'run_opened' },
    });
    const recorded = (opened.data as { pullRequests: { repo: string; branch: string }[] })
      .pullRequests;
    expect(recorded.map((p) => [p.repo, p.branch]).sort()).toEqual(
      prs.map(({ repo, pr }) => [`acme/${repo.name}`, pr.headRef]).sort(),
    );

    // The run's repository set is its pull requests' repositories, with the build grant.
    const repos = (await runRepositories(started.dispatchRunId)).map((r) => r.repository).sort();
    expect(repos).toEqual(prs.map(({ repo }) => `acme/${repo.name}`).sort());
    const entries = await mintRunGitCredentials(started.dispatchRunId);
    expect(entries.map((e) => e.repository).sort()).toEqual(repos);
    const tokenMints = calls.filter((c) => c.url.endsWith('/access_tokens'));
    expect(tokenMints).toHaveLength(1);
    expect(tokenMints[0]!.body).toMatchObject({
      permissions: { contents: 'write', pull_requests: 'write' },
    });
  });

  it('a repository the card targets but no pull request lives in is not in the repair’s set', async () => {
    const { card, prs } = await sentBackCard('agent_review');
    const bystander = await connectRepairRepo(fx, `docs-${randomToken(4)}`);
    const row = await adminDb.projectRepo.findFirstOrThrow({
      where: { githubRepoId: bystander.id },
    });
    await adminDb.workItemRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: card.id,
        projectRepoId: row.id,
        position: 0,
      },
    });
    // Its App could not write it — and the repair is not refused for it.
    stub({ installation: { [`acme/${bystander.name}`]: 404 } });

    const started = await pressFix(card.identifier);

    expect((await runRepositories(started.dispatchRunId)).map((r) => r.repository)).toEqual([
      `acme/${prs[0]!.repo.name}`,
    ]);
  });

  it('a pull request in no repository of the project: refused no_repository, opening nothing', async () => {
    const { card, prs } = await sentBackCard();
    await adminDb.projectRepo.deleteMany({ where: { githubRepoId: prs[0]!.repo.id } });

    await expect(pressFix(card.identifier)).rejects.toMatchObject({
      code: 'run_git_credential_unavailable',
      reason: 'no_repository',
    });
    await expectNothingStarted(card.id);
  });

  it('the same key twice answers the first run, created: false, and boots nothing new', async () => {
    const { card } = await sentBackCard();

    const first = await pressFix(card.identifier, { idem: 'same-press' });
    const second = await pressFix(card.identifier, { idem: 'same-press' });

    expect(second).toEqual({ dispatchRunId: first.dispatchRunId, created: false });
    expect(await fixRuns(card.id)).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  // MOTIR-7312: a double-click whose second press passes the short-circuit, then
  // previews only AFTER the first press's repair claim committed. The open repair
  // the preview finds is the press's own, so it answers that run — never `taken`.
  it('a second press whose preview runs AFTER the first press committed answers its run, never "taken"', async () => {
    const { card } = await sentBackCard();

    let secondReachedPreview!: () => void;
    const secondAtPreview = new Promise<void>((resolve) => (secondReachedPreview = resolve));
    let firstClaimed!: () => void;
    const firstCommitted = new Promise<void>((resolve) => (firstClaimed = resolve));

    const preview = workItemRepairService.previewHostedRepair.bind(workItemRepairService);
    let previews = 0;
    vi.spyOn(workItemRepairService, 'previewHostedRepair').mockImplementation(async (...args) => {
      if (++previews === 2) {
        secondReachedPreview();
        await firstCommitted;
      }
      return preview(...args);
    });
    const claim = workItemRepairService.claimRepair.bind(workItemRepairService);
    vi.spyOn(workItemRepairService, 'claimRepair').mockImplementation(async (...args) => {
      // Held until the second press is past the short-circuit, or it would replay there.
      await secondAtPreview;
      const answered = await claim(...args);
      firstClaimed();
      return answered;
    });

    const [a, b] = await Promise.all([
      pressFix(card.identifier, { idem: 'double-click' }),
      pressFix(card.identifier, { idem: 'double-click' }),
    ]);

    expect(previews).toBe(2);
    expect(a.dispatchRunId).toBe(b.dispatchRunId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await fixRuns(card.id)).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

describe('Fix on the hosted agent — who it is for', () => {
  it('a red build (class `ci`) is refused not_sent_back, opening nothing', async () => {
    const { card } = await cardWith('implemented', { checks: { Vitest: 'failure' } });

    const refused = await pressFix(card.identifier).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(HostedFixRefusedError);
    expect(refused).toMatchObject({
      reason: 'not_sent_back',
      code: 'hosted_fix_not_sent_back',
      repairClass: 'ci',
    });
    await expectNothingStarted(card.id);
    await expectCardUntouched(card.id, 'implemented');
  });

  it('an acceptance sent back with Re-run (class `acceptance_rerun`) is refused not_sent_back', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Exports list' });
    await setStatus(story.id, 'in_review');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    await deliveredPr(fx, story.id, repo, {
      headRef: 'parent/exports',
      checks: { Vitest: 'success' },
    });
    const receipt = await adminDb.acceptanceEvidence.create({
      data: { workspaceId: fx.workspaceId, workItemId: story.id, status: 'changes_requested' },
    });
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'acceptance_result',
        subjectId: receipt.id,
        subjectVersion: HEAD,
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date('2026-09-26T10:00:00Z'),
        decidedByLabel: 'Yue Zhu',
        decisionSource: 'ui',
        decidedUnderAuthority: 'assignee',
        noteMd: 'Re-run it.',
        refusalVerdict: 'revise',
      },
    });

    await expect(pressFix(story.identifier)).rejects.toMatchObject({
      reason: 'not_sent_back',
      repairClass: 'acceptance_rerun',
    });
    await expectNothingStarted(story.id);
  });

  it('a card that is not To fix is refused not_repairable with the claim’s own reason', async () => {
    const waiting = await cardWith('in_review'); // green, nobody sent it back
    await expect(pressFix(waiting.card.identifier)).rejects.toMatchObject({
      reason: 'not_repairable',
      code: 'hosted_fix_not_repairable',
      repairRefusal: 'not_failing',
    });

    const fresh = await createTestWorkItem(fx, { kind: 'task', title: 'never built' });
    await expect(pressFix(fresh.identifier)).rejects.toMatchObject({
      reason: 'not_repairable',
      repairRefusal: 'not_implemented',
    });

    await expectNothingStarted(waiting.card.id);
    await expectNothingStarted(fresh.id);
  });
});

describe('Fix on the hosted agent — one repair at a time, local or hosted', () => {
  it('a local `motir fix` holds it: refused taken, naming the holder and when it started', async () => {
    const { card } = await sentBackCard();
    const rival = await member('Terminal Fixer');
    const local = await workItemRepairService.claimRepair(fx.projectId, card.identifier, rival.ctx);
    expect(local.outcome).toBe('claimed');

    const refused = await pressFix(card.identifier).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(HostedFixRefusedError);
    expect(refused).toMatchObject({
      reason: 'taken',
      code: 'hosted_fix_taken',
      holder: { id: rival.user.id, name: 'Terminal Fixer' },
      startedAt: local.startedAt,
    });
    // Still the ONE (local) repair run; nothing minted or booted.
    const runs = await fixRuns(card.id);
    expect(runs.map((r) => [r.id, r.origin])).toEqual([[local.runId, 'local']]);
    expect(mintCalls()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    // A LOCAL repair's run records no decision for a container to adopt (MOTIR-6929).
    expect((await dispatchRunService.getRun(local.runId!, rival.ctx)).repair).toBeNull();
  });

  it('the presser’s OWN local repair is not adopted — the press is refused taken', async () => {
    const { card } = await sentBackCard();
    await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);

    await expect(pressFix(card.identifier)).rejects.toMatchObject({
      reason: 'taken',
      holder: { id: fx.ownerId },
    });
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('a hosted repair holds it: a second press is refused taken, and a local claim answers taken', async () => {
    const { card } = await sentBackCard();
    const started = await pressFix(card.identifier);
    const rival = await member('Second Presser');

    await expect(pressFix(card.identifier, { ctx: rival.ctx })).rejects.toMatchObject({
      reason: 'taken',
      holder: { id: fx.ownerId },
    });
    const local = await workItemRepairService.claimRepair(fx.projectId, card.identifier, rival.ctx);
    expect(local).toMatchObject({
      outcome: 'taken',
      runId: started.dispatchRunId,
      holder: { id: fx.ownerId },
    });
    expect(await fixRuns(card.id)).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('the PRESSER’s own local `motir fix` does not adopt their hosted repair — it answers taken', async () => {
    // Two agents on one pull request is exactly what the one-repair lock exists to prevent,
    // whoever started the container (§8.6). Only a LOCAL run its own operator re-claims is
    // a resume (`mine`).
    const { card } = await sentBackCard();
    const started = await pressFix(card.identifier);
    const local = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);
    expect(local).toMatchObject({
      outcome: 'taken',
      runId: started.dispatchRunId,
      holder: { id: fx.ownerId },
      pullRequests: [],
    });
    expect(await fixRuns(card.id)).toHaveLength(1);
  });
});

describe('Fix on the hosted agent — every pre-flight refuses before the lock', () => {
  const cases: Array<{
    name: string;
    arrange: (repoName: string) => void;
    error: unknown;
  }> = [
    {
      name: 'the CI allowance exhausted',
      arrange: () => {
        vi.spyOn(ciAllowanceService, 'assertDispatchAllowed').mockRejectedValueOnce(
          new CiCreditsExhaustedError({ organizationId: 'org', state: 'exhausted' } as never),
        );
      },
      error: CiCreditsExhaustedError,
    },
    {
      name: 'hosted_model_not_offered',
      arrange: () => stub({ models: { ids: ['claude-sonnet-5'] } }),
      error: HostedModelNotOfferedError,
    },
    {
      name: 'out of credits',
      arrange: () => stub({ mayRun: false }),
      error: HostedRunOutOfCreditsError,
    },
    {
      name: 'credits unavailable',
      arrange: () => stub({ mayRun: 'unanswerable' }),
      error: HostedRunCreditsUnavailableError,
    },
    {
      name: 'a repository not writable',
      arrange: (repoName) => stub({ installation: { [`acme/${repoName}`]: 404 } }),
      error: HostedRunRepositoryNotWritableError,
    },
    {
      name: 'the fleet unconfigured',
      arrange: () => {
        vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
        vi.stubEnv('MOTIR_HOSTED_AGENT_IMAGE', '');
      },
      error: OrchestratorNotConfiguredError,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: no run, no lock, and the next press after the fix succeeds`, async () => {
      const { card, prs } = await sentBackCard();
      c.arrange(prs[0]!.repo.name);

      await expect(pressFix(card.identifier)).rejects.toBeInstanceOf(c.error);
      await expectNothingStarted(card.id);
      await expectCardUntouched(card.id);

      // The cause fixed, the next press is accepted: nothing was left holding the lock.
      vi.restoreAllMocks();
      vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
      stub();
      stubPaidAiPlan();
      const started = await pressFix(card.identifier);
      expect(started.created).toBe(true);
    });
  }
});

describe('Fix on the hosted agent — how it ends moves no card', () => {
  for (const outcome of ['failed', 'cancelled', 'backstop'] as const) {
    it(`ended ${outcome}: the card stays To fix changes_requested (never run_died), and a new press is accepted`, async () => {
      const { card } = await sentBackCard();
      const started = await pressFix(card.identifier);

      const end = await hostedRunService.endHostedRun(started.dispatchRunId, outcome, 'it ended');

      expect(end.closed).toBe(true);
      await expectCardUntouched(card.id);
      const reason = await withWorkspaceContext(
        { userId: fx.ownerId, workspaceId: fx.workspaceId },
        (tx) => recomputeWorkItemFixReason(card.id, tx),
      );
      expect(reason.fixReason).toBe('changes_requested');

      const again = await pressFix(card.identifier);
      expect(again.created).toBe(true);
      expect(again.dispatchRunId).not.toBe(started.dispatchRunId);
    });
  }
});

// ── MOTIR-7208: a DeepSeek offered entry — the env is <provider>/<id>, the key BARE ──
const DEEPSEEK = 'deepseek-v4-pro';

describe('Fix on the hosted agent with a DeepSeek model (MOTIR-7208)', () => {
  it('boots MOTIR_MODEL=deepseek/<id> and mints the key for the bare id', async () => {
    const { card } = await sentBackCard('agent_review');
    stub({ models: { ids: [MODEL, DEEPSEEK] } });

    const started = await pressFix(card.identifier, { model: DEEPSEEK });

    expect(started.created).toBe(true);
    expect(fakeOrchestrator.specs[0]!.env).toMatchObject({
      MOTIR_MODEL: `deepseek/${DEEPSEEK}`,
      MOTIR_RUN_MODE: 'fix',
    });
    expect(mintCalls()[0]!.body!['models']).toEqual([DEEPSEEK]);
  });
});

// ── NO AGENT-RUN CAPACITY (Story MOTIR-9541 · MOTIR-9628) ───────────────────
describe('Fix on the hosted agent — a model with no agent-run capacity', () => {
  it('refused before the repair claim: no run, no lock, and the next press succeeds', async () => {
    const { card } = await sentBackCard();
    const verdict = vi
      .spyOn(agentRunCapacityService, 'verdictFor')
      .mockResolvedValue({ verdict: 'no_capacity', reason: 'agent_share_exhausted' });

    const refused = await pressFix(card.identifier).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(HostedRunNoCapacityError);
    expect(refused).toMatchObject({ model: MODEL, reason: 'agent_share_exhausted' });
    expect(verdict).toHaveBeenCalledWith({ id: MODEL, provider: 'anthropic' });
    await expectNothingStarted(card.id);
    await expectCardUntouched(card.id);
    expect(calls.filter((c) => c.url === `${AI}/v1/credits/agent-run-check`)).toEqual([]);

    // No repair claim was taken: the person (or a local agent) can still take it.
    vi.restoreAllMocks();
    const started = await pressFix(card.identifier);
    expect(started.created).toBe(true);
  });
});
