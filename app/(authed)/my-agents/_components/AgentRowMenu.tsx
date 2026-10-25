'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Moon, MoreHorizontal, Power, Trash2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import type { AgentInstanceState } from '@/lib/dto/agentInstances';
import { allowedAgentMoves, type AgentMove } from '@/lib/agentInstances/presentation';

// THE ROW MENU (MOTIR-6868 revision 3, panel 3): exactly the moves §4 allows from
// the row's state — Wake from hibernated or failed, Hibernate from running,
// Delete… from every state §4 lets enter `deleting` — since AMENDMENT 4 that
// includes starting, waking and hibernating. A move the state does not allow is
// DISABLED, not hidden, so the menu keeps one shape.
//
// MOTIR-6916's delta (panel E, built by MOTIR-6921): once the org's AI plan has
// ended, Wake is disabled whatever the state, and the reason sits directly under
// it — the `ai_plan_required` sentence with its link — so the disabled move is
// never a silent one. Hibernate and Delete… follow the state as before.

const ITEM =
  'flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none disabled:cursor-not-allowed disabled:hover:bg-transparent';

export function AgentRowMenu({
  name,
  state,
  wakeNeedsPlan = false,
  waiting = null,
  onMove,
}: {
  name: string;
  state: AgentInstanceState;
  /** The org's AI plan has ended: Wake is disabled, with the reason under it. */
  wakeNeedsPlan?: boolean;
  /** The boot waits for room (MOTIR-9475): a line under Delete… says what deleting does. */
  waiting?: 'pool' | 'account' | null;
  onMove: (move: AgentMove) => void;
}) {
  const t = useTranslations('myAgents');
  const [open, setOpen] = useState(false);
  const allowed = new Set(allowedAgentMoves(state));
  if (wakeNeedsPlan) allowed.delete('wake');

  function item(move: AgentMove, icon: React.ReactNode, label: string, danger = false) {
    const enabled = allowed.has(move);
    return (
      <button
        type="button"
        role="menuitem"
        disabled={!enabled}
        aria-disabled={!enabled}
        className={`${ITEM} ${
          !enabled
            ? 'text-(--el-text-faint)'
            : danger
              ? 'text-(--el-danger-on-surface)'
              : 'text-(--el-text)'
        }`}
        onClick={() => {
          setOpen(false);
          onMove(move);
        }}
      >
        {icon}
        <span className="flex-1 truncate">{label}</span>
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={t('rowActions', { name })}
        className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Content width={wakeNeedsPlan || waiting ? 300 : 208} align="end" className="p-0">
        <div className="p-1" role="menu" aria-label={t('rowActions', { name })}>
          {item('wake', <Power className="size-4 shrink-0" aria-hidden="true" />, t('menu.wake'))}
          {wakeNeedsPlan ? (
            <p className="m-0 pr-(--spacing-control-x) pb-(--spacing-control-y) pl-[calc(var(--spacing-control-x)+22px)] text-xs text-(--el-text-secondary)">
              {t.rich('refusal.aiPlanRequired', {
                link: (chunks) => (
                  <Link
                    href="/settings/organization/billing"
                    className="text-(--el-link) underline"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          ) : null}
          {item(
            'hibernate',
            <Moon className="size-4 shrink-0" aria-hidden="true" />,
            t('menu.hibernate'),
          )}
          {item(
            'delete',
            <Trash2 className="size-4 shrink-0" aria-hidden="true" />,
            t('menu.delete'),
            true,
          )}
          {waiting ? (
            <p className="m-0 pr-(--spacing-control-x) pb-(--spacing-control-y) pl-[calc(var(--spacing-control-x)+22px)] text-xs text-(--el-text-secondary)">
              {t(waiting === 'account' ? 'waiting.menuNoteAccount' : 'waiting.menuNotePool')}
            </p>
          ) : null}
        </div>
      </Popover.Content>
    </Popover>
  );
}
