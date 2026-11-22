import 'server-only';

import {
  awsManagementCredentials,
  createAwsManagementApi,
  type AwsManagementApi,
  type AwsQuotaStatus,
} from '@motir/orchestrator';
import {
  TENANT_ACCOUNT_REGION,
  TENANT_QUOTA_TARGETS,
  tenantAccountName,
  type HostingTenantAccountState,
  type TenantQuotaTarget,
} from '@/lib/ciFleet/hostingTenantAccounts';
import type {
  TenantAccountDTO,
  TenantAccountsBlockDTO,
  TenantAccountsPageDTO,
  TenantQuotaDTO,
  TenantQuotaRaiseDTO,
} from '@/lib/dto/fleetStatusTenantAccounts';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { platformAwsReadRepository } from '@/lib/repositories/platformAwsReadRepository';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * THE FLEET STATUS PAGE'S TENANT HOSTING ACCOUNTS CARD (MOTIR-12014; design
 * MOTIR-12013, `platform-admin/design-notes.md` § AMENDMENT 2026-11-22) — the
 * third card of the Pools section, read and settled on its own like the two
 * beside it (`fleetStatusPoolsService`). Superadmin only; read once per page
 * load, nothing cached, nothing stored but the read marks.
 *
 * EVERY `hosting_tenant_account` ROW, with its organisation's name (system
 * context: the table is platform-only and spans every organisation). For each
 * `ready` row, through the account's member-role session — the same
 * `assumeMemberRole` the bootstrap uses — in `TENANT_ACCOUNT_REGION`, each
 * `TENANT_QUOTA_TARGETS` quota's applied value and its newest open raise
 * (`readQuotaStatus`). Accounts are read a few at a time; each account and each
 * quota settles on its own, so one account AWS does not answer for is that
 * account's Not read and leaves the rest whole.
 *
 * ⚠️ AN UNREAD QUOTA IS NEVER A NUMBER — and an account with no applied value
 * (`NoSuchResourceException`) is Not read too, never the AWS default: the
 * default is not what the account runs at. Each quota good read is marked in
 * `platform_aws_read` (subject per account and quota), so a later failure names
 * when it last answered.
 *
 * ⚠️ READ-ONLY. It files no raise and changes no account; filing is the
 * bootstrap's (MOTIR-12011). The member session stays in memory and is dropped,
 * and a failure is logged by its error NAME only — an AWS message can carry ARNs
 * and request ids, and nothing here ever holds a member email.
 *
 * AUDIT: one `fleet.status.read` row per call, the Pools section's action,
 * written in the transaction that writes the read marks — after the AWS calls,
 * which never run inside it (the chain lock is held until it commits).
 */

/** How many accounts are read from AWS at once. */
const ACCOUNT_READ_CONCURRENCY = 4;

/** Accounts on one page of the card. */
export const TENANT_ACCOUNTS_PAGE_SIZE = 10;

/** The `platform_aws_read` subject of one quota in one tenant account. */
export function tenantQuotaSubject(awsAccountId: string, target: TenantQuotaTarget): string {
  return `servicequotas:${target.serviceCode}/${target.quotaCode}@${awsAccountId}`;
}

export interface TenantAccountsReadOptions {
  now?: Date;
  /** The management API; built from this deployment's management credential when absent. */
  management?: AwsManagementApi;
}

type AccountRow = Awaited<
  ReturnType<typeof hostingTenantAccountRepository.listAllWithOrganizationInTx>
>[number];

/** What AWS answered for one account: per target, a status or the failure. */
type QuotaReads = PromiseSettledResult<AwsQuotaStatus>[] | null;

/** AWS's open statuses in Monitoring's keys; any other is not an open raise. */
function raiseOf(open: AwsQuotaStatus['openRaise']): TenantQuotaRaiseDTO | null {
  if (!open) return null;
  const status =
    open.status === 'PENDING' ? 'pending' : open.status === 'CASE_OPENED' ? 'case_opened' : null;
  if (status === null) return null;
  return {
    status,
    desiredValue: open.desiredValue,
    createdAt: open.createdAt?.toISOString() ?? null,
  };
}

