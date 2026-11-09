import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { planReferenceIds, planTargetKeyResolver, presentPlan } from '@/lib/api/v1/workLoop/schema';
import { readPlanJobCost } from '@/lib/services/planJobCostService';
import { planReviewService } from '@/lib/services/planReviewService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';

// GET /api/v1/plans/{planId} (Story 11.7 · Subtask 11.7.5 — MOTIR-2239) — a
// plan WITH the proposals it bundles: what a planning pass actually proposed,
// not just how many items it produced.
//
// ── These are PROPOSALS, and the SCHEMA says so ─────────────────────────────
// The count is `proposalCount`, not `itemCount` — "item" means WORK ITEM
// everywhere else on this API. An `add`'s `workItemKey` is `null` and stays null
// until a human approves the plan IN MOTIR, which is the only path from a
// proposal to a `work_item` row. A client can tell a proposal from a work item
// from the payload alone, without reading prose.
//
// ── The KEY resolution is a BOUNDED page-level projection ───────────────────
// `PlanItemDto.workItemId` is an internal cuid, which §7 forbids on the wire. So
// the ids this page returned are resolved to `MOTIR-<n>` keys in ONE batched,
// view-gated service read (`resolveReferenceSummaries`) — the form ADR Amendment
// 3 Q4 permits, and never one read per proposal. An id that does not resolve
// (deleted, or in a project this caller may not browse) becomes `null` rather
// than leaking the cuid.

export const GET = withV1Route<{ planId: string }>(
  { permission: 'project:browse' },
  async (ctx) => {
    // The reader's door (MOTIR-6330): a plan outside the caller's Plans-room scope
    // is not-found, exactly like an unknown id.
    const plan = await plansService.getPlanForReader(ctx.params.planId, ctx.service);

    // Targets AND parents (MOTIR-4085) — `planReferenceIds` owns which refs are
    // ids, so the temp-ref form never reaches the read.
    const refs = await workItemsService.resolveReferenceSummaries(
      { ids: planReferenceIds(plan), keys: [] },
      plan.projectId,
      ctx.service,
    );
    // …and the FOLDERS its proposals name (MOTIR-5415), in one batched read.
    const folders = await planReviewService.resolveProposalFolders(plan, ctx.service);
    // …and what its motir-ai job cost (MOTIR-10815): absent for a plan no job
    // produced, every figure `null` when motir-ai could not answer. Never fails the read.
    const cost = await readPlanJobCost(plan);
    return NextResponse.json(presentPlan(plan, planTargetKeyResolver(refs), folders, cost));
  },
);
