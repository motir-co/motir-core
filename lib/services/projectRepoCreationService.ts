import type { ProjectRepoDto, ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import { RepoEstablishBusyError, RepoExistsWithOtherSpecError } from '@/lib/projectRepos/errors';
import { SEED_SOURCE_INITIALISED } from '@/lib/projectRepos/vocabulary';
import {
  projectRepoProvisioningService,
  type EstablishRowOutcome,
} from '@/lib/services/projectRepoProvisioningService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// ── Create ONE project repository from a starter key (MOTIR-11038) ───────────
//
// Until this service a repository was created for a project only by a person:
// the establish pass is reachable from the establish route alone, and it attempts
// only rows that already exist (`proposed` / `failed`), which only `addRow`
// appends. An agent that must bring a repository into being — an init card's run
// (Story MOTIR-10162) — had neither half.
//
// This is a THIN sequence over the two shipped services, and it re-derives none
// of their decisions: the name rules, the seed compatibility, the claim that
// makes a concurrent run lose the race and the per-row failure recording all stay
// where they ship. What it adds is the ORDER — read the set, decide, append only
// when there is no row, then establish exactly that row — and the dispositions
// that order produces, which are what make a replayed init safe rather than a
// second repository.
//
// ⚠️ It is a SERVICE and not code in the MCP tool, because the run-credential
// door that is this implementation's second transport is an `/api/v1` route, and
// a v1 route may not import `@/lib/mcp/` (`tests/api/v1/planning-story-gate.test.ts`
// — "the two transports align through the SERVICE").

/** What happened to the ROW, as the creation door reports it. */
export type ProjectRepoCreationOutcome =
  /** This call appended the row, and the establish pass settled it. */
  | 'created'
  /** The row was already in the project with the same base and role (`proposed`
   *  or `failed`), and this call established it. */
  | 'adopted'
  /** The row was already settled (`created` / `connected` / `skipped`); nothing
   *  was written. */
  | 'already_settled'
  /** The establish pass attempted the row and it failed. The row is `failed` and
   *  resumable; `establish.failureCode` / `failureReason` carry why, verbatim. */
  | 'failed';

export interface CreateProjectRepositoryArgs {
  projectKey: string;
  name: string;
  role: ProjectRepoRoleDto;
  /** A seed-registry key. OMITTED means an EMPTY base (`SEED_SOURCE_INITIALISED`),
   *  never the role's default starter. */
  starterKey?: string;
}

export interface CreateProjectRepositoryResult {
  outcome: ProjectRepoCreationOutcome;
  /** The row as it stands after the call. */
  row: ProjectRepoDto;
  /** The establish pass's own per-row result, VERBATIM — its `outcome` is a
   *  different fact (the pass's `adopted` means the repository already existed on
   *  the host; this door's means the ROW already existed in the project). */
  establish: {
    outcome: EstablishRowOutcome;
    failureCode: string | null;
    failureReason: string | null;
  };
}

export const projectRepoCreationService = {
  /**
   * READ → DECIDE → APPEND (only when absent) → ESTABLISH (that one row).
   *
   * Refuses with `RepoExistsWithOtherSpecError` when a row of this name exists
   * with a different base or role, and with `RepoEstablishBusyError` when the
   * row is another run's live claim. A row-level failure is NOT a throw: it is
   * the `failed` outcome carrying the pass's own code and reason.
   */
  async createProjectRepositoryFromStarter(
    args: CreateProjectRepositoryArgs,
    ctx: ServiceContext,
  ): Promise<CreateProjectRepositoryResult> {
    // The same resolve the REST establish door makes: an unknown or other-tenant
    // key is not-found here, before anything is appended.
    const project = await projectsService.getByKey(args.projectKey, ctx);

    // The base is passed EXPLICITLY on every call. `addRow` defaults an absent
    // `seedSource` from the role, which is right for a hand-added row and wrong
    // here — the caller is choosing a base, and "no starter covers this base"
    // must be expressible.
    const seedSource = args.starterKey?.trim() || SEED_SOURCE_INITIALISED;

    const rows = await projectRepoSetService.listByProject(project.id, ctx);
    // CASE-INSENSITIVE, as the host treats repository names and as `addRow`'s own
    // collision guard does; the unique index only catches the exact duplicate.
    const wanted = args.name.trim().toLowerCase();
    const existing = rows.find((row) => row.name.toLowerCase() === wanted) ?? null;

    if (existing) {
      if (existing.seedSource !== seedSource) {
        throw new RepoExistsWithOtherSpecError(
          existing.name,
          'seedSource',
          existing.seedSource,
          seedSource,
        );
      }
      if (existing.role !== args.role) {
        throw new RepoExistsWithOtherSpecError(existing.name, 'role', existing.role, args.role);
      }
    }

    const row =
      existing ??
      (await projectRepoSetService.addRow(
        project.id,
        { name: args.name, role: args.role, seedSource },
        ctx,
      ));

    const result = await projectRepoProvisioningService.establishSet(project.id, ctx, {
      rowId: row.id,
    });
    const mine = result.rows.find((r) => r.rowId === row.id);
    // Total over the pass's closed five-member outcome.
    if (!mine || mine.outcome === 'not_attempted') throw new RepoEstablishBusyError(row.name);

    const settled = mine.row ?? row;
    const establish = {
      outcome: mine.outcome,
      failureCode: mine.failureCode ?? null,
      failureReason: mine.failureReason ?? null,
    };
    switch (mine.outcome) {
      case 'created':
      case 'adopted':
        return { outcome: existing ? 'adopted' : 'created', row: settled, establish };
      case 'already_settled':
        return { outcome: 'already_settled', row: settled, establish };
      case 'failed':
        return { outcome: 'failed', row: settled, establish };
    }
  },
};
