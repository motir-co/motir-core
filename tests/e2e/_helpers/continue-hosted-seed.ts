import { adminDb } from './db-reset';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestPerson } from './testPerson';
import {
  HOSTED_RUN_PASSWORD,
  seedCreatedRepo,
  seedHostedRun,
  type HostedRunSeed,
  type SeededHostedCard,
} from './hosted-run-seed';

// THE CONTINUE-HOSTED E2E SEED (Story MOTIR-6527 · Subtask MOTIR-6798), for
// `regression-continue-hosted.spec.ts`.
//
// It is `hosted-run-seed.ts`'s workspace (an owner, a project, a `created`-state
// repository the hosted pre-flight can write) plus what a continue needs on top:
//   * a SECOND `created` repository, so the happy path's run spans two;
//   * a second member, Ben, whose terminal `motir continue` is the *taken* case;
//   * a v1 token for each person — the owner's opens the LOCAL runs the refusal
//     cases let die, exactly as `run-died-seed.ts` does, and Ben's makes his claim.
//
// ⚠️ THE HAPPY PATH'S DEAD RUN IS NOT SEEDED. The spec runs the card hosted and
// lets the watchdog end it — the story is about a HOSTED run that died, and the
// stall window this lane shortens (`E2E_HOSTED_RUN_STALL_WINDOW_MS`) is the real
// way one dies.

export interface ContinuePerson {
  id: string;
  name: string;
  email: string;
  /** A project-bound v1 token carrying `work_item:edit`. */
  token: string;
}

export interface ContinueHostedSeed {
  hosted: HostedRunSeed;
  owner: ContinuePerson;
  ben: ContinuePerson;
  /** The project's two `created` repositories, primary first. */
  repos: { id: string; owner: string; name: string }[];
}

const REPO_OWNER = 'motir-projects-e2e';

async function mint(userId: string, seed: HostedRunSeed, label: string): Promise<string> {
  return (
    await apiTokensService.create(userId, seed.workspaceId, {
      label,
      projectId: seed.projectId,
      permissions: ['project:browse', 'work_item:edit'],
    })
  ).token;
}

export async function seedContinueHosted(
  email: string,
  identifier: string,
): Promise<ContinueHostedSeed> {
  const hosted = await seedHostedRun(email, identifier);
  const workspace = await adminDb.workspace.findUniqueOrThrow({
    where: { id: hosted.workspaceId },
  });
  const secondName = `hosted-${identifier.toLowerCase()}-api`;
  await seedCreatedRepo(hosted.workspaceId, workspace.organizationId, hosted.projectId, {
    owner: REPO_OWNER,
    name: secondName,
  });
  const rows = await adminDb.projectRepo.findMany({
    where: { projectId: hosted.projectId },
    orderBy: { position: 'asc' },
  });

  const benEmail = `ben-${email}`;
  const ben = await createTestPerson({
    email: benEmail,
    password: HOSTED_RUN_PASSWORD,
    name: 'Ben Builder',
  });
  await workspacesService.addMember({ userId: ben.id, workspaceId: hosted.workspaceId });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: ben.id, workspaceId: hosted.workspaceId } },
    data: { activeProjectId: hosted.projectId },
  });

  return {
    hosted,
    owner: {
      id: hosted.userId,
      name: 'Hosted Runner',
      email,
      token: await mint(hosted.userId, hosted, 'continue-owner'),
    },
    ben: {
      id: ben.id,
      name: 'Ben Builder',
      email: benEmail,
      token: await mint(ben.id, hosted, 'continue-ben'),
    },
    repos: rows.map((r) => ({ id: r.id, owner: REPO_OWNER, name: r.name })),
  };
}

/** A READY card pinned to BOTH repositories — Run hosted can start it. */
export async function seedTwoRepoCard(
  s: ContinueHostedSeed,
  title: string,
): Promise<SeededHostedCard> {
  const item = await workItemsService.createWorkItem(
    { projectId: s.hosted.projectId, kind: 'task', title },
    { userId: s.hosted.userId, workspaceId: s.hosted.workspaceId },
  );
  for (const [position, repo] of s.repos.entries()) {
    await adminDb.workItemRepo.create({
      data: {
        workspaceId: s.hosted.workspaceId,
        workItemId: item.id,
        projectRepoId: repo.id,
        position,
      },
    });
  }
  return { id: item.id, identifier: item.identifier };
}

/** An In Progress card assigned to the owner — where a card sits once a run
 *  claimed it; the refusal cases' LOCAL run dies on it. */
export async function seedInProgressCard(
  s: ContinueHostedSeed,
  title: string,
): Promise<SeededHostedCard> {
  const ctx = { userId: s.hosted.userId, workspaceId: s.hosted.workspaceId };
  const item = await workItemsService.createWorkItem(
    { projectId: s.hosted.projectId, kind: 'task', title },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: s.owner.id } });
  return { id: item.id, identifier: item.identifier };
}
