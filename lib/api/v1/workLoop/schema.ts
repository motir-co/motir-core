import { z } from 'zod/v4';
import {
  actorRefSchema,
  approvalGateKindSchema,
  approvalGateStateSchema,
  commentThreadSchema,
  workItemKeySchema,
} from '@/lib/api/v1/workItems/schema';
import type { V1Collection } from '@/lib/api/v1/pagination';
import type { WorkItemClaimDto } from '@/lib/dto/claim';
import type { WorkItemRepairClaimDto } from '@/lib/dto/workItemRepair';
import type { WorkItemContinueClaimDto } from '@/lib/dto/workItemContinue';
import type { ScopeClaimDto } from '@/lib/dto/scopeClaim';
import {
  isBodyAboveFieldMoveAdvisory,
  isMislabelledLinkAdvisory,
  isPostMergeChildAdvisory,
  isBlockerCountAdvisory,
  isSelfBlockingDesignAdvisory,
  isRunnerStopAdvisory,
  isSizingAdvisory,
  isUnderAuthoredAdvisory,
} from '@/lib/dto/workItems';
import type {
  WorkItemProseMislabelledLinkAdvisoryDto,
  WorkItemProsePostMergeChildAdvisoryDto,
} from '@/lib/dto/workItems';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';
import type { DispatchRunCloseOutPromptDto } from '@/lib/dto/dispatchRuns';
import type { CurrentTestInstructionsDTO } from '@/lib/dto/testInstructions';
import type { PlanItemProposedFields, PlanOutcomeDto, PlanWithItemsDto } from '@/lib/dto/plans';
import type { PlanJobCostDto } from '@/lib/dto/planJobCost';

// The v1 WORK-LOOP resources, declared once (Story 11.7 · Subtask 11.7.3 —
// MOTIR-2237). The paths, verbs, scopes and response shapes are pinned by ADR
// Amendment 6; this module is that amendment in `zod`.
//
// ── Why the shapes land AHEAD of most of their endpoints ────────────────────
// Ten endpoints returning eight resources cannot each shape their own response
// and stay coherent — that is exactly the drift Story 11.6 exists to prevent,
// and it would be perverse to introduce it in the story that supplies 11.6's
// schemas. So the shapes are declared here, once, and 11.7.4–11.7.7 arrive as
// ADAPTERS: each brings its route, its MAPPER, and its operation declaration.
//
// ⚠️ **The OPERATION DECLARATIONS travel with their ROUTES, not with these
// schemas** — the one place this card's plan met a shipped guard and lost.
// `tests/api/v1/openapi-operations-coverage.test.ts` asserts BOTH directions:
// "declares an operation for EVERY exported verb" AND "declares no operation for
// a route that does not exist". Registering all ten declarations here, with one
// route shipped, would make the second one red on every PR until 11.7.7 landed.
// So `operations.ts` declares what exists, and each endpoint card appends its
// own — which is also what keeps the emitted document describing an API a client
// can actually call.
//
// ── A v1 response is a SCHEMA's output, never a service DTO ─────────────────
// ADR Amendment 2, totalized by Amendment 5: the mapper is the seam where an
// internal DTO stops being public API, and it shapes FIELD BY FIELD — never a
// spread. A schema in this module without a mapper below it is a shape whose
// endpoint has not shipped yet; the card that ships the route brings the mapper
// and VERIFIES the shape against a real response (11.4.6's drift guard is what
// makes that verification automatic rather than a promise).

// ─────────────────────────────────────────────────────────────────────────────
// The dispatch prompt
// ─────────────────────────────────────────────────────────────────────────────

/** WHICH git workflow the prompt instructs — chosen server-side, never by the caller. */
export const dispatchWorkflowModeSchema = z.enum(['per_item_pr', 'session_lineage']);

/**
 * The advisory SEVERITY, deliberately an OPEN string rather than an enum.
 *
 * ADR §8 permits "a new enum value on a field documented as open-ended", and
 * this field is documented as exactly that. Two families ship today
 * (`advisory` / `likely-missing-edge` on a reference; `likely-ordering-violation`
 * / `likely-repo-straddle` / `likely-over-gate-sizing` / `likely-self-blocking-design`
 * / `body-edit-above-field-move` on a shape) and the advisory channel is designed to grow — MOTIR-2175,
 * MOTIR-2177, MOTIR-3110 and MOTIR-3178 each added a severity to a shipped
 * surface.
 *
 * A closed enum here would make the NEXT severity a breaking change for every
 * generated client, and — worse — would make this endpoint 500 on its own
 * response the day the server started emitting one, because 11.4.6's drift guard
 * validates real responses against these schemas. A consumer meeting a severity
 * it does not know IGNORES that advisory; it never fails on it. Advisories are
 * never a gate, so ignoring one is always safe.
 */
export const advisorySeveritySchema = z.string();

/**
 * A PROSE-vs-GRAPH reference advisory — the card's body names a not-done work
 * item it carries no `blocked_by` edge to (MOTIR-1969).
 *
 * `kind` is OPTIONAL here because it is optional on the DTO and never emitted:
 * this variant is the wire shape three shipped consumers already read, so
 * tagging it would change bytes for every one of them to buy nothing. v1 mirrors
 * the DTO rather than normalising it, which is what lets the endpoint's payload
 * be asserted field-by-field against the MCP tool's.
 */
const referenceAdvisorySchema = z.object({
  kind: z.literal('reference').optional(),
  item: workItemKeySchema,
  referenced: z.string(),
  referencedStatus: z.string(),
  severity: advisorySeveritySchema,
});

/**
 * A CRITERION-shaped SHAPE advisory — the card's own acceptance criteria are
 * mis-shaped, with no second work item involved anywhere in the finding
 * (MOTIR-2175 / MOTIR-2177), plus the 1-based index the remedy cuts at.
 *
 * The per-severity extras are OPTIONAL for the same reason `severity` is open: a
 * future shape severity carries its own fields, and a schema that required
 * today's would reject tomorrow's advisory rather than pass it through.
 *
 * ⚠️ `criterionIndex` stays REQUIRED here, and MOTIR-3110's sizing severity
 * therefore arrives as a SECOND `kind: 'shape'` variant below rather than by
 * loosening this one. Making it optional would be a nullability change on a
 * shipped field, which §8 forbids outright; adding a union member is the
 * additive form of the same widening (`public-api-conventions.md` §8, the
 * *"a new field on a response object"* / open-ended-enum limbs).
 */
