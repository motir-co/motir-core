import type { Prisma } from '@/generated/prisma/client';
import {
  OrchestratorApiError,
  type HostingDeployPort,
  type ReleaseEnvVar,
} from '@motir/orchestrator';
import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import { resolveEnvironment } from '@/lib/environmentConfig/resolveEnvironment';
import {
  ApplicationNotFoundError,
  ReleaseDeployFailedError,
  ReleaseInProgressError,
  ReleaseMigrationFailedError,
  type ReleaseStep,
} from '@/lib/hosting/errors';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { mergeProductionEnvironment } from '@/lib/hosting/releaseEnvironment';
import type { HostedReleaseCause } from '@/lib/hosting/vocabulary';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { hostedReleaseRepository } from '@/lib/repositories/hostedReleaseRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedReleaseUsageService } from '@/lib/services/hostedReleaseUsageService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import { productionDatabaseService } from '@/lib/services/productionDatabaseService';
import { withSystemContext } from '@/lib/workspaces/context';

// PUT ONE COMMIT INTO PRODUCTION (Story MOTIR-9797 · MOTIR-10030). The one entry
// point for a production release of a Motir repository: a merge (MOTIR-10031), a
// config change (MOTIR-10032) and a promotion by ref (MOTIR-7144) all call
// `deployProductionRelease`, so there is no second path.
//
// ⚠️ THE ORDER DECIDES WHAT SERVES AFTER EACH FAILURE.
//   1. Under the application row's lock — and only for that — refuse a second
//      release while one is in flight, create the row and move it to
//      `releasing`. The lock is NOT held across the migration or the deploy.
//   2. The manifest of the exact commit, the production database (created on
//      the first release that needs one), and the environment.
//   3. The manifest's migration, as a one-off run of the release image, BEFORE
//      the deploy: a failed or timed-out migration fails the release and the
//      deploy is never called, so the previous release keeps serving.
//   4. The deploy. Only on success does the release go `live` and become the
//      application's current release, the old one `replaced`.
// Every state move is `transitionRelease` (one conditional UPDATE) and every
// pointer move `swapCurrentRelease`.
//
// ⚠️ THE ENVIRONMENT CARRIES SECRETS. It lives in memory between its resolution
// and the port; it is never logged, stored or put in an error. A failure keeps
// only its step, HTTP status and code (`ReleaseDeployFailedError`), and that is
// all `failure_reason` records.

/** How long a migration may run before it is stopped and the release failed. */
export const PRODUCTION_MIGRATION_TIMEOUT_SECONDS = 15 * 60;

/** The starter's name for the direct (unpooled) string its migration reads
 *  (`prisma.config.ts`); passed beside the port's own `DIRECT_URL`. */
const MIGRATION_DIRECT_ENV_ALIAS = 'DATABASE_URL_UNPOOLED';

/** A code is passed on only when it looks like one, so a message cannot ride
 *  in its place. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_NAME = /^[A-Za-z]{1,64}$/;

export interface DeployProductionReleaseInput {
  projectRepositoryId: string;
  /** The commit released — the full sha. */
  commitSha: string;
  /** The tag or branch the release was asked for, when asked by ref. */
  ref?: string | null;
  /** What the release was (MOTIR-10103): the commit's subject, the pull
   *  request a merge came from, and who asked for a release of a ref. */
  commitSubject?: string | null;
  pullRequestNumber?: number | null;
  requestedById?: string | null;
  /** The image the caller built for that commit. */
  artifactRef: string;
  cause: HostedReleaseCause;
}

export interface ProductionReleaseDeps {
  /** The hosting manifest at a commit; GitHub through the repository's
   *  credential by default. */
  readManifest?: (projectRepositoryId: string, commitSha: string) => Promise<HostingManifest>;
}

/** The step, status and code of any failure — nothing else of it. */
function failureOf(releaseId: string, step: ReleaseStep, error: unknown): ReleaseDeployFailedError {
  if (error instanceof ReleaseDeployFailedError) return error;
  const status = error instanceof OrchestratorApiError ? error.status : null;
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : '';
  const causeCode =
    typeof code === 'string' && ERROR_CODE.test(code)
      ? code
      : ERROR_NAME.test(name)
        ? name
        : 'UNKNOWN';
  return new ReleaseDeployFailedError(releaseId, step, status, causeCode);
}

async function inStep<T>(releaseId: string, step: ReleaseStep, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw failureOf(releaseId, step, error);
  }
}

/** The release's `failure_reason`: the step and what it ended with. */
function reasonOf(error: ReleaseDeployFailedError | ReleaseMigrationFailedError): string {
  if (error instanceof ReleaseMigrationFailedError) {
    return error.timedOut ? 'migrate: timed out' : `migrate: exit ${error.exitCode ?? 'unknown'}`;
  }
  return `${error.step}: ${error.causeCode}${error.status === null ? '' : ` (HTTP ${error.status})`}`;
}

/** Create the release and move it to `releasing`, under the application row's
 *  lock, refusing while another release of the application is in flight. */
async function openRelease(
  applicationId: string,
  input: DeployProductionReleaseInput,
): Promise<HostedReleaseDto> {
  return withSystemContext(async (tx: Prisma.TransactionClient) => {
    if (!(await hostedApplicationRepository.lockForUpdate(applicationId, tx))) {
      throw new ApplicationNotFoundError(applicationId);
    }
    const inFlight = await hostedReleaseRepository.findInFlightByApplication(applicationId, tx);
    if (inFlight) throw new ReleaseInProgressError(applicationId, inFlight.id, inFlight.state);
    const created = await hostedApplicationService.createRelease(
      {
        applicationId,
        commitSha: input.commitSha,
        ref: input.ref ?? null,
        commitSubject: input.commitSubject ?? null,
        pullRequestNumber: input.pullRequestNumber ?? null,
        requestedById: input.requestedById ?? null,
        cause: input.cause,
      },
      tx,
    );
    return hostedApplicationService.transitionRelease(
      created.id,
      'building',
      'releasing',
      { artifactRef: input.artifactRef },
      tx,
    );
  });
}

