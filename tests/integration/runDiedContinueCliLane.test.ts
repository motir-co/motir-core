import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { MotirClient } from '../../packages/cli/src/client';
import type { CommandRunner } from '../../packages/cli/src/git';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import { randomToken } from '../helpers/random';
import { setStatus } from '../helpers/repairFixtures';

// THE CLI'S CONTINUE LANE, AGAINST A REAL SERVER (Story MOTIR-6526 · MOTIR-6537).
//
// `packages/cli/test/continueCommand.test.ts` and `continueParent.test.ts` drive
// `motir continue` against a SCRIPTED client — every answer the server would give
// is written in the test. That proves the command's logic and nothing about
// whether the server gives those answers. Here the command runs with the REAL
// `MotirClient`, over a real socket, against the real `/api/v1` route modules on
// real Postgres (`startMcpHttpServer({ v1Routes: true })`): the claim, the
// CONTINUE prompt, the scope claim, the run reporter's appends, heartbeat and close.
//
// Two seams are still scripted, and only these two: the AGENT (a coding agent is
// non-deterministic and needs a provider key) and GIT/GH (there is no remote). The
// session is the CLI's own shape, handed the real client.

const { runAgentMock, sessionRef } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  sessionRef: { current: null as unknown },
}));

vi.mock('../../packages/cli/src/agentRun.js', () => ({ runAgent: runAgentMock }));
vi.mock('../../packages/cli/src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
}));

const { continueCommand } = await import('../../packages/cli/src/commands/continue');

let server: McpTestServer;
let root: string;
/** What the command printed to stderr — the diagnosis a red assertion carries. */
let stderr = '';

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CONFIG_HOME'] = mkdtempSync(join(tmpdir(), 'motir-cfg-'));
  delete process.env['MOTIR_AGENT'];
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async () => ({ exitCode: 0, signal: null, model: null }));
  process.exitCode = undefined;
  root = mkdtempSync(join(tmpdir(), 'motir-continue-lane-'));
  // The ONE-REPO link: `.motir.json` inside the checkout, cards pinned to no repo.
  mkdirSync(join(root, 'repo'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function tokenFor(fx: WorkItemFixture, userId: string): Promise<string> {
  const { token } = await apiTokensService.create(userId, fx.workspaceId, {
    label: `cli-lane-${randomToken()}`,
    projectId: fx.projectId,
    // …and less `repository:manage` (MOTIR-11038): a member's role cannot confer it,
    // and nothing in this chain creates a repository.
    permissions: CLI_TOKEN_GRANT.filter(
      (p) => !p.startsWith('lesson:') && p !== 'repository:manage',
    ),
  });
  return token;
}

/** Ben — the member who runs `motir continue`, with the CLI's session shape. */
async function benSession(fx: WorkItemFixture) {
  const user = await usersService.createUser({
    email: `ben+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Ben Builder',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const client = new MotirClient({ serverUrl: server.url, token: await tokenFor(fx, user.id) });
  sessionRef.current = {
    client,
    serverUrl: server.url,
    projectKey: fx.projectIdentifier,
    link: {
      dir: join(root, 'repo'),
      path: join(root, 'repo', '.motir.json'),
      config: {
        serverUrl: server.url,
        workspace: fx.workspace.slug,
        project: fx.projectIdentifier,
      },
    },
  };
  return user;
}

/**
 * The pull request the continue's agent opened on the dead run's branch (MOTIR-10877): a
 * repository the workspace connected (not pinned to the project, so the card stays unpinned and
 * runs where it ran) with pull request #1, OPEN, and one passing check. The run now LINKS the
 * pull request it finds with `gh pr view` and then watches its CI, so the world it runs in has
 * to hold one — a green one, so the watch ends on its first read as it does on a green build.
 */
const PR_URL = 'https://github.com/moooon/web/pull/1';
async function openedPullRequest(fx: WorkItemFixture, branch: string): Promise<void> {
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${randomToken(8)}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-web-${randomToken(8)}`,
      owner: 'moooon',
      name: 'web',
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 1,
      state: 'open',
      merged: false,
      headRef: branch,
      baseRef: 'main',
    },
  });
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: pr.id,
      commitSha: 'abc1234def5678abc1234def5678abc1234def56',
      checkName: 'ci',
      conclusion: 'success',
      conclusionAt: new Date(),
    },
  });
}

/** git/gh with the dead run's branch on origin, and its open pull request for `gh pr view`. */
function scriptedGit(branch: string, seen: string[]): CommandRunner {
  const worktrees = new Map<string, string>();
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
  return (bin, args, cwd) => {
    seen.push([bin, ...args].join(' '));
    if (bin === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
      return args.some((a) => a.includes(branch))
        ? ok('abc')
        : { exitCode: 1, stdout: '', stderr: '' };
    }
    if (bin === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      const path = args[2] === '--track' ? args[5]! : args[2]!;
      worktrees.set(path, args[2] === '--track' ? args[4]! : args[3]!);
      return ok();
    }
    if (bin === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return ok(worktrees.get(cwd ?? '') ?? branch);
    }
    if (bin === 'git' && args[0] === 'merge-base') return ok();
    if (bin === 'git' && args[0] === 'rev-list') return ok('1');
    if (bin === 'git' && (args[0] === 'ls-remote' || args[0] === 'log')) {
      return ok(`abc123\trefs/heads/${branch}`);
    }
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return args[2] === branch || args[2] === PR_URL
        ? ok(
            JSON.stringify({
              url: PR_URL,
              state: 'OPEN',
              headRefName: branch,
              headRefOid: '',
              baseRefName: 'main',
            }),
          )
        : { exitCode: 1, stdout: '', stderr: 'no pull requests found' };
    }
    return ok();
  };
}

