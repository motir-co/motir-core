import 'server-only';

import type {
  EstateReconciliationResult,
  PlatformActivityItemDTO,
  PlatformEstateCountsDTO,
  PlatformOrganizationEstateDTO,
  PlatformOverviewDTO,
  PlatformOverviewPeriod,
} from '@/lib/dto/platform';
import {
  getPlatformModelCostDays,
  getPlatformProviderReconciliation,
  getPlatformRuns,
  getPlatformUsage,
  platformRunsCursorAt,
  type RawPlatformRun,
  type RawPlatformUsage,
} from '@/lib/ai/motirAiClient';
import {
  toPlatformRunActivityDTO,
  toPlatformTenantEventDTO,
  toProviderReconciliationDTO,
} from '@/lib/mappers/platformMappers';
import {
  toPlatformOrganizationSummaryDTO,
  toPlatformWorkspaceSummaryDTO,
} from '@/lib/mappers/platformMappers';
import type { Prisma } from '@/generated/prisma/client';
import type { CostsPageDTO, CostsView } from '@/lib/dto/platformCosts';
import {
  buildCosts,
  candidatePeriods,
  firstDayHeld,
  intersectRange,
  modelRangeFor,
  modelYearRanges,
  periodRange,
  utcDayOf,
  type AwsPeriodLine,
  type AwsSource,
  type ModelsSource,
} from '@/lib/platform/costs';
import { awsCostDayRepository } from '@/lib/repositories/awsCostDayRepository';
import { awsCostFetchRepository } from '@/lib/repositories/awsCostFetchRepository';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { PlatformOrganizationNotFoundError } from '@/lib/platform/errors';
import { platformEstateRepository } from '@/lib/repositories/platformEstateRepository';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';

/**
 * The audited CROSS-TENANT READ authority — Story MOTIR-727 · MOTIR-730, and the
 * service the ADR's §3 layer table names first (`docs/decisions/platform-staff-auth.md`).
 *
 * Everything Story 10.1 renders about the estate below a single organization is
 * read here: the overview's counts (MOTIR-731) and the drill-down's tiers
 * (MOTIR-733). Nothing is rendered by this card.
 *
 * ---------------------------------------------------------------------------
 * WHAT EVERY METHOD DOES, IN ORDER
 * ---------------------------------------------------------------------------
 * 1. `requirePlatformStaff('support')` — MOTIR-2896's gate, called rather than
 *    re-implemented. It runs BEFORE any transaction opens, so a non-staff caller
 *    is refused with nothing read and nothing written. The `(admin)` layout also
 *    asserts it; §2 requires both, because the service check is what protects a
 *    future route handler, action or job that never passes through a layout.
 * 2. `withPlatformRead(principal, entry, …)` — binds `app.platform_staff` and
 *    INSERTs exactly one `platform_audit_log` row as the transaction's first
 *    statement. A read that throws rolls the row back with it; a read that
 *    commits cannot exist without one.
 * 3. The reads, through `platformEstateRepository` / `platformOrganizationRepository`
 *    — the only methods that carry no tenant filter. No tenant-scoped service or
 *    repository was changed to make them possible; the `platform_staff` SELECT
 *    arms (`20261001200000_platform_staff_estate_read_arms`) are what admit them.
 *
 * ONE AUDITED TRANSACTION PER METHOD CALL. A page that needs two of these reads
 * calls a method that returns both, rather than two methods — two calls would
 * write two rows for one page view (the argument `getOrganizationPage` makes).
 */

/** How many workspaces one organization read returns. A cap, with `hasMoreWorkspaces`. */
export const PLATFORM_ORG_WORKSPACE_LIMIT = 100;

/**
 * The Costs page's model read (MOTIR-11712): the view's range, and on the Year
 * view every earlier year from the first recorded one — each call one year at
 * most, motir-ai's limit. Outside any transaction; any call failing makes the
 * whole Models column unavailable, because a column missing a year would read as
 * a smaller figure.
 */
