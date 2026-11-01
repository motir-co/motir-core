import type { Prisma } from '@/generated/prisma/client';
import type { IndexPauseReason } from '@/lib/ciFleet/indexAllowance';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { getGitProvider, providerSupportsRepoTarballUrl } from '@/lib/git';
import type { GitProviderId, NormalizedRepo } from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { isOnlyItsSeed, NO_COMMIT_BEYOND_TEMPLATE } from '@/lib/projectRepos/seedHead';
import {
  enqueueCodeGraphIndex,
  enqueueReposMissingFirstIndex,
  repoRefOf,
} from '@/lib/github/indexEnqueue';

// codeGraphIndexService (Story 7.5 · MOTIR-1500, the motir-core producer half) —
// the business logic behind the code-graph jobs' READ half. When a repo is
// connected (or pushed to), this resolves WHICH tenant and WHICH projects a
// graph must be built for; the building itself happens in a fleet container
// (`docs/decisions/code-graph-index-fleet.md` §2), so no repo bytes and no host
// token ever pass through this file — the open-core invariant, docs/ai-boundary.md.
//
// 4-layer (CLAUDE.md): the job handler is the "service caller" for a background
// trigger, so the work lives here, not in the definition file, exactly as
// `billingSeatSync` delegates to `billingService`. This service owns the
// repository reads (through the leaves), the RLS context, and the enqueue
// gating. `resolveIndexTarget` is the checkpointed read the step shape drives;
// what the definition file adds is only the SHAPE (which call is a `step.run`),
// which is Inngest's concern and belongs with the job, not in here.
//
// TENANCY: ONE INDEX PER `(organisation, repoRef)` (MOTIR-4652 · MOTIR-4642 ·
// `docs/decisions/code-graph-index-fan-out.md`, MOTIR-2029).
//
// A repo belongs to a WORKSPACE (`GithubRepo.workspaceId` since MOTIR-1931 — NOT
// the installation's, which is NULL for Motir's shared provisioning
// installation), and the workspace belongs to an ORGANISATION. The code graph is
// the ORGANISATION's: one repository has one graph, built once, and which projects
// work on it is visibility configuration rather than a second build.
//
// So this slice resolves the repo's workspace → its `organizationId` and
// dispatches ONE container. It does not enumerate the workspace's projects and it
// does not fan out.
//
// ⚠️ WHAT THIS REPLACED, AND WHY THE COMMENT MATTERS MORE THAN THE DIFF. Until
// MOTIR-4652 this paragraph read: *"resolves its `organizationId` → ALL its
// projects, and the fan-out dispatches ONE container PER PROJECT for the same
// repo"*, and then asked the next reader NOT to fix it — *"narrowing the fan-out
// is a behaviour change to shipped, working code-graph plumbing, and it wants its
// own decision, its own tests and its own review."* It also named MOTIR-1754 as
// the owner, whose own scope boundary handed the question straight back. That is
// how a deferral orphans, and it is why MOTIR-2029 exists. This is the narrowing.
//
// For an organisation with two projects sharing a repository, the old shape
// booted two containers to produce byte-identical graphs — drawing the
// organisation's index allowance twice and consuming Motir's container time
// twice. The multiplier was live in `moooon`.
//
// ⚠️ DECIDED, 2026-09-05 — `docs/decisions/code-graph-index-fan-out.md` (MOTIR-2029).
// This paragraph named MOTIR-1754 for months and that story's own scope boundary
// handed the question straight back, which is exactly how a deferral orphans. It
// is answered now, and NOT by narrowing this fan-out:
//
//   THE CODE GRAPH IS KEYED TO THE ORGANISATION. One repository has ONE graph,
//   built once. Which projects work on it is VISIBILITY CONFIGURATION — an org
//   admin adds a repository to any project, in any workspace of the org, and
//   doing so rebuilds nothing. The repository belongs to the org, the org is the
//   billing unit, so there is no boundary between two of its projects that a
//   second copy of the same graph would protect.
//
// So this fan-out does not get a narrower project list — it stops being a fan-out.
// The decision record carries the eleven-row tenancy audit and the migration
// question it deliberately leaves to the implementation story.
//
// Do not read this paragraph as an invitation to fix it in passing: the change is
// a schema move on both sides of the boundary, and it is that story's.
//
// SIDE-EFFECTS-OUTSIDE-TX: the DB reads run inside one `withSystemContext`
// transaction (RLS-safe under the trusted-writer escape, like the webhook); every
// network side effect — the container dispatch, the enqueues — happens AFTER that
// transaction closes, so a transaction is never held open across a GitHub,
// motir-ai or orchestrator round-trip.

export interface IndexRepoInput {
  /** GitHub's numeric installation id (as a string) — the token-minting key. */
  installationId: string;
  /** The workspace whose repo this is (MOTIR-1931) — stamped from the REPO row at
   *  enqueue time (`handlePush` resolves `repo.workspaceId`; the reconcile/bind
   *  path passes the workspace it just persisted the repo under), and already
   *  carried by both job payloads. NOT re-derived from the installation here: a
   *  Motir-created repo hangs off the shared provisioning installation, which
   *  names no workspace, so that hop would fan the index out into the wrong
   *  tenant's projects — or none. */
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  /** The ref to index — the repo's default branch. */
  defaultBranch: string;
}

