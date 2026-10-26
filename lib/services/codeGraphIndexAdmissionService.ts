import { withSystemContext } from '@/lib/workspaces/context';
import { fleetInFlightSlotRepository as slots } from '@/lib/repositories/fleetInFlightSlotRepository';
import {
  ciFleetAdmissionLockRepository as locks,
  FLEET_ADMISSION_SCOPE,
} from '@/lib/repositories/ciFleetAdmissionLockRepository';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  fleetKillSwitchEngaged,
  indexFleetOnPool,
  indexInFlightCap,
  orgIndexInFlightCap,
} from '@/lib/ciFleet/limits';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import {
  fleetCeilingService,
  describeFleetCensus,
  FLEET_KILL_SWITCH_DETAIL,
  type FleetInFlightCensus,
} from '@/lib/services/fleetCeilingService';

// THE INDEX ADMISSION CAP (Story MOTIR-1981 · MOTIR-1990) — how many code-graph
// index containers may run at once, globally and per tenant, decided under a lock
// before a container is booted.
//
// `docs/decisions/code-graph-index-fleet.md` §7 (decision 6) and §7.2 (the
// correction that says what this is and is not).
//
// ── WHY A CAP AT ALL ────────────────────────────────────────────────────────
// Without one, a workspace connecting N repos boots N containers and two
// workspaces doing it at once boot N+M. Two things break, and they are different
// failures with different owners:
//
//   * COST. Every container bills the shared fleet org, and §7.2 established
//     that Fly offers NEITHER a spending cap NOR a billing alert — there is
//     nothing but Motir's own counter in front of the invoice.
//   * FAIRNESS. One tenant's burst delays every other tenant. Measured, not
//     theorised: a global unkeyed `concurrency: 2` on the job meant one
//     workspace's five repos occupied the lane while another workspace's FIRST
//     index queued behind all of it.
//
// ── THE LAYERING, AND WHAT THIS FILE IS NOT ─────────────────────────────────
// `docs/decisions/fleet-per-org-pool.md` §7 re-derived it per ORGANISATION
// (MOTIR-6907), and the fleet-capacity decision record MOTIR-9357 took indexing
// off the org pool (MOTIR-9375):
//
//   MOTIR_INDEX_MAX_IN_FLIGHT     → the one Motir-side bound on indexing, which
//                                   nobody is charged for — this file
//   ceil(global / 2)              → index fairness, org vs org — this file
//   MOTIR_FLEET_MAX_IN_FLIGHT=0   → the operator's kill switch — §6
//
// So this gate enforces the two index bounds and nothing else: indexing is held
// to NO plan figure, and an index container takes none of the org's CI or
// hosted-run room. `fleetCeilingService.orgCensus` is still called in-line here,
// from inside this transaction, for the org's index share and the admitted
// verdict's breakdown.

// ── IN THE ORCHESTRATOR, NOT IN INNGEST ─────────────────────────────────────
// It belongs next to the resource it protects. And an Inngest-side per-tenant cap
// would need a KEYED concurrency limit, which `defineJob` discards entirely
// (MOTIR-1982) — so the substrate cannot express it today. That bug is not a
// blocker here and must not become one: the cap is being put somewhere that can
// hold it, rather than waiting for the place that cannot.
//
// ── ONE LOCK, AND WHY ONLY ONE ──────────────────────────────────────────────
// Everything read below is a read-derived write (`notes.html` #35; the CLAUDE.md
// lock-before-read-derived-update contract): count, decide, take, in ONE
// transaction with `FLEET_ADMISSION_SCOPE` held `FOR UPDATE`. That row is the
// same one every CI admission and every `fleetCeilingService.reserve` takes,
// which is what makes the per-organisation index share exact.
//
// There is deliberately NO second, per-organisation lock. The fleet scope is
// GLOBAL, so holding it already serializes every admission in the system,
// including two from the same organisation — a tenant-scoped anchor would add a
// lock-ordering constraint and buy nothing. MUTATION-CHECK IT: delete the `lockScope`
// call and `tests/ciFleet/codeGraphIndexAdmission.test.ts`'s race cases must go
// red.
//
// ── FAIL CLOSED ─────────────────────────────────────────────────────────────
// If a count cannot be established, DO NOT BOOT — the same
// posture as `fleetCeilingService`, for the same reason: a deferred index is
// recoverable (the caller waits and asks again, and nothing is dropped), a
// container nothing bounds is not.
//
// ── NO BYPASS ───────────────────────────────────────────────────────────────
// `isMeta` does not lift any of these, and neither does self-hosting. §8 puts
// meta's OWN index containers on this same fleet through this same code, so a
// meta bypass would mean the tested path is the one nobody runs — and §9.1 is
// explicit that `isMeta` decides whether a cost is CHARGED, never whether work
// runs somewhere else. There is deliberately no tenant-shaped argument here
// beyond attribution.

