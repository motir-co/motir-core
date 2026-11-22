'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertCircle, Bug, ChevronUp, Inbox, Lightbulb, Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { TriageAvatar } from '@/app/(authed)/triage/_components/TriageAvatar';
import { visitorViewPath } from '@/lib/visitor/routes';
import { cn } from '@/lib/utils/cn';
import type {
  VisitorPendingRequestDto,
  VisitorPendingRequestPageDto,
} from '@/lib/dto/publicRequests';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// The Visitor's Requested features list (MOTIR-6769; design MOTIR-6767 panels
// 1–3, 5). A CLIENT island seeded from the server's page one: "Load more" appends
// in place through `GET /api/p/<identifier>/requests`, and each row's vote toggle
// posts to the existing public-request act route. Both mutate state the island
// owns, so neither needs a `router.refresh()` (the page-state contract's case 3).

type VoteError = 'limited' | 'failed';

interface RowState {
  voted: boolean;
  voteCount: number;
  saving: boolean;
  error: VoteError | null;
}

const rowState = (r: VisitorPendingRequestDto): RowState => ({
  voted: r.voted,
  voteCount: r.voteCount,
  saving: false,
  error: null,
});

export function RequestedFeaturesList({
  identifier,
  initial,
}: {
  identifier: string;
  initial: VisitorPendingRequestPageDto;
}) {
  const t = useTranslations('visitor.requestedFeatures');
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState<VoteError | null>(null);
  const [votes, setVotes] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(initial.items.map((r) => [r.id, rowState(r)])),
  );
  // A press on a row while its save is in flight is IGNORED, not queued (the
  // design's saving state): this ref is the synchronous guard, since React state
  // lands a render later than a fast second click.
  const inFlight = useRef(new Set<string>());

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setLoadFailed(null);
    try {
      const res = await fetch(
        `/api/p/${encodeURIComponent(identifier)}/requests?cursor=${encodeURIComponent(cursor)}`,
      );
      if (!res.ok) {
        setLoadFailed(res.status === 429 ? 'limited' : 'failed');
        return;
      }
      const page = (await res.json()) as VisitorPendingRequestPageDto;
      // A request that moved between pages (a vote landed) is not shown twice.
      setItems((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.items.filter((r) => !seen.has(r.id))];
      });
      setVotes((prev) => {
        const next = { ...prev };
        for (const r of page.items) next[r.id] ??= rowState(r);
        return next;
      });
      setCursor(page.nextCursor);
    } catch {
      setLoadFailed('failed');
    } finally {
      setLoading(false);
    }
  }

  async function toggleVote(id: string) {
    if (inFlight.current.has(id)) return;
    const before = votes[id];
    if (!before) return;
    inFlight.current.add(id);
    // Optimistic, then reconciled to the SERVER's answer (design MOTIR-6767 §
    // The vote toggle): the count shown after a save is `voteCount`, never the guess.
    setVotes((prev) => ({
      ...prev,
      [id]: {
        voted: !before.voted,
        voteCount: before.voteCount + (before.voted ? -1 : 1),
        saving: true,
        error: null,
      },
    }));
    try {
      const res = await fetch(`/api/public-requests/${encodeURIComponent(id)}/upvote`, {
        method: 'POST',
      });
      if (!res.ok) {
        const error: VoteError = res.status === 429 ? 'limited' : 'failed';
        setVotes((prev) => ({ ...prev, [id]: { ...before, saving: false, error } }));
        return;
      }
      const result = (await res.json()) as { voted: boolean; voteCount: number };
      setVotes((prev) => ({
        ...prev,
        [id]: { voted: result.voted, voteCount: result.voteCount, saving: false, error: null },
      }));
    } catch {
      setVotes((prev) => ({ ...prev, [id]: { ...before, saving: false, error: 'failed' } }));
    } finally {
      inFlight.current.delete(id);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        data-testid="requested-features-empty"
        icon={<Inbox className="h-12 w-12" aria-hidden />}
        title={t('emptyTitle')}
        description={t('emptyBody')}
      />
    );
  }

  return (
    <div>
      <ol
        aria-label={t('listLabel')}
        className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
      >
        {items.map((r) => (
          <RequestRow
            key={r.id}
            identifier={identifier}
            request={r}
            vote={votes[r.id] ?? rowState(r)}
            onToggle={() => void toggleVote(r.id)}
          />
        ))}
      </ol>
      {cursor || loadFailed ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-(--el-text-secondary)">
          {loadFailed ? (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-(--el-danger-on-surface)"
            >
              <AlertCircle className="h-3.5 w-3.5" aria-hidden />
              {loadFailed === 'limited' ? t('loadLimited') : t('loadFailed')}
            </span>
          ) : (
            <span>{t('shown', { shown: items.length, total: initial.total })}</span>
          )}
          <Button
            variant="secondary"
            loading={loading}
            leftIcon={loadFailed ? <RotateCw className="h-4 w-4" aria-hidden /> : undefined}
            onClick={() => void loadMore()}
          >
            {loading ? t('loading') : loadFailed ? t('tryAgain') : t('loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RequestRow({
  identifier,
  request,
  vote,
  onToggle,
}: {
  identifier: string;
  request: VisitorPendingRequestDto;
  vote: RowState;
  onToggle: () => void;
}) {
  const t = useTranslations('visitor.requestedFeatures');
  const relativeTime = useRelativeTime();
  const isBug = request.kind === 'bug';
  return (
    <li
      data-testid={`requested-feature-${request.identifier}`}
      className="flex items-start gap-3 border-b border-(--el-border-soft) bg-(--el-page-bg) px-3.5 py-3 last:border-b-0"
    >
      <span className="pt-0.5">
        {isBug ? (
          <Bug className="h-4 w-4 text-(--el-type-bug)" aria-hidden />
        ) : (
          <Lightbulb className="h-4 w-4 text-(--el-type-story)" aria-hidden />
        )}
      </span>
      <Link
        href={visitorViewPath(identifier, 'items', request.identifier)}
        className="flex min-w-0 flex-1 flex-col gap-1"
      >
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-xs text-(--el-text-secondary)">{request.identifier}</span>
          <span className="text-[13.5px] leading-snug font-semibold text-(--el-text)">
            {request.title}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-(--el-text-secondary)">
          <span>{isBug ? t('bugReport') : t('featureRequest')}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1.5">
            <TriageAvatar name={request.submitterName} />
            <span>{request.submitterName}</span>
          </span>
          <span aria-hidden>·</span>
          <span>{relativeTime(new Date(request.createdAt))}</span>
        </span>
        {vote.error ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-[12.5px] text-(--el-danger-on-surface)"
          >
            <AlertCircle className="h-3.5 w-3.5" aria-hidden />
            {vote.error === 'limited' ? t('voteLimited') : t('voteFailed')}
          </span>
        ) : null}
      </Link>
      <button
        type="button"
        aria-pressed={vote.voted}
        aria-disabled={vote.saving || undefined}
        aria-label={`${vote.voted ? t('removeVote') : t('upvote')} — ${t('voteCount', { count: vote.voteCount })}`}
        onClick={onToggle}
        className={cn(
          'inline-flex h-(--height-control) min-w-14 flex-none items-center justify-center gap-1 rounded-(--radius-control) border px-(--spacing-control-x) text-[13px] font-semibold tabular-nums',
          vote.voted
            ? 'border-(--el-border-strong) bg-(--el-tint-mint) text-(--el-text-strong)'
            : 'border-(--el-border) bg-(--el-page-bg) text-(--el-text-secondary)',
          vote.saving && 'cursor-default',
        )}
      >
        {vote.saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <ChevronUp className="h-3.5 w-3.5" aria-hidden />
        )}
        <span>{vote.voteCount}</span>
      </button>
    </li>
  );
}
