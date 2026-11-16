import type { Organization, PlatformAuditLog, User } from '@/generated/prisma/client';
import type {
  PlatformAuditEntryDTO,
  PlatformAuditJsonValue,
  PlatformAuditLogDTO,
  PlatformOperatorDTO,
  PlatformOrganizationDetailDTO,
  PlatformOrganizationSummaryDTO,
  PlatformUserDetailDTO,
  PlatformUserSummaryDTO,
  PlatformWorkspaceSummaryDTO,
} from '@/lib/dto/platform';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { PlatformWorkspaceRow } from '@/lib/repositories/platformEstateRepository';
import type { PlatformAuditLogWithActor } from '@/lib/repositories/platformAuditLogRepository';
import type { RawPlatformRun, RawProviderReconciliation } from '@/lib/ai/motirAiClient';
import type { PlatformTenantEventRow } from '@/lib/repositories/platformEstateRepository';
import type { PlatformActivityItemDTO, ProviderReconciliationDTO } from '@/lib/dto/platform';

/** A `platform_audit_log` row → the DTO. */
export function toPlatformAuditLogDTO(row: PlatformAuditLog): PlatformAuditLogDTO {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole,
    action: row.action,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    organizationId: row.organizationId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A `platform_audit_log` row (with its actor) → one audit-log VIEW entry
 * (MOTIR-751). `isWrite` is the caller's: which verbs are reads is the
 * vocabulary's knowledge (`PLATFORM_AUDIT_READ_ACTIONS`), not the row's.
 */
export function toPlatformAuditEntryDTO(
  row: PlatformAuditLogWithActor,
  isWrite: boolean,
): PlatformAuditEntryDTO {
  return {
    seq: row.seq,
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actor: {
      userId: row.actorUserId,
      name: row.actor.name,
      email: row.actor.email,
      role: row.actorRole,
    },
    action: row.action,
    isWrite,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    organizationId: row.organizationId,
    reason: row.reason,
    metadata: (row.metadata ?? null) as PlatformAuditJsonValue | null,
    entryHash: row.entryHash,
    prevHash: row.prevHash,
    chainedToSeq: row.prevHash === null ? null : row.seq - 1,
  };
}

/**
 * The acting principal → what a page may render.
 *
 * Drops `userId` deliberately. The console footer draws an email and a role;
 * handing a client component the id of the acting operator adds nothing it
 * renders and one more thing that can end up in markup.
 */
export function toPlatformOperatorDTO(principal: PlatformPrincipal): PlatformOperatorDTO {
  return { email: principal.email, role: principal.role };
}

/**
 * A `user` row → the operator LOOKUP's row (MOTIR-1167).
 *
 * ⚠️ AN ALLOW-LIST, NOT A SPREAD-AND-DELETE. Every field is named, so a column
 * added to `user` later — a phone number, a locale, a billing id — does NOT
 * silently appear on a cross-tenant operator surface because a mapper forwarded
 * whatever it was handed. That is the same argument `platformStaffRepository`
 * makes for its three-column `select`, one layer up.
 */
export function toPlatformUserSummaryDTO(row: User): PlatformUserSummaryDTO {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
  };
}

/** A `user` row + its session count → the operator DRILL-DOWN's account. */
export function toPlatformUserDetailDTO(
  row: User,
  activeSessionCount: number,
): PlatformUserDetailDTO {
  return {
    ...toPlatformUserSummaryDTO(row),
    emailVerified: row.emailVerified,
    twoFactorEnabled: row.twoFactorEnabled,
    suspendedReason: row.suspendedReason,
    activeSessionCount,
    platformRole: row.platformRole,
  };
}

/**
 * An `organization` row → the operator LOOKUP's row (MOTIR-4565).
 *
 * ⚠️ AN ALLOW-LIST, NOT A SPREAD-AND-DELETE — the same rule
 * `toPlatformUserSummaryDTO` states and for a sharper reason: `organization`
 * carries BILLING state (`scaledTrackerSubscription`, the tier mirror), so a
 * mapper that forwarded whatever it was handed would put a future billing column
 * on a cross-tenant operator surface the moment somebody added one.
 */
export function toPlatformOrganizationSummaryDTO(
  row: Organization,
): PlatformOrganizationSummaryDTO {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt.toISOString(),
    isMeta: row.isMeta,
    internalBilling: row.internalBilling,
    suspended: row.suspendedAt !== null,
  };
}

