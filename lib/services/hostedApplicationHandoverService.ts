import type { Prisma } from '@/generated/prisma/client';
import { ApplicationNotFoundError } from '@/lib/hosting/errors';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';

// THE HANDOVER OF A HOSTED APPLICATION (Story MOTIR-9800). At takeover a live app
// is handed over, not destroyed: the `hosted_application` row is the record of
// what was handed over and is KEPT, and Motir stops serving the app's addresses.
// The AWS handover saga's `remove_access` step and the stop at the end of a
// serverless or Fly grace window both end here; the grace cards add their own
// methods to this service.
//
// ── Every method runs in the CALLER's transaction ─────────────────────────
//
// Each caller already holds a `withWorkspaceServiceContext` transaction and
// passes it as `tx`, so a stop that fails later rolls these writes back with
// it. No method here opens a transaction or makes a host call.
//
// ── What each address answers afterwards needs no routing change ──────────
//
// `publicAddressesService.resolveHost` already gives the right answers once the
// rows change: the application's own `<slug>--<workspace>` host has no row and
// is the shared 404; the bare workspace host answers `no_application`; and an
// issued customer domain naming no application answers `no_application` too.
// A customer domain is UNBOUND exactly as on removal of its application (the
// address decision, §3): the row stays in the workspace with its
// ownership proof and its certificate issued, so the customer can Re-point it
// or Remove it. Removing it, which withdraws the certificate, stays the
// customer's own act through `customDomainService.remove`.

/** One customer domain and where it should point once Motir stops serving the
 *  application: the application's own upstream (an AWS app's, once opened), or
 *  null where none outlives the handover (serverless and Fly). */
export interface HandoverDomainUpstream {
  readonly host: string;
  readonly upstreamAddress: string | null;
}

/** What `releaseApplicationAddresses` changed. */
export interface ReleasedApplicationAddresses {
  /** The application's `<slug>--<workspace>` host, now freed; null when it held none. */
  readonly releasedHost: string | null;
  /** Whether the application was the workspace's default, now cleared. */
  readonly wasDefault: boolean;
  /** The customer domains it served, now unbound, by hostname. */
  readonly unboundDomains: readonly HandoverDomainUpstream[];
}

async function requireApplication(applicationId: string, tx: Prisma.TransactionClient) {
  const app = await hostedApplicationRepository.findById(applicationId, tx);
  if (!app) throw new ApplicationNotFoundError(applicationId);
  return app;
}

/** The domains bound to `applicationId`, each with the application's upstream. */
async function boundDomains(
  applicationId: string,
  upstreamAddress: string | null,
  tx: Prisma.TransactionClient,
) {
  const rows = await publicAddressRepository.listCustomDomainsByApplication(applicationId, tx);
  return {
    rows,
    answer: rows.map((row) => ({ host: row.hostname, upstreamAddress })),
  };
}

export const hostedApplicationHandoverService = {
  /**
   * Stop Motir serving the application's addresses, keeping its record: the
   * workspace default cleared if it is this application, each bound customer
   * domain unbound (its certificate left issued), and the slug and production
   * address freed (`releaseAddresses`). The handover fields are not touched.
   *
   * Look before act, in the order the answer needs: the domains are read
   * first, because the answer names what WAS bound. A second call finds
   * nothing to change, writes nothing, and answers
   * `{ releasedHost: null, wasDefault: false, unboundDomains: [] }`.
   */
  async releaseApplicationAddresses(
    applicationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReleasedApplicationAddresses> {
    const app = await requireApplication(applicationId, tx);
    const domains = await boundDomains(app.id, app.upstreamAddress, tx);
    const wasDefault = await workspaceRepository.clearDefaultApplicationIf(
      app.workspaceId,
      app.id,
      tx,
    );
    for (const row of domains.rows) {
      await publicAddressRepository.setApplication(row.id, null, tx);
    }
    const released = await hostedApplicationRepository.releaseAddresses(app.id, tx);
    return {
      releasedHost: released ? app.productionAddress : null,
      wasDefault,
      unboundDomains: domains.answer,
    };
  },

  /**
   * The customer domains still bound to the application, by hostname, each
   * with the application's upstream address — what the handover screen tells
   * the customer to repoint before Motir stops serving them. Empty once the
   * addresses are released.
   */
  async listCustomerDomainUpstreams(
    applicationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HandoverDomainUpstream[]> {
    const app = await requireApplication(applicationId, tx);
    return (await boundDomains(app.id, app.upstreamAddress, tx)).answer;
  },
};
