import 'server-only';

import { randomUUID } from 'node:crypto';
import {
  adminAssignTier,
  adminWriteCredits,
  getAdminLedger,
  MOTIR_AI_REQUEST_TIMEOUT_MS,
} from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiConflictError,
  MotirAiInsufficientBalanceError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import type { AdminActor, AdminCreditKind } from '@/lib/ai/types';
import type {
  PlatformCreditLedgerPageDTO,
  PlatformCreditWriteDTO,
  PlatformPlanSetDTO,
} from '@/lib/dto/platformCreditOps';
import {
  toPlatformCreditLedgerPageDTO,
  toPlatformCreditWriteDTO,
  toPlatformPlanSetDTO,
} from '@/lib/mappers/platformCreditOpsMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import {
  PlatformCreditAmountInvalidError,
  PlatformCreditConflictError,
  PlatformCreditInsufficientBalanceError,
  PlatformCreditRejectedError,
  PlatformCreditServiceUnavailableError,
  PlatformLargeGrantUnconfirmedError,
  PlatformOrganizationNotFoundError,
} from '@/lib/platform/errors';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';
import { aiPlanGateService, type PaidAiPlanAnswer } from '@/lib/services/aiPlanGateService';

/**
 * CREDIT & PLAN OPS — MOTIR-747 · 10.3.2, the operator side of motir-ai's credit
 * ledger, and the backend of design `platform-admin/design-notes.md` AMENDMENT
 * 2026-10-03 Panels 1–2 (the Operations tab's **Credits & plan** card and its
 * three dialogs).
 *
 * A `superadmin` GRANTS credits (a positive `grant` row — goodwill, a support
 * credit), ADJUSTS a balance (a signed `adjustment` row — a billing correction)
 * and assigns an org's PLAN TIER; any staff role READS the balance, the tier and
 * the ledger. The ledger lives only in motir-ai (`POST /v1/admin/credits`,
 * `POST /v1/admin/tier`, `GET /v1/admin/ledger`); core holds no billing table and
 * no Prisma for billing — this file reads Prisma only to confirm the org exists
 * and to name the actor.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING, AND WHY THE REMOTE WRITE IS INSIDE THE AUDITED TRANSACTION
 * ---------------------------------------------------------------------------
 * The `platformPlannerModelService.setModel` shape, for the same reason: the
 * design's rule 6 is that *"the write and its audit row share one outcome — a
 * refusal or an unreachable credit service leaves neither"*. So:
 *
 *   1. `superadmin`, then the AMOUNT and the REASON, all before anything is
 *      sent or written — `withPlatformRead` writes the audit row as its first
 *      statement, so a check made later would be made after its row existed.
 *   2. The balance / tier the operator is acting on, read through the client
 *      (`GET /v1/admin/ledger?limit=1`), so the row's `metadata` can say
 *      before → after (or from → to). An adjustment that would overdraw it is
 *      refused here, before the trail is touched. This read is the write's own
 *      preamble and leaves no row of its own; a refused write leaves none either.
 *   3. The audited transaction: the org is re-read under the platform context
 *      (an unknown org is refused BEFORE motir-ai is asked, because motir-ai
 *      PROVISIONS an org it has never seen on a write), the large-grant typed
 *      confirm is checked against the org's slug, and motir-ai's write runs
 *      last. Any refusal it answers rolls the audit row back with it.
 *
 * ⚠️ THE RESIDUAL CASE, named rather than hidden (the planner model's): motir-ai
 * applies the write and core's commit then fails. The ledger has moved and the
 * trail has no row. Here — unlike the planner model — it is RECOVERABLE: every
 * write carries a `requestId`, motir-ai is idempotent on it, and a retry of the
 * same action with the same `requestId` replays the stored row (`idempotent:
 * true`, nothing new written) while THIS side writes the audit row it owes. The
 * residual case is logged with the `requestId` so it can be retried by hand.
 * The converse — a double-submit of an action that DID land — writes a second
 * audit row for one ledger row; both carry the same `requestId`, which is what
 * makes the pair recognisable as one action.
 *
 * ⚠️ AND THE CHAIN LOCK IS HELD ACROSS THE REMOTE CALL. `withPlatformRead` takes
 * the audit chain's lock first, so every other platform transaction waits while
 * motir-ai answers. That is the price of the shared outcome; the interactive
 * transaction's budget is raised to cover the client's own deadline so a slow but
 * successful answer is not turned into a rollback by Prisma's 5 s default.
 */

/**
 * A grant at or above this many credits needs the org's slug typed back to
 * confirm (design Panel 2b; the open question MOTIR-747 owns). 10,000 is the
 * design's proposal: half the Team allotment, above any routine goodwill credit.
 */
export const LARGE_GRANT_THRESHOLD_CREDITS = 10_000;

