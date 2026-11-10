import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import {
  installFakeGh,
  makeCliWorkspace,
  makeLocalRepo,
  writeFakeAgent,
  type CliWorkspace,
  type FakeGh,
  type LocalRepo,
} from '../helpers/cliHarness';
import { randomToken } from '../helpers/random';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';

// STORY-CLOSING suite for MOTIR-2731 — running a work item that ships in more
// than one repository (Subtask MOTIR-3141).
//
// The ASSEMBLED tool, not its modules. `packages/cli/test/**` proves each module
// in isolation with the client, the launcher and git injected; the story's
// vitest gate proves the server seams. Nothing in either proves that a person
// typing `motir run` on a two-repository card ends up with TWO pull requests —
// which is the whole story, and the failure it exists to prevent is the quiet
// one: the agent follows a perfectly actionable instruction, opens one pull
// request, exits 0, and the card sits at In Review forever held by a completion
// gate waiting on a repository nobody was ever told about.
//
//   built `motir` binary ──HTTP──▶ the real /api/v1 routes ──▶ real Postgres
//          ├─ spawns ──▶ a scripted FAKE AGENT that reads $MOTIR_PROMPT_FILE and
//          │             does what the prompt says, in EVERY repository block it
//          │             renders — the directories, the shared branch, each base
//          │             branch and the key all read out of the prompt, never
//          │             supplied by this file
//          └─ shells ──▶ real `git` against real on-disk origins, and a fake
//                        `gh` that records every `pr create`
//
// ⚠️ NO PLAYWRIGHT AND NO ACCEPTANCE VIDEO, deliberately. This story's
// deliverable is a payload, a prompt and terminal output — there is no
// user-observable web surface to film, `plan-rules/kind-story.md` exempts a
// NON-UI story from the acceptance video explicitly, and the story-level
// end-to-end obligation is discharged in the lane that can actually drive the
// flow. A browser spec for a terminal feature would assert nothing.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let server: McpTestServer;
let ws: CliWorkspace;

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
  ws = makeCliWorkspace();
});

async function mintToken(fx: WorkItemFixture): Promise<string> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: `cli-${randomToken(6)}`,
    fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
  });
  return token;
}

async function linkedProject(): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture();
  const token = await mintToken(fx);
  expect((await ws.run(['auth', 'login', '--server', server.url, '--token', token])).exitCode).toBe(
    0,
  );
  expect((await ws.run(['link', '--project', fx.projectIdentifier])).exitCode).toBe(0);
  return fx;
}

/**
 * Connect a repository to the workspace — the registry a pin validates against.
 *
 * ⚠️ `provider` is a parameter because a repository Motir CANNOT DERIVE A CLONE
 * URL FOR is a distinct fixture (MOTIR-3588): a missing checkout whose payload
 * carries a URL is now CLONED before the agent starts, so the "nowhere to go"
 * case survives only for a repository whose location Motir does not know.
 * `repoCloneUrl` returns null for a provider this build cannot address, and the
 * pin still validates — an un-addressable repository stays in the domain.
 */
async function connectRepo(
  fx: WorkItemFixture,
  name: string,
  opts: { provider?: string } = {},
): Promise<string> {
  const provider = opts.provider ?? 'github';
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${provider}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${provider}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider,
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${name}-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
      provider,
    },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name,
  });
  return repo.id;
}

async function card(
  fx: WorkItemFixture,
  title: string,
  targetRepos?: string[],
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title,
      type: 'code',
      ...(targetRepos ? { targetRepos } : {}),
    },
    fx.ctx,
  );
}

/** A MERGED pull request onto that repository's own default branch — what makes
 *  a repository read `delivered` on the next dispatch.
 *
 *  ⚠️ THE LINK IS THE DELIVERY ROW (MOTIR-3757): the completion facts behind
 *  `delivered` come from `work_item_delivery`, and since the drop that is the only
 *  place a link can be written. */
async function recordMerge(repoId: string, workItemId: string, number: number) {
  const row = await adminDb.githubPullRequest.create({
    data: {
      repoId,
      number,
      state: 'closed',
      merged: true,
      headRef: `subtask/pr-${number}`,
      baseRef: 'main',
      mergedAt: new Date('2026-08-19T09:00:00.000Z'),
    },
  });
  const repo = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: repoId } });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: repo.workspaceId,
      workItemId,
      githubPullRequestId: row.id,
      repoId,
    },
  });
}

