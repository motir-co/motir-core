import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import {
  truncateAuthTables,
  truncateCodeGraphOffboarding,
  truncateJobRuns,
} from '../../helpers/db';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { isOrgAdminForWorkspace } from '@/lib/services/organizationAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE STORY'S GATE — Story MOTIR-4669 · subtask MOTIR-4684.
//
// ⚠️ THIS FILE DELIBERATELY DOES NOT RE-ASSERT WHAT THE CARDS ALREADY OWN, and
// the restraint is the point rather than a shortcut. Each seam below is one NO
// single card's suite could make, because it spans several of them:
//
//   tests/projectRepos/organizationRepoService.test.ts  the add paths, the
//     org-admin gate on each, the double-add 409 by class, both concurrency races
//   tests/projectRepos/twoRemovals.test.ts              the two removals, the
//     access filter on `Used by N projects`, the windowed offboarding
//   tests/github/github-repo-org-rls.test.ts            the org read arms
//   tests/github/githubOrganisationTenancy.test.ts      the backfill + writers
//
// A second copy of a covered claim is not a stronger guarantee; it is two places
// to update when the claim changes, and one of them will be missed. What is HERE:
//
//   1. CONNECT ONCE, LINK TWICE — the story's central claim, end to end across
//      TWO WORKSPACES. It needs MOTIR-4648's dropped index, MOTIR-4649's tenancy
//      column, MOTIR-4677's read arms and MOTIR-4678's service all at once, so no
//      card's own suite can state it.
//   2. THE FULL LIFECYCLE in one arc: link, unlink to ZERO, re-link. The
//      "zero projects is legal" rule is only observable across those three steps.
//   3. CROSS-ORGANISATION isolation with a DIFFERING-POPULATION fixture.
//   4. The two reads the surfaces depend on and no card drove directly.

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;
let repoId: string;
let repoRef: string;
let enqueueSpy: ReturnType<typeof vi.spyOn>;
let offboardSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateCodeGraphOffboarding();
  // `job_run` carries no FK to workspace either, for the same deliberate reason,
  // so a succeeded index row leaks into the next test and turns a `never` into an
  // `indexed`. This file both writes and reads them.
  await truncateJobRuns();
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;

  installationRowId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: orgId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'gitlab',
      },
    })
  ).id;

  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installationRowId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId: 'r-shared',
      owner: 'moooon',
      name: 'motir-core',
      defaultBranch: 'main',
      provider: 'gitlab',
      archived: false,
    },
  });
  repoId = repo.id;
  repoRef = 'moooon/motir-core';

  enqueueSpy = vi.spyOn(codeGraphIndexService, 'enqueueFirstIndexForRepos').mockResolvedValue();
  offboardSpy = vi.spyOn(codeGraphOffboardingService, 'enqueueQuietly');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A SECOND workspace in the SAME organisation, with a project of its own. */
async function secondWorkspace() {
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
  const ctx: ServiceContext = { userId: fx.ownerId, workspaceId: ws.id };
  return { workspaceId: ws.id, projectId: project.id, ctx };
}

describe('⚠️ CONNECT ONCE, LINK TWICE — the story`s central claim, end to end', () => {
  it('one repository, two projects, two WORKSPACES — and the second link costs NOTHING', async () => {
    const second = await secondWorkspace();

    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoId, role: 'api' },
      fx.ctx,
    );
    enqueueSpy.mockClear();

    // The second project is in ANOTHER WORKSPACE of the same organisation. Before
    // this story that was inexpressible — `ProjectRepo.githubRepoId @unique` made
    // it impossible to create — and the repository was connected per workspace, so
    // it would have been a second `GithubRepo` and a second index.
    await organizationRepoService.linkExistingRepo(
      second.projectId,
      { githubRepoId: repoId, role: 'api' },
      second.ctx,
    );

    // TWO project rows…
    const links = await adminDb.projectRepo.findMany({ where: { githubRepoId: repoId } });
    expect(links).toHaveLength(2);
    expect(new Set(links.map((l) => l.workspaceId))).toEqual(
      new Set([fx.workspaceId, second.workspaceId]),
    );

    // …ONE repository…
    expect(await adminDb.githubRepo.count({ where: { repoId: 'r-shared' } })).toBe(1);

    // …and ZERO index enqueues on the second link. This is the number the whole
    // tenancy move exists to remove, asserted where it would have been paid.
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('and the picker OFFERS it to the second project before the link, then stops', async () => {
    const second = await secondWorkspace();

    const before = await organizationRepoService.listAvailableForProject(
      second.projectId,
      second.ctx,
    );
    expect(before.map((o) => o.id)).toContain(repoId);

    await organizationRepoService.linkExistingRepo(
      second.projectId,
      { githubRepoId: repoId, role: 'api' },
      second.ctx,
    );

    const after = await organizationRepoService.listAvailableForProject(
      second.projectId,
      second.ctx,
    );
    expect(after.map((o) => o.id)).not.toContain(repoId);
    // …and it is STILL offered to the first project, which has not taken it.
    const other = await organizationRepoService.listAvailableForProject(fx.projectId, fx.ctx);
    expect(other.map((o) => o.id)).toContain(repoId);
  });
});

