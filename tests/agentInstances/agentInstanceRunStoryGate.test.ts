import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentExecResult } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { dispatchRunGitCredentialsSchema } from '@/lib/api/v1/workLoop/schema';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import {
  AGENT_RUN_END_DETAIL,
  agentInstanceRunService as runs,
  agentRunLaunchKey,
} from '@/lib/services/agentInstanceRunService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { hostedRunKeyService } from '@/lib/services/hostedRunKeyService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestLink } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import {
  AI,
  clock,
  debits,
  fleet,
  fx,
  intervals,
  MIN,
  otherMember,
  seedRepo,
  setUpHarness,
  stub,
  tearDownHarness,
} from './_harness';

// THE RUN-IN-MY-AGENT STORY GATE (Story MOTIR-6864 · MOTIR-7030) — the assembled
// path, each child's REAL output driven through the next child's REAL consumer,
// against a real Postgres and the fake persistent fleet (reached through the
// lifecycle's `getPersistentOrchestrator()` seam, its `exec` answering as the
// agent's terminal server would). motir-ai and GitHub are stubbed at `fetch`.
//
// The units of MOTIR-7023 … MOTIR-7029 each fake a neighbour. This file does not:
// the route opens the run, the launch job mints the token and hands it to the
// agent on stdin, and THAT token — read back off the exec, never minted by the
// test — is what knocks on the git-credential route and the run's `/events`.
//
// Contract: `docs/decisions/agent-instance-run.md` — §4's refusal set, §5's
// record and charge, §6's lifecycle and close paths.

const session = { user: null as { id: string; email: string } | null };
const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctxRef.current,
}));

const startRoute = await import('@/app/api/work-items/[id]/agent-runs/route');
const cardRunsRoute = await import('@/app/api/work-items/[id]/dispatch-runs/route');
const projectRunsRoute = await import('@/app/api/projects/[key]/dispatch-runs/route');
const runDetailRoute = await import('@/app/api/dispatch-runs/[id]/route');
const cancelRoute = await import('@/app/api/dispatch-runs/[id]/cancel/route');
const closeRoute = await import('@/app/api/v1/dispatch-runs/[id]/close/route');
const eventsRoute = await import('@/app/api/v1/dispatch-runs/[id]/events/route');
const gitCredentialRoute = await import('@/app/api/v1/dispatch-runs/[id]/git-credential/route');
const hibernateRoute = await import('@/app/api/projects/[key]/instances/[id]/hibernate/route');
const deleteRoute = await import('@/app/api/projects/[key]/instances/[id]/route');

const MASTER = 'm'.repeat(48);

/** What the fake agent's terminal server answers. */
const agentSide = { signIn: 'signed_in' };

function answer(command: readonly string[]): PersistentExecResult {
  const line = command.join(' ');
  const ok = (stdout = ''): PersistentExecResult => ({ exitCode: 0, stdout, stderr: '' });
  if (line === 'motir agent-terminal run --help') return ok();
  if (line.endsWith('motir agent-terminal signin')) {
    return ok(`${JSON.stringify({ profile: 'claude', state: agentSide.signIn })}\n`);
  }
  if (line.includes('motir agent-terminal run ') && line.includes('--run-id')) {
    return ok('{"session":"sess-1"}\n');
  }
  if (line.includes('motir agent-terminal stop ')) return ok('{"result":"stopped"}\n');
  return ok();
}

/** GitHub's App identity reads the git-credential route adds on top of the harness's stub. */
function widenFetch(): void {
  const inner = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/app') && (init?.method ?? 'GET') === 'GET') {
        return json({ slug: 'motir-integration' });
      }
      const user = /\/users\/(.+)$/.exec(url);
      if (user) return json({ id: 2002, login: decodeURIComponent(user[1] ?? '') });
      return inner(input, init);
    }),
  );
}

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  resetRateLimitStore();
  _resetRunGitBotAuthors();
  _resetInstallationTokenCache();
  widenFetch();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  agentSide.signIn = 'signed_in';
  fleet.setExecResponder(answer);
  await seedRepo('acme', 'web');
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Reads ───────────────────────────────────────────────────────────────────

const KEY = () => fx.projectIdentifier;
const agentRow = async (id: string) => (await adminDb.agentInstance.findUnique({ where: { id } }))!;
const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });
const runRows = () => adminDb.dispatchRun.findMany({ where: { workspaceId: fx.workspaceId } });
const runTokens = () => adminDb.apiToken.findMany({ where: { dispatchRunId: { not: null } } });
const runJobs = () =>
  adminDb.jobQueueRun.findMany({ where: { jobId: { startsWith: 'agent-instance-run/' } } });
const machineStarts = () => fleet.operations.filter((op) => op.startsWith('machine:start'));
const cardRow = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });
const closingLines = async (runId: string) =>
  (
    await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: runId, kind: 'log' },
      orderBy: { seq: 'asc' },
    })
  )
    .map((e) => e.body ?? '')
    .filter((b) => b.includes('run in agent ended'));

