import { adminDb } from './db-reset';
import { recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ContinueHostedSeed } from './continue-hosted-seed';
import type { SeededHostedCard } from './hosted-run-seed';

// THE FIX-ON-THE-HOSTED-AGENT E2E SEED (Story MOTIR-1626 · Subtask MOTIR-6930), for
// `regression-fix-hosted.spec.ts`.
//
// It is `continue-hosted-seed.ts`'s workspace — an owner, a second member (Ben, whose
// terminal `motir fix` is the *held* case), a v1 token each, and the `created`-state
// repositories the hosted pre-flight can write — plus a card A REVIEW SENT BACK:
//   * In Review, assigned to the owner, delivering ONE open pull request on the project's
//     primary repository, green at its head;
//   * a decided `changes_requested` gate about that exact version — the review AGENT's
//     (`agent_review`, `review_agent` authority) or a person's Request changes on the
//     approve-and-merge gate (`pull_request_approval`);
//   * its `fixReason` recomputed through the shipped service, so the To fix banner and the
//     Development frame's fix part read what a real refusal would leave behind.
//
// ⚠️ THE REFUSAL IS SEEDED, NOT RAISED. How a review decides is the review agent's own
// lane (MOTIR-6827's receipt). This spec is about what a PERSON does with a card already
// sent back: press *Fix on the hosted agent*.

const HEAD = 'd'.repeat(40);
let prSeq = 600;

const FINDINGS = [
  'The export drops the header row when the list is empty.',
  '',
  '1. `exportCsv` returns `""` for an empty list — it must still write the header.',
  '2. The new route has no tenant check.',
].join('\n');

export async function seedSentBackCard(
  s: ContinueHostedSeed,
  title: string,
  by: 'agent_review' | 'pull_request_approval',
): Promise<SeededHostedCard> {
  const ctx = { userId: s.hosted.userId, workspaceId: s.hosted.workspaceId };
  const item = await workItemsService.createWorkItem(
    { projectId: s.hosted.projectId, kind: 'task', title },
    ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { status: 'in_review', assigneeId: s.owner.id },
  });

  // The project's primary `created` repository — the one the lane's GitHub mock answers
  // as writable, which a repair's credential covers (`repositoriesForRepair`).
  const primary = s.repos[0]!;
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: s.hosted.workspaceId, owner: primary.owner, name: primary.name },
  });
  prSeq += 1;
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: prSeq,
      state: 'open',
      merged: false,
      headRef: `subtask/${item.identifier.toLowerCase()}`,
      baseRef: 'main',
      title,
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: s.hosted.workspaceId,
      workItemId: item.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: HEAD, checkName: 'Vitest', conclusion: 'success' },
  });

  const byAgent = by === 'agent_review';
  await adminDb.approvalGate.create({
    data: {
      workspaceId: s.hosted.workspaceId,
      projectId: s.hosted.projectId,
      workItemId: item.id,
      kind: by,
      subjectId: item.id,
      subjectVersion: `${repo.owner}/${repo.name}#${pr.number}@${HEAD}`,
      state: 'changes_requested',
      decidedById: s.owner.id,
      decidedAt: new Date(),
      decidedByLabel: byAgent ? 'Review agent' : s.owner.name,
      decisionSource: 'ui',
      decidedUnderAuthority: byAgent ? 'review_agent' : 'assignee',
      noteMd: FINDINGS,
    },
  });
  await withWorkspaceContext(ctx, (tx) => recomputeWorkItemFixReason(item.id, tx));
  return { id: item.id, identifier: item.identifier };
}
