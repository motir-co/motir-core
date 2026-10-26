import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { ApprovalGateKind, type WorkItem } from '@/generated/prisma/client';
import { isRegisteredGateKind } from '@/lib/approvalGates/registry';
import { RUN_HOLDING_GATE_KINDS } from '@/lib/dispatchRuns/heldGates';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { db } from '@/lib/db';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { shaFor } from '../helpers/commitShaFixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../helpers/jobs';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';
import { setProjectAccess } from '@/tests/helpers/projectAccess';
import { homePageItems } from '../helpers/homePage';

// THE STORY GATE for a run that stops at a gate (Story MOTIR-7701 · MOTIR-7714), on a
// real Postgres, through the real services.
//
// Each sibling proved its own link with the others held still: the gated close and its
// held-gate rows (MOTIR-7703), the stored column (MOTIR-7707), the continue claim on a
// gated run (MOTIR-7708), the resume job (MOTIR-7710), the tab and the marker's reads
// (MOTIR-7712 / 7713). What only this tier sees is a RUN travelling the whole chain:
// it closes `gated` naming its gates, its cards land on To resume and leave In progress,
// a person approves through one of the deciding doors, the job starts exactly one
// hosted continue as the person who dispatched the run, the continue claim takes the
// run over on its own branch, and the entry leaves.
//
// ⚠️ ONE BOUNDARY IS FAKE, AND IT IS THE CONTAINER. `gateResume.test.ts` stubs
// `hostedRunService.start` whole; here the REAL start runs — the access check, the
// model settle, the continue preview, every pre-flight, the continue claim, the run-key
// mint — and only the boot lands on `fakeOrchestrator` (the fleet's own test double),
// with motir-ai, the gateway and GitHub answered at their HTTP seam exactly as
// `tests/hostedRuns/hostedRunStart.test.ts` answers them. So each pre-flight refusal in
// (f) is the real refusal, raised by the real check, and recorded by the real job.
//
// The job queue is CAPTURED, and each captured `run/gate-resume.requested` is handed to
// the job's own handler — the call a worker makes.
//
// The CLI drain's unit cases ship with MOTIR-7704; the browser journey is MOTIR-7715.