/** Move the lifecycle's clock to the real clock (plus `offsetMs`) — run rows are stamped by the database. */
function atRealNow(offsetMs = 0): void {
  clock.advance(Date.now() + offsetMs - clock.now().getTime());
}

// ── Actors ──────────────────────────────────────────────────────────────────

async function agent(name = 'yue-claude'): Promise<string> {
  const dto = await lifecycle.create(KEY(), { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('running');
  return dto.id;
}

function card(title = 'a card', parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

/** The card's press: `POST /api/work-items/[key]/agent-runs`. */
async function press(
  key: string,
  agentInstanceId: string,
  idempotencyKey?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await startRoute.POST(
    new Request(`http://t/api/work-items/${key}/agent-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentInstanceId, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    }),
    { params: Promise.resolve({ id: key }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Drive the launch job as the engine would, and read back the token the agent was handed. */
async function launch(dispatchRunId: string): Promise<string> {
  const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
  const verdict = await engineJob('agent-instance-run/launch')!.handler(
    {
      step,
      event: {
        data: {
          workspaceId: fx.workspaceId,
          dispatchRunId,
          idempotencyKey: agentRunLaunchKey(dispatchRunId),
        },
      },
    } as never,
    jobServices as never,
  );
  expect(verdict).toBe('launched');
  const exec = fleet.execs.filter((e) => e.command.includes(dispatchRunId)).at(-1)!;
  return (JSON.parse(exec.stdin!) as { token: string }).token;
}

/** A card pressed on a fresh agent and launched. */
async function startedRun(name?: string) {
  const agentId = await agent(name);
  const item = await card();
  const { status, body } = await press(item.identifier, agentId);
  expect(status).toBe(201);
  const runId = body.dispatchRunId as string;
  const token = await launch(runId);
  return { runId, agentId, item, token };
}

const bearer = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

const gitCredential = (runId: string, token: string) =>
  gitCredentialRoute.POST(
    new Request(`http://localhost/api/v1/dispatch-runs/${runId}/git-credential`, {
      method: 'POST',
      headers: bearer(token),
    }),
    { params: Promise.resolve({ id: runId }) },
  );

const postEvents = (runId: string, token: string, body: string) =>
  eventsRoute.POST(
    new Request(`http://localhost/api/v1/dispatch-runs/${runId}/events`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ events: [{ kind: 'log', body }] }),
    }),
    { params: Promise.resolve({ id: runId }) },
  );

const cliClose = (runId: string, token: string) =>
  closeRoute.POST(
    new Request(`http://localhost/api/v1/dispatch-runs/${runId}/close`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ stopReason: 'completed' }),
    }),
    { params: Promise.resolve({ id: runId }) },
  );

const cancel = (runId: string) =>
  cancelRoute.POST(new Request('http://t/cancel', { method: 'POST' }), {
    params: Promise.resolve({ id: runId }),
  });

const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

async function credentialsFor(runId: string, token: string) {
  const res = await gitCredential(runId, token);
  expect(res.status).toBe(200);
  return dispatchRunGitCredentialsSchema.parse(await res.json()).credentials;
}

// ── 1 · The seam ────────────────────────────────────────────────────────────

