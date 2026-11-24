import type { CategoryFigures } from '@/lib/platform/spend';
import type {
  ReconciliationDifferingSide,
  ReconciliationSource,
  ReconciliationStatus,
  RawPlatformUsage as RawPlatformUsageForDto,
  RawPlatformUsageMonths,
  RawSpendRow,
} from '@/lib/ai/motirAiClient';
import type { PlatformAuditTargetKind, PlatformRole } from '@/generated/prisma/client';

/**
 * What crosses the API boundary from the platform tier
 * (`docs/decisions/platform-staff-auth.md`).
 *
 * MOTIR-2896 defines only the audit row's shape. The estate / usage DTOs are
 * MOTIR-731–733's, and `PlatformUsageDTO` in particular is MOTIR-732's — the
 * ADR's "deliberately does NOT decide" table says so.
 */

/** One recorded platform-staff action. */
export interface PlatformAuditLogDTO {
  id: string;
  actorUserId: string;
  /** The actor's role AT THE TIME — snapshotted, never re-derived from a join. */
  actorRole: PlatformRole;
  action: string;
  targetKind: PlatformAuditTargetKind;
  targetId: string | null;
  targetLabel: string | null;
  organizationId: string | null;
  reason: string | null;
  /** ISO-8601, so the JSON shape is stable across the boundary. */
  createdAt: string;
}

/** A JSON value as stored in an audit row's `metadata`. */
export type PlatformAuditJsonValue =
  | string
  | number
  | boolean
  | null
  | PlatformAuditJsonValue[]
  | { [key: string]: PlatformAuditJsonValue };

/**
 * One entry of the AUDIT LOG view (MOTIR-751; the page is MOTIR-752, design
 * `platform-admin` AMENDMENT 2026-10-03 Panels 6/7) — the table row AND its
 * open detail: "the entry number, exact time, actor, action, target with id,
 * full reason, the metadata payload, and its hash chained to the previous
 * entry's".
 */
export interface PlatformAuditEntryDTO {
  /** The chain position — the design's "entry #n". */
  seq: number;
  id: string;
  /** ISO-8601, millisecond precision (the hashed value). */
  createdAt: string;
  actor: {
    userId: string;
    name: string;
    email: string;
    /** The role AT THE TIME — snapshotted on the row, never re-derived. */
    role: PlatformRole;
  };
  action: string;
  /** False for the READ verbs (`PLATFORM_AUDIT_READ_ACTIONS`) — the "Writes" filter's line. */
  isWrite: boolean;
  targetKind: PlatformAuditTargetKind;
  targetId: string | null;
  targetLabel: string | null;
  organizationId: string | null;
  reason: string | null;
  metadata: PlatformAuditJsonValue | null;
  /** SHA-256 hex of this entry. The design abbreviates it (`9f3c…a41e`). */
  entryHash: string;
  /** The previous entry's hash, or `null` for entry #1. */
  prevHash: string | null;
  /** The entry this one is chained to — "chained to #n" — or `null` for entry #1. */
  chainedToSeq: number | null;
}

/** The search filters (all optional; they AND together). */
export interface PlatformAuditSearchFiltersDTO {
  /** The operator — a user id. */
  actorUserId?: string | null;
  /** The tenant — an organization id. */
  organizationId?: string | null;
  /** One exact action key. */
  action?: string | null;
  /** ISO date or date-time, inclusive. */
  dateFrom?: string | null;
  /** ISO date or date-time, EXCLUSIVE (pass the day after the last day wanted). */
  dateTo?: string | null;
  /** "Writes" (the design's default) when true or omitted; "Writes & reads" when false. */
  writesOnly?: boolean;
  /** Free text over the reason and the target (label substring, or exact id). */
  text?: string | null;
}

/** One page of the audit log, newest first. */
export interface PlatformAuditSearchPageDTO {
  entries: PlatformAuditEntryDTO[];
  /** Pass back as `cursor` for the next (older) page; `null` on the last page. */
  nextCursor: string | null;
  /** The page size the service used (50). */
  pageSize: number;
}

/** Why the chain stopped verifying — see `AuditChainBreakReason` in `lib/platform/auditChain.ts`. */
export type PlatformAuditChainBreakReason = 'hash_mismatch' | 'link_mismatch' | 'seq_gap';

/**
 * The integrity line (design Panels 6/7). `ok`: "Chain verified — all
 * {checkedCount} entries hash-chain intact, checked through #{throughSeq} at
 * {checkedAt}". `broken`: "The chain is broken at entry #{brokenAtSeq}
 * ({brokenAtTime}) … it and the {entriesAfter} entries after it can't be
 * trusted as written." Feed it to `auditEntryChainStatus` per row for the
 * Hash mismatch / Unverified markers.
 */
