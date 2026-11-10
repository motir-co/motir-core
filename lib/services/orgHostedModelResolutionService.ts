import 'server-only';

import { fetchOrgTiers } from '@/lib/ai/motirAiClient';
import { orgQualifiesForHostedModelChoice } from '@/lib/billing/modelChoiceQualification';
import type { OrgHostedModelLayer } from '@/lib/hosted/resolveHostedModel';
import { withOrgContext } from '@/lib/organizations/context';
import {
  organizationRepository,
  type OrgHostedModelOverridesRow,
} from '@/lib/repositories/organizationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE ORGANISATION LAYER OF HOSTED-MODEL RESOLUTION (story MOTIR-10838 ·
// MOTIR-10843): which org a workspace belongs to, whether it qualifies for its own
// run-side models right now, and — only if it does — the values it stored. The
// ONE read resolution uses (the start path, the picker read, the review start and
// the project Hosted agent room), read once per request and handed to
// `resolveHostedModel` as data.
//
// Two RLS-scoped reads, as `resolveTenantOrg` does: the workspace's org id under
// the workspace context, then the org row under the ORG context (the
// `organization` policy keys off `app.organization_id`, which the workspace
// context does not bind). The tier is motir-ai's and is asked for only when the
// org is not the meta org. An unknown tier (`fetchOrgTiers` answered null) reads
// as NOT qualifying: the org layer is skipped and the run resolves from the
// platform layers — never refused because a tier could not be read. An org that
// has stored no choice skips the tier read entirely: there is nothing to apply.
// `qualifies` is then false, which means only "no org layer applies" here.

export interface OrgHostedModelResolution {
  organizationId: string;
  qualifies: boolean;
  /** The stored choices while the org qualifies; null otherwise. */
  layer: OrgHostedModelLayer | null;
}

/** The six columns → the resolver's layer. */
export function toOrgHostedModelLayer(row: OrgHostedModelOverridesRow): OrgHostedModelLayer {
  return {
    levels: {
      trivial: row.hostedModelTrivial,
      low: row.hostedModelLow,
      medium: row.hostedModelMedium,
      high: row.hostedModelHigh,
    },
    review: row.hostedReviewModel,
    design: row.hostedDesignModel,
  };
}

function hasAnyChoice(layer: OrgHostedModelLayer): boolean {
  return (
    Object.values(layer.levels).some((m) => m !== null) ||
    layer.review !== null ||
    layer.design !== null
  );
}

export const orgHostedModelResolutionService = {
  async readOrgLayer(ctx: {
    userId: string;
    workspaceId: string;
  }): Promise<OrgHostedModelResolution> {
    const organizationId = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const workspace = await workspaceRepository.findByIdInTx(ctx.workspaceId, tx);
        // The context just bound this workspace for this caller, so it exists.
        /* v8 ignore next */
        if (!workspace) throw new Error(`workspace ${ctx.workspaceId} not found`);
        return workspace.organizationId;
      },
    );
    const row = await withOrgContext({ userId: ctx.userId, organizationId }, (tx) =>
      organizationRepository.findOrgHostedModelOverridesInTx(organizationId, tx),
    );
    // `workspace.organization_id` is a foreign key, so the row exists; were it ever
    // unreadable, the run falls to the platform layers rather than failing.
    /* v8 ignore next */
    if (!row) return { organizationId, qualifies: false, layer: null };
    const layer = toOrgHostedModelLayer(row);
    // Nothing stored ⇒ nothing to apply whatever the tier: skip the network read.
    if (!hasAnyChoice(layer)) return { organizationId, qualifies: false, layer: null };
    let tierKey: string | null = null;
    if (!row.isMeta) {
      const tiers = await fetchOrgTiers([organizationId]);
      tierKey = tiers?.get(organizationId) ?? null;
    }
    const qualifies = orgQualifiesForHostedModelChoice({ isMeta: row.isMeta, tierKey });
    return { organizationId, qualifies, layer: qualifies ? layer : null };
  },
};
