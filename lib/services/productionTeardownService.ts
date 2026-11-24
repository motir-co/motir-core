import { getDatabasePort } from '@/lib/orchestrator/database';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import {
  hostedApplicationRepository,
  type HostedApplicationTeardown,
} from '@/lib/repositories/hostedApplicationRepository';
import { hostedReleaseUsageService } from '@/lib/services/hostedReleaseUsageService';
import { productionUsageMeterService } from '@/lib/services/productionUsageMeterService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE TWO PROVIDER HALVES OF A PRODUCTION TEARDOWN, shared by the hosted
// repository delete (MOTIR-11981, which then deletes the row) and the stop at
// the end of a grace window (MOTIR-12135, which takes the final export between
// the two halves and keeps the row). Each half is look-before-act and records
// what it did before it returns, so a retry after any later failure reaches
// nothing on the provider twice. Neither holds a transaction across a provider
// call: each provider call is followed by its own short write.

/** What the halves read of an application: the teardown read. */
export type ProductionTeardownSubject = Pick<
  HostedApplicationTeardown,
  | 'id'
  | 'projectRepositoryId'
  | 'target'
  | 'productionAppName'
  | 'currentReleaseId'
  | 'previousReleaseId'
  | 'databaseProjectId'
>;

/** Whether the application still has an app on the provider to remove. */
export function hasProductionApp(app: ProductionTeardownSubject): boolean {
  return (
    app.productionAppName !== null ||
    app.currentReleaseId !== null ||
    app.previousReleaseId !== null
  );
}

export const productionTeardownService = {
  /**
   * Stop serving: settle the live release's usage and charge its last metered
   * window (neither throws), destroy the production app (an already-gone app
   * returns no usage), then forget its releases and its name, so a retry
   * neither re-settles usage nor destroys it again. A no-op for an application
   * with nothing left on the provider.
   */
  async removeProductionApp(app: ProductionTeardownSubject, workspaceId: string): Promise<void> {
    if (!hasProductionApp(app)) return;
    if (app.currentReleaseId) {
      // Never throws: a usage the port cannot read is logged and skipped.
      await hostedReleaseUsageService.settleReleaseUsage(app.currentReleaseId);
      // Its last window charged, and every open day with it (MOTIR-12108).
      // Never throws.
      await productionUsageMeterService.accrueOutgoingRelease(app.currentReleaseId, {
        chargeNow: true,
      });
    }
    const port = getHostingDeployPort(app.target);
    // The name enablement recorded, else the app the releases ran on, which the
    // port resolves (and would create) from the repository.
    const appRef =
      app.productionAppName ??
      (
        await port.ensureApp({
          repositoryId: app.projectRepositoryId,
          environment: { kind: 'production' },
        })
      ).appRef;
    await port.destroyApp({ appRef });
    await withWorkspaceServiceContext(workspaceId, (tx) =>
      hostedApplicationRepository.clearProductionPointers(app.id, tx),
    );
  },

  /**
   * Delete the application's production database at the provider (a deleted
   * database answers zero usage), then forget it on the row, so a retry has
   * nothing left to delete. A no-op for an application with no database.
   */
  async deleteProductionDatabase(
    app: ProductionTeardownSubject,
    workspaceId: string,
  ): Promise<void> {
    if (!app.databaseProjectId) return;
    const databases = getDatabasePort();
    await databases.deleteDatabase({
      provider: databases.provider,
      applicationRef: app.projectRepositoryId,
      databaseRef: app.databaseProjectId,
    });
    await withWorkspaceServiceContext(workspaceId, (tx) =>
      hostedApplicationRepository.clearDatabase(app.id, tx),
    );
  },
};