export type PlatformAuditChainVerificationDTO =
  | {
      status: 'ok';
      /** The first entry checked (1 for a full check). */
      fromSeq: number;
      /** The last entry checked, or `null` when there was nothing to check. */
      throughSeq: number | null;
      checkedCount: number;
      /** ISO-8601. */
      checkedAt: string;
    }
  | {
      status: 'broken';
      fromSeq: number;
      throughSeq: number | null;
      /** Entries that verified before the break. */
      checkedCount: number;
      checkedAt: string;
      brokenAtSeq: number;
      /** ISO-8601 — the broken entry's stored time, shown as stored. */
      brokenAtTime: string;
      reason: PlatformAuditChainBreakReason;
      /** How many entries follow the broken one (within the range checked). */
      entriesAfter: number;
    };

/**
 * The acting operator, as a page renders it. NOT the full `PlatformPrincipal`:
 * that is a server-side identity assertion and must not be handed to a client
 * component. This carries what the console footer draws and nothing more.
 */
export interface PlatformOperatorDTO {
  email: string;
  role: PlatformRole;
}

/**
 * One account in the operator LOOKUP's result list (MOTIR-1167, design Panel 9's
 * door — the USER group Panel 3's global search promises).
 *
 * Deliberately thin. A lookup result is a row somebody is about to click, and
 * every field on it is a field an operator can read without opening the account
 * — which is a cross-tenant read of a person's data, and therefore something to
 * hand out by the spoonful rather than the bucket.
 */
export interface PlatformUserSummaryDTO {
  id: string;
  email: string;
  name: string;
  /** ISO-8601 — when the account was created. */
  createdAt: string;
  /** ISO-8601 when the account is suspended, else null. */
  suspendedAt: string | null;
}

/**
 * One account as the operator DRILL-DOWN renders it (design Panel 9).
 *
 * ⚠️ It carries NO tenant rows, and that absence is a decision rather than an
 * omission. The workspaces and organizations an account belongs to are tenant
 * tables, and no tenant table has gained a `platform_staff` READ arm — the ADR
 * (`docs/decisions/platform-staff-auth.md`, "What this ADR deliberately does NOT
 * decide") allocates every one of those policies to MOTIR-730. A read issued
 * against them from this tier answers with zero rows and raises nothing the day
 * MOTIR-2435 cuts over to the non-bypass role, which is the silent-narrowing
 * shape MOTIR-2880 recorded. So the day-1 drill-down reads only `user` and
 * `session`, both of which are in `tenant-root-creation-rls.test.ts`'s
 * DELIBERATELY_UNGUARDED map and therefore answer identically before and after
 * that cutover. The tenancy half arrives with the read layer that can serve it.
 */
export interface PlatformUserDetailDTO extends PlatformUserSummaryDTO {
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  /** The operator's stated reason for the LIVE suspension, else null. */
  suspendedReason: string | null;
  /** How many sign-in sessions the account currently holds. */
  activeSessionCount: number;
  /**
   * Platform standing, when the account has any. Almost always null — it is here
   * because an operator acting on a COLLEAGUE's account should see that they
   * are, before they suspend them.
   */
  platformRole: PlatformRole | null;
}

/**
 * The operator drill-down's whole page (MOTIR-1167, design Panel 9).
 *
 * One shape rather than two calls, because the page's two halves are ONE audited
 * read: the account, and every operator write on it. See
 * `platformSupportService.getUserPage` for why that matters to the trail.
 */
export interface PlatformUserPageDTO {
  user: PlatformUserDetailDTO;
  /**
   * Every operator WRITE on this account, newest first. Reads are filtered out
   * by the service — this is the log the design calls *"every operator write on
   * this account"*, and a page view is not one.
   */
  actions: PlatformAuditLogDTO[];
}

/**
 * One organization in the operator LOOKUP's result list (MOTIR-4565, design
 * `platform-admin/design-notes.md` Panel 10).
 *
 * Thin for the same reason `PlatformUserSummaryDTO` is: a lookup result is a row
 * somebody is about to click, and every field on it is readable without opening
 * the tenant — which is a cross-tenant read, and therefore something to hand out
 * by the spoonful.
 *
 * ⚠️ IT CARRIES BOTH CLASSIFICATION FLAGS, SEPARATELY. The design draws two
 * chips with two labels, and a single `internal: boolean` here would make that
 * impossible to render honestly — it is the conflation
 * `docs/decisions/internal-billing-classification.md` §1 refuses, expressed as a
 * DTO.
 */
