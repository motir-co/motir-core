import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestPerson } from './testPerson';
import { seedGithubInstallation } from './github-seed';
import { E2E_PROVISIONING_ORG } from './github-const';

// THE FIXING / MOVING AGAIN E2E SEED (Story MOTIR-10305 · Subtask MOTIR-10311), for the
// acceptance receipt `acceptance-fixing-moving-again.spec.ts` records.
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS LEFT TO THE SPEC:
//   * the person, workspace, project (in `manual` merge mode, so a green card raises the
//     approve-to-merge question a reviewer can send back), and the cards — their services;
//   * the GitHub installation and the repository — `seedGithubInstallation`, the shipped
//     `persistInstallation`, as every GitHub E2E seeds it;
//   * the pull requests, their links, every check and every push — NOT seeded. The spec
//     drives them through the REAL `/api/github/webhook` route and the REAL link door, so
//     each To fix reason, each Fixing state and each To resume exit is the one the shipped
//     recompute wrote in the check row's own transaction.
//
// ⚠️ The cards start `in_progress` — where a card sits when its run opens the pull request —
// so the `opened` delivery is what lands a delivered card on `implemented`.

export const FIXING_MOVING_PASSWORD = 'fixing-moving-e2e-pass-10311';

/** The repository every card delivers into, on the shared E2E installation. Its own provider
 *  id, so no other spec's mirrored rows are shared. */
export const FIXING_REPO = {
  providerRepoId: '88103051',
  owner: E2E_PROVISIONING_ORG,
  name: 'fixing-web',
  defaultBranch: 'main',
  archived: false,
} as const;

export interface FixingCard {
  id: string;
  identifier: string;
  title: string;
}

export interface FixingMovingSeed {
  email: string;
  name: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** Walked red → Fixing → red → Fixing → green, the held row and the refresh. */
  repaired: FixingCard;
  /** Left Fixing, and looked at on every surface in both languages. */
  fixing: FixingCard;
  /** Sent back by a reviewer, repaired on the hosted agent, then pushed. */
  hosted: FixingCard;
  /** Gated with an open pull request; CI starts after its run stopped (English). */
  gated: FixingCard;
  /** Gated with an open pull request; CI starts after its run stopped (Chinese). */
  gatedZh: FixingCard;
  /** Gated with no pull request; only its status moves. */
  gatedStill: FixingCard;
}

export async function seedFixingMoving(slug: string): Promise<FixingMovingSeed> {
  const email = `fixing-${slug}@example.com`;
  const name = 'Ada Owner';
  const person = await createTestPerson({ email, password: FIXING_MOVING_PASSWORD, name });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Fixing E2E',
    ownerUserId: person.id,
  });
  const project = await projectsService.createProject({
    name: 'Checkout',
    identifier: 'FIXG',
    workspaceId: workspace.id,
    actorUserId: person.id,
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: 'manual', prMergeModeDecidedAt: new Date() },
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: person.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  await seedGithubInstallation(workspace.id, [FIXING_REPO]);
  const repoRow = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: FIXING_REPO.providerRepoId },
  });
  await linkProjectRepo({
    workspaceId: workspace.id,
    projectId: project.id,
    githubRepoId: repoRow.id,
    name: repoRow.name,
    role: 'web',
  });

  const ctx = { userId: person.id, workspaceId: workspace.id };
  const card = async (title: string): Promise<FixingCard> => {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title, assigneeId: person.id },
      ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    return { id: item.id, identifier: item.identifier, title };
  };

  return {
    email,
    name,
    password: FIXING_MOVING_PASSWORD,
    userId: person.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    repaired: await card('Retry declined card payments'),
    fixing: await card('Show the tax line on receipts'),
    hosted: await card('Keep the header row in an empty export'),
    gated: await card('Draw the refund timeline'),
    gatedZh: await card('Name the refund reason'),
    gatedStill: await card('Write the refund email'),
  };
}

/** The head commit a pull request is at — stable per (number, push), 40 hex chars. */
export function headShaFor(number: number, push: number): string {
  return `${number.toString(16).padStart(6, '0')}${push.toString(16).padStart(2, '0')}`.repeat(5);
}
