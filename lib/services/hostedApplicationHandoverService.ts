import { hostingAppNames } from '@motir/orchestrator';
import type { HostedApplicationState, Prisma } from '@/generated/prisma/client';
import {
  repositoryActionsConfigClient,
  type RepositoryCoordinates,
} from '@/lib/github/repositoryActionsConfig';
import {
  ApplicationNotFoundError,
  ApplicationNotStoppableError,
  ApplicationStopFailedError,
  HostedApplicationHandoverError,
  type ApplicationStopStep,
  type HostedApplicationHandoverStep,
} from '@/lib/hosting/errors';
import {
  HOSTING_TARGET_VARIABLE,
  PRODUCTION_ENVIRONMENT,
  PRODUCTION_IMAGE_VARIABLE,
} from '@/lib/hosting/productionEnablementNames';
import { HOSTED_APPLICATION_GRACE_DAYS, type GraceNoticeKind } from '@/lib/hosting/vocabulary';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import { hostedApplicationExportRepository } from '@/lib/repositories/hostedApplicationExportRepository';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { hostedApplicationExportService } from '@/lib/services/hostedApplicationExportService';
import { assertOrgCapability } from '@/lib/services/organizationAccessService';
import { productionTeardownService } from '@/lib/services/productionTeardownService';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE HANDOVER OF A HOSTED APPLICATION (Story MOTIR-9800). At takeover a live app
// is handed over, not destroyed: the `hosted_application` row is the record of
// what was handed over and is KEPT, and Motir stops serving the app's addresses.
// The AWS handover saga's `remove_access` step and the stop at the end of a
// serverless or Fly grace window both end here; the grace cards add their own
// methods to this service.
//
// ── The address methods run in the CALLER's transaction ───────────────────
//
// `releaseApplicationAddresses` and `listCustomerDomainUpstreams` take the
// caller's `withWorkspaceServiceContext` transaction as `tx`, so a stop that
// fails later rolls their writes back with it; they open none and call no
// host. The grace-window methods (`prepareForTransfer`, `startGrace`,
// `stopApplication`) open their own short transactions and make their provider
// calls outside any of them.
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

  /** Enqueue a grace notice after the transaction that decided it committed
   *  (`startGrace`'s `transferred`, the stop's `stopped`). Keyed
   *  `<applicationId>:<kind>`, so the queue holds one of each kind. */
  async sendGraceNotice(notice: GraceNotice | null): Promise<void> {
    if (!notice) return;
    await sendEvent('hosting.application-grace.notice', {
      workspaceId: notice.workspaceId,
      applicationId: notice.applicationId,
      kind: notice.kind,
      idempotencyKey: `${notice.applicationId}:${notice.kind}`,
    });
  },

  /** The `grace` applications whose `stopsAt` is at or before `now`, soonest
   *  first — what the stop sweep walks (MOTIR-12135). Cross-tenant: read under
   *  the system context. */
  async listApplicationsDueToStop(now: Date = new Date()): Promise<string[]> {
    const rows = await withSystemContext((tx) =>
      hostedApplicationRepository.listInGraceStoppingBy(now, tx),
    );
    return rows.map((row) => row.id);
  },

  /**
   * END a grace window (MOTIR-12135): the scheduled sweep once `stopsAt` has
   * passed, or an organisation admin's Stop now. Under the application's stop
   * lock, five steps, each looking before it acts and recording its result
   * before the next starts:
   *
   *   1. stop serving — usage settled, the production app destroyed, its
   *      pointers forgotten (before the dump, so no write lands after it);
   *   2. the final export — taken unless a `final` export row exists, then
   *      REQUIRED: no row, no step 3;
   *   3. the database deleted at the provider, then forgotten on the row;
   *   4–5. in ONE transaction: the addresses released and the row moved to
   *      `handed_over` with `handedOverAt`; after it commits, the `stopped`
   *      notice enqueued.
   *
   * The row is KEPT. A stop cut off at any step and run again continues from
   * that step, so `destroyApp` and `deleteDatabase` reach the provider at most
   * once in effect, and the database is never deleted while no final export
   * row exists. Nothing here reads a credit balance: only `stopsAt` and Stop
   * now end a window.
   *
   * An application already `handed_over` answers `already_stopped` and calls
   * nothing at the provider; when it was handed over by a stop (its final
   * export exists), the `stopped` notice is enqueued again under its key, which
   * the queue collapses — so a stop cut off between its commit and its enqueue
   * still sends its notice.
   *
   * @throws ApplicationNotFoundError — no such application, or (through a
   *   route's `scope`) another organisation's or one the caller is not in.
   * @throws OrgForbiddenError — a user actor who is not an organisation admin.
   * @throws ApplicationNotStoppableError — neither `grace` nor `handed_over`.
   * @throws ApplicationStopFailedError — a step failed; still `grace`.
   */
  async stopApplication(
    applicationId: string,
    actor: StopActor,
    scope?: StopScope,
  ): Promise<StopOutcome> {
    const subject = await readStopSubject(applicationId);
    if (!subject || (scope && scope.organizationId !== subject.organizationId)) {
      throw new ApplicationNotFoundError(applicationId);
    }
    if (actor.kind === 'user') await assertStopAdmin(actor.userId, subject, scope);
    if (subject.state !== 'grace' && subject.state !== 'handed_over') {
      throw new ApplicationNotStoppableError(applicationId, subject.state);
    }
    const { workspaceId } = subject;
    return withSystemContext(
      async (lockTx) => {
        await hostedApplicationRepository.lockStop(applicationId, lockTx);
        // Re-read under the lock: a stop that held it before us may have
        // finished the job.
        const app = await withWorkspaceServiceContext(workspaceId, (tx) =>
          hostedApplicationRepository.findTeardownById(applicationId, tx),
        );
        if (!app) throw new ApplicationNotFoundError(applicationId);
        if (app.state === 'handed_over') return alreadyStopped(applicationId, workspaceId);
        if (app.state !== 'grace') throw new ApplicationNotStoppableError(applicationId, app.state);

        await stopStep(applicationId, 'stop_serving', () =>
          productionTeardownService.removeProductionApp(app, workspaceId),
        );
        const finalExportId = await stopStep(applicationId, 'final_export', () =>
          ensureFinalExport(applicationId, workspaceId),
        );
        await stopStep(applicationId, 'delete_database', () =>
          productionTeardownService.deleteProductionDatabase(app, workspaceId),
        );
        const handedOverAt = new Date();
        await stopStep(applicationId, 'record', () =>
          withWorkspaceServiceContext(workspaceId, async (tx) => {
            await hostedApplicationRepository.lockForUpdate(applicationId, tx);
            await hostedApplicationHandoverService.releaseApplicationAddresses(applicationId, tx);
            await hostedApplicationRepository.setStateIfIn(
              applicationId,
              ['grace'],
              'handed_over',
              { handedOverAt },
              tx,
            );
          }),
        );
        await hostedApplicationHandoverService.sendGraceNotice({
          workspaceId,
          applicationId,
          kind: 'stopped',
        });
        return { outcome: 'stopped', applicationId, handedOverAt, finalExportId };
      },
      { timeout: STOP_LOCK_TIMEOUT_MS },
    );
  },
};