/**
 * Why a run indexed nothing. Three of the four are "the tenant went away or has
 * nowhere to put a graph"; `provider_cannot_index` is different in KIND and is
 * called out here so a reader never mistakes it for one of those (MOTIR-2124).
 *
 * ⚠️ `provider_cannot_index` MEANS "THIS REPO WILL NEVER BE INDEXED", NOT
 * "NOT THIS TIME". The other three are transient by nature — re-connect the
 * installation, re-create the workspace, add a project, and the next run indexes.
 * This one is a property of the HOST (it cannot hand a token-less container a
 * self-authorizing archive URL — see `providerSupportsRepoTarballUrl`), so no
 * retry, re-push or re-connect will ever change it. It is recorded as a clean
 * terminal verdict rather than thrown for exactly that reason: a throw would buy
 * five identical retries and a dead-letter row per push, which is the defect this
 * value exists to remove — but a verdict is only honest if it is not silent, so
 * the refusal ALSO logs, and the connect surface tells the user up front.
 */
export type IndexSkipReason =
  | 'installation_missing'
  | 'workspace_missing'
  | 'no_projects'
  | 'provider_cannot_index'
  // A repository Motir created that still holds only its seed (MOTIR-4589):
  // "not indexed YET", which a later push past the seed changes — never a failure.
  | typeof NO_COMMIT_BEYOND_TEMPLATE;

// ⚠️ `no_projects` SURVIVED MOTIR-4652, AND ITS MEANING NARROWED. THE CARD ASKED
// FOR IT TO BE RETIRED; IT CANNOT BE, AND THE REASON IS IN THE OTHER REPOSITORY.
//
// It used to mean "this repo has nowhere to be indexed INTO" — with N graphs to
// build and no project to build them for, there was nothing to do. Under the
// organisation model that is no longer true: the organisation owns the graph and
// it is worth building whether or not a project reads it yet.
//
// What still requires a project is the RUN CREDENTIAL. motir-ai's
// `IssueRunCredentialInput` (control plane, `coreProjectId: string`) is required,
// and `issueRunCredential` resolves the `AiProject` spine through
// `findOrCreateByCoreIds` before minting — MOTIR-4656 changed what the credential
// is SCOPED to (the organisation) and deliberately did not change what it is
// RESOLVED FROM. So an organisation with zero projects has nothing to anchor a
// credential with, and this verdict is still the honest answer for it.
//
// It is therefore no longer "one per project of the workspace, and zero projects
// means zero work". It is "the organisation has no project to resolve a run
// credential through". Narrower, still reachable, still terminal.

/**
 * THE CORE-SIDE PHASES OF ONE CONTAINER'S DISPATCH (MOTIR-4413) — the part of a
 * refresh's wall clock that happens OUTSIDE the container, and which nothing has
 * ever recorded.
 *
 * `motir-ai` has instrumented the container's own eight phases since MOTIR-3250
 * (`src/indexer/runIndex.ts`'s `PhaseTimer` over `INDEX_RUN_PHASES`, reported by
 * `logPhaseTimings` as one `[index-timings]` line). Everything before that timer
 * starts, and everything between containers, was invisible: the ledger's output
 * was three fields and none of them was a duration, so "why did this refresh take
 * thirty-five minutes" could only be answered by reading a machine's logs by hand.
 *
 * Three spans are knowable HERE and nowhere else — one per `(repo × project)`,
 * never one aggregate, because a long admission queue and a slow boot and a
 * lagging poll are three different faults with three different remedies and they
 * produce the same single number when summed.
 */
export type IndexCorePhase =
  /** Queued for an admission slot: the request → the grant (MOTIR-1990's cap). */
  | 'admissionWait'
  /** Mint + tarball-URL resolve + provision: the grant → the container booted. */
  | 'boot'
  /**
   * The width of the FINAL poll window — the longest a finished container could
   * have gone unobserved before this run noticed.
   *
   * ⚠️ A BOUND, AND DELIBERATELY NAMED AS ONE. The provider does not tell us when
   * the container stopped, only that it has; what is derivable is the interval
   * that preceded the poll which saw it. Reporting it as an exact lag would be a
   * measurement we cannot take, and a plausible number is worse than an honest
   * bound (`lib/jobs/supervision/driver.ts` owns the cadence this reads).
   */
  | 'pollToDetect';

/**
 * One container's core-side spans, in milliseconds.
 *
 * ⚠️ THE SHAPE MIRRORS `motir-ai`'s ON PURPOSE — a `phasesMs` map plus a total,
 * exactly what `logPhaseTimings` emits — so the two halves of one refresh read the
 * same way rather than in two invented vocabularies.
 *
 * ⚠️ EVERY MEMBER IS OPTIONAL, AND AN ABSENT ONE MEANS "COULD NOT BE COMPUTED",
 * never "zero". Telemetry may not fail a run: the ledger row is a permanent claim
 * that the repo is indexed (`docs/decisions/code-graph-index-fleet.md` §6), so a
 * span whose source is missing — an in-flight run whose memo predates this card,
 * a clock that went backwards — is OMITTED rather than guessed or thrown on.
 */