const MODEL = 'claude-sonnet-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { manualWorkGateService } = await import('@/lib/services/manualWorkGateService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { dispatchRunService } = await import('@/lib/services/dispatchRunService');
const { dispatchRunSweepService } = await import('@/lib/services/dispatchRunSweepService');
const { homeService } = await import('@/lib/services/homeService');
const { workItemContinueService } = await import('@/lib/services/workItemContinueService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { resumeRunDetailService } = await import('@/lib/services/resumeRunDetailService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { gateResume } = await import('@/lib/jobs/definitions/gateResume');
const { runStartWorkItemRun, runReportAction, runCloseWorkItemRun } =
  await import('@/lib/mcp/tools/workItemRun');

// ── The HTTP seam: motir-ai, the gateway and GitHub ─────────────────────────────

interface Stub {
  models?: string[];
  mayRun?: boolean;
  /** `GET /repos/{owner}/{name}/installation` status, by `owner/name`. Default 200. */
  installation?: Record<string, number>;
}

function stub(s: Stub = {}): void {
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
        const ids = s.models ?? [MODEL];
        return json(200, {
          models: ids.map((id) => ({ id, provider: 'anthropic' })),
          default: ids[0] ?? null,
        });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
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
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

let fx: WorkItemFixture;
let events: CapturedJobEvent[];
let repoSeq = 0;

grantPaidAiPlan();

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  fx = await makeWorkItemFixture();
  ({ events } = captureJobEvents());
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
  await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
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

// ── Fixtures ────────────────────────────────────────────────────────────────────

/** A project repository with a realized GitHub repository behind it. */
async function seedRepo(opts: {
  state: 'created' | 'connected';
  owner: string;
  name: string;
}): Promise<string> {
  repoSeq += 1;
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${opts.owner}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${opts.owner}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: opts.owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: String(900_000 + repoSeq),
      owner: opts.owner,
      name: opts.name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: opts.name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: opts.state,
      position: `a${String(repoSeq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
  return row.id;
}

/** The person who dispatched the hosted run — a member other than the approver. */
async function dispatcher(): Promise<{ id: string; ctx: ServiceContext }> {
  const user = await createTestUser({
    email: `mara-${Math.random().toString(36).slice(2, 8)}@example.com`,
    name: 'Mara S.',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { id: user.id, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

type CardExtra = {
  parentId?: string;
  kind?: 'story' | 'subtask';
  type?: 'manual' | 'choice';
  descriptionMd?: string;
};

/** A card created the way the product creates one, then In Progress and the owner's. */
async function card(title: string, extra: CardExtra = {}): Promise<WorkItem> {
  const created = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: extra.kind ?? 'subtask',
      title,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
      ...(extra.type ? { type: extra.type, executor: 'human' as const } : {}),
      ...(extra.descriptionMd ? { descriptionMd: extra.descriptionMd } : {}),
    },
    fx.ctx,
  );
  // A choice card is raised In Review by its own create; leave it where its gate put it.
  return adminDb.workItem.update({
    where: { id: created.id },
    data: { assigneeId: fx.ownerId, ...(extra.type === 'choice' ? {} : { status: 'in_progress' }) },
  });
}

/** Publish a design result on `design` — with design approval on, this ASKS the question. */
async function publish(design: WorkItem, label: string): Promise<void> {
  const pathname = `${designPrefix(fx.workspaceId, design.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, design.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  await ensureWorkWaitsOn(design.id, fx);
  await designEvidenceService.recordFromPathnames(
    {
      workItemId: design.id,
      assets: [
        { kind: 'mock', sourcePath: `design/work-items/${label}.mock.html`, pathname },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: notePathname,
        },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
}

const SESSION_BRANCH = 'motir/auto-20261007-0900';
const AGENT_BRANCH = 'story/billing-export';

/**
 * A story with a design child, a code child blocked by it, and a child that already
 * landed. Its HOSTED scope run (opened as a hosted start opens it, by `dispatcherCtx`)
 * integrated one leg onto the session branch and stopped at the design's gate.
 */
async function hostedStory(
  dispatcherCtx: ServiceContext,
  opts: { extraLegs?: (parent: WorkItem) => Promise<WorkItem[]> } = {},
) {
  const parent = await card('Quota settings', { kind: 'story' });
  const design = await card('Quota settings page — design', { parentId: parent.id });
  const landed = await card('Quota API', { parentId: parent.id });
  const code = await card('Quota settings page', { parentId: parent.id });
  await workItemsService.linkWorkItems(
    { fromId: code.id, toId: design.id, kind: 'is_blocked_by' },
    fx.ctx,
  );
  const extra = opts.extraLegs ? await opts.extraLegs(parent) : [];
  await publish(design, 'v1');
  const legs = [landed, design, code, ...extra];
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run_scope',
      origin: 'hosted',
      agent: 'opencode',
      model: MODEL,
      reportedBy: 'cli',
      scopeKey: parent.identifier,
      cards: legs.map((leg) => ({ key: leg.identifier, disposition: 'queued' as const })),
    },
    dispatcherCtx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'card_settled',
        workItemKey: landed.identifier,
        disposition: 'integrated',
        sessionBranch: SESSION_BRANCH,
      },
    ],
    dispatcherCtx,
  );
  await adminDb.workItem.update({ where: { id: landed.id }, data: { status: 'implemented' } });
  await dispatchRunService.close(run.id, { stopReason: 'gated' }, dispatcherCtx);
  return { parent, design, landed, code, extra, runId: run.id };
}

const hctx = (userId: string = fx.ownerId) => ({
  userId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
});

const stateOf = async (id: string) => {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return { resumeState: row.resumeState, resumeRunId: row.resumeRunId, fixReason: row.fixReason };
};

const gateOn = (item: WorkItem, kind: ApprovalGateKind) =>
  adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: item.id, kind, state: 'awaiting' },
    orderBy: { createdAt: 'desc' },
  });

const approveThroughDecide = (gateId: string, extra: Record<string, unknown> = {}) =>
  approvalGatesService.decide(
    {
      gateId,
      decision: 'approve',
      source: 'ui',
      stamp: DECIDED_WITHOUT_A_READER,
      ...extra,
    } as Parameters<typeof approvalGatesService.decide>[0],
    fx.ctx,
  );

const resumeAsks = () => events.filter((e) => e.name === 'run/gate-resume.requested');

