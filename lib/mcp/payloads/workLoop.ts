import { z } from 'zod/v4';
import {
  dispatchPromptSchema,
  integrationResultSchema,
  planOutcomeSchema,
  planSchema,
  planSessionSchema,
  presentDispatchPrompt,
  presentPlanJobHandle,
  presentPlanOutcome,
  presentPlanSession,
  presentSessionCloseOut,
  presentWorkItemContinueClaim,
  presentWorkItemRepairClaim,
  planJobHandleSchema,
  sessionCloseOutSchema,
  workItemContinueClaimSchema,
  workItemRepairClaimSchema,
} from '@/lib/api/v1/workLoop/schema';
import { PLANNING_SOURCES } from '@/lib/api/v1/workItems/schema';
import { PLAN_DECISION_REASONS } from '@/lib/dto/plans';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';
import type { WorkItemContinueClaimDto } from '@/lib/dto/workItemContinue';
import type { WorkItemRepairClaimDto } from '@/lib/dto/workItemRepair';
import type { PlanOutcomeDto, PlanWithItemsAndWarningsDto } from '@/lib/dto/plans';
import { redactNativeActor } from '@/lib/plans/redactNativeModel';
import { definePayload } from './define';
import { parsedSectionsSchema } from './parsedSectionsSchema';
import { mcpWorkItemSchema, type McpWorkItem } from './workItems';

// The WORK-LOOP payload shapes (Story 11.6 · Subtask 11.6.5 — MOTIR-2231).
//
// The last family, and the one that only became possible when 11.7 (MOTIR-2208)
// gave these resources a v1 schema to derive from. Six of the eight tools that
// hand-built `structuredContent` live here, so proportionally this is where the
// hand-shaping was densest — and it is the newest half of the surface, which is
// precisely where two independently-written descriptions drift first.
//
// ── The RENAME hazard, and why these are widenings ──────────────────────────
// v1's plan presenters deliberately RENAME as they map: `itemCount` becomes
// `proposalCount` (because "item" means WORK ITEM everywhere else on that API,
// and none exist until a plan is approved), and `items` becomes `proposals`.
// Those renames are right for v1 and they are NOT free here: ADR Amendment 7 Q6
// makes a renamed key a violation, because a client reading the old name would
// silently get `undefined`. So the plan payloads carry BOTH — the v1 name from
// v1's own presenter, and the original beside it. Additive, as the rule requires.

/**
 * The DISPATCH prompt. `DispatchPromptDto` and `dispatchPromptSchema` have the
 * same eight fields, so this derives with no widening and carries a real probe.
 *
 * The advisories are re-shaped per variant by v1's presenter rather than passed
 * through — which is the point of the seam: a field added to
 * `WorkItemProseAdvisoryDto` for an internal consumer cannot reach either
 * surface by accident.
 */
export const dispatchPromptPayload = definePayload({
  schema: dispatchPromptSchema as unknown as z.ZodType<z.infer<typeof dispatchPromptSchema>>,
  probes: [{ resource: 'DispatchPrompt', select: (p) => [p] }],
});

/** Map a dispatch payload — v1's own presenter, unchanged. */
export function presentMcpDispatchPrompt(
  dto: DispatchPromptDto,
): z.infer<typeof dispatchPromptSchema> {
  return presentDispatchPrompt(dto);
}

/**
 * The SESSION close-out. `{ sessionBranch, results: [{ key, outcome, reason? }] }`
 * on both surfaces — they already agreed, so this derives exactly.
 */
export const sessionCloseOutPayload = definePayload({
  schema: sessionCloseOutSchema as unknown as z.ZodType<z.infer<typeof sessionCloseOutSchema>>,
  probes: [{ resource: 'SessionCloseOut', select: (p) => [p] }],
});

/** Map a close-out result — v1's own presenter, unchanged. */
export function presentMcpSessionCloseOut(result: {
  sessionBranch: string;
  results: { key: string; outcome: 'completed' | 'already_done' | 'failed'; reason?: string }[];
}): z.infer<typeof sessionCloseOutSchema> {
  return presentSessionCloseOut(result);
}

/**
 * The JOB HANDLE both submitting tools return.
 *
 * ⚠️ This shape signals "ACCEPTED, not finished" by what it cannot carry — no
 * `items`, no `proposals`, no `count`, no `status`. A client cannot mistake it
 * for a result, and that property is worth more than the two fields it has.
 * `expand_item` and `submit_plan_session` both return it.
 */