export interface IndexCoreTimings {
  /** WHICH container's spans these are — the second half of `(repo × project)`. */
  readonly projectId: string;
  readonly phasesMs: Partial<Record<IndexCorePhase, number>>;
  /** The sum of the spans PRESENT. Absent when none could be computed. */
  readonly totalMs?: number;
}

/**
 * WHAT A CONTAINER ACTUALLY DID: synced against a previous snapshot, or rebuilt
 * the whole tree (MOTIR-4945).
 *
 * The two differ by tens of minutes, and until this existed the ledger recorded
 * neither — so a run that had silently stopped being incremental was
 * indistinguishable from one that had not, and the only symptom was "indexing got
 * slow again" on a surface nobody watches.
 *
 * ⚠️ IT IS DERIVED AT DISPATCH, FROM A FACT motir-core ALREADY HOLDS, and that is
 * the whole reason this is cheap: `credential.previousSnapshotUrl` is present
 * exactly when motir-ai granted this run a sync, so its presence IS the mode. No
 * second call, no widened credential, nothing new crossing the 7.1 boundary.
 *
 * ⚠️ AND IT IS NOT A DIAGNOSIS. `rebuild` says the grant was absent; it does NOT
 * say why — no snapshot at all, versus an engine version that moved away from the
 * stored one. motir-ai knows the difference and this side deliberately does not
 * ask, because carrying that reason changes what crosses the boundary and is its
 * own decision.
 */
export type IndexMode = 'sync' | 'rebuild';

/**
 * WHICH container ran in WHICH mode — one row per `(repo × project)`, exactly as
 * {@link IndexCoreTimings} is, and for the same reason: the fan-out is
 * workspace-scoped, each project gets its own credential, and so each gets its own
 * grant. An aggregate would hide a repository that syncs for one project and
 * rebuilds for another.
 */
export interface IndexModeRecord {
  /** WHICH container's mode this is — the second half of `(repo × project)`. */
  readonly projectId: string;
  /**
   * ⚠️ THE OFFER-DERIVED MODE, AND ITS MEANING IS UNCHANGED BY MOTIR-5058. It
   * still answers, and only answers, *was a snapshot OFFERED to this run*. The
   * two fields below sit BESIDE it; nothing overwrites or reinterprets this one.
   */
  readonly mode: IndexMode;
  /**
   * WHAT THE CONTAINER ITSELF DID (MOTIR-5058) — read back from motir-ai after
   * the run settled, and absent when it could not be.
   *
   * ⚠️ THE VOCABULARY IS DIFFERENT ON PURPOSE: `build`, not `rebuild`. The two
   * fields answer two different questions and a reader who assumes they are the
   * same field twice will draw the exact wrong conclusion, so they are not even
   * spelled alike. See {@link IndexMode}'s own note — *"motir-ai knows the
   * difference and this side deliberately does not ask"* was true until this
   * card, which is when asking became its own decision and was taken.
   *
   * ⚠️ ABSENT IS NOT `build`. It means motir-ai had nothing to report or could
   * not be asked — an older deployment, a run that reported no verdict, a lost
   * write, a failed call. Defaulting it reproduces the false confidence the pair
   * exists to remove.
   */
  readonly containerMode?: 'sync' | 'build';
  /**
   * WHY a run that WAS handed a snapshot rebuilt anyway — the container's own
   * reason (the sync threw, or its engine called the snapshot stale). Present
   * only alongside a `containerMode` of `build`, and only when a snapshot was
   * offered: a cold build was never offered one and has nothing to explain.
   */
  readonly containerFallbackReason?: string;
  /**
   * WHAT THE RUN COST, as the CONTAINER measured itself (MOTIR-5101). Absent
   * when motir-ai had no timings to report — an older deployment, a run that
   * predates the store, a failed read.
   *
   * ⚠️ THIS IS NOT {@link IndexCoreTimings}, AND THE TWO MUST NEVER BE MERGED —
   * the naming collision MOTIR-5055 records is the failure being avoided here,
   * one field over, and the instinct to "unify the timings" is exactly how it
   * recurs. They are produced by different processes and measure different
   * spans:
   *
   *   • **`coreTimings`** (`IndexCoreTimings`, MOTIR-4413) — THIS side's own
   *     detection overhead, derived on the dispatch host from the boot memo:
   *     how long motir-core spent provisioning, polling and tearing down. It
   *     rides its OWN array on the ledger row and is untouched by this card.
   *   • **`containerTimings`** (here) — the span INSIDE the container, measured
   *     by the container, excluding every one of those costs.
   *
   * **The whole reason the second exists is that the first cannot answer the
   * question.** Provisioning overhead measured 31 513 ms and 58 738 ms on two
   * runs eighteen minutes apart — a swing 62% the size of the saving being
   * measured — so a reader who adds these two numbers together, or who reaches
   * for whichever is at hand, gets a figure that says incremental indexing does
   * nothing. Keep them separately readable and separately labelled.
   */
  readonly containerTimings?: {
    readonly totalMs?: number;
    readonly unaccountedMs?: number;
    readonly peakRssMb?: number;
    readonly phasesMs?: Record<string, number>;
    readonly syncCounts?: Record<string, number>;
  };
}