/** Hand every captured resume event to the JOB'S OWN handler, as a worker would. */
async function drainResumeJobs(): Promise<number> {
  const pending = resumeAsks();
  for (const event of pending) events.splice(events.indexOf(event), 1);
  for (const event of pending) {
    const outcome = await new JobTestEngine({ function: gateResume, events: [event] }).execute();
    if (outcome.error) throw outcome.error;
  }
  return pending.length;
}

const continues = () =>
  adminDb.dispatchRun.findMany({
    where: { workspaceId: fx.workspaceId, command: 'continue' },
  });

const toResumeIds = async (userId?: string) =>
  (await homeService.listToResume(hctx(userId))).items.map((r) => r.id);
const toFixIds = async (userId?: string) =>
  (await homeService.listToFix(hctx(userId))).items.map((r) => r.id);
const inProgressIds = async (userId?: string) =>
  homePageItems(await homeService.listInProgress(hctx(userId))).map((r) => r.id);

/**
 * GUARD 1 — `resumeState` and a run's death are never both on one card. A card the
 * story's writers left waiting has no `run_died`, and no card is listed on both To
 * resume and To fix. Called after every seam below, so a writer that lets a died run
 * keep its column (or a gated run read as dead) fails the seam it happens in.
 */
async function expectResumeAndFixDisjoint(): Promise<void> {
  const rows = await adminDb.workItem.findMany({
    where: { workspaceId: fx.workspaceId, resumeState: { not: null } },
    select: { identifier: true, fixReason: true },
  });
  for (const row of rows) {
    expect(row.fixReason, `${row.identifier} holds resumeState AND fixReason`).toBeNull();
  }
  const toFix = new Set(await toFixIds());
  const both = (await toResumeIds()).filter((id) => toFix.has(id));
  expect(both, 'listed on To resume AND To fix').toEqual([]);
}

// ── (a) + (d) · an agent-reported LOCAL run ─────────────────────────────────────

