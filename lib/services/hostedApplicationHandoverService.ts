import { hostingAppNames } from '@motir/orchestrator';
import type { HostedApplicationState, Prisma } from '@/generated/prisma/client';
import {
  repositoryActionsConfigClient,
  type RepositoryCoordinates,
} from '@/lib/github/repositoryActionsConfig';
import {
  ApplicationNotFoundError,
  HostedApplicationHandoverError,
  type HostedApplicationHandoverStep,
} from '@/lib/hosting/errors';
import {
  HOSTING_TARGET_VARIABLE,
  PRODUCTION_ENVIRONMENT,
  PRODUCTION_IMAGE_VARIABLE,
} from '@/lib/hosting/productionEnablementNames';
import { HOSTED_APPLICATION_GRACE_DAYS } from '@/lib/hosting/vocabulary';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

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

  /**
   * Withdraw what production enablement put in a serverless or Fly repository,
   * BEFORE its transfer, the application reading `handing_over` first. Outside
   * any transaction (provider and GitHub calls). Look-before-act: a second run
   * finds the state already written and every resource `absent`, and answers
   * the same. `not_applicable` for an AWS repository, a customer repository and
   * one with no application; `past_transfer` for one already in grace or handed
   * over.
   *
   * @throws HostedApplicationHandoverError naming the step that failed.
   */
  async prepareForTransfer(repoRowId: string): Promise<PrepareOutcome> {
    const subject = await graceSubject(repoRowId);
    if (!subject) return { outcome: 'not_applicable' };
    const { app, coordinates } = subject;
    if (!PREPARABLE_STATES.includes(app.state)) return { outcome: 'past_transfer' };

    await step(repoRowId, 'set_state', () =>
      withWorkspaceServiceContext(app.workspaceId, (tx) =>
        hostedApplicationRepository.setStateIfIn(
          app.id,
          ['live'],
          'handing_over',
          { stopsAt: null },
          tx,
        ),
      ),
    );
    await step(repoRowId, 'revoke_credential', () =>
      getHostingDeployPort(app.target).revokeDeployCredentials({
        pushNamespace: productionPushNamespace(repoRowId, app.productionAppName),
      }),
    );
    if (!coordinates) return { outcome: 'prepared', applicationId: app.id };
    await step(repoRowId, 'delete_environment', () =>
      repositoryActionsConfigClient.deleteEnvironment(coordinates, PRODUCTION_ENVIRONMENT),
    );
    await step(repoRowId, 'delete_variables', async () => {
      await repositoryActionsConfigClient.deleteVariable(coordinates, PRODUCTION_IMAGE_VARIABLE);
      await repositoryActionsConfigClient.deleteVariable(coordinates, HOSTING_TARGET_VARIABLE);
    });
    return { outcome: 'prepared', applicationId: app.id };
  },

  /**
   * The takeover failed before the repository moved: a `handing_over`
   * application goes back to `live` with `stopsAt` null, and production
   * enablement is forgotten in the same transaction, so the backfill's next
   * `enableProduction` re-mints the credential and writes the environment and
   * the variables again. The removed credentials are not restored here.
   */
  async cancelPreparation(repoRowId: string): Promise<CancelOutcome> {
    const subject = await graceSubject(repoRowId);
    if (!subject) return { outcome: 'not_applicable' };
    const { app } = subject;
    const restored = await withWorkspaceServiceContext(app.workspaceId, async (tx) => {
      const moved = await hostedApplicationRepository.setStateIfIn(
        app.id,
        ['handing_over'],
        'live',
        { stopsAt: null },
        tx,
      );
      if (moved) await hostedApplicationRepository.clearProductionEnablement(app.id, tx);
      return moved;
    });
    return restored
      ? { outcome: 'restored', applicationId: app.id }
      : { outcome: 'not_handing_over', applicationId: app.id };
  },

  /**
   * The repository's transfer was recorded at `transferredAt`: the application
   * enters `grace`, `stopsAt` = `transferredAt` + 30 days. Given `tx` (the
   * caller's transaction, which records the transfer), the state commits with
   * it and the CALLER enqueues the returned notice after commit
   * (`sendGraceNotice`); without one, this opens its own and enqueues it. A
   * second call finds the application already past `handing_over` and writes
   * and enqueues nothing.
   */
  async startGrace(
    repoRowId: string,
    transferredAt: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<GraceStartOutcome> {
    if (tx) return startGraceInTx(repoRowId, transferredAt, tx);
    const workspaceId = await withSystemContext(
      async (sys) =>
        (await projectRepoRepository.findPreviewSubjectInTx(repoRowId, sys))?.workspaceId,
    );
    if (!workspaceId) return { outcome: 'not_applicable', notice: null };
    const outcome = await withWorkspaceServiceContext(workspaceId, (wtx) =>
      startGraceInTx(repoRowId, transferredAt, wtx),
    );
    await hostedApplicationHandoverService.sendGraceNotice(outcome.notice);
    return outcome;
  },

  /** Enqueue a grace notice `startGrace` returned, after its transaction
   *  committed. Keyed `<applicationId>:<kind>`, so it is sent once. */
  async sendGraceNotice(notice: GraceNotice | null): Promise<void> {
    if (!notice) return;
    await sendEvent('hosting.application-grace.notice', {
      workspaceId: notice.workspaceId,
      applicationId: notice.applicationId,
      kind: 'transferred',
      idempotencyKey: `${notice.applicationId}:transferred`,
    });
  },
};

