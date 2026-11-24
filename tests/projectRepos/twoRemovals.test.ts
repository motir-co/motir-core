import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { SEED_SOURCE_FLY_STARTER } from '@/lib/projectRepos/vocabulary';
import { adminDb } from '../helpers/adminDb';
import { setProjectAccess } from '../helpers/projectAccess';
import type { ProjectAccessMode } from '@/generated/prisma/client';
import { truncateAuthTables, truncateCodeGraphOffboarding } from '../helpers/db';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { CODE_GRAPH_RETENTION_WINDOW_DAYS } from '@/lib/codeGraph/offboarding';
import {
  GithubRemovalHappensOnGithubError,
  MotirHostedRepoIsTakenOverError,
} from '@/lib/projectRepos/errors';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { OrgForbiddenError } from '@/lib/organizations/errors';
import { withSystemContext } from '@/lib/workspaces/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE TWO REMOVALS — one word, opposite blast radii
// Story MOTIR-4669 · subtask MOTIR-4679.
//
// | | remove from a PROJECT | disconnect from the ORGANISATION |
// |---|---|---|
// | links      | one row              | every project in the org, across workspaces |
// | code graph | NOTHING              | offboarded, `repo_disconnected`, WINDOWED    |
//
// ⚠️ TWO OF THESE ASSERTIONS ARE ABSENCES, and they are the ones worth the file.
// "Nothing was enqueued" and "the graph is still there" are invisible on a
// passing happy path: a project-level remove that quietly offboarded the
// organisation's graph would return 200 and look correct, and the damage would
// surface days later as a repository nobody can plan against. An absence is only
// ever proven by asserting it.
//
// Real Postgres throughout. The enqueue seam is SPIED rather than stubbed away —
// the org-level arm has to be seen to fire, so a blanket mock would make the two
// halves of this file untestable against each other.

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;
let gitlabInstallationRowId: string;
let repoGithub: string;
let repoGitlab: string;
let enqueueSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await truncateAuthTables();
  // `code_graph_offboarding` carries NO FK to workspace — deliberately, because
  // the row exists because the workspace was deleted — so a `TRUNCATE "workspace"
  // CASCADE` never reaches it and a pending row leaks into the next test. This
  // file both writes and counts those rows, so it must clear them itself.
  await truncateCodeGraphOffboarding();
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;

  installationRowId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-gh-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: orgId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
    })
  ).id;
  gitlabInstallationRowId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-gl-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: orgId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'gitlab',
      },
    })
  ).id;

  repoGithub = (await seedRepo(installationRowId, 'github', 'motir-core', 'gh-1')).id;
  repoGitlab = (await seedRepo(gitlabInstallationRowId, 'gitlab', 'motir-gateway', 'gl-1')).id;

  enqueueSpy = vi.spyOn(codeGraphOffboardingService, 'enqueueQuietly');
});