describe('(a) a gated close through the agent door names its gates and moves its cards to To resume', () => {
  async function agentRunStory() {
    const parent = await card('Billing export', { kind: 'story' });
    const design = await card('Billing export — design', { parentId: parent.id });
    const code = await card('Billing export', { parentId: parent.id });
    await workItemsService.linkWorkItems(
      { fromId: code.id, toId: design.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    const started = (await runStartWorkItemRun(
      { key: parent.identifier, harness: 'Claude Code', model: MODEL },
      fx.ctx,
    )) as unknown as { structuredContent: { runId: string; outcome: string } };
    expect(started.structuredContent.outcome).toBe('started');
    const runId = started.structuredContent.runId;
    // The agent integrated nothing yet but cut its session branch on the first leg it
    // settled: the branch a `motir continue` takes over.
    const reported = (await runReportAction(
      {
        key: code.identifier,
        action: 'Cut the session branch',
        events: [{ kind: 'checkout_ready', data: { branch: AGENT_BRANCH } }],
      },
      fx.ctx,
    )) as unknown as { structuredContent: { accepted: number; refused: unknown[] } };
    expect(reported.structuredContent).toMatchObject({ accepted: 2, refused: [] });
    await publish(design, 'v1');
    return { parent, design, code, runId };
  }

  it('close_work_item_run `gated` → its held-gate rows → waiting_on_gate → ONE To resume entry, off In progress and To fix', async () => {
    const { parent, design, code, runId } = await agentRunStory();
    expect(await inProgressIds()).toEqual(expect.arrayContaining([parent.id, code.id]));

    const closed = (await runCloseWorkItemRun(
      { key: parent.identifier, runId, outcome: 'gated' },
      fx.ctx,
    )) as unknown as {
      isError?: boolean;
      structuredContent: { stopReason: string; status: string };
    };
    expect(closed.isError).toBeFalsy();
    expect(closed.structuredContent).toMatchObject({ status: 'succeeded', stopReason: 'gated' });

    const designGate = await gateOn(design, 'design_result');
    const held = await adminDb.dispatchRunHeldGate.findMany({ where: { dispatchRunId: runId } });
    expect(held.map((h) => ({ gateId: h.gateId, workItemId: h.workItemId, kind: h.kind }))).toEqual(
      [{ gateId: designGate.id, workItemId: design.id, kind: 'design_result' }],
    );
    for (const id of [parent.id, design.id, code.id]) {
      expect(await stateOf(id)).toEqual({
        resumeState: 'waiting_on_gate',
        resumeRunId: runId,
        fixReason: null,
      });
    }

    const toResume = await homeService.listToResume(hctx());
    expect(toResume.items).toHaveLength(1);
    expect(toResume.items[0]).toMatchObject({ id: parent.id, resumeRunId: runId });
    expect(toResume.items[0]!.resumeRun).toMatchObject({
      ranWhere: 'runbook',
      gates: [{ gateId: designGate.id, kind: 'design_result', state: 'awaiting' }],
    });
    const inProgress = await inProgressIds();
    const toFix = await toFixIds();
    for (const id of [parent.id, design.id, code.id]) {
      expect(inProgress).not.toContain(id);
      expect(toFix).not.toContain(id);
    }
    expect((await homeService.tabCounts(hctx())).toResume).toBe(1);
    await expectResumeAndFixDisjoint();
  });

  it('(d) a LOCAL gated run: the approval starts nothing and records no resume — `motir continue` takes it over', async () => {
    const { parent, design, runId } = await agentRunStory();
    await runCloseWorkItemRun({ key: parent.identifier, runId, outcome: 'gated' }, fx.ctx);
    const designGate = await gateOn(design, 'design_result');

    await approveThroughDecide(designGate.id);

    expect((await stateOf(parent.id)).resumeState).toBe('ready_to_resume');
    // The ask is made (the decide door does not know where the run ran) and the job
    // answers it with nothing: a local run is the developer's to continue.
    expect(await drainResumeJobs()).toBe(1);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await adminDb.gateResume.count()).toBe(0);
    expect(await continues()).toEqual([]);
    await expectResumeAndFixDisjoint();

    const claimed = await workItemContinueService.claimContinue(
      fx.projectId,
      parent.identifier,
      fx.ctx,
    );
    expect(claimed).toMatchObject({ outcome: 'claimed', resumesGated: true });
    expect(await stateOf(parent.id)).toMatchObject({ resumeState: null, resumeRunId: null });
    expect(await toResumeIds()).toEqual([]);
    await expectResumeAndFixDisjoint();
  });
});

// ── (b) · a hosted run resumes itself through the decide door ───────────────────

describe('(b) approving the held design through decide resumes the hosted run exactly once', () => {
  it('ready_to_resume → the job → ONE hosted continue as the dispatcher, on the run’s branch → the column clears', async () => {
    const mara = await dispatcher();
    const { parent, design, code, runId } = await hostedStory(mara.ctx);
    expect(await toResumeIds()).toEqual([parent.id]);
    const designGate = await gateOn(design, 'design_result');

    await approveThroughDecide(designGate.id);

    expect(await stateOf(parent.id)).toEqual({
      resumeState: 'ready_to_resume',
      resumeRunId: runId,
      fixReason: null,
    });
    expect(await stateOf(code.id)).toMatchObject({ resumeState: 'ready_to_resume' });
    await expectResumeAndFixDisjoint();

    expect(resumeAsks().map((e) => e.data)).toEqual([
      { workspaceId: fx.workspaceId, gateId: designGate.id, idempotencyKey: designGate.id },
    ]);
    expect(await drainResumeJobs()).toBe(1);

    // EXACTLY ONE continue, hosted, as Mara, with the run's model, booted once.
    const opened = await continues();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      origin: 'hosted',
      command: 'continue',
      model: MODEL,
      createdById: mara.id,
      status: 'running',
      scopeWorkItemId: parent.id,
    });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env).toMatchObject({
      MOTIR_DISPATCH_RUN_ID: opened[0]!.id,
      MOTIR_WORK_ITEM_KEY: parent.identifier,
      MOTIR_RUN_MODE: 'continue',
    });
    const runOpened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: opened[0]!.id, kind: 'run_opened' },
    });
    expect(runOpened.data).toMatchObject({
      continuesRunId: runId,
      resumesGated: true,
      branch: SESSION_BRANCH,
      origin: 'hosted',
    });
    expect(
      await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: designGate.id } }),
    ).toMatchObject({
      runId,
      outcome: 'started',
      skipReason: null,
      resumedRunId: opened[0]!.id,
    });
    // The gated run is resumed, never rewritten as a death.
    expect(await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: 'succeeded',
      stopReason: 'gated',
    });

    // The entry leaves; the item page reads the live continue as Resuming.
    for (const id of [parent.id, code.id]) {
      expect(await stateOf(id)).toMatchObject({ resumeState: null, resumeRunId: null });
    }
    expect(await toResumeIds()).toEqual([]);
    expect((await homeService.tabCounts(hctx())).toResume).toBe(0);
    expect(await resumeRunDetailService.readForWorkItem(parent.id, fx.ctx)).toMatchObject({
      state: 'resuming',
      runId,
      resumedRunId: opened[0]!.id,
    });
    await expectResumeAndFixDisjoint();

    // A redelivered ask starts nothing more.
    await new JobTestEngine({
      function: gateResume,
      events: [
        {
          name: 'run/gate-resume.requested',
          data: {
            workspaceId: fx.workspaceId,
            gateId: designGate.id,
            idempotencyKey: designGate.id,
          },
        },
      ],
    }).execute();
    expect(await continues()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

// ── (c) · the other deciding doors ───────────────────────────────────────────────

const CHOICE_BODY = [
  '## Question',
  'Where do quota overages go?',
  '## Why this is a choice',
  '**Situation:** contradicts your decision',
  '**You said:** "Never block a request."',
  'Research found the gateway must refuse past the hard cap.',
  '## Options',
  '### Refuse past the cap',
  '**Best if you want:** less to operate',
  'The gateway’s own ceiling.',
  '### Bill the overage',
  '**Best if you want:** more customisable later',
  'Requests keep flowing.',
  '## What this choice gates',
  'The quota story.',
].join('\n');

describe('(c) every other door that approves a held gate resumes the hosted run once', () => {
  async function expectOneResume(runId: string, gateId: string, parent: WorkItem) {
    expect(resumeAsks().map((e) => (e.data as { gateId: string }).gateId)).toEqual([gateId]);
    expect(await drainResumeJobs()).toBe(1);
    expect(await continues()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(await adminDb.gateResume.findUniqueOrThrow({ where: { gateId } })).toMatchObject({
      runId,
      outcome: 'started',
    });
    expect((await stateOf(parent.id)).resumeState).toBeNull();
    expect(await toResumeIds()).toEqual([]);
    await expectResumeAndFixDisjoint();
  }

  it('the system approval, with design approval switched off', async () => {
    const mara = await dispatcher();
    // The run stopped at the design's v1 question; the setting was switched off
    // meanwhile, so v2's publish raises the gate and approves it on the record.
    const { parent, design, runId } = await hostedStory(mara.ctx);
    expect((await stateOf(parent.id)).resumeState).toBe('waiting_on_gate');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { designApprovalGate: false },
    });

    await publish(design, 'v2');

    const approved = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: design.id, kind: 'design_result', state: 'approved' },
    });
    expect(approved.decisionSource).toBe('system');
    await expectOneResume(runId, approved.id, parent);
  });

  it('Mark done on a held manual-work gate', async () => {
    const mara = await dispatcher();
    let manual!: WorkItem;
    const { parent, runId } = await hostedStory(mara.ctx, {
      extraLegs: async (p) => {
        manual = await card('Rotate the gateway key', { parentId: p.id, type: 'manual' });
        await withWorkspaceContext(fx.ctx, (tx) =>
          manualWorkGateService.raise(manual.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
        );
        return [manual];
      },
    });
    const gate = await gateOn(manual, 'manual_work');
    const held = await adminDb.dispatchRunHeldGate.findMany({ where: { dispatchRunId: runId } });
    expect(held.map((h) => h.kind).sort()).toEqual(['design_result', 'manual_work']);

    await approveThroughDecide(gate.id);

    expect((await stateOf(parent.id)).resumeState).toBe('ready_to_resume');
    await expectOneResume(runId, gate.id, parent);
  });

  it('a choose on a held choice gate', async () => {
    const mara = await dispatcher();
    let choice!: WorkItem;
    const { parent, runId } = await hostedStory(mara.ctx, {
      extraLegs: async (p) => {
        choice = await card('Choose where overages go', {
          parentId: p.id,
          type: 'choice',
          descriptionMd: CHOICE_BODY,
        });
        return [choice];
      },
    });
    const gate = await gateOn(choice, 'decision_choice');
    const { stamp, gate: read } = await approvalGatesService.getForWorkItem(
      { workItemId: choice.id, kind: 'decision_choice' },
      fx.ctx,
    );
    const optionId = (read as { options?: { id: string }[] } | null)?.options?.[0]?.id;

    await approvalGatesService.decide(
      {
        gateId: gate.id,
        decision: 'choose',
        source: 'ui',
        stamp,
        optionId: optionId ?? 'refuse-past-the-cap',
      } as Parameters<typeof approvalGatesService.decide>[0],
      fx.ctx,
    );

    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).state).toBe(
      'approved',
    );
    await expectOneResume(runId, gate.id, parent);
  });
});

