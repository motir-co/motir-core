'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Bot,
  CheckCircle2,
  Clock,
  Loader2,
  OctagonAlert,
  Sparkles,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';
import type {
  PlanStatusDto,
  WorkItemPlanHistoryEntryDto,
  WorkItemPlanHistoryPageDto,
} from '@/lib/dto/plans';
import { ContentSectionCard } from './ContentSectionCard';
import { PLAN_HISTORY_FIRST_PAGE, PLAN_HISTORY_MORE_PAGE } from './planHistoryPaging';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// The PLAN HISTORY section on the work-item detail page (Story MOTIR-5542 ·
// MOTIR-5547), per design/work-items/plan-history.mock.html + design-notes
// § "Plan history" (MOTIR-5545).
//
// WHAT IT SAYS: every plan related to THIS item — the plans that created it,
// changed it, archived it or added work items under it — in all five statuses,
// one row per plan, oldest first. Each row says what the plan did in a tense its
// status allows and opens `/plans/<id>`. It POINTS; it never renders proposed
// values (MOTIR-4197's boundary).
//
// THE ROW is `PlanRow`'s anatomy (status square · title · meta · pill) with its
// BOX dropped: inside `ContentSectionCard` a bordered row would be a container
// inside a container (§0). Rows are divided by a hairline. A `planned` plan does
// NOT get `PlanRow`'s accent border: on this page the pending-plan notice is the
// one call to action for an undecided plan (§5).
//
// A CLIENT ISLAND because it owns the rows Show more appends. The page renders
// it with the first page from its tier-two read (§1); nothing another mutation
// on this page changes is read here, so no refetch tick is owed.

/** The first page the page read — or `'failed'` when that read threw. */
export type PlanHistoryInitial = WorkItemPlanHistoryPageDto | 'failed';

export interface PlanHistorySectionProps {
  /** The item's id — the route `GET /api/work-items/[id]/plans` is keyed on it. */
  itemId: string;
  /** The `PROD-N` key, for the list's accessible name. */
  identifier: string;
  initial: PlanHistoryInitial;
}

// The retired `PlanRow`'s glyph and square per status — `/plans` lists
// conversations since MOTIR-6025, so this section is now their one reader.
const STATUS_ICON: Record<PlanStatusDto, LucideIcon> = {
  generating: Loader2,
  planned: Clock,
  approving: Loader2,
  stale: OctagonAlert,
  approved: CheckCircle2,
  declined: XCircle,
};
const STATUS_TINT: Record<PlanStatusDto, string> = {
  generating: 'bg-(--el-tint-sky)',
  planned: 'bg-(--el-tint-lavender)',
  approving: 'bg-(--el-tint-mint)',
  stale: 'bg-(--el-tint-rose)',
  approved: 'bg-(--el-tint-mint)',
  declined: 'bg-(--el-muted)',
};

