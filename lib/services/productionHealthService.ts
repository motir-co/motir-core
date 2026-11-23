import {
  OrchestratorApiError,
  ReleaseNotFoundError,
  RuntimeHealthUnavailableError,
} from '@motir/orchestrator';
import type { Prisma as DbPrisma } from '@/generated/prisma/client';
import type { ProductionHealthDto, ProductionHealthLogLineDto } from '@/lib/dto/productionHealth';
import { probeHealthCheck } from '@/lib/hosting/healthProbe';
import {
  combineHealthState,
  type HealthEventDraft,
  type HostedHealthState,
  type ProbeResult,
  type RuntimeRead,
} from '@/lib/hosting/healthState';
import { releaseHandleFor } from '@/lib/hosting/releaseUsage';
import { NOTIFICATION_EVENT_TYPE } from '@/lib/notifications/preferences';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  hostedApplicationHealthRepository,
  type HostedApplicationEventRow,
} from '@/lib/repositories/hostedApplicationHealthRepository';
import {
  hostedApplicationRepository,
  type HostedApplicationProbeTarget,
} from '@/lib/repositories/hostedApplicationRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import { notificationFanInService } from '@/lib/services/notificationFanInService';
import { productionLogsService } from '@/lib/services/productionLogsService';
import { resolveRepository } from '@/lib/services/productionPanelService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A LIVE APP'S HEALTH AND ITS CRASHES (Story MOTIR-9799 · MOTIR-12106). The
// per-minute prober (`system.production-health-probe`) reads, for every
// application with a current release, the deploy port's `readHealth` and — when
// the process runs — the manifest's health-check path on its production
// address, combines them by `combineHealthState` into ONE state, and records a
// crash event, with its masked last log lines, for each transition into
// `crashed` or `unhealthy`, telling every project administrator.
//
// ⚠️ THE ORDER IS WHAT MAKES IT IDEMPOTENT.
//   1. Every network call — the port and the probe — runs OUTSIDE any
//      transaction, and a failure there leaves the stored state as it was.
//   2. Under the row's own workspace, a transaction-scoped lock serialises the
//      probers of one application; the next state is recomputed against the
//      LOCKED previous one, so of two overlapping runs the second sees the
//      first's state and records nothing.
//   3. An event is inserted with `skipDuplicates` on `(application,
//      transitionKey)`; only a row actually written reads the last lines and
//      notifies, AFTER commit — each administrator once, deduped on the event id.
//
// ⚠️ NEVER WAKES A SLEEPING APP. A runtime `suspended` is never probed.
// ⚠️ NEVER TOUCHES A CUSTOMER REPOSITORY. An organization-seeded repository's
// application is skipped before anything is read.
// ⚠️ NOTHING ABOUT THE PROJECT'S LIFECYCLE. Health is the application's alone.

const LOG = '[productionHealthService]';

/** How many of the release's last lines an event keeps. */
export const EVENT_LOG_LINES = 50;
/** How many events the health read returns. */
export const HEALTH_EVENTS_LIMIT = 50;
/** Applications probed at once in one run, so a slow probe does not hold the
 *  others past their minute. */
export const PROBE_CONCURRENCY = 8;

export type ProbeApplicationOutcome =
  | { outcome: 'probed'; state: HostedHealthState; events: number }
  | { outcome: 'skipped' }
  | { outcome: 'failed' };

