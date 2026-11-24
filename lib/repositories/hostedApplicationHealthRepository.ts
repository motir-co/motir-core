import type {
  HostedApplicationEventKind,
  HostedHealthCondition,
  HostedHealthState,
  HostedReleaseState,
  Prisma,
} from '@/generated/prisma/client';

// Single-op data access for `hosted_application_health` and
// `hosted_application_event` (Story MOTIR-9799 · MOTIR-12106). Every call takes a
// required `tx` bound to the row's workspace: both tables' only policy is
// `<table>_active_workspace`, with no system arm.

export interface HostedApplicationHealthRow {
  applicationId: string;
  workspaceId: string;
  state: HostedHealthState;
  since: Date;
  condition: HostedHealthCondition | null;
  consecutiveProbeFailures: number;
  probedReleaseId: string | null;
  healthCheckPath: string | null;
  lastProbedAt: Date | null;
}

export interface HostedApplicationEventRow {
  id: string;
  applicationId: string;
  releaseId: string | null;
  kind: HostedApplicationEventKind;
  reason: string;
  exitCode: number | null;
  occurredAt: Date;
  lastLogLines: Prisma.JsonValue;
  transitionKey: string;
  /** The release it happened on, as it stands now; null when it is gone. */
  release: { commitSha: string; state: HostedReleaseState } | null;
}

const HEALTH_SELECT = {
  applicationId: true,
  workspaceId: true,
  state: true,
  since: true,
  condition: true,
  consecutiveProbeFailures: true,
  probedReleaseId: true,
  healthCheckPath: true,
  lastProbedAt: true,
} as const;

const EVENT_SELECT = {
  id: true,
  applicationId: true,
  releaseId: true,
  kind: true,
  reason: true,
  exitCode: true,
  occurredAt: true,
  lastLogLines: true,
  transitionKey: true,
  release: { select: { commitSha: true, state: true } },
} as const;

export const hostedApplicationHealthRepository = {
  /**
   * Serialize the probers of ONE application for the rest of `tx`, then read
   * its health row (null before the first). A transaction-scoped advisory lock
   * rather than the row's own `FOR UPDATE` alone, because the first run has no
   * row to lock: two overlapping first runs would otherwise both insert.
   */
  async lockForUpdate(
    applicationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationHealthRow | null> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-application-health:${applicationId}`}, 0))`;
    await tx.$queryRaw`
      SELECT "id" FROM "hosted_application_health" WHERE "application_id" = ${applicationId} FOR UPDATE
    `;
    return tx.hostedApplicationHealth.findUnique({
      where: { applicationId },
      select: HEALTH_SELECT,
    });
  },

  async upsertState(row: HostedApplicationHealthRow, tx: Prisma.TransactionClient): Promise<void> {
    const { applicationId, workspaceId, ...fields } = row;
    await tx.hostedApplicationHealth.upsert({
      where: { applicationId },
      create: { applicationId, workspaceId, ...fields },
      update: fields,
    });
  },

  /**
   * Insert one event unless its `(applicationId, transitionKey)` is taken, with
   * no last lines yet (`setEventLogLines` stores them once they are read).
   * Answers the new row's id, or null when nothing was written.
   */
  async insertEvent(
    event: Omit<HostedApplicationEventRow, 'id' | 'lastLogLines' | 'release'> & {
      workspaceId: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const written = await tx.hostedApplicationEvent.createMany({
      data: [{ ...event, lastLogLines: [] }],
      skipDuplicates: true,
    });
    if (written.count === 0) return null;
    const row = await tx.hostedApplicationEvent.findUniqueOrThrow({
      where: {
        applicationId_transitionKey: {
          applicationId: event.applicationId,
          transitionKey: event.transitionKey,
        },
      },
      select: { id: true },
    });
    return row.id;
  },

  /** Store an event's masked last lines, once they are read. */
  async setEventLogLines(
    eventId: string,
    lines: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.hostedApplicationEvent.update({
      where: { id: eventId },
      data: { lastLogLines: lines },
    });
  },

  async findForApplication(
    applicationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationHealthRow | null> {
    return tx.hostedApplicationHealth.findUnique({
      where: { applicationId },
      select: HEALTH_SELECT,
    });
  },

  /** The application's events, newest first. */
  async listEvents(
    applicationId: string,
    { limit }: { limit: number },
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationEventRow[]> {
    return tx.hostedApplicationEvent.findMany({
      where: { applicationId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: EVENT_SELECT,
    });
  },

  /** When the newest `crashed` event of a release occurred, or null. */
  async newestCrashAt(
    applicationId: string,
    releaseId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const row = await tx.hostedApplicationEvent.findFirst({
      where: { applicationId, releaseId, kind: 'crashed' },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    return row?.occurredAt ?? null;
  },
};
