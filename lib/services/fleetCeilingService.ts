import type {
  FleetShardMoveReason,
  FleetShardPauseReason,
  Prisma,
} from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { fleetInFlightSlotRepository as slots } from '@/lib/repositories/fleetInFlightSlotRepository';
import {
  ciFleetAdmissionLockRepository as locks,
  FLEET_ADMISSION_SCOPE,
} from '@/lib/repositories/ciFleetAdmissionLockRepository';
import {
  FLEET_WORKLOADS,
  FLEET_WORKLOAD_KINDS,
  type FleetWorkloadKind,
} from '@/lib/ciFleet/workloads';
import { fleetKillSwitchEngaged, fleetSlotTtlSeconds } from '@/lib/ciFleet/limits';
// Wires the agent runner's Fly↔AWS switch before any admission reads it (MOTIR-9421).
import '@/lib/ciFleet/fleetKindSwitches';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import {
  aiPlanGateService,
  AI_PLAN_REQUIRED_ADMISSION_DETAIL,
  PLAN_UNKNOWN_ADMISSION_DETAIL,
} from '@/lib/services/aiPlanGateService';
import { planCapsService } from '@/lib/services/planCapsService';
import type { PlanCaps } from '@/lib/billing/planCaps';

// THE FLEET'S ADMISSION — PER ORGANISATION (Story MOTIR-6906 · MOTIR-6907,
// re-cutting MOTIR-1916 · MOTIR-1997). `docs/decisions/fleet-per-org-pool.md`.
//
// Every container any workload boots on Motir's fleet is admitted here, or by a
// gate that takes the same lock and calls {@link fleetCeilingService.orgCensus}
// in-line (CI's `ciRunnerAdmissionService`, indexing's
// `codeGraphIndexAdmissionService`).
//
// ── WHAT DECIDES ────────────────────────────────────────────────────────────
//   * THE PLAN'S FIGURE FOR THE WORKLOAD (MOTIR-9363 · MOTIR-9373; the
//     fleet-capacity decision MOTIR-9357, amending §2). A hosted-agent run is
//     held to its org's plan's `agentRunsInParallel` (Standard 1, Pro 3, Max 5),
//     judged against the org's in-flight HOSTED-AGENT count alone — never the
//     cross-workload sum, so a CI burst no longer stops an agent run and an
//     agent run no longer takes CI's room. `PLAN_FIGURE_BY_WORKLOAD` says which
//     figure holds which workload. Motir's own orgs are held by no figure.
//     CI runners are held to the plan's `ciBurstCap` (Standard 5, Pro 10, Max 25,
//     Host and `pool_*` 50) over the org's CI runner count alone, by the CI gate
//     (MOTIR-9375); `Organization.fleetPoolCap`, set by platform staff, overrides
//     that one figure and nothing else ({@link fleetCeilingService.resolveCiBurstCap}).
//     Code-graph indexing is held to no plan figure: its own index caps bound it.
//   * THE ORGANISATION'S POOL (§2, the flat 500) is GONE: no admission reads it
//     (MOTIR-9375) and the platform monitor shows each workload against its own
//     plan figure instead (MOTIR-9377), reading the same `capsFor` and
//     {@link fleetCeilingService.resolveCiBurstCap} the gates read.
//   * THE KILL SWITCH (§6) — `MOTIR_FLEET_MAX_IN_FLIGHT=0` stops every new boot
//     of every workload. It is what the one fleet-wide ceiling (MOTIR-1997,
//     default 24) became; unset or positive, it imposes nothing.
//   * A WORKLOAD'S OWN CAP, where it has one, through the request's `guard`
//     (the agent-instance pool, MOTIR-6872).
//
// ── WHY STILL ONE LOCK ──────────────────────────────────────────────────────
// The count is keyed by organisation, but the lock is NOT: every admission still
// takes the one `FLEET_ADMISSION_SCOPE` row. A lock per org was considered and
// rejected (§2): it would add a lock-ordering constraint against every other
// gate and re-open the race this header used to close — a read-derived write
// (`notes.html` #35; the CLAUDE.md lock-before-read-derived-update contract) is
// exact only if every writer that can change the count contends on the same row.
// MUTATION-CHECK IT: delete the `lockScope` call below and
// `tests/ciFleet/fleetCeiling.test.ts`'s two-org race must go red.
//
// ── FAIL CLOSED ─────────────────────────────────────────────────────────────
// If the count, or the org's pool, cannot be established, DO NOT BOOT. A queued
// container is recoverable; a container nothing bounds is not.
//
// ── NO ORG-LESS SLOT ─────────────────────────────────────────────────────────
// Motir's own orgs (`isMeta` / `internalBilling`) are held by no plan figure —
// the kill switch still stops them. A request that names no organisation is
// REFUSED (`organization_required`): it would be counted by no org's pool, which
// is a container nothing bounds.

