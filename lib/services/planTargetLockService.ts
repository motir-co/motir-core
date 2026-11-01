import { Prisma, type PlanTargetLock } from '@/generated/prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { planTargetLockRepository } from '@/lib/repositories/planTargetLockRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { PlanTargetLockedError, type PlanTargetWaitingCause } from '@/lib/planChange/errors';
import { sessionWaitingState } from '@/lib/planChange/sessionWaitingState';
import { restingStatusFor } from '@/lib/plans/restingStatus';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import { holdsWhile, planHoldFor, sessionHoldFor } from '@/lib/plans/planHold';
import { planHoldKey, type PlanHoldDTO } from '@/lib/dto/plans';
import { classifyBlockerReadiness } from '@/lib/workItems/blockerReadiness';
import {
  PLANNING_STATUS_KEY,
  PLAN_TARGET_LOCK_SWEEP_BATCH_SIZE,
  isExpired,
  leaseExpiryFrom,
  planLeaseExpiryFrom,
  shouldHoldStatus,
} from '@/lib/planChange/targetLock';

// THE PLANNING-TARGET LOCK (Story MOTIR-2786 · MOTIR-2787) — acquire, hand off,
// release, and recover.
//
// ── THE GAP IT CLOSES ───────────────────────────────────────────────────────
// A planning thread is addressed by SCOPE — `(project, anchor set)`,
// `@@unique([projectId, scopeKey])`. That makes re-opening an IDENTICAL target
// set resume one thread, and does nothing at all about OVERLAPPING ones:
// `[MOTIR-9]` and `[MOTIR-9, MOTIR-4]` are two scope keys naming one common
// item, and both would happily expand it. The exclusion therefore has to live on
// the ITEM, which is what `plan_target_lock.work_item_id UNIQUE` is.
//
// Nothing has collided yet for a reason worth being uncomfortable about: the
// planner runs one job at a time on one machine, so every planning turn in the
// product is globally serialized. That is a far stronger guarantee than anything
// designed, and MOTIR-2783 removes it.
//
// ── WHY IT IS ENFORCED HERE AND NOT IN motir-ai ─────────────────────────────
// motir-core owns the session row, the work item AND the status machine, so
// acquire-or-refuse is one transaction against one database. Setting the status
// from motir-ai over HTTP would make the check-then-act non-atomic across a
// service boundary for no gain. motir-ai's half is only "never run two turns of
// one session concurrently" (MOTIR-2788).
//
// ── THE ROW IS THE LOCK; THE STATUS IS THE AFFORDANCE ───────────────────────
// See `lib/planChange/targetLock.ts` and the migration header. The lease row is
// the authority and the status is its visible face: release and recovery touch
// ONLY items that have a row here.
//
// ⚠️ TWO CLAUSES OF THIS NOTE ARE SUPERSEDED BY MOTIR-5645, and they are stated
// rather than quietly edited, because both were load-bearing for years:
//
//   1. *"only `todo`/`in_progress` have a legal edge into it"* — MOTIR-5643
//      declares an edge from EVERY non-terminal status, so a card can now be
//      parked from `blocked`, `implemented`, `in_review` and `approved` too.
//   2. *"an item parked at `planning` without one is never disturbed"* — a
//      hand-parked item is now ADOPTED when a plan names it as a target
//      (`acquireForPlanWithin`), which is what retires the runbook's manual
//      `transition_status` step. A card parked by hand with NO plan naming it is
//      still never disturbed by the sweep or a release, because both read rows
//      rather than statuses; an ADOPTED one is RESTED at `todo` / `blocked` by
//      every release of its plan (MOTIR-6066, `restAdoptedTarget`).
//
// ── WHO HOLDS IT: A SESSION, OR A PLAN ──────────────────────────────────────
// MOTIR-5645 / AMENDMENT 16 D5. A planning conversation holds its targets from
// the moment it opens; a PLAN holds every committed target it names, acquired at
// `plansService.addProposals` — the one choke point the MCP door, `expand_item`
// and generation all pass through. `PlanTargetHolder` is the discriminator and a
// database CHECK keeps a row to exactly one of them.
//
// ── CONCURRENCY ─────────────────────────────────────────────────────────────
// Acquire locks the WORK ITEM row (`SELECT … FOR UPDATE`) before reading the
// lease. That is deliberate rather than locking the lease row: the lease may not
// exist yet, and a `FOR UPDATE` over zero rows locks NOTHING, so every racer
// would fall through the guard together. The work item always exists, so the
// lock is real. The `work_item_id` unique index is still the backstop, and its
// P2002 is translated to `PlanTargetLockedError` — one condition, one outcome,
// however the race was lost.
//
// Multi-item scopes take their row locks in ONE fixed order (work item id,
// ascending) in every path — acquire, hand-off and release alike. Two operations
// touching the same pair of items in opposite orders deadlock instead of queuing.
//
// 4-layer (CLAUDE.md): this service owns the transactions; `planTargetLockRepository`
// is a single-op leaf; the status write goes through `workItemsService.applyStatusTransition`
// (the one validated status path, which this never re-implements).

/**
 * What the lock needs to know about who is asking: the actor plus the project the
 * targets live in.
 *
 * Deliberately NARROWER than `ProjectContext` — a `ProjectContext` carries the
 * resolved project ROW, which every caller here already had a cheaper way to
 * avoid loading. `plansService` releases from a post-commit hook that holds only
 * ids, and making it re-read a project row purely to satisfy a parameter type
 * would be a database round trip bought with nothing. A `ProjectContext` is
 * structurally assignable to this, so the session paths pass theirs unchanged.
 */
export interface PlanTargetLockContext {
  userId: string;
  workspaceId: string;
  projectId: string;
}

/** What one acquire did to one target — returned so callers and tests can assert
 *  the hand-off's shape without re-reading the database. */
export interface PlanTargetLockOutcome {
  workItemId: string;
  identifier: string;
  /** `acquired` — a fresh lease. `refreshed` — this session already held it.
   *  `reclaimed` — the previous holder's lease had expired. `handed_over` — a
   *  live lease moved from the member's OWN older session of the same scope to
   *  this one (AMENDMENT 17 §6). */
  disposition: 'acquired' | 'refreshed' | 'reclaimed' | 'handed_over';
  /** Whether the status was moved to `planning` (or, on a refresh/reclaim, is
   *  being held there by this lease). */
  statusHeld: boolean;
  expiresAt: Date;
}

export interface PlanTargetHandOff {
  /** Identifiers to RELEASE — restored to their prior status. */
  release: readonly string[];
  /** Identifiers to ACQUIRE. */
  acquire: readonly string[];
}

