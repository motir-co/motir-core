import {
  Prisma,
  type ProjectRepoCollaboratorPermission,
  type ProjectRepoRole,
  type ProjectRepoState,
} from '@/generated/prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { keyBetweenSafe, keyForAppend } from '@/lib/workItems/positioning';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRepoCollaboratorRepository } from '@/lib/repositories/projectRepoCollaboratorRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectPrMergeModeService } from '@/lib/services/projectPrMergeModeService';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import {
  toProjectRepoDto,
  toProjectRepoSetDto,
  type ProjectRepoWithRealized,
} from '@/lib/mappers/projectRepoMappers';
import type {
  AddProjectRepoInput,
  PatchProjectRepoInput,
  ProjectRepoDto,
  ProjectRepoProposalSignalDto,
  ProjectRepoSeedMatchDto,
  ProjectRepoSetDto,
  SetProjectRepoOwnershipInput,
} from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryListDto, SeedRegistryPage } from '@/lib/dto/seedRegistry';
import {
  toProjectRepoNames,
  toProjectRepoPinNames,
  type ProjectRepoName,
} from '@/lib/projectRepos/names';
import { allowedTransitions, canTransition } from '@/lib/projectRepos/transitions';
import { classifyProjectRepoUniqueViolation } from '@/lib/projectRepos/uniqueViolation';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import {
  PROJECT_REPO_PLAN_EDITABLE_STATES,
  PROJECT_REPO_PROPOSAL_SIGNALS,
  SEED_MATCH_RESULTS,
  isOrganizationSeedSource,
  isProjectRepoProposalSignal,
  isSeedMatchResult,
} from '@/lib/projectRepos/vocabulary';
import { seedEntryFitsRow } from '@/lib/projectRepos/seedMatching';
import {
  HOSTING_SIZES,
  HOSTING_TARGETS,
  HOSTING_USE_CASES,
  isHostingSize,
  isHostingTarget,
  type HostingTarget,
  isHostingUseCase,
} from '@/lib/hosting/vocabulary';
import {
  ProjectRepoHostingTargetFixedError,
  ProjectRepoInvalidFieldError,
  ProjectRepoLinkConflictError,
  ProjectRepoNameTakenError,
  ProjectRepoNotFoundError,
  ProjectRepoNotMotirHostedError,
  ProjectRepoSeedRefusedError,
  ProjectRepoStateTransitionError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';

// The project's REPOSITORY SET — reads and writes (Story MOTIR-1775 · MOTIR-1780),
// specified by `docs/decisions/project-repository-set.md`.
//
// SCOPE, deliberately narrow. This service owns the SET as data: propose rows,
// edit them, order them, move each through the ADR §4.1 establish machine, record
// which `GithubRepo` realizes each, and answer "which repo names may an item in
// this project be pinned to?". It does NOT:
//
//   * create anything on GitHub — that is the creation primitive (MOTIR-1781),
//     which calls `markCreating` → `attachRealizedRepo` / `markFailed` around its
//     own network work. Repo creation is a side effect OUTSIDE any transaction
//     (ADR §4.2 + the side-effects-outside-tx rule), which is exactly why the
//     state machine is exposed as separate short transactions rather than one
//     method that would have to hold a row locked across a GitHub round-trip;
//   * DERIVE the set's contents from a plan (which roles, which names) — that is
//     MOTIR-1881, which writes `proposed` rows THROUGH `addRow`;
//   * render anything — that is MOTIR-1782;
//   * re-point `resolveCodeContext` / `codeGraphIndexService` from workspace scope
//     to project scope. This card makes the association EXIST; adopting it is
//     MOTIR-1754's behaviour change. See the comments at both sites.
//
// TRANSACTIONS + RLS: every path opens `withWorkspaceContext`, which is what binds
// the `app.workspace_id` GUC the `project_repository` policy reads (and, for the
// joined realized repo, the `github_repo` policy). One service method = one
// transaction, and every validation read that GATES a write happens inside that
// same transaction (`db.$transaction` is what `withWorkspaceContext` opens), so a
// concurrent editor cannot slip between the guard and the write.
//
// ACCESS: reads are browse-gated, writes edit-gated, both through
// `projectAccessService` — the project's own access policy, no second rule here.

/** GitHub's own repo-name charset + length limit — the SHAPE a name must have to
 *  be creatable at all. Whether it is AVAILABLE is a host mechanic the creation
 *  primitive learns (MOTIR-1781; MOTIR-1777 (d) settles how), never asserted here. */
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const REPO_NAME_MAX = 100;
const LABEL_MAX = 80;
const SEED_SOURCE_MAX = 200;
const FAILURE_REASON_MAX = 2000;
const TARGET_ACCOUNT_MAX = 100;

/**
 * The states in which a row's PLAN fields (role / name / seed source) may still be
 * edited: `proposed` (nothing created yet — Principle #3, the plan is editable
 * before coding starts) and `failed` (ADR §1.5 pre-fills a de-collided name for
 * the user to accept or change, which is only possible if a failed row is
 * editable).
 *
 * NOT editable while `creating` (a creation is in flight under that exact name) and
 * not once SETTLED (`created` / `connected` — the repository exists, so renaming
 * the row would make the record disagree with reality; `skipped` — the row is
 * settled, and re-planning it is a remove-and-re-add). The free-form `label` is
 * editable in EVERY state: it is a human annotation that drives nothing.
 */
const PLAN_EDITABLE_STATES: readonly ProjectRepoState[] = PROJECT_REPO_PLAN_EDITABLE_STATES;

/**
 * The SETTLED states a row may be RE-PLANNED out of (`replanRow`) — the two that
 * settled without making anything: `skipped` (deliberately code-less) and
 * `connected` (an existing repository was pointed at; nothing was created and
 * nothing in it changed).
 *
 * `created` is deliberately absent. A created repository is a real artifact
 * (ADR §4.2), and quietly replacing the row that records it would make
 * "Motir created this" disappear from the set; dropping it is the user's explicit
 * **Remove**, not a side effect of changing their mind about the mode. `creating`
 * is absent because a creation is in flight under that exact name, and `proposed`
 * / `failed` are absent because they are already re-planned states — the row is
 * editable in place.
 */
const REPLANNABLE_STATES: readonly ProjectRepoState[] = ['skipped', 'connected'];

/** Trim + shape-validate an intended repo name. */
function validateName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new ProjectRepoInvalidFieldError('name', 'it must not be blank.');
  }
  if (name.length > REPO_NAME_MAX) {
    throw new ProjectRepoInvalidFieldError(
      'name',
      `it must be at most ${REPO_NAME_MAX} characters.`,
    );
  }
  if (!REPO_NAME_PATTERN.test(name)) {
    throw new ProjectRepoInvalidFieldError(
      'name',
      'it may contain only letters, digits, and the characters . _ -',
    );
  }
  if (name === '.' || name === '..') {
    throw new ProjectRepoInvalidFieldError('name', 'it must not be a path segment (. or ..).');
  }
  return name;
}