/** What a census saw, per workload and in total — for one organisation (the
 *  admission's reading) or for the whole fleet (the operator's). Carried out of
 *  every decision so a log names WHICH workload filled the pool — a bare
 *  "500/500" cannot be acted on. */
export interface FleetInFlightCensus {
  /** Containers counted against the pool — every `shared`-pool workload. An
   *  `own`-pool workload appears in `byWorkload` and never here. */
  total: number;
  byWorkload: Record<FleetWorkloadKind, number>;
}

export type FleetSlotVerdict =
  /** Reserved — the slot is taken and this caller owes the release. */
  | {
      outcome: 'reserved';
      census: FleetInFlightCensus;
      /** The plan figure this reservation was judged against (MOTIR-9373);
       *  `null` when none held it — an exempt org, or a workload no figure
       *  holds. */
      pool: number | null;
      /** WHICH ACCOUNT of the fleet pool the container boots on (MOTIR-9421),
       *  as written on the slot; `null` means the process-wide Fly fleet. */
      fleetShardId: string | null;
    }
  /** This `(workload, ref)` already held a slot. Not an error: the take is
   *  idempotent, so a redelivery lands here rather than double-occupying. */
  | { outcome: 'already_held' }
  /** Not reserved. Nothing was written; the caller queues and retries. */
  | {
      outcome: 'deferred';
      /** `plan_cap` (MOTIR-9373): the org already runs as many of this
       *  workload as its plan's figure allows (`PLAN_FIGURE_BY_WORKLOAD`); the
       *  detail names the plan and the figure (the CI gate returns the same
       *  reason for its CI burst cap, MOTIR-9375). `fleet_ceiling`: the operator's kill switch is engaged
       *  (`MOTIR_FLEET_MAX_IN_FLIGHT=0`). `organization_required`: the request
       *  named no organisation, so no pool could count it. `workload_cap`
       *  (MOTIR-6872): the request's own {@link FleetSlotRequest.guard} refused —
       *  a workload-specific cap under the same lock. `ai_plan_required` /
       *  `plan_unknown` (MOTIR-6909): the org has no paid AI plan, or it could
       *  not be read — a shared-pool workload is paid-AI-plan only. Since
       *  MOTIR-9373 `plan_unknown` is also the answer when the plan's figures
       *  cannot be read, or its key has no caps row: never a default figure.
       *  `shard_capacity` (MOTIR-9421): the kind is on its pool and every
       *  account of it is full, paused or absent; the detail is the kind's
       *  words. Never sent to Fly while the switch is on. */
      reason:
        | 'ai_plan_required'
        | 'plan_unknown'
        | 'plan_cap'
        | 'fleet_ceiling'
        | 'organization_required'
        | 'gate_unavailable'
        | 'workload_cap'
        | 'shard_capacity';
      detail: string;
    };