/** The workload every decision in this file is about. */
const CODE_GRAPH_INDEX_WORKLOAD = 'code_graph_index' satisfies FleetWorkloadKind;

// ── THE INDEXER'S FLY↔AWS SWITCH (MOTIR-9445) ───────────────────────────────
// `fleetKindOnPool('code_graph_index')` reads `MOTIR_INDEX_FLEET_PROVIDER` per
// job through this reader. Wired where the indexer's admission lives, because
// that is the one caller that places an index; it moves no other kind.
wireFleetKindSwitch(CODE_GRAPH_INDEX_WORKLOAD, indexFleetOnPool);

/** What a `pool_full` deferral says. */
const INDEX_POOL_FULL_DETAIL =
  "every account of the indexer's pool is full — the index waits for a container to finish";

/**
 * How much longer than the container's own hard kill the slot keeps counting.
 *
 * The slot's `expires_at` is a SAFETY NET for a release that never runs, and the
 * one direction it must never err in is SHORT: a TTL under the container's real
 * life stops counting a container that is still running and spending, which lets
 * the pool be exceeded. So the container's timeout plus the boot deadline plus
 * a settle margin, rounded up — never the timeout alone.
 */
const SLOT_TTL_MARGIN_SECONDS = 300;

/** Why an index container was not admitted. Every one of these means WAIT — the
 *  caller queues and asks again. None of them means "drop this index". */
export type IndexAdmissionDeferralReason =
  /** The organisation has no paid AI plan, or it could not be read (MOTIR-6909).
   *  ⚠️ `ai_plan_required` is the ONE reason here that does not mean wait
   *  (MOTIR-8235): no container finishing changes an organisation's plan, so
   *  `waitForAdmission` returns it on the first refusal and the index job
   *  records it as a pause. `plan_unknown` is a transient and waits. */
  | 'ai_plan_required'
  | 'plan_unknown'
  /** ANOTHER RUN is already indexing this (repo × project) — MOTIR-2160. Not a
   *  cap at all: the unit of work is taken, and a second container for it would
   *  be waste at best and a stale pointer at worst. Waiting is exactly right —
   *  the holder is minutes from settling, and the wait ends with THIS run
   *  indexing the newer head. */
  | 'repo_index_in_flight'
  /** This organisation already holds `ceil(global / 2)` index containers
   *  (MOTIR-6907, `fleet-per-org-pool.md` §7). Its own burst is being paced so
   *  another org's first index is not stuck behind it. */
  | 'org_index_cap'
  /** Indexing as a whole is at its configured global cap. */
  | 'index_cap'
  /** The indexer is on its pool of accounts and every one of them is full,
   *  paused or empty (MOTIR-9445). The index waits; it is never sent to Fly. */
  | 'pool_full'
  /** The operator's kill switch is engaged (`MOTIR_FLEET_MAX_IN_FLIGHT=0`). */
  | 'fleet_ceiling'
  /** The gate itself could not decide. FAIL-CLOSED: an unestablished count is
   *  treated as a full pool, never an empty one. */
  | 'gate_unavailable';

/**
 * A GRANTED admission — the slot is taken and this caller owes the release.
 *
 * ⚠️ JSON-SERIALIZABLE BY CONTRACT, like `IndexSession`: it crosses a
 * `ctx.step.run` boundary, so every instant is an ISO string.
 *
 * It is a value rather than a boolean because `bootIndexContainer` REQUIRES one
 * as a parameter — the same trick the repository layer uses with `tx` (CLAUDE.md:
 * *"required so TypeScript catches missing-tx bugs"*). Booting an index container
 * without having gone through this gate is a compile error, not a code review.
 */
