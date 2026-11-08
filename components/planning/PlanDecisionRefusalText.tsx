'use client';

import { useTranslations } from 'next-intl';

import type { PlanDecisionRefusal, PlanDecisionRefusalCode } from '@/lib/planning/planReview';

/**
 * What the planning rail says when the decide door REFUSED an approve or a discard
 * with a code the older keys do not name (MOTIR-10657). The sentence is the refusal's
 * own — which proposal, which field, what to do next — and the server's sentence
 * follows it, because it names the value that was refused and nothing else on the
 * screen does. Rendered inside the rail's alert paragraph, so it is phrasing only.
 */
export function PlanDecisionRefusalText({
  code,
  refusal,
}: {
  code: PlanDecisionRefusalCode;
  refusal: PlanDecisionRefusal | null;
}) {
  const tc = useTranslations('planningWorkspace.conversation.error');
  const item = refusal?.item ?? null;
  const reason = refusal?.reason ?? null;
  return (
    <>
      {tc(code, {
        hasItem: item ? 'yes' : 'no',
        item: item ?? '',
        fieldKind: refusal?.fieldKind ?? 'other',
        field: refusal?.field ?? '',
      })}
      {reason ? (
        <span className="mt-1 block text-(--el-text-secondary)" data-testid="plan-refusal-reason">
          {tc('refusalReason', { reason })}
        </span>
      ) : null}
    </>
  );
}
