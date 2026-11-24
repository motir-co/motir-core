import {
  LogsUnavailableError,
  OrchestratorApiError,
  ReleaseNotFoundError,
  type ReleaseLogLine,
} from '@motir/orchestrator';
import type { ProductionLogsDto, ProductionLogsState } from '@/lib/dto/productionLogs';
import { InvalidLogCursorError } from '@/lib/hosting/errors';
import {
  connectionStringSecrets,
  maskSecretValues,
  matchesOutsideSecrets,
  secretNeedles,
} from '@/lib/hosting/logMasking';
import { logLimit, type ProductionLogQuery } from '@/lib/hosting/productionLogQuery';
import { releaseHandleFor } from '@/lib/hosting/releaseUsage';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { hostedReleaseRepository } from '@/lib/repositories/hostedReleaseRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { resolveRepository } from '@/lib/services/productionPanelService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A MOTIR REPOSITORY'S PRODUCTION LOGS (Story MOTIR-9799 · MOTIR-12105): one
// page of the CURRENT release's output, read from whichever target it runs on
// through the deploy port, with every production secret value masked.
//
// ⚠️ `readMaskedLines` IS THE ONLY CALLER OF THE PORT'S `readLogs`. The port
// returns lines exactly as the target holds them; every reader in Motir — the
// route below, the crash-event recorder — goes through this method, so every
// line it receives is masked by construction.
//
// ⚠️ NOTHING IS KEPT. No line, secret value or provider message is stored,
// logged or put in an error: the secrets are read fresh on every call (so a
// secret saved after the release went live still masks), live in this call's
// memory only, and a target that cannot answer is the `unavailable` state, not
// an error carrying its words.

/** The application whose current release is read — a caller that already holds
 *  a trusted one (the crash recorder) names it by its repository. */
export interface ProductionLogsScope {
  workspaceId: string;
  projectRepositoryId: string;
}

/** One masked line, as the port's line with its message masked. */
export type MaskedLogLine = ReleaseLogLine;

export interface MaskedLogPage {
  state: ProductionLogsState;
  /** Newest first. */
  lines: MaskedLogLine[];
  cursor: string | null;
}

const empty = (state: Exclude<ProductionLogsState, 'ok'>): MaskedLogPage => ({
  state,
  lines: [],
  cursor: null,
});

/** The values to mask: every secret entry, and the password inside any secret
 *  that is a connection string. */
async function secretNeedlesFor(application: {
  id: string;
  workspaceId: string;
  projectRepositoryId: string;
}): Promise<string[]> {
  const secrets = await productionReleaseService.productionSecretEnvironment(application);
  return secretNeedles(secrets.flatMap((s) => [s.value, ...connectionStringSecrets(s.value)]));
}

/**
 * The SYSTEM read: a page of the application's current release's output, newest
 * first, masked. No actor — the caller holds the scope. `no_release` when the
 * repository has no application, no current release, or one that is not live;
 * `unavailable` when the target cannot answer.
 */
async function readMaskedLines(
  scope: ProductionLogsScope,
  query: ProductionLogQuery,
): Promise<MaskedLogPage> {
  const limit = logLimit(query.limit);
  const app = await hostedApplicationService.getApplicationForRepository(
    scope.workspaceId,
    scope.projectRepositoryId,
  );
  if (!app?.currentRelease) return empty('no_release');
  const currentReleaseId = app.currentRelease.id;
  const release = await withWorkspaceServiceContext(scope.workspaceId, (tx) =>
    hostedReleaseRepository.findUsageTarget(currentReleaseId, tx),
  );
  if (!release || release.state !== 'live') return empty('no_release');

  // Before the target is read, so output is never fetched that could not be masked.
  const needles = await secretNeedlesFor(app);

  let page;
  try {
    const port = getHostingDeployPort(app.target);
    const { appRef } = await port.ensureApp({
      repositoryId: app.projectRepositoryId,
      environment: { kind: 'production' },
    });
    const handle = releaseHandleFor({ target: app.target, appRef }, release);
    if (handle === null) return empty('no_release');
    page = await port.readLogs(handle, {
      ...(query.since ? { since: query.since } : {}),
      ...(query.until ? { until: query.until } : {}),
      ...(query.filter ? { filter: query.filter } : {}),
      limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  } catch (error) {
    if (error instanceof ReleaseNotFoundError) return empty('no_release');
    if (error instanceof LogsUnavailableError) return empty('unavailable');
    if (error instanceof OrchestratorApiError) {
      // A cursor is decoded before any call to the target, so its refusal is
      // the caller's 400; any other refusal is the target not answering.
      if (query.cursor && error.status === 400) throw new InvalidLogCursorError();
      return empty('unavailable');
    }
    throw error;
  }

  const lines: MaskedLogLine[] = [];
  for (const line of page.lines) {
    // The target matched the RAW text: a line whose filter match was only
    // inside a secret is dropped, so the filter cannot probe a secret.
    if (!matchesOutsideSecrets(line.message, needles, query.filter)) continue;
    lines.push({
      at: line.at,
      stream: line.stream,
      message: maskSecretValues(line.message, needles),
    });
  }
  return { state: 'ok', lines, cursor: page.cursor };
}

export interface ReadProductionLogsInput {
  projectKey: string;
  projectRepositoryId: string;
  actor: ServiceContext;
  query: ProductionLogQuery;
}

/**
 * The ACTOR read behind `GET …/production/logs`: the repository resolved as the
 * Production panel resolves it — not found for an unknown, another project's, a
 * customer or an unbrowsable repository, before the target is touched — then
 * `readMaskedLines`.
 */
async function readProductionLogs(input: ReadProductionLogsInput): Promise<ProductionLogsDto> {
  const { projectId } = await resolveRepository(
    input.projectKey,
    input.projectRepositoryId,
    input.actor,
  );
  const permissions = await projectAccessService.getPermissions(projectId, input.actor);
  if (!permissions.has('project:browse')) throw new ProjectNotFoundError(projectId);
  const page = await readMaskedLines(
    { workspaceId: input.actor.workspaceId, projectRepositoryId: input.projectRepositoryId },
    input.query,
  );
  return {
    lines: page.lines.map((line) => ({
      at: line.at.toISOString(),
      stream: line.stream,
      message: line.message,
    })),
    cursor: page.cursor,
    state: page.state,
  };
}

export const productionLogsService = { readMaskedLines, readProductionLogs };
