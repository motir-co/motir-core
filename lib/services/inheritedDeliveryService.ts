import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withdrawPullRequestApprovalGateOnSetChange } from './pullRequestApprovalGates';
import { recomputeWorkItemCiState } from './deliveryVerdict';
import { recomputeWorkItemFixReason } from './fixReasonService';

// INHERITED DELIVERIES ARE DERIVED, SO THEY ARE RECONCILED (Bugs MOTIR-11835 · MOTIR-11839 ·
// MOTIR-11901 · MOTIR-11917).
//
// With a project's "Complete children when a parent is done"
// (`autoCompleteChildrenOnParentDone`) on, closing a parent closes its children — which is
// only true to the code when every child's pull request merges with the parent. So a pull
// request a card delivers IN ITS OWN RIGHT (an explicit link, `inherited = false`) is also
// delivered by every ancestor of that card up to, not including, the first epic: an epic is
// never a merge target. Those ancestor rows are marked `inherited = true`.
//
// MOTIR-11835 wrote them at link time and nothing took them back. A row that is derived from
// a rule has to follow the rule wherever its inputs change, or it outlives the reason it was
// written: an unlink left the parent merging a pull request somebody had just declared was
// not this work, and a re-parent left the OLD parent delivering it while the new one never
// did. So this module does not "add on link" and "remove on unlink" — it RECOMPUTES, for the
// pull requests a change touched, exactly which inherited rows the rule asks for, and writes
// the difference. Every door that can move an input calls the same reconcile:
//
//   · a link and an unlink (`githubPullRequestService`) — the explicit rows changed;
//   · a re-parent, by any door (`workItemsService`, a plan's `modify`) — the tree changed;
//   · a delete (`workItemsService.deleteWorkItem`) — the tree lost the card, and the FK
//     cascade took its explicit rows but not what its ancestors inherited from them;
//   · an archive and a restore (`workItemsService.archiveWorkItem` / `unarchiveWorkItem`) —
//     the cascade's reach changed (below);
//   · the switch itself (`projectStatusAutomationService`) — the rule changed.
//
// ⚠️ AN ARCHIVED CARD IS OUTSIDE THE CASCADE, SO IT JUSTIFIES NO ROW (Bug MOTIR-11917).
// Closing a parent closes its children through `childStatusCascadeService`, which reads
// `findChildren` — and that filters `archivedAt`. So completing a parent never reaches an
// archived child, nor anything under it, and the reason an ancestor merges a descendant's
// pull request does not hold for one. The rule therefore skips an explicit row on an
// archived card, and the walk up from a live card stops AT the first archived ancestor:
// that card is asked nothing ("archiving abandons the work"), and nothing above it closes
// what is below it. A restore puts the rows back through the same reconcile.
//
// ⚠️ ONLY `inherited` ROWS ARE EVER REMOVED. A row someone linked to an ancestor explicitly
// is not derived from anything, so no reconcile reaches it — that is what the flag is for.
//
// Every card whose OWN delivery set the reconcile changed, and every card whose gate set it
// changed through an ancestor (`withoutAncestorDeliveries` leaves out a pull request any
// ancestor also delivers), is owed the set-change follow-up: the awaiting approve-and-merge
// question is withdrawn as `set_changed` and re-asked over the new set, and the CI verdict and
// the to-fix answer folded over that set are recomputed.

type Chain = { projectId: string; archived: boolean; ancestors: WorkItem[] };

/** Each holder's project, whether it is archived, and its ancestors, NEAREST FIRST. */
async function loadChains(
  holders: ReadonlyMap<string, string>,
  tx: Prisma.TransactionClient,
): Promise<Map<string, Chain>> {
  const chains = new Map<string, Chain>();
  for (const [itemId, workspaceId] of holders) {
    const item = await workItemRepository.findById(itemId, tx);
    if (!item) continue;
    // `findAncestors` answers root → parent.
    const ancestors = (await workItemRepository.findAncestors(itemId, workspaceId, tx)).reverse();
    chains.set(itemId, {
      projectId: item.projectId,
      archived: item.archivedAt !== null,
      ancestors,
    });
  }
  return chains;
}

const pairKey = (workItemId: string, pullRequestId: string) => `${workItemId}|${pullRequestId}`;

type WantedRow = {
  workItemId: string;
  githubPullRequestId: string;
  repoId: string;
  workspaceId: string;
};

/** The inherited rows the rule asks for, keyed by (ancestor, pull request). */
async function wantedInheritedRows(
  explicitRows: readonly WantedRow[],
  chains: ReadonlyMap<string, Chain>,
  tx: Prisma.TransactionClient,
): Promise<Map<string, WantedRow>> {
  const cascadeByProject = new Map<string, boolean>();
  const cascadeOn = async (projectId: string) => {
    if (!cascadeByProject.has(projectId)) {
      const automation = await projectRepository.findStatusAutomation(projectId, tx);
      cascadeByProject.set(projectId, automation?.autoCompleteChildrenOnParentDone ?? false);
    }
    return cascadeByProject.get(projectId)!;
  };

  const wanted = new Map<string, WantedRow>();
  for (const row of explicitRows) {
    const chain = chains.get(row.workItemId);
    // An archived holder is outside the cascade (MOTIR-11917): it justifies no row.
    if (!chain || chain.archived || !(await cascadeOn(chain.projectId))) continue;
    for (const ancestor of chain.ancestors) {
      // An epic is never a merge target; an archived ancestor is never reached by the
      // cascade, and neither is anything below it from further up (MOTIR-11917).
      if (ancestor.kind === 'epic' || ancestor.archivedAt !== null) break;
      wanted.set(pairKey(ancestor.id, row.githubPullRequestId), {
        ...row,
        workItemId: ancestor.id,
      });
    }
  }
  return wanted;
}