/**
 * A small JSON-serializable summary persisted on the job_run ledger row.
 *
 * ⚠️ `indexed` / `repoRef` / `projectsIndexed` ARE UNCHANGED AND MUST STAY SO
 * (§6). `jobRunRepository.listSucceededCodeGraphIndexRepoRefs` builds the indexed
 * set from them, and `MigrateIndexRepoDto` / `MigrateIndexStatusDto.allIndexed`
 * gate the onboarding wizard on that set. {@link IndexCoreTimings} and
 * {@link IndexModeRecord} ride ALONGSIDE them, optional, and no reader of the
 * three is asked to learn about either.
 *
 * ⚠️ `indexModes` IS ITS OWN ARRAY RATHER THAN A FIELD ON `coreTimings`, and the
 * split is deliberate. A timings row is OMITTED when no span could be computed
 * (`phasesMs` empty), and the mode is knowable in exactly that case — it comes
 * from the boot memo, not from clock arithmetic — so folding it in would discard
 * the mode precisely when the timings are unavailable. Two arrays keyed by
 * `projectId` cost a reader one join and never lose a fact.
 *
 * ⚠️ AND AN `indexModes` ROW NOW CARRIES **TWO** MODES, WHICH IS NOT REDUNDANCY
 * (MOTIR-5058). They answer different questions, they are produced on different
 * sides of the open/closed boundary, and keeping both is the entire point of the
 * card that added the second — so this block says what each one MEANS, because
 * the next reader's instinct will be to simplify one of them away:
 *
 *   • **`mode`** (`sync` / `rebuild`) — DERIVED HERE, from whether motir-ai
 *     granted this run a previous snapshot. It answers ***was a snapshot
 *     OFFERED***. It is free: `credential.previousSnapshotUrl`'s presence IS the
 *     mode, so nothing extra crosses the boundary to obtain it.
 *   • **`containerMode`** (`sync` / `build`) + **`containerFallbackReason`** —
 *     REPORTED BY THE CONTAINER and read back from motir-ai. They answer ***what
 *     the run actually DID with that offer***, and why it rebuilt when it did.
 *
 * **They disagree on exactly one arm, and that arm is why this exists.** A run
 * offered a snapshot whose incremental sync then threw — or whose engine refused
 * an index older than its own extraction — rebuilds from scratch and is recorded
 * here as `mode: 'sync'`, because a snapshot *was* offered. `containerMode:
 * 'build'` with a reason is the only thing on this ledger that contradicts it.
 * Collapsing the pair restores a ledger that says `sync` about a run that
 * rebuilt, which is the defect MOTIR-5055 records and MOTIR-5027's detector
 * reads straight through.
 *
 * ⚠️ **AND THE CONTAINER HALF IS OPTIONAL BY CONSTRUCTION, NEVER DEFAULTED.**
 * It is read after the run settles, over a route an older motir-ai does not
 * serve, by a client that returns `null` for every failure (`motirAiClient`'s
 * `fetchCodeGraphRunVerdict`). Absent therefore means *nobody told us*, which is
 * not the same as `build` and must never be read as it — a defaulted value here
 * would be indistinguishable from a measured one, which is the precise confusion
 * the second field was added to end.
 */
export type IndexRepoResult =
  | {
      indexed: false;
      /** A target verdict, or a HARD-STOP pause of the organisation's internal
       *  index allowance (MOTIR-4593): nothing was admitted or booted, and the
       *  repository row records the same reason. */
      reason: IndexSkipReason | IndexPauseReason;
    }
  | {
      indexed: true;
      repoRef: string;
      /**
       * ⚠️ ALWAYS `1` SINCE MOTIR-4652, AND KEPT RATHER THAN RETIRED.
       *
       * It counted the fan-out's containers. There is one container per
       * `(organisation, repoRef)` now, so the number is a constant — but the field
       * stays, for two reasons a reader should not have to reconstruct:
       *
       *  1. HISTORICAL LEDGER ROWS CARRY OTHER VALUES. `job_run.output` is stored
       *     JSON; rows written before this card say `projectsIndexed: 2`. Removing
       *     the field from the TYPE would not remove it from those rows, and a
       *     reader meeting `2` needs somewhere to find out what it meant.
       *  2. NOTHING IN PRODUCTION READS IT. The comment above says the three
       *     fields are what `listSucceededCodeGraphIndexRepoRefs` and the
       *     onboarding wizard consume — but that read builds its set from
       *     `output.repoRef` ALONE and never touches this field. So retiring it
       *     would have been safe and pointless; keeping it at 1 costs nothing and
       *     keeps the row shape stable.
       */
      projectsIndexed: number;
      /** MOTIR-4413. Absent when no container produced a computable span. */
      coreTimings?: IndexCoreTimings[];
      /** MOTIR-4945. Absent when no container reported a mode — which, mid-rollout,
       *  is every run whose `index-boot` memo predates this card. */
      indexModes?: IndexModeRecord[];
    };

