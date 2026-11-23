import { repositoryActionsConfigClient } from '@/lib/github/repositoryActionsConfig';
import {
  HOSTING_TARGET_VARIABLE,
  PRODUCTION_ENVIRONMENT,
  PRODUCTION_IMAGE_VARIABLE,
  PRODUCTION_PUSH_TOKEN_SECRET,
} from '@/lib/hosting/productionEnablementNames';
import { hostInstallationIdOf } from '@/lib/services/projectRepoTakeoverService';

// THE REPOSITORY-SCOPED PRODUCTION CONFIGURATION MOTIR SET, WITHDRAWN (Story
// MOTIR-9800 · MOTIR-12131). Switching production on (`productionEnablementService`)
// writes a deploy credential as the `production` environment's secret and two
// repository variables. Each travels WITH the repository when it is transferred,
// and once it has moved Motir's App can no longer delete them — so the takeover
// handover withdraws them here, BEFORE the transfer, while the provisioning App
// still reaches the repository. Every delete is a no-op for a name that is
// already gone, so a resumed step repeats it freely.

/** The repository whose production configuration is withdrawn. */
export interface ProductionConfigRepository {
  id: string;
  githubRepo: { installationId: string; owner: string; name: string } | null;
}

export const productionRepositoryConfigService = {
  /**
   * Delete the production deploy credential and the production variables
   * Motir set on the repository. A row with no realized repository has none.
   * The image variable goes before the target variable, the gate every build
   * workflow reads, as enablement writes them in the other order.
   */
  async removeFromRepository(repo: ProductionConfigRepository): Promise<void> {
    if (!repo.githubRepo) return;
    const coordinates = {
      installationId: await hostInstallationIdOf(repo.githubRepo.installationId),
      owner: repo.githubRepo.owner,
      repo: repo.githubRepo.name,
    };
    await repositoryActionsConfigClient.deleteEnvironmentSecret(
      coordinates,
      PRODUCTION_ENVIRONMENT,
      PRODUCTION_PUSH_TOKEN_SECRET,
    );
    await repositoryActionsConfigClient.deleteVariable(coordinates, PRODUCTION_IMAGE_VARIABLE);
    await repositoryActionsConfigClient.deleteVariable(coordinates, HOSTING_TARGET_VARIABLE);
  },
};
