import type { OrgPlanFiguresDTO } from '@/lib/dto/orgPlanFigures';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { planCapsService } from '@/lib/services/planCapsService';

// ONE PLAN-FIGURES READ (Story MOTIR-9368 · MOTIR-9659) — an organisation's plan
// figures, read where the admissions read them, so the platform fleet monitor
// (MOTIR-6905) and the org's own Fleet use section call the SAME function and can
// never drift apart. Moved verbatim out of the monitor, where it was private.
//
// ⚠️ NO ACCESS GATE HERE. Each caller gates: the monitor through
// `requirePlatformStaff`, the tenant read through the org's owner+admin check.

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const orgPlanFiguresService = {
  /**
   * The org's plan figures: the three agent figures from `capsFor`, the CI figure
   * (and whether staff overrode it) from the CI gate's own `resolveCiBurstCap`. A
   * throw from either reads as an unknown plan with no key, logged. Never throws.
   */
  async figuresFor(organizationId: string): Promise<OrgPlanFiguresDTO> {
    try {
      const caps = await planCapsService.capsFor(organizationId);
      if (caps.kind === 'plan_unknown') return { kind: 'plan_unknown', planKey: caps.planKey };
      const ci = await fleetCeilingService.resolveCiBurstCap(organizationId);
      const ciCapped = ci.kind === 'capped' ? ci : null;
      if (caps.kind === 'exempt') {
        return {
          kind: 'exempt',
          ciBurstOverride: ciCapped?.source === 'override' ? ciCapped.figure : null,
        };
      }
      return {
        kind: 'capped',
        planKey: caps.planKey,
        planName: caps.planName,
        agentRunsInParallel: caps.caps.agentRunsInParallel,
        agentsPerUser: caps.caps.agentsPerUser,
        agentsRunningPerOrg: caps.caps.agentsRunningPerOrg,
        ciBurstCap: ciCapped?.figure ?? null,
        ciBurstSource: ciCapped?.source ?? 'unreadable',
      };
    } catch (err) {
      console.error("[orgPlanFiguresService] could not read the organization's plan", {
        organizationId,
        detail: detailOf(err),
      });
      return { kind: 'plan_unknown', planKey: null };
    }
  },
};
