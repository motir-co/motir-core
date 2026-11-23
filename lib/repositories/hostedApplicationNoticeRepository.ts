import type {
  HostedApplicationNotice,
  HostedApplicationNoticeKind,
  Prisma,
} from '@/generated/prisma/client';

// Data access for `hosted_application_notice` (Story MOTIR-9800 · MOTIR-12136) —
// the record that one grace-window notice went out for one hosted application.
// Single Prisma operations; the notifier owns the order.
//
// ⚠️ EVERY METHOD TAKES `tx`. The table is workspace-scoped (RLS policy
// `hosted_application_notice_active_workspace`), so a caller binds the
// application's workspace first (`withWorkspaceServiceContext`); on the `db`
// singleton every read is empty and every write is refused.

export interface HostedApplicationNoticeKey {
  applicationId: string;
  kind: HostedApplicationNoticeKind;
}

export const hostedApplicationNoticeRepository = {
  /** The notice already recorded for this application and kind, or null. */
  async find(
    key: HostedApplicationNoticeKey,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationNotice | null> {
    return tx.hostedApplicationNotice.findUnique({ where: { applicationId_kind: key } });
  },

  /**
   * Record a notice as sent. A concurrent second recorder loses on the unique
   * `(application_id, kind)` with a `P2002`, which the notifier treats as
   * "already recorded".
   */
  async create(
    data: HostedApplicationNoticeKey & { workspaceId: string },
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationNotice> {
    return tx.hostedApplicationNotice.create({ data });
  },

  /** The application's newest recorded notice — the banner — or null. */
  async findLatest(
    applicationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationNotice | null> {
    return tx.hostedApplicationNotice.findFirst({
      where: { applicationId },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    });
  },
};
