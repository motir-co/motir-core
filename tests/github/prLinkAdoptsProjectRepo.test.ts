import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { GithubRepoNotFoundError } from '@/lib/github/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-10162 · Subtask MOTIR-11040 — linking a pull request records the
// repository it lives in as a `connected` row of the card's project, so the
// project's set stops omitting a repository its own cards ship from.
//
// Real Postgres, the real service arms. The only stub is the GitHub host the
// post-commit check refresh reaches, which is best-effort and not under test.

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
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A workspace with one project and the organisation's connected `acme-api`. */
async function makeScenario(tag: string) {
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
  const providerRepoId = String(98000 + installSeq);
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: `inst-adopt-${installSeq}`,
      accountLogin: `acme-${tag}`,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId,
        owner: `acme-${tag}`,
        name: 'acme-api',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: providerRepoId } });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  return { user, workspace, project, repo, ctx, owner: `acme-${tag}` };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function card(s: Scenario, title: string) {
  return workItemsService.createWorkItem({ projectId: s.project.id, kind: 'task', title }, s.ctx);
}

function linkByCoordinates(s: Scenario, workItemId: string, number: number) {
  return githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId,
      projectId: s.project.id,
      owner: s.owner,
      name: 'acme-api',
      number,
      headRef: `feat/${number}`,
      baseRef: 'main',
      title: `PR ${number}`,
    },
    s.ctx,
  );
}

function projectRows(projectId: string) {
  return adminDb.projectRepo.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
}

/** The fields an adoption must never change on a row it did not write. */
function settledFields(row: {
  state: string;
  role: string;
  seedSource: string;
  name: string;
  position: string;
  label: string | null;
  githubRepoId: string | null;
}) {
  const { state, role, seedSource, name, position, label, githubRepoId } = row;
  return { state, role, seedSource, name, position, label, githubRepoId };
}

function adoptDirectly(s: Scenario, githubRepoId = s.repo.id, name = 'acme-api') {
  return withWorkspaceContext(s.ctx, (tx) =>
    projectRepoSetService.adoptConnectedRepo(
      { projectId: s.project.id, workspaceId: s.workspace.id, githubRepoId, name },
      tx,
    ),
  );
}