/** Trim a free-form label; a blank one normalizes to null (an explicit clear), so
 *  a caller never has to distinguish `''` from `null`. */
function validateLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const label = raw.trim();
  if (label.length === 0) return null;
  if (label.length > LABEL_MAX) {
    throw new ProjectRepoInvalidFieldError('label', `it must be at most ${LABEL_MAX} characters.`);
  }
  return label;
}

/** Trim + bound a seed source. An opaque string by design (ADR §2) — this
 *  validates SHAPE only, so MOTIR-709's registry keys need no change here. */
function validateSeedSource(raw: string): string {
  const seedSource = raw.trim();
  if (seedSource.length === 0) {
    throw new ProjectRepoInvalidFieldError('seedSource', 'it must not be blank.');
  }
  if (seedSource.length > SEED_SOURCE_MAX) {
    throw new ProjectRepoInvalidFieldError(
      'seedSource',
      `it must be at most ${SEED_SOURCE_MAX} characters.`,
    );
  }
  return seedSource;
}

/**
 * Validate a caller-supplied derivation signal (MOTIR-1892) against ADR §0.1's
 * ladder. An ABSENT signal is legal and means null — that is every hand-added
 * row, which has no Motir inference to record. A PRESENT one must name a rung the
 * ADR fixes: the column is what the establish step maps to copy, so a value it
 * cannot map is a bug to reject at the write, not one to discover at render.
 */
/** Validate the matching's recorded result (MOTIR-709) against its closed list. */
function validateSeedMatch(raw: unknown): ProjectRepoSeedMatchDto | null {
  if (raw === undefined || raw === null) return null;
  if (!isSeedMatchResult(raw)) {
    throw new ProjectRepoInvalidFieldError(
      'seedMatch',
      `it must be one of ${SEED_MATCH_RESULTS.join(', ')}.`,
    );
  }
  return raw;
}

/**
 * Check a person's re-point (MOTIR-709; decision MOTIR-706 v2 §3.5) and answer
 * the key to store — the entry's CURRENT key, so a legacy key is never written
 * anew. Role and target are HARD: an entry of another role, or one that cannot
 * deploy where the row runs, is refused rather than stored. Each refusal names
 * its rule, and nothing is written.
 */
async function checkRepoint(
  seedSource: string,
  row: { role: ProjectRepoRole; hostingTarget: HostingTarget | null },
): Promise<string> {
  const entry = await seedRegistryService.findEntry(seedSource);
  if (!entry) {
    throw new ProjectRepoSeedRefusedError('unknown', seedSource, 'no starter has that key.');
  }
  if (entry.status !== 'active') {
    throw new ProjectRepoSeedRefusedError('retired', seedSource, 'that starter has been retired.');
  }
  if (entry.role !== row.role && entry.role !== 'any') {
    throw new ProjectRepoSeedRefusedError(
      'role_mismatch',
      seedSource,
      `that starter is for a ${entry.role} repository, and this one is ${row.role}.`,
    );
  }
  if (!seedEntryFitsRow(entry, row)) {
    throw new ProjectRepoSeedRefusedError(
      'target_mismatch',
      seedSource,
      row.hostingTarget === null
        ? 'that starter deploys to a hosting target, and this repository runs on none.'
        : `that starter does not deploy to ${row.hostingTarget}, where this repository runs.`,
    );
  }
  return entry.key;
}

function validateProposalSignal(raw: unknown): ProjectRepoProposalSignalDto | null {
  if (raw === undefined || raw === null) return null;
  if (!isProjectRepoProposalSignal(raw)) {
    throw new ProjectRepoInvalidFieldError(
      'proposalSignal',
      `it must be one of ${PROJECT_REPO_PROPOSAL_SIGNALS.join(', ')}.`,
    );
  }
  return raw;
}

/**
 * Access-gate the project, then run `fn` inside ONE workspace-scoped transaction.
 *
 * The gate is the ONLY resolution needed: `projectAccessService` resolves the
 * project ITSELF and throws `ProjectNotFoundError` (→ 404) both when the id does
 * not exist AND when it belongs to another workspace — so the two are literally
 * indistinguishable to a caller (the no-existence-leak posture, asserted in the
 * service test). Deliberately NOT `projectsService.assertProjectInWorkspace`,
 * whose `ProjectWorkspaceMismatchError` would confirm a cross-tenant id is real.
 * A member who may browse but not edit is then rejected as `'edit'` (→ 403).
 */
async function inProject<T>(
  projectId: string,
  ctx: ServiceContext,
  mode: 'browse' | 'edit',
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (mode === 'edit') {
    await projectAccessService.assertPermission(projectId, ctx, 'repository:manage');
  } else {
    await projectAccessService.assertCanBrowse(projectId, ctx);
  }
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId }, fn);
}

/**
 * Resolve a set ROW to its project, edit-gate it, then run `fn` in ONE
 * workspace-scoped transaction which LOCKS the row and re-reads it. The lock +
 * re-read is the lost-update guard every state transition needs (the legality of a
 * hop is derived from the current state, so the state must not move between the
 * read and the write) and is also what makes a concurrent transition's loser
 * observe the already-moved state and fail with the typed illegal-transition
 * error rather than clobbering it.
 */