/** One expired lease the sweep dealt with.
 *
 *  `plan_awaiting_review` is MOTIR-5647's: the lease is a dead-author detector,
 *  and a plan that reached `planned` is waiting for a PERSON rather than for a
 *  crashed author — so its lock is left standing however old the lease is
 *  (AMENDMENT 16 D9). A SESSION-held lock is spared the same way while any of
 *  the session's plans is `planned` / `stale` (MOTIR-8467): a conversation's
 *  plan parks nothing of its own. Reported rather than silently skipped, so the sweep's own
 *  output says why it walked past a row its read had selected.
 *
 *  `plan_generating` is MOTIR-9260's: a SESSION-held lock is also spared while one of
 *  the session's plans is `generating` and has written within `PLAN_STALLED_AFTER_MS`
 *  — a hosted walk that is still writing is a live author, not a dead one.
 *
 *  `session_waiting` is MOTIR-7912's: the lease's holder session (or the session of
 *  the plan holding it) is failed-waiting or awaiting its person, so the hold is
 *  spared however old the lease is — the same dead-author argument, since a person
 *  is coming back. */
export interface PlanTargetLockSweepEntry {
  workItemId: string;
  outcome:
    | PlanTargetReleaseOutcome
    | 'unattributable'
    | 'plan_awaiting_review'
    | 'plan_generating'
    | 'session_waiting';
}

/**
 * Resolve the scope's identifiers to work items IN this project, ordered by id —
 * the fixed lock order every path uses. An identifier naming nothing is skipped
 * rather than raising: the caller resolved and permission-gated the anchor set
 * before it ever became a scope key, so a miss here means the item was deleted
 * between then and now, and a deleted item is not something to hold.
 */
async function resolveTargets(
  identifiers: readonly string[],
  projectId: string,
  tx: Prisma.TransactionClient,
) {
  if (identifiers.length === 0) return [];
  const items = await workItemRepository.findByIdentifiers(projectId, [...identifiers], tx);
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The holder's display name for a refusal, or null when the user is gone. */
async function holderName(
  heldById: string | null,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  if (!heldById) return null;
  const user = await userRepository.findById(heldById, tx);
  return user?.name ?? null;
}

/**
 * WHO is holding a target (MOTIR-5645). A lock names a SESSION or a PLAN, never
 * both and never neither — `plan_target_lock_one_holder` is a
 * `num_nonnulls(session_id, plan_id) = 1` CHECK, so the database refuses any
 * other shape.
 *
 * The two live on ONE table because the exclusion the whole mechanism provides
 * is `work_item_id UNIQUE`: split across two tables there is nothing for that
 * constraint to be unique ACROSS, and a session and a plan could each take the
 * same card.
 */
export type PlanTargetHolder =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'plan'; readonly planId: string };

/** Whether an existing lock is held by THIS holder — a refresh rather than a
 *  collision. Compared on the holder's own column, so a session lock and a plan
 *  lock can never read as each other's. */
function heldBy(lock: PlanTargetLock, holder: PlanTargetHolder): boolean {
  return holder.kind === 'session'
    ? lock.sessionId === holder.sessionId
    : lock.planId === holder.planId;
}

/** The holder's columns, as the row stores them. Writing BOTH on every acquire —
 *  one to a value and the other to null — is what lets a lock legitimately change
 *  hands from a session to a plan (or back) on a reclaim without leaving the CHECK
 *  violated. */
function holderColumns(holder: PlanTargetHolder): {
  sessionId: string | null;
  planId: string | null;
} {
  return holder.kind === 'session'
    ? { sessionId: holder.sessionId, planId: null }
    : { sessionId: null, planId: holder.planId };
}

/** The lease a holder of this kind gets: thirty minutes for a session, which is
 *  refreshed by a submit; twenty-four hours for a plan, which is refreshed by an
 *  append (`targetLock.ts`'s two constants, and AMENDMENT 16 D9). */
function expiryFor(holder: PlanTargetHolder, now: Date): Date {
  return holder.kind === 'session' ? leaseExpiryFrom(now) : planLeaseExpiryFrom(now);
}

/**
 * WHY the holder of this lease is waiting, or null when it is not (MOTIR-7912).
 * The session is the lease's own `sessionId`, or — for a plan-held lease — the
 * session its plan belongs to. A session is waiting while it is OPEN and either
 * failed (`failed`) or awaiting its person (`question` / `reply`); the shared
 * predicate in `sessionWaitingState` decides, never a re-spelling of its columns.
 */
async function waitingCauseOf(
  lock: { sessionId: string | null; planId: string | null; workspaceId: string },
  tx: Prisma.TransactionClient,
): Promise<{ cause: PlanTargetWaitingCause | null; sessionId: string | null }> {
  let sessionId = lock.sessionId;
  if (!sessionId && lock.planId) {
    sessionId =
      (await planRepository.findById(lock.planId, lock.workspaceId, tx))?.sessionId ?? null;
  }
  if (!sessionId) return { cause: null, sessionId: null };
  const state = await planChangeSessionRepository.findWaitingState(sessionId, lock.workspaceId, tx);
  if (!state) return { cause: null, sessionId };
  switch (sessionWaitingState(state)) {
    case 'failed':
      return { cause: 'failed', sessionId };
    case 'awaiting_person':
      return { cause: state.awaitingPersonCause ?? 'reply', sessionId };
    default:
      return { cause: null, sessionId };
  }
}

/**
 * Acquire ONE target inside the caller's transaction. The work item's row lock is
 * already held by the caller, so what this reads cannot move underneath it.
 */