// ── The stop at the end of a grace window (MOTIR-12135) ─────────────────────

/** How long one stop may hold its lock: the final export streams a whole
 *  database to storage inside it. */
export const STOP_LOCK_TIMEOUT_MS = 30 * 60_000;

/** Who stops an application: the sweep, or an organisation admin. */
export type StopActor = { kind: 'user'; userId: string } | { kind: 'system' };

/** The organisation a route reached the application through. */
export interface StopScope {
  organizationId: string;
}

export type StopOutcome =
  | { outcome: 'stopped'; applicationId: string; handedOverAt: Date; finalExportId: string }
  | {
      outcome: 'already_stopped';
      applicationId: string;
      handedOverAt: Date | null;
      finalExportId: string | null;
    };

interface StopSubject {
  id: string;
  workspaceId: string;
  organizationId: string;
  state: HostedApplicationState;
}

async function readStopSubject(applicationId: string): Promise<StopSubject | null> {
  return withSystemContext(async (tx) => {
    const app = await hostedApplicationRepository.findById(applicationId, tx);
    if (!app) return null;
    const organizationId = await workspaceRepository.findOrganizationId(app.workspaceId, tx);
    if (!organizationId) return null;
    return { id: app.id, workspaceId: app.workspaceId, organizationId, state: app.state };
  });
}

