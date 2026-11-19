'use client';

import { useTranslations } from 'next-intl';
import { CheckCircle2, Info, Loader2 } from 'lucide-react';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { assumptionRowsOf } from '@/lib/planning/requirementPane';
import type { SubmittedRequirement } from '@/lib/ai/types';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// THE REQUIREMENT DOCUMENT and the NO-REQUIREMENT NOTICE (Story MOTIR-9430 ·
// MOTIR-9437), as `design/ai-chat/plan-offer--requirement.mock.html` draws them: the
// document fills the whole left pane, centred in a readable measure, with no card or
// border of its own. Read-only — no input, no Confirm and no Decline; the decision stays
// on the offer in the rail. Presentational: the host decides when it is up.

const PARTS = ['outcome', 'behaviour', 'scopeEdge', 'constraints', 'acceptance'] as const;

export function RequirementDocument({
  requestMd,
  requirement,
  workItemRefs,
}: {
  requestMd: string;
  requirement: SubmittedRequirement;
  /** The thread's resolved card links, which cover the offer's requirement (MOTIR-10023). */
  workItemRefs: WorkItemRefMap;
}) {
  const t = useTranslations('planningWorkspace.requirementPane');
  const rows = assumptionRowsOf(requirement.assumptions);
  return (
    <article
      className="mx-auto flex w-full max-w-[720px] flex-col gap-4 pb-6"
      data-testid="requirement-document"
    >
      <h2 className="sticky top-0 z-10 truncate bg-(--el-page-bg) py-2 text-base font-semibold text-(--el-text-strong)">
        {firstLine(requestMd)}
      </h2>
      {PARTS.map((part) => {
        const text = (requirement[part] ?? '').trim();
        return (
          <section key={part} data-testid="requirement-section" data-part={part}>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-(--el-text-secondary)">
              {t(`headings.${part}`)}
            </h3>
            {text.length > 0 ? (
              <MarkdownView value={text} workItemRefs={workItemRefs} />
            ) : (
              <p
                className="text-sm italic text-(--el-text-secondary)"
                data-testid="requirement-none"
              >
                {t('none')}
              </p>
            )}
          </section>
        );
      })}
      <section data-testid="requirement-section" data-part="assumptions">
        <h3 className="mb-1 text-xs font-semibold tracking-wide text-(--el-text-secondary)">
          {t('headings.assumptions')}
        </h3>
        {rows.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row, i) => (
              <li
                key={`${row.id}-${i}`}
                data-testid="requirement-assumption"
                className="flex items-baseline gap-2 rounded-(--radius-control) bg-(--el-tint-lavender) px-(--spacing-control-x-8) py-(--spacing-control-y-4) text-sm text-(--el-text-strong)"
              >
                <span className="font-mono text-[11px] font-semibold">{row.id}</span>
                <span className="min-w-0 wrap-anywhere">{row.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm italic text-(--el-text-secondary)" data-testid="requirement-none">
            {t('none')}
          </p>
        )}
      </section>
      <p
        className="rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-[13px] text-(--el-text-strong)"
        data-testid="requirement-correction-hint"
      >
        {t('correctionHint')}
      </p>
    </article>
  );
}

export function RequirementNotice() {
  const t = useTranslations('planningWorkspace.requirementPane');
  return (
    <p
      className="mx-auto w-full max-w-[720px] rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding) text-sm leading-relaxed text-(--el-text-secondary)"
      data-testid="requirement-notice"
    >
      {t('notice')}
    </p>
  );
}

/** The request on one line: its first non-blank line, markdown markers dropped. */
function firstLine(md: string): string {
  const line = md.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.replace(/^[#>*\-\s]+/, '').trim();
}

/** The pane while the requirement is being written (MOTIR-11802): it appears here. */
export function RequirementWriting() {
  const t = useTranslations('planningWorkspace.grill');
  return (
    <p
      role="status"
      className="mx-auto flex w-full max-w-[720px] items-center gap-2 text-sm text-(--el-text-secondary)"
      data-testid="requirement-pane-writing"
    >
      <Loader2 className="size-4 flex-none animate-spin" aria-hidden />
      <span>{t('paneWriting')}</span>
    </p>
  );
}

/** The banner over a requirement a grilling is updating, or has updated (MOTIR-11805). */
export function RequirementGrillBanner({ state }: { state: 'updating' | 'updated' }) {
  const t = useTranslations('planningWorkspace.grill.overRequirement');
  const updated = state === 'updated';
  const Glyph = updated ? CheckCircle2 : Info;
  return (
    <p
      role="status"
      data-testid={`requirement-pane-${state}`}
      className={`mx-auto mb-4 flex w-full max-w-[720px] gap-2 rounded-(--radius-control) px-(--spacing-control-x-12) py-(--spacing-control-y) text-[13px] text-(--el-text-strong) ${
        updated ? 'bg-(--el-tint-mint)' : 'bg-(--el-tint-sky)'
      }`}
    >
      <Glyph
        className={`mt-px size-4 shrink-0 ${updated ? 'text-(--el-success)' : 'text-(--el-info)'}`}
        aria-hidden
      />
      <span>{t(updated ? 'paneUpdated' : 'paneUpdating')}</span>
    </p>
  );
}
