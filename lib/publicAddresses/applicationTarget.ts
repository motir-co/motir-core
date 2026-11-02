import type { OriginCredentialKind } from '@motir/orchestrator';

import type { HostingTarget } from '@/lib/hosting/vocabulary';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';

// WHERE AN ISSUED CUSTOMER HOST FORWARDS TO — Story MOTIR-4533 · MOTIR-9525,
// the seam the customer-domain decision (MOTIR-9521 §3) names.
//
// The host contract asks ONE question of the hosting runtime: what is the
// upstream of this application's serving release? This file is the only place
// that asks it, so the contract and the edge never learn how a target describes
// its releases (MOTIR-5769's port does).
//
// ⚠️ ONLY THE CREDENTIALED CALLER REACHES THIS. A Fly upstream wakes a
// suspended Machine on any request, refused or not, so an upstream address is
// never computed for an anonymous read; `publicAddressesService.resolveHost`
// calls this only for the edge's bearer.

/** What the edge needs to forward to an application. */
export interface ApplicationTarget {
  /** The upstream's origin — `describe().upstreamAddress`, reduced to its origin. */
  readonly origin: string;
  /** The input to `deriveOriginSecret` for an `origin_secret` upstream. */
  readonly appRef: string;
  /** How the edge proves itself to the upstream. */
  readonly credential: OriginCredentialKind;
}

/** The application fields the seam reads. */
export interface ApplicationTargetSource {
  readonly target: HostingTarget;
  /** The production app's name on its target; `null` until production is enabled. */
  readonly productionAppName: string | null;
  readonly currentReleaseId: string | null;
}

/**
 * The upstream of the application's serving release, or `null` when it has
 * none — no current release, production never enabled, or a target that
 * reports no address for it.
 */
export async function resolveApplicationTarget(
  application: ApplicationTargetSource,
): Promise<ApplicationTarget | null> {
  if (!application.currentReleaseId || !application.productionAppName) return null;
  const appRef = application.productionAppName;
  const port = getHostingDeployPort(application.target);
  const [serving] = await port.listReleases({ appRef });
  if (!serving) return null;
  const description = await port.describe(serving.handle);
  if (!description.upstreamAddress) return null;
  return {
    origin: new URL(description.upstreamAddress).origin,
    appRef,
    credential: description.originCredential,
  };
}
