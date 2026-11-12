import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import {
  deferAdoptedRepoRouting,
  githubPullRequestService,
  PULL_REQUEST_LINK_PERMISSION,
} from '@/lib/services/githubPullRequestService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoInitRoutingService } from '@/lib/services/projectRepoInitRoutingService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { GithubRepoNotFoundError } from '@/lib/github/errors';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createTestLink } from '../fixtures/workItemFixtures';

// Story MOTIR-10162 · Subtask MOTIR-11057 — a repository that ENTERS a project's set
// through a pull-request link routes the cards waiting on the init card that
// declared its name, exactly as a repository that settles through the establish
// or connect-existing arms already does.
//
// Real Postgres, both real service arms. The only stub is the GitHub host the
// post-commit check refresh reaches (best-effort, not under test), as in the
// adoption suite this one sits beside. The pass's own rules (a waiter that already
// holds a reference, a finished one, a container) are the routing suite's, and are
// not re-asserted here.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const PASSWORD = 'hunter2hunter2';
let installSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: 1, check_runs: [] }), { status: 200 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * A workspace with one project, the organisation's connected `acme-api`, an init
 * card declaring `declares`, and one childless open leaf blocked by it.
 */
async function makeScenario(tag: string, declares = 'acme-api') {
  installSeq += 1;
  const user = await usersService.createUser({
    email: `${tag}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Acme ${tag}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  const providerRepoId = String(97000 + installSeq);
  const owner = `acme-${tag}`;
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: `inst-route-${installSeq}`,
      accountLogin: owner,
      accountType: 'Organization',
    },
    repos: [{ providerRepoId, owner, name: 'acme-api', defaultBranch: 'main', archived: false }],
  });
  const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: providerRepoId } });
  const ctx = { userId: user.id, workspaceId: workspace.id };

  const init = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: `Create ${declares}` },
    ctx,
  );
  await adminDb.workItem.update({
    where: { id: init.id },
    data: { subject: 'init', initRepositoryName: declares },
  });
  const waiter = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Build the API' },
    ctx,
  );
  await createTestLink({
    workspaceId: workspace.id,
    fromId: waiter.id,
    toId: init.id,
    kind: 'is_blocked_by',
    createdById: user.id,
  });
  return { user, workspace, project, repo, ctx, owner, init, waiter };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

function linkByCoordinates(s: Scenario, workItemId: string, number: number, name = 'acme-api') {
  return githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId,
      projectId: s.project.id,
      owner: s.owner,
      name,
      number,
      headRef: `feat/${number}`,
      baseRef: 'main',
      title: `PR ${number}`,
    },
    s.ctx,
  );
}

function ingestedPr(s: Scenario, number: number) {
  return adminDb.githubPullRequest.create({
    data: {
      repoId: s.repo.id,
      number,
      state: 'open',
      headRef: `feat/${number}`,
      baseRef: 'main',
    },
  });
}

function projectRows(projectId: string) {
  return adminDb.projectRepo.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
}

/** Everything the routing could touch on one card. */
async function snapshot(id: string) {
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  const refs = await adminDb.workItemRepo.findMany({
    where: { workItemId: id },
    orderBy: { position: 'asc' },
  });
  const edges = await adminDb.workItemLink.findMany({ where: { fromId: id } });
  return {
    targetRepo: item.targetRepo,
    targetRepos: item.targetRepos,
    refs: refs.map((r) => ({ id: r.id, projectRepoId: r.projectRepoId, position: r.position })),
    edges: edges.map((e) => ({ id: e.id, toId: e.toId, kind: e.kind, createdAt: e.createdAt })),
  };
}

async function expectRoutedTo(s: Scenario, rowId: string, edgesBefore: unknown) {
  const after = await snapshot(s.waiter.id);
  expect(after.refs.map((r) => [r.projectRepoId, r.position])).toEqual([[rowId, 0]]);
  expect(after.targetRepo).toBe('acme-api');
  expect(after.targetRepos).toEqual(['acme-api']);
  expect(after.edges).toEqual(edgesBefore);
}

/** The warnings this module wrote that name both the project and the repository. */
function namingWarnings(warn: ReturnType<typeof vi.spyOn>, projectId: string, repoId: string) {
  return warn.mock.calls.filter(
    (args: unknown[]) =>
      typeof args[0] === 'string' &&
      args[0].startsWith('[githubPullRequestService]') &&
      args[0].includes(projectId) &&
      args[0].includes(repoId),
  );
}

describe('a link that ADOPTS a repository routes the waiters', () => {
  it('the coordinates arm: one connected row, and the waiter holds one reference at position 0', async () => {
    const s = await makeScenario('coords');
    const edgesBefore = (await snapshot(s.waiter.id)).edges;

    await linkByCoordinates(s, s.init.id, 1);

    const rows = await projectRows(s.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      githubRepoId: s.repo.id,
      state: 'connected',
      seedSource: 'organization',
    });
    await expectRoutedTo(s, rows[0]!.id, edgesBefore);
  });

  it('the picker arm: the same single reference to the same row', async () => {
    const s = await makeScenario('picker');
    const edgesBefore = (await snapshot(s.waiter.id)).edges;
    const pr = await ingestedPr(s, 7);

    await githubPullRequestService.linkPullRequest(s.init.id, pr.id, s.ctx);

    const rows = await projectRows(s.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ githubRepoId: s.repo.id, state: 'connected' });
    await expectRoutedTo(s, rows[0]!.id, edgesBefore);
  });
});

describe('a link that does NOT adopt routes nothing', () => {
  it('leaves an already-listed row byte-identical and the waiter unpinned', async () => {
    const s = await makeScenario('listed');
    // Written directly, so no settle hook ran: had this link's hook fired, the
    // pass would route the waiter to this connected row.
    const existing = await adminDb.projectRepo.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        role: 'api',
        name: 'acme-api',
        seedSource: 'starter',
        state: 'connected',
        githubRepoId: s.repo.id,
        position: 'a0',
      },
    });
    const before = await snapshot(s.waiter.id);
    const route = vi.spyOn(projectRepoInitRoutingService, 'routeInitCardDependents');

    const result = await linkByCoordinates(s, s.init.id, 1);

    expect(result.created).toBe(true);
    expect(await projectRows(s.project.id)).toEqual([existing]);
    expect(await snapshot(s.waiter.id)).toEqual(before);
    expect(route).not.toHaveBeenCalled();
  });

  it('writes no second row when the name is held by another repository, and routes nothing', async () => {
    const s = await makeScenario('name-held');
    await projectRepoSetService.addRow(s.project.id, { role: 'api', name: 'acme-api' }, s.ctx);
    const before = await snapshot(s.waiter.id);

    const result = await linkByCoordinates(s, s.init.id, 1);

    expect(result.link).toBeDefined();
    const rows = await projectRows(s.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.githubRepoId).toBeNull();
    expect(await snapshot(s.waiter.id)).toEqual(before);
  });

  it('a repository the organisation does not hold is still refused, and starts no hook', async () => {
    const s = await makeScenario('unknown');
    const rowsBefore = await adminDb.projectRepo.count();
    const route = vi.spyOn(projectRepoInitRoutingService, 'routeInitCardDependents');

    await expect(linkByCoordinates(s, s.init.id, 1, 'not-ours')).rejects.toBeInstanceOf(
      GithubRepoNotFoundError,
    );

    expect(await adminDb.projectRepo.count()).toBe(rowsBefore);
    expect((await snapshot(s.waiter.id)).refs).toEqual([]);
    expect(route).not.toHaveBeenCalled();
  });

  it('routes nobody when no init card in the project declares the adopted name', async () => {
    const s = await makeScenario('no-match', 'acme-infra');

    await linkByCoordinates(s, s.init.id, 1);

    expect(await projectRows(s.project.id)).toHaveLength(1);
    expect((await snapshot(s.waiter.id)).refs).toEqual([]);
  });
});

describe('the routing is best-effort', () => {
  it('a rejecting pass never fails either arm, and is named once', async () => {
    for (const arm of ['coords', 'picker'] as const) {
      const s = await makeScenario(`fail-${arm}`);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const route = vi
        .spyOn(projectRepoInitRoutingService, 'routeInitCardDependents')
        .mockRejectedValueOnce(new Error('pass down'));

      if (arm === 'coords') {
        const result = await linkByCoordinates(s, s.init.id, 1);
        expect(Object.keys(result).sort()).toEqual(['created', 'link']);
      } else {
        const pr = await ingestedPr(s, 3);
        const dto = await githubPullRequestService.linkPullRequest(s.init.id, pr.id, s.ctx);
        expect(dto.id).toBe(pr.id);
      }
      route.mockRestore();

      const rows = await projectRows(s.project.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('connected');
      expect((await snapshot(s.waiter.id)).refs).toEqual([]);
      expect(namingWarnings(warn, s.project.id, s.repo.id)).toHaveLength(1);
      warn.mockRestore();
    }
  });

  it('a registration with no after-commit scope reads nothing, routes nothing, and is named', async () => {
    const s = await makeScenario('no-scope');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi.spyOn(projectRepoRepository, 'findByProjectAndGithubRepoId');
    const route = vi.spyOn(projectRepoInitRoutingService, 'routeInitCardDependents');
    const rowsBefore = await adminDb.projectRepo.count();

    deferAdoptedRepoRouting(s.project.id, s.repo.id, s.ctx);
    // Nothing was registered, so nothing can still be pending.
    await new Promise((resolve) => setImmediate(resolve));

    expect(read).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(await adminDb.projectRepo.count()).toBe(rowsBefore);
    expect(namingWarnings(warn, s.project.id, s.repo.id)).toHaveLength(1);
  });
});

describe('replay is silent across the joint', () => {
  it('a second pull request and a re-link write no second row and leave the reference byte-identical', async () => {
    const s = await makeScenario('replay');
    const other = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Another' },
      s.ctx,
    );
    await linkByCoordinates(s, s.init.id, 1);
    const routed = await snapshot(s.waiter.id);
    expect(routed.refs).toHaveLength(1);
    const route = vi.spyOn(projectRepoInitRoutingService, 'routeInitCardDependents');

    await linkByCoordinates(s, other.id, 2);
    await linkByCoordinates(s, s.init.id, 1);

    expect(await projectRows(s.project.id)).toHaveLength(1);
    expect(await snapshot(s.waiter.id)).toEqual(routed);
    const pr1 = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repo.id, number: 1 },
    });
    expect(await adminDb.workItemDelivery.count({ where: { githubPullRequestId: pr1.id } })).toBe(
      1,
    );
    expect(route).not.toHaveBeenCalled();
  });
});

describe("neither arm's answer gains a field", () => {
  it('the coordinates arm answers exactly its link and its created flag', async () => {
    const s = await makeScenario('shape-coords');
    const adopted = await linkByCoordinates(s, s.init.id, 1);
    const listed = await linkByCoordinates(s, s.waiter.id, 2);

    expect(Object.keys(adopted).sort()).toEqual(['created', 'link']);
    expect(Object.keys(adopted.link).sort()).toEqual(Object.keys(listed.link).sort());
  });

  it('the picker answers the linked-pull-request DTO and nothing of the adoption', async () => {
    const s = await makeScenario('shape-picker');
    const first = await ingestedPr(s, 5);
    const second = await ingestedPr(s, 6);
    const adopted = await githubPullRequestService.linkPullRequest(s.init.id, first.id, s.ctx);
    const listed = await githubPullRequestService.linkPullRequest(s.waiter.id, second.id, s.ctx);
    const row = (await projectRows(s.project.id))[0]!;

    expect(Object.keys(adopted).sort()).toEqual(Object.keys(listed).sort());
    expect(adopted).not.toHaveProperty('adoption');
    expect(Object.values(adopted)).not.toContain(row.id);
  });
});

describe('the deferred read is workspace-bound and asserts no permission of its own', () => {
  it('a registration made in another workspace never reads this project', async () => {
    const a = await makeScenario('ws-a');
    const b = await makeScenario('ws-b');
    // A's repository is adopted with no hook, so A's waiter is still unpinned.
    await withWorkspaceContext(a.ctx, (tx) =>
      projectRepoSetService.adoptConnectedRepo(
        {
          projectId: a.project.id,
          workspaceId: a.workspace.id,
          githubRepoId: a.repo.id,
          name: 'acme-api',
        },
        tx,
      ),
    );
    const route = vi.spyOn(projectRepoInitRoutingService, 'routeInitCardDependents');

    // Registered in B's transaction, naming A's project and repository.
    await withWorkspaceContext(b.ctx, async () => {
      deferAdoptedRepoRouting(a.project.id, a.repo.id, b.ctx);
    });

    expect(route).not.toHaveBeenCalled();
    expect((await snapshot(a.waiter.id)).refs).toEqual([]);
  });

  it("a link in a second workspace routes only that workspace's waiter", async () => {
    const a = await makeScenario('iso-a');
    const b = await makeScenario('iso-b');

    await linkByCoordinates(b, b.init.id, 1);

    expect((await snapshot(b.waiter.id)).refs).toHaveLength(1);
    expect((await snapshot(a.waiter.id)).refs).toEqual([]);
    expect(await projectRows(a.project.id)).toEqual([]);
  });

  it("the linking actor's one permission is the only one either arm asserts", async () => {
    const s = await makeScenario('perm');
    const assert = vi.spyOn(projectAccessService, 'assertPermission');

    await linkByCoordinates(s, s.init.id, 1);
    const pr = await ingestedPr(s, 9);
    await githubPullRequestService.linkPullRequest(s.waiter.id, pr.id, s.ctx);

    expect((await snapshot(s.waiter.id)).refs).toHaveLength(1);
    expect(assert.mock.calls.map((c) => c[2])).toEqual([
      PULL_REQUEST_LINK_PERMISSION,
      PULL_REQUEST_LINK_PERMISSION,
    ]);
  });
});
