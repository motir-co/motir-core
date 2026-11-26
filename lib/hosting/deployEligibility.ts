import type {
  HostedApplicationState,
  HostingTarget,
  ProjectRepoState,
  ProjectRepoTakeoverState,
} from '@/generated/prisma/client';
import { HANDOVER_APPLICATION_STATES } from '@/lib/hosting/vocabulary';
import { TRANSFERRED_TAKEOVER_STATES } from '@/lib/projectRepos/takeover';
import { isEstablishedState, isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';

// Whether a project repository may have a PRODUCTION home (Story MOTIR-9797 ·
// MOTIR-10026). Four conditions, checked in this order so the refusal names the
// most fundamental one: a customer repository is never hosted (Decision
// MOTIR-5769, D1), a repository that has left Motir or whose application is
// being handed over is never deployed again (Story MOTIR-9800 · MOTIR-12127), a
// row that names no repository yet has nothing to deploy, and a repository with
// no hosting target has nowhere to run.
//
// `taken_over` is THE release freeze the takeover's grace window relies on: every
// merge, config, ref and rollback deploy asks this one function, and no other
// guard exists.
//
// Whether the repository's hosting MANIFEST is valid is not decided here: the
// switch-on path checks it before it asks for an application.

/** The facts of a `project_repository` row the decision reads. */
export interface DeployEligibilityFacts {
  seedSource: string;
  state: ProjectRepoState;
  hostingTarget: HostingTarget | null;
  /** Where the repository's takeover stands; null when none was asked. */
  takeoverState: ProjectRepoTakeoverState | null;
  /** When the repository moved to its new owner; null until it has. */
  takeoverTransferredAt: Date | null;
  /** The repository's hosted application's handover state; null while it has
   *  no application. */
  applicationState: HostedApplicationState | null;
}

export type DeployEligibilityRefusal =
  | 'customer_repository'
  | 'taken_over'
  | 'not_established'
  | 'no_target';

/** Takeover states that mean the repository has already moved. */
const MOVED_TAKEOVER_STATES: ReadonlySet<ProjectRepoTakeoverState> = new Set(
  TRANSFERRED_TAKEOVER_STATES,
);

const HANDOVER_STATES: ReadonlySet<HostedApplicationState> = new Set(HANDOVER_APPLICATION_STATES);

/** Has the repository left Motir, or is its application being handed over? A
 *  takeover that FAILED after the move still reads its transfer time, and the
 *  repository is still gone, so the time alone answers. */
function isTakenOver(row: DeployEligibilityFacts): boolean {
  if (row.takeoverTransferredAt !== null) return true;
  if (row.takeoverState !== null && MOVED_TAKEOVER_STATES.has(row.takeoverState)) return true;
  return row.applicationState !== null && HANDOVER_STATES.has(row.applicationState);
}

/** Which condition fails first, or null when the row may be deployed. */
export function deployEligibilityRefusal(
  row: DeployEligibilityFacts,
): DeployEligibilityRefusal | null {
  if (isOrganizationSeedSource(row.seedSource)) return 'customer_repository';
  if (isTakenOver(row)) return 'taken_over';
  if (!isEstablishedState(row.state)) return 'not_established';
  if (row.hostingTarget === null) return 'no_target';
  return null;
}

export function isDeployEligible(row: DeployEligibilityFacts): boolean {
  return deployEligibilityRefusal(row) === null;
}
