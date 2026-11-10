import 'server-only';

import { fetchOrgTiers } from '@/lib/ai/motirAiClient';
import { OrgModelChoiceNotQualifiedError } from '@/lib/ai/errors';
import { orgQualifiesForHostedModelChoice } from '@/lib/billing/modelChoiceQualification';
import type {
  OrgOfferedModelDTO,
  OrgRunModelKeyDTO,
  OrgRunModelsDTO,
  OrgRunModelWriteDTO,
} from '@/lib/dto/orgAiModels';
import type { HostedModelOffer } from '@/lib/hosted/resolveHostedModel';
import { HostedModelNotOfferedError, HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import {
  ORG_RUN_MODEL_COLUMN,
  toOrgRunModelRowDTO,
  toOrgRunModelsLockedDTO,
  toOrgRunModelsReadyDTO,
  UNREADABLE_ORG_RUN_MODELS,
} from '@/lib/mappers/orgAiModelsMappers';
import { orgCan } from '@/lib/organizations/capabilities';
import { assertOrgNotClosing } from '@/lib/organizations/closingGuard';
import { withOrgContext } from '@/lib/organizations/context';
import {
  organizationRepository,
  type OrgHostedModelOverridesRow,
} from '@/lib/repositories/organizationRepository';
import { hostedRunModelService } from '@/lib/services/hostedRunModelService';
import { assertOrgCapability, assertOrgMember } from '@/lib/services/organizationAccessService';

// An organisation's own RUN-SIDE models — a default per difficulty, the review agent
// and the design run (story MOTIR-10838 · MOTIR-10850). motir-core stores them (six
// `organization` columns, MOTIR-10843); this service gates who may read and change
// them, decides the room's state and validates a write against the run-model offer.
//
// Order, both directions: the member / owner-admin gate in its own org context first
// (so a refused caller costs no network call), then the tier and the offer OUTSIDE
// any transaction, then — for a write — one org-context transaction that re-gates
// with its `tx` and writes the column.
//
// An unknown tier is UNREADABLE here, never locked: the room must not show a lock it
// cannot vouch for. Resolution deliberately treats the same unknown tier as not
// qualifying (`orgHostedModelResolutionService`), so a run is never refused for it.

type Qualification = 'qualifies' | 'locked' | 'unreadable';

async function qualificationOf(
  organizationId: string,
  row: Pick<OrgHostedModelOverridesRow, 'isMeta'>,
): Promise<Qualification> {
  if (row.isMeta) return 'qualifies';
  const tiers = await fetchOrgTiers([organizationId]);
  if (tiers === null) return 'unreadable';
  const tierKey = tiers.get(organizationId) ?? null;
  return orgQualifiesForHostedModelChoice({ isMeta: false, tierKey }) ? 'qualifies' : 'locked';
}

type OfferRead =
  | { state: 'ok'; offer: HostedModelOffer; offered: OrgOfferedModelDTO[] }
  | { state: 'unavailable' };

async function readOffer(): Promise<OfferRead> {
  const read = await hostedRunModelService.listOfferedModels();
  if (read.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: 'ok',
    offer: {
      models: read.models.map((m) => m.id),
      default: read.default,
      defaultsByDifficulty: read.defaultsByDifficulty,
      reviewAgentDefault: read.reviewAgentDefault,
      designRunDefault: read.designRunDefault,
    },
    offered: read.models,
  };
}

/** The org row, read under the org context the caller's gate already bound. */
async function requireRow(
  organizationId: string,
  tx: Parameters<typeof organizationRepository.findOrgHostedModelOverridesInTx>[1],
): Promise<OrgHostedModelOverridesRow> {
  const row = await organizationRepository.findOrgHostedModelOverridesInTx(organizationId, tx);
  // The membership gate just read this org, so its row exists.
  /* v8 ignore next */
  if (!row) throw new Error(`organization ${organizationId} not found`);
  return row;
}

export const orgRunModelOverrideService = {
  /**
   * The room's read, for any member (a non-member → 404). Always one of the three
   * states; never throws for an unreadable tier or offer.
   */
  async read(input: { organizationId: string; actorUserId: string }): Promise<OrgRunModelsDTO> {
    const { role, row } = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => ({
        role: await assertOrgMember(input.actorUserId, input.organizationId, tx),
        row: await requireRow(input.organizationId, tx),
      }),
    );
    const qualification = await qualificationOf(input.organizationId, row);
    if (qualification === 'unreadable') return UNREADABLE_ORG_RUN_MODELS;
    if (qualification === 'locked') return toOrgRunModelsLockedDTO(row);
    const read = await readOffer();
    if (read.state === 'unavailable') return UNREADABLE_ORG_RUN_MODELS;
    return toOrgRunModelsReadyDTO(row, read.offer, read.offered, orgCan(role, 'manageOrgSettings'));
  },

  /**
   * Set (a model id) or clear (null) one run-side row — owner or admin only (member
   * → 403, non-member → 404), refused for a closing org (409).
   *
   * @throws HostedModelsUnavailableError when the tier or the offer cannot be read;
   *   OrgModelChoiceNotQualifiedError for an org that does not qualify;
   *   HostedModelNotOfferedError for a model outside the run-model offer.
   */
  async write(input: {
    organizationId: string;
    actorUserId: string;
    key: OrgRunModelKeyDTO;
    model: string | null;
  }): Promise<OrgRunModelWriteDTO> {
    const ctx = { userId: input.actorUserId, organizationId: input.organizationId };
    const gated = await withOrgContext(ctx, async (tx) => {
      await assertOrgCapability(input.actorUserId, input.organizationId, 'manageOrgSettings', tx);
      await assertOrgNotClosing(input.organizationId, tx);
      return requireRow(input.organizationId, tx);
    });

    const qualification = await qualificationOf(input.organizationId, gated);
    if (qualification === 'unreadable') {
      throw new HostedModelsUnavailableError('the organisation’s plan could not be read');
    }
    if (qualification === 'locked') throw new OrgModelChoiceNotQualifiedError(input.organizationId);
    const read = await readOffer();
    if (read.state === 'unavailable') {
      throw new HostedModelsUnavailableError('the run-model offer could not be read');
    }
    if (input.model !== null && !read.offer.models.includes(input.model)) {
      throw new HostedModelNotOfferedError(input.model);
    }

    const column = ORG_RUN_MODEL_COLUMN[input.key];
    const { previousModel, written } = await withOrgContext(ctx, async (tx) => {
      await assertOrgCapability(input.actorUserId, input.organizationId, 'manageOrgSettings', tx);
      await assertOrgNotClosing(input.organizationId, tx);
      const before = await requireRow(input.organizationId, tx);
      const after = await organizationRepository.updateOrgHostedModelOverrides(
        input.organizationId,
        { [column]: input.model },
        tx,
      );
      return { previousModel: before[column], written: after };
    });
    return {
      key: input.key,
      previousModel,
      model: input.model,
      row: toOrgRunModelRowDTO(input.key, written, read.offer),
    };
  },
};
