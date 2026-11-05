import { adminDb } from './db-reset';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ContinueHostedSeed } from './continue-hosted-seed';
import { seedReviewAgent, type ReviewAgentCard } from './review-agent-seed';

// THE REVIEW-PATH E2E SEED (Story MOTIR-10327 · Subtask MOTIR-10345), for the story's
// acceptance receipt `acceptance-review-path.spec.ts`.
//
// It is `review-agent-seed.ts`'s workspace — a manual-merge project with the review agent
// OFF, the owner (the routed person, who holds a v1 token with `work_item:edit`, the token a
// local agent's `motir review` submits with) and a teammate, Ben — plus the ONE fact the
// author note needs and no other seed carries: the GitHub accounts the pull requests are
// authored by.
//
//   * the OWNER is linked to GitHub account {@link OWNER_GITHUB}, so a pull request the
//     webhook says that account opened is one the routed person authored;
//   * Ben, the teammate, is GitHub account {@link TEAMMATE_GITHUB} (not linked — an author
//     who is not the routed person is all the note needs);
//   * Motir's App is {@link APP_GITHUB}: GitHub refuses that App's Request changes on a pull
//     request it opened, which the lane's merge seam answers 422 to when the spec names the
//     pull request in `ownAuthoredPullRequests`.
//
// ⚠️ WHAT IS NOT SEEDED: every pull request, green check, gate, verdict and dismissal. The
// spec drives them through the signed webhook route, the link door, the user-token verdict
// door and the browser, so each state the video shows is the one the product reached.

export const OWNER_GITHUB = { id: 7_270_001, login: 'review-path-owner' } as const;
export const TEAMMATE_GITHUB = { id: 7_270_002, login: 'review-path-ben' } as const;
export const APP_GITHUB = { id: 7_270_003, login: 'motir-e2e[bot]' } as const;

export async function seedReviewPath(slug: string): Promise<ContinueHostedSeed> {
  const s = await seedReviewAgent(slug);
  // The routed person's linked GitHub account. The token is never read on this path (the
  // author fact compares ids), so a placeholder ciphertext stands in for it.
  await adminDb.githubIdentity.create({
    data: {
      userId: s.owner.id,
      githubUserId: String(OWNER_GITHUB.id),
      githubLogin: OWNER_GITHUB.login,
      accessTokenEncrypted: 'e2e-review-path-unused',
    },
  });
  return s;
}

/** An In Progress card assigned to the owner, optionally under `parentId`. */
export async function seedReviewCard(
  s: ContinueHostedSeed,
  title: string,
  opts: { kind?: 'task' | 'subtask' | 'story'; parentId?: string; status?: 'in_progress' } = {},
): Promise<ReviewAgentCard> {
  const ctx = { userId: s.hosted.userId, workspaceId: s.hosted.workspaceId };
  const item = await workItemsService.createWorkItem(
    {
      projectId: s.hosted.projectId,
      kind: opts.kind ?? 'task',
      title,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: s.owner.id } });
  if (opts.status !== undefined || opts.kind !== 'story') {
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  }
  return { id: item.id, identifier: item.identifier, title };
}
