import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { customDomainService } from '@/lib/services/customDomainService';
import { publicSubdomainService } from '@/lib/services/publicSubdomainService';
import { tenantBaseDomain } from '@/lib/publicAddresses/tenantDomain';
import type { PublicAddressDto } from '@/lib/dto/publicAddresses';
import { CustomDomainsPane } from './CustomDomainsPane';

// The Custom domains page's reads (MOTIR-9529), below the page's Suspense
// boundary. A server component of its own so the page file exports only its
// default — the Public address room's shape.

export async function CustomDomainsBody({
  workspaceId,
  actorUserId,
}: {
  workspaceId: string;
  actorUserId: string;
}) {
  let addresses: PublicAddressDto[] = [];
  let canManage = false;
  let maxDomains: number | null = null;
  let workspaceHost: string | null = null;
  let loadFailed = false;
  try {
    // `allSettledOrThrow`, never a bare `Promise.all`: both arms open a
    // transaction (MOTIR-3066).
    const [pane, subdomain] = await allSettledOrThrow([
      customDomainService.listForPane({ workspaceId, actorUserId }),
      publicSubdomainService.getForWorkspace(workspaceId, actorUserId),
    ]);
    ({ addresses, canManage, maxDomains } = pane);
    workspaceHost = subdomain?.hostname ?? null;
  } catch (err) {
    // The pane's load-error state: one line and a retry, rather than the
    // route's error boundary taking the settings area down for one card.
    console.error('[workspace custom domains] load failed', err);
    loadFailed = true;
  }

  return (
    <CustomDomainsPane
      workspaceId={workspaceId}
      baseDomain={tenantBaseDomain()}
      workspaceHost={workspaceHost}
      addresses={addresses}
      canManage={canManage}
      maxDomains={maxDomains}
      loadFailed={loadFailed}
    />
  );
}