/** The ledger's page size on the card — the design's "25 a page in code". */
export const CREDIT_LEDGER_PAGE_SIZE = 25;

/** The ledger stores credits as a 32-bit integer (motir-ai's `MAX_INT32` boundary). */
export const MAX_CREDITS_PER_OPERATION = 2_147_483_647;

/** motir-ai's own ceiling on a `requestId`. */
const MAX_REQUEST_ID_LENGTH = 150;

/** The interactive-transaction budget for a transaction that waits on motir-ai. */
const REMOTE_TX_TIMEOUT_MS = MOTIR_AI_REQUEST_TIMEOUT_MS + 5_000;

/** A fresh idempotency key for one operator action. */
export function newCreditOpRequestId(): string {
  return `adm_${randomUUID()}`;
}

/** What a grant takes. */
export interface GrantCreditsInput {
  /** A positive whole number. */
  credits: number;
  reason: string;
  /**
   * The action's idempotency key. The dialog mints one when it opens and sends
   * the same one on a retry, so a retry after a lost answer cannot grant twice.
   * Omitted → a fresh one (a caller with no retry of its own).
   */
  requestId?: string | null;
  /** The org's slug, typed back — required at or above `LARGE_GRANT_THRESHOLD_CREDITS`. */
  confirmSlug?: string | null;
}

/** What an adjustment takes. */
export interface AdjustCreditsInput {
  /** A signed, non-zero whole number. Negative removes credits. */
  credits: number;
  reason: string;
  requestId?: string | null;
}

/** What a plan change takes. */
export interface SetPlanInput {
  /** A `PlanTier.key` motir-ai knows (`free`, `standard`, `pro`, …). */
  tierKey: string;
  reason: string;
  requestId?: string | null;
}

/** Translate a motir-ai client error into the console's typed refusal. */
function translateRemote(err: unknown, credits: number | null): unknown {
  if (err instanceof MotirAiInsufficientBalanceError) {
    return new PlatformCreditInsufficientBalanceError(credits ?? 0, null);
  }
  if (err instanceof MotirAiConflictError) return new PlatformCreditConflictError(err.detail);
  if (err instanceof MotirAiBadRequestError) return new PlatformCreditRejectedError(err.message);
  if (
    err instanceof MotirAiUnavailableError ||
    err instanceof MotirAiConfigError ||
    err instanceof MotirAiUnauthorizedError
  ) {
    return new PlatformCreditServiceUnavailableError(err.message);
  }
  return err;
}

function resolveRequestId(requested: string | null | undefined): string {
  const trimmed = requested?.trim();
  if (!trimmed) return newCreditOpRequestId();
  if (trimmed.length > MAX_REQUEST_ID_LENGTH) {
    throw new PlatformCreditRejectedError(`requestId is longer than ${MAX_REQUEST_ID_LENGTH}`);
  }
  return trimmed;
}

function assertAmount(kind: AdminCreditKind, credits: number): void {
  const valid =
    Number.isInteger(credits) &&
    Math.abs(credits) <= MAX_CREDITS_PER_OPERATION &&
    (kind === 'grant' ? credits > 0 : credits !== 0);
  if (!valid) throw new PlatformCreditAmountInvalidError(kind, credits);
}

/** The actor label motir-ai stores on the row: `Name <email>`, or the email alone. */
async function actorFor(principal: PlatformPrincipal): Promise<AdminActor> {
  // Reference data (CLAUDE.md: a read of unrelated reference data needs no
  // transaction) — the operator's own display name, captured at the time.
  const user = await userRepository.findById(principal.userId);
  const name = user?.name?.trim();
  return {
    userId: principal.userId,
    label: name ? `${name} <${principal.email}>` : principal.email,
  };
}

/**
 * The balance and tier the operator is acting on — step 2 of the ordering above.
 * One ledger row is enough: the answer carries the balance and tier whatever the
 * page size.
 */
async function readCurrent(organizationId: string) {
  try {
    return await getAdminLedger({ coreOrganizationId: organizationId, limit: 1 });
  } catch (err) {
    throw translateRemote(err, null);
  }
}

/** Log the residual case — motir-ai applied a write whose audit row did not commit. */
function logUnrecordedWrite(
  what: string,
  organizationId: string,
  principal: PlatformPrincipal,
  requestId: string,
  err: unknown,
): void {
  // A CONSTANT format string first: every value is an argument, never part of
  // the format (CodeQL js/tainted-format-string).
  console.error(
    '[platform-credit-ops] motir-ai applied %s on organization %s by %s (requestId %s), but the audit row did not commit — retry the same action with the same requestId to record it',
    what,
    organizationId,
    principal.userId,
    requestId,
    err,
  );
}

