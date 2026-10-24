import { adminDb } from './db-reset';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { createTestPerson } from './testPerson';
import { seedGithubInstallation } from './github-seed';
import { E2E_PROVISIONING_ORG } from './github-const';

// THE CARRIED-APPROVAL SEED (Bug MOTIR-5986), for `regression-carried-approval-merges.spec.ts`.
//
// ONE shape: a DESIGN card mid-run in a `manual` project, with work waiting on it and two
// repositories its pull requests will open in. Everything the walk decides is left to the
// product:
//   * the pull requests, their links and their green checks — SIGNED deliveries to the real
//     webhook route and the real link door, driven by the spec;
//   * the design result and its gate — the REAL `publish_design_result` tool over `/api/mcp`,
//     with a token holding exactly `CLI_TOKEN_GRANT` (`design-approval-seed.ts` says why a
//     seeded gate would prove nothing);
//   * the merge — the CI promotion's `pull-request/auto-merge.requested` job, run by the
//     lane's JOB WORKER against the merge seam it installs (`githubMergeSeamEnv`).
//
// ⚠️ `manual`, SET rather than defaulted. In an `auto` project every green merges on its
// own, so a merge after green would prove nothing about the APPROVAL being carried. In
// `manual` the only thing that can dispatch that job is `settleGreenVerdict`'s manual arm —
// an approval pressed before the checks passed (`design-result.md` AMENDMENT 6 Q4).
//
// ⚠️ THE DESIGN CARD STARTS `in_progress`. `design-approval-seed.ts` records why a card at
// `todo` would make an approval move nothing; here it is also the status a run holds while
// its pull requests are open.
//
// ⚠️ THE REPOSITORIES BELONG TO THE PROVISIONING ORG, which is load-bearing: the worker
// mints its installation token with the App the owner selects, and the lane configures
// only the Studio App (`acceptance-gate-seed.ts` records the same fact).

export const CARRIED_APPROVAL_PASSWORD = 'carried-approval-e2e-pass-1';

/** The two repositories the design's pull requests open in, on the shared installation. */
export const CARRY_WEB_REPO = {
  providerRepoId: '88030001',
  owner: E2E_PROVISIONING_ORG,
  name: 'carry-web',
  defaultBranch: 'main',
  archived: false,
} as const;
export const CARRY_API_REPO = {
  providerRepoId: '88030002',
  owner: E2E_PROVISIONING_ORG,
  name: 'carry-api',
  defaultBranch: 'main',
  archived: false,
} as const;

export type CarryRepo = typeof CARRY_WEB_REPO | typeof CARRY_API_REPO;

export const CARRY_TITLES = {
  story: 'Pick a delivery slot at checkout',
  design: 'Redraw the delivery slot picker',
  dependent: 'Build the delivery slot picker',
} as const;

export interface CarriedApprovalSeed {
  ownerEmail: string;
  password: string;
  workspaceId: string;
  /** Exactly `CLI_TOKEN_GRANT` — the grant a dispatched run publishes with. */
  token: string;
  design: { id: string; identifier: string; title: string };
}

export async function seedCarriedApproval(slug: string): Promise<CarriedApprovalSeed> {
  const ownerEmail = `carry-owner-${slug}@example.com`;
  const owner = await createTestPerson({
    email: ownerEmail,
    password: CARRIED_APPROVAL_PASSWORD,
    name: 'Casey Carrier',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Carried approval E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Delivery',
    identifier: 'CARRY',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: 'manual' } });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  await seedGithubInstallation(workspace.id, [CARRY_WEB_REPO, CARRY_API_REPO]);
  // Sequentially — concurrent project-repo appends race on the position key.
  for (const [repo, role] of [
    [CARRY_WEB_REPO, 'web'],
    [CARRY_API_REPO, 'api'],
  ] as const) {
    const row = await adminDb.githubRepo.findFirstOrThrow({
      where: { repoId: repo.providerRepoId },
    });
    await linkProjectRepo({
      workspaceId: workspace.id,
      projectId: project.id,
      githubRepoId: row.id,
      name: row.name,
      role,
    });
  }

  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: CARRY_TITLES.story },
    ctx,
  );
  // Assigned to the owner, so the design question is routed to the person who signs in.
  const design = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: CARRY_TITLES.design,
      parentId: story.id,
      type: 'design',
      assigneeId: owner.id,
    },
    ctx,
  );
  const dependent = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'subtask',
      title: CARRY_TITLES.dependent,
      parentId: story.id,
      type: 'code',
    },
    ctx,
  );
  // Work waiting on the design is what lets a result be published at all.
  await workItemsService.linkWorkItems(
    { fromId: dependent.id, toId: design.id, kind: 'is_blocked_by' },
    ctx,
  );
  await workItemsService.updateStatus(design.id, 'in_progress', ctx);

  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'carried-approval-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    ownerEmail,
    password: CARRIED_APPROVAL_PASSWORD,
    workspaceId: workspace.id,
    token: minted.token,
    design: { id: design.id, identifier: design.identifier, title: CARRY_TITLES.design },
  };
}

/** The head commit a pull request's checks report — stable per number, 40 hex chars. */
export function carryHeadSha(number: number): string {
  return number.toString(16).padStart(8, '0').repeat(5);
}
