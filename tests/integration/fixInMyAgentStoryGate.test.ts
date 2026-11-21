import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentExecResult } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { agentRunLaunchCommand } from '@/lib/agentInstances/terminal';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceRunService, agentRunLaunchKey } from '@/lib/services/agentInstanceRunService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestWorkItem } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { fleet, fx, seedRepo, setUpHarness, tearDownHarness } from '../agentInstances/_harness';
import { agentTerminalRunCommand } from '../../packages/cli/src/commands/agentTerminal';
import {
  AGENT_RUN_COMMANDS,
  parseControlRequest,
  type ControlRequest,
} from '../../packages/cli/src/agentTerminal/control';

// ═══════════════════════════════════════════════════════════════════════════════
// THE STORY GATE — THE SAME AGENT STAYS ON ITS PULL REQUEST (Story MOTIR-8981 · MOTIR-9057)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Each child proved its half with the other side mocked. This file drives the REAL
// writers into the REAL consumers, on a real Postgres and the fake persistent fleet:
//
//   1 · the repair claim admits one fix and refuses the second, under the card's lock;
//   2 · the command a POST writes is the command the agent's terminal is asked for —
//       route → run row → launch job's exec → the CLI's control request → the parser.
//
// The resume / fall-back half is the CLI package's own lane
// (`packages/cli/test/fixInMyAgentStoryGate.test.ts`), because that is where its
// source is measured.
//
// Stubbed, each at a seam the shipped code already exposes: the session and workspace
// context resolvers (the vitest env has no cookies), the fleet's `exec` (the agent's
// terminal server's answers) and the control socket (`deps.request`). No network, no
// Fly, no agent binary, no GitHub.

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
const doorRoute = await import('@/app/api/work-items/[id]/fix-in-my-agent/route');
const resumeRoute = await import('@/app/api/work-items/[id]/agent-runs/resume-target/route');
const autoFixRoute = await import('@/app/api/projects/[key]/agent-auto-fix/route');

const MASTER = 'm'.repeat(48);

function answer(command: readonly string[]): PersistentExecResult {
  const line = command.join(' ');
  const ok = (stdout = ''): PersistentExecResult => ({ exitCode: 0, stdout, stderr: '' });
  if (line === 'motir agent-terminal run --help') return ok();
  if (line.endsWith('motir agent-terminal signin')) {
    return ok(`${JSON.stringify({ profile: 'claude', state: 'signed_in' })}\n`);
  }
  if (line.includes('motir agent-terminal run ')) return ok('{"session":"sess-1"}\n');
  return ok();
}

