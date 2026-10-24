'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleHelp } from 'lucide-react';

import { Popover } from '@/components/ui/Popover';
import { Switch } from '@/components/ui/Switch';

// THE "GRILL ME" CONTROL (Task MOTIR-1101 · Subtask MOTIR-8447; design
// `design/ai-chat/planning-workspace--grill-me.mock.html` panels 1, 2 and 12,
// notes G1/G2/G6).
//
// One row in the composer's `beforeField` slot: the design system's Switch, the
// label, and a "?" that opens a Popover explaining what turning it on does. It is
// a MODE, never a launcher — the switch changes what the person's NEXT message
// does and sends nothing itself. It holds no session state: its value and its
// visibility are the rail's (`useGrillOptIn`, `planRunPhase`).
//
// The "?" opens on press, not hover (a hover tooltip is unreachable on touch);
// Escape and an outside press close it, and Radix returns focus to the trigger.

export interface GrillMeControlProps {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Draw the "Your next message starts the grilling." hint (on, before the next message). */
  hint?: boolean;
  disabled?: boolean;
  /** The conversation holds no plan yet (MOTIR-9316): the pre-planning hint, and the
   *  popover's extra last paragraph. Inside a run both stay as shipped. */
  beforePlanning?: boolean;
}

export function GrillMeControl({
  on,
  onChange,
  hint = false,
  disabled = false,
  beforePlanning = false,
}: GrillMeControlProps) {
  const t = useTranslations('planningWorkspace.grill.control');
  const labelId = useId();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-1 px-3 pt-2" data-testid="grill-me-control">
      <div className="flex items-center gap-2">
        <span data-testid="grill-me-toggle" className="inline-flex">
          <Switch
            checked={on}
            onCheckedChange={onChange}
            disabled={disabled}
            aria-labelledby={labelId}
          />
        </span>
        <span id={labelId} className="text-sm font-medium text-(--el-text)">
          {t('label')}
        </span>
        <Popover open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              data-testid="grill-me-help"
              aria-label={t('helpName')}
              aria-expanded={open}
              aria-haspopup="dialog"
              className="inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <CircleHelp className="size-4" aria-hidden />
            </button>
          </Popover.Trigger>
          <Popover.Content
            side="top"
            align="start"
            width={300}
            role="dialog"
            aria-label={t('popover.title')}
            data-testid="grill-me-explanation"
            className="p-(--spacing-card-padding)"
          >
            <h2 className="text-sm font-semibold text-(--el-text)">{t('popover.title')}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-(--el-text-secondary)">
              {t('popover.body1')}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)">
              {t('popover.body2')}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)">
              {t('popover.body3')}
            </p>
            {beforePlanning ? (
              <p
                className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)"
                data-testid="grill-me-explanation-before-planning"
              >
                {t('popover.beforePlanning')}
              </p>
            ) : null}
          </Popover.Content>
        </Popover>
      </div>
      {on && hint ? (
        <p className="text-xs text-(--el-text-secondary)" data-testid="grill-me-hint">
          {t(beforePlanning ? 'hintBeforePlanning' : 'hint')}
        </p>
      ) : null}
    </div>
  );
}