async function writeCredits(
  principal: PlatformPrincipal,
  organizationId: string,
  kind: AdminCreditKind,
  input: GrantCreditsInput,
): Promise<PlatformCreditWriteDTO> {
  await requirePlatformStaff('superadmin');
  assertAmount(kind, input.credits);
  const base = {
    action: kind === 'grant' ? ('org.credit_grant' as const) : ('org.credit_adjust' as const),
    targetKind: 'organization' as const,
    targetId: organizationId,
    organizationId,
    reason: input.reason,
  };
  assertReasonSatisfied(base);
  const reason = input.reason.trim();
  const requestId = resolveRequestId(input.requestId);

  const current = await readCurrent(organizationId);
  const balanceBefore = current.balanceCredits;
  const balanceAfter = balanceBefore + input.credits;
  if (kind === 'adjustment' && balanceAfter < 0) {
    throw new PlatformCreditInsufficientBalanceError(input.credits, balanceBefore);
  }
  const actor = await actorFor(principal);

  const entry: PlatformAuditEntry = {
    ...base,
    reason,
    metadata: { requestId, credits: input.credits, balanceBefore, balanceAfter },
  };
  let applied = false;
  try {
    const result = await withPlatformRead(
      principal,
      entry,
      async (tx) => {
        const org = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
        if (!org) throw new PlatformOrganizationNotFoundError(organizationId);
        if (
          kind === 'grant' &&
          input.credits >= LARGE_GRANT_THRESHOLD_CREDITS &&
          input.confirmSlug?.trim() !== org.slug
        ) {
          throw new PlatformLargeGrantUnconfirmedError(
            input.credits,
            LARGE_GRANT_THRESHOLD_CREDITS,
          );
        }
        const written = await adminWriteCredits({
          coreOrganizationId: organizationId,
          kind,
          credits: input.credits,
          reason,
          requestId,
          actor,
        });
        applied = true;
        return written;
      },
      { timeoutMs: REMOTE_TX_TIMEOUT_MS },
    );
    if (!result.idempotent && result.balanceCredits !== balanceAfter) {
      // Another ledger write (a debit, a top-up) landed between the read and
      // this one. The write still stands — the amount is what the operator
      // chose — and the row's balances are the ones the operator SAW.
      console.warn(
        '[platform-credit-ops] %s on %s: expected balance %s, motir-ai answered %s (requestId %s)',
        kind,
        organizationId,
        balanceAfter,
        result.balanceCredits,
        requestId,
      );
    }
    return toPlatformCreditWriteDTO(organizationId, result, requestId);
  } catch (err) {
    if (applied)
      logUnrecordedWrite(
        `a ${kind} of ${input.credits}`,
        organizationId,
        principal,
        requestId,
        err,
      );
    throw translateRemote(err, input.credits);
  }
}