const temps: string[] = [];

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  fleet.setExecResponder(answer);
  await seedRepo('acme', 'web');
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
});
afterEach(async () => {
  await tearDownHarness();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function agent(name: string): Promise<string> {
  return (await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx)).id;
}

/** A card delivered by one pull request whose only check failed. */
async function redCard() {
  const card = await createTestWorkItem(fx, { kind: 'task', title: `red ${randomToken(4)}` });
  await setStatus(card.id, 'implemented');
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  await deliveredPr(fx, card.id, repo, {
    headRef: `subtask/${card.identifier}`,
    checks: { Vitest: 'failure' },
  });
  return card;
}

const fixRuns = (workItemId: string) =>
  adminDb.dispatchRun.findMany({
    where: { command: 'fix', cards: { some: { workItemId } } },
    orderBy: { startedAt: 'asc' },
  });

let seq = 0;
const press = (key: string, agentInstanceId: string) =>
  workItemRepairService.openAgentRepair(fx.projectId, key, fx.ctx, {
    origin: 'instance',
    agent: 'claude',
    agentInstanceId,
    idempotencyKey: `gate-${++seq}`,
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (key: string, body: unknown) =>
  new Request(`http://test/api/work-items/${key}/agent-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const startVia = (key: string, body: object) => startRoute.POST(post(key, body), params(key));

async function runOf(res: Response) {
  const { dispatchRunId } = (await res.json()) as { dispatchRunId: string };
  return adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dispatchRunId } });
}

/** Run the launch job's handler for a run, as the engine would. */
async function runLaunchJob(dispatchRunId: string): Promise<unknown> {
  const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
  return engineJob('agent-instance-run/launch')!.handler(
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
}

// ── 1 · The claim that admits one fix is the claim that refuses the second ────────

describe('1 · a second fix cannot start while one holds the claim', () => {
  it('claims the first press and answers taken, naming the holder, to the second — one running fix run', async () => {
    const first = await agent('first');
    const second = await agent('second');
    const card = await redCard();

    const opened = await press(card.identifier, first);
    const refused = await press(card.identifier, second);

    expect(opened.outcome).toBe('claimed');
    expect(refused).toMatchObject({ outcome: 'taken', runId: opened.runId });
    expect(refused.holder).not.toBeNull();
    const runs = await fixRuns(card.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: opened.runId, status: 'running', command: 'fix' });
  });

  it('answers mine to the same operator over a local run, and still opens no second run', async () => {
    const card = await redCard();

    const first = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);
    const again = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx);

    expect(first.outcome).toBe('claimed');
    expect(again).toMatchObject({ outcome: 'mine', runId: first.runId });
    expect(await fixRuns(card.id)).toHaveLength(1);
  });

  it('writes no fix run and no run_opened when admit throws — the refusal is under the lock', async () => {
    const card = await redCard();

    await expect(
      workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx, {
        admit: () => {
          throw new Error('not admitted for this class');
        },
      }),
    ).rejects.toThrow('not admitted for this class');

    expect(await fixRuns(card.id)).toEqual([]);
    // The workspace holds no other run, so no `run_opened` at all is the absence asserted.
    expect(
      await adminDb.dispatchRunEvent.count({
        where: { workspaceId: fx.workspaceId, kind: 'run_opened' },
      }),
    ).toBe(0);
  });

  it('reaches the agent-run start as a refusal the presser can render, and opens no second run', async () => {
    const first = await agent('first');
    const second = await agent('second');
    const card = await redCard();

    const won = await startVia(card.identifier, { agentInstanceId: first, command: 'fix' });
    const lost = await startVia(card.identifier, { agentInstanceId: second, command: 'fix' });

    // Distinguishable from success (201) and from a server error (5xx): a 409 whose body
    // is the claim's own answer.
    expect(won.status).toBe(201);
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({
      code: 'agent_run_repair_refused',
      claim: { outcome: 'taken' },
    });
    expect(await fixRuns(card.id)).toHaveLength(1);
  });
});

// ── 2 · One run command never leaks into another ──────────────────────────────────

describe('2 · the launch command carries the settled command', () => {
  it('appends --command only for a fix or a continue, and the three arrays differ', () => {
    const plain = agentRunLaunchCommand('PROD-1', 'run_1');
    const fix = agentRunLaunchCommand('PROD-1', 'run_1', 'fix');
    const cont = agentRunLaunchCommand('PROD-1', 'run_1', 'continue');

    expect(fix).toEqual([...plain, '--command', 'fix']);
    expect(cont).toEqual([...plain, '--command', 'continue']);
    expect(fix).not.toEqual(plain);
    expect(cont).not.toEqual(fix);
    expect(plain).not.toContain('--command');
    // A parent's run is launched like a plain run.
    expect(agentRunLaunchCommand('PROD-1', 'run_1', 'run_scope')).toEqual(plain);
  });
});

describe('2 · the control request refuses what it does not know', () => {
  const run = { op: 'run', runId: 'run_1', workItemKey: 'PROD-1' };

  it('refuses a run with no card key, with or without a command', () => {
    expect(
      parseControlRequest(JSON.stringify({ op: 'run', runId: 'run_1', command: 'fix' })),
    ).toBeNull();
    expect(parseControlRequest(JSON.stringify({ op: 'run', runId: 'run_1' }))).toBeNull();
  });

  it('refuses a command outside run, fix, continue and review rather than coercing it to run', () => {
    expect(AGENT_RUN_COMMANDS).toEqual(['run', 'fix', 'continue', 'review']);
    for (const command of ['run_scope', 'REVIEW', 'FIX', '', 7, null]) {
      expect(parseControlRequest(JSON.stringify({ ...run, command }))).toBeNull();
    }
  });

  it('settles an absent command to run, and keeps a fix and a continue as they are', () => {
    expect(parseControlRequest(JSON.stringify(run))).toMatchObject({ command: 'run' });
    expect(parseControlRequest(JSON.stringify({ ...run, command: 'fix' }))).toMatchObject({
      command: 'fix',
    });
    expect(parseControlRequest(JSON.stringify({ ...run, command: 'continue' }))).toMatchObject({
      command: 'continue',
    });
  });
});

describe('2 · a body with no command keeps working unchanged', () => {
  it('opens run for a childless card and run_scope for a parent, and neither launch names a command', async () => {
    const id = await agent('yue-claude');
    const leaf = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a leaf' },
      fx.ctx,
    );
    const leafRun = await runOf(await startVia(leaf.identifier, { agentInstanceId: id }));
    expect(leafRun.command).toBe('run');
    expect(agentRunLaunchCommand(leaf.identifier, leafRun.id, leafRun.command)).not.toContain(
      '--command',
    );
    await agentInstanceRunService.end(leafRun.id, 'cancelled', 'gate');

    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'a parent' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'its child', parentId: parent.id },
      fx.ctx,
    );
    const parentRun = await runOf(await startVia(parent.identifier, { agentInstanceId: id }));
    expect(parentRun.command).toBe('run_scope');
    expect(agentRunLaunchCommand(parent.identifier, parentRun.id, parentRun.command)).not.toContain(
      '--command',
    );
    await agentInstanceRunService.end(parentRun.id, 'cancelled', 'gate');
  });
});

describe('2 · a command written at the top is read, unchanged, at the bottom', () => {
  it.each(['fix', 'continue'] as const)(
    'travels %s from the POST body to the run row, the launch exec, the control request and the parser',
    async (command) => {
      const id = await agent('yue-claude');
      // A fix needs a red delivery; a continue starts on an ordinary card.
      const card =
        command === 'fix'
          ? await redCard()
          : await workItemsService.createWorkItem(
              { projectId: fx.projectId, kind: 'task', title: 'to continue' },
              fx.ctx,
            );

      const res = await startVia(card.identifier, { agentInstanceId: id, command });
      expect(res.status).toBe(201);
      const run = await runOf(res);
      expect(run.command).toBe(command);

      // The launch job's exec: the argv the agent's machine is asked to run.
      expect(await runLaunchJob(run.id)).toBe('launched');
      const exec = fleet.execs.find((e) => e.command.includes('--run-id'));
      expect(exec).toBeDefined();
      const argv = [...exec!.command];
      expect(argv.slice(-2)).toEqual(['--command', command]);
      expect(argv[argv.indexOf('--run-id') + 1]).toBe(run.id);

      // The CLI that exec runs, fed the flag it was given, asks the terminal server for
      // the same command — through the control socket's own request shape.
      const stateRoot = mkdtempSync(join(tmpdir(), 'gate-9057-'));
      temps.push(stateRoot);
      const sent: ControlRequest[] = [];
      await agentTerminalRunCommand(
        card.identifier,
        { runId: run.id, command: argv[argv.length - 1] as string },
        {
          env: { NODE_ENV: 'test', MOTIR_AGENT_TERMINAL_CONTROL: '/nowhere' },
          readStdin: async () => JSON.stringify({ apiUrl: 'https://app.test', token: 'tok' }),
          stateDir: (runId) => join(stateRoot, runId),
          stdout: () => undefined,
          request: async (_path, request) => {
            sent.push(request);
            return { ok: true, session: 'sess-1' };
          },
        },
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ op: 'run', command, workItemKey: card.identifier });

      // …and the server's parser reads that request as the same command.
      expect(parseControlRequest(JSON.stringify(sent[0]))).toMatchObject({ command });
      await agentInstanceRunService.end(run.id, 'cancelled', 'gate');
    },
  );
});

// ── 3 · A recorded session is the session the next fix is told to resume ───────────

describe('3 · the recorded session reaches the fix run and the door', () => {
  async function priorRun(agentInstanceId: string, workItemKey: string, sessionId: string) {
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin: 'instance',
        agentInstanceId,
        agent: 'claude',
        cards: [{ key: workItemKey, disposition: 'queued' as const }],
      },
      fx.ctx,
    );
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({
      where: { dispatchRunId: run.id },
    });
    await adminDb.dispatchRunEvent.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: run.id,
        dispatchRunCardId: leg.id,
        seq: 101,
        kind: 'agent_exited',
        data: { sessionId },
      },
    });
    await dispatchRunService.close(run.id, { stopReason: 'completed' }, fx.ctx);
    return run;
  }

  it('reads the last run back, offers the door in that agent, and records the resume on the fix run', async () => {
    const id = await agent('yue-claude');
    const card = await redCard();
    const prior = await priorRun(id, card.identifier, 'S-1');

    const target = await resumeRoute.GET(
      new Request('http://test/resume-target'),
      params(card.identifier),
    );
    expect(target.status).toBe(200);
    expect(await target.json()).toMatchObject({
      lastRun: { id: prior.id, sessionId: 'S-1', canResume: true, agent: { id } },
    });

    const offered = await doorRoute.GET(new Request('http://test/door'), params(card.identifier));
    expect(await offered.json()).toMatchObject({ offered: true, agent: { id } });

    const res = await startVia(card.identifier, { agentInstanceId: id, command: 'fix' });
    expect(res.status).toBe(201);
    const run = await runOf(res);
    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: run.id, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({
      command: 'fix',
      resume: { profile: 'claude', sessionId: 'S-1', canResume: true },
    });

    // With the repair open the door stops offering, and says why.
    const held = await doorRoute.GET(new Request('http://test/door'), params(card.identifier));
    expect(await held.json()).toMatchObject({ offered: false, reason: 'repair_open' });
  });

  it('records no session when the last run recorded none', async () => {
    const id = await agent('yue-claude');
    const card = await redCard();
    await dispatchRunService
      .open(
        {
          projectKey: fx.projectIdentifier,
          command: 'run',
          reportedBy: 'cli',
          origin: 'instance',
          agentInstanceId: id,
          agent: 'claude',
          cards: [{ key: card.identifier, disposition: 'queued' as const }],
        },
        fx.ctx,
      )
      .then(({ run }) => dispatchRunService.close(run.id, { stopReason: 'completed' }, fx.ctx));

    const run = await runOf(
      await startVia(card.identifier, { agentInstanceId: id, command: 'fix' }),
    );
    const opened = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: run.id, kind: 'run_opened' },
    });
    expect(opened.data).toMatchObject({ resume: { profile: 'claude', sessionId: null } });
  });

  it('answers a green card as not offered and an unknown key as 404 on the door and the read-back', async () => {
    const green = await createTestWorkItem(fx, { kind: 'task', title: 'green' });
    const door = await doorRoute.GET(new Request('http://test/door'), params(green.identifier));
    expect(door.status).toBe(200);
    expect(await door.json()).toMatchObject({ offered: false });

    const missing = `${fx.projectIdentifier}-99999`;
    expect((await doorRoute.GET(new Request('http://test/door'), params(missing))).status).toBe(
      404,
    );
    expect((await resumeRoute.GET(new Request('http://test/target'), params(missing))).status).toBe(
      404,
    );
  });
});

describe('3 · the project’s auto-fix switch answers over HTTP', () => {
  const withKey = () => ({ params: Promise.resolve({ key: fx.projectIdentifier }) });
  const patch = (body: string) =>
    new Request('http://test/agent-auto-fix', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('reads the switch off, refuses a body that is not a boolean, and leaves it where it was', async () => {
    const read = await autoFixRoute.GET(new Request('http://test/agent-auto-fix'), withKey());
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ agentAutoFixEnabled: false });

    for (const body of ['not json', '[]', '{}', '{"agentAutoFixEnabled":"yes"}']) {
      expect((await autoFixRoute.PATCH(patch(body), withKey())).status).toBe(400);
    }
    const same = await autoFixRoute.PATCH(patch('{"agentAutoFixEnabled":false}'), withKey());
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ agentAutoFixEnabled: false });
  });
});

// ── 4 · The coverage lane names the story's changed surface, and only that ─────────

describe('4 · the story coverage lane', () => {
  const REPO = resolve(__dirname, '..', '..');
  const config = readFileSync(join(REPO, 'vitest.coverage.fix-in-my-agent.config.ts'), 'utf8');
  const globsIn = (block: RegExp) =>
    [...(config.match(block)?.[1] ?? '').matchAll(/^\s*'([^']+\.tsx?)',?$/gm)].map((m) => m[1]!);
  const measured = globsIn(/const MEASURED = \[([\s\S]*?)\n\];/);
  const shared = globsIn(/SHARED_NOT_FLOORED = \[([\s\S]*?)\n\];/);

  it('names each file once — floored or shared, never both', () => {
    expect(measured.length).toBeGreaterThan(0);
    expect(shared.length).toBeGreaterThan(0);
    expect(new Set([...measured, ...shared]).size).toBe(measured.length + shared.length);
  });

  it('spells a route group and a dynamic segment `*`, never `(authed)` or a bracket', () => {
    for (const glob of [...measured, ...shared]) {
      expect(glob, glob).not.toMatch(/[()[\]]/);
    }
  });

  it('lists no CLI path — the CLI package’s own lane measures it', () => {
    for (const glob of [...measured, ...shared]) expect(glob).not.toMatch(/^packages\//);
  });

  it('measures per file at 90 over a suite that runs in the lane, and the script runs the lane', () => {
    expect(config).toContain('perFile: true');
    expect(config).toContain("'tests/integration/fixInMyAgentStoryGate.test.ts'");
    for (const key of ['statements', 'functions', 'branches', 'lines']) {
      expect(config).toContain(`${key}: 90`);
    }
    const scripts = (
      JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['coverage:fix-in-my-agent']).toContain(
      'vitest.coverage.fix-in-my-agent.config.ts',
    );
  });
});