describe('the coordinates arm (link_pull_request, the v1 route)', () => {
  it('adds exactly one connected row, after every row the project already held', async () => {
    const s = await makeScenario('coords');
    // A row the project already holds, for a DIFFERENT repository, so the new
    // row's position is measured against something.
    await projectRepoSetService.addRow(s.project.id, { role: 'web', name: 'acme-web' }, s.ctx);
    const item = await card(s, 'Ship it');

    await linkByCoordinates(s, item.id, 1);

    const rows = await projectRows(s.project.id);
    expect(rows).toHaveLength(2);
    const adopted = rows.find((r) => r.githubRepoId === s.repo.id)!;
    expect(adopted).toMatchObject({
      state: 'connected',
      seedSource: 'organization',
      role: 'other',
      label: null,
      name: 'acme-api',
      workspaceId: s.workspace.id,
    });
    expect(rows[rows.length - 1]!.id).toBe(adopted.id);
    expect(adopted.position > rows[0]!.position).toBe(true);
  });

  it('writes no second row for a second pull request or a re-link, and leaves the first row byte-identical', async () => {
    const s = await makeScenario('twice');
    const first = await card(s, 'First');
    const second = await card(s, 'Second');

    await linkByCoordinates(s, first.id, 1);
    const before = settledFields((await projectRows(s.project.id))[0]!);

    await linkByCoordinates(s, second.id, 2);
    await linkByCoordinates(s, first.id, 1);

    const rows = await projectRows(s.project.id);
    expect(rows).toHaveLength(1);
    expect(settledFields(rows[0]!)).toEqual(before);
    expect(await adoptDirectly(s)).toBe('already_listed');
    expect(await adoptDirectly(s)).toBe('already_listed');
    expect(await projectRows(s.project.id)).toHaveLength(1);
  });

  it('writes nothing else: no collaborator row, no github_repo change, one project_repository row', async () => {
    const s = await makeScenario('nothing-else');
    const item = await card(s, 'Ship it');
    const reposBefore = await adminDb.githubRepo.findMany({ orderBy: { id: 'asc' } });
    const collaboratorsBefore = await adminDb.projectRepoCollaborator.count();
    const setRowsBefore = await adminDb.projectRepo.count();

    await linkByCoordinates(s, item.id, 1);

    expect(await adminDb.projectRepoCollaborator.count()).toBe(collaboratorsBefore);
    expect(await adminDb.githubRepo.findMany({ orderBy: { id: 'asc' } })).toEqual(reposBefore);
    expect(await adminDb.projectRepo.count()).toBe(setRowsBefore + 1);
  });

  it('still refuses a repository the organisation does not hold, and writes no row', async () => {
    const s = await makeScenario('unknown');
    const item = await card(s, 'Ship it');

    await expect(
      githubPullRequestService.linkPullRequestByCoordinates(
        {
          workItemId: item.id,
          projectId: s.project.id,
          owner: s.owner,
          name: 'not-connected',
          number: 1,
          headRef: 'feat/x',
          baseRef: 'main',
          title: null,
        },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(GithubRepoNotFoundError);
    expect(await adminDb.projectRepo.count()).toBe(0);
  });

  it("refuses a card in another workspace's project before any set row is written", async () => {
    const s = await makeScenario('home');
    const other = await makeScenario('away');
    const foreign = await card(other, 'Not yours');

    await expect(
      githubPullRequestService.linkPullRequestByCoordinates(
        {
          workItemId: foreign.id,
          projectId: s.project.id,
          owner: s.owner,
          name: 'acme-api',
          number: 1,
          headRef: 'feat/x',
          baseRef: 'main',
          title: null,
        },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(await adminDb.projectRepo.count()).toBe(0);
  });
});

describe("the item page's arm (linkPullRequest)", () => {
  it('adopts on the same terms', async () => {
    const s = await makeScenario('picker');
    const item = await card(s, 'Ship it');
    const pr = await adminDb.githubPullRequest.create({
      data: { repoId: s.repo.id, number: 7, state: 'open', headRef: 'feat/7', baseRef: 'main' },
    });

    await githubPullRequestService.linkPullRequest(item.id, pr.id, s.ctx);

    const rows = await projectRows(s.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      githubRepoId: s.repo.id,
      state: 'connected',
      seedSource: 'organization',
      role: 'other',
      label: null,
      name: 'acme-api',
      workspaceId: s.workspace.id,
    });
  });

  it('an unlink removes the delivery and leaves the project repository in the set', async () => {
    const s = await makeScenario('unlink');
    const item = await card(s, 'Ship it');
    const pr = await adminDb.githubPullRequest.create({
      data: { repoId: s.repo.id, number: 8, state: 'open', headRef: 'feat/8', baseRef: 'main' },
    });
    await githubPullRequestService.linkPullRequest(item.id, pr.id, s.ctx);
    const before = await projectRows(s.project.id);

    const { removed } = await githubPullRequestService.unlinkPullRequest(item.id, pr.id, s.ctx);

    expect(removed).toBe(true);
    expect(await adminDb.workItemDelivery.count({ where: { githubPullRequestId: pr.id } })).toBe(0);
    expect(await projectRows(s.project.id)).toEqual(before);
  });
});

describe('a project that already lists the repository', () => {
  it.each(['proposed', 'created'] as const)('keeps a `%s` row exactly as it was', async (state) => {
    const s = await makeScenario(`listed-${state}`);
    const existing = await adminDb.projectRepo.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        role: 'api',
        name: 'the-api',
        label: 'Ours',
        seedSource: 'starter',
        state,
        position: 'a0',
        githubRepoId: s.repo.id,
      },
    });
    const item = await card(s, 'Ship it');

    await linkByCoordinates(s, item.id, 1);

    const rows = await projectRows(s.project.id);
    expect(rows).toHaveLength(1);
    expect(settledFields(rows[0]!)).toEqual(settledFields(existing));
    expect(await adoptDirectly(s)).toBe('already_listed');
  });
});

describe("a row holding the repository's NAME for something else", () => {
  it('links, writes no row, and leaves the other row untouched', async () => {
    const s = await makeScenario('name-held');
    const holder = await projectRepoSetService.addRow(
      s.project.id,
      { role: 'api', name: 'Acme-API' },
      s.ctx,
    );
    const before = settledFields(
      await adminDb.projectRepo.findUniqueOrThrow({ where: { id: holder.id } }),
    );
    const item = await card(s, 'Ship it');

    const { link } = await linkByCoordinates(s, item.id, 1);

    expect(link).toBeDefined();
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: item.id } })).toBe(1);
    const rows = await projectRows(s.project.id);
    expect(rows).toHaveLength(1);
    expect(settledFields(rows[0]!)).toEqual(before);
    expect(await adoptDirectly(s)).toBe('name_held');
  });
});

