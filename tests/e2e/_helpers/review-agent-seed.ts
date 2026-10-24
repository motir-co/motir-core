import { adminDb } from './db-reset';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedContinueHosted, type ContinueHostedSeed } from './continue-hosted-seed';
import { seedGithubInstallation } from './github-seed';
import { E2E_PROVISIONING_ORG } from './github-const';

// THE REVIEW-AGENT E2E SEED (Story MOTIR-1626 · Subtask MOTIR-6827), for the story's
// acceptance receipt `regression-review-agent.spec.ts`.
//
// It is `continue-hosted-seed.ts`'s workspace — an owner, Ben, the `created`-state
// repositories the hosted pre-flight can READ (a review run reads the project's primary
// repository through the lane's hosted-run mock) — plus what the review agent's walk needs:
//   * the project in `manual` merge mode (`approval-gates.md` §12.2a: the review agent is
//     manual-only), with the review agent OFF — the spec switches it on in Settings;
//   * ONE repository of the provisioning org on the shared E2E installation, which the
//     cards' pull requests are opened in. Its owner is load-bearing, exactly as
//     `approve-and-merge-seed.ts` says: a merge mints its token with the App the owner
//     selects, and this lane configures only the provisioning App.
//
// ⚠️ WHAT IS NOT SEEDED: every pull request, every green check, every gate and every
// review run. The spec drives them through the signed webhook route, the link door, the
// job worker and the review run's own verdict route, so each state the video shows is the
// one the product reached.

export const REVIEW_REPO = {
  providerRepoId: '88025001',
  owner: E2E_PROVISIONING_ORG,
  name: 'review-web',
  defaultBranch: 'main',
  archived: false,
} as const;

export interface ReviewAgentCard {
  id: string;
  identifier: string;
  title: string;
}

export async function seedReviewAgent(slug: string): Promise<ContinueHostedSeed> {
  const s = await seedContinueHosted(`review-${slug}@example.com`, `RA${slug}`);
  // The mode the review agent needs; its switch stays OFF (the default) for the spec.
  await adminDb.project.update({
    where: { id: s.hosted.projectId },
    data: { prMergeMode: 'manual', reviewAgentEnabled: false },
  });
  // The same installation `seedHostedRun` bound, now also mirroring the review repository.
  await seedGithubInstallation(s.hosted.workspaceId, [REVIEW_REPO]);
  return s;
}

/** An In Progress card assigned to the owner — where a card sits when its run opens the
 *  pull request, and who a review's routed question (and its run) belongs to. */
export async function seedDeliveringCard(
  s: ContinueHostedSeed,
  title: string,
): Promise<ReviewAgentCard> {
  const ctx = { userId: s.hosted.userId, workspaceId: s.hosted.workspaceId };
  const item = await workItemsService.createWorkItem(
    { projectId: s.hosted.projectId, kind: 'task', title },
    ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: s.owner.id } });
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  return { id: item.id, identifier: item.identifier, title };
}
