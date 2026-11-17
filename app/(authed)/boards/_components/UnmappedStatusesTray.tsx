'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';

// The unmapped-statuses tray (Subtask 3.2.6 · design `board.mock.html` panel 5).
// Surfaces project workflow statuses mapped to NO board column
// (`BoardProjectionDto.unmappedStatusesInScope` — since MOTIR-11658 only those
// the board's effective filter could still match; Story 3.1.4 — the Jira
// behaviour): a
// yellow callout above the board naming the statuses, so work items in them are
// HIDDEN from the board but never silently dropped. The caller renders this
// ONLY when `statuses` is non-empty (an empty tray never shows).
//
// CTA (repointed in Subtask 3.6.3): the board-column admin now exists
// (`settings/project/board`, Story 3.6) — the surface that maps a stray status
// onto a column. So the link finally does what the 3.2.1 mock drew: it reads
// **"Map columns →"** and deep-links to Board settings, replacing the interim
// "Manage statuses →" → workflow-editor link that stood in while no mapping
// admin existed. (The 3.2.6 "CTA reality" note in design-notes.md is updated to
// match.) As of Subtask 3.7.8 (multiple boards per project) the link carries
// `?board=<id>` so it opens the settings for the board BEING VIEWED.
//
// Tokens: the yellow tint carries the hue in the BACKGROUND with
// `--el-text-strong` text (finding #35 AA — never a tinted page surface), and
// the warning triangle pairs the hue with a SHAPE so the signal is not
// colour-alone (finding #35). Status chips reuse the `Pill` neutral tone; shape
// via element tokens (`--radius-card`, `--spacing-control-*`).

export function UnmappedStatusesTray({
  statuses,
  boardId,
}: {
  statuses: WorkflowStatusDto[];
  /** The board currently being viewed — threaded into the Map-columns link so it
   *  deep-links to THIS board's config (Subtask 3.7.8). */
  boardId: string;
}) {
  const t = useTranslations('boards');
  const canConfigure = useProjectAccess().can('board:configure');
  return (
    <aside
      aria-label={t('unmappedLabel')}
      className="flex flex-wrap items-center gap-2.5 rounded-(--radius-card) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y)"
      data-testid="board-unmapped-tray"
    >
      <AlertTriangle className="h-[18px] w-[18px] shrink-0 text-(--el-warning)" aria-hidden />
      <span className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-(--el-text-strong)">
        {t('unmappedText')}
        <span className="inline-flex flex-wrap gap-1.5">
          {statuses.map((status) => (
            <Pill key={status.id} tone="neutral">
              {status.label}
            </Pill>
          ))}
        </span>
      </span>
      {/* MOTIR-6175 — the fix is in the Boards settings room, which opens on
          `board:configure`. Everyone keeps the WARNING (the cards it hides are
          everyone's concern); only a configurer is offered the door to fix it. */}
      {canConfigure ? (
        <Link
          href={`/settings/project/board?board=${encodeURIComponent(boardId)}`}
          className="text-sm font-semibold whitespace-nowrap text-(--el-link) hover:underline"
          data-testid="board-unmapped-link"
        >
          {t('unmappedMapColumns')} →
        </Link>
      ) : null}
    </aside>
  );
}
