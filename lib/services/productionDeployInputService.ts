import type {
  HostingDeployPort,
  ReleaseEnvVar,
  ReleaseShape,
  ReleaseSize,
} from '@motir/orchestrator';
import { resolveEnvironment } from '@/lib/environmentConfig/resolveEnvironment';
import type { ReleaseStep } from '@/lib/hosting/errors';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { mergeProductionEnvironment } from '@/lib/hosting/releaseEnvironment';
import type { HostingTarget } from '@/lib/hosting/vocabulary';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { productionDatabaseService } from '@/lib/services/productionDatabaseService';
import { withSystemContext } from '@/lib/workspaces/context';

// WHAT A PRODUCTION DEPLOY OF ONE COMMIT IS GIVEN (MOTIR-12107, extracted from
// MOTIR-10030's release path): the commit's manifest, the production database
// and the environment, the row's recorded size and shape, and the port with the
// application's provider app. The release path (`productionReleaseService`) and
// the idle-policy switch (`hostedIdlePolicyService`), which redeploys the
// serving release's own artifact, both assemble it here, so the two cannot
// drift into deploying the same commit two different ways.
//
// ⚠️ THE ENVIRONMENT CARRIES SECRETS. It lives in memory between here and the
// port; it is never logged, stored or put in an error.

/** Runs one step, turning its failure into the caller's typed error. */
export type DeployStepRunner = <T>(step: ReleaseStep, fn: () => Promise<T>) => Promise<T>;

export interface ProductionDeployInput {
  manifest: HostingManifest;
  /** Whether the manifest asks for a Postgres database. */
  needsDatabase: boolean;
  env: ReleaseEnvVar[];
  size: ReleaseSize;
  /** The recorded AWS shape, passed exactly as recorded and never inferred —
   *  an `aws` row with none is refused by the port by name; other targets
   *  ignore it (MOTIR-12093, MOTIR-5769 §4). */
  shape: ReleaseShape | null;
  port: HostingDeployPort;
  appRef: string;
}

export interface ProductionDeployApplication {
  id: string;
  workspaceId: string;
  target: HostingTarget;
}

/** Everything a production deploy of `commitSha` needs except the artifact and
 *  the idle policy, each step run through `inStep`. */
async function assembleProductionDeploy(
  app: ProductionDeployApplication,
  projectRepositoryId: string,
  commitSha: string,
  readManifest: (projectRepositoryId: string, commitSha: string) => Promise<HostingManifest>,
  inStep: DeployStepRunner,
): Promise<ProductionDeployInput> {
  const manifest = await inStep('manifest', () => readManifest(projectRepositoryId, commitSha));
  const needsDatabase = manifest.database.kind === 'postgres';
  const database = needsDatabase
    ? await inStep('database', async () => {
        await productionDatabaseService.ensureProductionDatabase(app.id);
        return productionDatabaseService.getProductionDatabaseEnv(app.id);
      })
    : null;
  const env = await inStep('environment', async () =>
    mergeProductionEnvironment(
      await resolveEnvironment(projectRepositoryId, 'production', {
        workspaceId: app.workspaceId,
      }),
      database,
    ),
  );
  // The row's recorded hosting decision: its size, and on `aws` its SHAPE.
  const { size, shape } = await inStep('environment', async () => {
    const facts = await withSystemContext((tx) =>
      projectRepoRepository.findDeployFactsInTx(projectRepositoryId, tx),
    );
    return { size: facts?.hostingSize ?? 'small', shape: facts?.hostingShape ?? null };
  });

  const port: HostingDeployPort = getHostingDeployPort(app.target);
  const { appRef } = await inStep('app', () =>
    port.ensureApp({ repositoryId: projectRepositoryId, environment: { kind: 'production' } }),
  );
  return { manifest, needsDatabase, env, size, shape, port, appRef };
}

export const productionDeployInputService = { assembleProductionDeploy };
