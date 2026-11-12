import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { createTestPerson } from './testPerson';
import { seedGithubInstallation } from './github-seed';
import { E2E_PROVISIONING_ORG } from './github-const';

// THE APPROVE-AND-MERGE E2E SEED (Story MOTIR-4909 · Subtask MOTIR-5487), for the walk
// `cloud-approve-and-merge.spec.ts` drives (the story's receipt, promoted to the cloud lane by
// Story MOTIR-7460 — docs/acceptance-lane-triage.md § MOTIR-7460).
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS LEFT TO THE SPEC:
//   * the people, workspace, project, membership and cards — their services;
//   * the GitHub installation and BOTH repositories — `seedGithubInstallation`, the shipped
//     `persistInstallation`, as every GitHub E2E seeds it;
//   * the How to test record on the first card — `testInstructionsService.publish`;
//   * the pull requests, their links, their green checks, the approve-and-merge gate and
//     every merge — NOT seeded. The spec drives them through the REAL webhook route and the
//     REAL link door, so the gate the walk decides is the one the product raised.
//
// ⚠️ THE REPOSITORIES BELONG TO THE PROVISIONING ORG, and that is load-bearing. A merge mints
// its installation token with the App the repository's owner selects
// (`githubAppRoleForRepo`), and the acceptance lane configures ONLY the provisioning App
// (`GITHUB_STUDIO_APP_ID` / `_PRIVATE_KEY`). A repository owned by the default E2E
// account would select the user-facing App the lane does not configure, and every press
// would fail before it reached the merge seam.
//
// ⚠️ PLAIN MEMBERS, not admins, for the one person who must NOT be able to decide: the gate's
// admin arm is read off the WORKSPACE role, so an admin bystander would be offered the verbs.

export const APPROVE_AND_MERGE_PASSWORD = 'approve-and-merge-e2e-pass-4';

/** The two repositories every card delivers into, on the shared E2E installation. */
export const WEB_REPO = {
  providerRepoId: '88010001',
  owner: E2E_PROVISIONING_ORG,
  name: 'amerge-web',
  defaultBranch: 'main',
  archived: false,
} as const;
export const API_REPO = {
  providerRepoId: '88010002',
  owner: E2E_PROVISIONING_ORG,
  name: 'amerge-api',
  defaultBranch: 'main',
  archived: false,
} as const;

export type SeedRepo = typeof WEB_REPO | typeof API_REPO;

export interface SeededCard {
  id: string;
  identifier: string;
  title: string;
}

export interface ApproveAndMergeSeed {
  ownerEmail: string;
  ownerName: string;
  bystanderEmail: string;
  password: string;
  workspaceId: string;
  projectId: string;
  /** Pressed, merged, finished by the merge webhooks. Its REPORTER is the bystander. */
  merged: SeededCard;
  /** One pull request joins its repository's merge queue. */
  queued: SeededCard;
  /** One pull request is refused, then retried. */
  refused: SeededCard;
  /** Walked in `zh`. */
  zh: SeededCard;
}

const OWNER_NAME = 'Olive Owner';

export async function seedApproveAndMerge(slug: string): Promise<ApproveAndMergeSeed> {
  const ownerEmail = `amerge-owner-${slug}@example.com`;
  const bystanderEmail = `amerge-bystander-${slug}@example.com`;
  const owner = await createTestPerson({
    email: ownerEmail,
    password: APPROVE_AND_MERGE_PASSWORD,
    name: OWNER_NAME,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Approve and merge E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Rate limits',
    identifier: 'AMRG',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // A person approves a green pull request before it merges — the mode this story is for.
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: 'manual', prMergeModeDecidedAt: new Date() },
  });

  const bystander = await createTestPerson({
    email: bystanderEmail,
    password: APPROVE_AND_MERGE_PASSWORD,
    name: 'Rae Reporter',
  });
  await workspacesService.addMember({ userId: bystander.id, workspaceId: workspace.id });
  for (const userId of [owner.id, bystander.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  await seedGithubInstallation(workspace.id, [WEB_REPO, API_REPO]);
  // Both repositories CONNECTED to the project, as the project's repository settings leave
  // them: How to test names only a project's repositories. Sequentially — concurrent
  // project-repo appends race on the position key.
  const repoRow = (providerRepoId: string) =>
    adminDb.githubRepo.findFirstOrThrow({ where: { repoId: providerRepoId } });
  const webRow = await repoRow(WEB_REPO.providerRepoId);
  const apiRow = await repoRow(API_REPO.providerRepoId);
  for (const [row, role] of [
    [webRow, 'web'],
    [apiRow, 'api'],
  ] as const) {
    await linkProjectRepo({
      workspaceId: workspace.id,
      projectId: project.id,
      githubRepoId: row.id,
      name: row.name,
      role,
    });
  }

  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const card = async (title: string): Promise<SeededCard> => {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title },
      ctx,
    );
    // Routed to the owner — `assigneeId ?? reporterId` — and moved to work, which is where a
    // card sits when its run opens the pull requests.
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: owner.id } });
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    return { id: item.id, identifier: item.identifier, title };
  };

  const merged = await card('Rate-limit the public API');
  const queued = await card('Honour Retry-After in the planner client');
  const refused = await card('Throttle burst traffic on the export');
  const zh = await card('Cap webhook retries');

  // The first card's reporter is the bystander: somebody who can see the card and is not the
  // person the question is routed to.
  await adminDb.workItem.update({ where: { id: merged.id }, data: { reporterId: bystander.id } });

  // How to test on the first card, so its frame's port shows the evidence below the rows.
  await testInstructionsService.publish(
    {
      workItemId: merged.id,
      bodyMd: [
        '## Click-path',
        '',
        '1. Send more than 100 requests a minute with one key.',
        '2. The 101st answers **429** with a `Retry-After` header.',
      ].join('\n'),
      repos: [
        { repoId: webRow.id, commitSha: headShaFor(10101) },
        { repoId: apiRow.id, commitSha: headShaFor(10102) },
      ],
    },
    ctx,
  );

  return {
    ownerEmail,
    ownerName: OWNER_NAME,
    bystanderEmail,
    password: APPROVE_AND_MERGE_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    merged,
    queued,
    refused,
    zh,
  };
}

/** The head commit a pull request's green checks report — stable per number, 40 hex chars. */
export function headShaFor(number: number): string {
  return number.toString(16).padStart(8, '0').repeat(5);
}