export interface PlatformOrganizationSummaryDTO {
  id: string;
  name: string;
  slug: string;
  /** ISO-8601 — when the organization was created. */
  createdAt: string;
  /** Motir's own COGS: caps lifted, AI paywall off, excluded from revenue. */
  isMeta: boolean;
  /** Charged exactly like a customer, then made whole by a paired offset. */
  internalBilling: boolean;
  /** Suspended by platform staff (MOTIR-748) — every member is refused. The
   *  "Suspended" pill the design puts on every row that names the org. */
  suspended: boolean;
}

/**
 * An organization's suspension as the console's status card renders it
 * (design `ops.status.suspendedSince`: *Since {at} · by {operator} · “{reason}”*).
 * `suspendedByUserId` is the operator's user id; their label is on the audit row
 * the suspension wrote (`org.suspend`), which the org page's trail already shows.
 */
export interface PlatformOrganizationSuspensionDTO {
  /** ISO-8601 — when the suspension took effect. */
  suspendedAt: string;
  /** The reason the operator gave — the same text the `org.suspend` audit row holds. */
  reason: string | null;
  /** The operator who suspended it; null once that account is deleted. */
  suspendedByUserId: string | null;
}

/**
 * One organization as the operator ORG PAGE renders it (design Panel 11).
 *
 * ⚠️ IT CARRIES NO USAGE, NO RECENT JOBS AND NO MEMBERS, and that absence is an
 * ALLOCATION rather than an omission: the design's own allocation table gives
 * those three panels to MOTIR-733, and this story draws them as reserved
 * regions. The workspace and project levels below an org are that card's
 * entirely.
 *
 * The paid-plan state it does carry is the two columns motir-core already holds
 * (`aiIncludedSeat` and the scaled-tracker subscription's presence) — never a
 * cross-service read, which is Story 10.1's own boundary.
 */
export interface PlatformOrganizationDetailDTO extends PlatformOrganizationSummaryDTO {
  /** Whether the org holds a paid Motir AI plan (the bundled seat). */
  aiIncludedSeat: boolean;
  /** Whether a scaled-tracker (per-seat PM) subscription is on record. */
  hasScaledTrackerSubscription: boolean;
  /** The suspension in force, or null for an active organization (MOTIR-748). */
  suspension: PlatformOrganizationSuspensionDTO | null;
}

/**
 * The operator ORG PAGE's whole payload (MOTIR-4566 / MOTIR-4568, design
 * Panels 11 and 12).
 *
 * One shape rather than two calls, because the page's two halves are ONE audited
 * read: the organization, and every operator write on it. See
 * `platformBillingClassificationService.getOrganizationPage` for why that matters
 * to the trail — two calls would write two audit rows per page view.
 */
export interface PlatformOrganizationPageDTO {
  organization: PlatformOrganizationDetailDTO;
  /**
   * Every operator WRITE on this organization, newest first. Reads are filtered
   * out by the service — this is the log the design calls *"every operator write
   * on this organization"*, and a page view is not one.
   */
  actions: PlatformAuditLogDTO[];
}

/**
 * The estate's four headline counts (MOTIR-730's `platformReadService.getEstateCounts`).
 *
 * Whole-estate totals, read as four `count(*)` statements in one audited platform
 * transaction — never a row load (finding #57). The overview's "new this period"
 * deltas and its activity feed are MOTIR-731's, built on top of this.
 */
export interface PlatformEstateCountsDTO {
  organizations: number;
  workspaces: number;
  projects: number;
  users: number;
}

/** One workspace inside an organization, as the estate read returns it (MOTIR-730). */
export interface PlatformWorkspaceSummaryDTO {
  id: string;
  name: string;
  slug: string;
  /** ISO-8601 — when the workspace was created. */
  createdAt: string;
  projectCount: number;
  memberCount: number;
}

/**
 * One organization and the tiers beneath it (MOTIR-730's
 * `platformReadService.getOrganizationEstate`) — the substrate MOTIR-733's
 * drill-down renders. Carries no usage and no jobs: those live in motir-ai and
 * are read over the 7.1 boundary by the cards that render them.
 */
export interface PlatformOrganizationEstateDTO {
  organization: PlatformOrganizationSummaryDTO;
  memberCount: number;
  /** Oldest first, capped at `PLATFORM_ORG_WORKSPACE_LIMIT`. */
  workspaces: PlatformWorkspaceSummaryDTO[];
  /** True when the org holds more workspaces than `workspaces` shows. */
  hasMoreWorkspaces: boolean;
}

