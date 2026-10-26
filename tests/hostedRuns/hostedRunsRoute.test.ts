import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// `POST /api/work-items/[id]/hosted-runs` (Story MOTIR-683 · MOTIR-690) — the
// route Run hosted calls. The compliant-session gate is the one thing stubbed (a
// route test has no cookie jar); the route, the service and every client are the
// shipped path, with `fetch` stubbed at motir-ai, the gateway and GitHub and the
// fleet on the fake orchestrator.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { POST } = await import('@/app/api/work-items/[id]/hosted-runs/route');

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function stubHttp(s: { modelsStatus?: number; mayRun?: boolean; installation?: number } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${AI}/v1/agent-models`) {
        return (s.modelsStatus ?? 200) === 200
          ? json(200, { models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL })
          : json(s.modelsStatus!, {});
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        const mayRun = s.mayRun ?? true;
        return json(200, { balanceCredits: mayRun ? 10 : 0, hasCredits: mayRun, mayRun });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, { key: 'sk-run', runRef: body?.runRef, expiresAt: body?.expiresAt });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        return json(200, { revoked: 1 });
      }
      if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
        if ((s.installation ?? 200) !== 200) return json(s.installation!, {});
        return json(200, {
          id: 42,
          account: { login: 'acme' },
          permissions: { contents: 'write', pull_requests: 'write' },
          suspended_at: null,
          html_url: 'https://github.com/organizations/acme/settings/installations/42',
        });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

let fx: WorkItemFixture;

/** A card created the way the product creates one — in its workflow's initial status. */
function newCard(input: { kind: 'task' | 'story'; title: string; parentId?: string }) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, ...input }, fx.ctx);
}

async function seedRepo(state: 'created' | 'connected'): Promise<void> {
  const owner = state === 'created' ? 'motir-projects' : 'acme';
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: '600001',
      owner,
      name: 'site',
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: 'site',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state,
      position: 'a000',
      githubRepoId: repo.id,
    },
  });
}

function post(key: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`https://app.test/api/work-items/${key}/hosted-runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: key }) },
  );
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  fx = await makeWorkItemFixture();
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_RUN_URL', GATEWAY);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', '222');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  stubHttp();
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

