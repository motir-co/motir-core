import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  publicSubdomainService,
  roleMayManageAddress,
} from '@/lib/services/publicSubdomainService';
import { tenantBaseDomain } from '@/lib/publicAddresses/tenantDomain';
import type { PublicSubdomainDto } from '@/lib/dto/publicAddresses';
import { PublicAddressControl } from './PublicAddressControl';

// The workspace address page's reads (Story MOTIR-4528 · MOTIR-9514), rendered
// below the page's Suspense boundary. A server component of its own so the page
// file exports only its default.

/** The pane's reads, below the boundary. */
export async function PublicAddressBody({
  workspaceId,
  actorUserId,
}: {
  workspaceId: string;
  actorUserId: string;
}) {
  let subdomain: PublicSubdomainDto | null = null;
  let canManage = false;
  let loadFailed = false;
  try {
    // `allSettledOrThrow`, never a bare `Promise.all`: both arms open a
    // transaction (MOTIR-3066).
    const [dto, role] = await allSettledOrThrow([
      publicSubdomainService.getForWorkspace(workspaceId, actorUserId),
      // The COMPOSED workspace role, so an org Owner / Admin sees the controls
      // the write path already lets them use (MOTIR-6462).
      workspacesService.getMemberRole(actorUserId, workspaceId),
    ]);
    subdomain = dto;
    canManage = roleMayManageAddress(role);
  } catch (err) {
    // The pane's load-error state (design panel 11): one line and a retry that
    // re-runs this read, rather than the route's error boundary taking the
    // whole settings area down for one card.
    console.error('[workspace public address] load failed', err);
    loadFailed = true;
  }

  return (
    <PublicAddressControl
      workspaceId={workspaceId}
      baseDomain={tenantBaseDomain()}
      subdomain={subdomain}
      canManage={canManage}
      loadFailed={loadFailed}
    />
  );
}