// ── (e) · two held gates approved back to back ──────────────────────────────────

describe('(e) two held gates approved back to back', () => {
  it('start ONE continue; the second ask records already_resumed', async () => {
    const mara = await dispatcher();
    let manual!: WorkItem;
    const { design, runId } = await hostedStory(mara.ctx, {
      extraLegs: async (p) => {
        manual = await card('Rotate the gateway key', { parentId: p.id, type: 'manual' });
        await withWorkspaceContext(fx.ctx, (tx) =>
          manualWorkGateService.raise(manual.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
        );
        return [manual];
      },
    });
    const designGate = await gateOn(design, 'design_result');
    const manualGate = await gateOn(manual, 'manual_work');

    await approveThroughDecide(designGate.id);
    await approveThroughDecide(manualGate.id);
    expect(resumeAsks()).toHaveLength(2);
    await drainResumeJobs();

    expect(await continues()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    const records = await adminDb.gateResume.findMany({ orderBy: { createdAt: 'asc' } });
    expect(records.map((r) => [r.gateId, r.outcome, r.skipReason])).toEqual([
      [designGate.id, 'started', null],
      [manualGate.id, 'skipped', 'already_resumed'],
    ]);
    expect(records.every((r) => r.runId === runId)).toBe(true);
    await expectResumeAndFixDisjoint();
  });
});

// ── (f) · each real pre-flight refusal is recorded as a skip ────────────────────

describe('(f) a resume the hosted start refuses is recorded, and the entry carries it', () => {
  const CASES = [
    ['out_of_credits', async () => stub({ mayRun: false })],
    ['model_not_offered', async () => stub({ models: ['claude-haiku-4-5-20251001'] })],
    ['no_project_access', async () => setProjectAccess(adminDb, fx.projectId, 'members')],
    [
      'repository_not_writable',
      async (story: { parent: WorkItem; code: WorkItem; design: WorkItem }) => {
        const repo = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
        for (const item of [story.parent, story.code, story.design]) {
          await adminDb.workItemRepo.deleteMany({ where: { workItemId: item.id } });
          await adminDb.workItemRepo.create({
            data: {
              workspaceId: fx.workspaceId,
              workItemId: item.id,
              projectRepoId: repo,
              position: 0,
            },
          });
        }
        stub({ installation: { 'acme/web': 404 } });
      },
    ],
  ] as const;

  it.each(CASES)(
    '%s: no continue, no boot, a skip the To resume entry names',
    async (reason, refuse) => {
      const mara = await dispatcher();
      const story = await hostedStory(mara.ctx);
      const designGate = await gateOn(story.design, 'design_result');
      await approveThroughDecide(designGate.id);
      await refuse(story);

      await drainResumeJobs();

      expect(await continues()).toEqual([]);
      expect(fakeOrchestrator.provisioned).toEqual([]);
      expect(
        await adminDb.gateResume.findUniqueOrThrow({ where: { gateId: designGate.id } }),
      ).toMatchObject({
        runId: story.runId,
        outcome: 'skipped',
        skipReason: reason,
        resumedRunId: null,
      });
      // Still ready, still listed — for a person to continue by hand — and the entry
      // says why the auto-resume did not start.
      expect((await stateOf(story.parent.id)).resumeState).toBe('ready_to_resume');
      const toResume = await homeService.listToResume(hctx());
      expect(toResume.items.map((r) => r.id)).toEqual([story.parent.id]);
      expect(toResume.items[0]).toMatchObject({
        resumeAttempt: { outcome: 'skipped', skipReason: reason },
      });
      const gated = await resumeRunDetailService.readForWorkItem(story.parent.id, fx.ctx);
      expect(gated).toMatchObject({
        state: 'ready_to_resume',
        attempt: { outcome: 'skipped', skipReason: reason },
      });
      await expectResumeAndFixDisjoint();
    },
  );
});

// ── (g) · a gate sent back ───────────────────────────────────────────────────────

describe('(g) a held gate sent back', () => {
  it('changes requested is ready_to_resume and starts nothing on its own (MOTIR-9185)', async () => {
    const mara = await dispatcher();
    const { parent, design, runId } = await hostedStory(mara.ctx);
    const designGate = await gateOn(design, 'design_result');

    await approvalGatesService.decide(
      {
        gateId: designGate.id,
        decision: 'request_changes',
        noteMd: 'The overage row needs its own line.',
        refusalVerdict: 'revise',
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
    );

    expect(await stateOf(parent.id)).toEqual({
      resumeState: 'ready_to_resume',
      resumeRunId: runId,
      fixReason: null,
    });
    expect(resumeAsks()).toEqual([]);
    expect(await continues()).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(await adminDb.gateResume.count()).toBe(0);
    const entry = (await homeService.listToResume(hctx())).items[0]!;
    expect(entry.resumeRun?.gates).toEqual([
      expect.objectContaining({
        gateId: designGate.id,
        state: 'changes_requested',
        notePreview: 'The overage row needs its own line.',
      }),
    ]);
    // The continue claim releases it as the column does: the reason is read, the work redone.
    expect(
      await workItemContinueService.claimContinue(fx.projectId, parent.identifier, fx.ctx),
    ).toMatchObject({ outcome: 'claimed', resumesGated: true });
    await expectResumeAndFixDisjoint();
  });
});

// ── (h) · a run that genuinely died ──────────────────────────────────────────────

describe('(h) a run that genuinely died is still To fix’s', () => {
  it.each([
    [
      'cancelled while it held a gate',
      { stopReason: 'gated' as const, status: 'cancelled' as const },
    ],
    ['interrupted', { stopReason: 'interrupted' as const }],
  ])('%s → run_died on To fix, resumeState null', async (_label, input) => {
    const parent = await card('A story', { kind: 'story' });
    const design = await card('Its design', { parentId: parent.id });
    await publish(design, 'v1');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        origin: 'hosted',
        model: MODEL,
        reportedBy: 'cli',
        scopeKey: parent.identifier,
        cards: [{ key: design.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );

    await dispatchRunService.close(run.id, input, fx.ctx);

    expect(await stateOf(parent.id)).toEqual({
      resumeState: null,
      resumeRunId: null,
      fixReason: 'run_died',
    });
    expect(await toFixIds()).toContain(parent.id);
    expect(await toResumeIds()).toEqual([]);
    await expectResumeAndFixDisjoint();
  });

  it('the lapse sweep closes a silent run abandoned → run_died, never To resume', async () => {
    const parent = await card('A story', { kind: 'story' });
    const design = await card('Its design', { parentId: parent.id });
    await publish(design, 'v1');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: parent.identifier,
        cards: [{ key: design.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 30 * 60_000) },
    });

    await dispatchRunSweepService.reapLapsed(new Date());

    expect(await stateOf(parent.id)).toMatchObject({ resumeState: null, fixReason: 'run_died' });
    expect(await toResumeIds()).toEqual([]);
    await expectResumeAndFixDisjoint();
  });
});

// ── GUARD 2 · the five kinds that hold a run, and no other ──────────────────────

const FIVE: ApprovalGateKind[] = [
  'decision_approval',
  'decision_choice',
  'decision_confirmation',
  'design_result',
  'manual_work',
];

describe('guard · the derivation reads exactly the five run-holding kinds', () => {
  it('RUN_HOLDING_GATE_KINDS is the five, and every one is a registered gate kind', () => {
    expect([...RUN_HOLDING_GATE_KINDS].sort()).toEqual(FIVE);
    for (const kind of RUN_HOLDING_GATE_KINDS) {
      expect(isRegisteredGateKind(kind), `${kind} has no decide handler`).toBe(true);
    }
  });

  it('a gated close over an awaiting gate of EVERY kind records the five and nothing else', async () => {
    const parent = await card('A story', { kind: 'story' });
    const legs: WorkItem[] = [];
    // Every kind a CARD can carry — `plan_approval` is card-less by a check constraint
    // (`approval_gate_work_item_iff_not_plan`), so no run's leg can hold one.
    const kinds = (Object.values(ApprovalGateKind) as ApprovalGateKind[]).filter(
      (kind) => kind !== 'plan_approval' && kind !== 'planning_session',
    );
    expect(kinds.length).toBeGreaterThan(FIVE.length);
    for (const kind of kinds) {
      const leg = await card(`a ${kind} card`, { parentId: parent.id });
      await adminDb.approvalGate.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: leg.id,
          kind,
          subjectId: `subject-${kind}`,
          state: 'awaiting',
        },
      });
      legs.push(leg);
    }
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: parent.identifier,
        cards: legs.map((leg) => ({ key: leg.identifier, disposition: 'queued' as const })),
      },
      fx.ctx,
    );

    await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);

    const held = await adminDb.dispatchRunHeldGate.findMany({ where: { dispatchRunId: run.id } });
    expect(held.map((h) => h.kind).sort()).toEqual(FIVE);
    // …and the entry draws the same five, never a pull request's or a plan's gate.
    const entry = (await homeService.listToResume(hctx())).items[0]!;
    expect(entry.resumeRun!.gates.map((g) => g.kind).sort()).toEqual(FIVE);
  });
});

