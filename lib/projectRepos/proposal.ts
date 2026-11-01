import type { ProjectRepoProposalSignalDto, ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import {
  PROJECT_REPO_ROLES,
  SEED_SOURCE_PLATFORM_STARTER,
  defaultSeedSourceForRole,
} from './vocabulary';

// DERIVING the project's repository set (Story MOTIR-1775 · MOTIR-1881) — the
// answer to "how many repositories does this project need?", specified by
// `docs/decisions/project-repository-set.md` §0.1 (what the proposal is derived
// from), §1.3/§1.4 (order + naming) and §2 (seed source per role).
//
// PURE by construction: no Prisma, no network, no clock, no `ProjectRepo` row. It
// maps a SIGNAL BUNDLE to an ordered list of intended rows, which is what makes
// the derivation unit-testable from a fixture with no plan and no GitHub — and
// what keeps the gathering (which does touch the DB and the motir-ai boundary)
// separate, in `projectRepoProposalService`.
//
// The output is a PROPOSAL, never a decision. ADR §0.2: the user confirms or edits
// the set at the establish step, and nothing is created until they do. That is the
// whole reason this file is allowed to be as unsure as it is — and the reason it
// must NOT pretend otherwise. A confident-looking three-repo proposal derived from
// prose is worse than a one-row proposal the user extends: the first is a guess
// wearing the authority of a decision, the second is honest. So every row carries
// the SIGNAL that produced it, and a row with no nameable signal is not emitted.

/**
 * WHY a proposed row is in the set — the §0.1 signal that produced it, in ladder
 * order. Machine-readable on purpose: the establish-step UI (MOTIR-1782) maps it
 * to its own copy rather than rendering {@link ProposedRepoRow.reason}, which is
 * an English fallback for logs and PR/debug output, not a localized string.
 *
 * The derivation's name for {@link ProjectRepoProposalSignalDto} — the SAME type,
 * not a parallel one, since MOTIR-1892 made the signal a persisted column and
 * therefore part of the wire shape. The ladder's per-rung documentation and its
 * runtime list live with the DTO and `lib/projectRepos/vocabulary.ts`
 * respectively; this alias keeps the derivation reading in its own vocabulary
 * without admitting a second spelling of the same three values.
 *
 *   * `plan-item-role` — §0.1.1, a repo ROLE pinned on the generated tree. The
 *     primary signal: the plan is the only artifact that describes what is
 *     actually being built, and it is what makes a frontend/backend split produce
 *     two rows with nobody asked a question. Reaches this module through
 *     {@link RepoSetSignals.itemRoles}; see its doc for who fills it.
 *   * `preplan-platform` — §0.1.2, the pre-plan session's `platform`, which fixes
 *     the PRIMARY row's role when the tree carries no roles.
 *   * `default-web` — §0.1.4, the thin-signal default: exactly one `web` row,
 *     because that is what the one default platform starter is.
 */
export type RepoProposalSignal = ProjectRepoProposalSignalDto;

/**
 * The signals a repo-set proposal may be derived from (ADR §0.1), gathered by
 * `projectRepoProposalService`. Every field except the slug is optional: the
 * ladder degrades to the one-web-repo default rather than failing, which is the
 * behaviour the ADR's consequences require of a project that never ran a pre-plan
 * (a migrated or seeded project reads `session: null`).
 */
export interface RepoSetSignals {
  /** The project's `slug` — the naming stem (§1.4). */
  projectSlug: string;
  /**
   * §0.1.1 — the distinct repo ROLES the generated tree pins, in the plan's own
   * order.
   *
   * EMPTY TODAY, and deliberately so: on `origin/main` a proposal carries no repo
   * field (`PlanItemProposedFields` is title/kind/description/type/priority/
   * executor/sizing/explanation/provenance), and motir-ai's proposal schema emits
   * none. The producer is MOTIR-1885 and the plan→materialize carrier is
   * MOTIR-1884; ADR §5.5 names both. This is the seam they fill — NOT a prose
   * inference this module makes in the meantime, which is exactly the
   * over-inference the card forbids.
   */
  itemRoles?: readonly ProjectRepoRoleDto[];
  /**
   * §0.1.2 — the pre-plan session's `platform` (motir-ai's `PROJECT_PLATFORMS`:
   * `web` / `mobile` / `desktop` / `other`). An unknown or absent value falls
   * through to the default; it is typed as a plain string because motir-ai owns
   * the vocabulary and a core-side enum would drift from it.
   */
  platform?: string | null;
  /**
   * §0.1.3 — the design step's chosen starter (`designStarter`), which fixes what
   * a `web` row seeds from. See {@link seedSourceForRole} for why both of its
   * values resolve to the same starter today.
   */
  designStarter?: string | null;
}

/** One intended repository, as PROPOSED — not yet a row, and not yet a decision. */
export interface ProposedRepoRow {
  role: ProjectRepoRoleDto;
  /** §1.4: `<project-slug>` at one row, `<project-slug>-<role>` at two or more. */
  name: string;
  /** The role's FIXED default (706 v2 §3.8). The proposer stores the seed
   *  MATCHING's choice instead (MOTIR-709, `seedRegistryService.matchSeedEntry`),
   *  which agrees with this on a registry holding only the shipped seeds. */
  seedSource: string;
  /** The §0.1 signal that justified this row (see {@link RepoProposalSignal}). */
  signal: RepoProposalSignal;
  /** A one-line English statement of the same thing, for logs and PR output. */
  reason: string;
}

/** GitHub's repo-name charset, applied to the slug STEM defensively so a name
 *  this module derives can never be rejected by the set service's own validation
 *  (which is the arbiter — this is belt, not a second policy). */
function repoNameStem(projectSlug: string): string {
  const stem = projectSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return stem.length > 0 ? stem : 'project';
}

/**
 * ADR §1.1's `platform` → primary-role mapping. `desktop` and `other` both land on
 * the `other` role, which §1.1 defines as exactly that escape hatch ("a CLI, a
 * desktop app, a docs site"). An unknown / absent platform returns `null` — the
 * caller then falls to §0.1.4's default rather than guessing a role from a value
 * it does not recognise.
 */
export function platformToRepoRole(platform: string | null | undefined): ProjectRepoRoleDto | null {
  switch (platform) {
    case 'web':
      return 'web';
    case 'mobile':
      return 'mobile';
    case 'desktop':
    case 'other':
      return 'other';
    default:
      return null;
  }
}

/**
 * ADR §2's seeding table: a `web` row seeds from the ONE default platform starter,
 * every other role from an INITIALISED repo (README naming the role, licence,
 * `.gitignore`, CI stub) with no scaffold pretence.
 *
 * `designStarter` is threaded through — it is §0.1.3's signal and the seam
 * MOTIR-709's starter registry will resolve — but it does not select among
 * starters today, and this function is where that is recorded rather than assumed:
 * `aiPreplanService` writes `'bare'` on a design pick and `'with-design'` on a
 * skip, describing two starters, and ADR §2's "one correction to record" is that
 * there is now ONE — `nextjs-prisma-vercel-starter-with-design` is retired and
 * archived, and the bare starter ships `@motir/design-system`. So both values
 * resolve to the same starter, and the flag survives as the record of the user's
 * design CHOICE, not as a repo selector.
 */
export function seedSourceForRole(
  role: ProjectRepoRoleDto,
  _designStarter?: string | null,
): string {
  return role === 'web' ? SEED_SOURCE_PLATFORM_STARTER : defaultSeedSourceForRole(role);
}

/** ADR §1.4's naming rule. The suffix appears only once there is something to
 *  disambiguate, so a single-repo project's one row reads as the project itself
 *  and nothing about it looks like "one of several" (§6). */
export function proposedRepoName(
  projectSlug: string,
  role: ProjectRepoRoleDto,
  setSize: number,
): string {
  const stem = repoNameStem(projectSlug);
  return setSize <= 1 ? stem : `${stem}-${role}`;
}

/** Order the derived roles: the platform's PRIMARY role first when the tree names
 *  it (§1.3 — the first row is the project's primary repo), then the rest in the
 *  ADR §1.1 vocabulary order, so the same signals always yield the same set. */
function orderRoles(
  roles: readonly ProjectRepoRoleDto[],
  primary: ProjectRepoRoleDto | null,
): ProjectRepoRoleDto[] {
  const present = new Set(roles);
  const ordered: ProjectRepoRoleDto[] = [];
  if (primary !== null && present.has(primary)) {
    ordered.push(primary);
    present.delete(primary);
  }
  for (const role of PROJECT_REPO_ROLES) {
    if (present.has(role)) ordered.push(role);
  }
  return ordered;
}

/**
 * Derive the project's proposed repository set from the signals in hand (ADR
 * §0.1's ladder, each step falling through when its signal is absent):
 *
 *   1. the ROLES the generated tree pins → one row per distinct role;
 *   2. else the pre-plan `platform` → one row, that platform's role;
 *   3. else exactly one `web` row (§0.1.4).
 *
 * Never returns an empty list: a project always needs somewhere for its code to
 * live, and "one row you can add to" is the honest floor. Never returns a row
 * whose presence it cannot name — the `signal` field is not decoration, it is the
 * invariant that keeps a wrong proposal arguable rather than mysterious.
 */
export function deriveRepoSetProposal(signals: RepoSetSignals): ProposedRepoRow[] {
  const platformRole = platformToRepoRole(signals.platform);
  const treeRoles = orderRoles(signals.itemRoles ?? [], platformRole);

  if (treeRoles.length > 0) {
    return treeRoles.map((role) =>
      buildRow(role, treeRoles.length, signals, {
        signal: 'plan-item-role',
        reason: `the generated plan pins work to a \`${role}\` repository`,
      }),
    );
  }

  if (platformRole !== null) {
    return [
      buildRow(platformRole, 1, signals, {
        signal: 'preplan-platform',
        reason: `the project's platform is \`${signals.platform}\``,
      }),
    ];
  }

  return [
    buildRow('web', 1, signals, {
      signal: 'default-web',
      reason:
        'the plan names no repository and no platform was recorded — the one default platform starter is a web app',
    }),
  ];
}

function buildRow(
  role: ProjectRepoRoleDto,
  setSize: number,
  signals: RepoSetSignals,
  why: { signal: RepoProposalSignal; reason: string },
): ProposedRepoRow {
  return {
    role,
    name: proposedRepoName(signals.projectSlug, role, setSize),
    seedSource: seedSourceForRole(role, signals.designStarter),
    signal: why.signal,
    reason: why.reason,
  };
}
