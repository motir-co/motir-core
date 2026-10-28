import { vi } from 'vitest';
import { capsForPlanKey } from '@/lib/billing/planCaps';
import { planCapsService } from '@/lib/services/planCapsService';

// MOTIR-9374 — the agent limits are the org's PLAN figures. A suite that tests a
// cap's MECHANICS (the lock, the release on hibernate, two orgs side by side)
// rather than a plan's figures stubs the plan-caps seam here with the agent
// figures it needs, on a plan named for what it is: a test seam, not a real row.
// The real plans' figures are tested in `tests/agentInstances/agentInstancePlanCaps.test.ts`.
//
// Every org that is not exempt by its own row reads these figures; Motir's own
// organisations (`isMeta` / `internalBilling`) still read `exempt`.
export const TEST_AGENT_PLAN_NAME = 'Test';

export function capAgentsAt(figures: { perOrg?: number; perUser?: number }): void {
  const base = capsForPlanKey('max_x2')!;
  const real = planCapsService.capsFor.bind(planCapsService);
  vi.spyOn(planCapsService, 'capsFor').mockImplementation(async (organizationId) => {
    const answer = await real(organizationId);
    if (answer.kind === 'exempt') return answer;
    return {
      kind: 'capped',
      planKey: 'test',
      planName: TEST_AGENT_PLAN_NAME,
      caps: {
        ...base,
        agentsPerOrg: figures.perOrg ?? base.agentsPerOrg,
        agentsPerUser: figures.perUser ?? base.agentsPerUser,
      },
    };
  });
}