/** PlanRow's `StatusPill`, every status named (MOTIR-3578's lesson). */
function StatusPill({ status, label }: { status: PlanStatusDto; label: string }) {
  switch (status) {
    case 'generating':
      return <Pill severity="info">{label}</Pill>;
    case 'planned':
      return <Pill status="planned">{label}</Pill>;
    case 'approving':
      return <Pill severity="info">{label}</Pill>;
    case 'stale':
      return <Pill severity="danger">{label}</Pill>;
    case 'declined':
      return <Pill tone="archived">{label}</Pill>;
    case 'approved':
      return <Pill severity="success">{label}</Pill>;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

type Tense = 'proposing' | 'applied' | 'declined';

/** §3: the tense is set by status, and a sentence must never claim a change that
 *  did not happen (MOTIR-4472). A sixth `PlanStatus` turns the `never` red. */
function tenseOf(status: PlanStatusDto): Tense {
  switch (status) {
    case 'generating':
    case 'planned':
    case 'stale':
    // Not applied until the approval commits (Bug MOTIR-9006) — the sentence must not
    // claim it early.
    case 'approving':
      return 'proposing';
    case 'approved':
      return 'applied';
    case 'declined':
      return 'declined';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

type IssueViewsT = ReturnType<typeof useTranslations<'issueViews'>>;

/** The relation sentence — TOTAL over tense × op × children (§3's table). */
export function relationSentence(entry: WorkItemPlanHistoryEntryDto, t: IssueViewsT): string {
  const { op, childCount } = entry.relation;
  const withChildren = childCount > 0;
  const count = { count: childCount };

  // `op: 'add'` — CREATED this item — exists only on an APPROVED plan: the new
  // item's id is written back to its proposal at approve, so no undecided or
  // declined plan can hold it. The approved sentence therefore renders whatever
  // the status says, rather than a proposal-tense sentence for a row that cannot
  // exist. `created + added N` is unreachable too (children laid under a card
  // added in the SAME plan carry a `planItem:` temp-ref), and keeps its key so
  // this switch stays total.
  if (op === 'add') {
    return withChildren ? t('planHistoryCreatedAdded', count) : t('planHistoryCreated');
  }

  const tense = tenseOf(entry.planStatus);
  switch (op) {
    case 'modify':
      if (tense === 'applied')
        return withChildren ? t('planHistoryChangedAdded', count) : t('planHistoryChanged');
      if (tense === 'declined')
        return withChildren
          ? t('planHistoryDeclinedModifyAdd', count)
          : t('planHistoryDeclinedModify');
      return withChildren
        ? t('planHistoryProposesModifyAdd', count)
        : t('planHistoryProposesModify');
    case 'remove':
      if (tense === 'applied')
        return withChildren ? t('planHistoryArchivedAdded', count) : t('planHistoryArchived');
      if (tense === 'declined')
        return withChildren
          ? t('planHistoryDeclinedRemoveAdd', count)
          : t('planHistoryDeclinedRemove');
      return withChildren
        ? t('planHistoryProposesRemoveAdd', count)
        : t('planHistoryProposesRemove');
    // `op: null` is the CHILDREN-ONLY claim. The DTO's invariant is
    // `op !== null || childCount > 0`, so this arm always has a count.
    case null:
      if (tense === 'applied') return t('planHistoryAdded', count);
      if (tense === 'declined') return t('planHistoryDeclinedAdd', count);
      return t('planHistoryProposesAdd', count);
    default: {
      const unreachable: never = op;
      return unreachable;
    }
  }
}

function PlanHistoryRow({ entry }: { entry: WorkItemPlanHistoryEntryDto }) {
  const routes = useReaderRoutes();
  const t = useTranslations('issueViews');
  const tPlan = useTranslations('aiPlanning');
  const tReview = useTranslations('planReview');
  const format = useFormatter();
  const Icon = STATUS_ICON[entry.planStatus];
  const title = entry.planTitle?.trim() || tReview('untitledPlan');

  // WHEN it was decided — and BY WHOM, behind the verb, exactly as PlanRow's
  // `WhenEntry`. A plan the abandoned-plan sweep ended has no decider, and that
  // absence is a whole sentence, never a placeholder.
  let decided: string | null = null;
  if (entry.decidedAt && (entry.planStatus === 'approved' || entry.planStatus === 'declined')) {
    const when = format.relativeTime(new Date(entry.decidedAt));
    if (entry.planStatus === 'approved') {
      decided = entry.decidedByName
        ? tPlan('approvedByName', { when, name: entry.decidedByName })
        : tPlan('approvedAt', { when });
    } else {
      decided = entry.decidedByName
        ? tPlan('declinedByName', { when, name: entry.decidedByName })
        : tPlan('declinedAt', { when });
    }
  }

  // WHO WROTE it, read off `author.source` alone (PlanRow's `PlanAttribution`).
  // Null is the unattributed state — an absence, not a placeholder.
  const { source, harness, model } = entry.author;
  const author =
    source === 'mcp' && harness
      ? {
          Icon: Bot,
          label: model
            ? t('planHistoryViaHarnessModel', { harness, model })
            : tPlan('viaHarness', { harness }),
        }
      : source === 'native'
        ? { Icon: Sparkles, label: tPlan('viaMotir') }
        : null;

  return (
    <Link
      href={routes.plan(entry.planId)}
      className="-mx-(--spacing-control-x) my-1 flex items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) transition-colors hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <span
        className={cn(
          'inline-flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control)',
          STATUS_TINT[entry.planStatus],
        )}
        aria-hidden
      >
        <Icon
          className={cn(
            'h-4 w-4 text-(--el-text-strong)',
            entry.planStatus === 'generating' && 'animate-spin',
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold text-(--el-text)">{title}</span>
        <span className="text-[13px] text-(--el-text-secondary)">{relationSentence(entry, t)}</span>
        <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--el-text-secondary)">
          <span>
            {tPlan('createdAt', { when: format.relativeTime(new Date(entry.createdAt)) })}
          </span>
          {decided ? <span>{decided}</span> : null}
          {author ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <author.Icon className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
              <span className="min-w-0">{author.label}</span>
            </span>
          ) : null}
        </span>
      </span>
      <StatusPill status={entry.planStatus} label={tPlan(`status.${entry.planStatus}`)} />
    </Link>
  );
}

/** §6's loading state: two row-shaped pulses at the newer edge. */
function PlanHistorySkeleton() {
  return (
    <div aria-busy className="mt-3 flex animate-pulse flex-col gap-3.5">
      {[58, 46].map((width) => (
        <div key={width} className="flex items-center gap-3">
          <span className="h-(--height-control-32) w-8 shrink-0 rounded-(--radius-control) bg-(--el-muted)" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span
              className="h-2.5 rounded-(--radius-control) bg-(--el-muted)"
              style={{ width: `${width}%` }}
            />
            <span
              className="h-2.5 rounded-(--radius-control) bg-(--el-muted)"
              style={{ width: `${width - 24}%` }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

export function PlanHistorySection({ itemId, identifier, initial }: PlanHistorySectionProps) {
  const t = useTranslations('issueViews');
  const tCommon = useTranslations('common');

  const [items, setItems] = useState<WorkItemPlanHistoryEntryDto[]>(
    initial === 'failed' ? [] : initial.items,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(
    initial === 'failed' ? null : initial.nextCursor,
  );
  const [firstReadFailed, setFirstReadFailed] = useState(initial === 'failed');
  const [loading, setLoading] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  // Sequence guard: a response that is no longer the latest request's never
  // clobbers newer state (CLAUDE.md § the app side).
  const seq = useRef(0);

  async function fetchPage(cursor: string | null, limit: number) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`/api/work-items/${itemId}/plans?${params}`);
    if (!res.ok) throw new Error(`Plan history read failed (${res.status})`);
    return (await res.json()) as WorkItemPlanHistoryPageDto;
  }

  function appendDeduped(page: WorkItemPlanHistoryPageDto) {
    setItems((current) => {
      const seen = new Set(current.map((entry) => entry.planId));
      return [...current, ...page.items.filter((entry) => !seen.has(entry.planId))];
    });
    setNextCursor(page.nextCursor);
  }

  function retryFirstRead() {
    const mine = ++seq.current;
    setLoading(true);
    void fetchPage(null, PLAN_HISTORY_FIRST_PAGE)
      .then((page) => {
        if (mine !== seq.current) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setFirstReadFailed(false);
      })
      .catch(() => {
        if (mine === seq.current) setFirstReadFailed(true);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }

  function loadMore() {
    if (!nextCursor || loading) return;
    const mine = ++seq.current;
    setLoading(true);
    setLoadMoreFailed(false);
    void fetchPage(nextCursor, PLAN_HISTORY_MORE_PAGE)
      .then((page) => {
        if (mine === seq.current) appendDeduped(page);
      })
      .catch(() => {
        if (mine === seq.current) setLoadMoreFailed(true);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }

  // §7(a): no related plan ⇒ NOTHING — no section, no reserved box. A failed
  // first read is NOT this case: leaving the section out would claim no plan ever
  // touched the item, which the page does not know (§7(c)).
  if (!firstReadFailed && items.length === 0) return null;

  return (
    <ContentSectionCard title={t('planHistoryTitle')} subtitle={t('planHistoryGloss')}>
      {firstReadFailed ? (
        // §7(c): one flush line, NOT the `ErrorState` card — that is itself a
        // Card, and a card inside the section card is a container in a container.
        <div role="status" className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-(--el-text-secondary)">{t('planHistoryError')}</span>
          <Button variant="secondary" size="sm" loading={loading} onClick={retryFirstRead}>
            {tCommon('retry')}
          </Button>
        </div>
      ) : (
        <>
          <ul
            aria-label={t('planHistoryListAria', { key: identifier })}
            className="m-0 flex list-none flex-col p-0"
          >
            {items.map((entry, index) => (
              <li
                key={entry.planId}
                className={index > 0 ? 'border-t border-(--el-border-soft)' : undefined}
              >
                <PlanHistoryRow entry={entry} />
              </li>
            ))}
          </ul>
          {loading ? <PlanHistorySkeleton /> : null}
          {loadMoreFailed ? (
            <div
              role="status"
              className="mt-3 flex flex-wrap items-center gap-3 border-t border-(--el-border-soft) pt-3"
            >
              <span className="text-[13px] text-(--el-text-secondary)">
                {t('planHistoryLoadMoreError')}
              </span>
              <Button variant="secondary" size="sm" onClick={loadMore}>
                {tCommon('retry')}
              </Button>
            </div>
          ) : nextCursor ? (
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              className="mt-3 h-(--height-control) w-full rounded-(--radius-control) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) px-(--spacing-control-x) font-sans text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('planHistoryShowMore')}
            </button>
          ) : null}
        </>
      )}
    </ContentSectionCard>
  );
}
