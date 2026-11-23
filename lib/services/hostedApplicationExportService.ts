import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { HostedApplicationExport } from '@/generated/prisma/client';
import { deleteAttachmentBlob, putPrivateStream, signedDownloadUrl } from '@/lib/blob/uploader';
import type { HostedApplicationExportDto } from '@/lib/dto/hostedApplicationExport';
import {
  ExportFailedError,
  ExportNotAllowedError,
  ExportNotFoundError,
  ExportTargetUnsupportedError,
} from '@/lib/hosting/errors';
import type { HostedApplicationExportKind } from '@/lib/hosting/vocabulary';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { toHostedApplicationExportDto } from '@/lib/mappers/hostedApplicationExportMappers';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';
import { hostedApplicationExportDownloadRepository } from '@/lib/repositories/hostedApplicationExportDownloadRepository';
import { hostedApplicationExportRepository } from '@/lib/repositories/hostedApplicationExportRepository';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { assertOrgCapability } from '@/lib/services/organizationAccessService';
import { productionDatabaseService } from '@/lib/services/productionDatabaseService';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A GRACE-WINDOW APPLICATION'S DATABASE EXPORT (Story MOTIR-9800 · MOTIR-12134).
// A serverless or Fly application handed over at takeover keeps running for 30
// days on Motir's account (decision MOTIR-9802); during that window an
// organisation admin can take a Postgres custom-format dump of its production
// database and download it, and the stop takes a `final` one the same way. An
// AWS application's database leaves with its account, so it has none here.
//
// ── A row exists only for a stored dump ───────────────────────────────────
//
// `pg_dump` streams straight into a multipart upload under a key named by the
// export's id; only after the upload completes and the store reports its size
// is the `hosted_application_export` row written. A failed dump or upload
// deletes whatever object was written and writes no row. So a caller holding an
// export id holds a stored export — which is what the stop relies on before it
// deletes the database.
//
// ── The connection string is a credential ─────────────────────────────────
//
// It is the DIRECT (unpooled) string — a pooled connection cannot hold a dump's
// snapshot — read through `productionDatabaseService` at the moment of use and
// never cached. The password goes to `pg_dump` in its environment
// (`PGPASSWORD`), not in its argument list, where any process in the container
// could read it; `pg_dump`'s own output on stderr is drained and never logged or
// put in an error, which carries only an exit code or a store's HTTP status.

/** Who asks: an organisation admin, or the system (the stop's final export). */
export type ExportActor = { kind: 'user'; userId: string } | { kind: 'system' };

/** The organisation a route reaches the application through; an application of
 *  another organisation is answered as not found. */
export interface ExportScope {
  organizationId: string;
}

/** How long a dump stays downloadable, by kind: the final export for the 30
 *  days decision MOTIR-9802 fixes, an on-demand one a week (the admin can take
 *  another while the application runs). */
const EXPORT_RETENTION_DAYS: Record<HostedApplicationExportKind, number> = {
  final: 30,
  on_demand: 7,
};

/** The targets whose production database Motir holds. */
const EXPORTABLE_TARGETS: readonly string[] = ['serverless', 'fly'];

const DAY_MS = 86_400_000;
const DUMP_CONTENT_TYPE = 'application/octet-stream';

/** A signed download link lives as long as the content route's: five minutes. */
const DOWNLOAD_URL_TTL_SECONDS = 300;

/** Where an export's dump is stored. */
export function exportStorageKey(
  workspaceId: string,
  applicationId: string,
  exportId: string,
): string {
  return `hosting-exports/${workspaceId}/${applicationId}/${exportId}.dump`;
}

/** The application an export is about, with the organisation that owns it. */
interface ExportSubject {
  id: string;
  workspaceId: string;
  organizationId: string;
  target: string;
  state: string;
}

async function readSubject(applicationId: string): Promise<ExportSubject | null> {
  return withSystemContext(async (tx) => {
    const app = await hostedApplicationRepository.findById(applicationId, tx);
    if (!app) return null;
    const organizationId = await workspaceRepository.findOrganizationId(app.workspaceId, tx);
    if (!organizationId) return null;
    return {
      id: app.id,
      workspaceId: app.workspaceId,
      organizationId,
      target: app.target,
      state: app.state,
    };
  });
}

/**
 * The organisation-admin gate (Owner or Admin). Through a route (`scope`), a
 * non-member is answered as not found, as every organisation door answers; to a
 * direct caller a non-member is simply not an admin.
 */
async function assertAdmin(
  userId: string,
  subject: ExportSubject,
  scope: ExportScope | undefined,
  notFoundId: string,
): Promise<void> {
  try {
    await assertOrgCapability(userId, subject.organizationId, 'manageOrgSettings');
  } catch (err) {
    if (err instanceof OrganizationNotFoundError) {
      if (scope) throw new ExportNotFoundError(notFoundId);
      throw new OrgForbiddenError(userId, subject.organizationId);
    }
    throw err;
  }
}

/** Read the application and refuse anything this export may not do, before any
 *  dump: the target, the kind for the actor, the admin gate, the grace window. */