afterEach(() => {
  vi.restoreAllMocks();
  // `GITHUB_FALLBACK_ORG` is stubbed by the hosted-repository arm below and is
  // UNSET everywhere else — which is also the shipped default, so every other
  // assertion in this file runs against a deployment that hosts nothing.
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function seedRepo(
  installationId: string,
  provider: string,
  name: string,
  repoId: string,
  owner = 'moooon',
) {
  return adminDb.githubRepo.create({
    data: {
      installationId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId,
      owner,
      name,
      defaultBranch: 'main',
      provider,
      archived: false,
    },
  });
}

/** A SECOND workspace in the SAME organisation — the org-level arm is about what
 *  crosses a workspace boundary, so a one-workspace fixture cannot see it. */
async function secondWorkspaceInSameOrg(opts: { accessMode?: ProjectAccessMode } = {}) {
  const ws = await adminDb.workspace.create({
    data: {
      organizationId: orgId,
      name: 'Second workspace',
      slug: `ws2-${Math.floor(Math.random() * 1_000_000)}`,
    },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: ws.id, userId: fx.ownerId, workspaceRole: 'manager' },
  });
  const project = await createTestProject({
    workspaceId: ws.id,
    actorUserId: fx.ownerId,
    identifier: `SEC${Math.floor(Math.random() * 10_000)}`,
  });
  if (opts.accessMode) await setProjectAccess(adminDb, project.id, opts.accessMode);
  const ctx: ServiceContext = { userId: fx.ownerId, workspaceId: ws.id };
  return {
    workspaceId: ws.id,
    projectId: project.id,
    projectName: project.name,
    ctx,
    // Enough of a `WorkItemFixture` for `createTestWorkItem`, which reads only
    // the ids, the identifier and the ctx — so `nameOnWork` below can seed work
    // in THIS workspace as well as in the main one.
    fx: {
      ...fx,
      workspace: ws,
      project,
      workspaceId: ws.id,
      projectId: project.id,
      projectIdentifier: project.identifier,
      ctx,
    } as WorkItemFixture,
  };
}

/**
 * NAME a repository on a project's WORK — the evidence the NAMED rung reads
 * (MOTIR-4821). This is what separates a project that has CHOSEN a repository
 * from one that merely MAY REACH it, and it is the only way a set-less project
 * can express the choice at all (`work_item.targetRepos`).
 *
 * Pinned through `adminDb` after the shipped create path has allocated the key
 * and position: the pin is a column this fixture only has to be present, and
 * routing it through the authoring service would drag the whole repo-domain
 * resolver into a test about a disclosure column.
 */
async function nameOnWork(target: { fx: WorkItemFixture }, repoName: string) {
  const item = await createTestWorkItem(target.fx, {
    // A root-level `task`, not a `subtask`: a subtask must have a parent, and the
    // pin is the only thing this fixture is about.
    kind: 'task',
    title: `work on ${repoName}`,
  });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { targetRepo: repoName, targetRepos: [repoName] },
  });
  return item;
}

/** The main fixture's project, in the shape `nameOnWork` takes. */
function mainProject() {
  return { fx };
}

/** Link a repository into a project through the shipped add path. */
async function link(projectId: string, githubRepoId: string, ctx: ServiceContext, name?: string) {
  return organizationRepoService.linkExistingRepo(
    projectId,
    { githubRepoId, role: 'api', ...(name ? { name } : {}) },
    ctx,
  );
}