export interface FleetSlotRequest {
  workload: FleetWorkloadKind;
  /** The workload's own id for the thing about to hold a container. */
  ref: string;
  /** WHICH RUN is taking it (MOTIR-2160) — stamped on the row so the matching
   *  {@link fleetCeilingService.release} can be ownership-checked. Only a workload
   *  whose `ref` already names one run may leave it unset. */
  ownerRef?: string | null;
  /** The organisation whose POOL this container counts against — REQUIRED
   *  (MOTIR-6907). Never a bypass. A blank one is refused. */
  organizationId: string;
  /** Attribution only. */
  workspaceId?: string | null;
  /**
   * The container's own hard-kill budget. Becomes the slot's `expires_at`
   * safety net, so a release that never runs costs capacity for this long
   * instead of forever. Defaults to the configured fleet-wide TTL.
   *
   * ⚠️ A value SHORTER than the container's real life would under-count and let
   * the pool be exceeded — pass the workload's real timeout, not a guess.
   */
  ttlSeconds?: number;
  /**
   * A WORKLOAD'S OWN CAP, decided under the SAME fleet admission lock as the
   * pool (MOTIR-6872). Returns `null` to admit, or a sentence naming the cap
   * that refused. Evaluated after the already-held check and before the census,
   * in the locked transaction — so a cap on how many of one workload may run is
   * as exact as the pool itself, and two racers cannot both squeeze under it.
   * A guard that THROWS fails closed like any other count (`gate_unavailable`).
   */
  guard?: (tx: Prisma.TransactionClient, now: Date) => Promise<string | null>;
}

/**
 * Take `FLEET_ADMISSION_SCOPE` inside the caller's system-context transaction —
 * the lock every read-derived admission decision is made under (`reserve`, and
 * the hosted move after a refusal, MOTIR-9423). Throws when it cannot be taken.
 * Each caller opens its own `withSystemContext` so the RLS arm scan reads the
 * whole block.
 */