describe('1 · start → run record → run credential → git credential', () => {
  it('a leaf: one `instance` run, the card claimed, and the handed-on token works for its OWN run only', async () => {
    const agentId = await agent();
    const item = await card();
    const { status, body } = await press(item.identifier, agentId);
    expect(status).toBe(201);
    expect(body).toMatchObject({ created: true, woke: false });
    const runId = body.dispatchRunId as string;

    const rows = await runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: runId,
      command: 'run',
      origin: 'instance',
      agentInstanceId: agentId,
      agent: 'claude',
      model: null,
      status: 'running',
    });
    expect(await cardRow(item.id)).toMatchObject({
      status: 'in_progress',
      assigneeId: fx.ownerId,
      implementationSource: 'byok',
      implementationHarness: 'claude',
    });

    const token = await launch(runId);
    expect((await runTokens()).map((t) => t.dispatchRunId)).toEqual([runId]);

    // The run's own git credential: one entry, the card's repository.
    const creds = await credentialsFor(runId, token);
    expect(creds.map((c) => c.repository)).toEqual(['acme/web']);
    expect(await adminDb.dispatchRunGitCredential.count({ where: { dispatchRunId: runId } })).toBe(
      1,
    );

    // The run's own `/events` — and the event bumps the agent's activity (§6).
    clock.advance(10 * MIN);
    const before = (await agentRow(agentId)).lastActivityAt;
    const appended = await postEvents(runId, token, 'working\n');
    expect(appended.status).toBe(200);
    const bumped = (await agentRow(agentId)).lastActivityAt;
    expect(bumped.getTime()).toBeGreaterThan(before.getTime());
    expect(bumped.getTime()).toBe(clock.now().getTime());

    // ANOTHER run's routes refuse this token — the git credential and the events alike.
    const other = await startedRun('second-agent');
    const theirGit = await gitCredential(other.runId, token);
    expect(theirGit.status).toBe(403);
    expect(await codeOf(theirGit)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    const theirEvents = await postEvents(other.runId, token, 'not mine\n');
    expect(theirEvents.status).toBe(403);
    expect(await codeOf(theirEvents)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    expect(
      await adminDb.dispatchRunGitCredential.count({ where: { dispatchRunId: other.runId } }),
    ).toBe(0);
    // …while that run's own token still serves it.
    expect((await credentialsFor(other.runId, other.token)).length).toBe(1);
  });

  it('a two-repository leaf: the credential covers both repositories', async () => {
    await seedRepo('acme', 'api');
    const agentId = await agent();
    const item = await card();
    const repos = await adminDb.projectRepo.findMany({
      where: { projectId: fx.projectId },
      orderBy: { position: 'asc' },
    });
    expect(repos).toHaveLength(2);
    for (const [position, repo] of repos.entries()) {
      await adminDb.workItemRepo.create({
        data: {
          workspaceId: fx.workspaceId,
          workItemId: item.id,
          projectRepoId: repo.id,
          position,
        },
      });
    }

    const { status, body } = await press(item.identifier, agentId);
    expect(status).toBe(201);
    const runId = body.dispatchRunId as string;
    const token = await launch(runId);
    const creds = await credentialsFor(runId, token);
    expect(creds.map((c) => c.repository).sort()).toEqual(['acme/api', 'acme/web']);
    for (const c of creds) expect(c.token).toMatch(/^ghs_/);
  });

  it('a parent card: a `run_scope` run, its legs in dependency order, and its credential', async () => {
    const agentId = await agent();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'a story' },
      fx.ctx,
    );
    const later = await card('later', story.id);
    const earlier = await card('earlier', story.id);
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: later.id,
      toId: earlier.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const { status, body } = await press(story.identifier, agentId);
    expect(status).toBe(201);
    const runId = body.dispatchRunId as string;
    expect(await runRow(runId)).toMatchObject({
      command: 'run_scope',
      origin: 'instance',
      agentInstanceId: agentId,
    });
    const legs = await adminDb.dispatchRunCard.findMany({
      where: { dispatchRunId: runId },
      orderBy: { position: 'asc' },
    });
    expect(legs.map((l) => l.workItemKey)).toEqual([earlier.identifier, later.identifier]);

    const token = await launch(runId);
    const exec = fleet.execs.filter((e) => e.command.includes(runId)).at(-1)!;
    expect(exec.command).toContain(story.identifier);
    expect((await credentialsFor(runId, token)).map((c) => c.repository)).toEqual(['acme/web']);
  });
});

// ── 2 · The wake ────────────────────────────────────────────────────────────

describe('2 · a hibernated agent is woken through the lifecycle BEFORE the run opens', () => {
  it('opens exactly one interval, then the run', async () => {
    const agentId = await agent();
    await lifecycle.hibernate(KEY(), agentId, fx.ctx);
    const before = await intervals();
    expect(before.every((i) => i.endedAt !== null)).toBe(true);
    const startsBefore = machineStarts().length;
    const item = await card();
    const wake = vi.spyOn(lifecycle, 'wake');
    const open = vi.spyOn(dispatchRunService, 'open');

    const { status, body } = await press(item.identifier, agentId);
    expect(status).toBe(201);
    expect(body.woke).toBe(true);

    expect(wake).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(wake.mock.invocationCallOrder[0]!).toBeLessThan(open.mock.invocationCallOrder[0]!);
    expect(machineStarts()).toHaveLength(startsBefore + 1);
    const after = await intervals();
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((i) => i.endedAt === null)).toHaveLength(1);
    expect((await agentRow(agentId)).state).toBe('running');

    await launch(body.dispatchRunId as string);
  });
});

// ── 3 · Every refusal ───────────────────────────────────────────────────────

interface RefusalCase {
  name: string;
  /** Arrange; answer the card and agent to press. */
  arrange: () => Promise<{ key: string; cardId: string; agentId: string }>;
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  /** Refused before the wake step: no wake is even asked. */
  beforeWake: boolean;
}

async function freshCard() {
  const item = await card('refused card');
  return { key: item.identifier, cardId: item.id };
}

async function sleepingAgent(): Promise<string> {
  const id = await agent('sleeper');
  await lifecycle.hibernate(KEY(), id, fx.ctx);
  return id;
}

