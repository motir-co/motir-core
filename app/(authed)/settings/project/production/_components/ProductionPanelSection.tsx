import { ProductionError } from '@/components/hosting/ProductionError';
import { ProductionPanel } from '@/components/hosting/ProductionPanel';
import type { ProductionHealthDto } from '@/lib/dto/productionHealth';
import type { ProductionPanelDto } from '@/lib/dto/productionPanel';
import { productionHealthService } from '@/lib/services/productionHealthService';
import { productionPanelService } from '@/lib/services/productionPanelService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The Production panel's server read (Story MOTIR-9797 · MOTIR-10037), streamed
// inside the page's `<Suspense>` once the page has settled the status. It seeds
// the client island with the routes' own payload — the same service the GET route
// answers from, so the first paint and every later fetch carry one shape.
//
// A read that fails renders the design's error state (panel 15) with Try again,
// and nothing stale: there is no earlier panel to show as live.
//
// The application's HEALTH (MOTIR-12109) is seeded the same way, from the service
// behind `GET …/production/health`. A health read that fails does not fail the
// panel: the island shows Health's own error with Try again.

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
  let initialHealth: ProductionHealthDto | null = null;
  if (initial.application) {
    try {
      initialHealth = await productionHealthService.getHealthForRepository(
        projectKey,
        repositoryId,
        actor,
      );
    } catch {
      initialHealth = null;
    }
  }
  return (
    <ProductionPanel
      projectKey={projectKey}
      repositoryId={repositoryId}
      repositoryName={repositoryName}
      initial={initial}
      initialHealth={initialHealth}
      focusEventId={focusEventId ?? null}
    />
  );
}
