import { getFormatter, getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { PlannerFindingCostDTO } from '@/lib/dto/plannerFindings';
import { formatCostMicroUsd } from './costFormat';

/**
 * COST BESIDE FIX COUNT — design MOTIR-10362 § Elements. The plan's dry-run
 * findings made and fixed, then one line per review or repair usage line with
 * its tokens, sessions and amount. Four states: priced lines; a line unpriced
 * (says so, shows no number); and a `null` cost, the Not metered note — with
 * its explanation for a check plan finding, which never has a plan job.
 *
 * ⚠️ NEVER A ZERO FOR ABSENT DATA, AND NEVER A TOTAL: a sum over an unpriced
 * line would understate it.
 */
export async function FindingCostStrip({
  cost,
  source,
}: {
  cost: PlannerFindingCostDTO | null;
  source: string;
}) {
  const t = await getTranslations('platformAdmin.plannerFindings.cost');
  const format = await getFormatter();
  const heading = (
    <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('title')}</h2>
  );

  if (cost === null) {
    return (
      <Card header={heading}>
        <div
          data-testid="planner-finding-not-metered"
          className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-surface-soft) p-(--spacing-card-padding-12) font-sans text-sm text-(--el-text-secondary)"
        >
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
          <p>
            <strong className="font-semibold text-(--el-text-strong)">{t('notMetered')}</strong>
            {source === 'check_plan' ? <> {t('notMeteredBody')}</> : null}
          </p>
        </div>
      </Card>
    );
  }

  const counts: [string, number][] = [];
  if (typeof cost.findingsMade === 'number') counts.push([t('made'), cost.findingsMade]);
  if (typeof cost.findingsFixed === 'number') counts.push([t('fixed'), cost.findingsFixed]);

  return (
    <Card header={heading}>
      <div data-testid="planner-finding-cost" className="flex flex-col gap-3 font-sans text-sm">
        {counts.length > 0 ? (
          <dl className="grid grid-cols-2 gap-2">
            {counts.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <dt className="text-xs text-(--el-text-secondary)">{label}</dt>
                <dd className="text-lg text-(--el-text)">{format.number(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {cost.lines.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {cost.lines.map((line, index) => {
              const amount = formatCostMicroUsd(line.costMicroUsd, format);
              return (
                <li
                  key={`${line.stage}-${index}`}
                  data-testid="planner-finding-cost-line"
                  className="flex flex-col gap-0.5 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding-8)"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-(--el-text)">
                      {line.stage === 'repair' ? t('repair') : t('review')}
                    </span>
                    {amount === null ? (
                      <span className="text-xs text-(--el-text-secondary)">{t('unpriced')}</span>
                    ) : (
                      <span className="text-(--el-text)">{t('amount', { amount })}</span>
                    )}
                  </div>
                  <span className="text-xs text-(--el-text-secondary)">
                    {t('tokens', {
                      input: format.number(line.inputTokens),
                      output: format.number(line.outputTokens),
                    })}{' '}
                    · {t('sessions', { n: line.sessions })}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
