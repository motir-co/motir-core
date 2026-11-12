import { adminDb } from './db-reset';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { createTestPerson } from './testPerson';
import { seedGithubInstallation } from './github-seed';
import { E2E_PROVISIONING_ORG } from './github-const';
import { headShaFor, publishReceipt, type SeededCard } from './acceptance-gate-seed';

// THE ACCEPTANCE-VERDICT seed (Story MOTIR-6071 · Subtask MOTIR-6508), for the receipt
// `acceptance-verdict.spec.ts` records. It is `acceptance-gate-seed.ts`'s STORY-RUN shape
// twice, plus one FINISHED story, in one project for one reviewer:
//
//   · two STORY RUNS — a story at In Review over two subtasks at Implemented, the story
//     being its run's own target (How to test on the story). The SPEC opens each story's
//     pull request, links it and turns it green through the real webhook route and link
//     door, and only then publishes the receipt (`publishReceipt`) — the run's own order,
//     so the publish is what finds BOTH questions owed: the acceptance video and, paired
//     with it, the merge approval. Both are raised by the shipped predicate
//     (`reconcileGatesFor`), never planted.
//   · a FINISHED story — every subtask Done, no delivery of its own. Its receipt is
//     published BEFORE the last subtask closes, and that close asks the story
//     (`reconcileAcceptanceOwnerOf`), the MOTIR-5903 subtask-run timing — which is also the
//     order the integration gate (`acceptanceVerdictStoryGate.test.ts`) builds it in.
//
// ⚠️ THE REPOSITORY IS THIS SPEC'S OWN (`88060001`) and belongs to the provisioning org, as
// `acceptance-gate-seed.ts` says why. Its pull-request numbers are the spec's 21xxx block.
//
// ⚠️ Titles are deliberately NOT substrings of one another: `getByRole` matches an
// accessible name by substring, and an overlap dies on strict mode instead of on anything
// this story is about.

export const ACCEPTANCE_VERDICT_PASSWORD = 'acceptance-verdict-e2e-pass-4';

export const VERDICT_REPO = {
  providerRepoId: '88060001',
  owner: E2E_PROVISIONING_ORG,
  name: 'accverdict-web',
  defaultBranch: 'main',
  archived: false,
} as const;

export const ACCEPTANCE_VERDICT_TITLES = {
  rerun: 'Show a first-card hint on the empty board',
  replan: 'Let a team import cards from a spreadsheet',
  finished: 'Welcome a new member with a short tour',
} as const;

/** A story and the E2E subtask under it that recorded its run. */
export interface VerdictStory {
  story: SeededCard;
  e2e: SeededCard;
}

export interface AcceptanceVerdictSeed {
  ownerEmail: string;
  ownerUserId: string;
  password: string;
  workspaceId: string;
  projectId: string;
  /** Sent back with Re-run. */
  rerun: VerdictStory;
  /** Sent back with Re-plan. */
  replan: VerdictStory;
}

export async function seedAcceptanceVerdict(slug: string): Promise<AcceptanceVerdictSeed> {
  const ownerEmail = `accverdict-owner-${slug}@example.com`;
  const owner = await createTestPerson({
    email: ownerEmail,
    password: ACCEPTANCE_VERDICT_PASSWORD,
    name: 'Olive Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acceptance verdict E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Team Boards',
    identifier: 'ACCV',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // A person approves a green pull request before it merges, and a story's run records an
  // acceptance video — both SET, never left to a default (`acceptance-gate-seed.ts`).
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: 'manual', prMergeModeDecidedAt: new Date(), acceptanceVideoEnabled: true },
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  await seedGithubInstallation(workspace.id, [VERDICT_REPO]);
  const repoRow = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: VERDICT_REPO.providerRepoId },
  });
  await linkProjectRepo({
    workspaceId: workspace.id,
    projectId: project.id,
    githubRepoId: repoRow.id,
    name: repoRow.name,
    role: 'web',
  });

  const ctx = { userId: owner.id, workspaceId: workspace.id };

  /** A story IN REVIEW over two subtasks at Implemented — `acceptance-gate-seed.ts`'s
   *  story-run shape, with How to test on the STORY so it is its run's own target. */
  const storyRun = async (title: string, prNumber: number): Promise<VerdictStory> => {
    const story = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'story', title },
      ctx,
    );
    await adminDb.workItem.update({ where: { id: story.id }, data: { assigneeId: owner.id } });
    const e2eTitle = `E2E · ${title.toLowerCase()}`;
    const e2e = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'subtask', title: e2eTitle, parentId: story.id },
      ctx,
    );
    const built = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'subtask', title: `Build: ${title}`, parentId: story.id },
      ctx,
    );
    for (const child of [e2e, built]) {
      for (const status of ['in_progress', 'in_review', 'implemented'] as const) {
        await workItemsService.updateStatus(child.id, status, ctx);
      }
    }
    await workItemsService.updateStatus(story.id, 'in_progress', ctx);
    await workItemsService.updateStatus(story.id, 'in_review', ctx);
    await testInstructionsService.publish(
      {
        workItemId: story.id,
        bodyMd: ['## Click-path', '', `1. ${title}.`].join('\n'),
        repos: [{ repoId: repoRow.id, commitSha: headShaFor(prNumber) }],
      },
      ctx,
    );
    return {
      story: { id: story.id, identifier: story.identifier, title },
      e2e: { id: e2e.id, identifier: e2e.identifier, title: e2eTitle },
    };
  };

  const rerun = await storyRun(ACCEPTANCE_VERDICT_TITLES.rerun, 21101);
  const replan = await storyRun(ACCEPTANCE_VERDICT_TITLES.replan, 21201);

  return {
    ownerEmail,
    ownerUserId: owner.id,
    password: ACCEPTANCE_VERDICT_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    rerun,
    replan,
  };
}

/**
 * A FINISHED story with its acceptance video waiting: every subtask Done, no delivery of
 * its own. The receipt lands while one subtask is still open (so it asks nothing yet), and
 * closing that subtask is what asks the story — the product's order, not the seed's.
 */
export async function seedFinishedStory(seed: AcceptanceVerdictSeed): Promise<VerdictStory> {
  const ctx = { userId: seed.ownerUserId, workspaceId: seed.workspaceId };
  const title = ACCEPTANCE_VERDICT_TITLES.finished;
  const story = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title },
    ctx,
  );
  await adminDb.workItem.update({
    where: { id: story.id },
    data: { assigneeId: seed.ownerUserId },
  });
  const e2eTitle = `E2E · ${title.toLowerCase()}`;
  const e2e = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'subtask', title: e2eTitle, parentId: story.id },
    ctx,
  );
  const built = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'subtask', title: `Build: ${title}`, parentId: story.id },
    ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', ctx);
  for (const status of ['in_progress', 'done'] as const) {
    await workItemsService.updateStatus(built.id, status, ctx);
  }
  const card = { id: story.id, identifier: story.identifier, title };
  await publishReceipt({
    workspaceId: seed.workspaceId,
    uploaderUserId: seed.ownerUserId,
    story: card,
    producedByKey: e2e.identifier,
    commitSha: headShaFor(21301),
  });
  for (const status of ['in_progress', 'implemented'] as const) {
    await workItemsService.updateStatus(e2e.id, status, ctx);
  }
  await workItemsService.updateStatus(e2e.id, 'done', ctx, { keepPendingQuestions: true });
  // The question the close raised — the shape the walk needs, checked before the page opens.
  await adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: story.id, kind: 'acceptance_result', state: 'awaiting' },
  });
  return { story: card, e2e: { id: e2e.id, identifier: e2e.identifier, title: e2eTitle } };
}