export interface IndexAdmission {
  /** The `fleet_in_flight_slot` ref this container holds. */
  readonly slotRef: string;
  /** ISO-8601 — when the slot was taken. */
  readonly admittedAt: string;
  /** What the fleet looked like at admission, for the operator's log. */
  readonly detail: string;
  /**
   * The fleet account (`fleet_shard.id`) the container boots on — the same
   * account recorded on the slot row (MOTIR-9445), so boot, poll, settle and
   * reap address ONE account's orchestrator. Absent or null: the process-wide
   * fleet (the indexer's switch is Fly). A memo written before this field
   * existed carries none, which reads as Fly, and so does its slot row.
   */
  readonly shardId?: string | null;
}

export type IndexAdmissionVerdict =
  /** Admitted AND the slot is TAKEN — decided and claimed in one transaction. */
  | { outcome: 'admitted'; admission: IndexAdmission; census: FleetInFlightCensus }
  /**
   * THIS RUN already holds the slot for this (repo × project). NOT an error and
   * NOT a refusal: a redelivered job or a replayed step must not occupy two slots
   * for one container, and it must not be refused capacity it is already holding
   * — that would make the caller tear down a live container to honour a refusal.
   *
   * ⚠️ SCOPED TO THE RUN SINCE MOTIR-2160. It used to mean "somebody holds it",
   * which is the same sentence for a replay of this run and for a SECOND run that
   * has no capacity of its own — and the second read admitted a container past
   * every cap. A different holder is now `deferred` / `repo_index_in_flight`.
   */
  | { outcome: 'already_held'; admission: IndexAdmission }
  /** Not admitted, nothing written. The caller WAITS and asks again. */
  | { outcome: 'deferred'; reason: IndexAdmissionDeferralReason; detail: string };