async function inLockedRow<T>(
  rowId: string,
  ctx: ServiceContext,
  fn: (row: ProjectRepoWithRealized, tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const existing = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    projectRepoRepository.findById(rowId, ctx.workspaceId, tx),
  );
  if (!existing) throw new ProjectRepoNotFoundError(rowId);
  await projectAccessService.assertPermission(existing.projectId, ctx, 'repository:manage');
  return withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: existing.projectId },
    async (tx) => {
      const locked = await projectRepoRepository.lockById(rowId, tx);
      if (!locked) throw new ProjectRepoNotFoundError(rowId);
      const fresh = await projectRepoRepository.findById(rowId, ctx.workspaceId, tx);
      if (!fresh) throw new ProjectRepoNotFoundError(rowId);
      return fn(fresh, tx);
    },
  );
}

/**
 * Translate a unique-index race on the set into its typed domain error, so a raw
 * P2002 never escapes the service (the concurrency-to-typed-error rule).
 *
 * ⚠️ THE CLASSIFICATION IS SHARED, AND THAT IS THE FIX (MOTIR-5273). This function
 * used to read `meta.target` itself, which is ABSENT under this client (see
 * `lib/prisma/uniqueViolation.ts`), so its claim arm was unreachable: the realize
 * path — which passes no name — re-threw the raw Prisma error as a 500, and the
 * append / rename paths reported every race as "that name is taken". MOTIR-4833
 * had fixed the identical translator in `organizationRepoService` and not this
 * one; both now ask `classifyProjectRepoUniqueViolation`, so there is one copy to
 * be right or wrong.
 *
 * ⚠️ EVERY ARM THROWS A TYPED ERROR, including the remainder. A claim with no
 * repository in hand cannot arise (an append writes no `github_repo_id`, a rename
 * does not change it), so it falls to the remainder rather than to a guess, and
 * the remainder is `ProjectRepoLinkConflictError` — a retryable 409 that says
 * someone else wrote first — never the raw error and never a name collision.
 *
 * EXPORTED FOR ITS OWN UNIT TEST, for the reason `translateLinkViolation` is: a
 * race decides which arm runs, so only driving it directly pins every arm.
 */
export function translateUniqueViolation(
  err: unknown,
  fallback: { projectId: string; name: string; githubRepoId: string | null },
): never {
  const violation = classifyProjectRepoUniqueViolation(err);
  if (violation === null) throw err;
  if (violation === 'claim' && fallback.githubRepoId !== null) {
    throw new RealizedRepoAlreadyClaimedError(fallback.githubRepoId);
  }
  if (violation === 'name') {
    throw new ProjectRepoNameTakenError(fallback.name, fallback.projectId);
  }
  console.warn('[projectRepoSetService] unclassified P2002 on the repository set', {
    violation,
    meta: (err as { meta?: unknown }).meta,
    projectId: fallback.projectId,
    githubRepoId: fallback.githubRepoId,
  });
  throw new ProjectRepoLinkConflictError(fallback.projectId, fallback.name, fallback.githubRepoId);
}