export const planJobHandlePayload = definePayload({
  schema: planJobHandleSchema as unknown as z.ZodType<z.infer<typeof planJobHandleSchema>>,
  probes: [{ resource: 'PlanJobHandle', select: (p) => [p] }],
});

/** Map a job handle — v1's own presenter, unchanged. */
export function presentMcpPlanJobHandle(result: {
  jobId: string;
  planId: string;
}): z.infer<typeof planJobHandleSchema> {
  return presentPlanJobHandle(result);
}

/**
 * `submit_plan_session`'s result — the job handle WIDENED with the thread it was
 * submitted from.
 *
 * MCP has always returned the session alongside, and a resumed client re-attaches
 * from its marker turn, so dropping it to match v1's bare handle would be a
 * removal — the one thing ADR Amendment 7 Q6 does not permit. v1's endpoint
 * answers with the handle alone, which is right for a caller that will poll;
 * the overlap is still one schema, and the probe asserts it.
 */
export const mcpPlanSubmitSchema = planJobHandleSchema.extend({
  session: planSessionSchema,
});
export type McpPlanSubmit = z.infer<typeof mcpPlanSubmitSchema>;

/** Map a submit result — both halves through v1's own presenters. */
export function presentMcpPlanSubmit(result: {
  jobId: string;
  planId: string;
  session: Parameters<typeof presentPlanSession>[0];
}): McpPlanSubmit {
  return {
    ...presentPlanJobHandle(result),
    session: presentPlanSession(result.session),
  };
}

/** The `submit_plan_session` payload. */
export const planSubmitPayload = definePayload({
  schema: mcpPlanSubmitSchema as unknown as z.ZodType<McpPlanSubmit>,
  probes: [
    { resource: 'PlanJobHandle', select: (p) => [p] },
    { resource: 'PlanSession', select: (p) => [p.session] },
  ],
});

/**
 * A plan's STATUS — v1's `PlanOutcome` widened with the two names the MCP
 * payload already published (`itemCount`, `projectId`).
 *
 * `proposalCount` arrives BESIDE `itemCount`, never instead of it (see the
 * rename note at the top of this module).
 */
export const mcpPlanOutcomeSchema = planOutcomeSchema.extend({
  projectId: z.string(),
  /** The pre-11.6 name for `proposalCount`. Kept so no caller breaks. */
  itemCount: z.number().int(),
});
export type McpPlanOutcome = z.infer<typeof mcpPlanOutcomeSchema>;

/** Map a plan outcome — the shared half through v1's presenter. */
export function presentMcpPlanOutcome(outcome: PlanOutcomeDto): McpPlanOutcome {
  return {
    ...presentPlanOutcome(outcome),
    projectId: outcome.projectId,
    itemCount: outcome.itemCount,
  };
}

/** The `get_plan_status` payload, probed against the shared outcome. */
export const planOutcomePayload = definePayload({
  schema: mcpPlanOutcomeSchema as unknown as z.ZodType<McpPlanOutcome>,
  probes: [{ resource: 'PlanOutcome', select: (p) => [p] }],
});

/**
 * A PLAN with its proposals.
 *
 * A NARROWING of v1's `planSchema` (`.omit({ proposals, proposalCount })`) plus
 * the MCP payload's own `items` / `itemCount`. It is a narrowing rather than a
 * widening for one honest reason: v1's `proposals` carry a `workItemKey`
 * resolved through a `keyOfId` lookup the v1 route performs and this tool does
 * not. Publishing that field here would mean either making a read this tool has
 * never made, or emitting `null` for every proposal that HAS a work item —
 * a field that lies. Neither is a change this card's boundary permits, so the
 * proposal rows stay MCP's own and the divergence is DECLARED here rather than
 * discovered later.
 */
/**
 * One `modify` approve will send back from built work (MOTIR-10106) — the shape
 * `ProposalRescopeWarningDto` carries, on the write doors and `validate_plan`.
 */
export const rescopeWarningSchema = z.object({
  planItemId: z.string(),
  proposal: z.string(),
  workItemId: z.string(),
  identifier: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  outcomes: z.string(),
  fields: z.array(z.enum(['title', 'descriptionMd', 'repository'])),
  message: z.string(),
});

