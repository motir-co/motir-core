import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { normalizeTargetRepo } from '@/lib/workItems/targetRepo';
import type { ProjectRepoRoleDto, ProjectRepoStateDto } from '@/lib/dto/projectRepos';
import type { HostingSize, HostingTarget, HostingUseCase } from '@/lib/hosting/vocabulary';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The PROJECT's repository SET as it rides a planning-job envelope (Story
// MOTIR-2732 · MOTIR-3044, ADR `docs/decisions/work-item-repository-set.md`
// "Amendment 2026-08-18" §A4).
//
// ⚠️ This is NOT `context.code`, and the two sit BESIDE each other rather than
// merging, because they answer different questions at different SCOPES:
//
//   * `context.code` (`lib/ai/codeContext.ts`) — the WORKSPACE's connected repo
//     grant list, one entry per repository the installation granted, existing so
//     motir-ai can read a code graph (MOTIR-1598 / MOTIR-1599). Untouched here.
//   * `context.repositories` (this module) — the PROJECT's own repository set:
//     `project_repository` rows, each with an identity, a role, a label, an
//     intended name and an establish state.
//
// Collapsing them would be the very confusion this card exists to end. A
// workspace grant list cannot say which repositories a PROJECT plans to have, it
// carries no role, and it contains nothing for a repository that does not exist
// yet — which is most of them at the moment a plan is generated.
//
// **Why the identity is the load-bearing field.** `ProjectRepo.role`'s own
// comment: *"A role MAY repeat (§1.2) — two services are two `api` rows"*, and
// `label` is *"never a resolution key (an ambiguous role resolves to null,
// §5.3)"*. So on a project with two `api` repositories a role pin resolves to
// NOTHING, and the planner has no way to mean *the billing API* rather than *the
// search API*. Sending the row's `ref` is what makes that project plannable at
// the repository axis at all; MOTIR-3045 is the consumer that pins by it.
//
// Composition mirrors `resolveCodeContext`: the set read opens its OWN
// transaction (the `project_repository` RLS policy is workspace-keyed), so every
// caller MUST invoke this OUTSIDE any write transaction — at planning-job submit,
// which is where both producers already resolve the code context.

/** One `project_repository` row as it rides the job envelope. */
export interface JobProjectRepo {
  /**
   * The row's identity — what a proposal pins to name THIS repository rather than
   * a role that may match two of them. Stable across a rename of the repository
   * and across the row being edited before it is established, which is the whole
   * reason a reference exists (amendment §A3).
   */
  ref: string;
  /**
   * The repository's name as a reader would see it: the REALIZED repository's own
   * name once the row is realized, else the row's authored intent.
   *
   * The same rule `lib/projectRepos/names.ts` applies, and stated per row rather
   * than borrowed from `toProjectRepoNames` for the reason
   * `lib/projectRepos/roleResolution.ts` gives for the same choice: that helper
   * DE-DUPLICATES the set case-insensitively by name, which is right for a
   * dispatch domain and wrong here — two rows whose realized repositories happen
   * to share a bare name would collapse to one entry, and disambiguating exactly
   * that pair is what this field exists for.
   */
  name: string;
  role: ProjectRepoRoleDto;
  /** The free-form label that distinguishes repeated roles (`api` + "billing"). */
  label: string | null;
  /** The establish state — `proposed` / `creating` / `created` / `connected` /
   *  `skipped` / `failed`. A planner that cannot see this cannot tell a
   *  repository that exists from one the plan is about to ask for. */
  state: ProjectRepoStateDto;
  /**
   * The row's raw seed source (Story MOTIR-9796 · MOTIR-10014). `organization`
   * marks a repository the organisation brought (`isOrganizationSeedSource`);
   * every other value one Motir created. Sent RAW — motir-ai derives the Motir
   * repo / customer repo label from it with the same rule, so there is no owner
   * column and no second source of truth for it.
   */
  seedSource: string;
  /** Where this Motir repo's app runs (MOTIR-9808), or null when none is recorded. */
  hostingTarget: HostingTarget | null;
  /** What the app is for, or null when none is recorded. */
  hostingUseCase: HostingUseCase | null;
  /** How big it is, or null when none is recorded. */
  hostingSize: HostingSize | null;
}

/** The `context.repositories` unit of a planning-job envelope. */
export interface JobProjectRepoContext {
  repos: JobProjectRepo[];
  /**
   * The seed matching's answer per hosting target (MOTIR-10014), computed at
   * request time over the live seed registry (MOTIR-709,
   * `seedRegistryService.starterByHostingTarget`) — the starter the planner
   * names in a hosting decision card, so that card names what the MATCHING
   * returns rather than a starter written into a rule.
   */
  starterByTarget: Record<HostingTarget, string>;
}

/**
 * The project's repository set for the job envelope, or `undefined` when the
 * project records none.
 *
 * **ABSENT, never empty** — the reserved-hole convention `context.code` and
 * `discovery` already follow, and the distinction the consumer needs: *"this
 * project records no repositories"* and *"nobody asked"* must be tellable apart.
 * A `{ repos: [] }` would collapse them, and a motir-ai that predates this field
 * would be indistinguishable from one that read an empty set.
 *
 * Rows are sent in SET ORDER, unfiltered — an unestablished row is included with
 * its state, because a plan is written before its repositories exist and a
 * planner that only saw established rows would be blind to every repository the
 * plan itself proposed. A `skipped` or `failed` row is included for the same
 * reason: its state is the answer, not its absence.
 */
export async function resolveProjectRepoContext(
  projectId: string,
  ctx: ServiceContext,
): Promise<JobProjectRepoContext | undefined> {
  const rows = await projectRepoSetService.listByProject(projectId, ctx);
  const repos: JobProjectRepo[] = [];
  for (const row of rows) {
    const name = normalizeTargetRepo(row.realizedRepo?.name ?? row.name);
    if (name === null) continue;
    repos.push({
      ref: row.id,
      name,
      role: row.role,
      label: row.label,
      state: row.state,
      seedSource: row.seedSource,
      hostingTarget: row.hostingTarget,
      hostingUseCase: row.hostingUseCase,
      hostingSize: row.hostingSize,
    });
  }
  return repos.length === 0
    ? undefined
    : { repos, starterByTarget: await seedRegistryService.starterByHostingTarget() };
}
