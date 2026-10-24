import { db, adminDb } from './db-reset';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { createTestPerson } from './testPerson';
import { seedGithubInstallation } from './github-seed';
import { grantPaidAiPlanIfBilled } from './billing';

// THE FIXTURE FOR THE HOSTED-RUN ACCEPTANCE WALK (Story MOTIR-683 · MOTIR-6452):
// a workspace + project owner, and — for each card the spec drives a hosted run
// on — a READY leaf card backed by a `created`-state repository, so
// `hostedRunService.start` reaches its real pre-flight checks (readiness, the
// repo-installation write-access read) rather than refusing on a fixture gap.
//
// ⚠️ `created` STATE, NOT `connected` (MOTIR-6452's own finding): a `created`
// repository writes through the `motir-studio` App
// (`lib/github/runGitCredential.ts`'s `runGitAppFor`), and the acceptance lane's
// `webServer.env` already carries `GITHUB_STUDIO_APP_ID` /
// `GITHUB_STUDIO_APP_PRIVATE_KEY` (`playwright.acceptance.config.ts`, for the
// repository-set journey). A `connected` repository would need
// `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` (the `motir-integration` App),
// which this lane does not configure — `hostedRunStart.test.ts`'s own
// `seedRepo({state: 'created', …})` is the mirrored fixture shape.
//
// ⚠️ SEEDED THROUGH THE SERVICES where they exist, and through `adminDb`
// (db-reset's RLS-bypassing client) only for the three tables no service
// exposes (`GithubInstallation` / `GithubRepo` / `ProjectRepo`) — the same split
// `scoped-run-seed.ts` documents, and the exact rows
// `tests/hostedRuns/hostedRunStart.test.ts` already proves `start()` accepts.

export const HOSTED_RUN_PASSWORD = 'hunter2hunter2';

export interface SeededHostedCard {
  id: string;
  identifier: string;
}

export interface HostedRunSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

/** One workspace, one project, its owner signed in as the actor. No cards yet —
 *  call {@link seedReadyHostedCard} once per card a spec drives a hosted run on. */
export async function seedHostedRun(email: string, identifier: string): Promise<HostedRunSeed> {
  const owner = await createTestPerson({
    email,
    password: HOSTED_RUN_PASSWORD,
    name: 'Hosted Runner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Hosted run',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Hosted run',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  // A hosted run spends Motir's fleet, which is paid-AI-plan only.
  grantPaidAiPlanIfBilled(workspace.organizationId);
  await seedCreatedRepo(workspace.id, workspace.organizationId, project.id, {
    owner: 'motir-projects-e2e',
    name: `hosted-${identifier.toLowerCase()}`,
  });
  // A SEPARATE, standard connected installation (`E2E_REPO` / `E2E_INSTALLATION_ID`)
  // purely so a `pull_request` webhook resolves to a real `GithubRepo` row and
  // `linkPr` can attribute its delivery to a card — unrelated to which repo
  // `hostedRunService.start`'s pre-flight considers writable (that is the
  // `created`-state repo above, checked through this lane's own GitHub mock, never
  // through a DB row). The two need not be the same repository: a delivery's link
  // is explicit (`linkPr`'s whole point), not inferred from the run's own repo.
  await seedGithubInstallation(workspace.id);

  return {
    email,
    password: HOSTED_RUN_PASSWORD,
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
  };
}

let repoSeq = 0;

/** A `created`-state project repository — see the file header for why. Returns
 *  the project repository's id, so a spec can PIN a card to it. */
export async function seedCreatedRepo(
  workspaceId: string,
  organizationId: string,
  projectId: string,
  repo: { owner: string; name: string },
): Promise<string> {
  repoSeq += 1;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${workspaceId}-${repo.owner}` },
    create: {
      installationId: `inst-${workspaceId}-${repo.owner}`,
      workspaceId,
      organizationId,
      accountLogin: repo.owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId,
      organizationId,
      // Unique across WORKER RESTARTS, not only within one worker: Playwright
      // restarts the worker after a failed test, which resets `repoSeq`, while
      // the rows it already wrote stay in the database. A bare counter then
      // collides with them and fails every later test in the file (MOTIR-9411).
      // A restarted worker is a new process, so its pid keeps the ids apart.
      repoId: `${process.pid}${String(repoSeq).padStart(4, '0')}`,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId,
      projectId,
      role: 'web',
      name: repo.name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: `a${String(repoSeq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
  return row.id;
}

/**
 * A READY leaf card (no blockers — `readiness.ready` from birth, exactly like
 * `hostedRunStart.test.ts`'s plain `newCard`), belonging to {@link seed}'s
 * project. The project's own `created`-state repository (seeded once by
 * {@link seedHostedRun}) is its fallback pin — `repositoriesForItems` resolves
 * to the project's primary repo when a leg pins none of its own.
 */
export async function seedReadyHostedCard(
  seed: HostedRunSeed,
  title: string,
): Promise<SeededHostedCard> {
  const item = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title },
    { userId: seed.userId, workspaceId: seed.workspaceId },
  );
  return { id: item.id, identifier: item.identifier };
}