/** The overview's period control (design D1): what every delta is counted over. */
export type PlatformOverviewPeriod = '7d' | '30d' | 'month';

/** One row of the overview's activity feed — a tenant event or a run (MOTIR-731). */
export interface PlatformActivityItemDTO {
  kind: 'new_organization' | 'new_workspace' | 'new_project' | 'planning_run' | 'coding_run';
  id: string;
  at: string;
  organization: { id: string; name: string } | null;
  workspace: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  /** A run whose org is known but that names no workspace/project ("(unattributed)"). */
  unattributed: boolean;
  /** Who a tenant belongs to (an owner's / manager's email) or a project's key. */
  detail: string | null;
  /** A run's model and credits. */
  model: string | null;
  credits: number | null;
}

/** The estate overview (MOTIR-731, design D1/D2) — one audited read. */
export interface PlatformOverviewDTO {
  period: PlatformOverviewPeriod;
  /** The start of the period every delta counts from. */
  since: string;
  counts: PlatformEstateCountsDTO;
  deltas: PlatformEstateCountsDTO;
  feed: {
    items: PlatformActivityItemDTO[];
    /** Older items exist past this page. */
    nextCursor: string | null;
    /** The run half could not be read — the tenant half still renders. */
    runsUnavailable: boolean;
  };
}

/** One row of the Tenants list (MOTIR-7287, design D10): an org's spend for the period. */
export interface PlatformTenantSpendRowDTO {
  /** Null for the estate total row. A spend row whose org is gone keeps its id as its name. */
  organization: {
    id: string;
    name: string;
    slug: string | null;
    isMeta: boolean;
    internalBilling: boolean;
  } | null;
  credits: Record<
    | 'planning_tokens'
    | 'agent_tokens'
    | 'agent_machine'
    | 'agent_instance'
    | 'agent_storage'
    | 'ci'
    | 'search'
    | 'hosting_production',
    number
  >;
  indexingSeconds: number;
  chargedCredits: number;
  costMicroUsd: number;
}

/** The Tenants list for one period, sort and filter. */
export interface PlatformTenantListDTO {
  period: string;
  sort: string;
  filter: string;
  /** The total over EVERY organization — never the page, never the filter. */
  estate: PlatformTenantSpendRowDTO | null;
  rows: PlatformTenantSpendRowDTO[];
  nextCursor: string | null;
  /** The filter matched more organizations than one list can carry. */
  filterCapped: boolean;
  /** motir-ai could not be read; the list shows its error state. */
  unavailable: boolean;
}

