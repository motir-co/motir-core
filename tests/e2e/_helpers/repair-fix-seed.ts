import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { createTestPerson } from './testPerson';
import { seedGithubInstallation } from './github-seed';
import { E2E_PROVISIONING_ORG } from './github-const';

// THE REPAIR E2E SEED (Story MOTIR-5460 · Subtask MOTIR-5468), for the acceptance
// receipt `regression-repair-fix.spec.ts` records.
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS LEFT TO THE SPEC:
//   * the two people, workspace, project, membership and cards — their services;
//   * the GitHub installation and the repository — `seedGithubInstallation`, the
//     shipped `persistInstallation`, as every GitHub E2E seeds it;
//   * each person's v1 token — `apiTokensService.create`, the door the token
//     settings page mints through, bound to the project with `work_item:edit`
//     (the permission `POST /api/v1/work-items/{key}/repair` declares);
//   * the pull requests, their links, the RED check that makes a card repairable
//     and the GREEN check that promotes it — NOT seeded. The spec drives them
//     through the REAL `/api/github/webhook` route (`github-seed.ts`'s
//     `postSignedWebhook` + `pullRequestPayload` / `checkSuitePayload`) and the
//     REAL link door (`pr-link.ts`), so the verdict the Development block reads is
//     the one the CI feedback path recorded, and the In Review the walk asserts is
//     the one `ciPromotion` wrote.
//
// Why not `how-to-test-seed.ts`'s rows: it writes check rows directly, and only
// green ones. A receipt whose last step is "the build went green, so the card
// moved" has to put the green through the producer that moves the card.
//
// ⚠️ The cards start `in_progress` — where a card sits when its run opens the pull
// request — so the `opened` delivery is what lands them on `implemented`.

export const REPAIR_FIX_PASSWORD = 'repair-fix-e2e-pass-5';

/** The repository both cards deliver into, on the shared E2E installation. Its own
 *  provider id, so no other spec's mirrored rows are shared. */
export const FIX_REPO = {
  providerRepoId: '88012001',
  owner: E2E_PROVISIONING_ORG,
  name: 'fix-web',
  defaultBranch: 'main',
  archived: false,
} as const;

export interface RepairCard {
  id: string;
  identifier: string;
  title: string;
}

export interface RepairPerson {
  email: string;
  name: string;
  /** A project-bound v1 bearer token carrying `work_item:edit`. */
  token: string;
}

export interface RepairFixSeed {
  password: string;
  workspaceId: string;
  projectId: string;
  /** A — the person who opens the card and copies the command. */
  ada: RepairPerson;
  /** B — the person whose agent claims the repair first. */
  ben: RepairPerson;
  /** Walked in English. */
  en: RepairCard;
  /** Walked in Chinese. */
  zh: RepairCard;
}

export async function seedRepairFix(slug: string): Promise<RepairFixSeed> {
  const adaEmail = `fix-ada-${slug}@example.com`;
  const benEmail = `fix-ben-${slug}@example.com`;
  const ada = await createTestPerson({
    email: adaEmail,
    password: REPAIR_FIX_PASSWORD,
    name: 'Ada Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Repair E2E',
    ownerUserId: ada.id,
  });
  const project = await projectsService.createProject({
    name: 'Checkout',
    identifier: 'FIXR',
    workspaceId: workspace.id,
    actorUserId: ada.id,
  });
  const ben = await createTestPerson({
    email: benEmail,
    password: REPAIR_FIX_PASSWORD,
    name: 'Ben Builder',
  });
  await workspacesService.addMember({ userId: ben.id, workspaceId: workspace.id });
  for (const userId of [ada.id, ben.id]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  await seedGithubInstallation(workspace.id, [FIX_REPO]);
  const repoRow = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: FIX_REPO.providerRepoId },
  });
  await linkProjectRepo({
    workspaceId: workspace.id,
    projectId: project.id,
    githubRepoId: repoRow.id,
    name: repoRow.name,
    role: 'web',
  });

  const ctx = { userId: ada.id, workspaceId: workspace.id };
  const card = async (title: string): Promise<RepairCard> => {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title },
      ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    return { id: item.id, identifier: item.identifier, title };
  };
  const en = await card('Retry declined card payments');
  const zh = await card('Show the tax line on receipts');

  const mint = async (userId: string, label: string) =>
    (
      await apiTokensService.create(userId, workspace.id, {
        label,
        projectId: project.id,
        permissions: ['project:browse', 'work_item:edit'],
      })
    ).token;

  return {
    password: REPAIR_FIX_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    ada: { email: adaEmail, name: 'Ada Owner', token: await mint(ada.id, 'repair-fix-ada') },
    ben: { email: benEmail, name: 'Ben Builder', token: await mint(ben.id, 'repair-fix-ben') },
    en,
    zh,
  };
}

/** The head commit a pull request's checks report — stable per (number, push), 40 hex chars. */
export function headShaFor(number: number, push: number): string {
  return `${number.toString(16).padStart(6, '0')}${push.toString(16).padStart(2, '0')}`.repeat(5);
}