/**
 * What the job needs to know before it can index anything: the skip reason, or
 * the resolved tenant tuple + the full project fan-out. JSON-SERIALIZABLE by
 * construction — it is a `step.run` result, so it crosses a checkpoint boundary
 * and is replayed from Inngest's memo on every later invocation (MOTIR-1974).
 */
export type IndexTarget =
  | { indexed: false; reason: IndexSkipReason }
  | {
      indexed: true;
      repoRef: string;
      providerId: GitProviderId;
      /** THE TENANT (MOTIR-4652). One dispatch lands for this organisation. */
      organizationId: string;
      /**
       * ⚠️ VESTIGIAL, AND NOT A FAN-OUT (MOTIR-4652). One project of the
       * organisation, used ONLY to resolve motir-ai's `AiProject` spine when
       * minting the run credential — see the `no_projects` note on
       * {@link IndexSkipReason}. Nothing iterates it, nothing indexes "into" it,
       * and the graph it produces belongs to the organisation.
       *
       * It goes when motir-ai's control plane accepts a `coreOrganizationId`
       * alone.
       */
      anchorProjectId: string;
    };

/**
 * THE ANCHOR'S CONTRACT, STATED AS A PREDICATE RATHER THAN AS AN EQUALITY
 * (MOTIR-5020) — and it is motir-ai's predicate, not one of our own choosing.
 *
 * The receiving end is `requireString` in motir-ai's `src/app.ts`:
 * `typeof v !== 'string' || v === ''` ⇒ `'coreProjectId' must be a non-empty
 * string`. Anything this returns false for is refused THERE, one repository
 * away from the code that produced it, with a message naming a field the reader
 * of a `job_run.failure` row has never heard of. So the same test is applied
 * HERE, where the value is still called what it is.
 *
 * ⚠️ THE GUARD IT REPLACES WAS `=== null`, AND WHAT MADE THAT WRONG IS NOT THAT
 * `null` IS THE ONLY BAD VALUE — it is that a guard which enumerates the bad
 * values it has thought of reports SAFE for the ones it has not. `?? null`
 * makes `null` the only bad value the resolver can PRODUCE, which is exactly
 * what made the pairing look airtight and what made it useless against a value
 * that arrived from anywhere else (see {@link requireCurrentIndexTarget}).
 */
export function isUsableAnchorProjectId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * A replayed `resolve-target` memo that does not satisfy the CURRENT
 * {@link IndexTarget} contract (MOTIR-5020).
 *
 * Thrown at the step boundary, before an admission is taken and before a
 * container is billed, so a shape skew costs nothing but a named failure.
 */
export class StaleIndexTargetMemoError extends Error {
  constructor(readonly detail: string) {
    super(
      `The replayed \`resolve-target\` memo does not satisfy the current IndexTarget contract: ${detail}. ` +
        'A memo is returned WITHOUT re-executing its step, so a run that started before a shape change ' +
        'replays the OLD shape into the new code. Bump the step id when an `IndexTarget` field changes.',
    );
    this.name = 'StaleIndexTargetMemoError';
  }
}

/**
 * NARROW A `resolve-target` RESULT THAT MAY HAVE BEEN WRITTEN BY ANOTHER
 * VERSION OF THIS CODE (MOTIR-5020) — the check the bare `as IndexTarget` cast
 * at the call site was not.
 *
 * ⚠️ THE CAST AT THAT CALL SITE IS DOCUMENTED AS LAUNDERING `Jsonify<T>`, AND
 * THAT IS TRUE AND INSUFFICIENT. `step.run` returns a STORED row when one
 * exists for `(run_id, id)` and does not execute the function at all
 * (`lib/jobs/engine/step.ts`), so the value crossing this seam was produced by
 * whichever revision was deployed when the run STARTED — which on a resume
 * across a deploy is not this one. The cast then asserts the current type over
 * last week's JSON, and every field the new shape added reads `undefined`.
 *
 * That is not hypothetical: MOTIR-4652 replaced `projectIds: string[]` with
 * `anchorProjectId: string` and kept the step id `resolve-target`. A resumed
 * run replayed `{ indexed: true, …, projectIds: [...] }`, `!target.indexed` did
 * not fire because `indexed` was `true`, `target.anchorProjectId` was
 * `undefined`, `JSON.stringify` DROPPED it from the mint body, and motir-ai
 * answered `'coreProjectId' must be a non-empty string` — for an ABSENT field,
 * which its `requireString` reports identically to an empty one.
 *
 * ⚠️ AND NOTE WHERE THE OLD GUARD WAS: INSIDE the memoized step. A replay does
 * not run it, so no widening of it could ever have seen this value. The guard
 * that has to exist is the one at the BOUNDARY the value actually crosses.
 */
export function requireCurrentIndexTarget(value: unknown): IndexTarget {
  const t = value as IndexTarget;
  if (t.indexed && !isUsableAnchorProjectId(t.anchorProjectId)) {
    throw new StaleIndexTargetMemoError(
      `\`anchorProjectId\` is ${JSON.stringify(t.anchorProjectId)}, not a non-empty string`,
    );
  }
  return t;
}

