import type { GithubRepo, Project, ProjectRepo } from '@/generated/prisma/client';
import type {
  ProjectRepoDto,
  ProjectRepoOwnershipDto,
  ProjectRepoProposalSignalDto,
  ProjectRepoSeedMatchDto,
  ProjectRepoRoleDto,
  ProjectRepoSetDto,
  ProjectRepoStateDto,
  ProjectRepoTakeoverStateDto,
  RealizedProjectRepoDto,
} from '@/lib/dto/projectRepos';
import { isEstablishedState } from '@/lib/projectRepos/vocabulary';
import {
  findOwnerAccessRecord,
  toAccessDto,
  type ProjectRepoAccessColumns,
} from '@/lib/projectRepos/access';

// Prisma `ProjectRepo` row (+ its joined `GithubRepo`) → API DTO (Story
// MOTIR-1775 · MOTIR-1780). The single place the persisted enums narrow to their
// string unions, Dates become ISO strings, and the two-part `established` rule is
// computed — so no Prisma row leaks past the service boundary (the 4-layer rule)
// and no consumer re-derives establishment.

/**
 * A `ProjectRepo` row with its realized repo joined (`include: { githubRepo }`)
 * and its collaborator records — the shape `projectRepoRepository`'s reads
 * return.
 *
 * `collaborators` carries only the columns the derivation reads. It is the WHOLE
 * set for the row, not pre-filtered, because the mapper picks the `admin` record
 * out of it (ADR §3 Q2) and a caller with the set in hand can answer both "whose
 * access does the establish step show?" and "who else is on this repository?"
 * without a second read.
 */
export type ProjectRepoWithRealized = ProjectRepo & {
  githubRepo: GithubRepo | null;
  collaborators: ProjectRepoAccessColumns[];
};

function toRealizedDto(repo: GithubRepo): RealizedProjectRepoDto {
  return {
    id: repo.id,
    provider: repo.provider,
    owner: repo.owner,
    name: repo.name,
    repoRef: `${repo.owner}/${repo.name}`,
    defaultBranch: repo.defaultBranch,
    archived: repo.archived,
  };
}

export function toProjectRepoDto(row: ProjectRepoWithRealized): ProjectRepoDto {
  return {
    id: row.id,
    projectId: row.projectId,
    role: row.role as ProjectRepoRoleDto,
    label: row.label,
    name: row.name,
    seedSource: row.seedSource,
    state: row.state as ProjectRepoStateDto,
    failureReason: row.failureReason,
    // Narrowed, not validated: the set service rejects any value outside ADR
    // §0.1's ladder at the only writer, so a row that reaches here carries a
    // signal the UI can map to copy — or null, which is the honest answer for a
    // user-added row and for every row written before MOTIR-1892.
    proposalSignal: row.proposalSignal as ProjectRepoProposalSignalDto | null,
    // Written only through the set service, which checks `SEED_MATCH_RESULTS`.
    seedMatch: row.seedMatch as ProjectRepoSeedMatchDto | null,
    realizedRepo: row.githubRepo ? toRealizedDto(row.githubRepo) : null,
    // BOTH halves, deliberately: a settled state whose mirror row has since been
    // deleted is NOT established (the repository no longer exists), even though
    // the plan it records survives.
    established: isEstablishedState(row.state) && row.githubRepo !== null,
    // The TAKE-IT-OVER saga (MOTIR-711). `null` is the common case and means no
    // handoff has ever been requested — NOT a state of the machine, which is why
    // the surface renders nothing for it rather than an "idle" chip.
    takeover: row.takeoverState
      ? {
          state: row.takeoverState as ProjectRepoTakeoverStateDto,
          targetOwner: row.takeoverTargetOwner,
          requestedAt: row.takeoverRequestedAt?.toISOString() ?? null,
          transferredAt: row.takeoverTransferredAt?.toISOString() ?? null,
          completedAt: row.takeoverCompletedAt?.toISOString() ?? null,
          failureReason: row.takeoverFailureReason,
        }
      : null,
    // The APPROVING USER's access — derived from their collaborator record's two
    // stamps, never a stored state (MOTIR-1900) — see `lib/projectRepos/access.ts`
    // for why. It is the `admin` record specifically (ADR §3 Q2 reserves that
    // level to them), which is what keeps this field answering the same question
    // it always has now that a row can hold a whole team's records (MOTIR-1910).
    access: toAccessDto(findOwnerAccessRecord(row.collaborators)),
    // The Prisma enums carry exactly `lib/hosting/vocabulary.ts`'s values (a test
    // pins the two lists together), so these are identities, not narrowings.
    hostingTarget: row.hostingTarget,
    hostingUseCase: row.hostingUseCase,
    hostingSize: row.hostingSize,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The full set read: the ordered rows plus the project's SET-level ownership
 *  decision (ADR §3.2 / §3.4), which lives on the `project` row. */
export function toProjectRepoSetDto(
  projectId: string,
  rows: ProjectRepoWithRealized[],
  project: Pick<Project, 'repoSetOwnership' | 'repoSetTargetAccount'>,
): ProjectRepoSetDto {
  return {
    projectId,
    rows: rows.map(toProjectRepoDto),
    ownership: (project.repoSetOwnership as ProjectRepoOwnershipDto | null) ?? null,
    targetAccount: project.repoSetTargetAccount,
  };
}
