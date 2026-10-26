/**
 * AN ORGANISATION'S OWN PLAN FIGURES (Story MOTIR-9368 · MOTIR-9659) — the plan
 * as the fleet's admissions read it (MOTIR-9377): each workload is held to its
 * OWN plan figure (`lib/billing/planCaps.ts`, the fleet-capacity decision
 * MOTIR-9357, amending `fleet-per-org-pool.md` §2). One shape for both readers:
 * the platform fleet monitor (MOTIR-6905) and the org's own Fleet use section, so
 * the two never name different figures.
 *
 * Safe to return to that org's owner and admins: it is the org's own plan and
 * figures and nothing else — no organisation id, AWS account id, member email,
 * credential or environment value.
 *
 * A CLOSED union: a surface renders each kind by name, so an exempt or unknown
 * plan reads as words, never a default figure.
 */
export type OrgPlanFiguresDTO =
  | {
      kind: 'capped';
      planKey: string;
      /** As motir-ai names it; shown untranslated. */
      planName: string;
      agentRunsInParallel: number;
      agentsPerUser: number;
      agentsRunningPerOrg: number;
      /** What CI admission holds the org to — the plan's `ciBurstCap` or the staff
       *  override; null when the override could not be read (CI is refused). */
      ciBurstCap: number | null;
      ciBurstSource: 'plan' | 'override' | 'unreadable';
    }
  /** Motir's own orgs (`isMeta` / `internalBilling`) or a build with no billing:
   *  no plan figure, except a staff CI override when one is set. */
  | { kind: 'exempt'; ciBurstOverride: number | null }
  /** The plan could not be read, or its key has no caps row — admission refuses. */
  | { kind: 'plan_unknown'; planKey: string | null };
