import type { HostingTarget, ProjectRepoState } from '@/generated/prisma/client';
import { isEstablishedState, isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';

// Whether a project repository may have a PRODUCTION home (Story MOTIR-9797 ·
// MOTIR-10026). Three conditions, checked in this order so the refusal names the
// most fundamental one: a customer repository is never hosted (Decision
// MOTIR-5769, D1), a row that names no repository yet has nothing to deploy, and
// a repository with no hosting target has nowhere to run.
//
// Whether the repository's hosting MANIFEST is valid is not decided here: the
// switch-on path checks it before it asks for an application.

/** The facts of a `project_repository` row the decision reads. */
export interface DeployEligibilityFacts {
  seedSource: string;
  state: ProjectRepoState;
  hostingTarget: HostingTarget | null;
}

export type DeployEligibilityRefusal = 'customer_repository' | 'not_established' | 'no_target';

/** Which condition fails first, or null when the row may be deployed. */
export function deployEligibilityRefusal(
  row: DeployEligibilityFacts,
): DeployEligibilityRefusal | null {
  if (isOrganizationSeedSource(row.seedSource)) return 'customer_repository';
  if (!isEstablishedState(row.state)) return 'not_established';
  if (row.hostingTarget === null) return 'no_target';
  return null;
}

export function isDeployEligible(row: DeployEligibilityFacts): boolean {
  return deployEligibilityRefusal(row) === null;
}