async function deployProductionRelease(
  input: DeployProductionReleaseInput,
  deps: ProductionReleaseDeps = {},
): Promise<HostedReleaseDto> {
  const readManifest = deps.readManifest ?? hostedRepositoryAccessService.readManifestAt;
  const app = await hostedApplicationService.ensureApplication(input.projectRepositoryId);
  const release = await openRelease(app.id, input);
  const id = release.id;

  try {
    const manifest = await inStep(id, 'manifest', () =>
      readManifest(input.projectRepositoryId, input.commitSha),
    );
    const needsDatabase = manifest.database.kind === 'postgres';
    const database = needsDatabase
      ? await inStep(id, 'database', async () => {
          await productionDatabaseService.ensureProductionDatabase(app.id);
          return productionDatabaseService.getProductionDatabaseEnv(app.id);
        })
      : null;
    const env = await inStep(id, 'environment', async () =>
      mergeProductionEnvironment(
        await resolveEnvironment(input.projectRepositoryId, 'production', {
          workspaceId: app.workspaceId,
        }),
        database,
      ),
    );
    const size = await inStep(id, 'environment', async () => {
      const facts = await withSystemContext((tx) =>
        projectRepoRepository.findDeployFactsInTx(input.projectRepositoryId, tx),
      );
      return facts?.hostingSize ?? 'small';
    });

    const port: HostingDeployPort = getHostingDeployPort(app.target);
    const { appRef } = await inStep(id, 'app', () =>
      port.ensureApp({
        repositoryId: input.projectRepositoryId,
        environment: { kind: 'production' },
      }),
    );
    const artifact = { kind: 'image', ref: input.artifactRef } as const;

    const migrateCommand = needsDatabase ? manifest.database.migrateCommand : undefined;
    if (migrateCommand) {
      const migrationEnv = await inStep(id, 'migrate', async () => {
        const { DIRECT_URL } = await productionDatabaseService.getProductionMigrationEnv(app.id);
        const direct: ReleaseEnvVar[] = [
          { name: 'DIRECT_URL', value: DIRECT_URL, secret: true },
          { name: MIGRATION_DIRECT_ENV_ALIAS, value: DIRECT_URL, secret: true },
        ];
        return [...env.filter((v) => !direct.some((d) => d.name === v.name)), ...direct];
      });
      const result = await inStep(id, 'migrate', () =>
        port.runReleaseCommand({
          appRef,
          artifact,
          command: migrateCommand,
          env: migrationEnv,
          timeoutSeconds: PRODUCTION_MIGRATION_TIMEOUT_SECONDS,
        }),
      );
      if (result.timedOut || result.exitCode !== 0) {
        throw new ReleaseMigrationFailedError(id, result.exitCode, result.timedOut);
      }
    }

    // Close the serving release's usage window while it still serves: once the
    // deploy replaces it the port need not answer for its handle (MOTIR-10034).
    // Never fails the release — a settle that cannot read records nothing.
    const serving = (
      await hostedApplicationService.getApplicationForRepositorySystem(input.projectRepositoryId)
    )?.currentRelease;
    if (serving?.state === 'live') {
      await hostedReleaseUsageService.settleReleaseUsage(serving.id);
    }

    const handle = await inStep(id, 'deploy', () =>
      port.deploy({
        appRef,
        environment: { kind: 'production' },
        artifact,
        runtime: manifest,
        env,
        size,
        idle: { mode: 'always_on' },
      }),
    );

    return await withSystemContext(async (tx) => {
      const live = await hostedApplicationService.transitionRelease(
        id,
        'releasing',
        'live',
        { providerReleaseId: handle.releaseId, providerRef: handle.providerRef },
        tx,
      );
      await hostedApplicationService.swapCurrentRelease(app.id, id, tx);
      return live;
    });
  } catch (error) {
    if (
      !(error instanceof ReleaseDeployFailedError || error instanceof ReleaseMigrationFailedError)
    ) {
      throw error;
    }
    return hostedApplicationService.transitionRelease(id, 'releasing', 'failed', {
      failureReason: reasonOf(error),
    });
  }
}

/** A release whose BUILD failed: its row, created straight into `failed` with
 *  the reason, the application's pointers untouched. */
async function recordFailedRelease(
  projectRepositoryId: string,
  commitSha: string,
  reason: string,
  options: Pick<
    DeployProductionReleaseInput,
    'ref' | 'commitSubject' | 'pullRequestNumber' | 'requestedById'
  > & { cause?: HostedReleaseCause } = {},
): Promise<HostedReleaseDto> {
  const app = await hostedApplicationService.ensureApplication(projectRepositoryId);
  return withSystemContext(async (tx) => {
    const created = await hostedApplicationService.createRelease(
      {
        applicationId: app.id,
        commitSha,
        ref: options.ref ?? null,
        commitSubject: options.commitSubject ?? null,
        pullRequestNumber: options.pullRequestNumber ?? null,
        requestedById: options.requestedById ?? null,
        cause: options.cause ?? 'merge',
      },
      tx,
    );
    return hostedApplicationService.transitionRelease(
      created.id,
      'building',
      'failed',
      { failureReason: reason },
      tx,
    );
  });
}

export const productionReleaseService = { deployProductionRelease, recordFailedRelease };