export interface IndexAdmissionRequest {
  /** The (repo × project) this container will index. */
  readonly projectId: string;
  /** `owner/name`. */
  readonly repoRef: string;
  /**
   * WHICH DISPATCH IS ASKING (MOTIR-2160) — the triggering event's id, the same
   * identity `defineJob` correlates the ledger row by and the one MOTIR-2002
   * chose for this problem on the CI fleet.
   *
   * That it is FIXED for a run and DIFFERENT for the next one is the whole point:
   * it is what lets a deterministic slot key mean "one unit of index work"
   * without also meaning "one caller". A request whose dispatch already holds the
   * slot is a replay and keeps its capacity; a request from another dispatch
   * finds the work taken and waits.
   *
   * ⚠️ THE EVENT'S ID, NOT `ctx.runId` — deliberately, and the difference is
   * testable. `ctx.runId` is read at the top of the handler, and Inngest
   * re-invokes that handler from the top at every step boundary; the ledger's own
   * `eventId` derivation (`event.id ?? ctx.runId`) already prefers the event for
   * exactly that reason. `@inngest/test` makes the consequence visible — it mints
   * a FRESH runId per pass, so a `runId`-owned slot is taken by one pass and
   * unrecognisable to the next. An ownership rule the suite cannot express is one
   * nothing defends.
   */
  readonly dispatchId: string;
  /** Attribution. */
  readonly workspaceId: string;
  /** The key the per-organisation index share counts on. */
  readonly organizationId: string;
  /**
   * The container's own hard kill, in ms — the slot's TTL is derived from it.
   * Pass the workload's REAL timeout: a shorter one under-counts a container that
   * is still spending.
   */
  readonly containerTimeoutMs: number;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/**
 * What an EXISTING slot for this (repo × project) means for the run that just
 * asked for it (MOTIR-2160) — the one place the two readings of a held slot are
 * told apart, so the take path and the lost-race path cannot drift.
 *
 * ⚠️ AN UNOWNED ROW (`owner_ref IS NULL`) DEFERS. It was taken before this
 * column existed, so it belongs to a run this one cannot identify — and the
 * question here is whether to boot a SECOND container against a live one. The
 * asymmetry with `releaseOwned`, which does treat NULL as releasable, is
 * deliberate and points the same way both times: never run two containers for
 * one unit of work, never under-count one that is running. It costs at most the
 * holder's remaining TTL, once, on the deploy that ships this column.
 */
function heldVerdict(
  held: { claimedAt: Date; ownerRef: string | null; fleetShardId: string | null },
  slotRef: string,
  dispatchId: string,
): IndexAdmissionVerdict {
  const takenAt = held.claimedAt.toISOString();
  if (held.ownerRef === dispatchId) {
    return {
      outcome: 'already_held',
      admission: {
        slotRef,
        admittedAt: takenAt,
        detail: `this dispatch already holds the index slot for this (repo × project), taken at ${takenAt}`,
        // The account the held slot was admitted onto — a replay must reach the
        // same orchestrator the container booted on (MOTIR-9445).
        shardId: held.fleetShardId,
      },
    };
  }
  return {
    outcome: 'deferred',
    reason: 'repo_index_in_flight',
    detail:
      `another dispatch is already indexing this (repo × project) — ` +
      `slot taken at ${takenAt} by ${held.ownerRef ?? 'a dispatch that predates owner tracking'}`,
  };
}

/**
 * The slot key for one index container: `<projectId>:<repoRef>`.
 *
 * DETERMINISTIC, and NOT run-scoped — it names the WORK, never the worker. The
 * unit of index work is one (repo × project) — §6's ledger contract forces one
 * container per repo, and `resolveIndexTarget` fans out per project — so this key
 * names exactly one container's worth of capacity. Because the slot table's
 * uniqueness is `(workload, ref)`, that makes the take IDEMPOTENT across a
 * redelivery, an Inngest replay and a job retry: the second attempt finds the row
 * already there instead of occupying a second slot for the same container. A
 * run-scoped KEY would give every retry its own slot and turn the cap into a
 * number the retries walk past.
 *
 * ⚠️ WHAT THIS KEY ALONE CANNOT DECIDE, AND WHERE THAT IS DECIDED (MOTIR-2160).
 * It says a slot for this work is taken; it does not say BY WHOM. Nothing else
 * in the system said either — `system.code-graph-refresh`'s 2-minute debounce
 * coalesces pushes inside one window and does nothing once a run has started,
 * while an index of a large tree runs for minutes, so a second run for the same
 * repo is ordinary, not exotic. Reading a held slot as "mine" therefore let that
 * second run boot a container judged against NONE of the three caps, and let
 * whichever run settled first delete a row the other's live container was still
 * spending against.
 *
 * The fix keeps the key repo-scoped and puts the RUN on the row instead
 * (`fleet_in_flight_slot.owner_ref`), which is what makes both questions
 * answerable at once: {@link codeGraphIndexAdmissionService.admit} compares the
 * holder against the asking run — the same run keeps its capacity, a different
 * one waits — and the release is ownership-checked
 * (`fleetInFlightSlotRepository.releaseOwned`). Adding the run to the KEY would
 * have re-created exactly the walked-past cap described above; adding it as an
 * OWNER does not.
 */
export function indexSlotRef(projectId: string, repoRef: string): string {
  return `${projectId}:${repoRef}`;
}

export const codeGraphIndexAdmissionService = {
  /**
   * Decide whether ONE index container may boot, and TAKE its slot if so.
   *
   * The take is part of the decision rather than a step the caller performs
   * afterwards, and that is what makes the caps exact — MOTIR-1922's claim
   * documents the same load-bearing detail: a gate that decided and let someone
   * else take the slot would be deciding from a count that does not yet include
   * the decisions already made.
   *
   * Never throws. Every refusal is a typed verdict, because every caller is a
   * background dispatch: a throw becomes a job retry, and retrying "the fleet is
   * full" achieves nothing that waiting does not.
   */
  async admit(request: IndexAdmissionRequest, now = new Date()): Promise<IndexAdmissionVerdict> {
    const slotRef = indexSlotRef(request.projectId, request.repoRef);
    const globalCap = indexInFlightCap();
    const orgCap = orgIndexInFlightCap(globalCap);
    const ttlSeconds = Math.ceil(request.containerTimeoutMs / 1000) + SLOT_TTL_MARGIN_SECONDS;

    if (fleetKillSwitchEngaged()) {
      return { outcome: 'deferred', reason: 'fleet_ceiling', detail: FLEET_KILL_SWITCH_DETAIL };
    }
    // The fleet is paid-AI-plan only (MOTIR-6909): plan, then the index caps.
    const refused = await fleetCeilingService.planDeferral(request.organizationId);
    if (refused) return refused;

    try {
      return await withSystemContext(async (tx) => {
        await locks.ensureScope(FLEET_ADMISSION_SCOPE, tx);
        if (!(await locks.lockScope(FLEET_ADMISSION_SCOPE, tx))) {
          throw new Error('the fleet admission lock could not be taken');
        }

        // ── 0a · REAP THE EXPIRED SLOTS, UNDER THE LOCK (MOTIR-3684) ──────────
        // ⚠️ THE TTL IS NOT A SAFETY NET UNTIL SOMETHING ACTS ON IT, AND UNTIL
        // THIS LINE NOTHING DID. `fleetCeilingService.sweepExpired` existed and
        // had NO CALLER anywhere in the repository, so an unreleased slot sat in
        // the table for ever — one row for `moooon-B-V/motir-meta` was still
        // there twenty days after its run ended.
        //
        // That was survivable while the repository's own claim held: *"the count
        // already ignores these rows, so this changes no decision"*. Both counts
        // below DO ignore them (`expiresAt: { gt: now }`). **Step 0b does not** —
        // it reads the row by its key and decides on its mere EXISTENCE — so the
        // claim stopped being true the moment MOTIR-2160 added that read, and
        // nobody noticed because expiry and existence agree until a slot leaks.
        //
        // MEASURED CONSEQUENCE (2026-08-27): a leaked row for
        // `<project>:moooon-B-V/motir-core`, expired 19 hours earlier, refused
        // every `system.code-graph-refresh` of that repo with
        // `repo_index_in_flight` — 60 attempts over ~1.7 hours per run, nine runs
        // that day, a 100% failure rate, and a code graph that silently stopped
        // tracking the repository while the fleet sat at ZERO live containers.
        // The refusal was never a cap: every cap read the live counts and all
        // had room.
        //
        // ⚠️ THE REAP GOES HERE, NOT ON A SCHEDULE, and the placement is the
        // point. Under `FLEET_ADMISSION_SCOPE` every admission in the system is
        // serialized, so a row deleted here cannot be one another admission is
        // deciding on; and this is the one code path that a starved repo is
        // guaranteed to reach, so recovery needs no operator, no cron and no
        // deploy of its own. It changes no COUNT — by construction, since both
        // counts already excluded exactly these rows — which is what makes it
        // safe to do fleet-wide rather than for this ref alone: the debris of any
        // workload's crashed dispatcher is capacity nothing is holding.
        await slots.deleteExpired(now, tx);

        // ── 0b · IS THIS WORK ALREADY BEING DONE, AND BY WHOM? (MOTIR-2160) ───
        // A slot held by THIS run is not a new container, so it is not judged
        // against any cap — see the verdict's own comment. A slot held by ANOTHER
        // run is a live container doing this exact work, and the caller must WAIT
        // rather than boot a second one: the ownership test is the difference
        // between an idempotent replay and an overlap, and reading it as the
        // former was how a second run reached a boot having consulted none of the
        // bounds below.
        const held = await slots.findByRef(CODE_GRAPH_INDEX_WORKLOAD, slotRef, tx);
        if (held) return heldVerdict(held, slotRef, request.dispatchId);

        // The org's census: `byWorkload.code_graph_index` IS the org's index
        // share, and the rest is the admitted verdict's breakdown.
        const census = await fleetCeilingService.orgCensus(request.organizationId, now, tx);
        const orgIndexInFlight = census.byWorkload[CODE_GRAPH_INDEX_WORKLOAD];
        const indexInFlight = await slots.countLiveForWorkload(CODE_GRAPH_INDEX_WORKLOAD, now, tx);

        // ── 1 · THE PER-ORGANISATION INDEX SHARE — fairness, checked first ─────
        // Most specific reason first: "your organisation is pacing its own
        // burst" is a materially different operator answer from "indexing is
        // full", and the caller's log is the only place the difference survives.
        if (orgIndexInFlight >= orgCap) {
          return {
            outcome: 'deferred' as const,
            reason: 'org_index_cap' as const,
            detail: `the organization is at its index cap (${orgIndexInFlight}/${orgCap}, half of the global ${globalCap})`,
          };
        }

        // ── 2 · THE GLOBAL INDEX CAP — throughput, across every tenant ────────
        if (indexInFlight >= globalCap) {
          return {
            outcome: 'deferred' as const,
            reason: 'index_cap' as const,
            detail: `indexing is at its global cap (${indexInFlight}/${globalCap})`,
          };
        }

        // ── 3 · WHERE IT RUNS — the indexer's account, AFTER every bound ──────
        // (MOTIR-9445). Switch Fly ⇒ no account, the process-wide fleet, exactly
        // as before. Switch on ⇒ the indexer-pool account with the most headroom,
        // counted from the live index slots recorded on each account — read
        // here, under the one admission lock, and written by the take below in
        // the same transaction, so two admissions cannot both claim an account's
        // last unit. Only `code_graph_index` accounts are in the set. No account
        // with room ⇒ `pool_full`: no slot, and never Fly. A pool record that
        // cannot be read throws into the fail-closed catch below.
        const placement = await fleetShardAdmissionService.chooseInTx(
          { fleetKind: CODE_GRAPH_INDEX_WORKLOAD, organizationId: request.organizationId },
          now,
          tx,
        );
        if ('deferred' in placement) {
          return {
            outcome: 'deferred' as const,
            reason: 'pool_full' as const,
            // A Host org's own indexer account is full (MOTIR-9586): its words.
            detail: placement.own ? placement.detail : INDEX_POOL_FULL_DETAIL,
          };
        }

        // ── 4 · TAKE THE SLOT, in the same transaction as the counts above ────
        const took = await slots.take(
          {
            workload: CODE_GRAPH_INDEX_WORKLOAD,
            ref: slotRef,
            ownerRef: request.dispatchId,
            organizationId: request.organizationId,
            workspaceId: request.workspaceId,
            fleetShardId: placement.shardId,
            expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
          },
          tx,
        );
        // The insert raced a transaction that committed the same ref between the
        // read above and here. The slot exists exactly once either way — but WHOSE
        // it is decides whether this caller may boot, so the answer comes from the
        // same ownership test as the read above, not from the assumption that a
        // conflict is one's own redelivery (MOTIR-2160). A row we cannot read back
        // is treated as somebody else's: not booting is the recoverable mistake.
        if (!took) {
          const winner = await slots.findByRef(CODE_GRAPH_INDEX_WORKLOAD, slotRef, tx);
          return winner
            ? heldVerdict(winner, slotRef, request.dispatchId)
            : {
                outcome: 'deferred' as const,
                reason: 'repo_index_in_flight' as const,
                detail:
                  'another dispatch took this (repo × project) slot first, ' +
                  'and the winning row could not be read back to identify it',
              };
        }

        return {
          outcome: 'admitted' as const,
          census,
          admission: {
            slotRef,
            admittedAt: now.toISOString(),
            detail:
              `admitted: organization index ${orgIndexInFlight + 1}/${orgCap}, ` +
              `indexing ${indexInFlight + 1}/${globalCap} (${describeFleetCensus(census)})` +
              (placement.shardId ? `, on account ${placement.shardId}` : ''),
            shardId: placement.shardId,
          },
        };
      });
    } catch (err) {
      // FAIL CLOSED. The transaction rolled back, so no slot was taken and no
      // container will boot; the caller waits and asks again.
      console.error(
        '[codeGraphIndexAdmissionService] the index admission gate failed — not booting',
        {
          slotRef,
          organizationId: request.organizationId,
          detail: detailOf(err),
        },
      );
      return {
        outcome: 'deferred',
        reason: 'gate_unavailable',
        detail: `the index in-flight counts could not be established: ${detailOf(err)}`,
      };
    }
  },

  /**
   * Give an index slot back — call this when the container ends, however it
   * ended.
   *
   * ⚠️ ONLY WHEN THE CONTAINER IS REALLY GONE. Releasing a slot whose container
   * may still be running under-counts a container that is still spending, which
   * is the one direction the pool must never err in — so a FAILED teardown
   * deliberately does not release, and the slot's `expires_at` ages it out
   * instead while the reaper does its work.
   *
   * ⚠️ AND ONLY THE DISPATCH THAT TOOK IT MAY GIVE IT BACK (MOTIR-2160).
   * `dispatchId` is not bookkeeping — it is the guard. The slot ref names a
   * (repo × project), so an unchecked delete let one run free capacity belonging
   * to ANOTHER run's live container: the census then under-counted a container that was still spending,
   * and a third dispatch could take the freed row only to have it deleted by the
   * second's settle in turn. A release that owns nothing removes nothing and
   * reports `false`; the real holder's slot ages out through `expires_at` if its
   * own settle never comes.
   *
   * Best-effort by delegation: `fleetCeilingService.release` logs and returns
   * false rather than throwing, because the worst case here is a slot that
   * occupies capacity until its safety net expires — visible and bounded — while
   * a throw would fail a teardown path over a bookkeeping row.
   */
  async release(slotRef: string, dispatchId: string): Promise<boolean> {
    return fleetCeilingService.release(CODE_GRAPH_INDEX_WORKLOAD, slotRef, dispatchId);
  },
};