const criterionShapeAdvisorySchema = z.object({
  kind: z.literal('shape'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  criterionIndex: z.number().int(),
  /** `likely-ordering-violation`: the gate-14 phrase that matched. */
  phrase: z.string().optional(),
  /** `likely-repo-straddle`: the repo-qualified path the criterion names. */
  path: z.string().optional(),
  /** `likely-repo-straddle`: the repo that path resolves to. */
  repo: z.string().optional(),
  /** `likely-repo-straddle`: `contradiction` or `unpinnable`. */
  reason: z.string().optional(),
});

/**
 * A SIZING SHAPE advisory — the card's own `storyPoints` / `estimateMinutes` are
 * over the estimation gate's two ceilings (MOTIR-3110).
 *
 * ⚠️ **The two arms do not carry the same authority, and a client rendering this
 * must not present them as if they did (MOTIR-3271).** `story_points` IS the
 * gate's rule — `8+` is its literal split signal. `estimate_minutes` is a
 * PROXY: the column sums agent run time and CI time while the gate's ceiling is
 * on the agent run alone, so the finding means *probably over the hour*, at a
 * threshold (70 total minutes) derived from the top of the calibration band the
 * gate endorses. Nothing on the WIRE changes with that threshold — it is a
 * server-side heuristic, not a declared shape — which is why this correction
 * moves no contract version.
 *
 * ⚠️ `kind: 'shape'` and NO `criterionIndex`, which is why it is a second
 * variant beside {@link criterionShapeAdvisorySchema} rather than a third
 * severity inside it. The two are disjoint on their REQUIRED fields — this one
 * needs `threshold`, that one needs `criterionIndex` — so the plain union below
 * resolves each unambiguously, whichever order it tries them in. A client that
 * reads `criterionIndex` off anything tagged `shape` was already obliged to
 * tolerate unknown members (§8's other half); one that switches on `severity`
 * ignores this severity and loses nothing, because advisories never gate.
 *
 * ⚠️ Additive under §8, on the same terms as the subsumption variant.
 * `V1_CONTRACT_VERSION` moves with it (Amendment 8's obligation) — that number
 * is how a client learns the family grew without re-reading a document.
 */
const sizingShapeAdvisorySchema = z.object({
  kind: z.literal('shape'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  /**
   * Which ceiling(s) the card crossed: points, minutes, or both — `story_points`
   * is the gate's rule, `estimate_minutes` a proxy for it (see above).
   */
  threshold: z.string(),
  /** The card's observed `storyPoints` — `null` when unestimated. */
  storyPoints: z.number().nullable(),
  /**
   * The card's observed `estimateMinutes` — `null` when unestimated. The SUM of
   * agent run time and CI time, which is what makes the minutes arm a proxy.
   */
  estimateMinutes: z.number().nullable(),
});

/**
 * A SELF-BLOCKING-DESIGN SHAPE advisory — one criterion of the card produces a
 * DESIGN ASSET while another builds the RENDERED SURFACE that drawing decides
 * (MOTIR-3178).
 *
 * ⚠️ `kind: 'shape'` and a PAIR of indices under their own names, which is why it
 * is a third variant beside {@link criterionShapeAdvisorySchema} rather than a
 * fourth severity inside it. It carries no `criterionIndex` at all — its remedy
 * LIFTS the design criterion onto its own card rather than cutting the list at a
 * line — and the shape variants are disjoint on their REQUIRED fields
 * (`criterionIndex` / `threshold` / this pair / the counted claim), so the plain union below resolves
 * each unambiguously whichever order it tries them in.
 *
 * ⚠️ Additive under §8, on the same terms as the sizing and subsumption variants:
 * a new member of a union whose `severity` was already open-ended, on a field
 * every client must tolerate unknown members of. `V1_CONTRACT_VERSION` moves with
 * it (Amendment 8's obligation).
 */
const selfBlockingDesignShapeAdvisorySchema = z.object({
  kind: z.literal('shape'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  /** 1-based index of the criterion whose deliverable is the design asset. */
  designCriterionIndex: z.number().int(),
  /** 1-based index of the criterion that builds the surface that drawing decides. */
  surfaceCriterionIndex: z.number().int(),
});

/** One end of a BODY-EDIT-ABOVE-FIELD-MOVE advisory: one revision of the card. */
const revisionEndSchema = z.object({
  /** When the revision was written, ISO-8601. */
  at: z.string(),
  /** The fields it moved that the check reads — body columns, or watched fields. */
  fields: z.array(z.string()),
});

/**
 * A BODY-EDIT-ABOVE-FIELD-MOVE SHAPE advisory — the card's newest body write
 * moved none of the fields a body describes, and the write directly beneath it
 * did (MOTIR-5399). A prompt to RE-READ the body against that move, never a defect
 * claim: a body rewritten to match the move leaves the same trail as one that put
 * the old framing back, and only the prose tells them apart.
 *
 * ⚠️ `kind: 'shape'` with neither `criterionIndex`, `threshold` nor the design
 * pair — its REQUIRED fields are `bodyEdit` + `fieldMove`, so the four shape
 * variants stay disjoint and the plain union resolves each unambiguously.
 *
 * ⚠️ Additive under §8, on the same terms as the sizing and self-blocking
 * variants: a new member of a union whose `severity` was already open-ended.
 * `V1_CONTRACT_VERSION` moves with it (Amendment 8's obligation).
 */
const bodyAboveFieldMoveShapeAdvisorySchema = z.object({
  kind: z.literal('shape'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  /** The newer write — it moved a body and no watched field. */
  bodyEdit: revisionEndSchema,
  /** The write directly beneath it — it moved at least one watched field. */
  fieldMove: revisionEndSchema,
});

const blockerCountShapeAdvisorySchema = z.object({
  kind: z.literal('shape'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  claim: z.string(),
  claimedCount: z.number().int().nonnegative(),
  blockerCount: z.number().int().nonnegative(),
});

/**
 * The UNDER-AUTHORED member (MOTIR-5427): a childless card with no enumerated
 * acceptance criterion and null sizing, type and executor. `criteria` says whether
 * the heading is missing or just empty. Additive under §8 on the same terms as the
 * sizing member; never a gate.
 */
const underAuthoredShapeAdvisorySchema = z.object({
  kind: z.literal('shape'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  criteria: z.string(),
});

/**
 * A RUNNER-STOP body member (MOTIR-10380): `leaf-no-description` (a childless,
 * non-exempt leaf whose description is blank) or `leaf-no-criteria` (a body with no
 * enumerated acceptance criterion; `criteria` is `no-heading` or `no-criterion`).
 * Both carry the literal `runnerStop: true`, which is what a reader keys on.
 * `validate_plan` emits them; the dispatch path does not today, and the variant is
 * here so the published contract parses a payload that carries one.
 *
 * ⚠️ LISTED FIRST in the union below, and that is load-bearing: the union's object
 * members strip unknown keys, so a `leaf-no-criteria` payload tried against the
 * under-authored member first would parse there and lose `runnerStop`. Its required
 * `runnerStop` literal is what makes this member match only a runner stop.
 *
 * Additive under §8: a new member of a union whose `severity` is open-ended.
 */
const leafBodyRunnerStopShapeAdvisorySchema = z.object({
  kind: z.literal('shape'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  runnerStop: z.literal(true),
  /** `leaf-no-criteria` only: `no-heading` or `no-criterion`. */
  criteria: z.string().optional(),
});

/**
 * The MULTI-REPO RUNNER-STOP member (MOTIR-10381): `leaf-multi-repo` — a childless,
 * non-exempt leaf whose acceptance criteria name paths in two or more repositories,
 * whatever its repository set carries. `repo` is the second repository, `path` its
 * first path and `criterionIndex` the criterion naming it. Carries `runnerStop: true`.
 *
 * ⚠️ FIRST in the union, ahead of the body member and the criterion-shaped member:
 * the criterion-shaped member would otherwise accept this payload and strip
 * `runnerStop`, and the body member would strip `path` / `repo` / `criterionIndex`.
 * Its required fields are a superset of both, so it never captures either of them.
 *
 * Additive under §8, on the same terms as the body member.
 */
const leafMultiRepoRunnerStopShapeAdvisorySchema = z.object({
  kind: z.literal('shape'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  runnerStop: z.literal(true),
  /** The repo-qualified path the criterion names. */
  path: z.string(),
  /** The second repository that path resolves to. */
  repo: z.string(),
  /** 1-based index of the criterion naming it. */
  criterionIndex: z.number().int(),
});

/**
 * A SUBSUMPTION advisory — a path the card's body names was touched by a merged
 * pull request that is not this card's own and that merged after the card was
 * filed, so its deliverable may already be in the repository (MOTIR-2903).
 *
 * Its own variant rather than a third shape severity: a shape finding carries
 * the `criterionIndex` its remedy cuts at, and this one has no criterion — the
 * path that catches the canonical fixture sits in a card's Context refs, not in
 * its criteria. Making `criterionIndex` optional on the shipped shape schema
 * would have been a nullability change, which §8 forbids.
 *
 * ⚠️ Additive under §8 — a new member of a union whose `severity` was already
 * open-ended, on a field every client is required to tolerate unknown members
 * of. `V1_CONTRACT_VERSION` moves with it (Amendment 8's obligation), which is
 * how a client learns the family exists without re-reading a document.
 */
const subsumptionAdvisoryBase = {
  kind: z.literal('subsumption'),
  item: workItemKeySchema,
  severity: advisorySeveritySchema,
  /** The first path the card's body names that a qualifying pull request touched. */
  path: z.string(),
  /** The covering pull request as `owner/name#number` — where to read the diff. */
  pullRequest: z.string(),
  /** That pull request's title, or `null` when the mirror row carries none. */
  pullRequestTitle: z.string().nullable(),
};

/**
 * ⚠️ TWO VARIANTS RATHER THAN ONE NULLABLE FIELD, and the reason is §8 (MOTIR-3230).
 *
 * The obvious spelling of "an open pull request has not merged" is to relax
 * `mergedAt` to `z.string().nullable()`. That is a RETYPE of a declared field, which
 * §8 forbids outright — a client narrowing `mergedAt` to a string would start
 * receiving null from an operation whose contract had promised otherwise.
 *
 * Split into two variants, nothing a client has ever received changes: the MERGED
 * variant is byte-identical to the shipped shape plus `state: 'merged'`, which is
 * §8's allowed "new field on an existing shape". The OPEN variant is a payload no
 * consumer has ever seen, so none can be broken by its arrival — the same reasoning
 * that made the `shape` member additive when it joined this union.
 */
const subsumptionMergedAdvisorySchema = z.object({
  ...subsumptionAdvisoryBase,
  state: z.literal('merged'),
  /** When it merged, ISO-8601 — always after the card's own creation. */
  mergedAt: z.string(),
});

const subsumptionOpenAdvisorySchema = z.object({
  ...subsumptionAdvisoryBase,
  state: z.literal('open'),
  /** Null, always — an open pull request has not merged. Branch on `state`. */
  mergedAt: z.null(),
});

const subsumptionAdvisorySchema = z.union([
  subsumptionMergedAdvisorySchema,
  subsumptionOpenAdvisorySchema,
]);

/**
 * ONE advisory. A plain union rather than a discriminated one, because the
 * discriminant is absent on the reference variant — narrow POSITIVELY on the
 * TAGGED members (`'kind' in a && a.kind === 'shape' | 'subsumption'`); an
 * untagged object, and only an untagged one, is a reference.
 */
export const dispatchAdvisorySchema = z.union([
  leafMultiRepoRunnerStopShapeAdvisorySchema,
  leafBodyRunnerStopShapeAdvisorySchema,
  criterionShapeAdvisorySchema,
  sizingShapeAdvisorySchema,
  selfBlockingDesignShapeAdvisorySchema,
  bodyAboveFieldMoveShapeAdvisorySchema,
  blockerCountShapeAdvisorySchema,
  underAuthoredShapeAdvisorySchema,
  subsumptionAdvisorySchema,
  referenceAdvisorySchema,
]);
export type V1DispatchAdvisory = z.infer<typeof dispatchAdvisorySchema>;

/**
 * The assembled coding-agent prompt plus the facts a client routes on.
 *
 * ⚠️ `advisories` is NEVER A GATE and the schema must not read like one. The
 * prompt, the `workflowMode` and the item's readiness are byte-identical whether
 * the array is empty or not: an advisory changes what a caller is TOLD, never
 * what it may do. It is always PRESENT — `[]` when there are none — so a client
 * never branches on absence.
 */
/**
 * The per-repository DELIVERY state (`lib/workItems/repoDelivery.ts`) — what one
 * repository of an item's set has to show for itself. `null` for a repository
 * the card does not carry (the unpinned card whose project has exactly one).
 */
export const dispatchRepoDeliverySchema = z
  .enum([
    'delivered',
    'awaiting',
    'unknown',
    'unestablished',
    'excluded',
    'delivered_without_change_request',
  ])
  .nullable();

/** ONE repository of the dispatch set (MOTIR-3131). */
export const dispatchRepoSchema = z.object({
  /** The bare repository NAME the CLI keys `<root>/<name>` on. */
  name: z.string(),
  /** Its HTTPS clone URL, or `null` when Motir does not know one. */
  cloneUrl: z.string().nullable(),
  /** Its default branch — never guessed as `"main"`. */
  defaultBranch: z.string().nullable(),
  delivery: dispatchRepoDeliverySchema,
});

export const dispatchPromptSchema = z.object({
  key: workItemKeySchema,
  /** The full multi-section prompt text, ready to hand to a coding agent. */
  prompt: z.string(),
  /**
   * The item's PARENT key, or `null` for a top-level item (MOTIR-2445).
   *
   * The prompt already NAMES it, in the CONTEXT section's `- Parent:` line; this
   * is that fact as a field, so a client does not have to parse prose the server
   * may reword. Additive under §8.
   */
  parentKey: workItemKeySchema.nullable(),
  /** The RESOLVED bare repo name, or `null` when Motir cannot say. */
  targetRepo: z.string().nullable(),
  /** Its HTTPS clone URL, or `null` when Motir does not know one. */
  targetRepoCloneUrl: z.string().nullable(),
  /** The resolved repo's default branch — never guessed as `"main"`. */
  targetRepoDefaultBranch: z.string().nullable(),
  /**
   * EVERY repository the item ships in (MOTIR-3131) — ordered, primary first,
   * each with its coordinates and its delivery state. Always present; `[]` when
   * Motir cannot say. The scalar `targetRepo` above is a PROJECTION of this
   * array (`targetRepos[0]?.name ?? null`), never independently writable state.
   */
  targetRepos: z.array(dispatchRepoSchema),
  workflowMode: dispatchWorkflowModeSchema,
  /** The session branch the prompt instructs, or `null` in `per_item_pr` mode. */
  sessionBranch: z.string().nullable(),
  /**
   * The branch the prompt tells the agent to create for its work — the SAME name
   * in every repository the item ships in — or `null` for a manual item, which
   * has no branch (MOTIR-6539). The pull request comes from it in `per_item_pr`
   * mode and from `sessionBranch` in `session_lineage` mode. Additive under §8.
   *
   * OPTIONAL in the schema though this server always sends it: the `motir` CLI is
   * published separately and is routinely pointed at an older self-hosted Motir,
   * whose payload has no such key — absent must validate, and read as "no branch
   * to checkpoint", never as a malformed response.
   */
  workBranch: z.string().nullable().optional(),
  /**
   * The branch the prompt tells the agent to work on (MOTIR-6530) — the session
   * branch, else the card's per-item branch; `null` for a manual item.
   *
   * ⚠️ OPTIONAL in the contract though this server always sends it: the CLI
   * validates responses against this schema and is routinely pointed at an older
   * Motir, which sends no such key — a required field would turn that skew into a
   * refused dispatch rather than a run that simply does not know its branch.
   */
  branch: z.string().nullable().optional(),
  advisories: z.array(dispatchAdvisorySchema),
});
export type V1DispatchPrompt = z.infer<typeof dispatchPromptSchema>;

/**
 * Map the dispatch payload to the wire — field by field, never a spread.
 *
 * The advisory objects are re-shaped per variant rather than passed through, so
 * a field added to `WorkItemProseAdvisoryDto` for an internal consumer cannot
 * become public API by accident. That is the whole job of this seam.
 */
export function presentDispatchPrompt(dto: DispatchPromptDto): V1DispatchPrompt {
  return {
    key: dto.key,
    prompt: dto.prompt,
    parentKey: dto.parentKey,
    targetRepo: dto.targetRepo,
    targetRepoCloneUrl: dto.targetRepoCloneUrl,
    targetRepoDefaultBranch: dto.targetRepoDefaultBranch,
    targetRepos: dto.targetRepos.map((repo) => ({
      name: repo.name,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      delivery: repo.delivery,
    })),
    workflowMode: dto.workflowMode,
    sessionBranch: dto.sessionBranch,
    workBranch: dto.workBranch,
    branch: dto.branch,
    // The POST-MERGE-CHILD member (MOTIR-8863) is a VALIDATE-time finding about a
    // child's PLACEMENT in its container. The dispatch builder hands the prose
    // check no parent, so it never emits one here; the filter keeps the wire
    // contract unchanged (no new variant, no contract-version move) and makes the
    // mapper total over the DTO union. The MISLABELLED-LINK member (MOTIR-9007)
    // is the same case: the dispatch builder switches that check off.
    advisories: dto.advisories
      .filter(
        (
          advisory,
        ): advisory is Exclude<
          typeof advisory,
          WorkItemProsePostMergeChildAdvisoryDto | WorkItemProseMislabelledLinkAdvisoryDto
        > => !isPostMergeChildAdvisory(advisory) && !isMislabelledLinkAdvisory(advisory),
      )
      .map((advisory) => {
        // The RUNNER-STOP members (MOTIR-10380) first: they carry no
        // `criterionIndex`, so the generic `shape` branch below must never see one.
        if (isRunnerStopAdvisory(advisory)) {
          if (advisory.severity === 'leaf-multi-repo') {
            return {
              kind: 'shape' as const,
              item: advisory.item,
              severity: advisory.severity,
              runnerStop: true as const,
              path: advisory.path,
              repo: advisory.repo,
              criterionIndex: advisory.criterionIndex,
            };
          }
          return advisory.severity === 'leaf-no-criteria'
            ? {
                kind: 'shape' as const,
                item: advisory.item,
                severity: advisory.severity,
                runnerStop: true as const,
                criteria: advisory.criteria,
              }
            : {
                kind: 'shape' as const,
                item: advisory.item,
                severity: advisory.severity,
                runnerStop: true as const,
              };
        }
        if (isUnderAuthoredAdvisory(advisory)) {
          return {
            kind: 'shape' as const,
            item: advisory.item,
            severity: advisory.severity,
            criteria: advisory.criteria,
          };
        }
        if (isBlockerCountAdvisory(advisory)) {
          return {
            kind: 'shape' as const,
            item: advisory.item,
            severity: advisory.severity,
            claim: advisory.claim,
            claimedCount: advisory.claimedCount,
            blockerCount: advisory.blockerCount,
          };
        }
        // The SELF-BLOCKING-DESIGN member (MOTIR-3178) — narrowed out here for the
        // same reason the SIZING member below is: it carries no `criterionIndex`,
        // and the generic `shape` branch further down reads one.
        if (isSelfBlockingDesignAdvisory(advisory)) {
          return {
            kind: 'shape' as const,
            item: advisory.item,
            severity: advisory.severity,
            designCriterionIndex: advisory.designCriterionIndex,
            surfaceCriterionIndex: advisory.surfaceCriterionIndex,
          };
        }
        // The BODY-EDIT-ABOVE-FIELD-MOVE member (MOTIR-5399) — the third `shape`
        // variant with no `criterionIndex`, narrowed out for the same reason.
        if (isBodyAboveFieldMoveAdvisory(advisory)) {
          return {
            kind: 'shape' as const,
            item: advisory.item,
            severity: advisory.severity,
            bodyEdit: { at: advisory.bodyEdit.at, fields: [...advisory.bodyEdit.fields] },
            fieldMove: { at: advisory.fieldMove.at, fields: [...advisory.fieldMove.fields] },
          };
        }
        // The SIZING member next, because it is the other `shape` variant with no
        // `criterionIndex` — narrowing both out is what lets the branch below read
        // the index off the two members that have one (MOTIR-3110).
        if (isSizingAdvisory(advisory)) {
          return {
            kind: 'shape' as const,
            item: advisory.item,
            severity: advisory.severity,
            threshold: advisory.threshold,
            storyPoints: advisory.storyPoints,
            estimateMinutes: advisory.estimateMinutes,
          };
        }
        if (advisory.kind === 'shape') {
          return {
            kind: 'shape' as const,
            item: advisory.item,
            severity: advisory.severity,
            criterionIndex: advisory.criterionIndex,
            ...(advisory.severity === 'likely-ordering-violation'
              ? { phrase: advisory.phrase }
              : { path: advisory.path, repo: advisory.repo, reason: advisory.reason }),
          };
        }
        if (advisory.kind === 'subsumption') {
          const base = {
            kind: 'subsumption' as const,
            item: advisory.item,
            severity: advisory.severity,
            path: advisory.path,
            pullRequest: advisory.pullRequest,
            pullRequestTitle: advisory.pullRequestTitle,
          };
          // Branched on `state` rather than on `mergedAt`, so the two wire variants
          // are produced by the same discriminant a consumer reads them by, and a
          // merged entry can never be emitted carrying a null instant.
          return advisory.state === 'open'
            ? { ...base, state: 'open' as const, mergedAt: null }
            : { ...base, state: 'merged' as const, mergedAt: advisory.mergedAt };
        }
        return {
          item: advisory.item,
          referenced: advisory.referenced,
          referencedStatus: advisory.referencedStatus,
          severity: advisory.severity,
        };
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The KEYED CLAIM (MOTIR-2961)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a claim attempt resolved to.
 *
 * A CLOSED enum, unlike `advisorySeveritySchema` above, and deliberately: an
 * advisory is a thing a client may ignore, so an unknown member is safe there.
 * This value decides whether the caller may START WORK, and a client that met a
 * fifth outcome it did not know would have to guess which of "go" and "stop" it
 * meant. Adding a member here is therefore a §8 event with a version bump, not
 * a quiet extension.
 */
export const workItemClaimOutcomeSchema = z.enum(['claimed', 'mine', 'taken', 'not_claimable']);

/**
 * The result of claiming ONE work item by key.
 *
 * ⚠️ **A REFUSAL IS A 200, NOT AN ERROR** — the shape follows the same rule
 * `POST /api/v1/sessions/complete` states for its per-item outcomes: a partial
 * result is a real result. Three of the four outcomes are things a dispatcher
 * routinely meets on the happy path (it resumed its own work, a sibling was
 * faster, the card is finished), and turning two of them into HTTP failures
 * would make a client parse an error body to learn it may simply proceed.
 * Genuine failures keep their own statuses: an unknown or cross-workspace key is
 * the usual 404, a malformed one a 422.
 *
 * ⚠️ **`assignee` and `transitionedBy` are BOTH here because either can be the
 * only one that names the holder.** The assignee column is a LABEL a dispatcher
 * writes for its teammates and nothing guarantees it was written: the incident
 * this endpoint exists for (MOTIR-2958) is a session that flipped the status and
 * never assigned, so the loser reads `assignee: null` on a card somebody is
 * plainly working on. `transitionedBy` comes from the status-change history and
 * answers the question the column cannot.
 */
export const workItemClaimSchema = z.object({
  key: workItemKeySchema,
  /** The item's title, so a refusal is legible without a second call. */
  title: z.string(),
  outcome: workItemClaimOutcomeSchema,
  /** `outcome === "claimed"`, as its own boolean — the happy-path branch a
   *  client can take without knowing the vocabulary. */
  claimed: z.boolean(),
  /** The status AFTER this call: the new one on a claim, the untouched one on
   *  every refusal. `category` is what the claim decision was made on, and is
   *  `null` for a status the project's workflow does not define — an unknown
   *  category is never claimable, so `null` reads as "not available" rather
   *  than as a missing field. */
  status: z.object({ key: z.string(), category: z.string().nullable() }),
  /** Who the item is assigned to now — the caller on a claim, the holder on a
   *  refusal, `null` when nobody was ever assigned. */
  assignee: actorRefSchema.nullable(),
  /** Who performed the status transition that put the item where it is. */
  transitionedBy: actorRefSchema.nullable(),
  /** When that transition happened, or `null` for an item whose status has
   *  never moved. */
  transitionedAt: z.string().datetime().nullable(),
});
export type V1WorkItemClaim = z.infer<typeof workItemClaimSchema>;

/** Map the claim result to the wire — field by field, never a spread. */
export function presentWorkItemClaim(dto: WorkItemClaimDto): V1WorkItemClaim {
  return {
    key: dto.key,
    title: dto.title,
    outcome: dto.outcome,
    claimed: dto.claimed,
    status: { key: dto.status.key, category: dto.status.category },
    assignee: dto.assignee === null ? null : { id: dto.assignee.id, name: dto.assignee.name },
    transitionedBy:
      dto.transitionedBy === null
        ? null
        : { id: dto.transitionedBy.id, name: dto.transitionedBy.name },
    transitionedAt: dto.transitionedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The REPAIR CLAIM (Story MOTIR-5460 · MOTIR-5464)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a repair claim resolved to. CLOSED, for the reason
 * `workItemClaimOutcomeSchema` gives: it decides whether the caller may start an
 * agent, and a client meeting an unknown member would have to guess.
 */
export const workItemRepairOutcomeSchema = z.enum(['claimed', 'mine', 'taken', 'not_repairable']);

/** Why a card cannot be repaired — set exactly on `not_repairable`. CLOSED. */
export const workItemRepairRefusalSchema = z.enum([
  'not_implemented',
  'repair_on_run_target',
  'no_pull_requests',
  'ci_running',
  'not_failing',
  'repair_not_code',
]);

/** One failing pull request a fixing agent is handed. */
const repairPullRequestSchema = z.object({
  /** `owner/name`. */
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  /** The pull request's own branch — the agent checks it out and pushes to it,
   *  so the SAME pull request runs its checks again. The delivery read does not
   *  expose it, which is why it rides here. */
  headRef: z.string(),
  /** The branch the pull request targets; the agent merges it first. Null on a
   *  row mirrored before base branches were recorded. */
  baseRef: z.string().nullable(),
  /** From `derivePrCiState`, the verdict the Development pill shows — the pull
   *  request's OWN checks. It may be `passing` when `queueExit` is set: the merge
   *  queue failed on its merge group, not on its own checks. */
  ci: z.enum(['passing', 'failing', 'running']).nullable(),
  /** The checks failing at that verdict's commit, by name, sorted. A repair that
   *  gives up re-claims (`mine`) and names these. */
  failingChecks: z.array(z.string()),
  /** The standing merge-queue FAILURE that makes this pull request failing, or
   *  null. Set exactly when its latest queue exit is a failure, not re-queued, at
   *  its current head (MOTIR-5719). */
  queueExit: z
    .object({
      /** GitHub's own reason — `CI_FAILURE`, `CI_TIMEOUT`, `MERGE_CONFLICT`, … */
      rawReason: z.string(),
      exitedAt: z.string().datetime(),
      /** The head the queue tested — the pull request's current head. */
      headSha: z.string(),
      /** The queue's failing check; both null when none is known (a conflict). */
      failingCheckName: z.string().nullable(),
      failingCheckUrl: z.string().nullable(),
    })
    .nullable(),
});

/**
 * The result of claiming the REPAIR of one `implemented` card's red pull requests.
 *
 * ⚠️ **A REFUSAL IS A 200**, as on the keyed claim: `taken` and `not_repairable`
 * are ordinary answers a person running `motir fix` meets, and each is stated in
 * words by the CLI. ⚠️ **THE CARD'S STATUS AND ASSIGNEE ARE NEVER WRITTEN** — the
 * claim is an open dispatch run with command `fix`, and that run is the lock.
 */
export const workItemRepairClaimSchema = z.object({
  key: workItemKeySchema,
  title: z.string(),
  outcome: workItemRepairOutcomeSchema,
  /** Why the card cannot be repaired; null unless `outcome` is `not_repairable`. */
  reason: workItemRepairRefusalSchema.nullable(),
  /** The card to repair instead; set only with `reason: repair_on_run_target`. */
  runTargetKey: workItemKeySchema.nullable(),
  /** The open `fix` run — set on `claimed`, `mine` and `taken`. Report into it and
   *  CLOSE it (`POST /api/v1/dispatch-runs/{id}/close`): an unclosed run is what
   *  the item page shows as a repair in progress. */
  runId: z.string().nullable(),
  /** Who opened that run. */
  holder: actorRefSchema.nullable(),
  /** When that run started. */
  startedAt: z.string().datetime().nullable(),
  /** WHICH REPAIR this is (MOTIR-6502). `ci` — make the build pass. `acceptance_rerun`
   *  — the story's acceptance video was sent back with Re-run: fix what the reviewer
   *  saw (`acceptanceRefusal`), on the same pull requests, then re-record the video.
   *  `review` — a REVIEW sent the card back (MOTIR-6822): the review agent's
   *  `changes_requested`, or a person's Request changes on the approve-and-merge gate,
   *  still standing over the current version. Address every finding (`reviewRefusal`)
   *  on the same pull requests and push. `ci` on every refusal. */
  repairClass: z.enum(['ci', 'acceptance_rerun', 'review']),
  /** What the reviewer said — set exactly on an `acceptance_rerun` with `claimed` or
   *  `mine`, null otherwise. */
  acceptanceRefusal: z
    .object({
      /** The reason, verbatim. */
      reasonMd: z.string().nullable(),
      /** Who sent it back, as recorded at the decision. */
      decidedByLabel: z.string().nullable(),
      decidedAt: z.string().datetime(),
    })
    .nullable(),
  /** What the review said — set exactly on a `review` with `claimed` or `mine`, null
   *  otherwise (MOTIR-6822). */
  reviewRefusal: z
    .object({
      /** Which review sent it back: the review agent, or the approve-and-merge gate. */
      gate: z.enum(['agent_review', 'pull_request_approval']),
      /** The findings, verbatim and in full. */
      findingsMd: z.string().nullable(),
      /** Who sent it back — `Review agent` for the review agent, else the person. */
      reviewerName: z.string().nullable(),
      decidedAt: z.string().datetime(),
    })
    .nullable(),
  /** The failing OPEN pull requests — non-empty on `claimed` and `mine`, empty on
   *  every other outcome. On an `acceptance_rerun` or a `review`, EVERY open member,
   *  green ones included: the fix is to the delivered work, not to a red check. */
  pullRequests: z.array(repairPullRequestSchema),
});
export type V1WorkItemRepairClaim = z.infer<typeof workItemRepairClaimSchema>;

/** Map the repair claim to the wire — field by field, never a spread. */
export function presentWorkItemRepairClaim(dto: WorkItemRepairClaimDto): V1WorkItemRepairClaim {
  return {
    key: dto.key,
    title: dto.title,
    outcome: dto.outcome,
    reason: dto.reason,
    runTargetKey: dto.runTargetKey,
    runId: dto.runId,
    holder: dto.holder === null ? null : { id: dto.holder.id, name: dto.holder.name },
    startedAt: dto.startedAt,
    repairClass: dto.repairClass,
    acceptanceRefusal:
      dto.acceptanceRefusal === null
        ? null
        : {
            reasonMd: dto.acceptanceRefusal.reasonMd,
            decidedByLabel: dto.acceptanceRefusal.decidedByLabel,
            decidedAt: dto.acceptanceRefusal.decidedAt,
          },
    reviewRefusal:
      dto.reviewRefusal === null
        ? null
        : {
            gate: dto.reviewRefusal.gate,
            findingsMd: dto.reviewRefusal.findingsMd,
            reviewerName: dto.reviewRefusal.reviewerName,
            decidedAt: dto.reviewRefusal.decidedAt,
          },
    pullRequests: dto.pullRequests.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      ci: pr.ci,
      failingChecks: [...pr.failingChecks],
      queueExit:
        pr.queueExit === null
          ? null
          : {
              rawReason: pr.queueExit.rawReason,
              exitedAt: pr.queueExit.exitedAt,
              headSha: pr.queueExit.headSha,
              failingCheckName: pr.queueExit.failingCheckName,
              failingCheckUrl: pr.queueExit.failingCheckUrl,
            },
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The SCOPE CLAIM (MOTIR-3049)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT to claim — a container by key, or a project's ACTIVE sprint.
 *
 * ⚠️ ONE OPERATION AND A DISCRIMINATED BODY, not two endpoints. The two scopes
 * are named by DIFFERENT things — a `MOTIR-<n>` key on one side, a project key
 * on the other — so neither can be a path parameter of the other, and splitting
 * them would give the identical lock, the identical category re-assert and the
 * identical six-member outcome vocabulary two places to drift apart in. The body
 * is the only part that actually differs, so the body is where the difference
 * lives. (`POST /api/v1/sessions/complete` is the shipped precedent for a write
 * addressed by its body rather than by its path.)
 */
export const scopeClaimBodySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('work_item'),
      /** The container's key — a story, task or bug. Case-insensitive. */
      key: z.string().min(1).max(64),
      /**
       * Leave children already LANDED (Implemented or later) out of the claim
       * instead of refusing on them. Sent by `motir continue <PARENT>`, whose
       * dead run landed them (MOTIR-6535); a fresh run omits it.
       */
      exceptLanded: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sprint'),
      /** The project whose ACTIVE sprint to claim. Case-insensitive. */
      projectKey: z.string().min(1).max(64),
    })
    .strict(),
]);
export type V1ScopeClaimBody = z.infer<typeof scopeClaimBodySchema>;

/** What a scope claim resolved to. A CLOSED enum, for the reason
 *  `workItemClaimOutcomeSchema` states: it decides whether the caller may START
 *  WORK, and a client meeting a seventh member would have to guess. */
export const scopeClaimOutcomeSchema = z.enum([
  'claimed',
  'mine',
  'taken',
  'not_claimable',
  'wrong_shape',
  'not_finishable',
]);

/** One work item now held by the caller. */
export const scopeClaimMemberSchema = z.object({
  key: workItemKeySchema,
  title: z.string(),
  status: z.object({ key: z.string(), category: z.string().nullable() }),
});

/** The member whose state refused the claim, with its holder named. */
export const scopeClaimOffenderSchema = z.object({
  key: workItemKeySchema,
  title: z.string(),
  status: z.object({ key: z.string(), category: z.string().nullable() }),
  /** Who it is assigned to — `null` when a sibling flipped the status without assigning. */
  assignee: actorRefSchema.nullable(),
  /** Who moved it there. The field that names a holder the assignee column cannot. */
  transitionedBy: actorRefSchema.nullable(),
  transitionedAt: z.string().datetime().nullable(),
});

/** Why a `wrong_shape` scope is not runnable. */
export const scopeClaimShapeSchema = z.object({
  /** The child that is itself a container. */
  child: workItemKeySchema,
  childTitle: z.string(),
  /** Hops from the scope root to the work under `child`. `1` is the only
   *  claimable depth, so this is always at least `2`. */
  depth: z.number().int(),
});

/** One reason a scope cannot be finished — the validators' own shape. */
export const scopeClaimBlockerSchema = z.object({
  /** The in-scope item that is gated. */
  item: workItemKeySchema,
  /** The out-of-scope, not-done item gating it. */
  blockedBy: workItemKeySchema,
  blockerStatus: z.string(),
  blockerSprintId: z.string().nullable(),
});

/**
 * The result of claiming ONE scope.
 *
 * ⚠️ **A REFUSAL IS A 200, NOT AN ERROR**, for the same reason the keyed claim
 * gives: most refusals are ordinary states a dispatcher meets on the happy path,
 * and two of them (`wrong_shape`, `not_finishable`) are findings the caller acts
 * on by submitting a re-plan rather than by retrying. Genuine failures keep their
 * statuses: an unknown or cross-workspace key is 404, a malformed one 422, and a
 * project with no active sprint is 409.
 *
 * ⚠️ **`members` IS EMPTY ON EVERY REFUSAL**, and that is the contract rather
 * than an omission: a refused claim claimed NOTHING. A partially-claimed scope is
 * the one outcome with no good handling — you can neither finish it nor cleanly
 * abandon it — so there is no shape here that can express one.
 */
export const scopeClaimSchema = z.object({
  scope: z.object({
    kind: z.enum(['work_item', 'sprint']),
    /** The container's key, or `null` for a sprint scope. */
    key: workItemKeySchema.nullable(),
    /** The sprint's id, or `null` for a work-item scope. */
    sprintId: z.string().nullable(),
    /** The container's title, or the sprint's name. */
    name: z.string(),
  }),
  outcome: scopeClaimOutcomeSchema,
  /** `outcome === "claimed"`, as its own boolean. */
  claimed: z.boolean(),
  /** Every row the caller now holds, by key. `[]` on every refusal. */
  members: z.array(scopeClaimMemberSchema),
  /** Present for `mine` / `taken` / `not_claimable`; `null` otherwise. */
  offender: scopeClaimOffenderSchema.nullable(),
  /** Present for `wrong_shape`; `null` otherwise. */
  shape: scopeClaimShapeSchema.nullable(),
  /** Present for `not_finishable`; `[]` otherwise. */
  blockers: z.array(scopeClaimBlockerSchema),
});
export type V1ScopeClaim = z.infer<typeof scopeClaimSchema>;

/** Map the scope-claim result to the wire — field by field, never a spread. */
export function presentScopeClaim(dto: ScopeClaimDto): V1ScopeClaim {
  return {
    scope: {
      kind: dto.scope.kind,
      key: dto.scope.key,
      sprintId: dto.scope.sprintId,
      name: dto.scope.name,
    },
    outcome: dto.outcome,
    claimed: dto.claimed,
    members: dto.members.map((m) => ({
      key: m.key,
      title: m.title,
      status: { key: m.status.key, category: m.status.category },
    })),
    offender:
      dto.offender === null
        ? null
        : {
            key: dto.offender.key,
            title: dto.offender.title,
            status: { key: dto.offender.status.key, category: dto.offender.status.category },
            assignee:
              dto.offender.assignee === null
                ? null
                : { id: dto.offender.assignee.id, name: dto.offender.assignee.name },
            transitionedBy:
              dto.offender.transitionedBy === null
                ? null
                : {
                    id: dto.offender.transitionedBy.id,
                    name: dto.offender.transitionedBy.name,
                  },
            transitionedAt: dto.offender.transitionedAt,
          },
    shape:
      dto.shape === null
        ? null
        : { child: dto.shape.child, childTitle: dto.shape.childTitle, depth: dto.shape.depth },
    blockers: dto.blockers.map((b) => ({
      item: b.item,
      blockedBy: b.blockedBy,
      blockerStatus: b.blockerStatus,
      blockerSprintId: b.blockerSprintId,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session close-out — the two `integration`-scoped writes (11.7.4)
// ─────────────────────────────────────────────────────────────────────────────

/** Self-reported implementation provenance, applied by both close-out writes. */
export const implementationProvenanceSchema = z.object({
  implementationSource: z.enum(['byok', 'manual']).nullable(),
  implementationHarness: z.string().nullable(),
  implementationModel: z.string().nullable(),
});

/**
 * What recording ONE item as integrated returns.
 *
 * Deliberately NOT the whole work item: the operation answers "did the
 * integration land, and where?", and the caller that needs the item's fields has
 * `GET /api/v1/work-items/{key}` for that. A second full work-item shape here
 * would be a second place for the resource to drift.
 */
export const integrationResultSchema = z
  .object({
    key: workItemKeySchema,
    /** The status the workflow moved it to — `in_review` on the shipped default. */
    status: z.string(),
    /** The branch the work was integrated onto. */
    sessionBranch: z.string().nullable(),
    updatedAt: z.string(),
  })
  .extend(implementationProvenanceSchema.shape);

/**
 * What recording provenance ALONE returns (MOTIR-2421).
 *
 * The triple that was just written, plus the two facts a caller needs in order
 * to see that nothing else moved: the status is echoed unchanged, and
 * `sessionBranch` is here precisely so a client can READ that it is still null.
 * That is the assertion the dangerous fix fails — not "provenance was recorded",
 * which the wrong implementation also satisfies.
 */
export const implementationReportSchema = z
  .object({
    key: workItemKeySchema,
    /** Unchanged by this operation — it moves no status. */
    status: z.string(),
    /** Untouched by this operation. Null for a per-item-PR run, and it stays so. */
    sessionBranch: z.string().nullable(),
    updatedAt: z.string(),
  })
  .extend(implementationProvenanceSchema.shape);

/** How ONE item on a closed session branch fared. */
export const sessionCloseOutItemSchema = z.object({
  key: workItemKeySchema,
  outcome: z.enum(['completed', 'already_done', 'failed']),
  /** Present only on `failed` — the typed error's message. */
  reason: z.string().optional(),
});

/**
 * The bulk close-out result.
 *
 * PER-ITEM outcomes rather than a single verdict, because the underlying write
 * deliberately does not roll back the items that DID complete when one cannot
 * reach `done`. A client that only read a status code would believe a partial
 * close-out was a total one.
 */
export const sessionCloseOutSchema = z.object({
  sessionBranch: z.string(),
  results: z.array(sessionCloseOutItemSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// The job handle — ADR Amendment 6 Q3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a JOB-SUBMITTING endpoint returns: an expansion, or a plan-session
 * submit. Both answer 202.
 *
 * ⚠️ **This shape signals "accepted" by what it CANNOT carry.** There is no
 * `items`, no `proposals`, no `count` and no `status` — a client cannot read an
 * outcome out of it at all, only an address to come back to. That is stronger
 * than a `status: "accepted"` literal, which is a label a reader skims past and
 * which would collide with the PLAN's own status vocabulary. Nothing has been
 * planned when this is returned, and what eventually arrives is a plan of
 * PROPOSALS that only a human approving in Motir turns into work items.
 */
export const planJobHandleSchema = z.object({
  /** The motir-ai job. Nothing is waiting on it. */
  jobId: z.string(),
  /** The plan it will fill with proposals. */
  planId: z.string(),
  /** Where to read what became of it — a path, since the server behind a proxy
   *  cannot know its own public origin. */
  statusUrl: z.string(),
});
export type V1PlanJobHandle = z.infer<typeof planJobHandleSchema>;

/** Build the handle's poll address. ONE place, so the two 202 endpoints cannot
 *  hand back different URLs for the same read. */
export function planStatusUrl(planId: string): string {
  return `/api/v1/plans/${planId}/status`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plans — the two reads (11.7.5)
// ─────────────────────────────────────────────────────────────────────────────

/** A plan's own lifecycle state. There is deliberately no synthetic `failed`, and
 *  MOTIR-3064 re-affirmed that rather than adding one: a failed job writes no
 *  terminal plan state of its own, which is what `job` below is for in the
 *  moment, and a background reconciler settles an abandoned plan to `declined`
 *  (with a null decider — nobody decided it) rather than widening this
 *  vocabulary. See `docs/decisions/agent-authored-plans.md` AMENDMENT 2.
 *
 *  `stale` (MOTIR-3574, AMENDMENT 9) is the one member that IS neither live-and-
 *  approvable nor decided: the plan reached a reviewer and can no longer be
 *  approved, because a `modify`/`remove` target reached a terminal status after
 *  the plan closed. A client asking *is this decided?* must NOT read it as one —
 *  the plan is live and awaiting action, and the drift can reverse.
 *
 *  `approving` (Bug MOTIR-9006) is an approve IN PROGRESS: a person approved the
 *  plan and its proposals are being written into work items. Not decided yet and no
 *  longer a proposal — a loop waits on it as it waits on `generating`; it ends at
 *  `approved`, or back at `planned` if the approval failed. */
export const planStatusSchema = z.enum([
  'generating',
  'planned',
  'approving',
  'stale',
  'approved',
  'declined',
]);

/** WHY the plan was started — someone clicked, or the cadence watcher fired. */
export const planOriginSchema = z.enum(['user', 'cadence']);

/** The producing job's liveness, present ONLY while the plan is `generating`. */
export const planJobStateSchema = z.object({
  status: z.string().nullable(),
  /** `false` ⟺ motir-ai could not be asked; `failure` then describes the outage. */
  reachable: z.boolean(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
});

/**
 * What became of a submitted planning job — the companion read to every handle.
 *
 * `proposalCount` is named for what it counts. The DTO calls it `itemCount`, and
 * "item" is the word this API uses for a WORK ITEM everywhere else; a client
 * reading `itemCount` off a plan would reasonably believe work items exist. None
 * do until the plan is approved.
 */
export const planOutcomeSchema = z.object({
  planId: z.string(),
  status: planStatusSchema,
  origin: planOriginSchema,
  jobId: z.string().nullable(),
  proposalCount: z.number().int(),
  createdAt: z.string(),
  plannedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  job: planJobStateSchema.nullable(),
});

/** What an `add` proposal would create. Every field but the title is optional —
 *  a proposal is a draft, not a validated work item. */
/**
 * ONE proposed STEP of a `manual` card's to-do list (Story MOTIR-3810 ·
 * MOTIR-4620) — the element of {@link planProposalFieldsSchema}'s `todos`.
 *
 * Declared here rather than inferred, because a versioned contract STRIPS what
 * it does not name: without this a plan carrying steps and a plan carrying none
 * are byte-identical to a client, with nothing on the wire to say which.
 */
export const planProposalTodoSchema = z.object({
  text: z.string(),
  notesMd: z.string().nullable(),
  commandText: z.string().nullable(),
  executor: z.enum(['coding_agent', 'human']).nullable(),
});

export const planProposalFieldsSchema = z.object({
  title: z.string(),
  kind: z.string().nullable(),
  type: z.string().nullable(),
  priority: z.string().nullable(),
  executor: z.string().nullable(),
  storyPoints: z.number().nullable(),
  estimateMinutes: z.number().int().nullable(),
  descriptionMd: z.string().nullable(),
  targetRepo: z.string().nullable(),
  /**
   * The card's ORDERED STEPS, in the order they are performed — `null` on a
   * proposal that carries none, which is most of them.
   *
   * READ-ONLY on this surface, and that is a boundary rather than an omission:
   * `/api/v1` has no plan-AUTHORING operation at all (the author doors are the
   * MCP's and the internal seam's), so there is nothing here for a `todos` to be
   * written through.
   */
  todos: z.array(planProposalTodoSchema).nullable(),
});

/**
 * ONE proposal.
 *
 * ⚠️ `workItemKey` is `null` for an un-materialized `add`, and that null IS the
 * contract: it is how a client can tell a proposal from a work item without
 * reading prose. `parentRef` / `blockedByRefs` are the PROPOSED tree, carried as
 * refs precisely because the nodes they name may not exist.
 */
export const planProposalSchema = z.object({
  id: z.string(),
  op: z.enum(['add', 'modify', 'remove']),
  /** The `MOTIR-<n>` this proposal targets or created — `null` until approval. */
  workItemKey: workItemKeySchema.nullable(),
  proposedFields: planProposalFieldsSchema.nullable(),
  patch: z.record(z.string(), z.unknown()).nullable(),
  parentRef: z.string().nullable(),
  /**
   * The `MOTIR-<n>` {@link planProposalSchema.shape.parentRef} names, when it
   * names a COMMITTED work item (MOTIR-4085).
   *
   * ⚠️ ADDITIVE, and `parentRef` is untouched beside it. A ref is one of three
   * things — a work-item cuid, a `planItem:<id>` naming another `add` in this
   * same plan, or absent — and only the first has a key. So this is `null` for a
   * temp-ref, for a parent this caller may not browse, and for a proposal that
   * names no parent, exactly as `workItemKey` degrades.
   *
   * It exists because a client asking *where is this proposal putting a child?*
   * cannot answer it from `parentRef`: §7 forbids the cuid on the wire, so the
   * ref it receives is opaque to it. `motir auto --auto-approve-replan` is that
   * client — the lane check it runs before approving is a comparison against the
   * iteration's own parent key, and it has no way to turn a cuid into one.
   */
  parentKey: workItemKeySchema.nullable(),
  /**
   * The FOLDER this proposal names as its placement (MOTIR-5415) — the id
   * inside a `folder:<id>` `parentRef`, or inside a `modify`'s
   * `patch.parentRef`. `null` for a proposal that names a work item, a
   * temp-ref, the root, or no placement at all.
   *
   * ⚠️ ADDITIVE, beside `parentRef` exactly as `parentKey` is: the ref stays
   * verbatim, and this is its resolved reading.
   */
  folderId: z.string().nullable(),
  /**
   * That folder's names, ROOT FIRST (`["Parked", "2025"]`). `null` when
   * `folderId` is, AND when the folder no longer exists in the plan's project
   * — deleted after the plan was written, which approve refuses.
   */
  folderPath: z.array(z.string()).nullable(),
  blockedByRefs: z.array(z.string()),
});

/**
 * What the plan's motir-ai job cost (MOTIR-10815) — motir-ai's figures, each a
 * number or `null`.
 *
 * ⚠️ `null` IS "UNKNOWN", NEVER "FREE". A figure is `null` when motir-ai said it
 * cannot be known (its ledger is incomplete, or a session was unpriced), and the
 * whole block is `null`s when the cost could not be read at all. A kind reads `0`
 * only because motir-ai answered `0`. `totalCostMicroUsd` is motir-ai's own
 * total, never a sum of the kinds.
 */
export const planJobCostSchema = z.object({
  ledgerComplete: z.boolean().nullable(),
  totalCostMicroUsd: z.number().nullable(),
  credits: z.number().nullable(),
  bySessionKind: z.object({
    conversation: z.number().nullable(),
    lay: z.number().nullable(),
    author: z.number().nullable(),
    entry_author: z.number().nullable(),
    tool: z.number().nullable(),
  }),
});

export type V1PlanJobCost = z.infer<typeof planJobCostSchema>;

/** The cost block — the ONE presenter `presentPlan` and `presentMcpPlan` share. */
export function presentPlanJobCost(cost: PlanJobCostDto): V1PlanJobCost {
  const k = cost.bySessionKind;
  return {
    ledgerComplete: cost.ledgerComplete,
    totalCostMicroUsd: cost.totalCostMicroUsd,
    credits: cost.credits,
    bySessionKind: {
      conversation: k.conversation,
      lay: k.lay,
      author: k.author,
      entry_author: k.entry_author,
      tool: k.tool,
    },
  };
}

/** A plan WITH the proposals it bundles. */
export const planSchema = z.object({
  id: z.string(),
  status: planStatusSchema,
  origin: planOriginSchema,
  title: z.string().nullable(),
  summary: z.string().nullable(),
  sourceJobId: z.string().nullable(),
  proposalCount: z.number().int(),
  createdAt: z.string(),
  plannedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  proposals: z.array(planProposalSchema),
  /**
   * What the plan's job cost (MOTIR-10815) — on `GET /api/v1/plans/{planId}`
   * only, for a plan a motir-ai job produced. ABSENT for a plan with no
   * `sourceJobId`, and on every other answer that carries a plan.
   */
  cost: planJobCostSchema.optional(),
});

/**
 * The plan anchored at ONE WORK ITEM — or the honest absence of one (MOTIR-4085).
 *
 * ⚠️ `plan: null` IS AN ANSWER, NOT AN ERROR, and the wrapper exists to say so.
 * The question this resource asks is *what plan is anchored at this card?*, and
 * for almost every card in a project the true answer is *none* — nobody has
 * re-planned it. A 4xx there would make the ordinary state of the tree read as a
 * fault, and it would make a GET that is unanswerable for most valid keys, which
 * nothing else on this surface is.
 *
 * It is also the SIGNAL a caller acts on rather than a blank. An unattended loop
 * reads this to bound a plan before approving it; `null` tells it the agent
 * anchored its re-plan somewhere else — at a container, or at nothing — which is
 * a lane the prompt offers and calls legitimate. Reported as data, so the client
 * branches on a field instead of on a status code
 * (`public-api-conventions.md` §8).
 */
export const workItemPlanSchema = z.object({
  plan: planSchema.nullable(),
});

export type V1WorkItemPlan = z.infer<typeof workItemPlanSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The planning conversation (11.7.6)
// ─────────────────────────────────────────────────────────────────────────────

/** Who spoke. `system` marks the submit that sent the thread to the planner. */
export const planTurnRoleSchema = z.enum(['user', 'system', 'assistant']);

/** One turn, in `seq` order (0-based, gapless). */
export const planTurnSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  role: planTurnRoleSchema,
  body: z.string(),
  /** Set on the `system` turn a submit writes — the job it fired. */
  jobId: z.string().nullable(),
  question: z.string().nullable(),
  isAnswer: z.boolean(),
  authorId: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * The planning thread, addressed by SCOPE and never by id.
 *
 * `id` is reported because a client may want to correlate two reads, and
 * deliberately NOT accepted anywhere: every operation addresses the thread by
 * `projectKey` + `targetKeys`, which is what makes re-opening the same anchor set
 * RESUME the same conversation the web app is looking at rather than fork a
 * second one. `targetKeys` is the anchor SET — order and duplicates do not
 * matter, and an empty array is the project-wide thread.
 */
export const planSessionSchema = z.object({
  id: z.string(),
  targetKeys: z.array(workItemKeySchema),
  turnCount: z.number().int(),
  lastJobId: z.string().nullable(),
  lastSubmittedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  turns: z.array(planTurnSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// The activity stream (11.7.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One side of a change, in its DISPLAY form.
 *
 * The service ships DATA, not prose — a typed value the client turns into a
 * sentence — which is why the web app and the terminal can word the same change
 * differently without the server knowing either wording.
 */
export const activityValueSchema = z.union([
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('status'), key: z.string(), label: z.string().nullable() }),
  z.object({ type: z.literal('user'), userId: z.string(), name: z.string().nullable() }),
  z.object({ type: z.literal('date'), date: z.string() }),
  z.object({ type: z.literal('sprint'), sprintId: z.string(), name: z.string().nullable() }),
  z.object({ type: z.literal('issue'), workItemKey: workItemKeySchema.nullable() }),
]);

/** One renderable piece of a history entry. */
export const activityPartSchema = z.union([
  z.object({ kind: z.literal('created') }),
  z.object({ kind: z.literal('archived') }),
  z.object({ kind: z.literal('unarchived') }),
  z.object({
    kind: z.literal('field'),
    field: z.string(),
    from: activityValueSchema,
    to: activityValueSchema,
  }),
  /** The trail records THAT a body field changed, never its text. */
  z.object({ kind: z.literal('fieldEdited'), field: z.string() }),
  z.object({
    kind: z.literal('link'),
    op: z.enum(['added', 'removed']),
    linkKind: z.string(),
    target: activityValueSchema,
  }),
  z.object({
    kind: z.literal('collection'),
    field: z.string(),
    op: z.enum(['added', 'removed']),
    items: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('commentDeleted'),
    author: activityValueSchema,
    replyCount: z.number().int(),
  }),
  z.object({
    kind: z.literal('generic'),
    key: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
]);

/** One CHANGE-trail entry. `parts` is always ≥1 — a revision whose every diff
 *  key is suppressed produces no entry at all. */
export const activityChangeSchema = z.object({
  id: z.string(),
  changeKind: z.string(),
  changedAt: z.string(),
  actor: z.object({ userId: z.string(), name: z.string().nullable() }),
  parts: z.array(activityPartSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// The close-out mappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The body BOTH close-out writes accept.
 *
 * `sessionBranch` rides in the body on both, and on the bulk close that is a
 * DECISION rather than a convention (ADR Amendment 6 Q1): a session branch is a
 * git ref and routinely contains `/`, a Next.js `[param]` segment does not match
 * one, and `%2F` is normalised away by proxies before the route ever sees it. A
 * body field carries the ref exactly as the caller wrote it.
 *
 * The provenance triple is a SELF-REPORT, so `source` admits only the two
 * self-reportable values — `hosted` is never accepted on this seam.
 */
export const closeOutProvenanceBodySchema = z.object({
  implementationSource: z.enum(['byok', 'manual']).optional(),
  implementationHarness: z.string().min(1).optional(),
  implementationModel: z.string().min(1).optional(),
});

/** `POST /api/v1/work-items/{key}/integration`. */
export const integrationBodySchema = z
  .object({ sessionBranch: z.string().min(1).max(200) })
  .extend(closeOutProvenanceBodySchema.shape)
  .strict();

/** `POST /api/v1/sessions/complete`. */
export const sessionCloseOutBodySchema = z
  .object({ sessionBranch: z.string().min(1).max(200) })
  .extend(closeOutProvenanceBodySchema.shape)
  .strict();

/**
 * `POST /api/v1/work-items/{key}/implementation` — the SAME triple with no
 * branch beside it (MOTIR-2421).
 *
 * ⚠️ `.strict()` is the guard, not a formality: it is what makes a
 * `sessionBranch` sent to this endpoint a 422 rather than a silently ignored
 * field. A caller that reaches for the branch here is reaching for the fix that
 * would unblock dependents without a merge, and it must fail loudly.
 */
export const implementationReportBodySchema = closeOutProvenanceBodySchema.strict();

/**
 * The provenance triple as the SERVICE takes it, or `undefined` when the caller
 * reported none.
 *
 * The `undefined` is load-bearing and is why this is a function rather than a
 * spread at each route: passing a half-built object would stamp `byok` over a
 * hosted run's own record. Omitted → the item's recorded provenance is left
 * exactly as it is.
 *
 * The SAME distinction runs per FIELD (MOTIR-2447): an absent `implementation-
 * Harness` stays absent here rather than becoming an explicit `null`, so the
 * service can tell "I do not know" from "there is none" and leave a field a
 * previous report filled in. Writing `?? null` here is what let the close-out —
 * which knows only that the work was BYOK — erase the agent and model the run
 * had already recorded.
 */
export function toProvenanceInput(body: {
  implementationSource?: 'byok' | 'manual';
  implementationHarness?: string;
  implementationModel?: string;
}): { source?: 'byok' | 'manual'; harness?: string | null; model?: string | null } | undefined {
  if (
    body.implementationSource === undefined &&
    body.implementationHarness === undefined &&
    body.implementationModel === undefined
  ) {
    return undefined;
  }
  return {
    ...(body.implementationSource === undefined ? {} : { source: body.implementationSource }),
    ...(body.implementationHarness === undefined ? {} : { harness: body.implementationHarness }),
    ...(body.implementationModel === undefined ? {} : { model: body.implementationModel }),
  };
}

export type V1IntegrationResult = z.infer<typeof integrationResultSchema>;
export type V1ImplementationReport = z.infer<typeof implementationReportSchema>;
export type V1SessionCloseOut = z.infer<typeof sessionCloseOutSchema>;

/** What `markIntegrated` returns, shaped for the wire — field by field. */
export function presentIntegrationResult(item: {
  identifier: string;
  status: string;
  sessionBranch: string | null;
  updatedAt: string;
  implementationSource: 'hosted' | 'byok' | 'manual' | null;
  implementationHarness: string | null;
  implementationModel: string | null;
}): V1IntegrationResult {
  return {
    key: item.identifier,
    status: item.status,
    sessionBranch: item.sessionBranch,
    updatedAt: item.updatedAt,
    // `hosted` cannot be reported on this seam, but it CAN already be on the row
    // (a hosted run stamped it), so the wire shape has to be able to say so. The
    // BODY's enum is the narrow one; this is the read-back.
    implementationSource: item.implementationSource === 'hosted' ? null : item.implementationSource,
    implementationHarness: item.implementationHarness,
    implementationModel: item.implementationModel,
  };
}

/**
 * What `reportImplementation` returns, shaped for the wire (MOTIR-2421).
 *
 * The same fields as the integration read-back and deliberately so: the two
 * operations differ in what they ASSERT, not in what they report, and a caller
 * that has just recorded provenance either way reads one shape. `sessionBranch`
 * rides along unchanged, which is what lets a client see that this call left it
 * alone.
 */
export function presentImplementationReport(item: {
  identifier: string;
  status: string;
  sessionBranch: string | null;
  updatedAt: string;
  implementationSource: 'hosted' | 'byok' | 'manual' | null;
  implementationHarness: string | null;
  implementationModel: string | null;
}): V1ImplementationReport {
  return presentIntegrationResult(item);
}

/**
 * What the bulk close returns — the per-item outcomes, verbatim.
 *
 * ⚠️ The per-item result IS the payload. A branch with a dozen items can
 * legitimately close nine and skip three, and that is neither a failure nor a
 * uniform success: the underlying write deliberately does not roll back the nine.
 * Nothing here collapses the list into a count or a boolean, and a client reports
 * what came back rather than re-deriving an outcome from a length.
 */
export function presentSessionCloseOut(result: {
  sessionBranch: string;
  results: { key: string; outcome: 'completed' | 'already_done' | 'failed'; reason?: string }[];
}): V1SessionCloseOut {
  return {
    sessionBranch: result.sessionBranch,
    results: result.results.map((item) => ({
      key: item.key,
      outcome: item.outcome,
      // Present only on `failed` — an `undefined` here is an absent key on the
      // wire, which is what the schema declares.
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan mappers (11.7.5)
// ─────────────────────────────────────────────────────────────────────────────

export type V1PlanOutcome = z.infer<typeof planOutcomeSchema>;

/**
 * Turn the page's resolved references into the `keyOfId` {@link presentPlan}
 * takes.
 *
 * A tiny function rather than a closure in the route, because its THREE states
 * are the whole §7 story and each deserves a test: an id the read returned
 * nothing for (deleted, or cross-workspace), one it returned as NOT accessible
 * (it exists, in a project this caller may not browse), and one it resolved. The
 * first two both become `undefined` → `null` on the wire; neither ever leaks the
 * cuid, and the second is the arm a route-level closure would leave untested.
 */
export function planTargetKeyResolver(
  refs: Readonly<Record<string, { accessible: boolean; identifier?: string }>>,
): (id: string) => string | undefined {
  return (id) => {
    const ref = refs[id];
    if (ref === undefined || !ref.accessible) return undefined;
    return ref.identifier;
  };
}
export type V1Plan = z.infer<typeof planSchema>;

/** The job handle both 202 endpoints return. */
export function presentPlanJobHandle(result: { jobId: string; planId: string }): V1PlanJobHandle {
  return {
    jobId: result.jobId,
    planId: result.planId,
    statusUrl: planStatusUrl(result.planId),
  };
}

/**
 * What became of a submitted job — field by field.
 *
 * `projectId` is DROPPED rather than mapped: it is an internal cuid, and §7's
 * rule is that an identifier on the wire is the one a user sees. A caller who
 * asked about this plan already knows which project it asked in.
 */
export function presentPlanOutcome(outcome: PlanOutcomeDto): V1PlanOutcome {
  return {
    planId: outcome.planId,
    status: outcome.status,
    origin: outcome.origin,
    jobId: outcome.jobId,
    // RENAMED from the DTO's `itemCount`: "item" means WORK ITEM everywhere else
    // on this API, and a client reading `itemCount` off a plan would reasonably
    // believe that many work items exist. None do until the plan is approved.
    proposalCount: outcome.itemCount,
    createdAt: outcome.createdAt,
    plannedAt: outcome.plannedAt,
    decidedAt: outcome.decidedAt,
    job:
      outcome.job === null
        ? null
        : {
            status: outcome.job.status,
            reachable: outcome.job.reachable,
            failure:
              outcome.job.failure === null
                ? null
                : { code: outcome.job.failure.code, message: outcome.job.failure.message },
          },
  };
}

/**
 * A plan WITH its proposals — field by field, and NEVER a cuid.
 *
 * `workItemId` on a `modify` / `remove` is the internal id, which §7 forbids on
 * the wire; `keyOfId` resolves it to the `MOTIR-<n>` a client can act on. An id
 * that does not resolve — a deleted target, or one in a project this caller may
 * not browse — becomes `null` rather than leaking the cuid, exactly as
 * `presentWorkItemRef` degrades an unresolvable parent.
 *
 * An `add`'s target is `null` because no work item exists yet, and THAT null is
 * the contract: it is how a client tells a proposal from a work item without
 * reading prose.
 */
export function presentPlan(
  plan: PlanWithItemsDto,
  keyOfId: (id: string) => string | undefined,
  foldersByPlanItemId: ReadonlyMap<
    string,
    { folderId: string; folderPath: string[] | null }
  > = new Map(),
  cost?: PlanJobCostDto,
): V1Plan {
  return {
    id: plan.id,
    status: plan.status,
    origin: plan.origin,
    title: plan.title,
    summary: plan.summary,
    sourceJobId: plan.sourceJobId,
    proposalCount: plan.itemCount,
    createdAt: plan.createdAt,
    plannedAt: plan.plannedAt,
    decidedAt: plan.decidedAt,
    proposals: plan.items.map((item) => ({
      id: item.id,
      op: item.op,
      workItemKey: item.workItemId === null ? null : (keyOfId(item.workItemId) ?? null),
      proposedFields:
        item.proposedFields === null ? null : presentProposedFields(item.proposedFields),
      patch: item.patch === null ? null : { ...item.patch },
      parentRef: item.parentRef,
      // The same resolver, over the same id space — a temp-ref is not an id and
      // resolves to null, which is the honest answer rather than a guess.
      parentKey:
        committedRefId(item.parentRef) === null ? null : (keyOfId(item.parentRef!) ?? null),
      folderId: foldersByPlanItemId.get(item.id)?.folderId ?? null,
      folderPath: foldersByPlanItemId.get(item.id)?.folderPath ?? null,
      blockedByRefs: item.blockedByRefs,
    })),
    // Only when the caller read it: absent, not a block of nulls, otherwise.
    ...(cost ? { cost: presentPlanJobCost(cost) } : {}),
  };
}

/** The intra-plan temp-ref prefix — a ref naming another `add` on THIS plan
 *  rather than a committed work item. */
const PLAN_ITEM_REF_PREFIX = 'planItem:';

/** A ref naming a FOLDER as the placement (MOTIR-5414) — never a work item. */
const FOLDER_REF_PREFIX = 'folder:';

/**
 * A ref that names a COMMITTED work item, or `null`.
 *
 * The one place the three shapes of a ref are told apart, so the presenter and
 * the routes that pre-resolve ids cannot disagree about which of them is an id.
 */
function committedRefId(ref: string | null): string | null {
  if (ref === null || ref === '') return null;
  // A `folder:<id>` (MOTIR-5415) names a folder, not a work item — it has no key
  // and is resolved into `folderId` / `folderPath` instead.
  return ref.startsWith(PLAN_ITEM_REF_PREFIX) || ref.startsWith(FOLDER_REF_PREFIX) ? null : ref;
}

/**
 * Every work-item id a plan's proposals REFERENCE — targets and parents both.
 *
 * The batched, view-gated `resolveReferenceSummaries` read each plan-returning
 * route makes takes this list, so the three of them resolve the same id space
 * rather than each collecting its own (MOTIR-4085 added the parent half, and a
 * per-route copy is how one route would keep the old one).
 */
export function planReferenceIds(plan: PlanWithItemsDto): string[] {
  const ids = new Set<string>();
  for (const item of plan.items) {
    if (item.workItemId !== null) ids.add(item.workItemId);
    const parent = committedRefId(item.parentRef);
    if (parent !== null) ids.add(parent);
  }
  return [...ids];
}

/** An `add`'s proposed values — shaped explicitly, so a field the planner starts
 *  sending for an internal reason does not become public API by accident. */
function presentProposedFields(
  fields: PlanItemProposedFields,
): z.infer<typeof planProposalFieldsSchema> {
  return {
    title: fields.title,
    kind: fields.kind ?? null,
    type: fields.type ?? null,
    priority: fields.priority ?? null,
    executor: fields.executor ?? null,
    storyPoints: fields.storyPoints ?? null,
    estimateMinutes: fields.estimateMinutes ?? null,
    descriptionMd: fields.descriptionMd ?? null,
    targetRepo: fields.targetRepo ?? null,
    // The steps, normalized row by row so the wire shape is TOTAL: every optional
    // member of a stored row becomes an explicit `null` rather than an absent
    // key, which is what lets a generated client type them as nullable rather
    // than optional (the same discipline every field above it follows).
    todos:
      fields.todos?.map((todo) => ({
        text: todo.text,
        notesMd: todo.notesMd ?? null,
        commandText: todo.commandText ?? null,
        executor: (todo.executor ?? null) as 'coding_agent' | 'human' | null,
      })) ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The planning conversation (11.7.6)
// ─────────────────────────────────────────────────────────────────────────────

export type V1PlanSession = z.infer<typeof planSessionSchema>;

/**
 * The optional ANCHOR SET, on all three conversation endpoints.
 *
 * It rides in the BODY (ADR Amendment 6 Q1) because it is a SET whose order and
 * duplicates do not matter — `buildScope` dedupes and sorts before deriving the
 * thread's key — and a repeated query parameter would encode it as an ordered
 * list, so two spellings of one thread would look different at the edge before
 * the service normalised them.
 *
 * Omitted or empty means the PROJECT-WIDE thread.
 *
 * `sessionId` (MOTIR-6028; AMENDMENT 17 §2) names ONE conversation — the `id`
 * a previous call on this resource returned. A scope now holds many sessions
 * over time, so the id is how a client keeps talking to the same one. OPTIONAL:
 * without it the caller's resumable session for the scope is used (or, on the
 * first turn, a new one starts), which is what every client built before the id
 * existed already does.
 */
const planSessionIdField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'The `id` of the planning session to address, as a previous call returned it. ' +
      'Omit to use your resumable session for the scope (or start one with a turn).',
  );

export const planSessionScopeBodySchema = z
  .object({ targetKeys: z.array(z.string().min(1)).optional(), sessionId: planSessionIdField })
  .strict();

/** `POST …/plan-session/turns` — the scope, plus what to say. */
export const planTurnBodySchema = z
  .object({
    targetKeys: z.array(z.string().min(1)).optional(),
    sessionId: planSessionIdField,
    /** What you want changed about the plan. */
    body: z.string().min(1),
  })
  .strict();

/** Map the thread to the wire — field by field, never a spread. */
export function presentPlanSession(session: {
  id: string;
  targetKeys: string[];
  turnCount: number;
  lastJobId: string | null;
  lastSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  turns: {
    id: string;
    seq: number;
    role: 'user' | 'system' | 'assistant';
    body: string;
    jobId: string | null;
    question: string | null;
    isAnswer: boolean;
    authorId: string | null;
    createdAt: string;
  }[];
}): V1PlanSession {
  return {
    id: session.id,
    targetKeys: session.targetKeys,
    turnCount: session.turnCount,
    lastJobId: session.lastJobId,
    lastSubmittedAt: session.lastSubmittedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: session.turns.map((turn) => ({
      id: turn.id,
      seq: turn.seq,
      role: turn.role,
      body: turn.body,
      jobId: turn.jobId,
      question: turn.question,
      isAnswer: turn.isAnswer,
      authorId: turn.authorId,
      createdAt: turn.createdAt,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The activity stream (11.7.7)
// ─────────────────────────────────────────────────────────────────────────────

/** The three views, mirroring the product's own Activity tabs. */
export const ACTIVITY_VIEWS = ['all', 'comments', 'history'] as const;
export type V1ActivityView = (typeof ACTIVITY_VIEWS)[number];

/** Which collection an activity cursor is scoped to — ONE PER VIEW. */
export const ACTIVITY_COLLECTION: Record<V1ActivityView, V1Collection> = {
  all: 'workItemActivityAll',
  comments: 'workItemActivityComments',
  history: 'workItemActivityHistory',
};

/**
 * ONE entry, in ONE representation, whichever view produced it.
 *
 * The three views are not three endpoints and not three shapes: `comments`
 * yields only `comment` entries, `history` only `change` entries, and `all` both
 * INTERLEAVED — so a client writes one renderer and switches on `type`, exactly
 * as the product's own Activity section does.
 *
 * The comment side reuses 11.2's `commentThreadSchema` verbatim rather than
 * declaring a second comment shape: `GET …/comments` and `?view=comments` read
 * the same service, and one declaration is what stops them from ever disagreeing.
 */
export const activityEntrySchema = z.union([
  z.object({ type: z.literal('comment'), comment: commentThreadSchema }),
  z.object({ type: z.literal('change'), change: activityChangeSchema }),
]);
export type V1ActivityEntry = z.infer<typeof activityEntrySchema>;

/**
 * The activity page's PER-SOURCE totals, beside the envelope's `totalCount`
 * (ADR Amendment 15).
 *
 * The `all` view merges two streams, and "how many are there" has two answers
 * for it. `totalCount` keeps meaning what it means on every other ranked page —
 * the whole view's size, here the sum — and these two say what it is made of.
 *
 * ⚠️ NULLABLE, and the null is load-bearing: it means **this view did not count
 * that source**, which is different from counting it and finding none. The
 * single-kind views each populate the one they actually counted and null the
 * other — `comments` knows its comment total and nothing about changes, and
 * `history` the reverse. Reporting `0` there would state, falsely, that the
 * item has no changes.
 */
export const activityTotalsSchema = z.object({
  /** Every comment on the item, replies included — `null` on the `history` view. */
  totalComments: z.number().int().nonnegative().nullable(),
  /** Displayable revisions in the whole trail — `null` on the `comments` view. */
  totalChanges: z.number().int().nonnegative().nullable(),
});
export type V1ActivityTotals = z.infer<typeof activityTotalsSchema>;

/** Map ONE history entry to the wire — field by field, never a spread. */
export function presentActivityChange(entry: {
  id: string;
  changeKind: string;
  changedAt: string;
  actor: { userId: string; name: string | null };
  parts: unknown[];
}): z.infer<typeof activityChangeSchema> {
  return {
    id: entry.id,
    changeKind: entry.changeKind,
    changedAt: entry.changedAt,
    actor: { userId: entry.actor.userId, name: entry.actor.name },
    parts: entry.parts.map(presentActivityPart),
  };
}

/**
 * ONE renderable piece of a change.
 *
 * ⚠️ LOOSE ON PURPOSE, and this is the card's real constraint. A published
 * client meets NEWER servers: a part kind — or a value type inside one — that
 * this schema does not know must come back in its GENERIC form rather than fail
 * the read, because a client that 500s on a part it has never seen cannot be
 * fixed by upgrading the server. So an unrecognised kind is projected onto
 * `generic`, which every client already has to render.
 */
function presentActivityPart(part: unknown): z.infer<typeof activityPartSchema> {
  const p = part as Record<string, unknown>;
  switch (p['kind']) {
    case 'created':
    case 'archived':
    case 'unarchived':
      return { kind: p['kind'] };
    case 'field':
      return {
        kind: 'field',
        field: String(p['field']),
        from: presentActivityValue(p['from']),
        to: presentActivityValue(p['to']),
      };
    case 'fieldEdited':
      return { kind: 'fieldEdited', field: String(p['field']) };
    case 'link':
      return {
        kind: 'link',
        op: p['op'] === 'removed' ? 'removed' : 'added',
        linkKind: String(p['linkKind']),
        target: presentActivityValue(p['target']),
      };
    case 'collection':
      return {
        kind: 'collection',
        field: String(p['field']),
        op: p['op'] === 'removed' ? 'removed' : 'added',
        items: Array.isArray(p['items']) ? p['items'].map(String) : [],
      };
    case 'commentDeleted':
      return {
        kind: 'commentDeleted',
        author: presentActivityValue(p['author']),
        replyCount: typeof p['replyCount'] === 'number' ? p['replyCount'] : 0,
      };
    default:
      // Every unknown kind, INCLUDING the DTO's own `generic`, lands here — the
      // one branch a client is guaranteed to be able to render.
      return {
        kind: 'generic',
        key: typeof p['key'] === 'string' ? p['key'] : String(p['kind'] ?? 'unknown'),
        from: typeof p['from'] === 'string' ? p['from'] : null,
        to: typeof p['to'] === 'string' ? p['to'] : null,
      };
  }
}

/** One side of a change, in its display form — same loose contract. */
function presentActivityValue(value: unknown): z.infer<typeof activityValueSchema> {
  const v = (value ?? {}) as Record<string, unknown>;
  switch (v['type']) {
    case 'text':
      return { type: 'text', text: String(v['text']) };
    case 'status':
      return {
        type: 'status',
        key: String(v['key']),
        label: typeof v['label'] === 'string' ? v['label'] : null,
      };
    case 'user':
      return {
        type: 'user',
        userId: String(v['userId']),
        name: typeof v['name'] === 'string' ? v['name'] : null,
      };
    case 'date':
      return { type: 'date', date: String(v['date']) };
    case 'sprint':
      return {
        type: 'sprint',
        sprintId: String(v['sprintId']),
        name: typeof v['name'] === 'string' ? v['name'] : null,
      };
    case 'issue':
      // §7: a work item is named by its KEY. The DTO also carries the internal
      // `workItemId`, which is DROPPED — an identifier the read could not
      // resolve becomes `null` rather than a cuid on the wire.
      return {
        type: 'issue',
        workItemKey: typeof v['identifier'] === 'string' ? v['identifier'] : null,
      };
    default:
      // An unknown value type degrades to `none`, the empty side every renderer
      // already handles — never a validation failure.
      return { type: 'none' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The DISPATCH RUN ingest (Story MOTIR-1789 · Subtask MOTIR-1792)
//
// The WRITE half of the run seam, specified by
// `docs/decisions/dispatch-run-record.md`. Three operations — open with the SET,
// append events, close — shaped for a TRANSPORT rather than for the CLI that is
// their first caller, so 9.1.7's hosted orchestrator later becomes a second
// caller with `origin: "hosted"` and nothing else changes.
//
// ⚠️ EVERY VOCABULARY BELOW IS CLOSED, and each one is the ADR's, enumerated
// from the shipped CLI lifecycle at `origin/main` 435bce9bd. They are declared
// here as `z.enum` literals rather than derived from the Prisma enums because
// this is the WIRE: a value reaching the document is a value the contract has
// promised, and deriving it from the schema would let a migration publish a new
// member without a contract-version bump.
// ─────────────────────────────────────────────────────────────────────────────

/** Which CLI command opened the run. `fix` (MOTIR-5464) is opened by the server's
 *  repair claim, never by `openDispatchRun` from a client that knows the others.
 *  `review` (MOTIR-6818, contract 1.56.0) is a hosted REVIEW run the server opens
 *  for an `agent_review` gate (`hosted-agent-run.md` §8). */
export const dispatchCommandSchema = z.enum([
  'next',
  'run',
  'run_scope',
  'batch',
  'auto',
  'fix',
  'continue',
  'review',
]);

/**
 * WHERE the run executed — the discriminator that lets one record serve every
 * writer. `instance` (MOTIR-7023, `agent-instance-run.md` §5) is a run in one of
 * the developer's own agents; `agentInstance` on the run names it.
 */
export const dispatchRunOriginSchema = z.enum(['local', 'hosted', 'instance']);

/**
 * The origins a client may OPEN a run with. `instance` is REFUSED here: only the
 * server opens a run in an agent (MOTIR-7023), exactly as only the server opens
 * the hosted runs it supervises (`hosted-agent-run.md` §3) — a body naming it is
 * a 400 and opens nothing.
 */
export const dispatchRunIngestOriginSchema = dispatchRunOriginSchema.exclude(['instance']);

/** The run header's own state. `timed_out` is written only by the reap. */
export const dispatchRunStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

/** Why the run ended. */
export const dispatchStopReasonSchema = z.enum([
  'drained',
  'completed',
  'max',
  'halted',
  'interrupted',
  'replanned',
  'gated',
  'abandoned',
]);

/** A LEG's state. */
export const dispatchCardDispositionSchema = z.enum([
  'queued',
  'running',
  'integrated',
  'implemented',
  'failed',
  'replanned',
  'skipped',
  'not_reached',
]);

/** Why a card was left out. */
export const dispatchSkipReasonSchema = z.enum([
  'needs_planning',
  'needs_human',
  'claim_refused',
  'blocked_in_scope',
  'integrated_dep',
  'replan_submitted',
  'checkout_unavailable',
]);

/** The ordered stream's vocabulary — six RUN-scoped, thirteen CARD-scoped. */
/**
 * The event kinds a CLIENT may REPORT — deliberately NOT every member of
 * `DispatchEventKind`.
 *
 * ⚠️ `bug_filed`, `plan_submitted` and `unbuildable_reported` are ABSENT ON
 * PURPOSE (MOTIR-3981 / MOTIR-6282, `run-findings-protocol.md` Q5). Those are
 * written server-side, by the service that files the bug, produces the plan or
 * concludes the run-found report, because the ids and the verdict exist only
 * there. Accepting them here would let any client with a run token FORGE a
 * finding — assert that a run produced a bug it never produced — and the whole
 * value of the record is that it says what actually happened. The schema is the
 * enforcement: `.strict()` plus this list refuses the kind outright.
 *
 * So this list grows when the CLI learns to report something new, and NOT when
 * the enum does. A member added to the schema does not belong here by default.
 */
export const dispatchEventKindSchema = z.enum([
  'run_opened',
  'scope_claimed',
  'snapshot_frozen',
  'session_pr',
  'plan_approved',
  'run_closed',
  'card_claimed',
  'card_skipped',
  'checkout_ready',
  'prompt_issued',
  'agent_started',
  'agent_exited',
  'leg_verdict',
  'delivery_linked',
  'ci_verdict',
  'ci_fix_attempt',
  'ci_gave_up',
  'card_settled',
  'log',
]);

/** One LEG on the wire. */
export const dispatchRunCardSchema = z.object({
  id: z.string(),
  /** The card's key. It SURVIVES the work item's deletion; `workItemId` does not. */
  key: workItemKeySchema.nullable(),
  workItemId: z.string().nullable(),
  /** The run's OWN order. Never re-derive it from a dependency graph. */
  position: z.number().int(),
  disposition: dispatchCardDispositionSchema,
  /** Non-null exactly when `disposition === "skipped"`. */
  skipReason: dispatchSkipReasonSchema.nullable(),
  sessionBranch: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  /**
   * The agent's self-reported model for THIS leg (MOTIR-7502), null when it
   * reported none. Read rule: the leg's model, else the run's `model`.
   */
  model: z.string().nullable(),
});

/** The run HEADER with its SET. */
export const dispatchRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  command: dispatchCommandSchema,
  origin: dispatchRunOriginSchema,
  scopeWorkItemId: z.string().nullable(),
  /** What the CLI printed for the scope. Survives the scope card's deletion. */
  scopeLabel: z.string().nullable(),
  status: dispatchRunStatusSchema,
  stopReason: dispatchStopReasonSchema.nullable(),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  /**
   * When the run last said it was alive (MOTIR-6528). Null for a run whose CLI
   * never heartbeats and for every hosted run, whose liveness is its supervision.
   */
  lastHeartbeatAt: z.string().datetime().nullable(),
  createdById: z.string().nullable(),
  /**
   * The developer's own agent the run executed in (MOTIR-7023) — its name and its
   * coding agent. Null for every `local` and `hosted` run.
   */
  agentInstance: z
    .object({
      id: z.string(),
      /** The agent's own name. */
      name: z.string(),
      /** The sandbox profile id (`claude`, `codex`, …). */
      profile: z.string(),
      /** The profile's display name (`Claude Code`). */
      profileLabel: z.string(),
    })
    .nullable(),
  /** The run's cards, in the run's own stored order. */
  cards: z.array(dispatchRunCardSchema),
  /** The stream's highest `seq`, or `0` — the cursor to resume from. */
  seq: z.number().int(),
  /**
   * What a `continue` run resumes (MOTIR-6795) — only on `getDispatchRun`, and
   * null there for any other command.
   */
  continues: z
    .object({
      fromRunId: z.string().nullable(),
      branch: z.string().nullable(),
      branches: z.array(
        z.object({
          repository: z.string().nullable(),
          branch: z.string(),
          cloneUrl: z.string().nullable(),
        }),
      ),
      mode: z.enum(['card', 'parent']),
      landedKeys: z.array(z.string()),
      resumedKeys: z.array(z.string()),
    })
    .nullable()
    .optional(),
  /**
   * What a HOSTED `fix` run repairs (MOTIR-6929) — only on `getDispatchRun`, and
   * null there for any other command and for a local repair.
   */
  repair: z
    .object({
      repairClass: z.enum(['ci', 'acceptance_rerun', 'review']),
      title: z.string().nullable(),
      pullRequests: z.array(
        z.object({
          repo: z.string(),
          number: z.number().int(),
          url: z.string(),
          branch: z.string(),
          baseRef: z.string().nullable(),
          headSha: z.string().nullable(),
        }),
      ),
      resume: z
        .object({
          profile: z.string(),
          sessionId: z.string().nullable(),
          canResume: z.boolean(),
        })
        .nullable()
        .optional(),
      findings: z
        .object({
          gate: z.enum(['agent_review', 'pull_request_approval']),
          gateId: z.string().nullable(),
          subjectVersion: z.string().nullable(),
          findingsMd: z.string().nullable(),
          reviewerName: z.string().nullable(),
          decidedByLabel: z.string().nullable(),
          decidedUnderAuthority: z.string().nullable(),
          decidedAt: z.string(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
});

/** What OPEN answers with. */
export const dispatchRunOpenedSchema = z.object({
  run: dispatchRunSchema,
  /** `false` when the same `idempotencyKey` had already opened this run. */
  created: z.boolean(),
});

/** What APPEND answers with. */
export const dispatchRunAppendedSchema = z.object({
  runId: z.string(),
  appended: z.number().int(),
  /** The run's new highest `seq` — the cursor for the next append. */
  seq: z.number().int(),
  /** Every leg this batch moved, so the caller need not re-read the run. */
  cards: z.array(dispatchRunCardSchema),
});

/**
 * What `POST /api/v1/dispatch-runs/{id}/git-credential` answers (MOTIR-6538,
 * `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5): the run's git
 * credentials, ONE ENTRY PER REPOSITORY of the run. Repositories written through
 * one App installation share a token. The author is that App's bot — never the
 * dispatcher, who is named only as `dispatchedBy`, for pull-request bodies.
 *
 * ⚠️ `token` is a live secret. It is answered to the run's own credential only,
 * and nothing may log or echo it.
 */
export const dispatchRunGitCredentialsSchema = z.object({
  credentials: z.array(
    z.object({
      /** `owner/name`. */
      repository: z.string(),
      token: z.string(),
      /** ISO-8601; GitHub's own expiry, one hour from the mint. */
      expiresAt: z.string(),
      authorName: z.string(),
      authorEmail: z.string(),
    }),
  ),
  /** The dispatcher's Motir display name, or `null` when the run has none. */
  dispatchedBy: z.string().nullable(),
});

/**
 * One card in the SET a run is opened with.
 *
 * ⚠️ THE PAIRING IS REFUSED AT THE EDGE, IN BOTH DIRECTIONS, and it mirrors the
 * database's own CHECK constraint rather than restating a convention: a skip
 * with no reason is the one row on a run page that says nothing, and a reason on
 * a card that was not skipped reads as a skip to anyone scanning the column.
 */
export const dispatchRunCardInputSchema = z
  .object({
    key: workItemKeySchema,
    disposition: dispatchCardDispositionSchema.extract(['queued', 'skipped']).default('queued'),
    skipReason: dispatchSkipReasonSchema.optional(),
  })
  .strict()
  .refine((c) => (c.disposition === 'skipped') === (c.skipReason !== undefined), {
    message: '`skipReason` is required when `disposition` is "skipped", and forbidden otherwise',
    path: ['skipReason'],
  });

export const dispatchRunOpenBodySchema = z
  .object({
    /** The project this run works in. Case-insensitive. */
    projectKey: z.string().min(1).max(64),
    command: dispatchCommandSchema,
    origin: dispatchRunIngestOriginSchema.default('local'),
    /** The container or sprint-bearing card the run was pointed at. */
    scopeKey: workItemKeySchema.optional(),
    /** What the CLI printed for the scope, e.g. "the active sprint". */
    scopeLabel: z.string().max(200).optional(),
    agent: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    /** Supplied by the caller so a retried open is ONE run, not two. */
    idempotencyKey: z.string().min(1).max(200).optional(),
    /**
     * THE SET, IN THE RUN'S OWN ORDER — every card this run owns, including the
     * ones it has already decided to skip. `position` is the array index.
     *
     * ⚠️ It is settled HERE because this is the one moment it exists: a scope
     * claim has just returned its members, or a batch snapshot has just been
     * frozen. Rebuilt afterwards from per-card events it becomes a list of what
     * the run got round to, and the skipped cards vanish entirely.
     */
    cards: z.array(dispatchRunCardInputSchema).max(500).default([]),
  })
  .strict();
export type V1DispatchRunOpenBody = z.infer<typeof dispatchRunOpenBodySchema>;

/** One event in an append batch. */
export const dispatchRunEventInputSchema = z
  .object({
    kind: dispatchEventKindSchema,
    /** The card this event is about. Omit for a RUN-scoped event. */
    workItemKey: workItemKeySchema.optional(),
    /** Structured detail — the claim outcome, the exit code, the verdict. */
    data: z.unknown().optional(),
    /**
     * The OPT-IN log body (ADR Q4). Sent only when the run was started with
     * `--report-log`; REFUSED rather than truncated when over 16 KiB, because a
     * silently shortened log reads as the whole tail.
     */
    body: z.string().optional(),
    /** The leg's new disposition, applied in the SAME transaction as the event. */
    disposition: dispatchCardDispositionSchema.optional(),
    skipReason: dispatchSkipReasonSchema.optional(),
    sessionBranch: z.string().max(400).optional(),
    exitCode: z.number().int().optional(),
    /**
     * The agent's SELF-REPORTED model (MOTIR-7502), on `agent_exited` ONLY — any
     * other kind carrying it is refused with `DISPATCH_RUN_EVENT_MODEL_NOT_ALLOWED`
     * (422). Null when the agent reported none; never a guess. Written onto the
     * leg when valid; when absent, the server reads `data.model` instead.
     */
    model: z.string().max(200).nullable().optional(),
  })
  .strict();

export const dispatchRunAppendBodySchema = z
  .object({
    /** Batched, because a chatty agent must not cost one request per line. */
    events: z.array(dispatchRunEventInputSchema).min(1).max(200),
  })
  .strict();
export type V1DispatchRunAppendBody = z.infer<typeof dispatchRunAppendBodySchema>;

export const dispatchRunCloseBodySchema = z
  .object({
    stopReason: dispatchStopReasonSchema,
    /**
     * The terminal status. Omit it and the server derives it from the stop
     * reason, which is the mapping every caller would otherwise re-implement
     * differently — `replanned` in particular is a SUCCESS.
     */
    status: dispatchRunStatusSchema.exclude(['running']).optional(),
  })
  .strict();
export type V1DispatchRunCloseBody = z.infer<typeof dispatchRunCloseBodySchema>;

/**
 * A run's CLOSE-OUT prompt (Story MOTIR-4906 · MOTIR-5357) — the text a scoped
 * run hands one agent before marking its pull requests ready, so HOW TO TEST is
 * written onto the run target.
 */
export const dispatchRunCloseOutPromptSchema = z.object({
  runId: z.string(),
  /** The run target — the item the run was launched against. */
  targetKey: workItemKeySchema,
  /** The full prompt text, ready to hand to a coding agent. */
  prompt: z.string(),
  /** The cards the run landed (integrated or implemented), in run order. */
  landedKeys: z.array(workItemKeySchema),
});
export type V1DispatchRunCloseOutPrompt = z.infer<typeof dispatchRunCloseOutPromptSchema>;

/** Map the close-out prompt to the wire — field by field, never a spread. */
export function presentDispatchRunCloseOutPrompt(
  dto: DispatchRunCloseOutPromptDto,
): V1DispatchRunCloseOutPrompt {
  return {
    runId: dto.runId,
    targetKey: dto.targetKey,
    prompt: dto.prompt,
    landedKeys: [...dto.landedKeys],
  };
}

/**
 * A run target's CURRENT How-to-test record (Story MOTIR-4906 · MOTIR-5358) — one
 * per run: its rich-text body, and a section per repository.
 */
export const currentTestInstructionsSchema = z.object({
  key: workItemKeySchema,
  /** Null when no run has written How to test onto this item. */
  record: z
    .object({
      /** The dispatch run that wrote it, when one did. */
      dispatchRunId: z.string().nullable(),
      /**
       * WHO wrote it (MOTIR-5454) — `run` for a dispatch run, `person` for
       * somebody who wrote it from the item page. A person's record carries a
       * null `dispatchRunId`, so this is the field that tells the two apart;
       * `userId` is null when that account has since been deleted, and `label`
       * is never blank.
       */
      author: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('run'), runId: z.string(), label: z.string() }),
        z.object({
          kind: z.literal('person'),
          userId: z.string().nullable(),
          label: z.string(),
        }),
      ]),
      createdAt: z.string(),
      /** The run's How to test as rich text (Markdown), exactly as the agent wrote it. */
      bodyMd: z.string(),
      previewPath: z.string().nullable(),
      repos: z.array(
        z.object({
          /** `owner/name`, or null when the repository is no longer the project's. */
          repo: z.string().nullable(),
          commitSha: z.string(),
        }),
      ),
    })
    .nullable(),
});
export type V1CurrentTestInstructions = z.infer<typeof currentTestInstructionsSchema>;

/** Map the current record to the wire — field by field; the internal ids stay off it. */
export function presentCurrentTestInstructions(
  dto: CurrentTestInstructionsDTO,
): V1CurrentTestInstructions {
  const record = dto.record;
  return {
    key: dto.workItemKey,
    record: record
      ? {
          dispatchRunId: record.dispatchRunId,
          author: record.author,
          createdAt: record.createdAt,
          bodyMd: record.bodyMd,
          previewPath: record.previewPath,
          repos: record.repos.map((section) => ({
            repo: section.repoName,
            commitSha: section.commitSha,
          })),
        }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The CONTINUE CLAIM (Story MOTIR-6526 · MOTIR-6532)
// ─────────────────────────────────────────────────────────────────────────────

/** What a continue claim resolved to. */
export const workItemContinueOutcomeSchema = z.enum([
  'claimed',
  'mine',
  'taken',
  'not_continuable',
]);

/** Why a work item cannot be continued — see `WorkItemContinueRefusal`. */
export const workItemContinueRefusalSchema = z.enum([
  'run_alive',
  'use_fix',
  'not_in_progress',
  'continue_the_parent',
  'no_dead_run',
  'no_branch',
  'gate_awaiting',
  'gate_sent_back',
]);

/**
 * The result of claiming the CONTINUE of a work item whose last run died.
 *
 * ⚠️ **A REFUSAL IS A 200**, as on the repair claim. ⚠️ **THE ITEM'S STATUS IS
 * NEVER WRITTEN** — the claim is an open dispatch run with command `continue`, and
 * that run is the lock; the item is RE-ASSIGNED to the claimant.
 */
const continuePullRequestSchema = z.object({
  /** `owner/name`. */
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  headRef: z.string(),
});

export const workItemContinueClaimSchema = z.object({
  key: workItemKeySchema,
  title: z.string(),
  outcome: workItemContinueOutcomeSchema,
  /** Why the item cannot be continued; null unless `outcome` is `not_continuable`. */
  reason: workItemContinueRefusalSchema.nullable(),
  /** The parent to continue instead; set only with `reason: continue_the_parent`. */
  parentKey: workItemKeySchema.nullable(),
  /** The open `continue` run — set on `claimed`, `mine` and `taken`. Report into it,
   *  heartbeat it, and CLOSE it when the continue ends. */
  runId: z.string().nullable(),
  /** Who holds the item: the `continue` run's opener, or — with `run_alive` — the
   *  live run's dispatcher. */
  holder: actorRefSchema.nullable(),
  /** When the holder's run started. */
  startedAt: z.string().datetime().nullable(),
  /** The run that died — set on `claimed` and `mine`. */
  deadRun: z
    .object({
      id: z.string(),
      command: dispatchCommandSchema,
      origin: dispatchRunOriginSchema,
      status: dispatchRunStatusSchema,
      stopReason: dispatchStopReasonSchema.nullable(),
      /** Its last heartbeat, else its end, else its start. */
      lastHeardAt: z.string().datetime(),
      dispatcher: actorRefSchema.nullable(),
    })
    .nullable(),
  /** The branch to continue on — set on `claimed` and `mine`. The PRIMARY
   *  repository's entry of `branches`. */
  branch: z.string().nullable(),
  /** EVERY repository's branch to continue on, primary first — set on `claimed`
   *  and `mine`, empty otherwise (MOTIR-6791). A run that spanned several
   *  repositories pushed a branch in each. */
  branches: z.array(
    z.object({
      /** The repository's NAME as the item's `targetRepos` names it, or null when
       *  the dead run recorded a branch without saying where. */
      repository: z.string().nullable(),
      branch: z.string(),
      /** The open pull request this repository's branch heads, when there is one. */
      pullRequest: continuePullRequestSchema.nullable(),
    }),
  ),
  /** The open pull request the dead run left, when there is one. */
  pullRequest: continuePullRequestSchema.nullable(),
  /** Who the item was assigned to before this claim took it over. */
  previousAssignee: actorRefSchema.nullable(),
  /** `parent` when the dead run was a SCOPED run over this container: the whole
   *  scope resumes on `branch`, the session branch. */
  mode: z.enum(['card', 'parent']),
  /** The dead scope run's legs already landed — never re-dispatched. */
  landedKeys: z.array(workItemKeySchema),
  /** The dead scope run's legs still in flight — In Progress and now the caller's.
   *  The ready set lists only To Do leaves, so the resumed drain runs these too. */
  resumedKeys: z.array(workItemKeySchema),
  /** The gates of a run that STOPPED AT A GATE (MOTIR-7708): on a resume, the
   *  approved ones it resumes after; with `gate_awaiting` / `gate_sent_back`, the
   *  ones still holding it. Empty for a continue of a run that died. */
  gates: z.array(
    z.object({
      key: workItemKeySchema,
      kind: approvalGateKindSchema,
      state: approvalGateStateSchema,
    }),
  ),
  /** True when this RESUMES a run that stopped at a gate, not one that died. */
  resumesGated: z.boolean(),
});
export type V1WorkItemContinueClaim = z.infer<typeof workItemContinueClaimSchema>;

/** Map the continue claim to the wire — field by field, never a spread. */
export function presentWorkItemContinueClaim(
  dto: WorkItemContinueClaimDto,
): V1WorkItemContinueClaim {
  const ref = (a: { id: string; name: string } | null) =>
    a === null ? null : { id: a.id, name: a.name };
  const pr = (p: WorkItemContinueClaimDto['pullRequest']) =>
    p === null ? null : { repo: p.repo, number: p.number, url: p.url, headRef: p.headRef };
  return {
    key: dto.key,
    title: dto.title,
    outcome: dto.outcome,
    reason: dto.reason,
    parentKey: dto.parentKey,
    runId: dto.runId,
    holder: ref(dto.holder),
    startedAt: dto.startedAt,
    deadRun:
      dto.deadRun === null
        ? null
        : {
            id: dto.deadRun.id,
            command: dto.deadRun.command,
            origin: dto.deadRun.origin,
            status: dto.deadRun.status,
            stopReason: dto.deadRun.stopReason,
            lastHeardAt: dto.deadRun.lastHeardAt,
            dispatcher: ref(dto.deadRun.dispatcher),
          },
    branch: dto.branch,
    branches: dto.branches.map((b) => ({
      repository: b.repository,
      branch: b.branch,
      pullRequest: pr(b.pullRequest),
    })),
    pullRequest: pr(dto.pullRequest),
    previousAssignee: ref(dto.previousAssignee),
    mode: dto.mode,
    landedKeys: [...dto.landedKeys],
    resumedKeys: [...dto.resumedKeys],
    gates: dto.gates.map((g) => ({ key: g.key, kind: g.kind, state: g.state })),
    resumesGated: dto.resumesGated,
  };
}