async function acquireOne(
  item: {
    id: string;
    identifier: string;
    projectId: string;
    status: string;
    obsolescence: string | null;
  },
  holder: PlanTargetHolder,
  pctx: PlanTargetLockContext,
  now: Date,
  tx: Prisma.TransactionClient,
  takeOverFrom: ReadonlySet<string> = new Set(),
): Promise<PlanTargetLockOutcome> {
  const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
  const expiresAt = expiryFor(holder, now);
  const existing = await planTargetLockRepository.findByWorkItemId(item.id, tx);

  if (existing) {
    // A live lease held by one of the caller's OWN predecessor sessions of this
    // scope passes to the new session (AMENDMENT 17 §6) — the member starting a
    // fresh conversation must not be refused by their own older one. The row
    // moves in place, so there is no instant with no holder.
    const handedOver =
      existing.sessionId !== null &&
      takeOverFrom.has(existing.sessionId) &&
      !isExpired(existing.expiresAt, now);
    // A hold whose session is WAITING is live whatever its lease says (MOTIR-7912):
    // a person is coming back to it, so another member is REFUSED, never handed a
    // reclaim of an expired lease.
    const waiting = heldBy(existing, holder) ? null : await waitingCauseOf(existing, tx);
    if (
      !heldBy(existing, holder) &&
      !handedOver &&
      (!isExpired(existing.expiresAt, now) || waiting?.cause)
    ) {
      throw new PlanTargetLockedError(
        item.identifier,
        await holderName(existing.heldById, tx),
        existing.expiresAt,
        {
          sessionId: waiting?.cause ? waiting.sessionId : existing.sessionId,
          planId: existing.planId,
          waitingCause: waiting?.cause ?? null,
        },
      );
    }
    // Ours (refresh) or expired (reclaim). EITHER WAY `priorStatus` and
    // `statusHeld` are INHERITED, never recomputed: the item is sitting at
    // `planning` right now precisely BECAUSE of this lease, so recomputing would
    // conclude "nothing to hold" and the eventual release would strand it there.
    const updated = await planTargetLockRepository.update(
      existing.id,
      { ...holderColumns(holder), heldById: pctx.userId, expiresAt },
      tx,
    );
    return {
      workItemId: item.id,
      identifier: item.identifier,
      disposition: heldBy(existing, holder)
        ? 'refreshed'
        : handedOver
          ? 'handed_over'
          : 'reclaimed',
      statusHeld: updated.statusHeld,
      expiresAt: updated.expiresAt,
    };
  }

  // Asked of the project's REAL graph rather than a constant, because a project
  // may customize its workflow. `canTransition` opens its own short read
  // transaction on another connection — the same thing `applyStatusTransition`
  // does from inside `boardsService.moveCard`'s transaction — so it neither
  // nests nor contends with the row lock held here.
  const planningIsLegal = await workflowsService.canTransition(
    item.projectId,
    item.status,
    PLANNING_STATUS_KEY,
    pctx.workspaceId,
  );
  // ⚠️ ADOPTION of a HAND-PARKED card (MOTIR-5645). An item already sitting at
  // `planning` with no lock row — the shape the runbook's manual
  // `transition_status` step produces — takes `statusHeld: false` and
  // `priorStatus: 'planning'`, because nothing recorded where it came from.
  //
  // That is the honest record: there is no prior status to RESTORE, because
  // restoring a status we never observed would be inventing one. So every
  // decision RESTS it instead — APPROVE at `todo` or `blocked` from its live
  // edges like any other target (AMENDMENT 16 D6), and since MOTIR-6066 a
  // DECLINE, an emptying withdraw, a discarded close and the abandoned-plan sweep
  // too (`releaseOne` → `restAdoptedTarget`). Leaving it parked, as D8 first
  // said, stranded it: the lock row is gone after release, so nothing ever moved
  // it again.
  //
  // ⚠️ A MARKED card is never PARKED (MOTIR-6672 · MOTIR-6681). `planning` is outside
  // the done category, so the move would be refused, failing the plan's append —
  // and a plan may target a marked card precisely to CHANGE its mark. The lock is
  // still taken (the plan holds the card); only the status is left where it is,
  // exactly as for a card whose workflow has no edge into `planning`. That also
  // makes the restore below unreachable for a marked card: it runs only on a lock
  // that parked.
  const statusHeld = item.obsolescence == null && shouldHoldStatus(item.status, planningIsLegal);

  try {
    await planTargetLockRepository.create(
      {
        workspaceId: pctx.workspaceId,
        projectId: item.projectId,
        workItemId: item.id,
        ...holderColumns(holder),
        heldById: pctx.userId,
        priorStatus: item.status,
        statusHeld,
        expiresAt,
      },
      tx,
    );
  } catch (err) {
    // The `work_item_id` unique fired: a racer claimed it without holding the row
    // lock this path takes (or from a connection that saw an older snapshot).
    // Same outcome as losing the lock — a raw P2002 never escapes the service.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new PlanTargetLockedError(item.identifier, null, now);
    }
    throw err;
  }

  if (statusHeld) {
    await workItemsService.applyStatusTransition(item.id, PLANNING_STATUS_KEY, ctx, tx);
  }
  return {
    workItemId: item.id,
    identifier: item.identifier,
    disposition: 'acquired',
    statusHeld,
    expiresAt,
  };
}

/**
 * Release ONE lease inside the caller's transaction, restoring the item's prior
 * status — or, for a target a PLAN adopted from a hand-park, RESTING it at `todo`
 * / `blocked`, since there is no observed prior status to restore (MOTIR-6066).
 *
 * ⚠️ The restore is CONDITIONAL on the item still being at `planning`. It used to
 * be justified as a MANUAL RELEASE — a person who dragged the card out had released
 * it themselves. `agent-authored-plans.md` AMENDMENT 21 OVERTURNED that on
 * 2026-09-25 (MOTIR-6017): while an undecided plan holds the card, no hand move out
 * of `planning` is accepted at all, so a PLAN-held card can no longer be released
 * by hand. The guard STAYS as the defensive arm §7 records — a card can still have
 * left `planning` by a system write, the status-delete admin reassign, a SESSION
 * lease (which never holds), an expired `generating` lease, or a move made before
 * the hold deployed — and writing a remembered status over any of those would put
 * the card somewhere nobody decided.
 */
async function releaseOne(
  lock: PlanTargetLock,
  actor: ServiceContext,
  tx: Prisma.TransactionClient,
  opts: { system?: boolean; approved?: boolean } = {},
): Promise<PlanTargetReleaseOutcome> {
  await workItemRepository.lockById(lock.workItemId, tx);
  const item = await workItemRepository.findById(lock.workItemId, tx);
  await planTargetLockRepository.deleteById(lock.id, tx);

  if (!item || item.status !== PLANNING_STATUS_KEY) return 'left_as_is';
  if (!lock.statusHeld) {
    return isAdoptedByPlan(lock) || (opts.approved === true && isHandParkedSessionLock(lock))
      ? restAdoptedTarget(item, actor, tx)
      : 'left_as_is';
  }
  await workItemsService.applyStatusTransition(lock.workItemId, lock.priorStatus, actor, tx, {
    // The restore is AUTHORITATIVE, not an interactive move: it puts the item
    // back where it was, and `planning → <prior>` may not be an edge the project's
    // graph carries in the restricted policy. Refusing to undo our own change
    // would leave the item stuck, which is the failure this whole card is about.
    system: opts.system ?? true,
  });
  return 'restored';
}

/** What one release did to its target: `restored` to the status it was parked
 *  from, `rested` at `todo` / `blocked` from its live edges (an ADOPTED target —
 *  MOTIR-6066), or `left_as_is`. */
export type PlanTargetReleaseOutcome = 'restored' | 'rested' | 'left_as_is';

/**
 * Whether a lock is a PLAN's adoption of a HAND-PARKED card — a card that was
 * already at `planning` with no lock row when the plan named it, so the plan
 * recorded `priorStatus: 'planning'` and moved nothing (`acquireOne`).
 *
 * PLAN-held only, deliberately. A SESSION that opens on a hand-parked card still
 * leaves it where the person put it when it ends WITHOUT a decision (MOTIR-2425):
 * a planning conversation is not a decision about the card, so resting its targets
 * on a decline, an idle close or a restart would make the endings of one
 * conversation disagree. The one session ending that IS a decision is the APPROVE
 * of the plan it produced, which rests the card through
 * {@link isHandParkedSessionLock} (bug MOTIR-8356).
 */
function isAdoptedByPlan(lock: PlanTargetLock): boolean {
  return lock.planId !== null && lock.priorStatus === PLANNING_STATUS_KEY;
}

/**
 * Whether a lock is a CONVERSATION SESSION's hold on a card that was already
 * hand-parked at `planning` when the session took it (bug MOTIR-8356): no plan
 * holder, a recorded prior status of `planning`, and no status held. The plan a
 * conversation produces parks nothing itself (`plansService.addProposals`), so
 * when it is APPROVED there is no plan-held lock for `restPlanTargets` to rest and
 * this session lock is the only record the card was ever parked. An approve rests
 * it exactly as it rests an adopted plan-held target; every other ending of the
 * session (a decline, an idle close, a restart) still leaves it where the person
 * put it, because a conversation that produced nothing is not a decision about
 * the card (MOTIR-2425).
 */
