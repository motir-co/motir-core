import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { recomputeAncestorRepoSets } from '@/lib/services/workItemsService';
import { writeDerivedRepoSet } from '@/lib/workItems/repoSetWrites';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// ── ROUTE THE CARDS WAITING ON AN INIT CARD TO THE REPOSITORY IT CREATED ──────
// (Story MOTIR-10162 · Subtask MOTIR-11042)
//
// An init card declares, as `initRepositoryName`, the bare name of a repository
// that does not exist yet. The cards that wait on it (`is_blocked_by` the init
// card) were laid UNPINNED on purpose — there was no row to point at — so when the
// repository arrives in the project's set they hold no reference, and a run that
// claims one has no checkout to branch into. This pass writes that reference.
//
// ⚠️ IT IS NOT MOTIR-1913's RETIRED PIN RESOLUTION. That pass filled in a NAME for
// a card that already pointed at a role; under the reference model a name is
// derived on read, so there was nothing left for it to write. A card laid before
// its row existed points at nothing, and a name cannot be derived from no
// reference. So this pass writes a REFERENCE row — and the stored name projection
// beside it, because the completion gate reads that column.
//
// WHAT ROUTES. A row in `created` or `connected` — the two states that carry a
// repository. The init cards of the ROW's OWN project whose declaration matches
// either name the row answers to, case-insensitively: the realized repository's
// own name, then the row's authored name (the rule `toWorkItemRepositoryDtos`
// applies). Each init card's non-archived dependents that are in that project,
// hold no reference of their own, have no live children, are not in a status
// their project classifies as done (a status with no category counts as OPEN),
// and are not themselves an init card. Each survivor gets exactly ONE reference,
// at position 0, to the row; its ancestors' derived sets are then recomputed.
//
// WHAT DOES NOT, AND WHY:
//   * `proposed`, `creating`, `failed` carry no repository, and `skipped` is
//     settled deliberately without one. A failed row is the terminal its waiters
//     must stay BLOCKED behind; routing from it would unblock them silently.
//   * A card that already holds any reference was pointed somewhere by someone;
//     re-pointing it would overwrite a decision this pass cannot see.
//   * A card with live children is a container: its set is the union of its
//     leaves', so a reference written onto it would be erased by the next rollup.
//     The leaves are routed and the rollup gives the container its set.
//   * A done card is finished; writing onto it is a side effect on closed work.
//   * An init card is about ANOTHER repository; a pin would tell its run to create
//     that repository inside an existing checkout.
//
// The blocked-by edge is never touched: the init card still decides WHEN the work
// may start, and the repository decides WHERE.
//
// IDEMPOTENT. Each candidate's row is locked and its references re-read under the
// lock before the write (the lock-before-read-derived-write rule the ancestor
// rollup states), so a second call — or a settle replayed after routing — finds a
// reference and routes nothing, and two settles racing on one card serialize.
//
// Called POST-COMMIT and best-effort from the two seams a repository arrives
// through: `projectRepoSetService.attachRealizedRepo` and
// `organizationRepoService.linkExistingRepo`. There is no automatic retry for a
// dropped run: the seam logs the row and project, and this function is safe to
// re-run. A dropped run leaves the waiters blocked and visibly unpinned — never a
// card claiming a checkout it does not have.

/** What one pass did: the ids of the cards it gave a reference to, in id order. */
export interface InitCardRoutingResult {
  routedWorkItemIds: string[];
}

/** The two row states that carry a repository — the only ones that route. */
export const ROUTABLE_PROJECT_REPO_STATES: ReadonlySet<string> = new Set(['created', 'connected']);

const NOTHING_ROUTED = (): InitCardRoutingResult => ({ routedWorkItemIds: [] });

/** The names a settled row answers to: the realized repository's, then the row's. */
function namesOf(row: { name: string; githubRepo: { name: string } | null }): string[] {
  const names = [row.githubRepo?.name, row.name]
    .map((n) => n?.trim())
    .filter((n): n is string => !!n);
  return [...new Set(names)];
}

/**
 * Give every card waiting on an init card that declares `projectRepoId`'s
 * repository a reference to that row. See the module header for the rule. Answers
 * an empty list, and writes nothing, when the id names no row in the caller's
 * workspace, the row carries no repository, no init card declares its name, or
 * every candidate already holds a reference.
 */
export async function routeInitCardDependents(
  projectRepoId: string,
  ctx: ServiceContext,
): Promise<InitCardRoutingResult> {
  const { workspaceId } = ctx;
  return withWorkspaceServiceContext(workspaceId, async (tx) => {
    const row = await projectRepoRepository.findById(projectRepoId, workspaceId, tx);
    if (!row) return NOTHING_ROUTED();
    // THE STATE GATE — total over the row's six states.
    if (!ROUTABLE_PROJECT_REPO_STATES.has(row.state)) return NOTHING_ROUTED();

    const initCards = await workItemRepository.listByInitRepositoryName(
      row.projectId,
      namesOf(row),
      tx,
    );
    if (initCards.length === 0) return NOTHING_ROUTED();

    const candidates = new Map<string, { id: string; status: string }>();
    for (const init of initCards) {
      const dependents = await workItemLinkRepository.findDependentsWithLiveChildCounts(
        init.id,
        tx,
      );
      for (const d of dependents) {
        if (d.projectId !== row.projectId) continue;
        if (d.liveChildCount > 0) continue;
        if (d.initRepositoryName !== null) continue;
        candidates.set(d.id, { id: d.id, status: d.status });
      }
    }
    if (candidates.size === 0) return NOTHING_ROUTED();

    // The project's OWN done category, never a list of status keys: keys are
    // per-project, and a project that renamed `done` would stop being skipped.
    const categories = await workflowsService.getStatusKeysByCategoryByProjects(
      [row.projectId],
      workspaceId,
      tx,
    );
    const doneKeys = new Set(categories.get(row.projectId)?.done ?? []);
    const open = [...candidates.values()].filter((c) => !doneKeys.has(c.status)).map((c) => c.id);

    // Batched first pass: drop every candidate that already holds a reference.
    const held = new Set(
      (await workItemRepoRepository.listByWorkItems(open, tx)).map((r) => r.workItemId),
    );
    // Sorted, so concurrent passes take card locks in one order.
    const unpinned = open.filter((id) => !held.has(id)).sort();

    const routedWorkItemIds: string[] = [];
    for (const id of unpinned) {
      await workItemRepository.lockById(id, tx);
      // Re-read UNDER the lock: a concurrent settle or an author may have pinned it.
      if ((await workItemRepoRepository.listByWorkItem(id, tx)).length > 0) continue;
      await writeDerivedRepoSet(id, workspaceId, [row.id], tx);
      await recomputeAncestorRepoSets(id, workspaceId, tx);
      routedWorkItemIds.push(id);
    }
    return { routedWorkItemIds };
  });
}

export const projectRepoInitRoutingService = { routeInitCardDependents };