describe('the PR merge mode', () => {
  function modeOf(projectId: string) {
    return adminDb.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { prMergeMode: true, prMergeModeDecidedAt: true },
    });
  }

  it('is seeded when the adopted row is what first gives the project a set', async () => {
    const s = await makeScenario('seed');
    expect((await modeOf(s.project.id)).prMergeModeDecidedAt).toBeNull();

    expect(await adoptDirectly(s)).toBe('adopted');

    expect((await modeOf(s.project.id)).prMergeModeDecidedAt).not.toBeNull();
  });

  it('is left alone on a project whose mode was already decided', async () => {
    const s = await makeScenario('decided');
    const decidedAt = new Date('2026-01-01T00:00:00Z');
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { prMergeMode: 'auto', prMergeModeDecidedAt: decidedAt },
    });
    const item = await card(s, 'Ship it');

    await linkByCoordinates(s, item.id, 1);

    expect(await modeOf(s.project.id)).toEqual({
      prMergeMode: 'auto',
      prMergeModeDecidedAt: decidedAt,
    });
    expect(await projectRows(s.project.id)).toHaveLength(1);
  });

  it('is left alone on a project whose set was already established', async () => {
    const s = await makeScenario('established');
    // Another connected repository already established the set, and seeded the
    // mode when it did.
    await adminDb.projectRepo.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        role: 'web',
        name: 'acme-web',
        seedSource: 'organization',
        state: 'connected',
        position: 'a0',
      },
    });
    await withWorkspaceContext(s.ctx, async (tx) => {
      const { projectPrMergeModeService } =
        await import('@/lib/services/projectPrMergeModeService');
      await projectPrMergeModeService.seedAtEstablishment(s.project.id, s.workspace.id, tx);
    });
    const seeded = await modeOf(s.project.id);
    expect(seeded.prMergeModeDecidedAt).not.toBeNull();
    const item = await card(s, 'Ship it');

    await linkByCoordinates(s, item.id, 1);

    expect(await modeOf(s.project.id)).toEqual(seeded);
    expect(await projectRows(s.project.id)).toHaveLength(2);
  });
});

describe('a lost race — both pre-checks miss and the insert meets a conflict', () => {
  // The two reads run before the insert, so a concurrent link can write the row
  // between them. The insert is ON CONFLICT DO NOTHING, so the loser re-reads
  // rather than aborting the caller's transaction, and the link still commits.
  afterEach(() => vi.restoreAllMocks());

  it('answers already_listed when the repository was listed by the winner', async () => {
    const s = await makeScenario('race-repo');
    expect(await adoptDirectly(s)).toBe('adopted');
    vi.spyOn(projectRepoRepository, 'findByProjectAndGithubRepoId').mockResolvedValueOnce(null);
    vi.spyOn(projectRepoRepository, 'findByProjectAndNameInsensitive').mockResolvedValueOnce(null);

    expect(await adoptDirectly(s)).toBe('already_listed');
    expect(await projectRows(s.project.id)).toHaveLength(1);
  });

  it('answers name_held when the winner took the name for another repository', async () => {
    const s = await makeScenario('race-name');
    await projectRepoSetService.addRow(s.project.id, { role: 'api', name: 'acme-api' }, s.ctx);
    vi.spyOn(projectRepoRepository, 'findByProjectAndNameInsensitive').mockResolvedValueOnce(null);

    expect(await adoptDirectly(s)).toBe('name_held');
    expect(await projectRows(s.project.id)).toHaveLength(1);
  });

  it('leaves the caller’s transaction usable after the conflict', async () => {
    const s = await makeScenario('race-tx');
    expect(await adoptDirectly(s)).toBe('adopted');
    vi.spyOn(projectRepoRepository, 'findByProjectAndGithubRepoId').mockResolvedValueOnce(null);
    vi.spyOn(projectRepoRepository, 'findByProjectAndNameInsensitive').mockResolvedValueOnce(null);

    const after = await withWorkspaceContext(s.ctx, async (tx) => {
      const outcome = await projectRepoSetService.adoptConnectedRepo(
        {
          projectId: s.project.id,
          workspaceId: s.workspace.id,
          githubRepoId: s.repo.id,
          name: 'acme-api',
        },
        tx,
      );
      // A statement after the conflict still runs — a caught P2002 would abort here.
      const count = await tx.projectRepo.count({ where: { projectId: s.project.id } });
      return { outcome, count };
    });
    expect(after).toEqual({ outcome: 'already_listed', count: 1 });
  });
});
