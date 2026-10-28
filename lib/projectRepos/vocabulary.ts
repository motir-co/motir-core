import type { ProjectRepoRole, ProjectRepoState } from '@/generated/prisma/client';
import type {
  ProjectRepoProposalSignalDto,
  ProjectRepoRoleDto,
  ProjectRepoSeedMatchDto,
} from '@/lib/dto/projectRepos';

// The repo-SET vocabulary (Story MOTIR-1775 · MOTIR-1780) — the small set of
// constants `docs/decisions/project-repository-set.md` fixes, in one module so no
// consumer re-derives them and no second copy can drift.
//
// Deliberately NOT here: the DERIVATION of a set's contents (which roles a plan
// implies, ADR §0.1) and the NAME derivation (§1.4). Both belong to MOTIR-1881,
// which writes `proposed` rows THROUGH this card's service. This module carries
// only what the schema + service need to be correct today.

/**
 * Every role the ADR §1.1 vocabulary admits, in the ADR's own order. Exported as
 * a value (not just the Prisma type) so a caller can enumerate / validate without
 * importing the generated enum object, and so a totality test can assert this
 * list and the Prisma enum stay in lockstep.
 *
 * Keep in lockstep with motir-ai's proposal-schema role enum (MOTIR-1885) — the
 * same cross-repo constant discipline `AI_DRAFT_EXPLANATION_SOURCE` follows.
 */
export const PROJECT_REPO_ROLES = [
  'web',
  'api',
  'mobile',
  'shared',
  'infra',
  'other',
] as const satisfies readonly ProjectRepoRole[];

/**
 * Whether a value is one of ADR §1.1's roles — the guard a PIN is validated with
 * (MOTIR-1912), and the reason a role can be emitted before any repository
 * exists: the vocabulary is CLOSED and needs no row to check against, unlike a
 * repo NAME, which is only meaningful once the project's set holds it.
 *
 * Takes `unknown` on purpose. A role arrives inside a plan proposal's JSON —
 * written by motir-ai over the 7.1 boundary and persisted verbatim — so the value
 * reaching this guard is genuinely untyped, and `'backend'`, `''` and a number
 * all have to read the same way: not a role.
 */
export function isProjectRepoRole(value: unknown): value is ProjectRepoRoleDto {
  return (PROJECT_REPO_ROLES as readonly unknown[]).includes(value);
}

/** Every per-row establish state (ADR §4.1), in lifecycle order. */
export const PROJECT_REPO_STATES = [
  'proposed',
  'creating',
  'created',
  'connected',
  'skipped',
  'failed',
] as const satisfies readonly ProjectRepoState[];

/**
 * The states in which a row HAS a repository — the ADR's word "established"
 * (§5.3). This is the filter every repo-resolution read applies: a `proposed`,
 * `creating`, `skipped` or `failed` row names no checkout that exists, so a work
 * item must never be pinned to one (§5.3's "matches no established row →
 * `targetRepo` stays null" is exactly this set being empty for a role).
 */
export const ESTABLISHED_PROJECT_REPO_STATES = [
  'created',
  'connected',
] as const satisfies readonly ProjectRepoState[];

/** Whether a row is ESTABLISHED — i.e. it names a repository that exists. */
export function isEstablishedState(state: ProjectRepoState): boolean {
  return (ESTABLISHED_PROJECT_REPO_STATES as readonly ProjectRepoState[]).includes(state);
}

/**
 * Every DERIVATION SIGNAL a proposed row may record (ADR §0.1), in the ladder's
 * own order (MOTIR-1892). The ONE runtime list: the service validates a written
 * value against it, and the derivation's emitted values are asserted against it,
 * so the persisted column can never hold a rung the ADR does not name.
 *
 * A plain STRING column rather than a Prisma enum, for the same reason
 * `seedSource` is one: this vocabulary is a LADDER that grows as §0.1 gains rungs
 * (a repo-role signal from an imported codebase, say), and each new rung already
 * requires code — a derivation branch and the UI's copy for it — so a database
 * enum would add a migration to a change that is a code change either way, and a
 * second place for the two to drift. Unlike `role` (which selects the seed source
 * and is the key a repo pin resolves through), the signal drives NO behaviour: it
 * is explanatory metadata the UI renders. Integrity comes from the closed union +
 * this list + the service's validation, and a value outside it is rejected at the
 * only writer.
 */
export const PROJECT_REPO_PROPOSAL_SIGNALS = [
  /** §0.1.1 — a repo ROLE pinned on the generated tree (the primary signal). */
  'plan-item-role',
  /** §0.1.2 — the pre-plan session's `platform` fixed the primary row's role. */
  'preplan-platform',
  /** §0.1.4 — the thin-signal default: exactly one `web` row. */
  'default-web',
] as const satisfies readonly ProjectRepoProposalSignalDto[];

/** Whether a value is one of the ADR §0.1 signals — the guard the set service
 *  validates a written `proposalSignal` with, so an unknown rung is rejected at
 *  the write rather than discovered by a UI that cannot map it to copy. */
export function isProjectRepoProposalSignal(value: unknown): value is ProjectRepoProposalSignalDto {
  return (PROJECT_REPO_PROPOSAL_SIGNALS as readonly unknown[]).includes(value);
}