/**
 * Pull request #1 on `repoId`, OPEN with one passing check — the one the fake `gh` names for
 * that repository's first `pr create`. The run now LINKS the pull request its agent opened and
 * then watches its CI (MOTIR-10877); seeding a green check is what lets that watch end on its
 * first read, as a green build would, instead of waiting on CI that nobody in this harness runs.
 */
async function seedPassingPullRequest(repoId: string): Promise<void> {
  const row = await adminDb.githubPullRequest.create({
    data: { repoId, number: 1, state: 'open', merged: false, headRef: 'seeded', baseRef: 'main' },
  });
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: row.id,
      commitSha: 'abc1234def5678abc1234def5678abc1234def56',
      checkName: 'ci',
      conclusion: 'success',
      conclusionAt: new Date(),
    },
  });
}

interface TwoRepoWorld {
  fx: WorkItemFixture;
  core: LocalRepo;
  ai: LocalRepo;
  coreId: string;
  gh: FakeGh;
}

/** Two REAL repositories, each with its own bare origin, both connected. */
async function twoRepoWorld(): Promise<TwoRepoWorld> {
  const fx = await linkedProject();
  const coreId = await connectRepo(fx, 'motir-core');
  const aiId = await connectRepo(fx, 'motir-ai');
  await seedPassingPullRequest(coreId);
  await seedPassingPullRequest(aiId);
  const core = makeLocalRepo(ws.root, 'motir-core');
  const ai = makeLocalRepo(ws.root, 'motir-ai');
  return { fx, core, ai, coreId, gh: installFakeGh(ws.binDir) };
}

