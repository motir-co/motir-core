'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, History, MoveRight } from 'lucide-react';
import type { PreplanRevisionDTO } from '@/lib/dto/aiPreplan';
import { normalizeRevisionKind, type RevisionKind } from '@/lib/onboarding/revisions';
import { RevisionDiff } from './RevisionDiff';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// The forward-only REVISION LOG viewer (Subtask 7.3.71 / MOTIR-1179) — one
// artifact's when / why / what timeline. FORWARD-ONLY by design (7.3.25 / 1038):
// every entry is a new version appended; there is NO rollback / restore / revert /
// undo control ANYWHERE in this component — undoing a change is just another
// forward revision the user asks for in the chat. The log reads newest-first; each
// entry expands to its per-revision diff (the WHAT). The baseline (v1) carries no
// diff, so a tier that was never revised renders nothing.
//
// Reads its data from the 7.3.70 read seam (`PreplanRevisionDTO[]`, newest-first);
// it never recomputes a diff. Purely presentational; tokened + a11y-labelled.

export interface RevisionLogProps {
  /** The tier's forward revision log, newest-first (the read seam's `versions`). */
  versions: PreplanRevisionDTO[];
  /** The tier's current version number — the entry tagged "Current". */
  currentVersion: number;
}

export function RevisionLog({ versions, currentVersion }: RevisionLogProps) {
  const t = useTranslations('onboarding.chat.revisions');

  // Nothing to show until a tier has been revised beyond its first draft.
  const hasHistory = versions.some((v) => v.version > 1);
  if (!hasHistory) return null;

  const ordered = [...versions].sort((a, b) => b.version - a.version);

  return (
    <section
      className="mt-6 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)"
      aria-label={t('historyTitle')}
    >
      <header className="flex items-center gap-2">
        <History className="size-4 text-(--el-text-muted)" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-(--el-text)">{t('historyTitle')}</h2>
      </header>
      {/* Forward-only assurance — there is deliberately no restore/undo control. */}
      <p className="mt-1 flex items-start gap-1.5 text-xs text-(--el-text-secondary)">
        <MoveRight className="mt-0.5 size-3.5 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
        {t('historyHint')}
      </p>

      <ol className="mt-3 flex flex-col gap-2">
        {ordered.map((rev) => (
          <RevisionEntry key={rev.version} rev={rev} isCurrent={rev.version === currentVersion} />
        ))}
      </ol>
    </section>
  );
}

const KIND_LABEL: Record<
  RevisionKind,
  'kindBaseline' | 'kindDirect' | 'kindCascade' | 'kindOther'
> = {
  created: 'kindBaseline',
  direct: 'kindDirect',
  cascade: 'kindCascade',
  other: 'kindOther',
};

const KIND_TINT: Record<RevisionKind, string> = {
  created: 'bg-(--el-muted) text-(--el-text-secondary)',
  direct: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
  cascade: 'bg-(--el-tint-sky) text-(--el-text-strong)',
  other: 'bg-(--el-muted) text-(--el-text-secondary)',
};

function RevisionEntry({ rev, isCurrent }: { rev: PreplanRevisionDTO; isCurrent: boolean }) {
  const t = useTranslations('onboarding.chat.revisions');
  const relativeTime = useRelativeTime();
  const [open, setOpen] = useState(false);

  const kind = normalizeRevisionKind(rev.changeKind);
  // The baseline has no diff to expand; every later version does.
  const expandable = rev.version > 1;
  const when = relativeTime(new Date(rev.createdAt));

  return (
    <li className="rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface)">
      <div className="flex flex-wrap items-center gap-2 px-(--spacing-control-x) py-(--spacing-control-y)">
        <span className="font-mono text-xs font-semibold text-(--el-text-secondary)">
          v{rev.version}
        </span>
        <span
          className={`rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium ${KIND_TINT[kind]}`}
        >
          {t(KIND_LABEL[kind])}
        </span>
        {isCurrent && (
          <span className="rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
            {t('currentTag')}
          </span>
        )}
        <span className="text-xs text-(--el-text-secondary)">{when}</span>
        {expandable && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-(--el-link) hover:underline"
          >
            {open ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
            {open ? t('hideChanges') : t('showChanges')}
          </button>
        )}
      </div>

      {rev.changeReason && (
        <p className="px-(--spacing-control-x) pb-2 text-sm text-(--el-text-secondary)">
          <span className="font-medium text-(--el-text-secondary)">{t('whyLabel')}: </span>
          {rev.changeReason}
        </p>
      )}

      {open && expandable && (
        <div className="border-t border-(--el-border-soft) px-(--spacing-control-x) py-3">
          <RevisionDiff diff={rev.diff} />
        </div>
      )}
    </li>
  );
}