describe('`Used by N projects` — ONE read, two consumers', () => {
  it('names the projects holding a repository across MORE THAN ONE workspace', async () => {
    const second = await secondWorkspaceInSameOrg();
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    const row = usage.find((u) => u.githubRepoId === repoGitlab);

    expect(row?.repoRef).toBe('moooon/motir-gateway');
    expect(row?.projects).toHaveLength(2);
    expect(new Set(row?.projects.map((p) => p.workspaceId))).toEqual(
      new Set([fx.workspaceId, second.workspaceId]),
    );
    // NAMES, not ids — the dialog enumerates them and the row's expansion shows
    // them, so a consumer must not have to do a second read to render either.
    expect(row?.projects.every((p) => p.name.length > 0)).toBe(true);
  });

  it('reports a repository NO project uses as an empty list — a legal state', async () => {
    // ⚠️ THE FIXTURE NOW HAS TO EARN THE ZERO (MOTIR-4802). It used to be the
    // bare fixture, and that was the DEFECT wearing a passing test: the project
    // has no repository SET, so the ladder's first rung makes every repository
    // connected in its workspace part of its domain, and a zero there was the
    // wrong answer rather than the legal state. Giving the project a set of its
    // own — a project BORN IN MOTIR — is what makes the connected registry stop
    // layering, and the zero real.
    await link(fx.projectId, repoGitlab, fx.ctx);

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    expect(usage.find((u) => u.githubRepoId === repoGithub)?.projects).toEqual([]);
  });

  it('⚠️ the list is ACCESS-FILTERED — a project the viewer may not browse is not named', async () => {
    // The leak this read is shaped to avoid. The row's gate is org MEMBERSHIP
    // (organization-tier.md §6), and an organisation contains projects a given
    // member may not browse; naming one — or counting it — announces its
    // existence to someone with no access to it.
    const second = await secondWorkspaceInSameOrg({ accessMode: 'members' });
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);

    // An org member who belongs to the FIRST workspace only.
    const outsider = await adminDb.user.create({
      data: {
        email: `out-${Math.floor(Math.random() * 1_000_000)}@example.com`,
        name: 'Outsider',
        emailVerified: true,
      },
    });
    await adminDb.workspaceMembership.create({
      data: {
        workspaceId: fx.workspaceId,
        userId: outsider.id,
        workspaceRole: 'member',
      },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: outsider.id, role: ORGANIZATION_ROLE.member },
    });

    const usage = await organizationRepoService.listRepositoryUsage({
      userId: outsider.id,
      workspaceId: fx.workspaceId,
    });
    const row = usage.find((u) => u.githubRepoId === repoGitlab);

    expect(row?.projects.map((p) => p.id)).toEqual([fx.projectId]);
    // …and THE COUNT IS THE LIST'S LENGTH. A `count: 2` beside one name would be
    // the same disclosure, arriving as a number instead of a word.
    expect(row?.projects).toHaveLength(1);
  });

  it('the OWNER sees both — so the filter above is the ACCESS, not the fixture', async () => {
    const second = await secondWorkspaceInSameOrg({ accessMode: 'members' });
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    expect(usage.find((u) => u.githubRepoId === repoGitlab)?.projects).toHaveLength(2);
  });
});