async function takeAdmissionLock(tx: Prisma.TransactionClient): Promise<void> {
  await locks.ensureScope(FLEET_ADMISSION_SCOPE, tx);
  if (!(await locks.lockScope(FLEET_ADMISSION_SCOPE, tx))) {
    throw new Error('the fleet admission lock could not be taken');
  }
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/** "CI runners 12, code-graph index 8, hosted agents 4" — the breakdown an
 *  operator needs to know which workload to lean on. Exported because the CI and
 *  index gates report the same refusal from their own transactions, and two
 *  spellings of one pool's log would be two pools as far as a reader is
 *  concerned. */
export function describeFleetCensus(census: FleetInFlightCensus): string {
  return FLEET_WORKLOAD_KINDS.map(
    (kind) => `${FLEET_WORKLOADS[kind].label} ${census.byWorkload[kind]}`,
  ).join(', ');
}

/**
 * WHICH PLAN FIGURE HOLDS WHICH WORKLOAD (MOTIR-9373; decision MOTIR-9357).
 * Total by construction, like `FLEET_WORKLOADS`: a workload added to the union
 * without an entry here is a compile error. `null` means no plan figure holds it
 * — indexing (Motir charges nobody for it; its index caps bound it) and agent
 * instances (their own `guard` reads the plan at create and wake). The CI gate
 * reads the same map, so "which figure holds CI" has one spelling.
 */
export const PLAN_FIGURE_BY_WORKLOAD: Readonly<Record<FleetWorkloadKind, keyof PlanCaps | null>> =
  Object.freeze({
    hosted_agent: 'agentRunsInParallel',
    ci_runner: 'ciBurstCap',
    code_graph_index: null,
    agent_instance: null,
  });

/** One of a workload, and many — what a `plan_cap` deferral counts. */
const PLAN_CAP_NOUN: Record<FleetWorkloadKind, readonly [string, string]> = {
  hosted_agent: ['agent run', 'agent runs'],
  ci_runner: ['CI job', 'CI jobs'],
  code_graph_index: ['index container', 'index containers'],
  agent_instance: ['agent', 'agents'],
};

/**
 * The words a `plan_cap` deferral carries: "a Standard organization runs 1
 * agent run at once, and 1 is already running". Names the plan as motir-ai sends
 * it and the figure — never the retired pool.
 */
export function planCapDetail(
  planName: string,
  figure: number,
  workload: FleetWorkloadKind,
  inFlight: number,
): string {
  const [one, many] = PLAN_CAP_NOUN[workload];
  const article = /^[aeiou]/i.test(planName) ? 'an' : 'a';
  const verb = inFlight === 1 ? 'is' : 'are';
  return `${article} ${planName} organization runs ${figure} ${figure === 1 ? one : many} at once, and ${inFlight} ${verb} already running`;
}

/** The words a `plan_unknown` deferral carries when the plan's figures could not
 *  be read — naming the key when there was one with no caps row. */
export function planUnknownCapDetail(planKey: string | null): string {
  return planKey === null
    ? PLAN_UNKNOWN_ADMISSION_DETAIL
    : `This organization's AI plan (${planKey}) has no fleet figures, so nothing boots until it does.`;
}

/**
 * THE ONE FIGURE THE CI GATE JUDGES AN ORG'S CI RUNNERS AGAINST (MOTIR-9375).
 * `Organization.fleetPoolCap`, set by platform staff, overrides the plan's
 * `ciBurstCap` and means nothing else; it holds an exempt org too, but never
 * rescues a plan that could not be read — an override is never a default.
 */
export type CiBurstCap =
  | { kind: 'capped'; figure: number; planName: string | null; source: 'override' | 'plan' }
  /** Motir's own orgs, or a build with no billing, with no override: no figure. */
  | { kind: 'unlimited' }
  /** The plan could not be read, or its key has no row. FAIL-CLOSED. */
  | { kind: 'plan_unknown'; planKey: string | null }
  /** The override could not be read. FAIL-CLOSED (`gate_unavailable`). */
  | { kind: 'unreadable' };

/**
 * The words a CI `plan_cap` deferral carries: the plan and its figure ("a Pro
 * organization runs 10 CI jobs at once, and 10 are already running"), or, for a
 * staff override, that Motir set the limit for this organization. Never the
 * retired pool.
 */
export function ciBurstDetail(
  cap: Extract<CiBurstCap, { kind: 'capped' }>,
  inFlight: number,
): string {
  if (cap.source === 'plan' && cap.planName !== null) {
    return planCapDetail(cap.planName, cap.figure, 'ci_runner', inFlight);
  }
  const verb = inFlight === 1 ? 'is' : 'are';
  return `this organization runs ${cap.figure} ${cap.figure === 1 ? 'CI job' : 'CI jobs'} at once, a limit Motir set for it, and ${inFlight} ${verb} already running`;
}

/** The words a kill-switch deferral carries. */
export const FLEET_KILL_SWITCH_DETAIL =
  'the fleet kill switch is engaged (MOTIR_FLEET_MAX_IN_FLIGHT=0): nothing boots';

/** A plan-gate deferral, in the shape every fleet gate returns. */
export type AiPlanDeferral = {
  outcome: 'deferred';
  reason: 'ai_plan_required' | 'plan_unknown';
  detail: string;
};

export const fleetCeilingService = {
  /**
   * The paid-AI-plan gate every shared-pool admission asks FIRST (MOTIR-6909):
   * plan, then pool, then coverage. Null when the org may proceed; otherwise the
   * deferral to return. FAIL-CLOSED: an unreadable plan defers `plan_unknown`.
   * Motir's own orgs (`isMeta` / `internalBilling`) always pass, with no remote
   * read — `aiPlanGateService` says why.
   */
  async planDeferral(organizationId: string): Promise<AiPlanDeferral | null> {
    const plan = await aiPlanGateService.hasPaidAiPlan(organizationId);
    if (plan === true) return null;
    return plan === 'unknown'
      ? { outcome: 'deferred', reason: 'plan_unknown', detail: PLAN_UNKNOWN_ADMISSION_DETAIL }
      : {
          outcome: 'deferred',
          reason: 'ai_plan_required',
          detail: AI_PLAN_REQUIRED_ADMISSION_DETAIL,
        };
  },

  /**
   * How many containers the WHOLE FLEET is holding, across every registered
   * workload and every organisation — the OPERATOR's reading (the platform
   * admin's monitor, MOTIR-6905). Since MOTIR-6907 no admission decides on it;
   * admission reads {@link orgCensus}.
   *
   * ⚠️ Read under `FLEET_ADMISSION_SCOPE` when it guards a write; as a report it
   * is a snapshot.
   *
   * Counted SEQUENTIALLY, not with `Promise.all`: the counts share one
   * interactive transaction, and Prisma serialises concurrent queries on a
   * single `tx` anyway — parallelising would buy nothing and make an
   * intermittent "Transaction already closed" the reward for reading it as
   * clever.
   *
   * Never swallows: a counter that throws must reach the caller's fail-CLOSED
   * handler rather than contribute a silent zero.
   */
  async census(now: Date, tx: Prisma.TransactionClient): Promise<FleetInFlightCensus> {
    const byWorkload = {} as Record<FleetWorkloadKind, number>;
    let total = 0;
    for (const kind of FLEET_WORKLOAD_KINDS) {
      const count = await FLEET_WORKLOADS[kind].countInFlight(now, tx);
      byWorkload[kind] = count;
      if (FLEET_WORKLOADS[kind].pool === 'shared') total += count;
    }
    return { total, byWorkload };
  },

  /**
   * How many containers ONE ORGANISATION is holding, per workload and summed
   * over the `shared`-pool workloads — the number its pool is judged against
   * (MOTIR-6907, `docs/decisions/fleet-per-org-pool.md` §2).
   *
   * ⚠️ THE CALLER MUST ALREADY HOLD `FLEET_ADMISSION_SCOPE` IN `tx`. This is the
   * read half of a read-derived write; taken outside the lock it is a snapshot
   * two racers can both act on. It is exposed rather than inlined because the CI
   * and index gates call it from INSIDE their own locked transactions — they have
   * already taken the lock and are mid-claim, so re-entering through `reserve`
   * would deadlock the gate against itself.
   *
   * Sequential and never swallowing, for the reasons {@link census} gives.
   */
  async orgCensus(
    organizationId: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<FleetInFlightCensus> {
    const byWorkload = {} as Record<FleetWorkloadKind, number>;
    let total = 0;
    for (const kind of FLEET_WORKLOAD_KINDS) {
      const count = await FLEET_WORKLOADS[kind].countInFlightForOrg(organizationId, now, tx);
      byWorkload[kind] = count;
      if (FLEET_WORKLOADS[kind].pool === 'shared') total += count;
    }
    return { total, byWorkload };
  },

  /**
   * The CI BURST CAP for one organisation (MOTIR-9375): the staff override, else
   * the plan's `ciBurstCap` (`PLAN_FIGURE_BY_WORKLOAD.ci_runner`). Both reads
   * happen BEFORE the fleet lock — the plan may go to motir-ai, and the override
   * is an org-GUC read the system context cannot see. A `plan_unknown` plan stays
   * unknown whatever the override says; a non-negative integer override wins
   * over a readable plan, exempt included; anything else is ignored.
   */
  async resolveCiBurstCap(organizationId: string): Promise<CiBurstCap> {
    const plan = await planCapsService.capsFor(organizationId);
    if (plan.kind === 'plan_unknown') return { kind: 'plan_unknown', planKey: plan.planKey };

    let override: number | null;
    try {
      override = await withOrgServiceWriteContext(organizationId, (tx) =>
        organizationRepository.findFleetPoolCapInTx(organizationId, tx),
      );
    } catch (err) {
      console.error("[fleetCeilingService] could not read the organization's CI burst override", {
        organizationId,
        detail: detailOf(err),
      });
      return { kind: 'unreadable' };
    }
    if (override !== null && Number.isInteger(override) && override >= 0) {
      return {
        kind: 'capped',
        figure: override,
        planName: plan.kind === 'capped' ? plan.planName : null,
        source: 'override',
      };
    }
    if (plan.kind === 'exempt') return { kind: 'unlimited' };
    const figureKey = PLAN_FIGURE_BY_WORKLOAD.ci_runner;
    /* v8 ignore next -- the map holds CI to `ciBurstCap`; a null is a code change */
    if (figureKey === null) return { kind: 'unlimited' };
    return {
      kind: 'capped',
      figure: plan.caps[figureKey],
      planName: plan.planName,
      source: 'plan',
    };
  },

  /**
   * Decide whether ONE container of `workload` may boot, and TAKE its slot if
   * so — the admission path for every workload that is not CI or indexing.
   *
   * CI and indexing do not use this: their gates have more to decide in one
   * transaction and take the same lock themselves, so they call
   * {@link orgCensus} in-line. Everything else — Epic 9's hosted runs, the agent
   * instances — is admitted by calling this and nothing more, which is the
   * point: a new workload cannot be admitted without being counted. A hosted
   * run is held to its plan's parallel-run figure (MOTIR-9373); an agent
   * instance to its `guard`.
   *
   * Deciding and taking the slot in ONE locked transaction is what makes the
   * pool exact: a gate that decided and let someone else take the slot would be
   * deciding from a count that does not yet include the decisions already made.
   *
   * Never throws. Every refusal is a typed verdict, because every caller is a
   * background dispatch: a throw becomes a job retry, and retrying "the pool is
   * full" achieves nothing that queueing does not.
   */
  async reserve(request: FleetSlotRequest, now = new Date()): Promise<FleetSlotVerdict> {
    // An org-less request is counted by no org's pool — refuse it, before any
    // read (MOTIR-6907 criterion 5). The type already requires the field; this
    // is the runtime half, for a caller whose value is blank.
    if (typeof request.organizationId !== 'string' || request.organizationId.trim() === '') {
      console.error('[fleetCeilingService] a fleet slot was requested with no organization', {
        workload: request.workload,
        ref: request.ref,
      });
      return {
        outcome: 'deferred',
        reason: 'organization_required',
        detail: 'a fleet container must belong to an organization, and this request named none',
      };
    }
    if (fleetKillSwitchEngaged()) {
      return { outcome: 'deferred', reason: 'fleet_ceiling', detail: FLEET_KILL_SWITCH_DETAIL };
    }

    const shared = FLEET_WORKLOADS[request.workload].pool === 'shared';
    // The shared workloads are paid-AI-plan only (MOTIR-6909). An `own`-pool
    // workload (the agent instances) asks its own plan question at create and
    // wake, and is bounded by its guard alone.
    let cap: { planName: string; figure: number } | null = null;
    if (shared) {
      const refused = await this.planDeferral(request.organizationId);
      if (refused) return refused;
      // The plan's figure for this workload (MOTIR-9373), read BEFORE the lock
      // as the pool was, so the fleet-wide lock is never held across a remote
      // read. Fail closed: an unreadable plan or a key with no row defers.
      const plan = await planCapsService.capsFor(request.organizationId);
      if (plan.kind === 'plan_unknown') {
        return {
          outcome: 'deferred',
          reason: 'plan_unknown',
          detail: planUnknownCapDetail(plan.planKey),
        };
      }
      const figureKey = PLAN_FIGURE_BY_WORKLOAD[request.workload];
      if (plan.kind === 'capped' && figureKey !== null) {
        cap = { planName: plan.planName, figure: plan.caps[figureKey] };
      }
    }

    const ttlSeconds = request.ttlSeconds ?? fleetSlotTtlSeconds();
    const organizationId = request.organizationId;
    try {
      return await withSystemContext(async (tx) => {
        await takeAdmissionLock(tx);

        // An already-held slot is NOT a new container, so it must not be judged
        // against the pool — a redelivery of a job that is already running would
        // otherwise be refused capacity it is already occupying, and the caller
        // would tear down a live container to honour a refusal.
        const held = await slots.findByRef(request.workload, request.ref, tx);
        if (held) return { outcome: 'already_held' as const };

        if (request.guard) {
          const refused = await request.guard(tx, now);
          if (refused !== null) {
            return {
              outcome: 'deferred' as const,
              reason: 'workload_cap' as const,
              detail: refused,
            };
          }
        }

        // The workload's OWN count, never the cross-workload total: each
        // workload is held to its own figure.
        const census = await this.orgCensus(organizationId, now, tx);
        const inFlight = census.byWorkload[request.workload];
        if (cap !== null && inFlight >= cap.figure) {
          return {
            outcome: 'deferred' as const,
            reason: 'plan_cap' as const,
            detail: planCapDetail(cap.planName, cap.figure, request.workload, inFlight),
          };
        }

        // WHICH ACCOUNT (MOTIR-9421), after the plan cap so a run its plan
        // refuses is told `plan_cap`, never `shard_capacity`; in this locked
        // transaction so the account counted is the account written. A kind
        // whose switch is Fly answers null. A throw fails closed below.
        const placement = await fleetShardAdmissionService.chooseInTx(
          { fleetKind: request.workload, organizationId },
          now,
          tx,
        );
        if ('deferred' in placement) {
          return {
            outcome: 'deferred' as const,
            reason: 'shard_capacity' as const,
            detail: placement.detail,
          };
        }

        const took = await slots.take(
          {
            workload: request.workload,
            ref: request.ref,
            ownerRef: request.ownerRef ?? null,
            organizationId,
            workspaceId: request.workspaceId ?? null,
            fleetShardId: placement.shardId,
            expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
          },
          tx,
        );
        // The insert raced another transaction that committed the same
        // (workload, ref) between the read above and here. Harmless and
        // idempotent — the slot exists exactly once either way.
        if (!took) return { outcome: 'already_held' as const };

        return {
          outcome: 'reserved' as const,
          census,
          pool: cap?.figure ?? null,
          fleetShardId: placement.shardId,
        };
      });
    } catch (err) {
      // FAIL CLOSED. The transaction rolled back, so no slot was taken. An
      // unestablished count is treated as a FULL pool, never an empty one.
      console.error('[fleetCeilingService] the fleet pool could not be evaluated — not booting', {
        workload: request.workload,
        ref: request.ref,
        detail: detailOf(err),
      });
      return {
        outcome: 'deferred',
        reason: 'gate_unavailable',
        detail: `the organization's in-flight count could not be established: ${detailOf(err)}`,
      };
    }
  },

  /**
   * After the account `refusedShardId` refused a hosted-agent run's provision for
   * capacity or an outage (MOTIR-9423): pause it, choose again among the
   * `hosted_agent` accounts not in `tried`, and re-point the run's slot there —
   * all under `FLEET_ADMISSION_SCOPE`, so the re-choice counts what it writes.
   * Answers the next account, or null when none is left (the slot is then still
   * held, on the refused account, and the caller releases it).
   *
   * The re-point is ownership-checked: a slot `ownerRef` does not hold is never
   * moved, and the answer is then null. The lock covers the choice only; the
   * caller provisions outside it.
   */
  async moveHostedSlotAfterRefusal(
    slot: { ref: string; ownerRef: string; organizationId: string },
    refusedShardId: string,
    reason: FleetShardMoveReason & FleetShardPauseReason,
    tried: ReadonlySet<string>,
    now: Date,
  ): Promise<string | null> {
    return withSystemContext(async (tx) => {
      await takeAdmissionLock(tx);
      let moved = true;
      const next = await fleetShardAdmissionService.moveAfterRefusalInTx(
        { fleetKind: 'hosted_agent', organizationId: slot.organizationId },
        refusedShardId,
        reason,
        tried,
        now,
        tx,
        async (nextShardId, _reason, moveTx) => {
          moved = await slots.reassignShardInTx(
            'hosted_agent',
            slot.ref,
            slot.ownerRef,
            nextShardId,
            moveTx,
          );
        },
      );
      return moved ? next : null;
    });
  },

  /**
   * Give a slot back — call this when the container ends, however it ended.
   *
   * This is what makes "completion of any workload's container frees a slot"
   * true for the slot-backed workloads; CI gets the same property for free, from
   * its own settle path. Releasing does NOT take the fleet lock: a delete is not
   * read-derived, and queueing every teardown behind the admission lock would
   * make the fleet slowest to free capacity exactly when it is fullest.
   *
   * Best-effort, and deliberately so: the worst case of a failure here is a slot
   * that occupies capacity until `expires_at` ages it out — visible and bounded
   * — whereas a throw would fail a teardown path over a bookkeeping row.
   *
   * ⚠️ PASS `ownerRef` WHENEVER THE WORKLOAD'S `ref` DOES NOT ALREADY NAME ONE RUN
   * (MOTIR-2160). With it the delete is ownership-checked, so a run can only free
   * the capacity it took; without it a shared ref lets whichever run settles first
   * release a slot another run's live container is still spending against. A
   * workload whose ref IS its run (an intent id, an agent-run id) has nothing to
   * check and may omit it.
   */
  async release(workload: FleetWorkloadKind, ref: string, ownerRef?: string): Promise<boolean> {
    try {
      const released = await withSystemContext((tx) =>
        ownerRef === undefined
          ? slots.release(workload, ref, tx)
          : slots.releaseOwned(workload, ref, ownerRef, tx),
      );
      // ⚠️ A RELEASE THAT REMOVED NOTHING IS THE MOMENT A LEAK IS BORN, AND IT
      // WAS SILENT (MOTIR-3684). The boolean is returned and every caller on the
      // index path discards it, so the only trace a leaked slot left was the
      // refusals it caused hours later — by which time the run that leaked it is
      // one of hundreds in the ledger and nothing links the two. This is the one
      // place that knows, so it says so. It is a WARNING, not an error: a
      // double-release is legitimate (a retried teardown), as is a refused
      // release of another run's slot — what is diagnostic is that it happened
      // at all, and which `ref` it was.
      if (!released) {
        console.warn('[fleetCeilingService] a fleet-slot release removed no row', {
          workload,
          ref,
          ownerRef: ownerRef ?? null,
        });
      }
      return released;
    } catch (err) {
      console.error('[fleetCeilingService] could not release a fleet slot', {
        workload,
        ref,
        detail: detailOf(err),
      });
      return false;
    }
  },

  /**
   * Make `request.ownerRef` the owner of the `(workload, ref)` slot, taking it
   * if it is gone (MOTIR-7492) — for a caller that got `already_held` from
   * {@link reserve} and then WON the state transition that slot stands for.
   *
   * A held slot is stamped with the run that reserved it. When two attempts race
   * for one `ref`, the one that reserved can be the one that loses the
   * transition, and its ownership-checked release then deletes the only slot
   * while the winner's container runs. Adopting stamps the winner instead, so
   * the loser's release removes nothing and the winner's own release, when its
   * run ends, removes the slot. If the loser's release got there first, the row
   * is put back.
   *
   * No admission lock and no census: this admits nothing new — the winner was
   * admitted by the `already_held` answer, against a slot that was counted.
   * Best-effort like {@link release}: a failure is logged and leaves the slot as
   * it was, bounded by its `expires_at`, rather than failing a live start.
   */
  async adopt(
    request: Pick<
      FleetSlotRequest,
      'workload' | 'ref' | 'organizationId' | 'workspaceId' | 'ttlSeconds'
    > & { ownerRef: string },
    now = new Date(),
  ): Promise<boolean> {
    const ttlSeconds = request.ttlSeconds ?? fleetSlotTtlSeconds();
    try {
      await withSystemContext((tx) =>
        slots.adopt(
          {
            workload: request.workload,
            ref: request.ref,
            ownerRef: request.ownerRef,
            organizationId: request.organizationId,
            workspaceId: request.workspaceId ?? null,
            expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
          },
          tx,
        ),
      );
      return true;
    } catch (err) {
      console.error('[fleetCeilingService] could not adopt a fleet slot', {
        workload: request.workload,
        ref: request.ref,
        ownerRef: request.ownerRef,
        detail: detailOf(err),
      });
      return false;
    }
  },

  /**
   * Drop slots whose safety net has expired — the OPERATOR's door onto the reap.
   *
   * ⚠️ THIS IS NOT THE PATH THAT RECOVERS A LEAKED SLOT, AND IT NEVER WAS
   * (MOTIR-3684). It shipped with no caller anywhere in the repository and stayed
   * that way, so the expiry it exists to enforce was enforced by nothing at all;
   * the reap that actually runs is inside
   * `codeGraphIndexAdmissionService.admit`, under the fleet admission lock, on
   * the one path a starved dispatch is guaranteed to reach. This stays as the
   * hand-run equivalent for an operator with a table to clear.
   *
   * It used to say the count already ignores expired rows "so this changes no
   * decision". `fleetInFlightSlotRepository.deleteExpired` carries what went
   * wrong with that sentence, and it is worth reading before adding another
   * read of this table.
   */
  async sweepExpired(now = new Date()): Promise<number> {
    return withSystemContext((tx) => slots.deleteExpired(now, tx));
  },
};