export interface ProbeAllResult {
  applications: number;
  probed: number;
  skipped: number;
  failures: number;
  events: number;
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_NAME = /^[A-Za-z]{1,64}$/;

/** A failure as facts only — its name, and a status and code when they look
 *  like ones — never its message, which a provider may have written. */
function failureFacts(error: unknown): {
  error: string;
  status?: number | null;
  code?: string;
} {
  const name = error instanceof Error && ERROR_NAME.test(error.name) ? error.name : 'UNKNOWN';
  const code = (error as { code?: unknown } | null)?.code;
  return {
    error: name,
    ...(error instanceof OrchestratorApiError ? { status: error.status } : {}),
    ...(typeof code === 'string' && ERROR_CODE.test(code) ? { code } : {}),
  };
}

/** The manifest's health-check path at the release's commit, or null when it
 *  cannot be read (logged as facts; the probe is then skipped). */
async function healthCheckPathAt(app: HostedApplicationProbeTarget, commitSha: string) {
  try {
    const manifest = await hostedRepositoryAccessService.readManifestAt(
      app.projectRepositoryId,
      commitSha,
    );
    return manifest.healthCheck.path;
  } catch (error) {
    console.warn(`${LOG} could not read a release's health-check path`, {
      applicationId: app.id,
      ...failureFacts(error),
    });
    return null;
  }
}

interface RuntimeAndProbe {
  runtime: RuntimeRead;
  probe: ProbeResult | null;
  healthCheckPath: string | null;
  probedReleaseId: string | null;
}

/** The two network reads, outside any transaction. Throws only what neither
 *  read could make sense of; the caller counts it and changes nothing. */
async function readSignals(
  app: HostedApplicationProbeTarget,
  cached: { probedReleaseId: string | null; healthCheckPath: string | null } | null,
): Promise<RuntimeAndProbe> {
  const release = app.currentRelease;
  if (!release || release.state !== 'live') {
    return {
      runtime: { kind: 'no_release' },
      probe: null,
      healthCheckPath: cached?.healthCheckPath ?? null,
      probedReleaseId: cached?.probedReleaseId ?? null,
    };
  }
  const port = getHostingDeployPort(app.target);
  const { appRef } = await port.ensureApp({
    repositoryId: app.projectRepositoryId,
    environment: { kind: 'production' },
  });
  const handle = releaseHandleFor(
    { target: app.target, appRef },
    { ...release, liveAt: null, usageSettledUntil: null },
  );
  let runtime: RuntimeRead;
  if (handle === null) {
    runtime = { kind: 'no_release' };
  } else {
    try {
      runtime = { kind: 'read', health: await port.readHealth(handle) };
    } catch (error) {
      if (error instanceof RuntimeHealthUnavailableError) runtime = { kind: 'unavailable' };
      else if (error instanceof ReleaseNotFoundError) runtime = { kind: 'no_release' };
      else throw error;
    }
  }

  // The path is read once per release, then cached on the health row.
  const healthCheckPath =
    cached && cached.probedReleaseId === release.id
      ? cached.healthCheckPath
      : await healthCheckPathAt(app, release.commitSha);

  const probes =
    runtime.kind === 'unavailable' ||
    (runtime.kind === 'read' && runtime.health.state === 'running');
  const probe =
    probes && healthCheckPath && app.productionAddress
      ? await probeHealthCheck({
          productionAddress: app.productionAddress,
          path: healthCheckPath,
          target: app.target,
          appRef,
        })
      : null;
  return { runtime, probe, healthCheckPath, probedReleaseId: release.id };
}

/** The release's last lines, masked by the logs read; `[]` when unreadable. */
async function lastLogLines(
  app: HostedApplicationProbeTarget,
): Promise<ProductionHealthLogLineDto[]> {
  try {
    const page = await productionLogsService.readMaskedLines(
      { workspaceId: app.workspaceId, projectRepositoryId: app.projectRepositoryId },
      { limit: EVENT_LOG_LINES },
    );
    return page.lines.map((line) => ({
      at: line.at.toISOString(),
      stream: line.stream,
      message: line.message,
    }));
  } catch (error) {
    console.warn(`${LOG} could not read an event's last lines`, {
      applicationId: app.id,
      ...failureFacts(error),
    });
    return [];
  }
}

/** Tell every project administrator about one event; best-effort. */
async function notifyAdministrators(
  app: HostedApplicationProbeTarget,
  eventId: string,
  event: HealthEventDraft,
): Promise<void> {
  let recipients: string[];
  try {
    recipients = await projectAccessService.listUserIdsWithPermission(
      { projectId: app.projectId, workspaceId: app.workspaceId },
      'project:administer',
    );
  } catch (error) {
    console.warn(`${LOG} could not list an event's recipients`, {
      applicationId: app.id,
      eventId,
      ...failureFacts(error),
    });
    return;
  }
  const type = NOTIFICATION_EVENT_TYPE.productionAppCrashed;
  for (const recipientUserId of recipients) {
    await notificationFanInService.notifyProjectEvent({
      workspaceId: app.workspaceId,
      recipientUserId,
      type,
      category: 'direct',
      dedupeKey: `${type}:${eventId}`,
      data: {
        kind: 'production_app_crashed',
        projectKey: app.projectKey,
        projectRepositoryId: app.projectRepositoryId,
        repositoryName: app.repositoryName,
        applicationId: app.id,
        eventId,
        eventKind: event.kind,
        reason: event.reason,
        occurredAt: event.occurredAt.toISOString(),
      },
    });
  }
}

/**
 * Probe one application and store its next state; never throws. `skipped` for
 * an application that is gone or whose repository is a customer's; `failed`
 * when a read or the write failed, which leaves the stored state as it was.
 */
async function probeApplication(
  applicationId: string,
  options: { now?: () => Date } = {},
): Promise<ProbeApplicationOutcome> {
  let app: HostedApplicationProbeTarget | null = null;
  try {
    app = await withSystemContext((tx) =>
      hostedApplicationRepository.findProbeTarget(applicationId, tx),
    );
    if (!app || isOrganizationSeedSource(app.seedSource)) return { outcome: 'skipped' };
    const found = app;

    const cached = await withWorkspaceServiceContext(found.workspaceId, (tx) =>
      hostedApplicationHealthRepository.findForApplication(found.id, tx),
    );
    const signals = await readSignals(found, cached);
    const now = (options.now ?? (() => new Date()))();
    const releaseId = found.currentRelease?.id ?? null;

    const { next, written } = await withWorkspaceServiceContext(found.workspaceId, async (tx) => {
      const previous = await hostedApplicationHealthRepository.lockForUpdate(found.id, tx);
      const newestCrashAt = releaseId
        ? await hostedApplicationHealthRepository.newestCrashAt(found.id, releaseId, tx)
        : null;
      const next = combineHealthState({
        previous,
        runtime: signals.runtime,
        probe: signals.probe,
        now,
        newestCrashAt,
      });
      await hostedApplicationHealthRepository.upsertState(
        {
          applicationId: found.id,
          workspaceId: found.workspaceId,
          state: next.state,
          since: next.since,
          condition: next.condition,
          consecutiveProbeFailures: next.consecutiveProbeFailures,
          probedReleaseId: signals.probedReleaseId,
          healthCheckPath: signals.healthCheckPath,
          lastProbedAt: signals.probe ? now : (previous?.lastProbedAt ?? null),
        },
        tx,
      );
      const written: Array<{ id: string; event: HealthEventDraft }> = [];
      for (const event of next.events) {
        const id = await hostedApplicationHealthRepository.insertEvent(
          {
            workspaceId: found.workspaceId,
            applicationId: found.id,
            releaseId,
            kind: event.kind,
            reason: event.reason,
            exitCode: event.exitCode,
            occurredAt: event.occurredAt,
            transitionKey: event.transitionKey,
          },
          tx,
        );
        if (id) written.push({ id, event });
      }
      return { next, written };
    });

    if (written.length > 0) {
      const lines = await lastLogLines(found);
      for (const { id, event } of written) {
        if (lines.length > 0) {
          try {
            await withWorkspaceServiceContext(found.workspaceId, (tx) =>
              hostedApplicationHealthRepository.setEventLogLines(
                id,
                lines as unknown as DbPrisma.InputJsonValue,
                tx,
              ),
            );
          } catch (error) {
            console.warn(`${LOG} could not store an event's last lines`, {
              applicationId: found.id,
              eventId: id,
              ...failureFacts(error),
            });
          }
        }
        await notifyAdministrators(found, id, event);
      }
    }
    return { outcome: 'probed', state: next.state, events: written.length };
  } catch (error) {
    console.warn(`${LOG} could not probe an application`, {
      applicationId,
      ...failureFacts(error),
    });
    return { outcome: 'failed' };
  }
}

/** Run `fn` over `items`, at most `limit` at once. */
async function eachLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Probe every application with a current release whose repository is not a
 *  customer's, each isolated. */
async function probeAll(options: { now?: () => Date } = {}): Promise<ProbeAllResult> {
  const rows = await withSystemContext((tx) =>
    hostedApplicationRepository.listWithCurrentRelease(tx),
  );
  const ids = rows.filter((r) => !isOrganizationSeedSource(r.seedSource)).map((r) => r.id);
  const outcomes = await eachLimited(ids, PROBE_CONCURRENCY, (id) => probeApplication(id, options));
  const result: ProbeAllResult = {
    applications: ids.length,
    probed: 0,
    skipped: 0,
    failures: 0,
    events: 0,
  };
  for (const o of outcomes) {
    if (o.outcome === 'probed') {
      result.probed += 1;
      result.events += o.events;
    } else if (o.outcome === 'skipped') result.skipped += 1;
    else result.failures += 1;
  }
  return result;
}

function toLogLines(raw: DbPrisma.JsonValue): ProductionHealthLogLineDto[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e.message !== 'string' || typeof e.at !== 'string') return [];
    return [
      {
        at: e.at,
        stream: e.stream === 'platform' ? ('platform' as const) : ('app' as const),
        message: e.message,
      },
    ];
  });
}

