import { isMotirAiUnreadable } from '@/lib/ai/errors';
import { getOrgPlannerModelOverrides, setOrgPlannerModelOverride } from '@/lib/ai/motirAiClient';
import type {
  OrgPlannerFunctionDTO,
  OrgPlannerModelsDTO,
  OrgPlannerModelWriteDTO,
} from '@/lib/dto/orgAiModels';
import {
  toOrgPlannerModelsDTO,
  toOrgPlannerModelWriteDTO,
  UNREADABLE_ORG_PLANNER_MODELS,
} from '@/lib/mappers/orgAiModelsMappers';
import { orgCan } from '@/lib/organizations/capabilities';
import { assertOrgNotClosing } from '@/lib/organizations/closingGuard';
import { withOrgContext } from '@/lib/organizations/context';
import { assertOrgCapability, assertOrgMember } from '@/lib/services/organizationAccessService';

// An organisation's own planning-side models — Planning, Guide, Debug and Ask
// (story MOTIR-10838 · MOTIR-10845). motir-ai stores them, decides whether the org
// qualifies (Pro and above, or the meta org) and resolves each job; this service
// gates who may read and change them and shapes the room's answer.
//
// Every gate runs in its OWN org context, closed before the call to motir-ai: a
// transaction is never held open across the network.

export const orgPlannerModelOverrideService = {
  /**
   * The room's read, for any member of the org (a non-member → 404). Never throws
   * for an unreachable motir-ai: that is the `unreadable` state.
   */
  async read(input: { organizationId: string; actorUserId: string }): Promise<OrgPlannerModelsDTO> {
    const role = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      (tx) => assertOrgMember(input.actorUserId, input.organizationId, tx),
    );
    try {
      const read = await getOrgPlannerModelOverrides(input.organizationId);
      return toOrgPlannerModelsDTO(read, orgCan(role, 'manageOrgSettings'));
    } catch (err) {
      if (isMotirAiUnreadable(err)) return UNREADABLE_ORG_PLANNER_MODELS;
      throw err;
    }
  },

  /**
   * Set (a model id) or clear (null) one function's override — owner or admin only
   * (member → 403, non-member → 404), refused for a closing org (409). motir-ai
   * stores the actor as the row's `updatedByCoreUserId`.
   *
   * @throws OrgModelChoiceNotQualifiedError, PlannerModelNotOfferedError,
   *   PlannerModelUnreachableError from motir-ai's refusals; MotirAiUnavailableError
   *   or MotirAiConfigError when it cannot be reached.
   */
  async write(input: {
    organizationId: string;
    actorUserId: string;
    function: OrgPlannerFunctionDTO;
    model: string | null;
  }): Promise<OrgPlannerModelWriteDTO> {
    await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgCapability(input.actorUserId, input.organizationId, 'manageOrgSettings', tx);
        await assertOrgNotClosing(input.organizationId, tx);
      },
    );
    const result = await setOrgPlannerModelOverride(input.organizationId, {
      function: input.function,
      model: input.model,
      actorCoreUserId: input.actorUserId,
    });
    return toOrgPlannerModelWriteDTO(result);
  },
};