describe('POST /api/work-items/[id]/hosted-runs (AC8)', () => {
  it('201 with the run id for a ready card and an offered model', async () => {
    await seedRepo('created');
    const card = await newCard({ kind: 'task', title: 'a card' });

    const res = await post(card.identifier, { model: MODEL, idempotencyKey: 'k1' });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { dispatchRunId: string; created: boolean };
    expect(body.created).toBe(true);
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: body.dispatchRunId } });
    expect(run.origin).toBe('hosted');
  });

  it('422 hosted_model_not_offered on a model not offered', async () => {
    await seedRepo('created');
    const card = await newCard({ kind: 'task', title: 'a card' });
    const res = await post(card.identifier, { model: 'gpt-9' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('hosted_model_not_offered');
  });

  it('503 hosted_models_unavailable when the list cannot be read', async () => {
    await seedRepo('created');
    const card = await newCard({ kind: 'task', title: 'a card' });
    stubHttp({ modelsStatus: 500 });
    const res = await post(card.identifier, { model: MODEL });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('hosted_models_unavailable');
  });

  it('402 hosted_run_out_of_credits when the pre-flight says no', async () => {
    await seedRepo('created');
    const card = await newCard({ kind: 'task', title: 'a card' });
    stubHttp({ mayRun: false });
    const res = await post(card.identifier, { model: MODEL });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { code: string }).code).toBe('hosted_run_out_of_credits');
  });

  it('409 hosted_repository_not_writable, listing each repository with its reason and fix', async () => {
    await seedRepo('connected');
    const card = await newCard({ kind: 'task', title: 'a card' });
    stubHttp({ installation: 404 });
    const res = await post(card.identifier, { model: MODEL });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; repositories: unknown[] };
    expect(body.code).toBe('hosted_repository_not_writable');
    expect(body.repositories).toEqual([
      expect.objectContaining({ repository: 'acme/site', fix: 'reconnect' }),
    ]);
  });

  it('409 hosted_run_card_not_ready on a card that is not ready', async () => {
    await seedRepo('created');
    const card = await newCard({ kind: 'task', title: 'a card' });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });
    const res = await post(card.identifier, { model: MODEL });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('hosted_run_card_not_ready');
  });

  it('404 across tenants — a card in another workspace', async () => {
    await seedRepo('created');
    const card = await newCard({ kind: 'task', title: 'a card' });
    const other = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: other.ctx });
    const res = await post(card.identifier, { model: MODEL });
    expect(res.status).toBe(404);
  });

  // MOTIR-6994: `model` is optional — without one the SERVICE resolves it from
  // the card's difficulty, so the route forwards no model rather than refusing.
  it('without a model, the service is asked to resolve one', async () => {
    const spy = vi
      .spyOn(hostedRunService, 'start')
      .mockResolvedValueOnce({ dispatchRunId: 'run-1', created: true });
    const res = await post('PROD-1', { idempotencyKey: 'k' });
    expect(res.status).toBe(201);
    expect(spy.mock.calls[0]![0]).not.toHaveProperty('model');
  });

  it('a blank model reads as no model', async () => {
    const spy = vi
      .spyOn(hostedRunService, 'start')
      .mockResolvedValueOnce({ dispatchRunId: 'run-1', created: true });
    await post('PROD-1', { model: '   ' });
    expect(spy.mock.calls[0]![0]).not.toHaveProperty('model');
  });

  it('400 on a model that is not a string', async () => {
    const res = await post('PROD-1', { model: 42 });
    expect(res.status).toBe(400);
  });

  // Coverage top-up (MOTIR-692): the gate's own refusal, a body `req.json()`
  // itself cannot parse, and every error → status branch no scenario above
  // reaches — each named by the typed error `hostedRunService.start` would
  // throw for it, since reproducing every real precondition here would
  // re-test `hostedRunService.start` itself rather than this route's mapping.
  it("an incompliant session is the gate's own response, never reaching the service", async () => {
    const gateResponse = new Response(null, { status: 302 });
    requireCompliantWorkspaceContext.mockResolvedValueOnce({ ok: false, response: gateResponse });
    const res = await POST(
      new Request('https://app.test/api/work-items/PROD-1/hosted-runs', {
        method: 'POST',
        body: JSON.stringify({ model: MODEL }),
      }),
      { params: Promise.resolve({ id: 'PROD-1' }) },
    );
    expect(res).toBe(gateResponse);
  });

  it('a body `req.json()` cannot parse is a 400', async () => {
    const res = await POST(
      new Request('https://app.test/api/work-items/PROD-1/hosted-runs', {
        method: 'POST',
        body: 'not json',
      }),
      { params: Promise.resolve({ id: 'PROD-1' }) },
    );
    expect(res.status).toBe(400);
  });

  it('402 when the CI-credit gate is exhausted', async () => {
    const { CiCreditsExhaustedError } = await import('@/lib/ciMetering/errors');
    vi.spyOn(hostedRunService, 'start').mockRejectedValueOnce(
      new CiCreditsExhaustedError({
        organizationId: 'org1',
        state: 'exhausted',
      } as never),
    );
    const res = await post('PROD-1', { model: MODEL });
    expect(res.status).toBe(402);
  });

  it('503 hosted_run_boot_failed, naming the run that was opened and ended', async () => {
    const { HostedRunBootFailedError } = await import('@/lib/hostedRuns/errors');
    vi.spyOn(hostedRunService, 'start').mockRejectedValueOnce(
      new HostedRunBootFailedError('run1', 'the fleet refused it'),
    );
    const res = await post('PROD-1', { model: MODEL });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { dispatchRunId: string }).dispatchRunId).toBe('run1');
  });

  it('503 hosted_run_unavailable for a git credential, run-key or orchestrator failure', async () => {
    const { RunGitCredentialUnavailableError } = await import('@/lib/hostedRuns/errors');
    vi.spyOn(hostedRunService, 'start').mockRejectedValueOnce(
      new RunGitCredentialUnavailableError('github_unavailable', 'GitHub is down'),
    );
    const res = await post('PROD-1', { model: MODEL });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('hosted_run_unavailable');
  });

  it('403 when the caller can browse the project but not edit it', async () => {
    const { ProjectAccessDeniedError } = await import('@/lib/projects/errors');
    vi.spyOn(hostedRunService, 'start').mockRejectedValueOnce(
      new ProjectAccessDeniedError('proj1', 'edit'),
    );
    const res = await post('PROD-1', { model: MODEL });
    expect(res.status).toBe(403);
  });

  it('an error the service names nothing for is rethrown, not swallowed', async () => {
    vi.spyOn(hostedRunService, 'start').mockRejectedValueOnce(new Error('unexpected'));
    await expect(post('PROD-1', { model: MODEL })).rejects.toThrow('unexpected');
  });
});

