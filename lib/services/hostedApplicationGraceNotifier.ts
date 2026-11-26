import { Prisma } from '@/generated/prisma/client';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { PRODUCTION_ROOM_HREF } from '@/lib/hosting/productionRoom';
import type { GraceNoticeKind, HostedApplicationState } from '@/lib/hosting/vocabulary';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { hostedApplicationNoticeRepository } from '@/lib/repositories/hostedApplicationNoticeRepository';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { resolveRecipientLocales } from '@/lib/services/emailRecipientLocale';
import { hostedApplicationHandoverService } from '@/lib/services/hostedApplicationHandoverService';
import { formatDate } from '@/lib/utils/datetime';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE GRACE-WINDOW NOTIFIER (Story MOTIR-9800 · MOTIR-12136; decision MOTIR-9802
// "Consequences"): the organisation's Owner and Admins — the people who can
// download the export or press Stop now — are told by email, and by the banner
// the Production panel reads back, when a serverless or Fly application's
// repository transfer lands (`transferred`), 7 days and 1 day before it stops
// (`seven_days`, `one_day`), and when it stops (`stopped`). The organisation
// deletion notifier (`organizationDeletionNotifier.ts`) is the precedent, and
// this follows it point by point:
//
// ── EXACTLY ONCE PER (application, kind) ───────────────────────────────────
// Each notice is recorded in `hosted_application_notice` AFTER its emails are
// enqueued, and a notice already recorded sends nothing — so a retried job, and
// the hourly reminder sweep, never mail twice. Each email also carries a
// per-recipient idempotency key, `hosting-grace:<app>:<kind>:<user>`, so a
// crash between the enqueue and the record re-sends nothing the engine has not
// already collapsed. A concurrent recorder's `P2002` counts as recorded.
//
// ── RECIPIENTS ARE RESOLVED AT SEND TIME ───────────────────────────────────
// From the memberships of the organisation that owns the application's
// workspace, read under that organisation's own context; Members get nothing.
//
// ── A KIND MUST MATCH THE STATE ────────────────────────────────────────────
// `transferred`, `seven_days` and `one_day` describe a running window (`grace`);
// `stopped` describes its end (`handed_over`). A notice whose application has
// moved on — a reminder queued before a Stop now, say — sends and records
// nothing.
//
// ── THE HOSTING STATE NEVER WAITS ON THE MAIL ──────────────────────────────
// The notices are enqueued by `startGrace` and `stopApplication` after their
// own commits, and sent here by a job; `sendEvent` is best-effort, so a mail
// transport outage is logged and never undoes a grace window or a stop.

/** Reminder thresholds, in days before `stopsAt`, largest first. */
export const GRACE_REMINDER_DAYS = [
  { days: 7, kind: 'seven_days' },
  { days: 1, kind: 'one_day' },
] as const satisfies readonly { days: number; kind: GraceNoticeKind }[];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The state a notice of each kind describes. */
const STATE_FOR_KIND: Record<GraceNoticeKind, HostedApplicationState> = {
  transferred: 'grace',
  seven_days: 'grace',
  one_day: 'grace',
  stopped: 'handed_over',
};

/** The organisation roles told: the people who can act on the window. */
const NOTIFIED_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

export type GraceNotifyOutcome =
  | { outcome: 'sent'; recipients: number }
  | { outcome: 'already_sent' }
  | { outcome: 'not_applicable'; reason: 'no_application' | 'state_mismatch' };

/** What the Production panel's banner shows: the newest notice, with the
 *  application's `stopsAt`. */
export interface LatestGraceNotice {
  kind: GraceNoticeKind;
  sentAt: Date;
  stopsAt: Date | null;
}

async function alreadySent(workspaceId: string, applicationId: string, kind: GraceNoticeKind) {
  const found = await withWorkspaceServiceContext(workspaceId, (tx) =>
    hostedApplicationNoticeRepository.find({ applicationId, kind }, tx),
  );
  return found !== null;
}

/** Record the notice; a concurrent recorder's `P2002` means it is recorded. */
async function record(workspaceId: string, applicationId: string, kind: GraceNoticeKind) {
  try {
    await withWorkspaceServiceContext(workspaceId, (tx) =>
      hostedApplicationNoticeRepository.create({ workspaceId, applicationId, kind }, tx),
    );
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
}

/** The Owner and Admins of the organisation that owns the workspace, with an
 *  address to write to. */
async function recipientsOf(workspaceId: string) {
  const organizationId = await withSystemContext((tx) =>
    workspaceRepository.findOrganizationId(workspaceId, tx),
  );
  if (!organizationId) return [];
  const rows = await withOrgServiceWriteContext(organizationId, (tx) =>
    organizationMembershipRepository.findMembersByOrg(organizationId, tx),
  );
  return rows
    .filter((row) => NOTIFIED_ROLES.has(row.role) && Boolean(row.user.email))
    .map((row) => ({ userId: row.user.id, name: row.user.name, email: row.user.email }));
}

/**
 * Send one grace-window notice about an application: one `email.send` per
 * Owner and Admin, then the record. Sends nothing when the notice is already
 * recorded, or when the application is gone or not in the state the kind
 * describes.
 */
async function notify(input: {
  applicationId: string;
  kind: GraceNoticeKind;
}): Promise<GraceNotifyOutcome> {
  const { applicationId, kind } = input;
  const app = await withSystemContext((tx) =>
    hostedApplicationRepository.findForGraceNotice(applicationId, tx),
  );
  if (!app) return { outcome: 'not_applicable', reason: 'no_application' };
  if (app.state !== STATE_FOR_KIND[kind]) {
    console.warn('[hostedApplicationGraceNotifier] the notice no longer matches its application', {
      applicationId,
      kind,
      state: app.state,
    });
    return { outcome: 'not_applicable', reason: 'state_mismatch' };
  }
  if (await alreadySent(app.workspaceId, applicationId, kind)) return { outcome: 'already_sent' };

  const recipients = await recipientsOf(app.workspaceId);
  const localeByUserId = await resolveRecipientLocales(recipients.map((r) => r.userId));
  const productionUrl = `${resolveBaseUrlTrimmed()}${PRODUCTION_ROOM_HREF}?repository=${encodeURIComponent(app.projectRepositoryId)}`;
  // The date the email names: when the app stops, or — for `stopped` — when it
  // did, which Stop now can make earlier than `stopsAt`.
  const stopDate = (kind === 'stopped' ? app.handedOverAt : app.stopsAt) ?? new Date();
  for (const recipient of recipients) {
    const locale = localeByUserId.get(recipient.userId);
    await sendEvent('email.send', {
      workspaceId: app.workspaceId,
      idempotencyKey: `hosting-grace:${applicationId}:${kind}:${recipient.userId}`,
      to: recipient.email,
      template: 'hosted-application-grace',
      data: {
        kind,
        recipientName: recipient.name,
        repositoryName: app.repositoryName,
        stopDate: formatDate(stopDate.toISOString(), locale),
        productionUrl,
        locale,
      },
    });
  }
  await record(app.workspaceId, applicationId, kind);
  return { outcome: 'sent', recipients: recipients.length };
}

/**
 * The hourly reminder pass: for every `grace` application whose `stopsAt` is
 * within 7 days and still ahead, enqueue that threshold's notice unless it is
 * recorded. Only the SMALLEST threshold reached is enqueued — an application
 * first found with one day left gets `one_day`, not a stale `seven_days` as
 * well. A `stopsAt` already past is the stop sweep's, not a reminder's. Never
 * throws for one application's failure.
 */
async function sendDueReminders(now: Date = new Date()): Promise<{ enqueued: number }> {
  const horizon = new Date(now.getTime() + GRACE_REMINDER_DAYS[0].days * DAY_MS);
  const due = await withSystemContext((tx) =>
    hostedApplicationRepository.listInGraceStoppingBetween(now, horizon, tx),
  );
  let enqueued = 0;
  for (const app of due) {
    try {
      const msLeft = app.stopsAt!.getTime() - now.getTime();
      const threshold = [...GRACE_REMINDER_DAYS].reverse().find((t) => msLeft <= t.days * DAY_MS)!;
      if (await alreadySent(app.workspaceId, app.id, threshold.kind)) continue;
      await hostedApplicationHandoverService.sendGraceNotice({
        workspaceId: app.workspaceId,
        applicationId: app.id,
        kind: threshold.kind,
      });
      enqueued += 1;
    } catch (err) {
      console.error('[hostedApplicationGraceNotifier] a reminder could not be enqueued', {
        applicationId: app.id,
        err,
      });
    }
  }
  return { enqueued };
}

/**
 * The newest grace notice recorded for an application, with its `stopsAt` —
 * what the Production panel's banner shows — or null when none is recorded.
 * Runs in the caller's workspace transaction, so another workspace's
 * application reads as none.
 */
async function latestGraceNotice(
  applicationId: string,
  tx: Prisma.TransactionClient,
): Promise<LatestGraceNotice | null> {
  const notice = await hostedApplicationNoticeRepository.findLatest(applicationId, tx);
  if (!notice) return null;
  const app = await hostedApplicationRepository.findById(applicationId, tx);
  return { kind: notice.kind, sentAt: notice.sentAt, stopsAt: app?.stopsAt ?? null };
}

export const hostedApplicationGraceNotifier = { notify, sendDueReminders, latestGraceNotice };