async function gate(
  applicationId: string,
  kind: HostedApplicationExportKind,
  actor: ExportActor,
  scope: ExportScope | undefined,
): Promise<ExportSubject> {
  const subject = await readSubject(applicationId);
  if (!subject || (scope && scope.organizationId !== subject.organizationId)) {
    throw new ExportNotFoundError(applicationId);
  }
  if (!EXPORTABLE_TARGETS.includes(subject.target)) {
    throw new ExportTargetUnsupportedError(applicationId, subject.target);
  }
  if (kind === 'final' && actor.kind !== 'system') {
    throw new ExportNotAllowedError(applicationId, 'final_needs_system');
  }
  if (kind === 'on_demand') {
    if (actor.kind !== 'user')
      throw new ExportNotAllowedError(applicationId, 'on_demand_needs_admin');
    await assertAdmin(actor.userId, subject, scope, applicationId);
  }
  if (subject.state !== 'grace') throw new ExportNotAllowedError(applicationId, 'not_in_grace');
  return subject;
}

/** The read gate for a listing or a download: the application, in scope, and an
 *  organisation admin asking. */
async function readGate(
  applicationId: string,
  actor: { kind: 'user'; userId: string },
  scope: ExportScope | undefined,
): Promise<ExportSubject> {
  const subject = await readSubject(applicationId);
  if (!subject || (scope && scope.organizationId !== subject.organizationId)) {
    throw new ExportNotFoundError(applicationId);
  }
  await assertAdmin(actor.userId, subject, scope, applicationId);
  return subject;
}

/** The status a provider or store failure carries, when it carries a number. */
function statusOf(err: unknown): number | null {
  const e = err as { status?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.$metadata?.httpStatusCode === 'number') return e.$metadata.httpStatusCode;
  return null;
}

/** The connection string split so its password never reaches an argument list. */
function dumpConnection(directUrl: string): { dbname: string; password: string } {
  const url = new URL(directUrl);
  const password = decodeURIComponent(url.password);
  url.password = '';
  return { dbname: url.toString(), password };
}

/**
 * `pg_dump --format=custom` of the database at `directUrl`, streamed into the
 * private store at `key`. Resolves with the stored size; rejects with the typed
 * error after deleting whatever object was written.
 */
async function dumpInto(applicationId: string, directUrl: string, key: string): Promise<bigint> {
  const { dbname, password } = dumpConnection(directUrl);
  const child = spawn(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-acl', `--dbname=${dbname}`],
    {
      // Only what `pg_dump` needs: nothing else of this process's environment
      // reaches a child that could print it.
      env: {
        PATH: process.env['PATH'] ?? '',
        PGPASSWORD: password,
        PGCONNECT_TIMEOUT: '30',
      } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Drained, never read: it can carry the host and user, and nothing here needs it.
  child.stderr.resume();
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });

  let sizeBytes: number;
  try {
    ({ sizeBytes } = await putPrivateStream(key, child.stdout, DUMP_CONTENT_TYPE));
  } catch (err) {
    child.kill('SIGKILL');
    await exited;
    await deleteQuietly(key);
    throw new ExportFailedError(applicationId, 'upload', statusOf(err));
  }
  const code = await exited;
  if (code !== 0) {
    await deleteQuietly(key);
    throw new ExportFailedError(applicationId, 'dump', code);
  }
  return BigInt(sizeBytes);
}

/** Delete an object the export will not record. Its failure is logged with the
 *  key only — the caller is about to throw the real failure. */
async function deleteQuietly(key: string): Promise<void> {
  try {
    await deleteAttachmentBlob(key);
  } catch {
    console.error(`[hostedApplicationExportService] could not delete the partial export ${key}`);
  }
}

export interface ExportExpirySweepResult {
  deleted: number;
  failed: number;
}

/** The `hosting.application-export` event payload. */
export interface HostedApplicationExportRequestedData {
  workspaceId: string;
  applicationId: string;
  /** The admin who asked; the job re-checks they still are one. */
  userId: string;
  /** The export's id, chosen at the request: the job's handle and its key. */
  exportId: string;
  idempotencyKey: string;
}