// Continue hosted (Story MOTIR-6527 · MOTIR-6792) — `mode: 'continue'`.
describe('POST /api/work-items/[id]/hosted-runs — mode continue', () => {
  async function deadCard(silentMinutes = 7) {
    const card = await newCard({ kind: 'task', title: 'a card whose run died' });
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { status: 'in_progress', assigneeId: fx.ownerId },
    });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'checkout_ready',
          workItemKey: card.identifier,
          disposition: 'running',
          data: { branch: 'subtask/work' },
        },
      ],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - silentMinutes * 60_000) },
    });
    return card;
  }

  it('201 with a hosted continue run for a card whose run died', async () => {
    await seedRepo('created');
    const card = await deadCard();

    const res = await post(card.identifier, {
      model: MODEL,
      idempotencyKey: 'c1',
      mode: 'continue',
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { dispatchRunId: string; created: boolean };
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: body.dispatchRunId } });
    expect(run).toMatchObject({ origin: 'hosted', command: 'continue' });
  });

  it('409 hosted_continue_run_alive, naming the holder, while the run still heartbeats', async () => {
    await seedRepo('created');
    const card = await deadCard(1);

    const res = await post(card.identifier, { model: MODEL, mode: 'continue' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; holder: { id: string } };
    expect(body.code).toBe('hosted_continue_run_alive');
    expect(body.holder.id).toBe(fx.ownerId);
  });

  it('409 hosted_continue_no_dead_run on a card never run', async () => {
    await seedRepo('created');
    const card = await newCard({ kind: 'task', title: 'never run' });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_progress' } });

    const res = await post(card.identifier, { model: MODEL, mode: 'continue' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('hosted_continue_no_dead_run');
  });

  it('400 on a mode that is not run, continue or fix', async () => {
    const res = await post('PROD-1', { model: MODEL, mode: 'resume' });
    expect(res.status).toBe(400);
  });
});

// Fix on the hosted agent (Story MOTIR-1626 · MOTIR-6928) — `mode: 'fix'`.
describe('POST /api/work-items/[id]/hosted-runs — mode fix', () => {
  /** A card In Review, one open green pull request, optionally sent back by the review agent. */
  async function reviewedCard(sentBack: boolean, checks: 'success' | 'failure' = 'success') {
    const card = await newCard({ kind: 'task', title: 'a reviewed card' });
    await setStatus(card.id, checks === 'failure' ? 'implemented' : 'in_review');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/reviewed',
      checks: { Vitest: checks },
    });
    if (sentBack) {
      await adminDb.approvalGate.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: card.id,
          kind: 'agent_review',
          subjectId: card.id,
          subjectVersion: `acme/${repo.name}#${pr.number}@${'c'.repeat(40)}`,
          state: 'changes_requested',
          decidedById: fx.ownerId,
          decidedAt: new Date(),
          decidedByLabel: 'Review agent',
          decisionSource: 'ui',
          decidedUnderAuthority: 'review_agent',
          noteMd: 'Fix the header row.',
        },
      });
    }
    return card;
  }

  it('201 with a hosted fix run for a card a review sent back', async () => {
    const card = await reviewedCard(true);

    const res = await post(card.identifier, { model: MODEL, idempotencyKey: 'f1', mode: 'fix' });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { dispatchRunId: string; created: boolean };
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: body.dispatchRunId } });
    expect(run).toMatchObject({ origin: 'hosted', command: 'fix' });
  });

  it('409 hosted_fix_taken, naming the holder, while a repair is open', async () => {
    const card = await reviewedCard(true);
    const local = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);

    const res = await post(card.identifier, { model: MODEL, mode: 'fix' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      holder: { id: string };
      startedAt: string;
    };
    expect(body.code).toBe('hosted_fix_taken');
    expect(body.holder.id).toBe(fx.ownerId);
    expect(body.startedAt).toBe(local.startedAt);
  });

  it('409 hosted_fix_not_sent_back on a card red for another reason', async () => {
    const card = await reviewedCard(false, 'failure');

    const res = await post(card.identifier, { model: MODEL, mode: 'fix' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'hosted_fix_not_sent_back',
      repairClass: 'ci',
    });
  });

  it('409 hosted_fix_not_repairable with the claim’s own reason', async () => {
    const card = await reviewedCard(false);

    const res = await post(card.identifier, { model: MODEL, mode: 'fix' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'hosted_fix_not_repairable',
      repairRefusal: 'not_failing',
    });
  });

  it('409 names where the repair runs instead, for a child of its run target', async () => {
    const { HostedFixRefusedError } = await import('@/lib/hostedRuns/errors');
    vi.spyOn(hostedRunService, 'start').mockRejectedValueOnce(
      new HostedFixRefusedError('PROD-2', 'not_repairable', {
        repairRefusal: 'repair_on_run_target',
        runTargetKey: 'PROD-1',
      }),
    );
    const res = await post('PROD-2', { model: MODEL, mode: 'fix' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      repairRefusal: 'repair_on_run_target',
      runTargetKey: 'PROD-1',
    });
  });
});