/**
 * Bring the inherited delivery rows of the given pull requests in line with the rule, and
 * return every card owed the set-change follow-up (not yet run — pass the answer to
 * {@link settleDeliverySetChanges}). Idempotent: a second call with nothing changed in
 * between writes nothing and returns `[]`.
 */
export async function reconcileInheritedDeliveries(
  pullRequestIds: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const rows = await workItemDeliveryRepository.listInheritanceRowsByPullRequests(
    pullRequestIds,
    tx,
  );
  if (rows.length === 0) return [];

  const chains = await loadChains(new Map(rows.map((r) => [r.workItemId, r.workspaceId])), tx);
  const wanted = await wantedInheritedRows(
    rows.filter((r) => !r.inherited),
    chains,
    tx,
  );

  const changed = new Set<string>();
  const existing = new Set(rows.map((r) => pairKey(r.workItemId, r.githubPullRequestId)));
  for (const row of rows) {
    if (!row.inherited || wanted.has(pairKey(row.workItemId, row.githubPullRequestId))) continue;
    await workItemDeliveryRepository.removeInherited(row.workItemId, row.githubPullRequestId, tx);
    changed.add(row.workItemId);
  }
  for (const [key, row] of wanted) {
    if (existing.has(key)) continue;
    await workItemDeliveryRepository.add({ ...row, inherited: true }, tx);
    changed.add(row.workItemId);
  }
  if (changed.size === 0) return [];

  // A holder whose ancestor's set changed has a different OWN set (`gateSetFor`), even
  // though no row of its own moved.
  const affected = new Set(changed);
  for (const [holderId, chain] of chains) {
    if (chain.ancestors.some((ancestor) => changed.has(ancestor.id))) affected.add(holderId);
  }
  return [...affected];
}

/**
 * The set-change follow-up, per card, in order: withdraw the gate that asked about the old
 * set (it re-asks over the new one), then recompute the CI verdict and the to-fix answer
 * folded over it (MOTIR-5482 · MOTIR-5470 · MOTIR-6602). Each card is settled once.
 *
 * ⚠️ AN ARCHIVED CARD IS ASKED NOTHING (Bug MOTIR-11917). `withdrawQuestionsOnArchive`
 * withdrew its questions as `pulled_back` when it was archived, and the re-ask half of the
 * withdrawal would raise a fresh one over its new set — an archived child whose pull
 * request is no longer its parent's would be asked to approve and merge it. So an archived
 * card skips the withdraw-and-re-ask; its verdict and to-fix answer are still recomputed.
 */
export async function settleDeliverySetChanges(
  workItemIds: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  for (const id of new Set(workItemIds)) {
    const item = await workItemRepository.findById(id, tx);
    if (item && item.archivedAt === null) {
      await withdrawPullRequestApprovalGateOnSetChange(id, tx);
    }
    await recomputeWorkItemCiState(id, tx);
    await recomputeWorkItemFixReason(id, tx);
  }
}

/**
 * After a card MOVED in the tree — a re-parent, a move to the top level, a filing into a
 * folder: reconcile every pull request the card or anything under it delivers, and settle
 * whatever changed. The rows the OLD ancestors inherited are found through those pull
 * requests, so both chains are covered from the moved card alone.
 */
export async function reconcileInheritedDeliveriesAfterMove(
  movedItemId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const subtreeIds = new Set(
    (await workItemRepository.findSubtree(movedItemId, tx)).map((row) => row.id),
  );
  const pullRequestIds = await workItemDeliveryRepository.listPullRequestIdsByWorkItems(
    [...subtreeIds],
    tx,
  );
  const changed = await reconcileInheritedDeliveries(pullRequestIds, tx);
  if (changed.length === 0) return;
  // The reconcile reads the tree AFTER the move, so it cannot see that a card in the
  // moved subtree USED to sit under an ancestor whose set just changed: a child moved to
  // the top level has no ancestors left to compare. Its own gate set changed all the same
  // (the pull request the old parent covered is its own again), so every card in the
  // subtree that delivers one of these pull requests is settled too.
  const subtreeHolders = (
    await workItemDeliveryRepository.listInheritanceRowsByPullRequests(pullRequestIds, tx)
  )
    .map((row) => row.workItemId)
    .filter((id) => subtreeIds.has(id));
  await settleDeliverySetChanges([...changed, ...subtreeHolders], tx);
}

/**
 * After a card was ARCHIVED or RESTORED: reconcile every pull request the card or anything
 * under it delivers, and settle whatever changed (Bug MOTIR-11917). The tree did not move,
 * so every chain is intact and the reconcile itself finds each card whose set changed: the
 * ancestors that lost (or regain) a row, and every holder below them.
 */
export async function reconcileInheritedDeliveriesForSubtree(
  rootItemId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const subtreeIds = (await workItemRepository.findSubtree(rootItemId, tx)).map((row) => row.id);
  const pullRequestIds = await workItemDeliveryRepository.listPullRequestIdsByWorkItems(
    subtreeIds,
    tx,
  );
  if (pullRequestIds.length === 0) return;
  await settleDeliverySetChanges(await reconcileInheritedDeliveries(pullRequestIds, tx), tx);
}

/**
 * After a project's "Complete children when a parent is done" switch changed: reconcile
 * every OPEN pull request delivering one of its cards. A merged or closed pull request is
 * history — no question is asked about it and no merge is left to make — so it is left as
 * it was rather than rewritten across the whole project in one transaction.
 */
export async function reconcileInheritedDeliveriesForProject(
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const pullRequestIds = await workItemDeliveryRepository.listOpenPullRequestIdsByProject(
    projectId,
    tx,
  );
  await settleDeliverySetChanges(await reconcileInheritedDeliveries(pullRequestIds, tx), tx);
}