const REFUSALS: RefusalCase[] = [
  {
    name: 'no `instance:use` on the project',
    arrange: async () => {
      const agentId = await agent();
      vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValueOnce(
        new PermissionDeniedError(fx.projectId, 'instance:use'),
      );
      return { ...(await freshCard()), agentId };
    },
    status: 403,
    code: 'PERMISSION_DENIED',
    beforeWake: true,
  },
  {
    name: 'another member’s agent',
    arrange: async () => {
      const other = await otherMember();
      const theirs = await adminDb.agentInstance.create({
        data: {
          workspaceId: fx.workspaceId,
          organizationId: fx.workspace.organizationId!,
          projectId: fx.projectId,
          ownerId: other.userId,
          name: 'theirs',
          profileId: 'claude',
          imageTag: 't',
          imageDigest: 'sha256:x',
          region: 'iad',
          state: 'running',
        },
      });
      return { ...(await freshCard()), agentId: theirs.id };
    },
    status: 404,
    code: 'agent_instance_not_found',
    beforeWake: true,
  },
  {
    name: 'a deleted agent',
    arrange: async () => {
      const agentId = await agent();
      await adminDb.agentInstance.update({
        where: { id: agentId },
        data: { deletedAt: new Date() },
      });
      return { ...(await freshCard()), agentId };
    },
    status: 404,
    code: 'agent_instance_not_found',
    beforeWake: true,
  },
  {
    name: 'an agent on another project',
    arrange: async () => {
      const agentId = await agent();
      const second = await createTestProject({
        workspaceId: fx.workspaceId,
        actorUserId: fx.ownerId,
        identifier: 'OTHR',
      });
      await adminDb.agentInstance.update({
        where: { id: agentId },
        data: { projectId: second.id },
      });
      return { ...(await freshCard()), agentId };
    },
    status: 409,
    code: 'agent_instance_wrong_project',
    beforeWake: true,
  },
  {
    name: 'a card waiting on an open blocker',
    arrange: async () => {
      const agentId = await agent();
      const blocker = await card('blocker');
      const c = await freshCard();
      await createTestLink({
        workspaceId: fx.workspaceId,
        fromId: c.cardId,
        toId: blocker.id,
        kind: 'is_blocked_by',
        createdById: fx.ownerId,
      });
      return { ...c, agentId };
    },
    status: 409,
    code: 'agent_run_card_not_ready',
    beforeWake: true,
  },
  {
    name: 'a card that is not in the to-do category',
    arrange: async () => {
      const agentId = await agent();
      const c = await freshCard();
      await adminDb.workItem.update({ where: { id: c.cardId }, data: { status: 'in_review' } });
      return { ...c, agentId };
    },
    status: 409,
    code: 'agent_run_card_not_ready',
    beforeWake: true,
  },
  {
    name: 'an image without the launcher',
    arrange: async () => {
      const agentId = await agent();
      await adminDb.agentInstance.update({
        where: { id: agentId },
        data: { runLauncher: 'absent' },
      });
      return { ...(await freshCard()), agentId };
    },
    status: 409,
    code: 'agent_instance_image_too_old',
    beforeWake: true,
  },
  {
    name: 'a coding agent with no unattended command',
    arrange: async () => {
      const agentId = await agent();
      await adminDb.agentInstance.update({ where: { id: agentId }, data: { profileId: 'cursor' } });
      return { ...(await freshCard()), agentId };
    },
    status: 409,
    code: 'agent_profile_cannot_run',
    beforeWake: true,
  },
  {
    name: 'a sleeping agent recorded signed out — refused WITHOUT waking it',
    arrange: async () => {
      const agentId = await sleepingAgent();
      await adminDb.agentInstance.update({
        where: { id: agentId },
        data: { signInState: 'signed_out' },
      });
      return { ...(await freshCard()), agentId };
    },
    status: 409,
    code: 'agent_not_signed_in',
    beforeWake: true,
  },
  {
    name: 'a running agent the live probe finds signed out',
    arrange: async () => {
      const agentId = await agent();
      agentSide.signIn = 'signed_out';
      return { ...(await freshCard()), agentId };
    },
    status: 409,
    code: 'agent_not_signed_in',
    beforeWake: true,
  },
  {
    name: 'a repository the App cannot write',
    arrange: async () => {
      const agentId = await agent();
      stub.installation = { 'acme/web': 404 };
      return { ...(await freshCard()), agentId };
    },
    status: 409,
    code: 'hosted_repository_not_writable',
    beforeWake: true,
  },
  {
    name: 'an agent that is hibernating',
    arrange: async () => {
      const agentId = await agent();
      await adminDb.agentInstance.update({
        where: { id: agentId },
        data: { state: 'hibernating' },
      });
      return { ...(await freshCard()), agentId };
    },
    status: 409,
    code: 'agent_instance_state_conflict',
    beforeWake: true,
  },
  {
    name: 'a deployment that cannot reach an agent',
    arrange: async () => {
      const agentId = await sleepingAgent();
      vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
      return { ...(await freshCard()), agentId };
    },
    status: 503,
    code: 'agent_instances_unavailable',
    beforeWake: true,
  },
  {
    name: 'the wake’s credit refusal, passed through',
    arrange: async () => {
      const agentId = await sleepingAgent();
      stub.mayRun = false;
      return { ...(await freshCard()), agentId };
    },
    status: 402,
    code: 'agent_instance_start_refused',
    extra: { reason: 'credits' },
    beforeWake: false,
  },
  {
    name: 'the wake’s unanswerable credit check, passed through',
    arrange: async () => {
      const agentId = await sleepingAgent();
      stub.mayRun = 'unanswerable';
      return { ...(await freshCard()), agentId };
    },
    status: 503,
    code: 'agent_instance_start_refused',
    extra: { reason: 'credits_unknown' },
    beforeWake: false,
  },
  {
    // A wake is never refused by the organisation's agent figure (MOTIR-9954,
    // agent-instances.md AMENDMENT 7); the operator's kill switch still refuses it.
    name: 'the wake’s kill-switch refusal, passed through',
    arrange: async () => {
      const agentId = await sleepingAgent();
      vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
      return { ...(await freshCard()), agentId };
    },
    status: 429,
    code: 'agent_instance_start_refused',
    extra: { reason: 'fleet_busy' },
    beforeWake: false,
  },
];

