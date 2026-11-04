import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { runLinkPullRequest } from '@/lib/mcp/tools/linkPullRequest';
import {
  FIND_WORK_ITEMS_FOR_PULL_REQUEST_TOOL_NAME,
  parseGithubPullRequestUrl,
  registerFindWorkItemsForPullRequest,
  runFindWorkItemsForPullRequest,
} from '@/lib/mcp/tools/findWorkItemsForPullRequest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { organizationIdOf } from '../helpers/organizationOf';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import { createTestUser } from '../fixtures/userFixtures';

// MOTIR-10331 — `find_work_items_for_pull_request`, the reverse of
// `link_pull_request`, on real Postgres.
//
// Every case enters at the tool ADAPTER, because the URL parse, the GitHub-only
// narrowing and the typed-error mapping are what an agent meets.
//
// The cases that matter most are the ones a plausible wrong implementation
// passes:
//   - the three `not_linked` reasons are asserted DISTINCT, and none is an error,
//     because the skill stops on each with a different sentence;
//   - a pull request delivering ONLY a sibling workspace's cards (same
//     organisation, so the repository and the pull request DO resolve) answers
//     `no_deliveries` — the tenant gate is the delivery rows, not the repository;
//   - nothing is written: the delivery set is read back unchanged after a call.

const PASSWORD = 'hunter2hunter2';
const OWNER = 'moooon';

interface Scenario {
  ctx: ServiceContext;
  userId: string;
  projectId: string;
  projectKey: string;
  workspaceId: string;
  repo: string;
  repoRowId: string;
}