export const hostedApplicationExportService = {
  /**
   * Take a database export of a `grace` serverless or Fly application: dump it,
   * store the dump, then record it. Returns the export id only once the stored
   * object and its row both exist. `exportId`, when given, names the export and
   * makes a repeat with the same id answer the export already recorded.
   *
   * @throws ExportNotFoundError, ExportTargetUnsupportedError,
   *   ExportNotAllowedError, OrgForbiddenError — before any dump.
   * @throws ExportFailedError — the dump or the upload failed; nothing recorded.
   */
  async createExport(
    applicationId: string,
    opts: { kind: HostedApplicationExportKind; exportId?: string },
    actor: ExportActor,
    scope?: ExportScope,
  ): Promise<string> {
    const subject = await gate(applicationId, opts.kind, actor, scope);
    const exportId = opts.exportId ?? randomUUID();
    if (opts.exportId) {
      const existing = await withWorkspaceServiceContext(subject.workspaceId, (tx) =>
        hostedApplicationExportRepository.findById(exportId, tx),
      );
      if (existing) return existing.id;
    }

    let directUrl: string;
    try {
      ({ DIRECT_URL: directUrl } = await productionDatabaseService.getProductionMigrationEnv(
        subject.id,
      ));
    } catch (err) {
      throw new ExportFailedError(applicationId, 'database', statusOf(err));
    }
    const key = exportStorageKey(subject.workspaceId, subject.id, exportId);
    const sizeBytes = await dumpInto(applicationId, directUrl, key);

    const now = Date.now();
    try {
      await withWorkspaceServiceContext(subject.workspaceId, (tx) =>
        hostedApplicationExportRepository.create(
          {
            id: exportId,
            workspaceId: subject.workspaceId,
            applicationId: subject.id,
            kind: opts.kind,
            requestedByUserId: actor.kind === 'user' ? actor.userId : null,
            storageKey: key,
            sizeBytes,
            expiresAt: new Date(now + EXPORT_RETENTION_DAYS[opts.kind] * DAY_MS),
          },
          tx,
        ),
      );
    } catch (err) {
      await deleteQuietly(key);
      throw err;
    }
    return exportId;
  },

  /**
   * An organisation admin asks for an on-demand export: the gate runs now, the
   * dump in the `hosting.application-export` job, because it outlives a request.
   * Returns the job's handle, which is also the export's id once it is stored.
   */
  async requestExport(
    applicationId: string,
    actor: { kind: 'user'; userId: string },
    scope?: ExportScope,
  ): Promise<{ jobId: string }> {
    const subject = await gate(applicationId, 'on_demand', actor, scope);
    const exportId = randomUUID();
    await sendEvent('hosting.application-export', {
      workspaceId: subject.workspaceId,
      applicationId: subject.id,
      userId: actor.userId,
      exportId,
      idempotencyKey: exportId,
    });
    return { jobId: exportId };
  },

  /**
   * The application's exports not yet expired, newest first, for an
   * organisation admin. No storage key: a dump is reached only by downloading.
   */
  async listExports(
    applicationId: string,
    actor: { kind: 'user'; userId: string },
    scope?: ExportScope,
  ): Promise<HostedApplicationExportDto[]> {
    const subject = await readGate(applicationId, actor, scope);
    const rows = await withWorkspaceServiceContext(subject.workspaceId, (tx) =>
      hostedApplicationExportRepository.listUnexpiredByApplication(subject.id, new Date(), tx),
    );
    return rows.map(toHostedApplicationExportDto);
  },

  /**
   * A signed link to download one export, valid for five minutes, for an
   * organisation admin; each call records one download. An export past its
   * expiry, or of another application, is not found.
   */
  async downloadUrl(
    exportId: string,
    actor: { kind: 'user'; userId: string },
    at: { applicationId: string } & Partial<ExportScope>,
  ): Promise<string> {
    const scope = at.organizationId ? { organizationId: at.organizationId } : undefined;
    const subject = await readGate(at.applicationId, actor, scope);
    const row = await withWorkspaceServiceContext(
      subject.workspaceId,
      async (tx): Promise<HostedApplicationExport | null> => {
        const found = await hostedApplicationExportRepository.findById(exportId, tx);
        if (!found || found.applicationId !== subject.id || found.expiresAt <= new Date()) {
          return null;
        }
        await hostedApplicationExportDownloadRepository.create(
          { workspaceId: subject.workspaceId, exportId: found.id, userId: actor.userId },
          tx,
        );
        return found;
      },
    );
    if (!row) throw new ExportNotFoundError(exportId);
    return signedDownloadUrl(row.storageKey, {
      download: true,
      ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
    });
  },

  /**
   * Delete every export past its expiry: the object first, then its download
   * rows and the export row, so a re-run after a partial failure finds the row
   * and deletes the (already gone) object again harmlessly. One export's
   * failure does not stop the others; the run reports how many failed.
   */
  async sweepExpiredExports(now: Date = new Date()): Promise<ExportExpirySweepResult> {
    const workspaceIds = await withSystemContext((tx) =>
      hostedApplicationRepository.listWorkspaceIdsByTargets(EXPORTABLE_TARGETS, tx),
    );
    let deleted = 0;
    let failed = 0;
    for (const workspaceId of workspaceIds) {
      const expired = await withWorkspaceServiceContext(workspaceId, (tx) =>
        hostedApplicationExportRepository.listExpired(now, tx),
      );
      for (const row of expired) {
        try {
          await deleteAttachmentBlob(row.storageKey);
          await withWorkspaceServiceContext(workspaceId, async (tx) => {
            await hostedApplicationExportDownloadRepository.deleteByExport(row.id, tx);
            await hostedApplicationExportRepository.deleteById(row.id, tx);
          });
          deleted += 1;
        } catch (err) {
          failed += 1;
          console.error(
            `[hostedApplicationExportService] could not expire export ${row.id}:`,
            err instanceof Error ? err.message : 'unknown',
          );
        }
      }
    }
    return { deleted, failed };
  },
};