// ⚠️ ACCESS IS NOT LIFECYCLE (MOTIR-5131). `listRepositoryUsage` had exactly one
// filter in it — `filterBrowsable` — and it answers *may this actor SEE the
// project*, never *is the project still alive*. The two narrow a list for
// similar-sounding reasons, which is why two earlier corrections to this same
// sentence (MOTIR-4955, MOTIR-4997) both went past it: a reviewer checking that
// the list is filtered finds a filter and moves on.
//
// The cost lands on the DISCONNECT dialog, which enumerates who is affected by a
// destructive act. Naming a project archived months ago inflates the blast radius
// and teaches the reader that the list is approximate — the one property a
// confirmation dialog cannot afford.
describe('`Used by N projects` — an ARCHIVED project is not a user (MOTIR-5131)', () => {
  /** A second live project in the MAIN workspace, so the archive is not the last-project case. */
  async function siblingProject(identifier: string) {
    const project = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: `Sibling ${identifier}`,
      identifier,
    });
    return project;
  }

  async function archive(projectId: string) {
    await projectsService.archiveProject({
      projectId,
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
    });
    // Archive enqueues its own windowed offboarding; this file counts enqueues.
    enqueueSpy.mockClear();
  }

  it('a repository linked to two live projects and one archived reports TWO', async () => {
    const live = await siblingProject('LIVE');
    const dead = await siblingProject('DEAD');
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(live.id, repoGitlab, fx.ctx, 'gw-live');
    await link(dead.id, repoGitlab, fx.ctx, 'gw-dead');

    const before = await organizationRepoService.listRepositoryUsage(fx.ctx);
    expect(before.find((u) => u.githubRepoId === repoGitlab)?.projects).toHaveLength(3);

    await archive(dead.id);

    const after = await organizationRepoService.listRepositoryUsage(fx.ctx);
    const row = after.find((u) => u.githubRepoId === repoGitlab);
    expect(row?.projects).toHaveLength(2);
    expect(new Set(row?.projects.map((p) => p.id))).toEqual(new Set([fx.projectId, live.id]));
  });

  it('⚠️ BOTH consumers narrow together — the inventory row and the dialog read ONE list', async () => {
    // `listInventory` composes `listRepositoryUsage` precisely so the count a
    // person reads at rest and the names the dialog enumerates cannot disagree.
    // Fixing the count at the call site would have restored the number and
    // quietly broken that property, so it is asserted on both consumers rather
    // than on the one that was reported.
    const live = await siblingProject('LIVE');
    const dead = await siblingProject('DEAD');
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(live.id, repoGitlab, fx.ctx, 'gw-live');
    await link(dead.id, repoGitlab, fx.ctx, 'gw-dead');
    await archive(dead.id);

    const [usage, inventory] = await Promise.all([
      organizationRepoService.listRepositoryUsage(fx.ctx),
      organizationRepoService.listInventory(fx.ctx),
    ]);
    const usageRow = usage.find((u) => u.githubRepoId === repoGitlab);
    const inventoryRow = inventory.find((r) => r.repo.id === repoGitlab);

    expect(inventoryRow?.projects.map((p) => p.id)).toEqual(usageRow?.projects.map((p) => p.id));
    expect(inventoryRow?.projects).toHaveLength(2);
    expect(inventoryRow?.projects.map((p) => p.id)).not.toContain(dead.id);
  });

  it('the `project_repository` LINK survives the archive — only the reading of it changes', async () => {
    // `ProjectRepo.githubRepo` is `onDelete: SetNull` precisely so a project's
    // plan for a repository outlives the connection. The data is correct and this
    // card must not start deleting anything: the product has no un-archive path,
    // so a deletion here would be as irreversible as the archive that caused it.
    const dead = await siblingProject('DEAD');
    await link(dead.id, repoGitlab, fx.ctx, 'gw-dead');
    await archive(dead.id);

    const links = await adminDb.projectRepo.findMany({ where: { projectId: dead.id } });
    expect(links).toHaveLength(1);
    expect(links[0]?.githubRepoId).toBe(repoGitlab);
  });

  it('⚠️ the DISCONNECT still clears and offboards the ARCHIVED project — the dialog narrows, the ACT does not', async () => {
    // THE REASON THE PREDICATE IS NOT ON `findManyByIds`. Its other caller is
    // `disconnectFromOrganisation`, whose enumeration drives the link clear AND
    // the code-graph offboarding — and an archived project's graph still exists.
    // Filtering it there would leave that graph an unreachable orphan, which is
    // the exact failure `code-graph-index-fleet.md` §14.3 and MOTIR-2166 are
    // about. So the two callers read DIFFERENT methods, deliberately.
    const dead = await siblingProject('DEAD');
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(dead.id, repoGitlab, fx.ctx, 'gw-dead');
    await archive(dead.id);

    // The dialog has already stopped naming it…
    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    expect(usage.find((u) => u.githubRepoId === repoGitlab)?.projects).toHaveLength(1);

    // …and the act still reaches it.
    const result = await organizationRepoService.disconnectFromOrganisation(repoGitlab, fx.ctx);
    expect(result.clearedLinks).toBe(2);
    expect(enqueueSpy).toHaveBeenCalled();
    const offboardedProjectIds = enqueueSpy.mock.calls.flatMap(
      (call: unknown[]) => (call[0] as { coreProjectIds: string[] }).coreProjectIds,
    );
    expect(offboardedProjectIds).toContain(dead.id);
  });
});

// A work-item name was the last indirect membership heuristic. It is migration
// evidence only; after rollout, the explicit link is the sole runtime answer.
describe('`Used by N projects` — explicit links are the only membership evidence', () => {
  it('does not infer membership from a work-item name in a set-less project', async () => {
    await nameOnWork(mainProject(), 'motir-core');

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    expect(usage.find((u) => u.githubRepoId === repoGithub)?.projects).toEqual([]);
  });
});

