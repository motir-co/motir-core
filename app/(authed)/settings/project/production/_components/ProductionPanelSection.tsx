import { ProductionError } from '@/components/hosting/ProductionError';
import { ProductionPanel } from '@/components/hosting/ProductionPanel';
import type { IdlePolicyDto } from '@/lib/dto/idlePolicy';
import type { ProductionHealthDto } from '@/lib/dto/productionHealth';
import type { ProductionUsageDto } from '@/lib/dto/productionUsage';
import type { ProductionPanelDto } from '@/lib/dto/productionPanel';
import { productionHealthService } from '@/lib/services/productionHealthService';
import { productionPanelService } from '@/lib/services/productionPanelService';
import { productionUsageService } from '@/lib/services/productionUsageService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The Production panel's server read (Story MOTIR-9797 · MOTIR-10037), streamed
// inside the page's `<Suspense>` once the page has settled the status. It seeds
// the client island with the routes' own payload — the same service the GET route
// answers from, so the first paint and every later fetch carry one shape.
//
// A read that fails renders the design's error state (panel 15) with Try again,
// and nothing stale: there is no earlier panel to show as live.
//
// The application's HEALTH (MOTIR-12109), its IDLE POLICY and this period's USAGE
// (MOTIR-12110) are seeded the same way, from the services behind their GET
// routes. A read that fails does not fail the panel: the island reads it again
// itself and shows that section's own error with Try again.

export async function ProductionPanelSection({
  projectKey,
  repositoryId,
  repositoryName,
  actor,
  focusEventId,
}: {
  projectKey: string;
  repositoryId: string;
  repositoryName: string;
  actor: ServiceContext;
  /** The crash event a notification opened the page on. */
  focusEventId?: string | null;
}) {
  let initial: ProductionPanelDto;
  try {
    initial = await productionPanelService.getProductionPanel({
      projectKey,
      projectRepositoryId: repositoryId,
      actor,
    });
  } catch {
    return <ProductionError />;
  }
  const orNull = <T,>(read: Promise<T>): Promise<T | null> => read.catch(() => null);
  const [initialHealth, initialIdle, initialUsage] = await Promise.all([
    initial.application
      ? orNull<ProductionHealthDto>(
          productionHealthService.getHealthForRepository(projectKey, repositoryId, actor),
        )
      : Promise.resolve(null),
    orNull<IdlePolicyDto>(
      productionPanelService.getIdlePolicy({
        projectKey,
        projectRepositoryId: repositoryId,
        actor,
      }),
    ),
    orNull<ProductionUsageDto>(
      productionUsageService.getUsageForRepository(projectKey, repositoryId, actor),
    ),
  ]);
  return (
    <ProductionPanel
      projectKey={projectKey}
      repositoryId={repositoryId}
      repositoryName={repositoryName}
      initial={initial}
      initialHealth={initialHealth}
      initialIdle={initialIdle}
      initialUsage={initialUsage}
      focusEventId={focusEventId ?? null}
    />
  );
}
