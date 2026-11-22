import type { HostingTenantAccountState } from '@/lib/ciFleet/hostingTenantAccounts';

// THE FLEET STATUS PAGE'S TENANT HOSTING ACCOUNTS CARD (MOTIR-12014; design
// MOTIR-12013, `platform-admin/design-notes.md` § AMENDMENT 2026-11-22) — every
// `hosting_tenant_account` row and, for a `ready` one, each `TENANT_QUOTA_TARGETS`
// quota as it stands in that account: the applied value read live from Service
// Quotas, the target, and the open raise.
//
// ⚠️ A QUOTA NOBODY ANSWERED FOR IS `notRead`, NEVER A NUMBER — and never the
// AWS default either: an account with no applied value is not running at the
// default as far as this card can tell. `lastReadAt` is the last good read
// (`platform_aws_read`), null when it was never read.
//
// ⚠️ NO CREDENTIAL AND NO MEMBER EMAIL has a field here. The AWS account id and
// the account name are shown on purpose: they are what an operator looks up.

/** The two open raise statuses AWS answers, as Monitoring's words key them. */
export type TenantQuotaRaiseStatusDTO = 'pending' | 'case_opened';

export interface TenantQuotaRaiseDTO {
  status: TenantQuotaRaiseStatusDTO;
  /** Null when AWS did not say. */
  desiredValue: number | null;
  /** When it was filed, ISO; null when AWS did not say. */
  createdAt: string | null;
}

interface TenantQuotaBase {
  /** `TENANT_QUOTA_TARGETS[i].name`. */
  name: string;
  serviceCode: string;
  quotaCode: string;
  /** Motir's own target — always known. */
  target: number;
}

export type TenantQuotaDTO =
  | (TenantQuotaBase & {
      status: 'ok';
      applied: number;
      raise: TenantQuotaRaiseDTO | null;
      /** applied < target AND no open raise. */
      belowTarget: boolean;
    })
  | (TenantQuotaBase & { status: 'notRead'; lastReadAt: string | null });

export interface TenantAccountDTO {
  organizationName: string;
  /** `tenant-<organisation id>`, what AWS Organizations lists. */
  accountName: string;
  /** Null until the account is found or created. */
  awsAccountId: string | null;
  state: HostingTenantAccountState;
  refusedCount: number;
  lastRefusedAt: string | null;
  /** One per `TENANT_QUOTA_TARGETS` entry, in its order, for a `ready` account;
   *  empty for every other state (nothing is read). */
  quotas: TenantQuotaDTO[];
}

export type TenantAccountsBlockDTO =
  | { status: 'unavailable' }
  | {
      status: 'ok';
      /** Every account, ordered: what needs acting on first (see `orderTenantAccounts`). */
      accounts: TenantAccountDTO[];
      /** Quotas below target with no open raise, over every account. */
      belowTargetCount: number;
      /** Accounts with at least one quota not read, over every account. */
      notReadCount: number;
    };

/** One page of the card, after the search. */
export interface TenantAccountsPageDTO {
  accounts: TenantAccountDTO[];
  /** The search as applied (trimmed); '' for none. */
  query: string;
  page: number;
  pageCount: number;
  /** How many accounts match the search (all of them with none). */
  total: number;
  /** Index of the first account on the page, from 1; 0 when nothing matches. */
  from: number;
  to: number;
}