/** One quota from what AWS answered and the last good read. Exported for its tests. */
export function judgeTenantQuota(
  target: TenantQuotaTarget,
  read: PromiseSettledResult<AwsQuotaStatus> | null,
  lastReadAt: Date | null,
): TenantQuotaDTO {
  const base = {
    name: target.name,
    serviceCode: target.serviceCode,
    quotaCode: target.quotaCode,
    target: target.desiredValue,
  };
  if (read?.status !== 'fulfilled' || read.value.applied === null) {
    return { ...base, status: 'notRead', lastReadAt: lastReadAt?.toISOString() ?? null };
  }
  const applied = read.value.applied;
  const raise = raiseOf(read.value.openRaise);
  return {
    ...base,
    status: 'ok',
    applied,
    raise,
    belowTarget: applied < target.desiredValue && raise === null,
  };
}

/** A read counts as good — and is marked — only when it answered an applied value. */
function answered(read: PromiseSettledResult<AwsQuotaStatus> | undefined): boolean {
  return read?.status === 'fulfilled' && read.value.applied !== null;
}

/** Each target's read in one account; null when the session itself failed. */
async function readAccount(
  management: AwsManagementApi,
  awsAccountId: string,
): Promise<QuotaReads> {
  let credentials;
  try {
    credentials = await management.assumeMemberRole(awsAccountId);
  } catch (err) {
    logFailure('tenant account session', err);
    return null;
  }
  const reads = await Promise.allSettled(
    TENANT_QUOTA_TARGETS.map((target) =>
      management.readQuotaStatus(credentials, TENANT_ACCOUNT_REGION, target),
    ),
  );
  for (const read of reads) if (read.status === 'rejected') logFailure('tenant quota', read.reason);
  return reads;
}

/** Every `ready` account's reads, a few accounts at a time, keyed by AWS account id. */
async function readReadyAccounts(
  rows: AccountRow[],
  management: AwsManagementApi | null,
): Promise<Map<string, QuotaReads>> {
  const ids = [...new Set(rows.filter(isReadable).map((row) => row.awsAccountId!))];
  const out = new Map<string, QuotaReads>();
  if (management === null) return out;
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      out.set(id, await readAccount(management, id));
    }
  };
  await Promise.all(Array.from({ length: Math.min(ACCOUNT_READ_CONCURRENCY, ids.length) }, worker));
  return out;
}

function isReadable(row: AccountRow): boolean {
  return row.state === 'ready' && row.awsAccountId !== null;
}

/** The management API, or null when this deployment has no management credential. */
function managementOf(options: TenantAccountsReadOptions): AwsManagementApi | null {
  if (options.management) return options.management;
  try {
    return createAwsManagementApi(awsManagementCredentials(process.env));
  } catch (err) {
    logFailure('management credential', err);
    return null;
  }
}

/**
 * What needs acting on first: an account with a quota below target and no open
 * raise, then one with a quota not read, then a refused one, then the rest —
 * each group by organisation name. Exported for its tests.
 */
export function tenantAccountRank(account: TenantAccountDTO): number {
  if (account.quotas.some((q) => q.status === 'ok' && q.belowTarget)) return 0;
  if (account.quotas.some((q) => q.status === 'notRead')) return 1;
  return account.state === 'refused' ? 2 : 3;
}

export function orderTenantAccounts(accounts: TenantAccountDTO[]): TenantAccountDTO[] {
  return [...accounts].sort(
    (a, b) =>
      tenantAccountRank(a) - tenantAccountRank(b) ||
      a.organizationName.localeCompare(b.organizationName, 'en') ||
      a.accountName.localeCompare(b.accountName, 'en'),
  );
}

/**
 * One page of the card: the search FIRST (organisation name, AWS account id or
 * account name, case-insensitive), over the already-ordered set, THEN the page.
 * So an account to act on leads page 1 whatever its name. A page past the last
 * clamps to the last; a page below 1, or not a number, is page 1.
 */
export function pageTenantAccounts(
  accounts: TenantAccountDTO[],
  input: { query?: string | null; page?: string | number | null },
): TenantAccountsPageDTO {
  const query = (input.query ?? '').trim();
  const needle = query.toLocaleLowerCase('en');
  const matching = needle
    ? accounts.filter((a) =>
        [a.organizationName, a.awsAccountId ?? '', a.accountName].some((field) =>
          field.toLocaleLowerCase('en').includes(needle),
        ),
      )
    : accounts;
  const pageCount = Math.max(1, Math.ceil(matching.length / TENANT_ACCOUNTS_PAGE_SIZE));
  const asked = Math.trunc(Number(input.page ?? 1));
  const page = Number.isFinite(asked) ? Math.min(Math.max(1, asked), pageCount) : 1;
  const start = (page - 1) * TENANT_ACCOUNTS_PAGE_SIZE;
  const rows = matching.slice(start, start + TENANT_ACCOUNTS_PAGE_SIZE);
  return {
    accounts: rows,
    query,
    page,
    pageCount,
    total: matching.length,
    from: rows.length === 0 ? 0 : start + 1,
    to: start + rows.length,
  };
}