async function readModelCosts(view: CostsView, today: string): Promise<ModelsSource> {
  try {
    const range = modelRangeFor(view, today);
    if (!range) return { status: 'ok', firstRecordedDay: null, days: [] };
    const first = await getPlatformModelCostDays({ from: range.fromDay, to: range.toDay });
    const earlier =
      view.kind === 'year'
        ? await Promise.all(
            modelYearRanges(first.firstRecordedDay, today).map((r) =>
              getPlatformModelCostDays({ from: r.fromDay, to: r.toDay }),
            ),
          )
        : [];
    return {
      status: 'ok',
      firstRecordedDay: first.firstRecordedDay,
      days: [...earlier.flatMap((read) => read.days), ...first.days],
    };
  } catch (err) {
    console.error('[platformReadService] the model cost read failed', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return { status: 'unavailable' };
  }
}

/**
 * The Costs page's AWS read (MOTIR-11712), from what the fetch job stored. AWS is
 * unavailable until the first fetch; after it, a period inside the stored span
 * reads its lines (a covered day with none cost nothing), and a period outside it
 * has no figure.
 */
async function readAwsCosts(
  view: CostsView,
  today: string,
  modelFirstDay: string | null,
  tx: Prisma.TransactionClient,
): Promise<AwsSource> {
  const coverage = await awsCostFetchRepository.findCoverage(tx);
  if (!coverage) return { status: 'unavailable' };
  const span = { fromDay: coverage.fromDay, toDay: coverage.toDay };
  const lines = new Map<string, AwsPeriodLine[]>();
  const periods = candidatePeriods(view, today, firstDayHeld(span, modelFirstDay));
  if (view.kind === 'day') {
    const month = periodRange(view.month, today);
    const covered = month && intersectRange(month, span);
    if (covered) {
      for (const period of periods)
        if (period >= covered.fromDay && period <= covered.toDay) lines.set(period, []);
      for (const row of await awsCostDayRepository.findInRange(covered, tx)) {
        lines
          .get(row.day)
          ?.push({ kind: row.kind, service: row.service, amountMicroUsd: row.amountMicroUsd });
      }
    }
  } else {
    for (const period of periods) {
      const range = periodRange(period, today);
      const covered = range && intersectRange(range, span);
      if (covered) lines.set(period, await awsCostDayRepository.sumByLineInRange(covered, tx));
    }
  }
  return { status: 'ok', coverage: span, fetchedAt: coverage.fetchedAt.toISOString(), lines };
}

function costsAuditLabel(view: CostsView): string {
  if (view.kind === 'day') return `costs ${view.month} by day`;
  if (view.kind === 'month') return `costs ${view.year} by month`;
  return 'costs by year';
}

export const platformReadService = {
  /**
   * The estate's four headline counts — organizations, workspaces, projects,
   * users — as four `count(*)` statements, never a row load (finding #57).
   *
   * Audited as an estate-wide read: `targetKind: 'platform'`, no target id.
   */
  async getEstateCounts(principal: PlatformPrincipal): Promise<PlatformEstateCountsDTO> {
    await requirePlatformStaff('support');

    return withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform', targetLabel: 'estate counts' },
      async (tx) => {
        // Sequential, not `Promise.all`: an interactive transaction is one
        // connection, and Prisma does not run statements on it concurrently.
        const organizations = await platformEstateRepository.countOrganizations(tx);
        const workspaces = await platformEstateRepository.countWorkspaces(tx);
        const projects = await platformEstateRepository.countProjects(tx);
        const users = await platformEstateRepository.countUsers(tx);
        return { organizations, workspaces, projects, users };
      },
    );
  },

  /**
   * The estate overview (MOTIR-731, design D1): the four tier counts, how many of
   * each were created in the PERIOD, and one activity feed that interleaves the
   * tenants created with the planning and hosted runs motir-ai recorded.
   *
   * The run half is read FIRST and OUTSIDE the transaction — an HTTP call must not
   * hold the audited read's connection open — and its failure is a STATE of the
   * page (`runsUnavailable`), never an error: the counts and tenant events are
   * motir-core's own and still render. Everything motir-core reads, including the
   * names behind the runs' ids, is ONE audited read.
   *
   * The feed pages on `(at, id)` across both halves: the cursor is the last row
   * SHOWN, and each half resumes strictly older than it, so a row one half held
   * back from a page is never skipped.
   */
  async getOverview(
    principal: PlatformPrincipal,
    input: { period: PlatformOverviewPeriod; cursor?: string | null; now?: Date },
  ): Promise<PlatformOverviewDTO> {
    await requirePlatformStaff('support');

    const take = OVERVIEW_FEED_PAGE;
    const now = input.now ?? new Date();
    const since = periodStart(input.period, now);
    const before = decodeFeedCursor(input.cursor);

    let runs: RawPlatformRun[] = [];
    let moreRuns = false;
    let runsUnavailable = false;
    try {
      const page = await getPlatformRuns({
        limit: take,
        cursor: before ? platformRunsCursorAt(before.at, before.id) : null,
      });
      runs = page.items;
      moreRuns = page.nextCursor !== null;
    } catch {
      runsUnavailable = true;
    }

    return withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform', targetLabel: 'estate overview' },
      async (tx) => {
        const organizations = await platformEstateRepository.countOrganizations(tx);
        const workspaces = await platformEstateRepository.countWorkspaces(tx);
        const projects = await platformEstateRepository.countProjects(tx);
        const users = await platformEstateRepository.countUsers(tx);
        const deltas = await platformEstateRepository.countCreatedSince(since, tx);
        const events = await platformEstateRepository.listTenantEvents({ take, before }, tx);
        const nameRows = runs.length
          ? await platformEstateRepository.findTenantNames(
              {
                organizationIds: unique(runs.map((r) => r.coreOrganizationId)),
                workspaceIds: unique(runs.map((r) => r.coreWorkspaceId)),
                projectIds: unique(runs.map((r) => r.coreProjectId)),
              },
              tx,
            )
          : [];
        const names = new Map(nameRows.map((n) => [n.id, n.name]));

        const merged: PlatformActivityItemDTO[] = [
          ...events.map(toPlatformTenantEventDTO),
          ...runs.map((run) => toPlatformRunActivityDTO(run, names)),
        ].sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
        const items = merged.slice(0, take);
        const last = items[items.length - 1];
        const hasMore = merged.length > take || moreRuns || events.length === take;

        return {
          period: input.period,
          since: since.toISOString(),
          counts: { organizations, workspaces, projects, users },
          deltas,
          feed: {
            items,
            nextCursor: hasMore && last ? encodeFeedCursor(last.at, last.id) : null,
            runsUnavailable,
          },
        };
      },
    );
  },

  /**
   * The estate's spend for one period (MOTIR-732, design D3/D4) — all eight
   * categories, the token categories' models and the totals, from motir-ai's
   * platform rollup alone; motir-core stores no metering.
   *
   * ONE audited `estate.read` per view, written whether or not motir-ai answered:
   * the operator looked at the estate's spend either way. motir-ai unreachable is
   * `usage: null` — the page's error state — never a throw.
   *
   * The same view reads the month's PROVIDER-BILL RECONCILIATION (MOTIR-11376)
   * beside it, so the page still makes one call and writes one row.
   * `reconciliation` is the DTO, `null` when motir-ai did not answer that read, or
   * `'month_required'` on All time, which the route has no form for.
   */
  async getEstateUsage(
    principal: PlatformPrincipal,
    period: string,
  ): Promise<{
    period: string;
    usage: RawPlatformUsage | null;
    reconciliation: EstateReconciliationResult;
  }> {
    await requirePlatformStaff('support');

    // Both motir-ai reads run outside the transaction, side by side, and each is
    // settled on its own: either failing leaves the other's part of the page
    // rendering. The reconciliation route answers one month only, so All time
    // asks it nothing (MOTIR-11376).
    const [usageRead, reconciliationRead] = await Promise.allSettled([
      getPlatformUsage({ period, level: 'platform' }),
      period === 'all'
        ? Promise.resolve('month_required' as const)
        : getPlatformProviderReconciliation({ period }).then(toProviderReconciliationDTO),
    ]);
    const usage = usageRead.status === 'fulfilled' ? usageRead.value : null;
    const reconciliation =
      reconciliationRead.status === 'fulfilled' ? reconciliationRead.value : null;

    // ONE audit row for the page view, whatever motir-ai answered.
    return withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform', targetLabel: `estate usage ${period}` },
      async () => ({ period, usage, reconciliation }),
    );
  },

  /**
   * The Costs page (MOTIR-11712, design MOTIR-11711): Motir's AWS bill as the
   * fetch job stored it, beside the model cost motir-ai recorded, for one view.
   *
   * ONE audited `estate.read` per view, written whether or not either source
   * answered. The model reads run first, outside the transaction (they name the
   * first recorded day the Year view starts from). The AWS read runs inside the
   * audited transaction; if it throws, that transaction rolls back with its audit
   * row, so the view is audited again with AWS marked unavailable — the operator
   * still looked, and the Models column still renders.
   */
  async getCosts(
    principal: PlatformPrincipal,
    view: CostsView,
    now: Date = new Date(),
  ): Promise<CostsPageDTO> {
    await requirePlatformStaff('support');
    const today = utcDayOf(now);
    const models = await readModelCosts(view, today);
    const modelFirstDay = models.status === 'ok' ? models.firstRecordedDay : null;
    const entry = {
      action: 'estate.read',
      targetKind: 'platform',
      targetLabel: costsAuditLabel(view),
    } as const;

    let aws: AwsSource;
    try {
      aws = await withPlatformRead(principal, entry, (tx) =>
        readAwsCosts(view, today, modelFirstDay, tx),
      );
    } catch (err) {
      console.error('[platformReadService] the stored AWS cost read failed', {
        error: err instanceof Error ? err.name : 'unknown',
      });
      aws = await withPlatformRead(
        principal,
        entry,
        async () => ({ status: 'unavailable' }) as const,
      );
    }
    return buildCosts({ view, today, aws, models });
  },

  /**
   * One organization and the tiers beneath it: its member count and its
   * workspaces, each with project and member counts.
   *
   * A missing organization throws INSIDE the transaction, so the read leaves no
   * audit row — the trail records reads that happened, not ids somebody typed.
   *
   * @throws PlatformOrganizationNotFoundError when the id names no organization.
   */
  async getOrganizationEstate(
    principal: PlatformPrincipal,
    organizationId: string,
  ): Promise<PlatformOrganizationEstateDTO> {
    await requirePlatformStaff('support');

    return withPlatformRead(
      principal,
      {
        action: 'estate.read',
        targetKind: 'organization',
        targetId: organizationId,
        organizationId,
      },
      async (tx) => {
        const organization = await platformOrganizationRepository.findOrganizationById(
          organizationId,
          tx,
        );
        if (!organization) throw new PlatformOrganizationNotFoundError(organizationId);

        const memberCount = await platformEstateRepository.countOrganizationMembers(
          organizationId,
          tx,
        );
        const rows = await platformEstateRepository.listWorkspacesForOrganization(
          organizationId,
          PLATFORM_ORG_WORKSPACE_LIMIT + 1,
          tx,
        );

        return {
          organization: toPlatformOrganizationSummaryDTO(organization),
          memberCount,
          workspaces: rows
            .slice(0, PLATFORM_ORG_WORKSPACE_LIMIT)
            .map(toPlatformWorkspaceSummaryDTO),
          hasMoreWorkspaces: rows.length > PLATFORM_ORG_WORKSPACE_LIMIT,
        };
      },
    );
  },
};

/** One page of the overview's activity feed. */
export const OVERVIEW_FEED_PAGE = 25;

/** The instant a period's deltas count from — UTC, like every period in the console. */
export function periodStart(period: PlatformOverviewPeriod, now: Date): Date {
  if (period === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const days = period === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function encodeFeedCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: at, i: id })).toString('base64url');
}

/** A malformed cursor reads as the first page, never an error — it is a URL a person can edit. */
function decodeFeedCursor(cursor: string | null | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof raw.t !== 'string' || typeof raw.i !== 'string') return null;
    const at = new Date(raw.t);
    return Number.isNaN(at.getTime()) ? null : { at, id: raw.i };
  } catch {
    return null;
  }
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}
