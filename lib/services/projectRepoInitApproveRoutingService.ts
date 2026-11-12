import { isTempRef } from '@/lib/plans/refs';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepoInitRoutingService } from '@/lib/services/projectRepoInitRoutingService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// ── APPROVING A PLAN ROUTES THE WAITERS WHOSE REPOSITORY ALREADY EXISTS ──
// (Story MOTIR-10162 · MOTIR-11058)
//
// The third moment a card waiting on an init card can be routed to its repository.
// The routing pass (`projectRepoInitRoutingService`, MOTIR-11042) rides the two
// moments a repository row SETTLES (the establish arm and the connect-existing
// arm), and a link that adopts a repository registers its own (MOTIR-11057). None
// of them covers a repository settled BEFORE its waiters exist: a person reads the
// plan, creates the declared repository, adds it to the project, and only then
// approves. The row settled long ago and approve is where the waiters come into
// existence — so approve is where they are routed.
//
// WHAT THIS DECIDES, and the list is short on purpose:
//
//   * WHETHER to run at all — a COST gate, never a scoping decision: the pass
//     scans the whole project. It opens on either of the two ways an approve can
//     bring a waiter into existence:
//       - the plan created an init card ({@link approvedPlanCreatedInitCard}),
//         read off the proposals the approve already holds; or
//       - the plan drew an edge onto a COMMITTED init card — an `add`'s
//         `blockedByRefs` or a `modify`'s `patch.blockedByAdd` naming one
//         ({@link committedBlockerIds}, then one indexed read). That is a LATER
//         plan's waiter on an init card an earlier plan laid (Bug MOTIR-11093):
//         the earlier card's settle hooks fired before this waiter existed, and
//         both completeness checks accept it unpinned because its blocker is a
//         committed init card, so this approve is the last moment that can route
//         it. A plan that does neither reads nothing.
//   * NOTHING ELSE. It compares no name and tests no row state: it hands EVERY row
//     of the project to the pass, which matches a declaration against a row's
//     resolved name and then its authored name, case-insensitively, and declines a
//     row that carries no repository. A pre-filter here would be a second statement
//     of that rule, and the two would drift.
//
// BEST-EFFORT at two layers. Each row is its own try/catch, so one repository's
// rejection does not skip the rest; the approve's call site wraps the whole step,
// so a failure in the read cannot fail an approve that has already committed. A
// row that fails leaves its waiters blocked and visibly unpinned, and the log names
// the row and the project. Safe to call on a project where nothing will route: the
// pass answers empty for a row nothing declares.

/** The slice of an approved plan item the gate reads. */
export interface ApprovedProposal {
  op: string;
  proposedFields: unknown;
  /** An `add`'s blockers: real work-item ids or intra-plan temp-refs. */
  blockedByRefs?: readonly string[];
  /** A `modify`'s sparse patch; its `blockedByAdd` names the blockers it adds. */
  patch?: unknown;
}

/** What one step did. */
export interface ApproveRoutingResult {
  /** The cards the pass gave a reference to, in the order the rows were handed over. */
  routedWorkItemIds: string[];
  /** The rows whose pass rejected; their waiters are left unpinned. */
  failedRepositoryIds: string[];
}

/**
 * Did the approved plan create an init card? True when any `add` carries a
 * non-null `initRepositoryName`. PRESENCE only: the name is compared to nothing
 * here — matching it is the routing pass's rule and lives nowhere else.
 */
export function approvedPlanCreatedInitCard(proposals: readonly ApprovedProposal[]): boolean {
  return proposals.some((p) => {
    if (p.op !== 'add') return false;
    const fields = p.proposedFields;
    if (fields === null || typeof fields !== 'object') return false;
    const declared = (fields as { initRepositoryName?: unknown }).initRepositoryName;
    return declared !== null && declared !== undefined;
  });
}

/**
 * The COMMITTED cards the approved plan made something wait on: the real ids among
 * every `add`'s `blockedByRefs` and every `modify`'s `patch.blockedByAdd`, deduped
 * and sorted. A temp-ref is skipped — it names an `add` in this same plan, which is
 * an init card only if it declares a repository, and then
 * {@link approvedPlanCreatedInitCard} already answers. Whether any of these ids IS
 * an init card is a read, left to the caller.
 */
export function committedBlockerIds(proposals: readonly ApprovedProposal[]): string[] {
  const ids = new Set<string>();
  for (const p of proposals) {
    for (const ref of blockerRefsOf(p)) {
      if (typeof ref === 'string' && !isTempRef(ref)) ids.add(ref);
    }
  }
  return [...ids].sort();
}

/** One proposal's blocker refs, by its op's carrier; anything malformed is none. */
function blockerRefsOf(p: ApprovedProposal): readonly unknown[] {
  if (p.op === 'add') return p.blockedByRefs ?? [];
  if (p.op !== 'modify' || p.patch === null || typeof p.patch !== 'object') return [];
  const added = (p.patch as { blockedByAdd?: unknown }).blockedByAdd;
  return Array.isArray(added) ? added : [];
}

export const projectRepoInitApproveRoutingService = {
  /**
   * Hand every repository row of `projectId` to the routing pass, once, when the
   * approved plan created an init card or made a card wait on a committed one. Runs
   * after the approve has committed. See the module header for what it does and
   * deliberately does not decide.
   */
  async routeAfterApprove(input: {
    projectId: string;
    ctx: ServiceContext;
    approvedProposals: readonly ApprovedProposal[];
  }): Promise<ApproveRoutingResult> {
    const { projectId, ctx } = input;
    const result: ApproveRoutingResult = { routedWorkItemIds: [], failedRepositoryIds: [] };
    const createdInit = approvedPlanCreatedInitCard(input.approvedProposals);
    const blockerIds = createdInit ? [] : committedBlockerIds(input.approvedProposals);
    if (!createdInit && blockerIds.length === 0) return result;

    // Bound to the approve's own workspace: the rows are workspace-scoped, and a
    // read outside a bound context answers zero rows and raises nothing — which
    // would look exactly like a project with no repositories.
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      if (!createdInit && !(await workItemRepository.hasInitCardAmong(projectId, blockerIds, tx))) {
        return [];
      }
      return projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
    });

    // Sequential, so concurrent cards are locked in one order per row by the pass.
    for (const row of rows) {
      try {
        const routed = await projectRepoInitRoutingService.routeInitCardDependents(row.id, ctx);
        result.routedWorkItemIds.push(...routed.routedWorkItemIds);
      } catch (err) {
        result.failedRepositoryIds.push(row.id);
        console.warn(
          `[projectRepoInitApproveRoutingService] could not route init-card dependents for row ${row.id} in project ${projectId} after an approve:`,
          err,
        );
      }
    }
    return result;
  },
};