function accountOf(
  row: AccountRow,
  reads: QuotaReads | undefined,
  lastReadAt: (target: TenantQuotaTarget) => Date | null,
): TenantAccountDTO {
  return {
    organizationName: row.organization.name,
    accountName: tenantAccountName(row.organizationId),
    awsAccountId: row.awsAccountId,
    // The column's check constraint holds it to the five states.
    state: row.state as HostingTenantAccountState,
    refusedCount: row.refusedCount,
    lastRefusedAt: row.lastRefusedAt?.toISOString() ?? null,
    quotas: isReadable(row)
      ? TENANT_QUOTA_TARGETS.map((target, i) =>
          judgeTenantQuota(target, reads?.[i] ?? null, lastReadAt(target)),
        )
      : [],
  };
}

export const fleetStatusTenantAccountsService = {
  /**
   * The card's block: every tenant hosting account, ordered, with each ready
   * account's quotas and the two header counts over the whole set. Any failure
   * outside one account's AWS read is the block's `unavailable`.
   */
  async read(
    principal: PlatformPrincipal,
    options: TenantAccountsReadOptions = {},
  ): Promise<TenantAccountsBlockDTO> {
    await requirePlatformStaff('superadmin');
    const now = options.now ?? new Date();
    try {
      const rows = await withSystemContext((tx) =>
        hostingTenantAccountRepository.listAllWithOrganizationInTx(tx),
      );
      const reads = await readReadyAccounts(rows, managementOf(options));
      const marks = await writeMarks(principal, rows, reads, now);
      const accounts = orderTenantAccounts(
        rows.map((row) =>
          accountOf(row, row.awsAccountId ? reads.get(row.awsAccountId) : undefined, (target) =>
            row.awsAccountId
              ? (marks.get(tenantQuotaSubject(row.awsAccountId, target)) ?? null)
              : null,
          ),
        ),
      );
      return {
        status: 'ok',
        accounts,
        belowTargetCount: accounts
          .flatMap((a) => a.quotas)
          .filter((q) => q.status === 'ok' && q.belowTarget).length,
        notReadCount: accounts.filter((a) => a.quotas.some((q) => q.status === 'notRead')).length,
      };
    } catch (err) {
      logFailure('tenant accounts', err);
      return { status: 'unavailable' };
    }
  },
};

/**
 * The audited transaction: one `fleet.status.read` row, a mark for every quota
 * read well now, and the last good read of every other. Answers each subject's
 * last good read time.
 */
async function writeMarks(
  principal: PlatformPrincipal,
  rows: AccountRow[],
  reads: Map<string, QuotaReads>,
  now: Date,
): Promise<Map<string, Date>> {
  const good: { subject: string; accountId: string }[] = [];
  const unread: string[] = [];
  for (const row of rows.filter(isReadable)) {
    const accountId = row.awsAccountId!;
    TENANT_QUOTA_TARGETS.forEach((target, i) => {
      const subject = tenantQuotaSubject(accountId, target);
      if (answered(reads.get(accountId)?.[i])) good.push({ subject, accountId });
      else unread.push(subject);
    });
  }
  return withPlatformRead(
    principal,
    {
      action: 'fleet.status.read',
      targetKind: 'platform',
      targetId: 'fleet_pools.tenant_accounts',
      metadata: { accounts: rows.length, quotasRead: good.length, quotasNotRead: unread.length },
    },
    async (tx) => {
      const marks = new Map<string, Date>();
      for (const { subject, accountId } of good) {
        await platformAwsReadRepository.markRead({ subject, accountId, readAt: now }, tx);
        marks.set(subject, now);
      }
      const unique = [...new Set(unread)];
      if (unique.length > 0) {
        for (const row of await platformAwsReadRepository.findMany(unique, tx)) {
          marks.set(row.subject, row.readAt);
        }
      }
      return marks;
    },
  );
}

/** The failure, by its error NAME only — an AWS message can carry ARNs and request ids. */
function logFailure(what: string, reason: unknown): void {
  console.error(`[admin] fleet status ${what} read failed`, {
    error: reason instanceof Error ? reason.name : 'unknown',
  });
}
