import { getTranslations } from 'next-intl/server';
import { AlertTriangle, CircleCheck, CircleDashed } from 'lucide-react';
import { Card } from '@/components/ui/Card';

/**
 * The RUN-THROUGH block — design MOTIR-11509 § Elements: a labelled region
 * between the plan-context header and the findings table, carrying its heading
 * and ONE reading of the check's answer.
 *
 * ⚠️ EXACTLY THREE READINGS, keyed on `runThroughAnswer` alone: `THRU` builds
 * through (no list); `STOPS` does not, with the stored stop cards in stored order
 * — or the quiet no-card line when there are none, never a fourth reading; `null`
 * no answer recorded — never the builds-through words, never an em dash, never a
 * blank block. `runThroughStopCards` is read inside the `STOPS` branch only.
 *
 * ⚠️ APART FROM THE VERDICT: its own region and glyph, not a pill, no tint, never
 * on a line or in a container with the verdict chip — and `verdictState` is not
 * passed here, so a verdict landing cannot change the drawing.
 *
 * Display only: no control, and no loading, error or empty state of its own.
 * An answer value a newer motir-ai might add is not a reading this design draws,
 * so it is drawn as no answer rather than guessed into one of the two.
 */
export async function RunThroughBlock({
  runThroughAnswer,
  runThroughStopCards,
}: {
  runThroughAnswer: string | null;
  runThroughStopCards: string[];
}) {
  const t = await getTranslations('platformAdmin.plannerFindings.recordPage.runThrough');
  const headingId = 'record-run-through-heading';
  const cardsId = 'record-run-through-cards';

  let reading: React.ReactNode;
  if (runThroughAnswer === 'THRU') {
    reading = (
      <>
        <p
          data-reading="thru"
          className="flex items-center gap-2 text-sm font-semibold text-(--el-text-strong)"
        >
          <CircleCheck aria-hidden className="h-4 w-4 shrink-0 text-(--el-success)" />
          {t('answer.thru')}
        </p>
        <p className="text-xs text-(--el-text-secondary)">{t('hint.thru')}</p>
      </>
    );
  } else if (runThroughAnswer === 'STOPS') {
    reading = (
      <>
        <p
          data-reading="stops"
          className="flex items-center gap-2 text-sm font-semibold text-(--el-text-strong)"
        >
          <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-(--el-warning)" />
          {t('answer.stops')}
        </p>
        <p className="text-xs text-(--el-text-secondary)">{t('hint.stops')}</p>
        <div className="flex flex-col gap-1.5">
          <span id={cardsId} className="text-xs font-medium text-(--el-text-secondary)">
            {t('cards.label')}
          </span>
          {runThroughStopCards.length > 0 ? (
            <ul aria-labelledby={cardsId} className="flex flex-wrap gap-1.5">
              {runThroughStopCards.map((card, i) => (
                <li
                  key={`${card}-${i}`}
                  className="rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs break-all text-(--el-text-identifier)"
                >
                  {card}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-(--el-text-secondary) italic">{t('cards.none')}</p>
          )}
        </div>
      </>
    );
  } else {
    reading = (
      <>
        <p
          data-reading="none"
          className="flex items-center gap-2 text-sm font-normal text-(--el-text-secondary)"
        >
          <CircleDashed aria-hidden className="h-4 w-4 shrink-0" />
          {t('answer.none')}
        </p>
        <p className="text-xs text-(--el-text-secondary)">{t('hint.none')}</p>
      </>
    );
  }

  return (
    <section aria-labelledby={headingId} data-testid="record-run-through">
      <Card
        header={
          <h2 id={headingId} className="font-sans text-sm font-semibold text-(--el-text)">
            {t('heading')}
          </h2>
        }
      >
        <div className="flex flex-col gap-2 font-sans">
          <span className="sr-only">{t('a11y.region')}</span>
          {reading}
        </div>
      </Card>
    </section>
  );
}
