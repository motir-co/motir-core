import 'server-only';

import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { readOrgPlan } from '@/lib/services/orgPlanReader';

// The two facts the org AI models room's page passes its island beside the routes'
// answers (story MOTIR-10838 · MOTIR-10846, design `design/org-admin/
// org-admin--ai-models.mock.html` panels 8 and 12): whether the organisation is
// Motir's meta organisation (its card subtitle says it chooses on any plan) and the
// name of its plan (the locked panel says "{org} is on {plan}").
//
// ⚠️ COPY ONLY. Neither fact decides anything: whether the room is ready, locked or
// unreadable, and whether it may be edited, is the routes' answer alone. So a fact
// that cannot be read answers its neutral value (not meta, no plan name) and never
// throws: the room still renders from the routes, with the copy that names no plan.

export interface OrgAiModelsRoomContext {
  isMeta: boolean;
  /** The plan's name as motir-ai names it; null when it cannot be read. */
  planName: string | null;
}

export const orgAiModelsRoomService = {
  async context(organizationId: string): Promise<OrgAiModelsRoomContext> {
    const [isMeta, plan] = await Promise.all([
      withOrgServiceWriteContext(organizationId, (tx) =>
        organizationRepository.findByIdInTx(organizationId, tx),
      )
        .then((org) => org?.isMeta ?? false)
        .catch(() => false),
      readOrgPlan(organizationId),
    ]);
    const planName =
      plan.kind === 'subscription' ? (plan.subscription.planTier?.name ?? null) : null;
    return { isMeta, planName };
  },
};