describe('3 · every refusal opens no run, claims no card, mints no token — and before the wake, wakes nothing', () => {
  it.each(REFUSALS)('$name → $status $code', async (c) => {
    const target = await c.arrange();
    const intervalsBefore = (await intervals()).map((i) => [i.id, i.endedAt?.toISOString()]);
    const startsBefore = machineStarts().length;
    const statesBefore = (await adminDb.agentInstance.findMany({ orderBy: { id: 'asc' } })).map(
      (a) => [a.id, a.state],
    );
    const wake = vi.spyOn(lifecycle, 'wake');

    const { status, body } = await press(target.key, target.agentId);
    expect(status).toBe(c.status);
    expect(body).toMatchObject({ code: c.code, ...(c.extra ?? {}) });

    // No run, no claim, no token, no job.
    expect(await runRows()).toEqual([]);
    expect(await runTokens()).toEqual([]);
    expect(await runJobs()).toEqual([]);
    expect(await cardRow(target.cardId)).toMatchObject({
      assigneeId: null,
      implementationSource: null,
    });
    // No machine started, no interval opened, no agent changed state.
    expect(machineStarts()).toHaveLength(startsBefore);
    expect((await intervals()).map((i) => [i.id, i.endedAt?.toISOString()])).toEqual(
      intervalsBefore,
    );
    expect(
      (await adminDb.agentInstance.findMany({ orderBy: { id: 'asc' } })).map((a) => [
        a.id,
        a.state,
      ]),
    ).toEqual(statesBefore);
    if (c.beforeWake) expect(wake).not.toHaveBeenCalled();
    else expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a run already running in the agent is refused naming that run and its card', async () => {
    const first = await startedRun();
    const item = await card('second press');
    const { status, body } = await press(item.identifier, first.agentId);
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'agent_instance_run_active',
      runId: first.runId,
      workItemKey: first.item.identifier,
    });
    expect((await runRows()).map((r) => r.id)).toEqual([first.runId]);
    expect((await runTokens()).map((t) => t.dispatchRunId)).toEqual([first.runId]);
    expect(await cardRow(item.id)).toMatchObject({ status: 'todo', assigneeId: null });
  });
});

// ── 4 · The race ────────────────────────────────────────────────────────────

