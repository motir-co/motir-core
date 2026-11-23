import { checkIndexAllowance } from '@/lib/ai/motirAiClient';
import { indexPauseReasonFor, type IndexPauseReason } from '@/lib/ciFleet/indexAllowance';

// THE INDEX ALLOWANCE ASK (MOTIR-12035) — moved verbatim out of
// `codeGraphIndexDispatchService` so the index handoff (MOTIR-11883) keeps its
// allowance ask now the container dispatch is deleted (MOTIR-12036).

/**
 * The answer to "may this organisation's next index container boot?" — what
 * {@link codeGraphIndexAllowanceService.askIndexAllowance} returns (MOTIR-4593).
 *
 * JSON-serializable: the job memoizes it in a step, so a replay pass acts on the
 * answer the first pass got rather than asking again mid-run.
 */
export type IndexAllowanceAsk =
  | {
      proceed: true;
      /** The verdict that let it boot; `null` when the allowance could not be
       *  asked, or was not asked because this run's container was already booted. */
      outcome: string | null;
    }
  | { proceed: false; outcome: string; reason: IndexPauseReason };

export const codeGraphIndexAllowanceService = {
  /**
   * ASK THE INDEX ALLOWANCE BEFORE ANYTHING BOOTS (MOTIR-4593 · Story MOTIR-4335).
   *
   * Only a HARD STOP refuses (`isIndexHardStop` — the outcome FAMILY, so a stop
   * motir-ai adds later is refused with no change here). `soft_gate_crossed`
   * BOOTS: a paid tier past its allowance keeps indexing and motir-ai records the
   * crossing. `exempt` (a meta organisation) and `no_allowance_configured` boot.
   *
   * ⚠️ NO ENTITLEMENT CHECK (decision A, MOTIR-4541). On cloud every connected
   * repository is indexed; nothing here asks whether the organisation has an AI
   * plan or has ever run an AI job. motir-ai provisions its billing identity on
   * the ask itself.
   *
   * ⚠️ "COULD NOT ASK" BOOTS. The client returns `null` for an unreachable,
   * unconfigured or older motir-ai, and a dispatcher that refused on `null` would
   * stop every index in the fleet on a transport blip — and on the day this lands
   * ahead of motir-ai's route. The container is still metered as COGS either way.
   *
   * Never throws.
   */
  async askIndexAllowance(organizationId: string): Promise<IndexAllowanceAsk> {
    const verdict = await checkIndexAllowance(organizationId);
    if (!verdict) return { proceed: true, outcome: null };
    const reason = indexPauseReasonFor(verdict.outcome);
    return reason
      ? { proceed: false, outcome: verdict.outcome, reason }
      : { proceed: true, outcome: verdict.outcome };
  },
};