describe('⚠️ THE FULL LIFECYCLE — link, unlink to ZERO, re-link', () => {
  it('the repository survives its last project leaving, and re-linking costs nothing', async () => {
    // "Zero projects is a LEGAL state" is only observable across three steps: a
    // one-step test can assert the row is gone, and a two-step test can assert
    // nothing was enqueued — but only the third step shows that the graph was
    // still there to be re-used, which is the whole reason the rule exists.
    // The project WORKS in this repository — the evidence `Used by` reads once
    // the link is gone (MOTIR-4821); see the assertion below for why it is here.
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'work in the repo' });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { targetRepo: 'motir-core', targetRepos: ['motir-core'] },
    });

    const row = await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoId, role: 'api' },
      fx.ctx,
    );
    enqueueSpy.mockClear();
    offboardSpy.mockClear();

    await projectRepoSetService.removeRow(row.id, fx.ctx);

    // ZERO projects, and the repository is still the organisation's.
    expect(await adminDb.projectRepo.count({ where: { githubRepoId: repoId } })).toBe(0);
    expect(await adminDb.githubRepo.findUnique({ where: { id: repoId } })).not.toBeNull();
    expect(offboardSpy).not.toHaveBeenCalled();
    expect(await adminDb.codeGraphOffboarding.count()).toBe(0);

    // …still in the inventory…
    const inventory = await organizationRepoService.listInventory(fx.ctx);
    expect(inventory.map((r) => r.repo.id)).toContain(repoId);
    // `Used by` is the inverse of explicit project links. Removing the final row
    // therefore removes this project from the disclosure even though a legacy
    // work-item name remains; names are not an authorization boundary.
    expect(inventory.find((r) => r.repo.id === repoId)?.projects).toEqual([]);

    // …and re-linking it pays nothing, which is what "legal" was protecting.
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoId, role: 'api' },
      fx.ctx,
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('the ORG disconnect clears BOTH workspaces` links and enqueues `repo_disconnected`', async () => {
    const second = await secondWorkspace();
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoId, role: 'api' },
      fx.ctx,
    );
    await organizationRepoService.linkExistingRepo(
      second.projectId,
      { githubRepoId: repoId, role: 'api' },
      second.ctx,
    );
    offboardSpy.mockClear();

    const result = await organizationRepoService.disconnectFromOrganisation(repoId, fx.ctx);
    expect(result.clearedLinks).toBe(2);

    // The REASON value, not merely that something was enqueued: the reason is what
    // makes the removal windowed rather than immediate, and a wrong one would
    // purge a customer's graph today.
    const pending = await adminDb.codeGraphOffboarding.findMany();
    expect(pending.length).toBeGreaterThan(0);
    expect(new Set(pending.map((p) => p.reason))).toEqual(new Set(['repo_disconnected']));
    expect(new Set(pending.map((p) => p.repoRef))).toEqual(new Set([repoRef]));
  });
});