/** A dead LOCAL run opened by the owner (Ada) over `legs`, lapsed ten minutes ago. */
async function deadRun(
  fx: WorkItemFixture,
  opts: {
    legs: { key: string; disposition: 'running' | 'implemented' }[];
    branch: string;
    scopeKey?: string;
  },
) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: opts.scopeKey ? 'run_scope' : 'run',
      reportedBy: 'cli',
      ...(opts.scopeKey ? { scopeKey: opts.scopeKey } : {}),
      cards: opts.legs.map((l) => ({ key: l.key, disposition: 'queued' as const })),
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    opts.legs.map((l) => ({
      kind: 'checkout_ready' as const,
      workItemKey: l.key,
      disposition: l.disposition,
      data: { branch: opts.branch },
    })),
    fx.ctx,
  );
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
  });
  return run.id;
}

describe('motir continue <KEY> — against the real claim and prompt routes', () => {
  it('claims over HTTP, runs the agent on the server’s CONTINUE prompt, and reports on the server’s own run', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Export invoices as CSV' });
    await setStatus(card.id, 'in_progress');
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
    const branch = `subtask/${card.identifier}-export`;
    const deadId = await deadRun(fx, {
      legs: [{ key: card.identifier, disposition: 'running' }],
      branch,
    });
    const ben = await benSession(fx);
    await openedPullRequest(fx, branch);
    const seen: string[] = [];

    await continueCommand(
      card.identifier,
      { agent: 'fake-agent' },
      { run: scriptedGit(branch, seen), maxCiPolls: 1, wait: async () => {} },
    );

    // THE CLAIM went through the server: the dead run is closed, a `continue` run
    // is open by Ben, and the card is his — its status written only by delivery.
    const dead = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: deadId } });
    expect(dead).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });
    const cont = await adminDb.dispatchRun.findFirstOrThrow({
      where: { command: 'continue', cards: { some: { workItemId: card.id } } },
    });
    expect(cont.createdById).toBe(ben.id);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).assigneeId).toBe(
      ben.id,
    );

    // THE PROMPT the agent ran is the SERVER's CONTINUE prompt, naming the branch.
    expect(runAgentMock, stderr).toHaveBeenCalled();
    const prompt = String(runAgentMock.mock.calls[0]![0].prompt);
    expect(prompt).toContain('CONTINUE');
    expect(prompt).toContain(branch);
    // …checked out on the dead run's branch, never a new one.
    expect(seen.some((c) => c.startsWith('git worktree add') && c.includes(branch))).toBe(true);

    // THE REPORTER adopted the server's run: no second run was opened, and the one
    // it reported on is closed.
    expect(
      await adminDb.dispatchRun.count({ where: { cards: { some: { workItemId: card.id } } } }),
    ).toBe(2);
    const closed = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: cont.id } });
    expect(closed.status).not.toBe('running');
    // THE RUN LINKED the pull request its agent opened (MOTIR-10877), with its own credential.
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: card.id } })).toBe(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('a refusal comes back from the server in words, and touches neither git nor the agent', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Never run' });
    await setStatus(card.id, 'in_progress');
    await benSession(fx);
    const seen: string[] = [];

    await continueCommand(
      card.identifier,
      { agent: 'fake-agent' },
      { run: scriptedGit('x', seen) },
    );

    expect(process.exitCode).toBe(1);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe('motir continue <PARENT> — against the real claim, scope and prompt routes', () => {
  it('resumes the dead parent run on its session branch and never re-dispatches the landed child', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Refunds' });
    const landed = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Refund a whole order',
      parentId: story.id,
    });
    const open = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Refund a single line',
      parentId: story.id,
    });
    for (const [id, status] of [
      [story.id, 'in_progress'],
      [landed.id, 'in_progress'],
      [open.id, 'in_progress'],
    ] as const) {
      await setStatus(id, status);
      await adminDb.workItem.update({ where: { id }, data: { assigneeId: fx.ownerId } });
    }
    await setStatus(landed.id, 'implemented');
    const branch = 'motir/auto-20260927-0900';
    await deadRun(fx, {
      scopeKey: story.identifier,
      legs: [
        { key: landed.identifier, disposition: 'implemented' },
        { key: open.identifier, disposition: 'running' },
      ],
      branch,
    });
    const ben = await benSession(fx);
    const seen: string[] = [];

    await continueCommand(
      story.identifier,
      { agent: 'fake-agent' },
      { run: scriptedGit(branch, seen), clock: () => 0, now: () => new Date(0) },
    );

    // The continue run is the PARENT's, and the in-flight child was re-assigned.
    const cont = await adminDb.dispatchRun.findFirstOrThrow({ where: { command: 'continue' } });
    expect(cont).toMatchObject({ scopeWorkItemId: story.id, createdById: ben.id });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: open.id } })).assigneeId).toBe(
      ben.id,
    );
    // Only the NOT-landed child's prompt was run, on the dead run's session branch.
    const childPrompts = runAgentMock.mock.calls
      .map((c) => String(c[0].prompt))
      .filter((p) => p.includes(open.identifier) || p.includes(landed.identifier));
    expect(
      childPrompts.some((p) => p.includes(open.identifier)),
      stderr,
    ).toBe(true);
    expect(childPrompts.every((p) => !p.includes(`# ${landed.identifier}`))).toBe(true);
    expect(seen.some((c) => c.includes(branch))).toBe(true);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: landed.id } })).status).toBe(
      'implemented',
    );
  });
});
