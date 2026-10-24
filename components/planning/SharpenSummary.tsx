'use client';

import { useTranslations } from 'next-intl';
import { Bot, Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import type { GrillingBranch, SettledAnswer, SharpenAssumption } from '@/lib/ai/types';
import type { SharpenSessionDto } from '@/lib/dto/sharpen';

// THE SETTLED-ANSWERS SUMMARY (Task MOTIR-1101 · Subtask MOTIR-8177; design G5,
// panels 7 and 8).
//
// "What you settled", counted, grouped by the part of the plan's requirement each
// answer fills: Behaviour (workflow questions), Scope edge (the other ways of
// doing it), Constraints (technical threads), Acceptance (what happens when things
// go wrong), and the planner's Assumptions (Skip / You decide). Empty groups are
// not drawn. An answer is never drawn like an assumption: the person's are
// solid, the planner's dashed.
//
// Beneath it, the write-back's result — automatic, never a button: Writing… while
// the session's write-back has not reported, Written (to the plan's requirement —
// never a card: Motir AI does not edit a card as the person, MOTIR-9314) once it
// has, and Failed with Copy answers when it did not land.

const GROUP_OF: Record<GrillingBranch, 'behaviour' | 'scopeEdge' | 'constraints' | 'acceptance'> = {
  workflow: 'behaviour',
  alternative: 'scopeEdge',
  technical_thread: 'constraints',
  non_happy: 'acceptance',
};
const GROUPS = ['behaviour', 'scopeEdge', 'constraints', 'acceptance'] as const;

export interface SharpenSummaryProps {
  session: SharpenSessionDto;
}

function answersText(settled: SettledAnswer[], assumptions: SharpenAssumption[]): string {
  return [
    ...settled.map((s) => `- ${s.question} — ${s.answer}`),
    ...assumptions.map((a) => `- ${a.question} — ${a.recommendation}`),
  ].join('\n');
}

export function SharpenSummary({ session }: SharpenSummaryProps) {
  const t = useTranslations('sharpen.summary');
  const { settled, assumptions } = session;
  if (settled.length === 0 && assumptions.length === 0) return null;

  const byGroup = new Map<(typeof GROUPS)[number], SettledAnswer[]>();
  for (const answer of settled) {
    const group = GROUP_OF[answer.topic];
    byGroup.set(group, [...(byGroup.get(group) ?? []), answer]);
  }
  const writeBack = session.writeBack;

  return (
    <div className="flex flex-col gap-2 pl-9">
      <section
        data-testid="sharpen-summary"
        aria-label={t('title')}
        className="rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding)"
      >
        <h3 className="text-sm font-semibold text-(--el-text)">{t('title')}</h3>
        <p className="text-xs text-(--el-text-secondary)">
          {t('counts', { answers: settled.length, assumptions: assumptions.length })}
        </p>
        {GROUPS.map((group) => {
          const answers = byGroup.get(group);
          if (!answers?.length) return null;
          return (
            <div key={group} className="mt-2" data-testid={`sharpen-summary-${group}`}>
              <h4 className="text-xs font-semibold tracking-wide text-(--el-text-strong) uppercase">
                {t(`groups.${group}`)}
              </h4>
              <ul className="mt-1 flex flex-col gap-1">
                {answers.map((a) => (
                  <li
                    key={a.questionId}
                    className="rounded-(--radius-control) border border-(--el-border) px-(--spacing-control-x) py-(--spacing-control-y) text-sm"
                  >
                    <span className="mr-1.5 inline-flex items-center gap-1 text-xs font-semibold text-(--el-text-strong)">
                      <Check className="size-3" aria-hidden />
                      {t('youAnswered')}
                    </span>
                    <span className="block text-(--el-text-secondary)">{a.question}</span>
                    <span className="block text-(--el-text)">{a.answer}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {assumptions.length > 0 ? (
          <div className="mt-2" data-testid="sharpen-summary-assumptions">
            <h4 className="text-xs font-semibold tracking-wide text-(--el-text-strong) uppercase">
              {t('groups.assumptions')}
            </h4>
            <ul className="mt-1 flex flex-col gap-1">
              {assumptions.map((a) => (
                <li
                  key={a.questionId}
                  className="rounded-(--radius-control) border border-dashed border-(--el-border-strong) px-(--spacing-control-x) py-(--spacing-control-y) text-sm"
                >
                  <span className="mr-1.5 inline-flex items-center gap-1 text-xs font-semibold text-(--el-text-strong)">
                    <Bot className="size-3" aria-hidden />
                    {t('plannersAssumption')}
                  </span>
                  <span className="block text-(--el-text-secondary)">{a.question}</span>
                  <span className="block text-(--el-text)">{a.recommendation}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {writeBack === null ? (
        <p
          aria-live="polite"
          className="text-xs text-(--el-text-secondary)"
          data-testid="sharpen-writing"
        >
          {t('writingPlanOnly')}
        </p>
      ) : writeBack.ok ? (
        <p
          role="status"
          data-testid="sharpen-written"
          className="rounded-(--radius-control) bg-(--el-success-surface) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
        >
          {t('writtenPlanOnly')}
        </p>
      ) : (
        <div
          role="alert"
          data-testid="sharpen-write-failed"
          className="flex flex-col items-start gap-2 rounded-(--radius-control) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
        >
          <span>{t('failed')}</span>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Copy className="size-4" aria-hidden />}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(answersText(settled, assumptions))
                .catch(() => {});
            }}
          >
            {t('copy')}
          </Button>
        </div>
      )}
    </div>
  );
}