async function makeScenario(opts: {
  email: string;
  identifier: string;
  repoName: string;
  repoHostId: string;
}): Promise<Scenario> {
  const user = await usersService.createUser({
    email: opts.email,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${opts.identifier}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Project ${opts.identifier}`,
    identifier: opts.identifier,
  });
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-find-pr-${opts.identifier}`,
      workspaceId: null,
      accountLogin: OWNER,
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: workspace.id,
      organizationId: await organizationIdOf(workspace.id),
      repoId: opts.repoHostId,
      owner: OWNER,
      name: opts.repoName,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  return {
    ctx: { userId: user.id, workspaceId: workspace.id },
    userId: user.id,
    projectId: project.id,
    projectKey: opts.identifier,
    workspaceId: workspace.id,
    repo: `${OWNER}/${opts.repoName}`,
    repoRowId: repo.id,
  };
}

async function makeItem(
  ctx: ServiceContext,
  projectId: string,
  title: string,
  kind: 'task' | 'story' = 'task',
): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem({ projectId, kind, title }, ctx);
  return { id: item.id, identifier: item.identifier };
}

async function link(ctx: ServiceContext, repo: string, key: string, number: number) {
  const res = await runLinkPullRequest(
    { key, repository: repo, number, headRef: 'feature/x', baseRef: 'main', title: 'A run' },
    ctx,
  );
  expect(res.isError).toBeFalsy();
}

function structured(res: CallToolResult): Record<string, unknown> {
  return (res.structuredContent ?? {}) as Record<string, unknown>;
}

function text(res: CallToolResult): string {
  return (res.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('\n');
}

const urlOf = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('linked — the cards a pull request delivers', () => {
  it('answers the one card a pull request delivers, with key, title, kind, status and project key', async () => {
    const s = await makeScenario({
      email: 'find-one@example.com',
      identifier: 'FPO',
      repoName: 'core',
      repoHostId: '9801',
    });
    const card = await makeItem(s.ctx, s.projectId, 'Add the export button');
    await link(s.ctx, s.repo, card.identifier, 100);

    const res = await runFindWorkItemsForPullRequest({ url: urlOf(s.repo, 100) }, s.ctx);

    expect(res.isError).toBeFalsy();
    expect(structured(res)).toEqual({
      outcome: 'linked',
      pullRequest: `${s.repo}#100`,
      workItems: [
        {
          key: card.identifier,
          title: 'Add the export button',
          kind: 'task',
          status: expect.any(String),
          projectKey: 'FPO',
        },
      ],
    });
    expect(text(res)).toContain(`${s.repo}#100 delivers 1 card:`);
    expect(text(res)).toContain(card.identifier);
    expect(text(res)).toContain('Add the export button');
  });

  it('answers EVERY card one pull request delivers, in the order they were linked', async () => {
    const s = await makeScenario({
      email: 'find-many@example.com',
      identifier: 'FPM',
      repoName: 'core',
      repoHostId: '9802',
    });
    const story = await makeItem(s.ctx, s.projectId, 'A story run on one branch', 'story');
    const first = await makeItem(s.ctx, s.projectId, 'First card');
    const second = await makeItem(s.ctx, s.projectId, 'Second card');
    await link(s.ctx, s.repo, story.identifier, 200);
    await link(s.ctx, s.repo, first.identifier, 200);
    await link(s.ctx, s.repo, second.identifier, 200);
    // A card on a DIFFERENT pull request of the same repository is not answered.
    const other = await makeItem(s.ctx, s.projectId, 'Someone else');
    await link(s.ctx, s.repo, other.identifier, 201);

    const res = await runFindWorkItemsForPullRequest({ url: `${urlOf(s.repo, 200)}/files` }, s.ctx);

    const items = structured(res).workItems as { key: string; kind: string }[];
    expect(items.map((i) => i.key)).toEqual([
      story.identifier,
      first.identifier,
      second.identifier,
    ]);
    expect(items[0]!.kind).toBe('story');
    expect(text(res)).toContain('delivers 3 cards:');
  });

  it('writes nothing: the delivery set reads the same after a lookup', async () => {
    const s = await makeScenario({
      email: 'find-readonly@example.com',
      identifier: 'FPR',
      repoName: 'core',
      repoHostId: '9803',
    });
    const card = await makeItem(s.ctx, s.projectId, 'A card');
    await link(s.ctx, s.repo, card.identifier, 300);
    const before = await adminDb.workItemDelivery.findMany({ orderBy: { id: 'asc' } });
    const prBefore = await adminDb.githubPullRequest.findMany({ orderBy: { id: 'asc' } });

    await runFindWorkItemsForPullRequest({ url: urlOf(s.repo, 300) }, s.ctx);
    await runFindWorkItemsForPullRequest({ url: urlOf(s.repo, 301) }, s.ctx);

    expect(await adminDb.workItemDelivery.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await adminDb.githubPullRequest.findMany({ orderBy: { id: 'asc' } })).toEqual(prBefore);
  });
});

describe('not_linked — three answers, none of them an error', () => {
  it('a known pull request that delivers no card answers `no_deliveries`', async () => {
    const s = await makeScenario({
      email: 'find-none@example.com',
      identifier: 'FPN',
      repoName: 'core',
      repoHostId: '9804',
    });
    await adminDb.githubPullRequest.create({
      data: {
        repoId: s.repoRowId,
        number: 400,
        title: 'Not linked to anything',
        state: 'open',
        headRef: 'feature/y',
        baseRef: 'main',
        headSha: 'abc123',
      },
    });

    const res = await runFindWorkItemsForPullRequest({ url: urlOf(s.repo, 400) }, s.ctx);

    expect(res.isError).toBeFalsy();
    expect(structured(res)).toEqual({
      outcome: 'not_linked',
      pullRequest: `${s.repo}#400`,
      reason: 'no_deliveries',
    });
    expect(text(res)).toContain('NOT LINKED (no_deliveries)');
    expect(text(res)).toContain('Stop here');
  });

  it('an unknown pull-request number answers `pull_request_unknown`', async () => {
    const s = await makeScenario({
      email: 'find-unknown-pr@example.com',
      identifier: 'FPU',
      repoName: 'core',
      repoHostId: '9805',
    });

    const res = await runFindWorkItemsForPullRequest({ url: urlOf(s.repo, 999) }, s.ctx);

    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({
      outcome: 'not_linked',
      reason: 'pull_request_unknown',
    });
  });

  it('a repository not connected here answers `repository_not_connected`', async () => {
    const s = await makeScenario({
      email: 'find-unknown-repo@example.com',
      identifier: 'FPX',
      repoName: 'core',
      repoHostId: '9806',
    });

    const res = await runFindWorkItemsForPullRequest(
      { url: urlOf(`${OWNER}/not-connected`, 1) },
      s.ctx,
    );

    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({
      outcome: 'not_linked',
      reason: 'repository_not_connected',
    });
    expect(text(res)).toContain('not connected');
  });
});

describe('tenancy — another workspace’s cards never reach the answer', () => {
  it('a sibling workspace in the SAME organisation: the pull request resolves, its cards do not', async () => {
    const s = await makeScenario({
      email: 'find-tenant@example.com',
      identifier: 'FPT',
      repoName: 'core',
      repoHostId: '9807',
    });
    const { workspace: sibling } = await workspacesService.createWorkspace({
      name: 'Sibling workspace',
      ownerUserId: s.userId,
      organizationId: await organizationIdOf(s.workspaceId),
    });
    const siblingCtx: ServiceContext = { userId: s.userId, workspaceId: sibling.id };
    const siblingProject = await projectsService.createProject({
      workspaceId: sibling.id,
      actorUserId: s.userId,
      name: 'Sibling project',
      identifier: 'SIB',
    });
    const secret = await makeItem(siblingCtx, siblingProject.id, 'A sibling workspace card');
    // The pull request is ingested on the repository's own side (as its webhook
    // would), and the SIBLING links its card to it.
    await adminDb.githubPullRequest.create({
      data: { repoId: s.repoRowId, number: 500, state: 'open', headRef: 'feature/z' },
    });
    await link(siblingCtx, s.repo, secret.identifier, 500);

    // From the sibling's own context the card IS delivered — the fixture is real.
    const own = await runFindWorkItemsForPullRequest({ url: urlOf(s.repo, 500) }, siblingCtx);
    expect(structured(own)).toMatchObject({ outcome: 'linked' });

    const res = await runFindWorkItemsForPullRequest({ url: urlOf(s.repo, 500) }, s.ctx);

    expect(res.isError).toBeFalsy();
    expect(structured(res)).toEqual({
      outcome: 'not_linked',
      pullRequest: `${s.repo}#500`,
      reason: 'no_deliveries',
    });
    expect(JSON.stringify(res)).not.toContain(secret.identifier);
    expect(JSON.stringify(res)).not.toContain('A sibling workspace card');
  });

  it('a pull request delivering cards in both workspaces answers only this workspace’s', async () => {
    const s = await makeScenario({
      email: 'find-tenant-mixed@example.com',
      identifier: 'FPW',
      repoName: 'core',
      repoHostId: '9808',
    });
    const { workspace: sibling } = await workspacesService.createWorkspace({
      name: 'Sibling two',
      ownerUserId: s.userId,
      organizationId: await organizationIdOf(s.workspaceId),
    });
    const siblingCtx: ServiceContext = { userId: s.userId, workspaceId: sibling.id };
    const siblingProject = await projectsService.createProject({
      workspaceId: sibling.id,
      actorUserId: s.userId,
      name: 'Sibling project',
      identifier: 'SIC',
    });
    const mine = await makeItem(s.ctx, s.projectId, 'My card');
    const theirs = await makeItem(siblingCtx, siblingProject.id, 'Their card');
    await link(s.ctx, s.repo, mine.identifier, 600);
    await link(siblingCtx, s.repo, theirs.identifier, 600);

    const res = await runFindWorkItemsForPullRequest({ url: urlOf(s.repo, 600) }, s.ctx);

    const items = structured(res).workItems as { key: string }[];
    expect(items.map((i) => i.key)).toEqual([mine.identifier]);
  });
});

describe('refusals', () => {
  it('refuses a caller without `work_item:edit` on the card’s project', async () => {
    const s = await makeScenario({
      email: 'find-viewer@example.com',
      identifier: 'FPV',
      repoName: 'core',
      repoHostId: '9809',
    });
    const card = await makeItem(s.ctx, s.projectId, 'A card');
    await link(s.ctx, s.repo, card.identifier, 700);
    const viewer = await createTestUser({ name: 'viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: s.workspaceId });
    await addToProjectAs({
      key: s.projectKey,
      actorUserId: s.userId,
      ctx: s.ctx,
      targetUserId: viewer.id,
      role: 'viewer',
    });

    const res = await runFindWorkItemsForPullRequest(
      { url: urlOf(s.repo, 700) },
      { userId: viewer.id, workspaceId: s.workspaceId },
    );

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent ?? {})).not.toContain(card.identifier);
  });

  it('refuses a malformed URL and a non-GitHub host as invalid input naming the expected form', async () => {
    const s = await makeScenario({
      email: 'find-bad-url@example.com',
      identifier: 'FPB',
      repoName: 'core',
      repoHostId: '9810',
    });

    for (const url of [
      'not a url',
      `https://github.com/${s.repo}/issues/3`,
      `https://gitlab.com/${s.repo}/pull/3`,
    ]) {
      const res = await runFindWorkItemsForPullRequest({ url }, s.ctx);
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('INVALID_PULL_REQUEST_REF');
      expect(text(res)).toContain('https://github.com/<owner>/<repo>/pull/<number>');
    }
  });
});

describe('the URL parse and the tool’s registry rows', () => {
  it('accepts github.com and www.github.com, with a trailing path, query or fragment', () => {
    expect(parseGithubPullRequestUrl('https://github.com/a/b/pull/7')).toEqual({
      ok: true,
      owner: 'a',
      name: 'b',
      number: 7,
    });
    expect(parseGithubPullRequestUrl('https://www.github.com/a/b/pull/7#discussion')).toMatchObject(
      {
        ok: true,
        number: 7,
      },
    );
    expect(parseGithubPullRequestUrl('https://GitHub.com/a/b/pull/7?x=1')).toMatchObject({
      ok: true,
    });
    expect(parseGithubPullRequestUrl('https://example.com/a/b/pull/7')).toMatchObject({
      ok: false,
    });
  });

  it('is gated on work_item:edit, read-only, and exempt with a reason', () => {
    expect(TOOL_PERMISSIONS.find_work_items_for_pull_request).toBe('work_item:edit');
    expect(TOOL_ANNOTATIONS.find_work_items_for_pull_request).toMatchObject({
      readOnlyHint: true,
    });
    expect(EXEMPT_TOOLS.find_work_items_for_pull_request).toContain('MOTIR-10331');
  });

  it('registers under its name and runs the adapter with the resolved context', async () => {
    const s = await makeScenario({
      email: 'find-register@example.com',
      identifier: 'FPG',
      repoName: 'core',
      repoHostId: '9811',
    });
    let registered:
      | {
          name: string;
          handler: (args: { url: string }, extra: unknown) => Promise<CallToolResult>;
        }
      | undefined;
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered = { name, handler };
      },
    } as unknown as McpServer;
    registerFindWorkItemsForPullRequest(server, () => s.ctx);

    expect(registered?.name).toBe(FIND_WORK_ITEMS_FOR_PULL_REQUEST_TOOL_NAME);
    const res = await registered!.handler({ url: urlOf(s.repo, 1) }, {});
    expect(structured(res)).toMatchObject({
      outcome: 'not_linked',
      reason: 'pull_request_unknown',
    });
  });
});