// ── The grace window's helpers (MOTIR-12132) ────────────────────────────────

/** The targets whose application cannot leave with its repository. */
const GRACE_TARGETS: readonly string[] = ['serverless', 'fly'];

/** The states a preparation runs from: a first run, or a re-run. */
const PREPARABLE_STATES: readonly HostedApplicationState[] = ['live', 'handing_over'];

const DAY_MS = 86_400_000;

export type PrepareOutcome =
  | { outcome: 'prepared'; applicationId: string }
  | { outcome: 'past_transfer' }
  | { outcome: 'not_applicable' };

export type CancelOutcome =
  | { outcome: 'restored'; applicationId: string }
  | { outcome: 'not_handing_over'; applicationId: string }
  | { outcome: 'not_applicable' };

/** The `transferred` notice to enqueue after the grace window's commit. */
export interface GraceNotice {
  readonly workspaceId: string;
  readonly applicationId: string;
}

export type GraceStartOutcome =
  | { outcome: 'started'; applicationId: string; stopsAt: Date; notice: GraceNotice }
  | { outcome: 'already_started'; applicationId: string; notice: null }
  | { outcome: 'not_applicable'; notice: null };

/** The production push namespace: the app enablement recorded, else the one
 *  its deterministic `mh-<rid>` name gives. */
function productionPushNamespace(repoRowId: string, appName: string | null): string {
  return appName ?? hostingAppNames('mh-', repoRowId, { kind: 'production' }).pushNamespace;
}

/** Run one preparation step; any failure becomes the typed error naming it. */
async function step<T>(
  repoRowId: string,
  name: HostedApplicationHandoverStep,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new HostedApplicationHandoverError(
      repoRowId,
      name,
      err instanceof Error ? err.message : 'unknown',
    );
  }
}

/** The repository's serverless or Fly application and the coordinates the
 *  provisioning App reaches the repository by, or null when the grace window
 *  does not apply: no row, a customer repository, no application, or AWS. */
async function graceSubject(repoRowId: string) {
  const repo = await withSystemContext((tx) =>
    projectRepoRepository.findPreviewSubjectInTx(repoRowId, tx),
  );
  if (!repo || isOrganizationSeedSource(repo.seedSource)) return null;
  const app = await withWorkspaceServiceContext(repo.workspaceId, (tx) =>
    hostedApplicationRepository.findByProjectRepository(repoRowId, tx),
  );
  if (!app || !GRACE_TARGETS.includes(app.target)) return null;
  const realized = repo.githubRepo;
  const coordinates: RepositoryCoordinates | null = realized
    ? {
        installationId: realized.installation.installationId,
        owner: realized.owner,
        repo: realized.name,
      }
    : null;
  return { app, coordinates };
}

async function startGraceInTx(
  repoRowId: string,
  transferredAt: Date,
  tx: Prisma.TransactionClient,
): Promise<GraceStartOutcome> {
  const app = await hostedApplicationRepository.findByProjectRepository(repoRowId, tx);
  if (!app || !GRACE_TARGETS.includes(app.target))
    return { outcome: 'not_applicable', notice: null };
  const stopsAt = new Date(transferredAt.getTime() + HOSTED_APPLICATION_GRACE_DAYS * DAY_MS);
  const started = await hostedApplicationRepository.setStateIfIn(
    app.id,
    PREPARABLE_STATES,
    'grace',
    { stopsAt },
    tx,
  );
  if (!started) return { outcome: 'already_started', applicationId: app.id, notice: null };
  return {
    outcome: 'started',
    applicationId: app.id,
    stopsAt,
    notice: { workspaceId: app.workspaceId, applicationId: app.id },
  };
}