function isHandParkedSessionLock(lock: PlanTargetLock): boolean {
  return (
    lock.sessionId !== null &&
    lock.planId === null &&
    lock.priorStatus === PLANNING_STATUS_KEY &&
    !lock.statusHeld
  );
}

/**
 * Whether a work item has a `blocked_by` that is not finished — the SAME
 * predicate the ready set, materialize's birth-status pass and approve's resting
 * status use (`classifyBlockerReadiness`), so `blocked` written by a release can
 * never mean something different from "not ready" there.
 */
async function hasOpenBlockerWithin(
  workItemId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const blockerRows = await workItemLinkRepository.findBlockerStatesForItems([workItemId], tx);
  if (blockerRows.length === 0) return false;
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    blockerRows.map((b) => b.projectId),
    workspaceId,
    tx,
  );
  return !classifyBlockerReadiness(blockerRows, terminalByProject).ready;
}

/**
 * REST an adopted target instead of leaving it parked (bug MOTIR-6066; AMENDMENT
 * 16 D8 as amended 2026-09-22).
 *
 * An adopted card has no observed prior status to restore — the plan found it
 * already at `planning`. D8 used to answer "then leave it", and that stranded it:
 * the lock row is deleted here, so no sweep ever reaches it again, and nothing in
 * the product moves a card out of `planning` on its own. The requester overruled
 * it: every decision returns a plan's targets, so a decline, an emptying
 * withdraw, a discarded close and the abandoned-plan sweep rest an adopted card
 * exactly as approve does — `blocked` with an open blocker, `todo` without.
 *
 * A SYSTEM write, like the restore beside it: `planning → todo` may not be an
 * edge a restricted custom graph declares, and refusing would strand the card.
 * A project whose workflow has no such status at all keeps the card where it is,
 * because a status the workflow does not offer is never written.
 */