export const mcpPlanSchema = planSchema.omit({ proposals: true, proposalCount: true }).extend({
  projectId: z.string(),
  itemCount: z.number().int(),
  /** Who decided the plan. MCP has always published it; v1 does not. */
  decidedById: z.string().nullable(),
  /**
   * WHO ASKED for the plan and WHO AUTHORED it (Story MOTIR-2982 · MOTIR-2986)
   * — MCP's own fields,
   * and deliberately NOT added to v1's `planSchema`.
   *
   * `docs/decisions/agent-authored-plans.md` Q1: the plan-authoring operations
   * are agent-facing, and MOTIR-2982's scope boundary says the public REST
   * surface's plan operations stay exactly as wide as they are today. Extending
   * HERE rather than upstream is what keeps that true at the SCHEMA, not merely
   * at the route list — `decidedById` directly above is the precedent that this
   * extension point exists for exactly this case.
   *
   * An agent that authored a plan reads its own attribution back; a person's
   * read of the same fact is the Plans surface (MOTIR-2991), not `/api/v1`.
   */
  createdById: z.string().nullable(),
  authorSource: z.enum(PLANNING_SOURCES).nullable(),
  authorHarness: z.string().nullable(),
  authorModel: z.string().nullable(),
  /**
   * WHY a `declined` plan ended (MOTIR-3189) — MCP's own field, on the same
   * extension point and for the same reason as the four above: an agent that
   * authored a plan reads back what became of it, and v1's `planSchema` stays
   * exactly as wide as it is today.
   *
   * It earns its place on THIS surface specifically. `declined` covers three
   * histories, and the one an authoring agent most needs to tell apart is *a
   * person discarded my half-written plan* from *the sweep terminated it
   * because my producer died* — the first is a decision to respect, the second
   * a failure to retry. Null on every other status, and on a `declined` row
   * written before the column existed, where it means *not recorded*.
   *
   * NOT a `PlanStatus` member: that vocabulary IS public and reaches v1, four
   * display switches and the zh-parity gate, and every consumer of the status is
   * asking *is it decided?* (AMENDMENT 6, D3).
   */
  decisionReason: z.enum(PLAN_DECISION_REASONS).nullable(),
  /**
   * The planning SESSION the plan belongs to (MOTIR-6022; AMENDMENT 17 §5) — an
   * MCP-only field on the same extension point as the four above. An agent that
   * authored a plan reads back which conversation it hangs off; `create_plan`
   * opens one of origin `mcp` for it. Null only on a row a pre-session build
   * wrote during a rollout.
   */
  sessionId: z.string().nullable(),
  /**
   * The requirement a Sharpen session SETTLED on the plan (Task MOTIR-1101) —
   * MCP-only, on the same extension point as the fields above. An agent that
   * reads a plan to build or judge it reads what the person settled with it,
   * kept apart from the assumptions the planner marked for what they skipped.
   * Null when nobody has sharpened the plan.
   */
  sharpenedRequirement: z
    .object({
      outcome: z.string().optional(),
      behaviour: z.string().optional(),
      scopeEdge: z.string().optional(),
      constraints: z.string().optional(),
      acceptance: z.string().optional(),
      // A list of recommendations (MOTIR-9160) or the string stored before it.
      assumptions: z
        .union([
          z.string(),
          z.array(z.union([z.string(), z.object({ id: z.string().optional(), text: z.string() })])),
        ])
        .optional(),
      plannerAssumptions: z.array(z.object({ question: z.string(), recommendation: z.string() })),
      settledAt: z.string(),
    })
    .nullable(),
  /**
   * The PLANNER's own record (MOTIR-9978) — machine state the authoring agent
   * keeps on the plan through `update_plan`, as data rather than in the summary.
   * MCP-only, and not on `PlanWithItemsDto` at all, so neither v1 nor the review
   * surface receives it. Present (null when none) on `get_plan` and
   * `update_plan`; absent on the other plan payloads.
   */
  plannerRecord: z.record(z.string(), z.unknown()).nullable().optional(),
  items: z.array(z.unknown()),
  /**
   * The OPTIONAL sections view (MOTIR-9033): each `add` proposal's body parsed at
   * read time, keyed by plan item id. Present only when `includeSections` was asked.
   */
  parsedSections: z.record(z.string(), parsedSectionsSchema).optional(),
  /**
   * The item links a proposal WRITE kept that would ship dead (MOTIR-10104) — on
   * `add_plan_items`, `update_plan_item` and `update_plan_proposal`, present only
   * when the write left at least one. Each names the corrected link when the
   * server can compute it; approve refuses the plan while a malformed one remains.
   */
  warnings: z
    .array(
      z.object({
        planItemId: z.string(),
        proposal: z.string(),
        field: z.enum(['descriptionMd', 'explanationMd']),
        link: z.string(),
        reason: z.string(),
        correctedLink: z.string().nullable(),
        canonicalForms: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  /**
   * The `modify`s a proposal WRITE kept that approve will send back from built work
   * (MOTIR-10106) — present only when the write left at least one. The write is kept;
   * the entry names the card, the status it leaves, what it may land on and the
   * fields that trip it.
   */
  rescopeWarnings: z.array(rescopeWarningSchema).optional(),
});
export type McpPlan = z.infer<typeof mcpPlanSchema>;

/** Map a plan — the shared envelope fields through v1's shape. */
export function presentMcpPlan(
  plan: PlanWithItemsAndWarningsDto,
  folders?: ReadonlyMap<string, { folderId: string; folderPath: string[] | null }>,
): McpPlan {
  return {
    id: plan.id,
    status: plan.status,
    origin: plan.origin,
    title: plan.title,
    summary: plan.summary,
    sourceJobId: plan.sourceJobId,
    createdAt: plan.createdAt,
    plannedAt: plan.plannedAt,
    decidedAt: plan.decidedAt,
    projectId: plan.projectId,
    itemCount: plan.itemCount,
    decidedById: plan.decidedById,
    createdById: plan.createdById,
    authorSource: plan.authorSource,
    authorHarness: plan.authorHarness,
    // Already null for a native author from `toPlanDto`; applied again so the
    // MCP surface holds the rule on its own (MOTIR-7225).
    authorModel: redactNativeActor(plan.authorSource, plan.authorModel),
    decisionReason: plan.decisionReason,
    sessionId: plan.sessionId,
    sharpenedRequirement: plan.sharpenedRequirement,
    // Each proposal carries the folder it NAMES and that folder's path
    // (MOTIR-5415) — `/api/v1`'s `folderId` / `folderPath`, on the same item the
    // `parentRef` rides. Only when the caller resolved them; the fields are then
    // present on every item, `null` where the proposal names no folder.
    items: folders
      ? plan.items.map((item) => ({
          ...item,
          folderId: folders.get(item.id)?.folderId ?? null,
          folderPath: folders.get(item.id)?.folderPath ?? null,
        }))
      : plan.items,
    ...(plan.warnings && plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
    ...(plan.rescopeWarnings && plan.rescopeWarnings.length > 0
      ? { rescopeWarnings: plan.rescopeWarnings }
      : {}),
  };
}

/** The `get_plan` payload. No probe — see the narrowing note above. */
export const planPayload = definePayload({
  schema: mcpPlanSchema as unknown as z.ZodType<McpPlan>,
  probes: [],
});

/**
 * The `add_plan_items` payload — the plan, plus the ids of the proposals THAT
 * CALL created, in append order (Story MOTIR-2982 · MOTIR-2988).
 *
 * A `.extend` of the plan shape above rather than a hand-authored look-alike, so
 * the two stay one shape: everything a caller can read about the plan is the
 * same as what `get_plan` returns, and the ONE addition is the transport fact
 * `get_plan` has no way to know — which of the plan's items this particular
 * append produced.
 *
 * That list is the intra-plan TEMP-REF contract: a caller passes
 * `planItem:<id>` from it as a later batch's `parentRef` / `blockedByRefs`, so a
 * tree arrives layer by layer, parents before children
 * (`docs/decisions/agent-authored-plans.md` Q1).
 */
export const mcpPlanAppendSchema = mcpPlanSchema.extend({
  planItemIds: z.array(z.string()),
});
export type McpPlanAppend = z.infer<typeof mcpPlanAppendSchema>;

/** Map an append result — the plan through the shared shape, plus the new ids. */
export function presentMcpPlanAppend(
  plan: PlanWithItemsAndWarningsDto,
  planItemIds: string[],
): McpPlanAppend {
  return { ...presentMcpPlan(plan), planItemIds };
}

export const planAppendPayload = definePayload({
  schema: mcpPlanAppendSchema as unknown as z.ZodType<McpPlanAppend>,
  probes: [],
});

/** A planning CONVERSATION — v1's `PlanSession`, which the MCP payload matches. */
export const planSessionPayload = definePayload({
  schema: planSessionSchema as unknown as z.ZodType<z.infer<typeof planSessionSchema>>,
  probes: [{ resource: 'PlanSession', select: (p) => [p] }],
});

/** Map a plan session — v1's own presenter, unchanged. */
export function presentMcpPlanSession(
  session: Parameters<typeof presentPlanSession>[0],
): z.infer<typeof planSessionSchema> {
  return presentPlanSession(session);
}

/**
 * The ACTIVITY page.
 *
 * The ENVELOPE stays MCP's own — including the `all` view's cursor, which is an
 * OPAQUE COMPOSITE over two sources on both surfaces. Nothing here describes it
 * in a way that would invite a client to construct, parse or merge one; it is a
 * string the server issued and the client hands back.
 */
export const activityPagePayload = definePayload({
  schema: z
    .object({ nextCursor: z.string().nullable() })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { nextCursor: string | null } & Record<string, unknown>
  >,
  probes: [],
});

/**
 * `mark_integrated`'s result.
 *
 * The tool returns the whole `WorkItemDto`, so the payload REUSES the work-item
 * write shape 11.6.3 already declared — one expression, not a second work-item
 * description. That shape carries every field `integrationResultSchema`
 * requires (`key`, `status`, `sessionBranch`, `updatedAt` and the three
 * implementation-provenance columns), so it VALIDATES against v1's result and
 * the drift guard has something real to compare.
 *
 * v1's own endpoint deliberately returns the NARROW result instead — "did the
 * integration land, and where?" — and that difference is legitimate: the two
 * surfaces answer the same question, and MCP answers it with more. What matters
 * is that the overlap is one schema, which is what the probe asserts.
 */
export const markIntegratedPayload = definePayload({
  schema: mcpWorkItemSchema as unknown as z.ZodType<McpWorkItem>,
  probes: [{ resource: 'IntegrationResult', select: (p) => [p] }],
});

export { integrationResultSchema };

/**
 * The REPAIR claim (Story MOTIR-6804 · MOTIR-6807). `claim_work_item_repair`
 * answers exactly what `POST /api/v1/work-items/{key}/repair` answers, through
 * v1's own presenter — so the whole payload IS the `WorkItemRepairClaim`
 * resource and the probe selects the payload itself. One lock seen through two
 * doors, never two descriptions of it.
 */
export const claimWorkItemRepairPayload = definePayload({
  schema: workItemRepairClaimSchema as unknown as z.ZodType<
    z.infer<typeof workItemRepairClaimSchema>
  >,
  probes: [{ resource: 'WorkItemRepairClaim', select: (p) => [p] }],
});

/** Map a repair claim — v1's own presenter, unchanged. */
export function presentMcpWorkItemRepairClaim(
  dto: WorkItemRepairClaimDto,
): z.infer<typeof workItemRepairClaimSchema> {
  return presentWorkItemRepairClaim(dto);
}

/**
 * The CONTINUE claim (Story MOTIR-7261 · MOTIR-7262). `claim_work_item_continue`
 * answers exactly what `POST /api/v1/work-items/{key}/continue` answers, through
 * v1's own presenter — so the whole payload IS the `WorkItemContinueClaim`
 * resource and the probe selects the payload itself, as the repair claim's does.
 */
export const claimWorkItemContinuePayload = definePayload({
  schema: workItemContinueClaimSchema as unknown as z.ZodType<
    z.infer<typeof workItemContinueClaimSchema>
  >,
  probes: [{ resource: 'WorkItemContinueClaim', select: (p) => [p] }],
});

/** Map a continue claim — v1's own presenter, unchanged. */
export function presentMcpWorkItemContinueClaim(
  dto: WorkItemContinueClaimDto,
): z.infer<typeof workItemContinueClaimSchema> {
  return presentWorkItemContinueClaim(dto);
}