/** An `organization` row → the operator ORG PAGE's organization. */
export function toPlatformOrganizationDetailDTO(row: Organization): PlatformOrganizationDetailDTO {
  return {
    ...toPlatformOrganizationSummaryDTO(row),
    aiIncludedSeat: row.aiIncludedSeat,
    // The COLUMN is a Json blob of Stripe-propagated state; the page needs only
    // whether one is on record, and forwarding the blob would put a payment
    // provider's payload on an operator screen for no rendered benefit.
    hasScaledTrackerSubscription: row.scaledTrackerSubscription !== null,
    suspension: row.suspendedAt
      ? {
          suspendedAt: row.suspendedAt.toISOString(),
          reason: row.suspendedReason,
          suspendedByUserId: row.suspendedByUserId,
        }
      : null,
  };
}

/** A workspace row with its relation counts → the estate read's workspace. */
export function toPlatformWorkspaceSummaryDTO(
  row: PlatformWorkspaceRow,
): PlatformWorkspaceSummaryDTO {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt.toISOString(),
    projectCount: row._count.projects,
    memberCount: row._count.memberships,
  };
}

// ── The estate overview's feed (MOTIR-731) ────────────────────────────────────

const TENANT_EVENT_KIND = {
  organization: 'new_organization',
  workspace: 'new_workspace',
  project: 'new_project',
} as const;

/** A created organization / workspace / project, as a feed row. */
export function toPlatformTenantEventDTO(row: PlatformTenantEventRow): PlatformActivityItemDTO {
  return {
    kind: TENANT_EVENT_KIND[row.kind],
    id: row.id,
    at: row.at.toISOString(),
    organization: { id: row.organizationId, name: row.organizationName },
    workspace:
      row.workspaceId && row.workspaceName
        ? { id: row.workspaceId, name: row.workspaceName }
        : null,
    project:
      row.kind === 'project' && row.projectName ? { id: row.id, name: row.projectName } : null,
    unattributed: false,
    detail: row.detail,
    model: null,
    credits: null,
  };
}

/** A motir-ai run, labelled with motir-core's names for its core ids. */
export function toPlatformRunActivityDTO(
  run: RawPlatformRun,
  names: Map<string, string>,
): PlatformActivityItemDTO {
  const named = (id: string | null) => (id ? { id, name: names.get(id) ?? id } : null);
  return {
    kind: run.kind === 'planning' ? 'planning_run' : 'coding_run',
    id: run.id,
    at: run.startedAt,
    organization: named(run.coreOrganizationId),
    workspace: named(run.coreWorkspaceId),
    project: named(run.coreProjectId),
    unattributed: run.coreProjectId === null,
    detail: null,
    model: run.model,
    credits: run.credits,
  };
}

/**
 * motir-ai's provider-bill reconciliation → Usage & cost's DTO (MOTIR-11376).
 * Field for field and nothing else: the gap, `pastTolerance`, the status and the
 * source are the route's answers, so none is recomputed or defaulted here — a
 * missing bill stays `null` all the way to the page.
 */
export function toProviderReconciliationDTO(
  raw: RawProviderReconciliation,
): ProviderReconciliationDTO {
  return {
    period: raw.period,
    providers: raw.providers.map((p) => ({
      provider: p.provider,
      relativeTolerance: p.relativeTolerance,
      absoluteToleranceMicroUsd: p.absoluteToleranceMicroUsd,
      days: p.days.map((d) => ({
        day: d.day,
        recordedMicroUsd: d.recordedMicroUsd,
        billedMicroUsd: d.billedMicroUsd,
        source: d.source,
        status: d.status,
        readAt: d.readAt,
        gapMicroUsd: d.gapMicroUsd,
        pastTolerance: d.pastTolerance,
        perModel: d.perModel.map((m) => ({
          model: m.model,
          recordedMicroUsd: m.recordedMicroUsd,
          billedMicroUsd: m.billedMicroUsd,
          gapMicroUsd: m.gapMicroUsd,
        })),
        estimatedRowCount: d.estimatedRowCount,
      })),
    })),
    findings: raw.findings.map((f) => ({
      provider: f.provider,
      day: f.day,
      recordedMicroUsd: f.recordedMicroUsd,
      billedMicroUsd: f.billedMicroUsd,
      gapMicroUsd: f.gapMicroUsd,
      models: f.models.map((m) => ({
        model: m.model,
        recordedMicroUsd: m.recordedMicroUsd,
        billedMicroUsd: m.billedMicroUsd,
        gapMicroUsd: m.gapMicroUsd,
      })),
      estimatedRowCount: f.estimatedRowCount,
      differingSide: f.differingSide,
    })),
    unreconciledProviders: [...raw.unreconciledProviders],
  };
}