/** One repo the first-index sweep found without a code graph. */
export interface MissingFirstIndexRepo {
  workspaceId: string;
  /** GitHub's numeric installation id — the enqueue payload's token-minting key. */
  installationId: string;
  repoRef: string;
  defaultBranch: string;
}

/** What {@link codeGraphIndexService.sweepReposMissingFirstIndex} did. */
export interface FirstIndexSweepReport {
  dryRun: boolean;
  /** Connected repos examined. */
  scanned: number;
  /** Of those, the ones that already have a succeeded index — left alone. */
  alreadyIndexed: number;
  /** The repos with no code graph, in report order. */
  missing: MissingFirstIndexRepo[];
  /** How many index jobs were actually enqueued (0 on a dry run). */
  enqueued: number;
}

/**
 * Does this repository still hold only the seed Motir created it with
 * (MOTIR-4589)? Reads its mirror row and every `project_repository` row that
 * realizes it, in the resolve step's transaction (the workspace is bound). A
 * repository with no mirror row answers false: what is unknown is never held.
 */
async function repoHoldsOnlyItsSeed(
  input: IndexRepoInput,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const repo = await githubRepoRepository.findConnectedByWorkspaceAndName(
    input.workspaceId,
    input.repoOwner,
    input.repoName,
    tx,
  );
  if (!repo) return false;
  const rows = await projectRepoRepository.listByGithubRepoId(repo.id, tx);
  return isOnlyItsSeed(rows, repo.defaultBranchHeadSha);
}