async function restAdoptedTarget(
  item: {
    id: string;
    projectId: string;
    archivedAt: Date | null;
    status: string;
    obsolescence: string | null;
  },
  actor: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<PlanTargetReleaseOutcome> {
  // A MARKED card stays finished (MOTIR-6681): both resting statuses are outside the
  // done category, so the mark refuses them even for a system write, and a throw
  // here would fail the plan's decision. Only a LEGACY card marked while it sat at
  // `planning` can reach this; it is left as it is — the same answer as a workflow
  // that offers no resting status.
  if (item.obsolescence != null) return 'left_as_is';
  const decision = restingStatusFor({
    archived: item.archivedAt !== null,
    currentStatus: item.status,
    hasOpenBlocker: await hasOpenBlockerWithin(item.id, actor.workspaceId, tx),
  });
  if (!decision.write) return 'left_as_is';
  const statuses = await workflowsService.listStatusesByProject(
    item.projectId,
    actor.workspaceId,
    tx,
  );
  if (!statuses.some((s) => s.key === decision.toKey)) return 'left_as_is';
  await workItemsService.applyStatusTransition(item.id, decision.toKey, actor, tx, {
    system: true,
  });
  return 'rested';
}

/**
 * THE PLAN HOLD, read on the caller's transaction (Story MOTIR-6017 · MOTIR-6265;
 * `agent-authored-plans.md` AMENDMENT 21 §§1–2): whether an UNDECIDED plan holds
 * `item` at `planning`, and — when it does — everything a surface needs to draw
 * the line and send its Review plan door where the plan is.
 *
 * ONE read shared by the status funnel's refusal (`applyStatusTransition`, under
 * the item row lock), the up-front read ({@link planTargetLockService.readPlanHold})
 * and the system movers that must not walk a held card out of `planning`
 * (`mergeQueueExitService`). The RULE is `planHoldFor`'s; this only gathers its
 * inputs. A card not at `planning` costs nothing: no read is made.
 */
export async function readPlanHoldWithin(
  item: { id: string; identifier: string; status: string },
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
  viewerId: string | null = null,
): Promise<PlanHoldDTO | null> {
  if (item.status !== PLANNING_STATUS_KEY) return null;
  const lock = await planTargetLockRepository.findByWorkItemId(item.id, tx);
  if (!lock) return null;
  if (!lock.planId) {
    // AMENDMENT 23 §5 — an OPEN session's lock holds too.
    if (!lock.sessionId) return null;
    const session = await planChangeSessionRepository.findHoldSubject(lock.sessionId, tx);
    const hold = sessionHoldFor({
      itemStatus: item.status,
      lockSessionId: lock.sessionId,
      sessionEndedAt: session ? session.endedAt : undefined,
    });
    if (!hold.held || !session) return null;
    return {
      kind: 'session',
      itemKey: item.identifier,
      workItemId: item.id,
      planId: null,
      planStatus: null,
      sessionId: hold.sessionId,
      anchorKey: session.targetKeys[0] ?? null,
      holderId: session.createdBy?.id ?? null,
      holderName: session.createdBy?.name ?? null,
      heldByViewer: viewerId !== null && session.createdBy?.id === viewerId,
    };
  }
  const plan = await planRepository.findHoldSubject(lock.planId, tx);
  const hold = planHoldFor({
    itemStatus: item.status,
    lock,
    planStatus: plan?.status ?? null,
    now,
  });
  if (!hold.held) return null;
  return {
    kind: 'plan',
    itemKey: item.identifier,
    workItemId: item.id,
    planId: hold.planId,
    planStatus: hold.planStatus,
    sessionId: plan?.sessionId ?? null,
    anchorKey: plan?.session?.targetKeys[0] ?? null,
  };
}

/** A plan — or an open session — named by {@link readPlanHoldsWithin}: its label
 *  columns and, for a plan, its status. Keyed by {@link planHoldKey}. */
export interface HeldPlanSubject {
  kind: 'plan' | 'session';
  planId: string | null;
  sessionId: string | null;
  title: string | null;
  anchorKey: string | null;
  planStatus: PlanHoldDTO['planStatus'];
}

/**
 * THE PLAN HOLD FOR MANY ITEMS AT ONCE (Story MOTIR-6017 · MOTIR-6268) — the
 * batched twin of {@link readPlanHoldWithin}: ONE read of the items' plan-held
 * leases joined to their plans, each row through the SAME `planHoldFor`, so a
 * surface that lists many cards (the board) and the funnel that refuses one move
 * cannot disagree. Only items at `planning` are read at all. Returns the hold per
 * held item, and each holding plan's label columns.
 */
export async function readPlanHoldsWithin(
  items: readonly { id: string; identifier: string; status: string }[],
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
  viewerId: string | null = null,
): Promise<{ byItemId: Map<string, PlanHoldDTO>; plans: Map<string, HeldPlanSubject> }> {
  const byItemId = new Map<string, PlanHoldDTO>();
  const plans = new Map<string, HeldPlanSubject>();
  const planning = items.filter((item) => item.status === PLANNING_STATUS_KEY);
  if (planning.length === 0) return { byItemId, plans };
  const itemById = new Map(planning.map((item) => [item.id, item]));
  const locks = await planTargetLockRepository.listPlanHeldByWorkItemIds(
    planning.map((item) => item.id),
    tx,
  );
  for (const lock of locks) {
    // The read asked for exactly these items, and a plan-held lock's plan is a
    // cascading FK — both lookups resolve.
    const item = itemById.get(lock.workItemId)!;
    const plan = lock.plan!;
    const hold = planHoldFor({ itemStatus: item.status, lock, planStatus: plan.status, now });
    if (!hold.held) continue;
    const anchorKey = plan.session?.targetKeys[0] ?? null;
    byItemId.set(item.id, {
      kind: 'plan',
      itemKey: item.identifier,
      workItemId: item.id,
      planId: hold.planId,
      planStatus: hold.planStatus,
      sessionId: plan.sessionId,
      anchorKey,
    });
    plans.set(hold.planId, {
      kind: 'plan',
      planId: hold.planId,
      sessionId: plan.sessionId,
      title: plan.title,
      anchorKey,
      planStatus: hold.planStatus,
    });
  }
  // AMENDMENT 23 §5 — the OPEN-session holds, through the same rule the funnel uses.
  const sessionLocks = await planTargetLockRepository.listSessionHeldByWorkItemIds(
    planning.map((item) => item.id),
    tx,
  );
  for (const lock of sessionLocks) {
    const item = itemById.get(lock.workItemId)!;
    const hold = sessionHoldFor({
      itemStatus: item.status,
      lockSessionId: lock.sessionId,
      sessionEndedAt: lock.session ? lock.session.endedAt : undefined,
    });
    if (!hold.held || !lock.session) continue;
    const anchorKey = lock.session.targetKeys[0] ?? null;
    const dto: PlanHoldDTO = {
      kind: 'session',
      itemKey: item.identifier,
      workItemId: item.id,
      planId: null,
      planStatus: null,
      sessionId: hold.sessionId,
      anchorKey,
      holderId: lock.session.createdBy?.id ?? null,
      holderName: lock.session.createdBy?.name ?? null,
      heldByViewer: viewerId !== null && lock.session.createdBy?.id === viewerId,
    };
    byItemId.set(item.id, dto);
    plans.set(planHoldKey(dto), {
      kind: 'session',
      planId: null,
      sessionId: hold.sessionId,
      title: null,
      anchorKey,
      planStatus: null,
    });
  }
  return { byItemId, plans };
}

export const planTargetLockService = {
  /**
   * THE BOARD'S PLAN HOLDS (Story MOTIR-6017 · MOTIR-6268;
   * `design/boards/design-notes.md` § _The board refuses ON THE CARD while a PLAN
   * holds it_ → _THE DATA_): per loaded card, the plan holding it
   * ({@link readPlanHoldsWithin}); per holding plan, its label columns and how
   * many live items of the PROJECT it holds — counted here, not by the client,
   * because a column loads a bounded set. The count applies the same rule: an
   * item at `planning`, and a `generating` plan's lease only while it runs.
   */
  async readBoardPlanHolds(
    projectId: string,
    items: readonly { id: string; identifier: string; status: string }[],
    ctx: Pick<ServiceContext, 'workspaceId'> & { userId?: string | null },
  ): Promise<{
    byItemId: Map<string, PlanHoldDTO>;
    plans: Map<string, HeldPlanSubject & { heldCount: number }>;
  }> {
    if (!items.some((item) => item.status === PLANNING_STATUS_KEY)) {
      return { byItemId: new Map(), plans: new Map() };
    }
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const now = new Date();
      const { byItemId, plans } = await readPlanHoldsWithin(items, tx, now, ctx.userId ?? null);
      const subjects = [...plans.values()];
      const planIds = subjects.flatMap((p) => (p.kind === 'plan' && p.planId ? [p.planId] : []));
      const sessionIds = subjects.flatMap((p) =>
        p.kind === 'session' && p.sessionId ? [p.sessionId] : [],
      );
      const counts = await planTargetLockRepository.countByPlanIds(
        {
          workspaceId: ctx.workspaceId,
          projectId,
          workItemStatus: PLANNING_STATUS_KEY,
          planIds,
          leasedPlanIds: planIds.filter((id) => holdsWhile(plans.get(id)!.planStatus!) === 'lease'),
          leaseAfter: now,
        },
        tx,
      );
      const sessionCounts = await planTargetLockRepository.countBySessionIds(
        {
          workspaceId: ctx.workspaceId,
          projectId,
          workItemStatus: PLANNING_STATUS_KEY,
          sessionIds,
        },
        tx,
      );
      const counted = new Map<string, HeldPlanSubject & { heldCount: number }>();
      for (const [key, subject] of plans) {
        const heldCount =
          subject.kind === 'plan'
            ? (counts.get(subject.planId!) ?? 0)
            : (sessionCounts.get(subject.sessionId!) ?? 0);
        counted.set(key, { ...subject, heldCount });
      }
      return { byItemId, plans: counted };
    });
  },

  /** The shared open-blocker read, exposed so approve's resting pass
   *  (`plansService.restPlanTargets`) asks it the same way a release does. */
  hasOpenBlockerWithin,

  /** The hand-parked session lock shape, exposed so approve's resting pass rests
   *  those targets inside its own transaction (MOTIR-9527 / MOTIR-9531). */
  isHandParkedSessionLock,

  /**
   * THE UP-FRONT READ (MOTIR-6265; AMENDMENT 21 §2): whether an undecided plan
   * holds this card, and where its plan is — so the status control can lock
   * every move and draw its Review plan door BEFORE anyone tries one, from the
   * same rule the funnel refuses with. `null` when the card is not held: not at
   * `planning`, no lock, a SESSION lock, an expired `generating` lease, or a
   * decided plan. An item outside the caller's workspace is simply not held.
   */
  async readPlanHold(workItemId: string, ctx: ServiceContext): Promise<PlanHoldDTO | null> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId) return null;
      return readPlanHoldWithin(item, tx, new Date(), ctx.userId);
    });
  },

  /**
   * Take the lock on every target in a scope — the acquire that runs when a
   * planning session OPENS or RESUMES.
   *
   * ALL-OR-NOTHING. One transaction over the whole set, so a scope that overlaps
   * a held item acquires none of it. A partial acquire would leave a caller
   * holding half a scope with no way to name what it holds, and would make a
   * refusal depend on which anchor happened to sort first.
   *
   * Idempotent for the holding session: re-opening the same thread refreshes its
   * lease instead of failing, which is what makes the mount read safe to repeat.
   */
  /**
   * WHO ELSE holds one of the scope's cards right now (AMENDMENT 23 §4; MOTIR-7643)
   * — the overlay's refusal, read on OPEN so the person is told before they type.
   * A READ: it takes nothing. Called only when the caller resumed nothing, so any
   * live lease is one a new session's acquire would be refused by — the same
   * PlanTargetLockedError that refusal raises is built here, so the two say the
   * same holder and the same `freesBy`.
   */
  async readForeignHoldForScope(
    identifiers: readonly string[],
    pctx: PlanTargetLockContext,
    now: Date = new Date(),
  ): Promise<PlanTargetLockedError | null> {
    if (identifiers.length === 0) return null;
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        for (const item of await resolveTargets(identifiers, pctx.projectId, tx)) {
          const lock = await planTargetLockRepository.findByWorkItemId(item.id, tx);
          if (!lock) continue;
          // The same liveness `acquireOne` applies: a waiting hold is live however
          // old its lease, so the preflight refusal and the acquire agree (MOTIR-7912).
          const waiting = await waitingCauseOf(lock, tx);
          if (isExpired(lock.expiresAt, now) && !waiting.cause) continue;
          return new PlanTargetLockedError(
            item.identifier,
            await holderName(lock.heldById, tx),
            lock.expiresAt,
            {
              sessionId: waiting.cause ? waiting.sessionId : lock.sessionId,
              planId: lock.planId,
              waitingCause: waiting.cause,
            },
          );
        }
        return null;
      },
    );
  },

  async acquireForScope(
    sessionId: string,
    identifiers: readonly string[],
    pctx: PlanTargetLockContext,
    now: Date = new Date(),
  ): Promise<PlanTargetLockOutcome[]> {
    if (identifiers.length === 0) return [];
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      (tx) => planTargetLockService.acquireForScopeWithin(sessionId, identifiers, pctx, now, tx),
    );
  },

  /**
   * The transactional CORE of {@link acquireForScope}, factored out so it can run
   * INSIDE a caller-supplied transaction — the same shape, and for the same
   * reason, as `workItemsService.applyStatusTransition`.
   *
   * The caller that needs it is the session OPEN: a thread row that commits while
   * its leases do not is precisely the split the story forbids, because the thread
   * would then exist, be resumable, and hold nothing. So the session start
   * (`planChangeSessionsService`'s resume-or-start) creates the row and takes the lock in ONE transaction, and a refusal rolls the
   * whole open back — the conversation was never opened, because its targets were
   * taken. `tx` is REQUIRED; this method never opens a transaction.
   */
  async acquireForScopeWithin(
    sessionId: string,
    identifiers: readonly string[],
    pctx: PlanTargetLockContext,
    now: Date,
    tx: Prisma.TransactionClient,
    opts: {
      /** Sessions whose LIVE leases this acquire may take over rather than be
       *  refused by — the caller's own older sessions of the SAME scope
       *  (AMENDMENT 17 §6). Any other holder still refuses. */
      takeOverFrom?: readonly string[];
    } = {},
  ): Promise<PlanTargetLockOutcome[]> {
    if (identifiers.length === 0) return [];
    const takeOverFrom = new Set(opts.takeOverFrom ?? []);
    const targets = await resolveTargets(identifiers, pctx.projectId, tx);
    const outcomes: PlanTargetLockOutcome[] = [];
    for (const item of targets) {
      await workItemRepository.lockById(item.id, tx);
      outcomes.push(
        await acquireOne(item, { kind: 'session', sessionId }, pctx, now, tx, takeOverFrom),
      );
    }
    return outcomes;
  },

  /**
   * PARK every committed target a PLAN names (MOTIR-5645; AMENDMENT 16 D1–D5) —
   * the acquire `plansService.addProposals` makes, inside the transaction that is
   * already holding the plan row.
   *
   * Takes work-item IDS rather than identifiers, because the append has already
   * resolved and validated them: a proposal's `workItemId` is a real id and an
   * `add`'s committed `parentRef` was resolved to one before this runs. That is
   * the only shape difference from {@link acquireForScopeWithin}; everything
   * below it — the fixed lock order, the refusal, the status write — is shared.
   *
   * ⚠️ WHAT IT DOES NOT DO, so the boundary is legible: it does not RELEASE.
   * Approve, decline and the empty close are MOTIR-5646's; the abandoned-plan
   * expiry is MOTIR-5647's. Until those land a plan-held lock is released by
   * nothing, which is safe only because all three ship on one parent pull
   * request.
   *
   * ⚠️ IT IS ONLY EVER CALLED FOR A PLAN WITH NO SESSION. A plan produced by a
   * planning CONVERSATION is already held by that conversation (MOTIR-2786), so
   * `plansService.addProposals` hands this an EMPTY list for one — successive
   * plans of one conversation are ONE actor, and making each its own holder made
   * a conversation collide with itself on every refine (MOTIR-5648).
   *
   * `tx` is REQUIRED — this never opens a transaction of its own, because the
   * park and the proposals it guards must commit or roll back together. A plan
   * that parked a card and then failed to append would hold it for a day.
   */
  async acquireForPlanWithin(
    planId: string,
    workItemIds: readonly string[],
    terminalStatusKeys: ReadonlySet<string>,
    pctx: PlanTargetLockContext,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLockOutcome[]> {
    if (workItemIds.length === 0) return [];
    // ONE fixed lock order — work item id ascending — the same order every other
    // path here takes, so an append and a release touching the same pair of cards
    // queue instead of deadlocking. De-duplicated first: a plan naming one card
    // in several proposals must not take its row lock twice.
    const ordered = [...new Set(workItemIds)].sort();
    const outcomes: PlanTargetLockOutcome[] = [];
    for (const id of ordered) {
      await workItemRepository.lockById(id, tx);
      // Re-read under the row lock: `addProposals` resolved these ids before
      // taking it, so the status it saw is a snapshot and `priorStatus` must be
      // what the row says NOW.
      const item = await workItemRepository.findById(id, tx);
      // Deleted between the resolve and the lock. Nothing to hold, and refusing
      // the whole append over it would be the wrong answer — `resolveTargets`
      // makes the same judgement for the session path, for the same reason.
      if (!item) continue;
      // ⚠️ A TERMINAL TARGET IS NEVER PARKED (AMENDMENT 16 D2; product owner,
      // 2026-09-16: *"done and cancelled should be excluded"*), and this check
      // has to be HERE rather than inherited.
      //
      // MOTIR-5645's card asserted that `validateProposals` already refuses a
      // terminal target before the park runs. It does not: that refusal is
      // `validatePlanProposals`, which needs `liveById` and therefore "cannot
      // move earlier than the CLOSE" — so an APPEND naming a `done` card is
      // accepted, and without this the park would take a lock on shipped work.
      //
      // Not folded into `shouldHoldStatus`, which asks a different question. That
      // one asks whether the MOVE is legal and answers false for a custom
      // workflow missing the edge — where the right outcome is still a lock with
      // `statusHeld: false`, because the row is the exclusion. This asks whether
      // the card may be HELD AT ALL, and the answer for terminal work is no row.
      if (terminalStatusKeys.has(item.status)) continue;
      outcomes.push(await acquireOne(item, { kind: 'plan', planId }, pctx, now, tx));
    }
    return outcomes;
  },

  /**
   * Move the lock DOWN a level — release one set and acquire another, in ONE
   * transaction.
   *
   * This is the operation the story's hand-off table describes: an epic is held
   * while it is being expanded, and the moment its stories exist the epic goes
   * back to `to do` and the story being broken down takes the lock. Both halves
   * have to commit together. A window where NEITHER is held lets a second session
   * in; a window where BOTH are held blocks a sibling story for no reason.
   *
   * Release runs first WITHIN that transaction, so handing a lock from a parent
   * to a child (or between overlapping sets) does not deadlock against itself.
   */
  async handOff(
    sessionId: string,
    moves: PlanTargetHandOff,
    pctx: PlanTargetLockContext,
    now: Date = new Date(),
  ): Promise<PlanTargetLockOutcome[]> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const releasing = await resolveTargets(moves.release, pctx.projectId, tx);
        for (const item of releasing) {
          const lock = await planTargetLockRepository.findByWorkItemId(item.id, tx);
          // Only OUR leases. A hand-off that could release someone else's lock
          // would be a way around the exclusion rather than a use of it.
          if (lock && lock.sessionId === sessionId) await releaseOne(lock, ctx, tx);
        }
        const acquiring = await resolveTargets(moves.acquire, pctx.projectId, tx);
        const outcomes: PlanTargetLockOutcome[] = [];
        for (const item of acquiring) {
          await workItemRepository.lockById(item.id, tx);
          // Re-read: the release above may have just moved this very item's
          // status, and the acquire's `priorStatus` must be what it is NOW.
          const fresh = await workItemRepository.findById(item.id, tx);
          if (!fresh) continue;
          outcomes.push(await acquireOne(fresh, { kind: 'session', sessionId }, pctx, now, tx));
        }
        return outcomes;
      },
    );
  },

  /**
   * Give back everything one session holds — the terminal path.
   *
   * Called when the level's output exists (the plan was approved) and when it
   * never will (declined). It is deliberately idempotent and total: a session
   * holding nothing releases nothing and returns an empty list, so every caller
   * can call it unconditionally rather than deciding whether there is anything to
   * release. A release that callers have to remember to guard is a release that
   * gets skipped on the error path, which is the path that matters.
   */
  async releaseForSession(
    sessionId: string,
    pctx: PlanTargetLockContext,
    opts: { approved?: boolean } = {},
  ): Promise<Array<{ workItemId: string; outcome: PlanTargetReleaseOutcome }>> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      (tx) => planTargetLockService.releaseForSessionWithin(sessionId, ctx, tx, opts),
    );
  },

  /**
   * {@link releaseForSession} INSIDE THE CALLER'S TRANSACTION — for the one end
   * operation (`planChangeSessionsService.endSession`, AMENDMENT 23 §2), which
   * stamps the end and gives the cards back in ONE transaction. `system` signs
   * each restore as a background write, the way the sweep does, for an end
   * Motir made rather than a person.
   */
  async releaseForSessionWithin(
    sessionId: string,
    actor: ServiceContext,
    tx: Prisma.TransactionClient,
    opts: { system?: boolean; approved?: boolean } = {},
  ): Promise<Array<{ workItemId: string; outcome: PlanTargetReleaseOutcome }>> {
    const locks = await planTargetLockRepository.listBySessionId(sessionId, tx);
    const results: Array<{ workItemId: string; outcome: PlanTargetReleaseOutcome }> = [];
    for (const lock of locks) {
      results.push({
        workItemId: lock.workItemId,
        outcome: await releaseOne(lock, actor, tx, opts),
      });
    }
    return results;
  },

  /**
   * Give back everything one PLAN holds, RESTORING each target's prior status
   * (MOTIR-5646; AMENDMENT 16 D8) — the twin of the release above, for the
   * DECLINE side of a decision.
   *
   * ⚠️ THIS IS THE RESTORE PATH, and the asymmetry with approve is the whole
   * of D6 vs D8. A decline, a withdraw that empties the plan and a close that
   * materializes nothing have changed NOTHING about the card, so the card goes
   * back to the status it was parked from. The one exception is a target the
   * plan ADOPTED from a hand-park: it has no observed prior status, so it RESTS
   * at `todo` / `blocked` from its live edges, as approve would rest it
   * (MOTIR-6066) — a declined plan never leaves its target parked. An APPROVE does not come through here
   * at all: it has already given each target its RESTING status inside its own
   * transaction (`plansService.restPlanTargets`) and deleted the lock, so this
   * finds nothing left to do — which is what makes calling it on every decision
   * safe and idempotent.
   *
   * Idempotent and total, like `releaseForSession`: a plan holding nothing
   * releases nothing and returns an empty list, so every caller can call it
   * unconditionally rather than deciding whether there is anything to release. A
   * release that callers have to remember to guard is one that gets skipped on
   * the error path, which is the path that matters.
   */
  async releaseForPlan(
    planId: string,
    pctx: PlanTargetLockContext,
  ): Promise<Array<{ workItemId: string; outcome: PlanTargetReleaseOutcome }>> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      (tx) => planTargetLockService.releaseForPlanWithin(planId, ctx, tx),
    );
  },

  /** {@link releaseForPlan} INSIDE THE CALLER'S TRANSACTION — the end operation's
   *  arm for a `generating` plan it discards (AMENDMENT 23 §2). */
  async releaseForPlanWithin(
    planId: string,
    actor: ServiceContext,
    tx: Prisma.TransactionClient,
    opts: { system?: boolean } = {},
  ): Promise<Array<{ workItemId: string; outcome: PlanTargetReleaseOutcome }>> {
    const locks = await planTargetLockRepository.listByPlanId(planId, tx);
    const results: Array<{ workItemId: string; outcome: PlanTargetReleaseOutcome }> = [];
    for (const lock of locks) {
      results.push({
        workItemId: lock.workItemId,
        outcome: await releaseOne(lock, actor, tx, opts),
      });
    }
    return results;
  },

  /**
   * Push the session's leases out by a fresh window — the heartbeat, called when
   * the thread does something (a submit).
   *
   * Without it a conversation longer than one lease would have its own targets
   * swept out from under it. With it, the window only starts running down once
   * the session goes quiet, which is precisely the condition it exists to detect.
   */
  async refreshForSession(
    sessionId: string,
    pctx: PlanTargetLockContext,
    now: Date = new Date(),
  ): Promise<number> {
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      (tx) => planTargetLockRepository.extendBySessionId(sessionId, leaseExpiryFrom(now), tx),
    );
  },

  /**
   * {@link refreshForSession} INSIDE THE CALLER'S TRANSACTION — every TURN
   * refreshes the lease, not only a submit (AMENDMENT 23 §2; MOTIR-7638), so a
   * session's lease expiry and its idle deadline are the same instant and the
   * idle close never ends a conversation a person is still having.
   */
  async refreshForSessionWithin(
    sessionId: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return planTargetLockRepository.extendBySessionId(sessionId, leaseExpiryFrom(now), tx);
  },

  /**
   * RECOVERY — release every lease whose window has run out.
   *
   * This is the path that reaches the case nothing else can. A planner that
   * crashes, a machine that vanishes mid-job, a redeploy, a user who closes the
   * tab: none of them produce an event. The plan stays `generating` until the
   * MOTIR-3064 abandoned-plan sweep asks its job about it (`PlanStatus` still has
   * no `failed` member — that reconciler writes `declined`), and that answer
   * arrives hourly and only for an EMPTY plan, so there is still no product
   * signal to hang a release on — only the passage of time.
   *
   * CROSS-TENANT discovery, PER-TENANT release. The expired set spans workspaces,
   * so the read runs under `withSystemContext` (the table's `FOR SELECT`
   * `app.system_admin` arm exists for exactly this). Each release then binds
   * `app.workspace_id` to that row's own workspace, so no write is ever
   * untenanted.
   *
   * Attribution: the lease's holder, falling back to the workspace owner — the
   * same answer `childStatusCascadeService` gives for a background status write.
   * A status change is signed by somebody in this product, and a lease whose
   * holder was deleted is one of the cases this sweep exists for.
   */
  async releaseExpired(
    now: Date = new Date(),
    batchSize: number = PLAN_TARGET_LOCK_SWEEP_BATCH_SIZE,
  ): Promise<{ released: number; entries: PlanTargetLockSweepEntry[] }> {
    const expired = await withSystemContext((tx) =>
      planTargetLockRepository.listExpired(now, batchSize, tx),
    );
    if (expired.length === 0) return { released: 0, entries: [] };

    const entries: PlanTargetLockSweepEntry[] = [];
    for (const lock of expired) {
      // ⚠️ A WAITING SESSION'S LOCK NEVER EXPIRES (MOTIR-7912). A session that is
      // failed-waiting or awaiting its person is not a dead author — a person is
      // coming back — so its leases, and those of the plan it is writing, are spared
      // however old they are. Without this the cards of a session waiting to resume
      // would be reclaimable within the lease window and the resume would lose them.
      const waiting = await withWorkspaceServiceContext(lock.workspaceId, (tx) =>
        waitingCauseOf(lock, tx),
      );
      if (waiting.cause) {
        entries.push({ workItemId: lock.workItemId, outcome: 'session_waiting' });
        continue;
      }
      // ⚠️ A `planned` PLAN'S LOCK NEVER EXPIRES (MOTIR-5647; AMENDMENT 16 D9).
      //
      // The lease is a DEAD-AUTHOR detector: it exists because a planner that
      // crashes leaves a plan `generating` with no terminal event, so the only
      // signal left is the passage of time. A plan that reached `planned` is not
      // that case — it is waiting for a PERSON, a review queue has no deadline,
      // and its release is the decision itself (D6 / D8).
      //
      // Without this, a plan sitting in review for longer than the window would
      // have its targets swept out from under it and become claimable while a
      // reviewer was still deciding, which is the exact failure the park exists
      // to prevent. The card would then be built from the shape the plan is
      // replacing.
      //
      // A `generating` plan still expires, which is the whole point of D9.
      if (lock.planId) {
        const planStatus = await withWorkspaceServiceContext(lock.workspaceId, async (tx) => {
          const plan = await planRepository.findById(lock.planId!, lock.workspaceId, tx);
          return plan?.status ?? null;
        });
        // ⚠️ AND A `stale` PLAN'S LOCK NEVER EXPIRES EITHER (MOTIR-6265; AMENDMENT
        // 21 §4). `stale` is NOT decided — it waits for a person exactly as
        // `planned` does — and without this, a plan that drifted while a reviewer
        // had it open would have its targets swept back to claimable after the
        // window: the failure the park exists to prevent, by the one status D9
        // forgot to name.
        if (planStatus === 'planned' || planStatus === 'stale') {
          entries.push({ workItemId: lock.workItemId, outcome: 'plan_awaiting_review' });
          continue;
        }
      }
      // ⚠️ AND A SESSION WHOSE PLAN WAITS FOR A PERSON KEEPS ITS LOCK (MOTIR-8467).
      // A conversation's plan parks nothing of its own — the SESSION holds the
      // target, so the row's `planId` is null and the arm above never looks the
      // plan up. A session lease is refreshed only by a turn, and neither a hosted
      // walk nor the person's review makes one, so without this the card went back
      // to the ready set half an hour after the last submit while its plan was
      // still in review. Any `planned` / `stale` plan of the session spares it.
      //
      // ⚠️ AND SO DOES A `generating` PLAN THAT IS STILL WRITING (MOTIR-9260). A
      // hosted walk routinely outlives the session lease after the person's last
      // turn, and its item writes refresh the PLAN, never the lease — so the card
      // left Planning mid-walk and the finished plan landed in review with its
      // target already claimable. A `generating` plan is judged by its SILENCE, the
      // rule the abandoned-plan sweep and the rail already use: written within
      // `PLAN_STALLED_AFTER_MS` is a live author and spares the lock; silent past it
      // is the dead-author case, and the lock expires as before.
      if (lock.sessionId) {
        const awaiting = await withWorkspaceServiceContext(lock.workspaceId, (tx) =>
          planRepository.countAwaitingDecisionBySession(lock.sessionId!, null, tx),
        );
        if (awaiting > 0) {
          entries.push({ workItemId: lock.workItemId, outcome: 'plan_awaiting_review' });
          continue;
        }
        const writing = await withWorkspaceServiceContext(lock.workspaceId, (tx) =>
          planRepository.countWritingBySession(
            lock.sessionId!,
            new Date(now.getTime() - PLAN_STALLED_AFTER_MS),
            tx,
          ),
        );
        if (writing > 0) {
          entries.push({ workItemId: lock.workItemId, outcome: 'plan_generating' });
          continue;
        }
      }
      // Resolve the signer in ITS OWN workspace-bound read, then release in a
      // second bound transaction. Two short transactions rather than one bare one
      // that binds mid-flight: the workspace is already known here (it came off
      // the lease), so there is nothing a mid-block bind would buy, and a bound
      // wrapper is the shape every other tenant write in this codebase has.
      const actorId = await withWorkspaceServiceContext(lock.workspaceId, async (tx) => {
        const owner = await workspaceMembershipRepository.findStandInManagerByWorkspace(
          lock.workspaceId,
          tx,
        );
        return lock.heldById ?? owner?.userId ?? null;
      });

      if (!actorId) {
        // Nobody to sign the restore with. Still drop the lease — a held item
        // nobody can plan is the failure this sweep exists for, and leaving the
        // row would preserve it in order to protect a status nobody can attribute.
        await withWorkspaceServiceContext(lock.workspaceId, (tx) =>
          planTargetLockRepository.deleteById(lock.id, tx),
        );
        entries.push({ workItemId: lock.workItemId, outcome: 'unattributable' });
        continue;
      }

      const actor: ServiceContext = { userId: actorId, workspaceId: lock.workspaceId };
      const outcome = await withWorkspaceContext(
        { userId: actorId, workspaceId: lock.workspaceId, projectId: lock.projectId },
        async (tx) => {
          // RE-READ under the transaction that will act. The row was chosen from
          // a snapshot taken in a different transaction, and the session may have
          // released it in between — a sweep that deletes on a stale read raises
          // P2025 on a lease somebody already gave back.
          const fresh = await planTargetLockRepository.findByWorkItemId(lock.workItemId, tx);
          if (!fresh || fresh.id !== lock.id) return 'left_as_is' as const;
          return releaseOne(fresh, actor, tx, { system: true });
        },
      );
      entries.push({ workItemId: lock.workItemId, outcome });
    }
    return {
      released: entries.filter(
        (e) => e.outcome !== 'session_waiting' && e.outcome !== 'plan_generating',
      ).length,
      entries,
    };
  },
};