describe('4 · two concurrent presses on one agent, against the real database', () => {
  it('exactly one run opens; the loser’s refusal names it — whichever wins', async () => {
    const agentId = await agent();
    const a = await card('a');
    const b = await card('b');
    const results = await Promise.all([
      press(a.identifier, agentId, 'press-a'),
      press(b.identifier, agentId, 'press-b'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const won = results.find((r) => r.status === 201)!;
    const lost = results.find((r) => r.status === 409)!;

    const rows = await runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: won.body.dispatchRunId, status: 'running' });
    const winnerKey = (
      await adminDb.dispatchRunCard.findFirstOrThrow({ where: { dispatchRunId: rows[0]!.id } })
    ).workItemKey;
    expect([a.identifier, b.identifier]).toContain(winnerKey);
    expect(lost.body).toMatchObject({
      code: 'agent_instance_run_active',
      runId: won.body.dispatchRunId,
      workItemKey: winnerKey,
    });
    // The loser's card was never claimed.
    const loserCard = winnerKey === a.identifier ? b : a;
    expect(await cardRow(loserCard.id)).toMatchObject({ status: 'todo', assigneeId: null });
  });
});

// ── 5 · The charge ──────────────────────────────────────────────────────────

describe('5 · no gateway key, no usage row — machine time is the agent’s interval charge', () => {
  it('a start on a running agent and one on a hibernated agent mint and revoke no gateway key', async () => {
    const mint = vi.spyOn(hostedRunKeyService, 'mintRunKey');
    const revoke = vi.spyOn(hostedRunKeyService, 'revokeRunKey');

    const awake = await startedRun('awake');
    const sleeperId = await sleepingAgent();
    const item = await card('woken');
    const pressed = await press(item.identifier, sleeperId);
    expect(pressed.status).toBe(201);
    const woken = pressed.body.dispatchRunId as string;
    const wokenToken = await launch(woken);

    // Each run lives and ends — the CLI's close on one, Cancel on the other.
    expect((await postEvents(awake.runId, awake.token, 'x\n')).status).toBe(200);
    expect((await cliClose(awake.runId, awake.token)).status).toBe(200);
    expect((await cancel(woken)).status).toBe(200);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: woken } })).toBe(0);
    expect(wokenToken).not.toBe(awake.token);

    // Both agents hibernate: every interval closes and is charged.
    clock.advance(5 * MIN);
    await lifecycle.hibernate(KEY(), awake.agentId, fx.ctx);
    await lifecycle.hibernate(KEY(), sleeperId, fx.ctx);
    const closed = await intervals();
    expect(closed.every((i) => i.endedAt !== null)).toBe(true);

    expect(mint).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    // Nothing asked motir-ai for a run key or a run's usage — only the paid-plan
    // read (MOTIR-6918), the credit check and the machine debits went out.
    const aiPaths = new Set(
      stub.calls.filter((c) => c.url.startsWith(AI)).map((c) => new URL(c.url).pathname),
    );
    expect([...aiPaths].sort()).toEqual(
      [
        '/v1/credits/agent-machine',
        '/v1/credits/agent-run-check',
        '/v1/stripe/subscription',
      ].filter((p) => aiPaths.has(p)),
    );
    // Every machine debit is an INTERVAL's, one per charged interval, none a run's.
    const charged = closed.filter((i) => i.chargeOutcome === 'charged');
    expect(charged.length).toBeGreaterThan(0);
    expect(debits()).toHaveLength(charged.length);
    for (const d of debits()) {
      expect(d.body).toHaveProperty('instanceIntervalId');
      expect(d.body).not.toHaveProperty('coreRunId');
      expect(JSON.stringify(d.body)).not.toContain(awake.runId);
      expect(JSON.stringify(d.body)).not.toContain(woken);
    }
    expect(
      debits()
        .map((d) => d.body!.instanceIntervalId)
        .sort(),
    ).toEqual(charged.map((i) => i.id).sort());
  });
});

// ── 6 · A live run keeps its agent ──────────────────────────────────────────

describe('6 · a live run keeps its agent', () => {
  it('the idle check skips it; Hibernate and Delete are refused naming the run', async () => {
    const { runId, agentId, item } = await startedRun();
    clock.advance(31 * MIN);
    expect(await sweeper.checkIdle(agentId)).toBe('active');
    expect((await sweeper.sweep()).hibernated.idle).toBe(0);

    const params = { params: Promise.resolve({ key: KEY(), id: agentId }) };
    const slept = await hibernateRoute.POST(
      new Request(`http://t/api/projects/${KEY()}/instances/${agentId}/hibernate`, {
        method: 'POST',
      }),
      params,
    );
    expect(slept.status).toBe(409);
    expect(await slept.json()).toMatchObject({
      code: 'agent_instance_run_active',
      runId,
      workItemKey: item.identifier,
    });
    const gone = await deleteRoute.DELETE(
      new Request(`http://t/api/projects/${KEY()}/instances/${agentId}`, { method: 'DELETE' }),
      params,
    );
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: 'agent_instance_run_active', runId });
    expect(await agentRow(agentId)).toMatchObject({ state: 'running', deletedAt: null });
    expect((await runRow(runId)).status).toBe('running');
  });
});

// ── 7 · Every end ───────────────────────────────────────────────────────────

type Started = Awaited<ReturnType<typeof startedRun>>;

interface EndCase {
  name: string;
  end: (run: Started) => Promise<void>;
  status: string;
  /** The end path's closing line — the CLI's own close writes none. */
  line: string | null;
}

const ENDS: EndCase[] = [
  {
    name: 'the CLI’s own close',
    end: async (run) => {
      expect((await cliClose(run.runId, run.token)).status).toBe(200);
    },
    status: 'succeeded',
    line: null,
  },
  {
    name: 'Cancel',
    end: async (run) => {
      expect((await cancel(run.runId)).status).toBe(200);
    },
    status: 'cancelled',
    line: 'cancelled',
  },
  {
    name: 'the agent’s machine settled failed',
    end: async (run) => {
      fleet.destroyOutside((await agentRow(run.agentId)).machineId!);
      expect((await sweeper.sweep()).reconciled).toBe(1);
      expect((await agentRow(run.agentId)).state).toBe('failed');
    },
    status: 'failed',
    line: AGENT_RUN_END_DETAIL.machineLost,
  },
  {
    name: 'supervise at the stall window',
    end: async (run) => {
      atRealNow(15 * MIN + 1_000);
      expect(await runs.supervise(run.runId)).toBe('stalled');
    },
    status: 'timed_out',
    line: AGENT_RUN_END_DETAIL.stall,
  },
];