describe('REMOVE FROM A PROJECT — and it must do almost nothing', () => {
  it('deletes exactly one row and enqueues NOTHING', async () => {
    const second = await secondWorkspaceInSameOrg();
    const mine = await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);
    enqueueSpy.mockClear();

    await projectRepoSetService.removeRow(mine.id, fx.ctx);

    expect(await adminDb.projectRepo.count({ where: { projectId: fx.projectId } })).toBe(0);
    // THE assertion. A project-level remove that offboarded would look identical
    // from the outside and cost the organisation its graph.
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('leaves the organisation`s connection, the mirror row, and the OTHER projects untouched', async () => {
    const second = await secondWorkspaceInSameOrg();
    const mine = await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);

    await projectRepoSetService.removeRow(mine.id, fx.ctx);

    // the mirror row — the organisation's connection
    expect(await adminDb.githubRepo.findUnique({ where: { id: repoGitlab } })).not.toBeNull();
    // …and the other project's link, unchanged
    const others = await adminDb.projectRepo.findMany({ where: { projectId: second.projectId } });
    expect(others).toHaveLength(1);
    expect(others[0]?.githubRepoId).toBe(repoGitlab);
    // …and no pending offboarding anywhere
    expect(await adminDb.codeGraphOffboarding.count()).toBe(0);
  });

  it('⚠️ removing the LAST project`s link leaves the repository in the inventory, indexed', async () => {
    // The case the wrong optimisation targets, asserted BY NAME so nobody has to
    // infer that it was considered. "Nothing uses it any more, so drop the graph"
    // re-introduces per-project ownership through the back door and makes the
    // next project that adds it pay for a full re-index.
    const only = await link(fx.projectId, repoGitlab, fx.ctx);
    enqueueSpy.mockClear();

    await projectRepoSetService.removeRow(only.id, fx.ctx);

    expect(await adminDb.githubRepo.findUnique({ where: { id: repoGitlab } })).not.toBeNull();
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(await adminDb.codeGraphOffboarding.count()).toBe(0);

    // …and it is offered back to the same project, at no cost.
    const options = await organizationRepoService.listAvailableForProject(fx.projectId, fx.ctx);
    expect(options.map((o) => o.id)).toContain(repoGitlab);
  });
});