export const projectRepoSetService = {
  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * A project's whole repository set — the ordered rows (primary first) PLUS the
   * SET-level ownership decision, in one read. The rows come back with their
   * realized repos joined in a single query.
   *
   * An empty `rows` list is the honest answer for a project that has not run the
   * establish step (every project that predates this table). It is NOT an error —
   * and since MOTIR-4955 it reaches no repository at all: a project with no set
   * never inherits the workspace's connected repos.
   */
  async getSet(projectId: string, ctx: ServiceContext): Promise<ProjectRepoSetDto> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      const project = await projectRepository.findById(projectId, tx);
      // The access gate already proved it exists and is browsable; a null here
      // would mean it was deleted mid-transaction, so fall back to "no decision
      // recorded" rather than throwing on a read.
      return toProjectRepoSetDto(projectId, rows, {
        repoSetOwnership: project?.repoSetOwnership ?? null,
        repoSetTargetAccount: project?.repoSetTargetAccount ?? null,
      });
    });
  },

  /** Just the rows of a project's set, in order. `getSet` when the caller also
   *  needs the ownership decision. */
  async listByProject(projectId: string, ctx: ServiceContext): Promise<ProjectRepoDto[]> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      return rows.map(toProjectRepoDto);
    });
  },

  /**
   * The seeds a person may re-point this row to (MOTIR-709), one page at a time:
   * the ACTIVE registry entries of the row's role — and the any-role
   * `initialised` — that pass the row's hosting target, exactly the entries
   * `patchRow` would accept. For MOTIR-712's picker; a browse read, since seeing
   * the choices is not changing them.
   */
  async listCompatibleSeeds(
    rowId: string,
    page: SeedRegistryPage,
    ctx: ServiceContext,
  ): Promise<SeedRegistryEntryListDto> {
    const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      projectRepoRepository.findById(rowId, ctx.workspaceId, tx),
    );
    if (!row) throw new ProjectRepoNotFoundError(rowId);
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    return seedRegistryService.listCompatible(
      { role: row.role, hostingTarget: row.hostingTarget },
      page,
    );
  },

  /**
   * The rows carrying a given ROLE, in set order — a LIST, because a role may
   * repeat (ADR §1.2). A caller resolving an item's repo pin by role must treat
   * `length !== 1` as unresolvable (§5.3: no match → null; more than one → null,
   * never an arbitrary pick).
   */
  async getByProjectAndRole(
    projectId: string,
    role: ProjectRepoRole,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto[]> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.findByProjectAndRole(
        projectId,
        role,
        ctx.workspaceId,
        tx,
      );
      return rows.map(toProjectRepoDto);
    });
  },

  /**
   * The repo NAMES an item in this project may be pinned to — the project-scoped
   * counterpart of `listConnectedRepoNames`, in the SAME normalized form, so a pin
   * validated against the project's set and one validated against the workspace's
   * connected set agree on spelling.
   *
   * ESTABLISHED rows only, realized-repo casing, de-duplicated — see
   * `lib/projectRepos/names.ts` for why each of those is load-bearing. The result
   * extends `ConnectedRepoName`, so it feeds `resolveDispatchTargetRepo` unchanged;
   * MOTIR-1783 / MOTIR-1784 / MOTIR-1884 consume this rather than re-implementing
   * the lookup.
   */
  async resolveProjectRepoNames(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<ProjectRepoName[]> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      return toProjectRepoNames(rows);
    });
  },

  /**
   * BOTH repo-name domains a `targetRepo` is resolved against (MOTIR-1783), plus
   * whether this project has a set at all — from ONE read of the set.
   *
   * Three answers rather than three calls, because the scope ladder in
   * `lib/workItems/dispatchRepo.ts` needs all three at once and they must describe
   * the SAME snapshot of the set.
   *
   * ⚠️ SINCE MOTIR-4955 THERE IS NO WORKSPACE-CONNECTED PATH AT ALL — the project
   * link is the isolation boundary, so an empty set reaches nothing
   * (`lib/projectRepos/effectiveDomain.ts`). The paragraph below records why
   * `hasSet` was never a registry switch even while that path existed.
   *
   * ⚠️ `hasSet` IS NOT A SWITCH BETWEEN THE TWO REGISTRIES (MOTIR-3086). It reads
   * like one — "rows? then the set; no rows? then the workspace" — and the ladder
   * in `dispatchRepo.ts` did exactly that until a project that arrived WITH CODE
   * added its first row and lost every repository it already had. `hasSet` is the
   * FACT that the project has planned repositories, and it is what makes the set
   * answer FIRST; whether anything is layered UNDER it is a second question, asked
   * and answered there. Do not re-derive an all-or-nothing switch from this flag.
   */
  async getRepoNameDomains(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<{ hasSet: boolean; dispatchable: ProjectRepoName[]; pinnable: ProjectRepoName[] }> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      return {
        hasSet: rows.length > 0,
        dispatchable: toProjectRepoNames(rows),
        pinnable: toProjectRepoPinNames(rows),
      };
    });
  },

  // ── Editing the set (before it is executed) ───────────────────────────────

  /**
   * APPEND a `proposed` row to the project's set. Nothing is created on the host —
   * a row starts as a proposal, and the user's confirmation at the establish step
   * is what moves it (ADR §0.2).
   *
   * `seedSource` defaults from the role via ADR §2's table, so a caller that knows
   * only "this is the api repo" cannot accidentally seed it from the web starter.
   *
   * The name-collision guard runs INSIDE the transaction and is
   * case-insensitive — git-host repo names are, so `acme-web` and `Acme-Web` are
   * one repository, while the DB's `(project_id, name)` unique index only catches
   * the exact duplicate. That index is still the arbiter of a lost race, and its
   * P2002 is translated to the same typed error.
   *
   * `proposalSignal` records WHY Motir proposed the row (ADR §0.1) and is
   * supplied only by the derivation (MOTIR-1881 through MOTIR-1892). A caller
   * that omits it — every hand-added row — persists NULL, which is what makes the
   * column distinguish "Motir inferred this" from "the user asked for this"
   * rather than attributing an inference to nobody.
   */
  async addRow(
    projectId: string,
    input: AddProjectRepoInput,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    const name = validateName(input.name);
    const label = validateLabel(input.label);
    // The default is the seed REGISTRY's (MOTIR-706 3.8), read live, so a role
    // whose foundation is registered later gets it with no code change here.
    const seedSource = validateSeedSource(
      input.seedSource ??
        (await seedRegistryService.defaultSeedSourceForRole(input.role as ProjectRepoRole)),
    );
    const proposalSignal = validateProposalSignal(input.proposalSignal);
    const seedMatch = validateSeedMatch(input.seedMatch);

    const row = await inProject(projectId, ctx, 'edit', async (tx) => {
      const clash = await projectRepoRepository.findByProjectAndNameInsensitive(
        projectId,
        name,
        ctx.workspaceId,
        tx,
      );
      if (clash) throw new ProjectRepoNameTakenError(name, projectId);
      const last = await projectRepoRepository.findLastPosition(projectId, ctx.workspaceId, tx);
      try {
        return await projectRepoRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId,
            role: input.role as ProjectRepoRole,
            label,
            name,
            seedSource,
            proposalSignal,
            seedMatch,
            state: 'proposed',
            position: keyForAppend(last),
          },
          tx,
        );
      } catch (err) {
        translateUniqueViolation(err, { projectId, name, githubRepoId: null });
      }
    });
    // A freshly-created row is `proposed`, so it is unrealized by construction.
    return toProjectRepoDto({ ...row, githubRepo: null, collaborators: [] });
  },

  /**
   * PARTIALLY edit a row — the establish step lets the user rename a row, change
   * its role, or switch what it seeds from before anything is created.
   *
   * `role` / `name` / `seedSource` are editable only while the row's plan is still
   * open ({@link PLAN_EDITABLE_STATES}): a `creating` row has a creation in flight
   * under that exact name, and a settled row's repository already exists, so
   * editing either would make the record disagree with reality. `label` is
   * editable in every state — it is a human annotation that drives nothing.
   *
   * Changing the `role` deliberately does NOT re-derive `seedSource`: an edited
   * value is a decision, and silently rewriting it would be the freeze-a-guess
   * defect `docs/decisions/target-repo-attribution.md` §3 warns about. A caller
   * that wants the new role's default passes `seedSource` explicitly.
   */
  async patchRow(
    rowId: string,
    input: PatchProjectRepoInput,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    const wantsPlanEdit =
      input.role !== undefined || input.name !== undefined || input.seedSource !== undefined;
    const name = input.name !== undefined ? validateName(input.name) : undefined;
    const seedSource =
      input.seedSource !== undefined ? validateSeedSource(input.seedSource) : undefined;
    // `label` is only in the patch when the key is PRESENT; `label: null` clears it.
    const label = 'label' in input ? validateLabel(input.label) : undefined;

    return inLockedRow(rowId, ctx, async (row, tx) => {
      // A re-point's own refusals come first, each naming its rule (MOTIR-709):
      // the organisation's repository is never seeded (D1), and a row past
      // `proposed` / `failed` already has its repository, or one on the way.
      if (seedSource !== undefined && isOrganizationSeedSource(row.seedSource)) {
        throw new ProjectRepoSeedRefusedError(
          'organization_row',
          seedSource,
          "it is the organisation's own repository, which Motir never seeds.",
        );
      }
      if (seedSource !== undefined && !PLAN_EDITABLE_STATES.includes(row.state)) {
        throw new ProjectRepoSeedRefusedError(
          'not_editable',
          seedSource,
          `a ${row.state} repository already exists or is being created.`,
        );
      }
      if (wantsPlanEdit && !PLAN_EDITABLE_STATES.includes(row.state)) {
        throw new ProjectRepoInvalidFieldError(
          'state',
          `a ${row.state} row's role / name / seed source can no longer be edited (only ${PLAN_EDITABLE_STATES.join(' or ')} rows can); its label still can.`,
        );
      }
      const repointed =
        seedSource !== undefined
          ? await checkRepoint(seedSource, {
              role: (input.role ?? row.role) as ProjectRepoRole,
              hostingTarget: row.hostingTarget,
            })
          : undefined;
      if (name !== undefined) {
        const clash = await projectRepoRepository.findByProjectAndNameInsensitive(
          row.projectId,
          name,
          ctx.workspaceId,
          tx,
          rowId,
        );
        if (clash) throw new ProjectRepoNameTakenError(name, row.projectId);
      }
      try {
        const updated = await projectRepoRepository.update(
          rowId,
          {
            ...(input.role !== undefined ? { role: input.role as ProjectRepoRole } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(label !== undefined ? { label } : {}),
            // A person's choice is authoritative and is not the matching's, so
            // the recorded match result is cleared with it.
            ...(repointed !== undefined ? { seedSource: repointed, seedMatch: null } : {}),
          },
          tx,
        );
        return toProjectRepoDto({
          ...updated,
          githubRepo: row.githubRepo,
          collaborators: row.collaborators,
        });
      } catch (err) {
        translateUniqueViolation(err, {
          projectId: row.projectId,
          name: name ?? row.name,
          githubRepoId: row.githubRepoId,
        });
      }
    });
  },

  /**
   * REMOVE a row from the set — how a user drops a repository they do not want,
   * and (per the transitions module) how a settled row is re-planned.
   *
   * Removing a row NEVER touches the repository itself: a created repo is a real
   * artifact in the user's own account, and deleting it to tidy a record would be
   * strictly worse than reporting the truth (ADR §4.2). Removing an established
   * row therefore un-claims its `GithubRepo`, which stays connected to the
   * workspace and can be attached to another row later. Idempotent: removing an
   * already-gone row is a no-op, not a 404, so a double-submit is harmless.
   */
  async removeRow(rowId: string, ctx: ServiceContext): Promise<void> {
    const existing = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      projectRepoRepository.findById(rowId, ctx.workspaceId, tx),
    );
    if (!existing) return;
    await projectAccessService.assertCanEdit(existing.projectId, ctx);
    await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: existing.projectId },
      async (tx) => {
        await projectRepoRepository.deleteById(rowId, tx);
        // Removing the last UNSETTLED row can be what establishes the set (MOTIR-5178).
        await projectPrMergeModeService.seedAtEstablishment(
          existing.projectId,
          ctx.workspaceId,
          tx,
        );
      },
    );

    // POST-COMMIT, BEST-EFFORT — the removed row's repository must LEAVE the
    // project's runner group (MOTIR-1972). The access list is the other half of
    // the establish seam's sync: a grant that outlives the row it came from is a
    // runner Motir booted for this project still being able to serve a repository
    // the project no longer claims. Only an ESTABLISHED row had an id in the list
    // at all, so removing a `proposed` one re-writes the same array — which is
    // exactly why the sync is a whole-set re-derivation and needs no branch here.
    await projectRunnerGroupService.syncQuietly({
      projectId: existing.projectId,
      workspaceId: ctx.workspaceId,
    });
  },

  /**
   * RE-PLAN a settled-but-empty-handed row: drop it and put a FRESH `proposed`
   * row in its place, carrying the same role, name, label, seed source, derivation
   * signal and position.
   *
   * This is the ADR §4.1 note made callable. A settled state has no outgoing edge
   * ON PURPOSE — "this repository was created" must never be quietly overwritten
   * by "actually, skip it" — and the ADR's own prescribed way to change one's mind
   * is to REMOVE the row and add a fresh one. That is exactly what this does, in
   * ONE transaction so the set is never briefly missing the row, and only from
   * {@link REPLANNABLE_STATES} (the two settlements that made nothing). It is what
   * the establish step's **Create it after all** (on a skipped row) and
   * **Let Motir host it** (on a connected one) call; widening it to `created`
   * would be an ADR change, not a code change.
   *
   * The row's IDENTITY changes — a new id — because the old decision is genuinely
   * over. `proposalSignal` is deliberately carried across: it records what Motir
   * inferred at proposal time, and the user re-planning the row does not rewrite
   * that history (the same reason an edit does not clear it).
   */
  async replanRow(rowId: string, ctx: ServiceContext): Promise<ProjectRepoDto> {
    const created = await inLockedRow(rowId, ctx, async (row, tx) => {
      if (!REPLANNABLE_STATES.includes(row.state)) {
        // Not an illegal-TRANSITION: nothing is being transitioned. The row's
        // state simply makes re-planning the wrong operation, and the caller's
        // correct move is `removeRow` (or, for an unsettled row, editing it in
        // place) — which the 422 says rather than implying a hop exists.
        throw new ProjectRepoInvalidFieldError(
          'state',
          `a ${row.state} row cannot be re-planned (only ${REPLANNABLE_STATES.join(' or ')} rows can); remove it instead.`,
        );
      }
      // Delete FIRST: the `(project_id, name)` unique index would otherwise reject
      // the replacement, since it carries the same name by design.
      await projectRepoRepository.deleteById(rowId, tx);
      return projectRepoRepository.create(
        {
          workspaceId: ctx.workspaceId,
          projectId: row.projectId,
          role: row.role,
          label: row.label,
          name: row.name,
          seedSource: row.seedSource,
          proposalSignal: row.proposalSignal,
          seedMatch: row.seedMatch,
          state: 'proposed',
          position: row.position,
        },
        tx,
      );
    });
    // A freshly-created row is `proposed`, so it is unrealized by construction —
    // which is also the point: re-planning UN-claims whatever the old row held.
    return toProjectRepoDto({ ...created, githubRepo: null, collaborators: [] });
  },

  /**
   * MOVE a row one place up or down the set — the keyboard-operable reorder the
   * establish step exposes as **Move up** / **Move down**.
   *
   * Order is MEANINGFUL: the first row is the project's PRIMARY repository (ADR
   * §1.3), so this is a real decision, not a display preference. A row already at
   * the edge it is asked to move toward is a NO-OP that returns the row unchanged
   * rather than an error — a double-press on the top row is not a failure, and the
   * UI disables those controls anyway.
   *
   * Legal in EVERY state. Reordering says which repository is primary; it neither
   * touches a repository nor claims anything about one, so a settled row reorders
   * exactly like a proposed one.
   */
  async moveRow(
    rowId: string,
    direction: 'up' | 'down',
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    return inLockedRow(rowId, ctx, async (row, tx) => {
      // Read the ordered set INSIDE the same transaction that holds the row lock,
      // so the neighbours the new key is computed between cannot move underneath
      // it (the lock-before-read-derived-update rule — the key is derived from the
      // neighbours' positions).
      const rows = await projectRepoRepository.listByProject(row.projectId, ctx.workspaceId, tx);
      const index = rows.findIndex((r) => r.id === rowId);
      const target =
        direction === 'up'
          ? index <= 0
            ? null
            : keyBetweenSafe(rows[index - 2]?.position ?? null, rows[index - 1]!.position)
          : index === -1 || index >= rows.length - 1
            ? null
            : keyBetweenSafe(rows[index + 1]!.position, rows[index + 2]?.position ?? null);

      if (target === null) return toProjectRepoDto(row);
      const updated = await projectRepoRepository.update(rowId, { position: target }, tx);
      return toProjectRepoDto({
        ...updated,
        githubRepo: row.githubRepo,
        collaborators: row.collaborators,
      });
    });
  },

  /**
   * Record WHO owns the set and WHICH account it lands in (ADR §3.2 / §3.4) — one
   * choice for the whole SET, stored on the project, never per row. §3.5 is what
   * makes that the right shape: a set is never half in the user's account and half
   * in Motir's, so a row that cannot be created in the chosen target fails as a row
   * rather than silently retargeting.
   */
  async setOwnership(
    projectId: string,
    input: SetProjectRepoOwnershipInput,
    ctx: ServiceContext,
  ): Promise<ProjectRepoSetDto> {
    const targetAccount = input.targetAccount.trim();
    if (targetAccount.length === 0) {
      throw new ProjectRepoInvalidFieldError('targetAccount', 'it must not be blank.');
    }
    if (targetAccount.length > TARGET_ACCOUNT_MAX) {
      throw new ProjectRepoInvalidFieldError(
        'targetAccount',
        `it must be at most ${TARGET_ACCOUNT_MAX} characters.`,
      );
    }
    return inProject(projectId, ctx, 'edit', async (tx) => {
      await projectRepository.setRepoSetOwnership(
        projectId,
        { ownership: input.ownership, targetAccount },
        tx,
      );
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      return toProjectRepoSetDto(projectId, rows, {
        repoSetOwnership: input.ownership,
        repoSetTargetAccount: targetAccount,
      });
    });
  },

  // ── The establish machine (ADR §4.1) ─────────────────────────────────────
  //
  // Exposed as SEPARATE short transactions rather than one "create the repo"
  // method, because repo creation is a network side effect that must happen
  // OUTSIDE any transaction: the creation primitive (MOTIR-1781) calls
  // `markCreating`, does its GitHub work with no row locked, then calls
  // `attachRealizedRepo` or `markFailed`. Every hop is legality-checked against
  // `lib/projectRepos/transitions.ts` under the row lock.

  /**
   * Move a row to `state`, if that hop is legal from where it currently sits.
   * Rejects with {@link ProjectRepoStateTransitionError} otherwise — naming the
   * legal targets so a caller self-corrects, the same self-correcting shape
   * `transition_status` uses for a work item.
   *
   * `failureReason` is REQUIRED for a hop to `failed` (a failed row that cannot say
   * why is exactly the "partial establishment inferred rather than recorded" the
   * table exists to prevent) and is CLEARED on every other hop, so a retried row
   * does not carry the stale reason for a failure it recovered from.
   */
  async transitionRow(
    rowId: string,
    state: ProjectRepoState,
    ctx: ServiceContext,
    options: { failureReason?: string } = {},
  ): Promise<ProjectRepoDto> {
    let failureReason: string | null = null;
    if (state === 'failed') {
      const reason = (options.failureReason ?? '').trim();
      if (reason.length === 0) {
        throw new ProjectRepoInvalidFieldError(
          'failureReason',
          'a row moving to failed must record why.',
        );
      }
      failureReason = reason.slice(0, FAILURE_REASON_MAX);
    }

    return inLockedRow(rowId, ctx, async (row, tx) => {
      if (!canTransition(row.state, state)) {
        throw new ProjectRepoStateTransitionError(
          rowId,
          row.state,
          state,
          allowedTransitions(row.state),
        );
      }
      const updated = await projectRepoRepository.update(rowId, { state, failureReason }, tx);
      // A hop to a settled state may be what ESTABLISHES the set (MOTIR-5178).
      await projectPrMergeModeService.seedAtEstablishment(row.projectId, ctx.workspaceId, tx);
      return toProjectRepoDto({
        ...updated,
        githubRepo: row.githubRepo,
        collaborators: row.collaborators,
      });
    });
  },

  /** `proposed | failed → creating` — the creation primitive claims the row before
   *  it touches GitHub, so a concurrent run observes `creating` and backs off. */
  markCreating(rowId: string, ctx: ServiceContext): Promise<ProjectRepoDto> {
    return this.transitionRow(rowId, 'creating', ctx);
  },

  /** `creating → failed`, recording WHY (ADR §4.1) — resumable, not terminal: the
   *  row can then be retried, connected to an existing repo, or skipped. */
  markFailed(rowId: string, reason: string, ctx: ServiceContext): Promise<ProjectRepoDto> {
    return this.transitionRow(rowId, 'failed', ctx, { failureReason: reason });
  },

  /** `proposed | failed → skipped` — deliberately without a repository, which is
   *  NOT an error (ADR §4.3): approval may complete with a row unresolved, leaving
   *  the project explicitly code-less for that role. */
  skipRow(rowId: string, ctx: ServiceContext): Promise<ProjectRepoDto> {
    return this.transitionRow(rowId, 'skipped', ctx);
  },

  /**
   * REALIZE a row: attach the `GithubRepo` mirror row that now backs it, and settle
   * its state in the SAME locked transaction — this is the seam that makes one
   * table serve as both the plan and the record, so the two can never disagree.
   *
   * The target state is DERIVED from where the row sits, because ADR §4.1 leaves no
   * ambiguity: a row Motir was creating becomes `created`; a `proposed` or `failed`
   * row being pointed at a repository that already exists becomes `connected`
   * (which is also how a monorepo collapses the set to one row). A settled row has
   * no legal hop, so re-attaching to one is the typed illegal-transition error, not
   * a silent overwrite of which repo a project's code lives in.
   *
   * Called by the creation primitive (MOTIR-1781) AFTER its GitHub work completes —
   * never with a transaction held open across that round-trip.
   *
   * POST-COMMIT, this fires the role → repo-name RESOLUTION (MOTIR-1913): a row
   * reaching an established state is exactly the moment items pinned to its role
   * can finally be told which repository they ship in. It is wired HERE rather than
   * in each caller because this method is the ONE seam every establish path goes
   * through — the creation primitive's `created` hop and the establish UI's
   * connect-existing `connected` hop alike — so neither has to remember it and
   * neither can drift. Best-effort by design: the repository EXISTS and the row IS
   * established by the time this runs, and failing the attach over a derived pin
   * would report a settled row as failed. The pass is idempotent, so the next
   * establish (or an explicit re-run) completes what a dropped one missed.
   */
  async attachRealizedRepo(
    rowId: string,
    githubRepoId: string,
    ctx: ServiceContext,
    seed: { seedHeadSha?: string | null } = {},
  ): Promise<ProjectRepoDto> {
    const attached = await this.attachRealizedRepoRow(rowId, githubRepoId, ctx, seed);
    // ⚠️ MOTIR-1913's PIN RESOLUTION PASS USED TO RUN HERE, AND IT IS GONE
    // (Story MOTIR-2732 · MOTIR-3040, ADR `work-item-repository-set.md`
    // "Amendment 2026-08-18" §A3's RETIRE branch).
    //
    // It existed because a card pinned a repository by ROLE — a name being
    // meaningless before the repository was created — so something had to fill the
    // name in at the moment a row became established. Under the reference model a
    // card points at the ROW, from birth, and a row is a legal target in ANY
    // state. So establishing a row now makes every card that points at it resolve
    // to a name ON THE NEXT READ, because the name is derived: there is nothing
    // left for a pass to write.
    //
    // Nothing replaces it. If you are here looking for where the pin gets filled,
    // the answer is that it no longer needs filling.

    // POST-COMMIT, BEST-EFFORT — grant the actor ACCESS to the repository that
    // now exists (MOTIR-1900). Wired at this same seam, and for the same reason
    // the pin resolution is: a row reaching an established state is exactly the
    // moment there is something to be let into, and this is the ONE method every
    // establish path goes through, so no caller has to remember it and none can
    // drift.
    //
    // Only a row Motir CREATED needs it — a `connected` row is the user's own
    // repository — and the service applies that rule itself, so this call stays
    // unconditional and the rule stays in one place.
    //
    // LAZILY IMPORTED to keep the module graph acyclic: the access service
    // orchestrates over THIS service (it reads the set and writes the rows), so a
    // top-level import here would close a cycle. Same shape as `plansService`'s
    // lazy reach for the repo-set proposal.
    try {
      const { projectRepoAccessService } = await import('@/lib/services/projectRepoAccessService');
      await projectRepoAccessService.inviteAfterEstablish(rowId, attached.projectId, ctx);
    } catch (err) {
      console.error(
        `[projectRepoSetService] could not grant collaborator access after establishing row ${rowId}:`,
        err,
      );
    }

    // POST-COMMIT, BEST-EFFORT — add the repository this row just realized to the
    // project's OWN runner group (MOTIR-1972 · `ci-runner-fleet.md` §7.3). Wired
    // at this same seam and for the same reason the two passes above are: this is
    // the ONE method every establish path goes through — the creation primitive's
    // `created` hop AND the establish UI's connect-existing `connected` hop — so
    // no caller has to remember it and none can drift.
    //
    // A whole-set re-sync rather than an append, because rows establish
    // INDEPENDENTLY and asynchronously (ADR §4.1): the desired access list is
    // whatever the set says right now, and the service takes the project's row
    // lock to make that read-derived write safe against a sibling row settling at
    // the same moment.
    await projectRunnerGroupService.syncQuietly({
      projectId: attached.projectId,
      workspaceId: ctx.workspaceId,
    });
    return attached;
  },

  // ── Collaborator access (MOTIR-1900, per-member since MOTIR-1910) ─────────

  /**
   * Record that `userId`'s GitHub account was INVITED to this row's repository at
   * `permission`.
   *
   * Runs under the row's lock AND the collaborator record's own `FOR UPDATE`,
   * because this is a read-derived write: whether the record is already accepted
   * decides what may be written, so that answer must not move between the read and
   * the write. Two concurrent grant passes (a poll and a **Resend**, two tabs, an
   * all-members sweep racing one member's retry) therefore serialize here rather
   * than interleaving — the GitHub call itself is idempotent, so the only thing at
   * risk was the record, and the locks are what protect it.
   *
   * ⚠️ `acceptedAt` IS NEVER CLEARED. `alreadyHasAccess` sets it (a `204` means the
   * account can already clone, with no invitation to accept), and a plain re-invite
   * leaves an existing stamp exactly as it was. The alternative — writing
   * `accepted: false` on every invite — is the lost update these locks exist to
   * prevent: a re-send racing an acceptance would report the member as merely
   * invited forever, and the surface would tell them to accept an invitation they
   * had already accepted.
   *
   * ⚠️ The ROW lock is taken as well as the record's, and deliberately: it is what
   * serialises this write against a concurrent state TRANSITION of the repository
   * row itself, so an invitation can never be recorded against a row that is
   * simultaneously being re-planned out from under it.
   */
  async recordCollaboratorInvite(
    rowId: string,
    input: {
      userId: string;
      login: string;
      permission: ProjectRepoCollaboratorPermission;
      invitationUrl: string | null;
      alreadyHasAccess: boolean;
    },
    ctx: ServiceContext,
  ): Promise<void> {
    await inLockedRow(rowId, ctx, async (_row, tx) => {
      const now = new Date();
      const existing = await projectRepoCollaboratorRepository.findForUpdate(
        rowId,
        input.userId,
        ctx.workspaceId,
        tx,
      );
      await projectRepoCollaboratorRepository.upsert(
        { projectRepoId: rowId, userId: input.userId, workspaceId: ctx.workspaceId },
        {
          githubLogin: input.login,
          permission: input.permission,
          invitedAt: now,
          invitationUrl: input.invitationUrl,
          // Keep an existing stamp; set one only when GitHub just told us the
          // account already has access. Never null.
          acceptedAt:
            existing?.acceptedAt ?? (input.alreadyHasAccess ? now : (existing?.acceptedAt ?? null)),
        },
        tx,
      );
    });
  },

  /**
   * Record that the invited account has been OBSERVED to have access.
   *
   * Idempotent and monotonic: a row already stamped keeps its ORIGINAL stamp, so
   * a repeated refresh never rewrites when access was first seen. Locked for the
   * same read-derived reason as the invite write above.
   */
  async recordCollaboratorAccepted(
    rowId: string,
    userId: string,
    ctx: ServiceContext,
  ): Promise<void> {
    await inLockedRow(rowId, ctx, async (_row, tx) => {
      const existing = await projectRepoCollaboratorRepository.findForUpdate(
        rowId,
        userId,
        ctx.workspaceId,
        tx,
      );
      // No record, or already stamped: nothing to do. The monotonicity is the
      // point — a repeated refresh must never rewrite WHEN access was first seen.
      if (!existing || existing.acceptedAt !== null) return;
      await projectRepoCollaboratorRepository.markAccepted(existing.id, new Date(), tx);
    });
  },

  /** {@link attachRealizedRepo} WITHOUT the post-commit pin resolution — the row
   *  write on its own, in its one locked transaction. Split out so the resolution
   *  reads a COMMITTED set rather than joining the lock that produced it. */
  async attachRealizedRepoRow(
    rowId: string,
    githubRepoId: string,
    ctx: ServiceContext,
    seed: { seedHeadSha?: string | null } = {},
  ): Promise<ProjectRepoDto> {
    return inLockedRow(rowId, ctx, async (row, tx) => {
      const target: ProjectRepoState = row.state === 'creating' ? 'created' : 'connected';
      if (!canTransition(row.state, target)) {
        throw new ProjectRepoStateTransitionError(
          rowId,
          row.state,
          target,
          allowedTransitions(row.state),
        );
      }
      // ⚠️ THE CLAIM GUARD, RE-ASKED AT THE GRAIN THE PRODUCT NOW HAS
      // (MOTIR-4648). It used to ask "is this repository claimed ANYWHERE?",
      // because `github_repo_id` was globally unique. It now asks "is it already
      // in THIS project's set?" — which is the guarantee that survived, and the
      // one the 409 was always really about: connecting the same repository into
      // one project twice is a mistake; two projects sharing one is the model.
      //
      // The pre-check still only turns the common same-tenant case into a clean
      // 409; `@@unique([projectId, githubRepoId])` is the real, tenant-blind
      // guarantee and its P2002 is translated below, unchanged.
      const claimant = await projectRepoRepository.findByProjectAndGithubRepoId(
        row.projectId,
        githubRepoId,
        tx,
      );
      if (claimant && claimant.id !== rowId) {
        throw new RealizedRepoAlreadyClaimedError(githubRepoId);
      }
      try {
        // Only a repository Motir CREATED has a seed head (MOTIR-4589); a
        // connected one is the user's, with history of its own.
        const seedHeadSha = target === 'created' ? (seed.seedHeadSha ?? null) : null;
        const updated = await projectRepoRepository.update(
          rowId,
          { githubRepoId, state: target, failureReason: null, seedHeadSha },
          tx,
        );
        // The `created` / `connected` hop may be what ESTABLISHES the set (MOTIR-5178).
        await projectPrMergeModeService.seedAtEstablishment(row.projectId, ctx.workspaceId, tx);
        const realized = await projectRepoRepository.findById(rowId, ctx.workspaceId, tx);
        return toProjectRepoDto(realized ?? { ...updated, githubRepo: null, collaborators: [] });
      } catch (err) {
        translateUniqueViolation(err, { projectId: row.projectId, name: row.name, githubRepoId });
      }
    });
  },

  /**
   * Record where a Motir repo's app runs, what it is for and how big it is
   * (MOTIR-9808) — the plan's hosting decision and build directly are the two
   * callers. One locked transaction; returns the row's DTO.
   *
   * Refuses, changing nothing: a value outside the vocabulary
   * (`ProjectRepoInvalidFieldError` naming `target` / `useCase` / `size`), a
   * customer row (`ProjectRepoNotMotirHostedError`, D1) and a row already on a
   * DIFFERENT target (`ProjectRepoHostingTargetFixedError` — moving is a
   * migration, D3). The same three values again are a no-op with no write; on
   * the same target the use case and size may be revised.
   */
  async setHosting(
    rowId: string,
    input: { target: string; useCase: string; size: string },
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    const { target, useCase, size } = input;
    if (!isHostingTarget(target)) {
      throw new ProjectRepoInvalidFieldError(
        'target',
        `must be one of ${HOSTING_TARGETS.join(', ')}.`,
      );
    }
    if (!isHostingUseCase(useCase)) {
      throw new ProjectRepoInvalidFieldError(
        'useCase',
        `must be one of ${HOSTING_USE_CASES.join(', ')}.`,
      );
    }
    if (!isHostingSize(size)) {
      throw new ProjectRepoInvalidFieldError('size', `must be one of ${HOSTING_SIZES.join(', ')}.`);
    }
    return inLockedRow(rowId, ctx, async (row, tx) => {
      if (isOrganizationSeedSource(row.seedSource)) throw new ProjectRepoNotMotirHostedError(rowId);
      if (row.hostingTarget !== null && row.hostingTarget !== target) {
        throw new ProjectRepoHostingTargetFixedError(rowId, row.hostingTarget, target);
      }
      if (
        row.hostingTarget === target &&
        row.hostingUseCase === useCase &&
        row.hostingSize === size
      ) {
        return toProjectRepoDto(row);
      }
      const updated = await projectRepoRepository.setHosting(
        rowId,
        { hostingTarget: target, hostingUseCase: useCase, hostingSize: size },
        tx,
      );
      return toProjectRepoDto({
        ...updated,
        githubRepo: row.githubRepo,
        collaborators: row.collaborators,
      });
    });
  },
};