describe('7 · every end closes the run exactly once and revokes its token', () => {
  it.each(ENDS)('$name', async (c) => {
    const run = await startedRun();
    await credentialsFor(run.runId, run.token);
    const revoke = vi.spyOn(runCredentialService, 'revokeRunCredential');

    await c.end(run);
    const closed = await runRow(run.runId);
    expect(closed.status).toBe(c.status);
    expect(closed.endedAt).not.toBeNull();
    const lines = await closingLines(run.runId);
    if (c.line === null) expect(lines).toEqual([]);
    else {
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(c.line);
    }
    // Revoked: the row is gone and the git-credential route refuses the token.
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: run.runId } })).toBe(0);
    expect((await gitCredential(run.runId, run.token)).status).toBe(401);
    const revoked = await Promise.all(revoke.mock.results.map((r) => r.value));
    expect(revoked.reduce((n, r: { revoked: number }) => n + r.revoked, 0)).toBe(1);

    // Every other close path after it writes nothing: still one close.
    expect((await runs.end(run.runId, 'failed', 'late')).closed).toBe(false);
    expect(await runs.supervise(run.runId)).toBe('closed');
    expect((await cancel(run.runId)).status).toBe(409);
    expect((await runRow(run.runId)).endedAt).toEqual(closed.endedAt);
    expect((await runRow(run.runId)).status).toBe(c.status);
    expect(await closingLines(run.runId)).toHaveLength(lines.length);
  });

  it('the CLI’s close racing Cancel: one close, one revoke — whichever wins', async () => {
    const run = await startedRun();
    const revoke = vi.spyOn(runCredentialService, 'revokeRunCredential');
    const [cancelled, closed] = await Promise.all([
      cancel(run.runId),
      cliClose(run.runId, run.token),
    ]);
    // Each is the winner, or found the run already closed: Cancel answers 409, the
    // CLI's close 401 (its token revoked) or an idempotent 200 on a closed run.
    expect([200, 409]).toContain(cancelled.status);
    expect([200, 401, 409]).toContain(closed.status);
    const row = await runRow(run.runId);
    expect(['cancelled', 'succeeded']).toContain(row.status);
    const lines = await closingLines(run.runId);
    expect(lines).toHaveLength(row.status === 'cancelled' ? 1 : 0);
    const revoked = await Promise.all(revoke.mock.results.map((r) => r.value));
    expect(revoked.reduce((n, r: { revoked: number }) => n + r.revoked, 0)).toBe(1);
    expect((await gitCredential(run.runId, run.token)).status).toBe(401);
  });
});

// ── 8 · The read back ───────────────────────────────────────────────────────

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.push(k);
      keysOf(v, into);
    }
  }
  return into;
}

const COST_KEY = /cost|credit|usage|price|billable/i;

