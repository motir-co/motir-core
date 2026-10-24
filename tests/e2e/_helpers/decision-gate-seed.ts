import { adminDb } from '@/tests/helpers/adminDb';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestPerson } from './testPerson';
import { seedGithubInstallation } from './github-seed';
import { E2E_PROVISIONING_ORG } from './github-const';

// THE DECISION GATE E2E SEED (Story MOTIR-4907 · Subtask MOTIR-5681), for the acceptance
// receipt `regression-decision-gate.spec.ts` records.
//
// WHAT GOES THROUGH A SERVICE, AND WHAT IS LEFT TO THE SPEC — the approve-and-merge seed's
// split (`approve-and-merge-seed.ts`), for the same reasons:
//   * the person, workspace, project and the three cards — their services;
//   * the GitHub installation and the repository — `seedGithubInstallation`;
//   * the pull requests, their links, their green checks, the CAPTURE of the decision
//     document and every gate — NOT seeded. The spec drives them through the real webhook
//     route and the real link door, and the capture reads the head's files through the
//     GitHub merge seam (`lib/test-github-merge-mock.ts`), so the gate the walk decides is
//     the one the product raised.
//
// ⚠️ THE REPOSITORY BELONGS TO THE PROVISIONING ORG — the approve-and-merge seed's rule:
// every host read here mints its installation token with the App the owner selects, and
// the acceptance lane configures only the provisioning App.

export const DECISION_GATE_PASSWORD = 'decision-gate-e2e-pass-5';

export const DECISION_REPO = {
  providerRepoId: '88016001',
  owner: E2E_PROVISIONING_ORG,
  name: 'decision-web',
  defaultBranch: 'main',
  archived: false,
} as const;

export interface SeededDecisionCard {
  id: string;
  identifier: string;
  title: string;
}

export interface DecisionGateSeed {
  ownerEmail: string;
  password: string;
  workspaceId: string;
  projectId: string;
  /** An agent's decision whose pull request carries ONE document — accepted and merged. */
  accepted: SeededDecisionCard;
  /** An agent's decision whose pull request carries NO document — cannot be approved. */
  missing: SeededDecisionCard;
  /** A decision a PERSON owns — never this gate. */
  human: SeededDecisionCard;
}

export async function seedDecisionGate(slug: string): Promise<DecisionGateSeed> {
  const ownerEmail = `decision-owner-${slug}@example.com`;
  const owner = await createTestPerson({
    email: ownerEmail,
    password: DECISION_GATE_PASSWORD,
    name: 'Dana Decider',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Decision gate E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Pages',
    identifier: 'DECN',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // A person approves before anything merges — the mode where one press answers both.
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: 'manual' } });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  await seedGithubInstallation(workspace.id, [DECISION_REPO]);
  const repoRow = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: DECISION_REPO.providerRepoId },
  });
  await linkProjectRepo({
    workspaceId: workspace.id,
    projectId: project.id,
    githubRepoId: repoRow.id,
    name: repoRow.name,
    role: 'web',
  });

  const ctx = { userId: owner.id, workspaceId: workspace.id };
  const card = async (
    title: string,
    executor: 'coding_agent' | 'human',
  ): Promise<SeededDecisionCard> => {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title, type: 'decision', executor },
      ctx,
    );
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: owner.id } });
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    return { id: item.id, identifier: item.identifier, title };
  };

  return {
    ownerEmail,
    password: DECISION_GATE_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    accepted: await card('Decide how a page stores its body', 'coding_agent'),
    missing: await card('Decide the retention window', 'coding_agent'),
    human: await card('Pick the import format', 'human'),
  };
}

/** The head commit a pull request's green checks report — stable per number, 40 hex chars. */
export function decisionHeadSha(number: number): string {
  return number.toString(16).padStart(8, '0').repeat(5);
}