/** The organisation-admin gate. Through a route a non-member is not found, as
 *  every organisation door answers; to a direct caller, not an admin. */
async function assertStopAdmin(
  userId: string,
  subject: StopSubject,
  scope: StopScope | undefined,
): Promise<void> {
  try {
    await assertOrgCapability(userId, subject.organizationId, 'manageOrgSettings');
  } catch (err) {
    if (err instanceof OrganizationNotFoundError) {
      if (scope) throw new ApplicationNotFoundError(subject.id);
      throw new OrgForbiddenError(userId, subject.organizationId);
    }
    throw err;
  }
}

/** The final export's id: the one already recorded, else a new one, re-read
 *  and required before the database may be deleted. */
async function ensureFinalExport(applicationId: string, workspaceId: string): Promise<string> {
  const finalExport = () =>
    withWorkspaceServiceContext(workspaceId, (tx) =>
      hostedApplicationExportRepository.findFinalByApplication(applicationId, tx),
    );
  const existing = await finalExport();
  if (existing) return existing.id;
  await hostedApplicationExportService.createExport(
    applicationId,
    { kind: 'final' },
    { kind: 'system' },
  );
  const stored = await finalExport();
  if (!stored) throw new Error('FINAL_EXPORT_NOT_RECORDED');
  return stored.id;
}

/** An application already handed over: nothing to do but make sure a stop's
 *  notice was enqueued (the queue collapses a repeat by its key). */
async function alreadyStopped(applicationId: string, workspaceId: string): Promise<StopOutcome> {
  const { handedOverAt, finalExportId } = await withWorkspaceServiceContext(
    workspaceId,
    async (tx) => ({
      handedOverAt: (await hostedApplicationRepository.findById(applicationId, tx))?.handedOverAt,
      finalExportId:
        (await hostedApplicationExportRepository.findFinalByApplication(applicationId, tx))?.id ??
        null,
    }),
  );
  if (finalExportId) {
    await hostedApplicationHandoverService.sendGraceNotice({
      workspaceId,
      applicationId,
      kind: 'stopped',
    });
  }
  return {
    outcome: 'already_stopped',
    applicationId,
    handedOverAt: handedOverAt ?? null,
    finalExportId,
  };
}

/** The safe facts of a failure: its code when it carries a typed one, else
 *  its class name — never its message, which can hold a provider body. */
function failureCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  if (err instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(err.message)) return err.message;
  return err instanceof Error && /^[A-Za-z]{1,64}$/.test(err.name) ? err.name : 'UNKNOWN';
}

/** Run one stop step; any failure becomes the typed error naming it. */
async function stopStep<T>(
  applicationId: string,
  name: ApplicationStopStep,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new ApplicationStopFailedError(applicationId, name, failureCode(err));
  }
}

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

/** A grace notice to enqueue after the transaction that decided it commits. */
export interface GraceNotice {
  readonly workspaceId: string;
  readonly applicationId: string;
  readonly kind: GraceNoticeKind;
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
    notice: { workspaceId: app.workspaceId, applicationId: app.id, kind: 'transferred' },
  };
}