function toEventDto(row: HostedApplicationEventRow) {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    kind: row.kind,
    reason: row.reason,
    lastLogLines: toLogLines(row.lastLogLines),
    releaseId: row.releaseId,
  };
}

/**
 * The health read behind `GET …/production/health`, for anyone who can browse
 * the project: the repository resolved as the Production panel resolves it
 * (not found for an unknown, another project's, a customer or an unbrowsable
 * repository), then its application's state and events, newest first.
 */
async function getHealthForRepository(
  projectKey: string,
  projectRepositoryId: string,
  actor: ServiceContext,
): Promise<ProductionHealthDto> {
  const { projectId } = await resolveRepository(projectKey, projectRepositoryId, actor);
  const permissions = await projectAccessService.getPermissions(projectId, actor);
  if (!permissions.has('project:browse')) throw new ProjectNotFoundError(projectId);
  const app = await hostedApplicationService.getApplicationForRepository(
    actor.workspaceId,
    projectRepositoryId,
  );
  if (!app) return { state: null, since: null, condition: null, events: [] };
  return withWorkspaceServiceContext(actor.workspaceId, async (tx) => {
    const health = app.currentRelease
      ? await hostedApplicationHealthRepository.findForApplication(app.id, tx)
      : null;
    const events = await hostedApplicationHealthRepository.listEvents(
      app.id,
      { limit: HEALTH_EVENTS_LIMIT },
      tx,
    );
    return {
      state: health?.state ?? null,
      since: health ? health.since.toISOString() : null,
      condition: health?.condition ?? null,
      events: events.map(toEventDto),
    };
  });
}

export const productionHealthService = { probeAll, probeApplication, getHealthForRepository };
