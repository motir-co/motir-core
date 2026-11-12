import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
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
//   * WHETHER to run at all — {@link approvedPlanCreatedInitCard}, a COST gate over
//     the proposals the approve already holds. Not a scoping decision: the pass
//     scans the whole project, and every waiter waits on an init card its own
//     plan laid, so that plan's approve is a run of this step.
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

export const projectRepoInitApproveRoutingService = {
  /**
   * Hand every repository row of `projectId` to the routing pass, once, when the
   * approved plan created an init card. Runs after the approve has committed. See
   * the module header for what it does and deliberately does not decide.
   */
  async routeAfterApprove(input: {
    projectId: string;
    ctx: ServiceContext;
    approvedProposals: readonly ApprovedProposal[];
  }): Promise<ApproveRoutingResult> {
    const { projectId, ctx } = input;
    const result: ApproveRoutingResult = { routedWorkItemIds: [], failedRepositoryIds: [] };
    if (!approvedPlanCreatedInitCard(input.approvedProposals)) return result;

    // Bound to the approve's own workspace: the rows are workspace-scoped, and a
    // read outside a bound context answers zero rows and raises nothing — which
    // would look exactly like a project with no repositories.
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx),
    );

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