describe('a two-repository card, end to end through the BUILT binary', () => {
  it('names both repositories, opens ONE pull request in EACH, and says it is not done', async () => {
    const { fx, core, ai, gh } = await twoRepoWorld();
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    agent.script([{ perRepoPr: { file: 'half.txt' } }]);
    const item = await card(fx, 'Both halves', ['motir-core', 'motir-ai']);

    const run = await ws.run(['run', item.identifier, '--agent', agent.command]);

    expect(run.exitCode).toBe(0);

    // 1 — the SUMMARY, before the agent starts.
    expect(run.stderr).toContain('2 — this item ships in every one of them');
    expect(run.stderr).toContain('motir-core  (the working directory)');
    expect(run.stderr).toContain('motir-ai  (a sibling checkout)');
    expect(run.stderr).toContain(core.path);
    expect(run.stderr).toContain(ai.path);

    // 2 — the PROMPT the agent received is the one the SERVER returned, and it
    //     carries one block per repository with ONE shared branch name.
    const served = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    const [invocation] = agent.invocations();
    expect(invocation?.promptFromFile).toBe(invocation?.stdin);
    expect(invocation?.cwd).toBe(core.path);
    const branches = [...served.prompt.matchAll(/-b (\S+) origin\//g)].map((m) => m[1]);
    expect(branches).toHaveLength(2);
    expect(new Set(branches).size).toBe(1);

    // 3 — the agent worked in BOTH checkouts, and `gh` recorded TWO pull
    //     requests, one per repository, each title carrying the key.
    const prs = gh.pullRequests();
    expect(prs).toHaveLength(2);
    expect(prs.map((pr) => pr.head)).toEqual([branches[0], branches[0]]);
    for (const pr of prs) expect(pr.title).toContain(item.identifier);
    expect(prs.some((pr) => pr.cwd.includes('motir-core-'))).toBe(true);
    expect(prs.some((pr) => pr.cwd.includes('motir-ai-'))).toBe(true);
    // Real git, real origins: both branches actually exist on their own origin.
    expect(core.hasBranchOnOrigin(branches[0]!)).toBe(true);
    expect(ai.hasBranchOnOrigin(branches[0]!)).toBe(true);
    // …and nothing merged anything.
    expect(gh.invocations().some((c) => c.args[1] === 'merge')).toBe(false);

    // 4 — the SUCCESS output does not tell the operator the card is finished.
    expect(run.stderr).toContain('a pull request is expected in EACH of its 2 repositories');
    expect(run.stderr).toContain("EVERY\nrepository's pull request has merged");
    expect(run.stderr).not.toContain('its pull request should be open');
    expect(run.stderr).not.toContain(`motir done ${item.identifier}`);
  });

  it('RESUMES a partially delivered card — naming what shipped and what is left', async () => {
    // 5 — the middle state, driven through a REAL merge fact rather than a
    //     stubbed one: one repository's pull request merged onto its own
    //     default branch, the other's never opened.
    const { fx, coreId } = await twoRepoWorld();
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    const item = await card(fx, 'Half shipped already', ['motir-core', 'motir-ai']);
    await recordMerge(coreId, item.id, 11);

    const run = await ws.run(['run', item.identifier, '--agent', agent.command]);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('PARTIALLY DELIVERED');
    expect(run.stderr).toContain('already delivered: motir-core');
    expect(run.stderr).toContain('still outstanding: motir-ai');
    expect(run.stderr).toContain(
      'Do not re-open a pull request in a repository that has already merged',
    );
    // The per-repository states are on the lines too, not only in the notice.
    expect(run.stderr).toContain('a pull request has merged onto its default branch');
    expect(run.stderr).toContain('no merged pull request yet');
  });

  it('a MISSING checkout is named with its hint, and the run still dispatches', async () => {
    // 6 — warning, not refusal. The operator is the one who knows whether that
    //     half is already merged or whether their checkout lives elsewhere.
    const fx = await linkedProject();
    await seedPassingPullRequest(await connectRepo(fx, 'motir-core'));
    // ⚠️ Un-addressable ON PURPOSE (MOTIR-3588). A missing checkout Motir CAN
    // clone is now materialized before the agent starts, which is the fix; the
    // half-done run this test is about survives only where there is nothing to
    // clone from, and that is what this provider makes true.
    await connectRepo(fx, 'motir-ai', { provider: 'bitbucket' });
    const core = makeLocalRepo(ws.root, 'motir-core');
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    // The agent must actually PUSH the half it CAN do: MOTIR-3004 refuses to
    // record `implemented` for a run that pushed nothing and returns before the
    // post-condition, so a do-nothing agent would hide the very report this test
    // is about. It fails on `motir-ai` — there is no checkout to enter — which is
    // exactly the half-done run the suspect report exists to name.
    agent.script([{ perRepoPr: { file: 'half.txt' } }]);
    const item = await card(fx, 'One half has nowhere to go', ['motir-core', 'motir-ai']);

    const run = await ws.run(['run', item.identifier, '--agent', agent.command]);

    expect(run.exitCode, run.output).toBe(0);
    expect(existsSync(ws.path('motir-ai'))).toBe(false);
    expect(run.stderr).toContain('no checkout here yet');
    expect(run.stderr).toContain('NOT a blocker');
    expect(run.stderr).toContain('motir link add motir-ai <path>');
    // The agent still ran, in the primary's checkout.
    expect(agent.invocations()[0]?.cwd).toBe(core.path);
    // …and the post-condition names the repository that had nowhere to work.
    expect(run.stderr).toContain('Suspect dispatch');
    expect(run.stderr).toContain('"motir-ai" still has no checkout');
  });
});

describe('the SINGLE-repository control, through the same harness', () => {
  it('produces one pull request and the output it produced before this story', async () => {
    // 7 — every card in the tenant today pins one repository, and none of them
    //     may be able to tell that this shipped.
    const fx = await linkedProject();
    await seedPassingPullRequest(await connectRepo(fx, 'motir-core'));
    const core = makeLocalRepo(ws.root, 'motir-core');
    const gh = installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    agent.script([{ perRepoPr: { file: 'only.txt' } }]);
    const item = await card(fx, 'An ordinary card', ['motir-core']);

    const run = await ws.run(['run', item.identifier, '--agent', agent.command]);

    expect(run.exitCode).toBe(0);
    expect(agent.invocations()[0]?.cwd).toBe(core.path);
    // ONE pull request, and the shipped singular follow-up.
    expect(gh.pullRequests()).toHaveLength(1);
    expect(run.stderr).toContain('its pull request is open');
    expect(run.stderr).toContain(`motir done ${item.identifier}`);
    // …and none of the multi-repository vocabulary appears at all.
    expect(run.stderr).not.toContain('ships in every one of them');
    expect(run.stderr).not.toContain('PARTIALLY DELIVERED');
    expect(run.stderr).toContain('Repo:       motir-core');
  });

  it('an UNPINNED card in a two-repository project still runs at the root, unchanged', async () => {
    const fx = await linkedProject();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    mkdirSync(ws.path('motir-core'), { recursive: true });
    mkdirSync(ws.path('motir-ai'), { recursive: true });
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    const item = await card(fx, 'Motir cannot say');

    const run = await ws.run(['run', item.identifier, '--agent', agent.command]);

    expect(run.exitCode, run.output).toBe(0);
    expect(agent.invocations()[0]?.cwd).toBe(ws.root);
    expect(run.stderr).toContain('not pinned (Motir cannot say)');
    expect(run.stderr).not.toContain('ships in every one of them');
  });
});