describe('DISCONNECT FROM THE ORGANISATION — the cascade', () => {
  it('clears every project`s link ACROSS workspaces and enqueues one windowed offboarding', async () => {
    const second = await secondWorkspaceInSameOrg();
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);
    enqueueSpy.mockClear();

    const result = await organizationRepoService.disconnectFromOrganisation(repoGitlab, fx.ctx);

    expect(result.clearedLinks).toBe(2);

    // Every project lost the repository — in BOTH workspaces.
    const rows = await adminDb.projectRepo.findMany({
      where: { projectId: { in: [fx.projectId, second.projectId] } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.githubRepoId === null)).toBe(true);

    // The mirror row is gone…
    expect(await adminDb.githubRepo.findUnique({ where: { id: repoGitlab } })).toBeNull();

    // …and the offboarding is enqueued with the REASON that makes it windowed.
    const reasons = enqueueSpy.mock.calls.map(
      (c: unknown[]) => (c[0] as { reason: string }).reason,
    );
    expect(new Set(reasons)).toEqual(new Set(['repo_disconnected']));

    const pending = await withSystemContext((tx) => tx.codeGraphOffboarding.findMany());
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => p.reason === 'repo_disconnected')).toBe(true);
    expect(new Set(pending.map((p) => p.repoRef))).toEqual(new Set(['moooon/motir-gateway']));
  });

  it('the removal is WINDOWED, not immediate — `dueAt` is the retention window away', async () => {
    // What makes the promise in the copy true. An immediate purge would bill a
    // user for their own misclick, because a re-index is a metered container per
    // (repo × project).
    await link(fx.projectId, repoGitlab, fx.ctx);
    const before = Date.now();
    await organizationRepoService.disconnectFromOrganisation(repoGitlab, fx.ctx);

    const [row] = await withSystemContext((tx) => tx.codeGraphOffboarding.findMany());
    const windowMs = CODE_GRAPH_RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    expect(row!.dueAt.getTime()).toBeGreaterThan(before + windowMs - 60_000);
  });

  it('⚠️ REFUSES a GitHub repository — Motir cannot remove one, and must not pretend to', async () => {
    // Not a permission refusal. Selection is the App's install screen; a
    // Motir-side "stop tracking" would delete the mirror row while leaving the
    // grant in place, and the repository would reappear on the next reconcile.
    await link(fx.projectId, repoGithub, fx.ctx);
    enqueueSpy.mockClear();

    await expect(
      organizationRepoService.disconnectFromOrganisation(repoGithub, fx.ctx),
    ).rejects.toBeInstanceOf(GithubRemovalHappensOnGithubError);

    // Refused means untouched — the mirror row, the link, and the queue.
    expect(await adminDb.githubRepo.findUnique({ where: { id: repoGithub } })).not.toBeNull();
    const [row] = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(row?.githubRepoId).toBe(repoGithub);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('⚠️ REFUSES a repository MOTIR HOSTS, and names the TAKEOVER as the act (bug MOTIR-4892)', async () => {
    // ⚠️ THE ORDER IS THE FIX, so the assertion is about WHICH refusal arrives.
    // `GithubRemovalHappensOnGithubError` is thrown for EVERY `github` row before
    // any ownership test, and its instruction — *change the Motir App's repository
    // access on GitHub* — points at the ORGANISATION's own installation. A
    // repository under the provisioning organisation is not in that installation:
    // it sits under the SHARED provisioning one, which is `organizationId: null`
    // because it spans tenants. So the refusal that existed was about the PROVIDER
    // and the one that was owed is about the OWNER.
    //
    // Asserted on the SERVICE, deliberately — the surface withholds the control
    // (`organizationGitPage.test.tsx`), and this is the half that holds for a
    // caller that never rendered the page.
    //
    // The env value's casing deliberately differs from the row's: a GitHub login
    // is case-insensitive and `GITHUB_FALLBACK_ORG` is whatever an operator typed.
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'Motir-Projects');
    const hosted = await seedRepo(
      installationRowId,
      'github',
      'motir',
      'gh-hosted',
      'motir-projects',
    );
    // Held the way the creation primitive leaves it — a project's `created` row.
    // `linkExistingRepo` no longer links a repository Motir hosts (MOTIR-12192).
    await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: 'api',
        name: 'hosted',
        seedSource: SEED_SOURCE_FLY_STARTER,
        state: 'created',
        githubRepoId: hosted.id,
        position: 'a0',
      },
    });
    enqueueSpy.mockClear();

    const err = await organizationRepoService.disconnectFromOrganisation(hosted.id, fx.ctx).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MotirHostedRepoIsTakenOverError);
    expect(err).not.toBeInstanceOf(GithubRemovalHappensOnGithubError);
    expect((err as MotirHostedRepoIsTakenOverError).code).toBe('MOTIR_HOSTED_REPO_IS_TAKEN_OVER');
    // It names the act that DOES apply — the takeover (MOTIR-711) — rather than
    // sending the reader to an installation the repository is not in.
    expect((err as Error).message).toMatch(/take it over/i);
    expect((err as Error).message).not.toMatch(/App's repository access/i);

    // Refused means untouched — the mirror row, the link, and the queue.
    expect(await adminDb.githubRepo.findUnique({ where: { id: hosted.id } })).not.toBeNull();
    const rows = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(rows.some((r) => r.githubRepoId === hosted.id)).toBe(true);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('⚠️ classifies NOTHING with no provisioning org configured — the refusal is byte-for-byte today`s', async () => {
    // The null-safe arm. A deployment that cannot provision (self-hosted, no
    // `GITHUB_FALLBACK_ORG`) hosts nothing, so the SAME row that is refused above
    // falls through to the provider refusal exactly as it did before this rule
    // existed. Asserted so the new gate cannot silently widen.
    const hosted = await seedRepo(
      installationRowId,
      'github',
      'motir',
      'gh-hosted-2',
      'motir-projects',
    );
    await link(fx.projectId, hosted.id, fx.ctx, 'hosted-2');

    await expect(
      organizationRepoService.disconnectFromOrganisation(hosted.id, fx.ctx),
    ).rejects.toBeInstanceOf(GithubRemovalHappensOnGithubError);
  });

  it('is ORG-ADMIN — a plain org member is refused and nothing is cleared', async () => {
    const member = await adminDb.user.create({
      data: {
        email: `m-${Math.floor(Math.random() * 1_000_000)}@example.com`,
        name: 'Member',
        emailVerified: true,
      },
    });
    await adminDb.workspaceMembership.create({
      data: {
        workspaceId: fx.workspaceId,
        userId: member.id,
        workspaceRole: 'manager',
      },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: member.id, role: ORGANIZATION_ROLE.member },
    });
    await link(fx.projectId, repoGitlab, fx.ctx);
    enqueueSpy.mockClear();

    await expect(
      organizationRepoService.disconnectFromOrganisation(repoGitlab, {
        userId: member.id,
        workspaceId: fx.workspaceId,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);

    const [row] = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(row?.githubRepoId).toBe(repoGitlab);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

describe('the GITHUB arm arrives through the WEBHOOK, not through Motir', () => {
  it('a repository dropped from the SELECTION is pruned and enqueued by the reconcile', async () => {
    // The shipped `installation_repositories` path, driven directly. This is what
    // the refusal above defers TO, and asserting it is what makes the refusal a
    // routing decision rather than a missing feature.
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: `inst-gh-${fx.workspaceId}`,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: 'gh-1',
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    enqueueSpy.mockClear();

    // The next delivery selects NOTHING — the user de-selected it on GitHub.
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: `inst-gh-${fx.workspaceId}`,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [],
    });

    // The mirror row is gone, and the graph is queued with the SAME reason the
    // org-level arm uses — one vocabulary, two doors.
    expect(await adminDb.githubRepo.findFirst({ where: { repoId: 'gh-1' } })).toBeNull();
    const pending = await withSystemContext((tx) => tx.codeGraphOffboarding.findMany());
    expect(pending.map((p) => p.reason)).toEqual(['repo_disconnected']);
  });
});

describe('the retention window is INTERPOLATED, never retyped', () => {
  // `lib/codeGraph/offboarding.ts` states the rule on itself: one named constant,
  // interpolated into the copy that states it, "so the promise and the behaviour
  // cannot drift." A product that says 30 days in a dialog and enforces something
  // else has expressed its enforcement in terms it does not control.
  const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as Record<string, unknown>;
  const github = (en['github'] as Record<string, Record<string, string>>) ?? {};

  it('every retention string this story adds carries `{days}`', () => {
    expect(github['orgDisconnect']?.['codeIndex']).toContain('{days}');
  });

  it('NO retention string hard-codes the number', () => {
    const strings = [
      ...Object.values(github['orgDisconnect'] ?? {}),
      ...Object.values(github['projectRemove'] ?? {}),
      github['repos']?.['codeIndex'] ?? '',
    ];
    const hardCoded = strings.filter((s) =>
      new RegExp(`\\b${CODE_GRAPH_RETENTION_WINDOW_DAYS}\\b`).test(s),
    );
    expect(hardCoded, 'interpolate CODE_GRAPH_RETENTION_WINDOW_DAYS as {days}').toEqual([]);
  });

  it('the PROJECT-level copy promises the opposite, and says so', () => {
    // The two removals share a word; their copy must not. This one REASSURES —
    // it is the only place in the product where "removes" is the harmless act.
    const body = github['projectRemove']?.['body'] ?? '';
    expect(body).toContain('only');
    expect(body).toContain('code index is untouched');
    expect(body).not.toContain('{days}');
  });
});