/** One member row on the org page's Overview (MOTIR-733). Roles are read-only here. */
export interface PlatformOrgMemberDTO {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

/**
 * The org page's OPERATIONS tab (MOTIR-752, design `platform-admin` AMENDMENT
 * 2026-10-03 Panel 1) — what motir-core itself holds for the tab, read as ONE
 * audited `estate.read`: the organization (its suspension included), the
 * counts the status line quotes, and the operator writes on it. The credit
 * ledger (motir-ai) and the kill-switches are separate reads the tab streams in.
 */
export interface PlatformOrgOperationsDTO {
  organization: PlatformOrganizationDetailDTO;
  memberCount: number;
  workspaceCount: number;
  /**
   * Who suspended it — the status line's "by {operator}". Null for an active
   * organization, or once that operator's account is gone.
   */
  suspendedBy: { userId: string; email: string; name: string | null } | null;
  /** Every operator WRITE on this organization, newest first (capped). */
  actions: PlatformAuditLogDTO[];
}

/** The org page's Overview tab (MOTIR-733, design D5) — one audited read. */
export interface PlatformOrgOverviewDTO {
  organization: PlatformOrganizationDetailDTO;
  /** The operator writes recorded against the org — the shipped action log. */
  actions: PlatformAuditLogDTO[];
  /** This month's nine categories; null when motir-ai could not be read. */
  monthCategories: CategoryFigures[] | null;
  month: string;
  members: { items: PlatformOrgMemberDTO[]; nextCursor: string | null; total: number };
  workspaces: (PlatformWorkspaceSummaryDTO & { monthChargedCredits: number | null })[];
  hasMoreWorkspaces: boolean;
  /** This month's per-workspace credits could not be read. */
  workspaceSpendUnavailable: boolean;
  jobs: { items: PlatformActivityItemDTO[]; nextCursor: string | null; unavailable: boolean };
}

/** A scope on the org page's Usage & cost tab (MOTIR-7288): the org, a workspace or a project. */
export type PlatformOrgUsageScope =
  | { level: 'organization' }
  | { level: 'workspace'; id: string; name: string }
  | { level: 'project'; id: string; name: string; workspace: { id: string; name: string } };

/** The org page's Usage & cost tab (MOTIR-7288, design D8/D11) — one audited read. */
export interface PlatformOrgUsageTabDTO {
  organization: PlatformOrganizationDetailDTO;
  period: string;
  scope: PlatformOrgUsageScope;
  /** The scope picker's choices: the org's workspaces, each with its projects. */
  scopes: { id: string; name: string; projects: { id: string; name: string }[] }[];
  /** The scope's spend; null when motir-ai could not be read. */
  usage: RawPlatformUsageForDto | null;
  /** The org's credit balance now; null when it could not be read. */
  balance: number | null;
  /**
   * BY WORKSPACE AND PROJECT (MOTIR-7293): the scope's children with their names,
   * and — at org scope — the two rows no workspace holds. Null at project scope
   * (a project has no children) or when motir-ai could not be read (`childrenUnavailable`).
   */
  children: {
    childLevel: 'workspace' | 'project';
    rows: (RawSpendRow & { name: string })[];
    remainder: { noProject: RawSpendRow; orgLevel: RawSpendRow } | null;
    truncated: boolean;
  } | null;
  childrenUnavailable: boolean;
  /** MONTH BY MONTH (MOTIR-7293), newest first, with the all-time row. */
  months: RawPlatformUsageMonths | null;
}

/** The workspace page beneath the org (MOTIR-7295, design D6) — one audited read. */
export interface PlatformWorkspacePageDTO {
  organization: { id: string; name: string };
  workspace: { id: string; name: string; slug: string; createdAt: string };
  month: string;
  /** The workspace's projects with this month's spend; spend null when motir-ai could not be read. */
  projects: {
    id: string;
    name: string;
    key: string;
    planningCredits: number | null;
    runsAndCiCredits: number | null;
    chargedCredits: number | null;
  }[];
  projectSpendUnavailable: boolean;
  members: {
    items: {
      id: string;
      userId: string;
      name: string | null;
      email: string;
      role: 'manager' | 'member' | 'viewer';
      joinedAt: string;
    }[];
    nextCursor: string | null;
    total: number;
  };
  jobs: { items: PlatformActivityItemDTO[]; nextCursor: string | null; unavailable: boolean };
}

// ── Provider-bill reconciliation (Story MOTIR-11350 · MOTIR-11376) ─────────────

/** One model's line of a day's bill, where the provider broke it down. */
export interface ProviderReconciliationModelDayDTO {
  model: string;
  recordedMicroUsd: number;
  billedMicroUsd: number;
  /** billed − recorded, carried from motir-ai unchanged (MOTIR-11376). */
  gapMicroUsd: number;
}

/** One closed UTC day of one provider, as motir-ai recorded it. */
export interface ProviderReconciliationDayDTO {
  day: string;
  recordedMicroUsd: number | null;
  /** null when nothing was read — the page shows an em dash, never 0. */
  billedMicroUsd: number | null;
  source: ReconciliationSource;
  status: ReconciliationStatus;
  readAt: string | null;
  gapMicroUsd: number | null;
  pastTolerance: boolean;
  perModel: ProviderReconciliationModelDayDTO[];
  estimatedRowCount: number | null;
}

export interface ProviderReconciliationProviderDTO {
  provider: string;
  relativeTolerance: number | null;
  absoluteToleranceMicroUsd: number | null;
  days: ProviderReconciliationDayDTO[];
}

export interface ProviderReconciliationFindingDTO {
  provider: string;
  day: string;
  recordedMicroUsd: number;
  billedMicroUsd: number;
  gapMicroUsd: number;
  models: {
    model: string;
    recordedMicroUsd: number;
    billedMicroUsd: number;
    gapMicroUsd: number;
  }[];
  estimatedRowCount: number | null;
  differingSide: ReconciliationDifferingSide | null;
}

/**
 * One month's provider-bill reconciliation for Usage & cost. Every figure, status
 * and verdict is motir-ai's, carried through unchanged.
 */
export interface ProviderReconciliationDTO {
  period: string;
  providers: ProviderReconciliationProviderDTO[];
  findings: ProviderReconciliationFindingDTO[];
  unreconciledProviders: string[];
}

/**
 * What Usage & cost has for its reconciliation section: the month's DTO, `null`
 * when motir-ai did not answer, or `'month_required'` on All time — the route
 * answers one month only, so nothing was asked.
 */
export type EstateReconciliationResult = ProviderReconciliationDTO | 'month_required' | null;