export const platformCreditOpsService = {
  /**
   * The CREDITS & PLAN card's read — balance, tier, the latest staff plan change
   * and one page (25) of the ledger, newest first. Any staff role reads it
   * (design Panel 8c: operator / support see the card read-only).
   *
   * An audited `estate.read` on the org, like every other org-page read. The
   * remote read runs inside the transaction, so an unreachable credit service
   * rolls the row back with it: nothing was read, so nothing is recorded.
   *
   * @param cursor the previous page's `nextCursor`, or omitted for the newest page.
   * @throws NotPlatformStaffError for a non-staff caller.
   * @throws PlatformOrganizationNotFoundError for an id that names no org.
   * @throws PlatformCreditServiceUnavailableError when motir-ai cannot answer —
   *   the card renders design Panel 8b ("Couldn't load credits"), never zeros.
   * @throws PlatformCreditRejectedError for a cursor motir-ai did not hand out.
   */
  /**
   * Does the paid-AI-plan gate count this org as paid? The plan dialog's
   * warning reads it (bug MOTIR-8985): Change plan sets a tier, never the
   * classification the fleet, hosted repositories and agents are gated on, so an
   * admin about to move an unpaid org onto Pro is told it will still be refused.
   * The answer is the gate's own ({@link aiPlanGateService.hasPaidAiPlan}) — never
   * re-derived here — so the dialog and the doors cannot disagree. Never throws
   * past the staff check: an unreadable plan is `'unknown'`.
   */
  async paidAiPlanAnswer(organizationId: string): Promise<PaidAiPlanAnswer> {
    await requirePlatformStaff('support');
    return aiPlanGateService.hasPaidAiPlan(organizationId);
  },

  async getLedger(
    principal: PlatformPrincipal,
    organizationId: string,
    cursor: string | null = null,
  ): Promise<PlatformCreditLedgerPageDTO> {
    await requirePlatformStaff('support');
    try {
      const read = await withPlatformRead(
        principal,
        {
          action: 'estate.read',
          targetKind: 'organization',
          targetId: organizationId,
          organizationId,
          metadata: { surface: 'credit_ledger', cursor },
        },
        async (tx) => {
          const org = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
          if (!org) throw new PlatformOrganizationNotFoundError(organizationId);
          return getAdminLedger({
            coreOrganizationId: organizationId,
            limit: CREDIT_LEDGER_PAGE_SIZE,
            cursor,
          });
        },
        { timeoutMs: REMOTE_TX_TIMEOUT_MS },
      );
      return toPlatformCreditLedgerPageDTO(organizationId, read, LARGE_GRANT_THRESHOLD_CREDITS);
    } catch (err) {
      throw translateRemote(err, null);
    }
  },

  /**
   * GRANT credits — a positive `grant` row (design Panel 2a/2b). Audited as
   * `org.credit_grant` with `{ requestId, credits, balanceBefore, balanceAfter }`.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws PlatformCreditAmountInvalidError for a non-positive / non-integer / out-of-range amount.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlatformOrganizationNotFoundError for an id that names no org.
   * @throws PlatformLargeGrantUnconfirmedError at or above the threshold without the slug.
   * @throws PlatformCreditConflictError / PlatformCreditRejectedError / PlatformCreditServiceUnavailableError from motir-ai.
   */
  async grantCredits(
    principal: PlatformPrincipal,
    organizationId: string,
    input: GrantCreditsInput,
  ): Promise<PlatformCreditWriteDTO> {
    return writeCredits(principal, organizationId, 'grant', input);
  },

  /**
   * ADJUST the balance — a signed, non-zero `adjustment` row (design Panel 2c).
   * The balance may not go below zero: refused here against the balance the
   * operator saw, and by motir-ai under its ledger lock. Audited as
   * `org.credit_adjust`, same metadata shape as a grant.
   *
   * @throws PlatformCreditInsufficientBalanceError when it would overdraw.
   * @throws (otherwise as `grantCredits`, without the large-grant confirm).
   */
  async adjustCredits(
    principal: PlatformPrincipal,
    organizationId: string,
    input: AdjustCreditsInput,
  ): Promise<PlatformCreditWriteDTO> {
    return writeCredits(principal, organizationId, 'adjustment', input);
  },

  /**
   * CHANGE PLAN — assign the org's `PlanTier` (design Panel 2d). Grants nothing
   * (a tier's allotment arrives with its billing cycle) and touches no Stripe
   * object. ⚠️ The open question the design left to this card, answered by
   * motir-ai's contract: **a paid org's next Stripe subscription event sets its
   * tier from the subscription again**, so on an org paying through Stripe this
   * assignment holds only until that event — which is what the dialog's Stripe
   * warning must say. Assigning the tier the org already holds is not refused:
   * motir-ai records it with `changed: false`, and so does the trail.
   *
   * Audited as `org.plan_set` with `{ requestId, fromTierKey, toTierKey }`.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlatformCreditRejectedError for a blank or unknown `tierKey`.
   * @throws PlatformOrganizationNotFoundError for an id that names no org.
   * @throws PlatformCreditConflictError / PlatformCreditServiceUnavailableError from motir-ai.
   */
  async setPlan(
    principal: PlatformPrincipal,
    organizationId: string,
    input: SetPlanInput,
  ): Promise<PlatformPlanSetDTO> {
    await requirePlatformStaff('superadmin');
    const tierKey = input.tierKey.trim();
    if (!tierKey) throw new PlatformCreditRejectedError('tierKey is required');
    const base = {
      action: 'org.plan_set' as const,
      targetKind: 'organization' as const,
      targetId: organizationId,
      organizationId,
      reason: input.reason,
    };
    assertReasonSatisfied(base);
    const reason = input.reason.trim();
    const requestId = resolveRequestId(input.requestId);

    const current = await readCurrent(organizationId);
    const fromTierKey = current.tier?.key ?? null;
    const actor = await actorFor(principal);

    const entry: PlatformAuditEntry = {
      ...base,
      reason,
      metadata: { requestId, fromTierKey, toTierKey: tierKey },
    };
    let applied = false;
    try {
      const result = await withPlatformRead(
        principal,
        entry,
        async (tx) => {
          const org = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
          if (!org) throw new PlatformOrganizationNotFoundError(organizationId);
          const written = await adminAssignTier({
            coreOrganizationId: organizationId,
            tierKey,
            reason,
            requestId,
            actor,
          });
          applied = true;
          return written;
        },
        { timeoutMs: REMOTE_TX_TIMEOUT_MS },
      );
      return toPlatformPlanSetDTO(organizationId, result, requestId);
    } catch (err) {
      if (applied) logUnrecordedWrite(`plan ${tierKey}`, organizationId, principal, requestId, err);
      throw translateRemote(err, null);
    }
  },
};