describe('⚠️ CROSS-ORGANISATION isolation — with a DIFFERING-POPULATION fixture', () => {
  // The fixture property that makes this a real test. If the actor could see
  // everything that exists, a scoped read and an unscoped one return the same
  // rows and BOTH pass — so the population the actor may see is deliberately a
  // STRICT SUBSET of the population that exists. Every assertion below is about
  // the difference.

  async function rivalOrganisation() {
    const org = await adminDb.organization.create({
      data: { name: 'Rival', slug: `rival-${Math.floor(Math.random() * 1_000_000)}` },
    });
    const ws = await adminDb.workspace.create({
      data: {
        organizationId: org.id,
        name: 'Rival ws',
        slug: `rivalws-${Math.floor(Math.random() * 1_000_000)}`,
      },
    });
    const inst = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-rival-${ws.id}`,
        workspaceId: ws.id,
        organizationId: org.id,
        accountLogin: 'rival',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: ws.id,
        organizationId: org.id,
        repoId: 'r-rival',
        owner: 'rival',
        name: 'secrets',
        defaultBranch: 'main',
        provider: 'github',
        archived: false,
      },
    });
    const user = await adminDb.user.create({
      data: {
        email: `rival-${Math.floor(Math.random() * 1_000_000)}@example.com`,
        name: 'Rival owner',
        emailVerified: true,
      },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: ws.id, userId: user.id, workspaceRole: 'manager' },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: org.id, userId: user.id, role: ORGANIZATION_ROLE.owner },
    });
    const project = await createTestProject({
      workspaceId: ws.id,
      actorUserId: user.id,
      identifier: `RIV${Math.floor(Math.random() * 10_000)}`,
    });
    return { organizationId: org.id, workspaceId: ws.id, repoId: repo.id, projectId: project.id };
  }

  it('the inventory shows the actor`s org only, while the rival`s rows EXIST', async () => {
    const rival = await rivalOrganisation();

    // The true population is TWO repositories in two organisations…
    expect(await adminDb.githubRepo.count()).toBe(2);

    // …and the actor sees exactly one.
    const inventory = await organizationRepoService.listInventory(fx.ctx);
    expect(inventory.map((r) => r.repo.id)).toEqual([repoId]);
    expect(inventory.map((r) => r.repo.id)).not.toContain(rival.repoId);
  });

  it('the picker offers nothing from the rival organisation', async () => {
    const rival = await rivalOrganisation();
    const options = await organizationRepoService.listAvailableForProject(fx.projectId, fx.ctx);
    expect(options.map((o) => o.id)).not.toContain(rival.repoId);
  });

  it('a rival`s repository cannot be LINKED, and the refusal leaks nothing', async () => {
    const rival = await rivalOrganisation();
    // Indistinguishable from a fictional id — asserted by class in
    // `organizationRepoService.test.ts`; asserted here as an EFFECT, which is the
    // half that matters across a tenancy boundary.
    await expect(
      organizationRepoService.linkExistingRepo(
        fx.projectId,
        { githubRepoId: rival.repoId, role: 'api' },
        fx.ctx,
      ),
    ).rejects.toBeTruthy();
    expect(await adminDb.projectRepo.count({ where: { githubRepoId: rival.repoId } })).toBe(0);
  });

  it('a rival`s repository cannot be DISCONNECTED — the write half of the boundary', async () => {
    const rival = await rivalOrganisation();
    await expect(
      organizationRepoService.disconnectFromOrganisation(rival.repoId, fx.ctx),
    ).rejects.toBeTruthy();
    // Still there. A refusal that had already cleared a link would be worse than
    // no gate at all, because it would look like a gate.
    expect(await adminDb.githubRepo.findUnique({ where: { id: rival.repoId } })).not.toBeNull();
  });
});

describe('the two reads the SURFACES depend on', () => {
  it('`isOrgAdminForWorkspace` answers the RENDERING question, in both directions', async () => {
    // The room and the org page each draw an affordance or a sentence off this. It
    // returns a boolean rather than throwing, because a caller asking "may I see
    // this?" is not asking about existence.
    expect(await isOrgAdminForWorkspace(fx.ownerId, fx.workspaceId)).toBe(true);

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
    expect(await isOrgAdminForWorkspace(member.id, fx.workspaceId)).toBe(false);
  });

  it('…and returns FALSE for an unresolvable workspace rather than throwing', async () => {
    // A caller error is not an admin. The room renders its no-permission arm,
    // which is the safe answer to a question about an affordance.
    expect(await isOrgAdminForWorkspace(fx.ownerId, 'ws_does_not_exist')).toBe(false);
  });

  it('`listInventory` carries the index state, and claims only what is KNOWN', async () => {
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repoId, role: 'api' },
      fx.ctx,
    );

    const before = await organizationRepoService.listInventory(fx.ctx);
    expect(before.find((r) => r.repo.id === repoId)?.indexState).toBe('never');

    // A succeeded index run is the ONLY thing that moves it, and it moves it to
    // `indexed` — never to `current`, which motir-core cannot know.
    // Mirrors what the real index job writes on success — the same shape
    // `tests/migrate-onboarding/migrate-index-sweep.test.ts` seeds, because both
    // read the same ledger and a fixture that drifts from it tests nothing.
    await adminDb.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: `evt-${Math.floor(Math.random() * 1_000_000)}`,
        lane: 'engine',
        attempt: 0,
        status: 'succeeded',
        finishedAt: new Date(),
        output: { indexed: true, repoRef, projectsIndexed: 1 },
      },
    });
    // …and the settle's stamp on the repository row, the fact the state is read
    // from (`hasBuiltGraph`, Bug MOTIR-10171).
    await adminDb.githubRepo.update({ where: { id: repoId }, data: { indexedAt: new Date() } });

    const after = await organizationRepoService.listInventory(fx.ctx);
    const row = after.find((r) => r.repo.id === repoId);
    expect(row?.indexState).toBe('indexed');
    expect(row?.projects.map((p) => p.id)).toEqual([fx.projectId]);
  });
});