// ── GUARD 3 · every deciding door reaches the resume enqueue ────────────────────
//
// An approval can be written in exactly one place — `approvalGateRepository.decide` —
// and only two service methods call it: the decide door and the design-approval-off
// system approval. The decide door asks for the resume itself, after its commit, so
// every door built on it inherits the ask; the system approval runs inside its
// caller's transaction, so each of ITS callers must ask after the commit. The guard
// ENUMERATES both sets of callers: a new door fails here until somebody has read it
// and added it, which is the moment to check it reaches the enqueue.

const ROOT = path.resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** The file's code with `//` and block comments blanked — prose naming a call is not one. */
function code(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const APP_SOURCES = [...sources('lib'), ...sources('app')];
const callers = (pattern: RegExp) => APP_SOURCES.filter((rel) => pattern.test(code(rel))).sort();

/** The DOORS built on `approvalGatesService.decide` — each inherits its resume ask. */
const DECIDE_DOORS = [
  'lib/services/approvalGatesService.ts',
  'lib/services/guideLandingService.ts',
  'lib/services/planGateDoor.ts',
  'lib/services/pullRequestMergeService.ts',
  'lib/services/pullRequestReviewSync.ts',
];

/** The callers of the in-transaction system approval — each must ask itself. */
const SYSTEM_APPROVAL_DOORS = ['lib/services/designEvidenceService.ts'];

describe('guard · every caller of decide or approveBySystem reaches the resume enqueue', () => {
  it('an approval is written only by approvalGateRepository.decide, from decide and approveBySystem', () => {
    expect(callers(/approvalGateRepository\s*\.\s*decide\s*\(/)).toEqual([
      'lib/services/approvalGatesService.ts',
    ]);
    const service = code('lib/services/approvalGatesService.ts');
    const methods = [...service.matchAll(/^  async (\w+)\(/gm)].map((m) => ({
      name: m[1]!,
      at: m.index!,
    }));
    const enclosing = [...service.matchAll(/approvalGateRepository\s*\.\s*decide\s*\(/g)].map(
      (m) => methods.filter((method) => method.at < m.index!).at(-1)?.name,
    );
    expect([...new Set(enclosing)].sort()).toEqual(['approveBySystem', 'decide']);
  });

  it('the decide door asks for the resume after its commit, on an approving decision', () => {
    const service = code('lib/services/approvalGatesService.ts');
    const start = service.search(/^  async decide\(/m);
    const body = service.slice(start, service.indexOf('async function decideUnderLock', start));
    expect(body, 'decide no longer asks for the resume').toMatch(
      /DECISION_STATE\[input\.decision\] === 'approved'\)\s*\{\s*await requestGateResumeAfterDecision\(/,
    );
    // After the transaction, never inside it: the ask reads the committed approval.
    expect(body.indexOf('requestGateResumeAfterDecision(')).toBeGreaterThan(
      body.indexOf('withWorkspaceContext('),
    );
  });

  it('the callers of decide are the enumerated doors', () => {
    expect(callers(/approvalGatesService\s*\.\s*decide\s*\(/)).toEqual(DECIDE_DOORS);
    // Nobody reaches decide by another name.
    expect(callers(/\{\s*[^}]*\bdecide\b[^}]*\}\s*=\s*approvalGatesService/)).toEqual([]);
  });

  it('every caller of approveBySystem asks for the resume itself', () => {
    expect(callers(/\.\s*approveBySystem\s*\(/)).toEqual(SYSTEM_APPROVAL_DOORS);
    for (const rel of SYSTEM_APPROVAL_DOORS) {
      expect(code(rel), `${rel} approves by system without asking to resume`).toMatch(
        /requestGateResumeAfterDecision\(/,
      );
    }
  });
});