export const codeGraphIndexService = {
  /**
   * PHASE 1 (one checkpointed step) — resolve the tenant tuple and the project
   * fan-out for a repo. DB reads only: no network, so it is cheap to replay and
   * cheap to retry. No-ops cleanly (never throws) when the
   * installation/workspace vanished before the job ran or the workspace has no
   * projects — the no-op verdicts ARE the contract (the job never throws on a
   * vanished tenant), and they are returned rather than thrown so the ledger
   * records WHY nothing was indexed.
   *
   * Keyed by WORKSPACE: the input carries no project, and the fan-out this
   * returns is every project of the workspace (see the TENANCY note above).
   */
  async resolveIndexTarget(input: IndexRepoInput): Promise<IndexTarget> {
    const resolved = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        input.installationId,
        tx,
      );
      // The installation is still read — it supplies the provider discriminator
      // the tarball fetch dispatches on — but NOT the tenant (MOTIR-1931).
      if (!installation) return { kind: 'installation_missing' as const };

      // ⚠️ BIND THE TENANT (MOTIR-2880). `github_installation` reads on the system
      // flag; `workspace` does NOT — all four of its SELECT policies key on
      // `app.workspace_id`, `app.user_id` or `app.bootstrap_slug`. So under
      // `motir_app` the read below returned null and EVERY first index reported
      // `workspace_missing` for a workspace that was right there. The workspace is
      // an input, so there is nothing to discover — it is bound here rather than at
      // the wrapper only because the installation read above still wants the flag.
      await bindWorkspaceContext(tx, input.workspaceId);

      const workspace = await workspaceRepository.findByIdInTx(input.workspaceId, tx);
      if (!workspace) return { kind: 'workspace_missing' as const };

      // ⚠️ READ ONCE, FOR AN ANCHOR — NOT FOR A FAN-OUT (MOTIR-4652). The
      // dispatch is per ORGANISATION now, so the project list is no longer the
      // thing being iterated. One project is still needed because motir-ai
      // resolves a run credential through an `AiProject` spine (see the
      // `no_projects` note above); `[0]` after the repository's own deterministic
      // order, so the same repo anchors on the same project across runs and a
      // memo key stays stable.
      const projects = await projectRepository.findByWorkspace(input.workspaceId, tx);
      return {
        kind: 'resolved' as const,
        onlyItsSeed: await repoHoldsOnlyItsSeed(input, tx),
        providerId: installation.provider as GitProviderId,
        workspaceId: input.workspaceId,
        organizationId: workspace.organizationId,
        anchorProjectId: projects[0]?.id ?? null,
      };
    });

    if (resolved.kind === 'installation_missing')
      return { indexed: false, reason: 'installation_missing' };
    if (resolved.kind === 'workspace_missing')
      return { indexed: false, reason: 'workspace_missing' };
    // See the `no_projects` note on {@link IndexSkipReason}: the organisation owns
    // the graph, but motir-ai still resolves a run credential through an
    // `AiProject`, so an organisation with no project has nothing to anchor one.
    //
    // ⚠️ THE TEST IS THE CONSUMER'S PREDICATE, NOT `=== null` (MOTIR-5020). See
    // {@link isUsableAnchorProjectId}: `''` and `undefined` are refused by
    // motir-ai in exactly the same words as a missing field, so they are refused
    // here, where the value still has a name and a skip reason.
    if (!isUsableAnchorProjectId(resolved.anchorProjectId))
      return { indexed: false, reason: 'no_projects' };

    // ⚠️ THE CAPABILITY GATE, AND IT BELONGS HERE — NOT AT THE ENQUEUE (MOTIR-2124).
    //
    // The fleet hands a container a PRE-SIGNED URL and no host credential, so a
    // provider that cannot resolve one cannot be indexed at all. Until this gate
    // existed, that fact was discovered at `bootIndexContainer`, which THROWS
    // (`requireRepoTarballUrlResolver`) — correct in isolation, catastrophic as a
    // steady state: an unindexable host burned all five Inngest attempts and
    // dead-lettered on every first index and every push, and the only record was a
    // `job_run_dlq` row nobody reads. 35 of them accumulated over 48 h once
    // (MOTIR-2105) before anyone noticed.
    //
    // Refusing HERE — one checkpointed, DB-only step, before the fleet-config gate
    // and before a single container is billed — turns that into ONE clean terminal
    // verdict per trigger, carrying the reason, on the ledger row the run already
    // writes.
    //
    // WHY NOT "at the enqueue", which is where the bug report asked for it: the
    // enqueue helpers are provider-blind by construction (`CodeGraphIndexData`
    // carries `installationId`, not a provider), so gating there means a GitLab
    // check in `gitlabConnectionService` and another in `gitlabWebhookService` —
    // two per-provider copies of a rule, in the two files a third provider would
    // have to remember to edit. That is the same class of miss that produced this
    // bug: MOTIR-1981 swept the JOBS and not the PROVIDER INTERFACE they depend on
    // (`notes.html` #215). This is the ONE place every path to a container passes
    // through, and it reads the capability itself rather than a provider name, so
    // a future provider is covered the day it registers — without editing this
    // line.
    //
    // It sits AFTER the three tenant verdicts deliberately: "the workspace is
    // gone" is a truer description of that run than "the host cannot index", and
    // the vanished-tenant contract predates this.
    //
    // `getGitProvider` THROWS on an id no provider registered, so it is resolved
    // inside the same guard rather than beside it: this step's shipped contract is
    // that it never throws (the vanished-tenant verdicts have to reach the ledger),
    // and an unregistered provider is in any case the strongest possible instance
    // of "this cannot be indexed" — it collapses into the same verdict rather than
    // into a crash.
    let canIndex: boolean;
    try {
      canIndex = providerSupportsRepoTarballUrl(getGitProvider(resolved.providerId));
    } catch {
      canIndex = false;
    }
    if (!canIndex) {
      // The verdict alone would be honest but quiet — a ledger value is legible to
      // whoever already went looking. Log it too, so the fact reaches an operator
      // reading logs, and the user-facing half is the connect surface's own copy
      // (`gitlab.projects.foot`). Arguments, never interpolated: `repoOwner` is
      // webhook-derived on the push path (`js/tainted-format-string`, CodeQL high).
      console.warn(
        '[codeGraphIndexService] skipping the code-graph index: this Git provider cannot ' +
          'resolve a pre-signed tarball URL, so a fleet container could never fetch the repo. ' +
          'No retry will change this. provider / repo:',
        resolved.providerId,
        repoRefOf({ owner: input.repoOwner, name: input.repoName }),
      );
      return { indexed: false, reason: 'provider_cannot_index' };
    }

    // ⚠️ A CREATED REPOSITORY WAITS FOR A COMMIT OF ITS OWN (MOTIR-4589), and the
    // check is HERE, at run time, for the same reason the capability gate is: every
    // trigger passes through it. Establish no longer enqueues a created repository,
    // but the push of Motir's own CI stub, a reconcile and the operator sweep still
    // can, and the debounced refresh resolves after the row has its seed head.
    // AFTER the tenant and capability verdicts: those are truer descriptions of a
    // run that could never index. The verdict reaches the ledger like theirs.
    if (resolved.onlyItsSeed) {
      console.warn(
        '[codeGraphIndexService] not indexed yet: no commit beyond the template. repo:',
        repoRefOf({ owner: input.repoOwner, name: input.repoName }),
      );
      return { indexed: false, reason: NO_COMMIT_BEYOND_TEMPLATE };
    }

    return {
      indexed: true,
      // The SAME key the enqueue gate matches on (`repoRefOf`) — this is what
      // lands in the ledger as `output.repoRef`, so producer and gate share one
      // formatter.
      repoRef: repoRefOf({ owner: input.repoOwner, name: input.repoName }),
      providerId: resolved.providerId,
      organizationId: resolved.organizationId,
      anchorProjectId: resolved.anchorProjectId,
    };
  },

  // ⚠️ PHASE 2 IS NOT HERE ANY MORE, AND MUST NOT COME BACK (MOTIR-2057). This
  // service used to own `indexRepoIntoProject` — fetch the repo's tarball into
  // this process, POST the bytes to motir-ai under a 180 s client deadline — and
  // MOTIR-2027 left it in place for
  // `system.code-graph-refresh` after moving first-index to the container fleet.
  // Production then ran the abandoned path for weeks at a ~68% failure rate:
  // `motir-core`'s whole-tree parse does not fit in 180 s, and its retries
  // starved every other repo's refresh. Both jobs now build on the fleet
  // (`lib/jobs/indexFleetSteps.ts` → `codeGraphIndexDispatchService`), so this
  // file is READS ONLY — the tenant/fan-out resolve above, and the two enqueue
  // paths below. Anything that wants a graph built dispatches a container.

  /**
   * The repo-add paths' index trigger (MOTIR-1500, re-gated by MOTIR-1961) —
   * enqueue a first index for every repo of `repos` that has no code graph yet.
   * Called POST-COMMIT by BOTH producers (`bindInstallationForWorkspace` and the
   * webhook's `reconcileInstallation`), which is why the ledger read lives here
   * rather than being repeated in each: one gate, one place to keep correct.
   *
   * Reads the already-indexed set under system context — the grant/webhook paths
   * have no active workspace, and the `job_run` policy's system-admin branch is
   * what lets them read the ledger at all. Best-effort throughout: a ledger read
   * failure must not fail the grant that already committed, so it degrades to
   * "nothing is indexed" (enqueue everything — convergent, since the job is
   * idempotent) rather than propagating.
   */
  async enqueueFirstIndexForRepos(input: {
    installationId: string;
    workspaceId: string;
    repos: NormalizedRepo[];
  }): Promise<void> {
    if (input.repos.length === 0) return;
    let indexedRepoRefs: string[] = [];
    try {
      indexedRepoRefs = await withSystemContext((tx) =>
        jobRunRepository.listSucceededCodeGraphIndexRepoRefs(input.workspaceId, tx),
      );
    } catch (err) {
      // The workspace id is passed as an ARGUMENT, never interpolated into the
      // first argument: on the webhook path it is request-derived, and building
      // a format string out of it is `js/tainted-format-string` (CodeQL, high).
      console.error(
        'enqueueFirstIndexForRepos could not read the index ledger for workspace; ' +
          'treating every repo as un-indexed (the job is idempotent):',
        input.workspaceId,
        err,
      );
    }
    await enqueueReposMissingFirstIndex({
      installationId: input.installationId,
      workspaceId: input.workspaceId,
      repos: input.repos,
      indexedRepoRefs,
    });
  },

  /**
   * The OPERATOR recovery path (MOTIR-1961) — find every connected repo with no
   * code graph and enqueue its first index. Driven by
   * `pnpm db:backfill:code-graph-index`.
   *
   * The re-gated enqueue above repairs a workspace the next time its repo
   * selection changes; this repairs one that will not see that event soon (or at
   * all), which is exactly the state the defect leaves behind — repos persisted
   * before the feature shipped, never "newly added" again. Both roads lead to the
   * same chokepoint, so there is one enqueue payload, not two.
   *
   * Idempotent and safe to re-run: a repo whose index has since succeeded drops
   * out of the missing set, so a second consecutive run enqueues nothing. Scoped
   * to one workspace with `workspaceId`; unscoped it sweeps every tenant, which is
   * the honest default — the defect is not one workspace's.
   *
   * Runs under system context (it spans tenants and reads the untenanted job
   * ledger). Side effects are OUTSIDE the transaction: the reads close first,
   * then the enqueues fire.
   */
  async sweepReposMissingFirstIndex(
    input: { workspaceId?: string; dryRun?: boolean } = {},
  ): Promise<FirstIndexSweepReport> {
    const dryRun = input.dryRun ?? false;

    const { scanned, missing } = await withSystemContext(async (tx) => {
      const repos = await githubRepoRepository.listWithInstallation(tx, {
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      });
      // One ledger read per workspace, not per repo — the sweep is cross-tenant
      // and a workspace typically owns several repos.
      const indexedByWorkspace = new Map<string, Set<string>>();
      for (const workspaceId of new Set(repos.map((r) => r.workspaceId))) {
        const refs = await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(workspaceId, tx);
        indexedByWorkspace.set(workspaceId, new Set(refs));
      }
      const found: MissingFirstIndexRepo[] = [];
      for (const repo of repos) {
        const repoRef = repoRefOf(repo);
        if (indexedByWorkspace.get(repo.workspaceId)?.has(repoRef)) continue;
        found.push({
          workspaceId: repo.workspaceId,
          installationId: repo.installation.installationId,
          repoRef,
          defaultBranch: repo.defaultBranch,
        });
      }
      return { scanned: repos.length, missing: found };
    });

    let enqueued = 0;
    if (!dryRun) {
      for (const repo of missing) {
        const [repoOwner, repoName] = splitRepoRef(repo.repoRef);
        await enqueueCodeGraphIndex({
          installationId: repo.installationId,
          workspaceId: repo.workspaceId,
          repoOwner,
          repoName,
          defaultBranch: repo.defaultBranch,
        });
        enqueued += 1;
      }
    }

    return {
      dryRun,
      scanned,
      alreadyIndexed: scanned - missing.length,
      missing,
      enqueued,
    };
  },
};

/** Split an `owner/name` ref back into the enqueue payload's two fields. A repo
 *  name cannot contain `/`, so the FIRST separator is the only one. */
function splitRepoRef(repoRef: string): [owner: string, name: string] {
  const at = repoRef.indexOf('/');
  return [repoRef.slice(0, at), repoRef.slice(at + 1)];
}