describe('8 · an `instance` run reads back with its agent and no cost', () => {
  it('on the card, in the run list, and in the run’s own detail', async () => {
    const { runId, agentId, item } = await startedRun();
    const expected = {
      id: agentId,
      name: 'yue-claude',
      profile: 'claude',
      profileLabel: 'Claude Code',
    };

    const onCard = (await (
      await cardRunsRoute.GET(
        new Request(`http://t/api/work-items/${item.identifier}/dispatch-runs`),
        {
          params: Promise.resolve({ id: item.identifier }),
        },
      )
    ).json()) as { runs: Record<string, unknown>[] };
    expect(onCard.runs).toHaveLength(1);
    expect(onCard.runs[0]).toMatchObject({
      id: runId,
      origin: 'instance',
      agentInstance: expected,
    });

    const listed = (await (
      await projectRunsRoute.GET(new Request(`http://t/api/projects/${KEY()}/dispatch-runs`), {
        params: Promise.resolve({ key: KEY() }),
      })
    ).json()) as { runs: Record<string, unknown>[] };
    const row = listed.runs.find((r) => r.id === runId);
    expect(row).toMatchObject({ origin: 'instance', agentInstance: expected });

    const detailRes = await runDetailRoute.GET(new Request(`http://t/api/dispatch-runs/${runId}`), {
      params: Promise.resolve({ id: runId }),
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as Record<string, unknown>;
    expect(detail).toMatchObject({ id: runId, origin: 'instance', agentInstance: expected });

    for (const dto of [onCard.runs[0], row, detail]) {
      expect(keysOf(dto).filter((k) => COST_KEY.test(k))).toEqual([]);
    }
  });
});

// ── 9 · The architecture guards ─────────────────────────────────────────────

const ROOT = join(__dirname, '..', '..');

/** A module's import specifiers — static `import`/`export … from` and dynamic `import()`. */
function importsOf(source: string, fileName = 'file.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The tells of a write into the developer's own git or gh configuration, read
 * off a module's string literals (comments never count): a `~/.gitconfig` path,
 * a `.config/gh` path (whole, or as `join(…, '.config', 'gh')`), a
 * `git config --global`, and `gh auth setup-git` / `gh auth login`.
 */
function homeConfigWrites(source: string, fileName = 'file.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  // A literal's text; a template's with each substitution read as `${}`, so the
  // run's own `${i}.gitconfig` is not the home's `.gitconfig`.
  const literal = (node: ts.Node): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map((s) => `\${}${s.literal.text}`).join('');
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    const text = literal(node);
    if (text !== null) {
      if (/(^|[/\s~])\.gitconfig\b/.test(text)) found.push(`gitconfig path: ${text}`);
      if (/\.config\/gh\b/.test(text)) found.push(`gh config path: ${text}`);
      if (/^--global$|\bconfig\s+--global\b/.test(text)) found.push(`global git config: ${text}`);
      if (/\bgh\s+auth\s+(setup-git|login)\b/.test(text)) found.push(`gh auth: ${text}`);
    }
    if (ts.isCallExpression(node)) {
      const args = node.arguments.map(literal);
      for (let i = 0; i + 1 < args.length; i += 1) {
        if (args[i] === '.config' && args[i + 1] === 'gh')
          found.push('gh config path: .config, gh');
      }
      // `spawn('gh', ['auth', 'login' | 'setup-git', …])`
      const argv = node.arguments[1];
      if (args[0] === 'gh' && argv && ts.isArrayLiteralExpression(argv)) {
        const words = argv.elements.map(literal);
        if (words[0] === 'auth' && (words[1] === 'login' || words[1] === 'setup-git')) {
          found.push(`gh auth: ${words[1]}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * The agent-mode code path — every `packages/cli/src` module this story added or
 * changed (MOTIR-7024 · MOTIR-7025), minus the generated API client
 * (`api/operations.ts`, `api/schema.d.ts`, `api/validators.js`).
 */
const AGENT_MODE_PATH = [
  'packages/cli/src/agentProfiles.ts',
  'packages/cli/src/agentRun.ts',
  'packages/cli/src/agentTerminal/control.ts',
  'packages/cli/src/agentTerminal/protocol.ts',
  'packages/cli/src/agentTerminal/server.ts',
  'packages/cli/src/client.ts',
  'packages/cli/src/commandCatalog.ts',
  'packages/cli/src/commands/agentTerminal.ts',
  'packages/cli/src/commands/dispatch.ts',
  'packages/cli/src/dispatch.ts',
  'packages/cli/src/errors.ts',
  'packages/cli/src/hostedGit.ts',
  'packages/cli/src/hostedMode.ts',
  'packages/cli/src/index.ts',
  'packages/cli/src/program.ts',
  'packages/cli/src/session.ts',
];

describe('9 · the architecture guards', () => {
  it('`agentInstanceRunService` never imports `hostedRunKeyService`', () => {
    const file = 'lib/services/agentInstanceRunService.ts';
    const imports = importsOf(readFileSync(join(ROOT, file), 'utf8'), file);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((s) => /hostedRunKeyService/.test(s))).toEqual([]);
  });

  it('no agent-mode module of the CLI writes the developer’s `~/.gitconfig` or `~/.config/gh`', () => {
    const offenders = AGENT_MODE_PATH.flatMap((file) =>
      homeConfigWrites(readFileSync(join(ROOT, file), 'utf8'), file).map((t) => `${file}: ${t}`),
    );
    expect(offenders).toEqual([]);
  });

  it('each guard sees the violation it exists for', () => {
    expect(
      importsOf(`import { hostedRunKeyService } from '@/lib/services/hostedRunKeyService';`),
    ).toContain('@/lib/services/hostedRunKeyService');
    expect(importsOf(`const m = await import('./hostedRunKeyService');`)).toContain(
      './hostedRunKeyService',
    );
    for (const bad of [
      `writeFileSync(join(homedir(), '.gitconfig'), x);`,
      `writeFileSync('~/.gitconfig', x);`,
      `mkdirSync(join(home, '.config', 'gh'));`,
      'writeFileSync(`${home}/.config/gh/hosts.yml`, x);',
      `spawnSync('git', ['config', '--global', 'credential.helper', h]);`,
      `execSync('git config --global user.name x');`,
      `spawnSync('gh', ['auth', 'setup-git']);`,
      `spawnSync('gh', ['auth', 'login', '--with-token']);`,
      `execSync('gh auth setup-git');`,
    ]) {
      expect(homeConfigWrites(bad), bad).not.toEqual([]);
    }
    // The run's own files are not the home's, and a comment is not a write.
    for (const fine of [
      'const identity = join(identityDir, `${i}.gitconfig`);',
      `env['GH_CONFIG_DIR'] = join(stateDir, 'gh');`,
      `// the developer's ~/.config/gh is never written`,
      `join(sandboxAgentConfigHome(home), '.config', 'opencode', 'opencode.jsonc');`,
      "throw new CliError('Run `motir auth login` to authenticate.');",
    ]) {
      expect(homeConfigWrites(fine), fine).toEqual([]);
    }
  });
});