/**
 * Every result the seed matching records on a row (MOTIR-709; decision MOTIR-706
 * v2 §3.5) — the ONE runtime list the set service checks a written `seedMatch`
 * against. See {@link ProjectRepoSeedMatchDto} for what each one means.
 */
export const SEED_MATCH_RESULTS = [
  'matched',
  'no_stack_signal',
  'no_target',
  'no_match',
] as const satisfies readonly ProjectRepoSeedMatchDto[];

/** Whether a value is one of {@link SEED_MATCH_RESULTS}. */
export function isSeedMatchResult(value: unknown): value is ProjectRepoSeedMatchDto {
  return (SEED_MATCH_RESULTS as readonly unknown[]).includes(value);
}

/**
 * The registry key of the ONE default platform starter (ADR §2, as amended by the
 * seed-registry decision MOTIR-706 v2, page cmvsezd8800eihnoikhllqqev): a
 * full-stack Next.js + Prisma web app that imports `@motir/design-system` and
 * deploys to the `serverless` target (AWS Lambda, MOTIR-5769 D-2). Its
 * `-with-design` sibling is retired and archived, so there is exactly one, and
 * only a `web` row can be seeded from it.
 *
 * A KEY, not a repository path: the seed registry entry under this key names its
 * template repository (`motir-co/nextjs-prisma-serverless-starter`), and
 * provisioning reads the template from the entry, never by splicing the key
 * into a URL (706 3.1).
 */
export const SEED_SOURCE_PLATFORM_STARTER = 'nextjs-prisma-serverless-starter';

/**
 * The platform starter's key BEFORE the rename (706 3.7): a legacy key of the
 * same registry entry. Migration `20261028200100_rename_platform_starter_seed_source`
 * rewrote every stored row; a row written by an instance still on the old code
 * during the rollout resolves to the same entry. Never written by new code.
 */
export const SEED_SOURCE_LEGACY_PLATFORM_STARTER = 'nextjs-prisma-vercel-starter';

/**
 * The honest fallback for a role the single starter does not fit (ADR §2): an
 * INITIALISED repo — a README naming the project and the row's role, a licence, a
 * `.gitignore`, a CI stub. A non-web repo starts near-empty and the flow says so
 * rather than implying a scaffold that does not exist; the first card dispatched
 * into that repo builds its skeleton, which is what a scaffold would have guessed
 * at, done by an agent that has read the plan.
 */
export const SEED_SOURCE_INITIALISED = 'initialised';

/**
 * A row that seeds from NOTHING because the repository already exists — one the
 * organisation is already connected to, PICKED into this project (Story
 * MOTIR-4669 · MOTIR-4678).
 *
 * ⚠️ IT IS NOT A SEED, AND THAT IS WHY IT NEEDS ITS OWN VALUE. Every other value
 * in this column answers *"what will Motir put in the repository it is about to
 * create?"*. This one answers *"nothing — the repository is the organisation's
 * and it has its own history."* Reusing {@link defaultSeedSourceForRole} here (as
 * the link path first did) makes a picked row indistinguishable from a row Motir
 * planned to scaffold, which is not a cosmetic confusion: the Repositories room
 * splits its two sections on exactly that question, so the row would render under
 * *"Motir hosts…"* offering **Take it over** for a repository the organisation
 * already owns.
 *
 * The column is a free-form string by design — ADR §2 says so, so that the
 * multi-stack starter registry can add keys without a migration — which is what
 * makes this an addition rather than an enum change. It is NOT a registry entry
 * (MOTIR-706 3.1): a customer's repository is never seeded.
 */
export const SEED_SOURCE_ORGANIZATION = 'organization';

/** Whether a row's repository came from the ORGANISATION rather than from Motir.
 *  The room's section split, and the only place the distinction is decided. */
export function isOrganizationSeedSource(seedSource: string): boolean {
  return seedSource === SEED_SOURCE_ORGANIZATION;
}

/**
 * The registry's FIXED default map — decision MOTIR-706 v2, 3.8 (page
 * cmvsezd8800eihnoikhllqqev), which amends ADR §2's seeding table: `web` →
 * {@link SEED_SOURCE_PLATFORM_STARTER}, every other role → `initialised`.
 *
 * ⚠️ THIS IS THE PURE, CLIENT-SAFE HALF. The registry READ is
 * `seedRegistryService.defaultSeedSourceForRole`, which applies the same rule
 * (`lib/seedRegistry/defaults.ts`) over the ACTIVE entries, so a role whose
 * foundation is registered later (`expo-mobile-foundation` for `mobile`,
 * `spring-api-foundation` for `api`, MOTIR-9813) gets it there. A hand-added
 * row's default (`projectRepoSetService.addRow`) reads the registry; this
 * function serves the pure derivations that cannot (`proposal.ts`,
 * `seedMatching.ts`, the client) until MOTIR-709's matching chooses their keys,
 * and it agrees with the read on every registry that holds only the two shipped
 * seeds.
 */
export function defaultSeedSourceForRole(role: ProjectRepoRole): string {
  return role === 'web' ? SEED_SOURCE_PLATFORM_STARTER : SEED_SOURCE_INITIALISED;
}
